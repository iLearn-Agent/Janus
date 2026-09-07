import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';

const cloudHome = mkdtempSync(path.join(os.tmpdir(), 'janus-smtp-smoke-'));
const deliveredMessages = [];
const smtpServer = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 localhost Janus SMTP smoke\r\n');
  let buffer = '';
  let dataMode = false;
  let message = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\r\n')) {
      const index = buffer.indexOf('\r\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (dataMode) {
        if (line === '.') {
          deliveredMessages.push(message);
          message = '';
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
        } else {
          message += `${line}\r\n`;
        }
        continue;
      }
      const command = line.split(/\s+/, 1)[0].toUpperCase();
      if (command === 'EHLO' || command === 'HELO') socket.write('250-localhost\r\n250 PIPELINING\r\n');
      else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') socket.write('250 2.0.0 ok\r\n');
      else if (command === 'DATA') {
        dataMode = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (command === 'QUIT') {
        socket.write('221 2.0.0 bye\r\n');
        socket.end();
      } else socket.write('250 2.0.0 ok\r\n');
    }
  });
});

let cloudServer;
const previousEnv = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,
};

try {
  await new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', resolve));
  const smtpAddress = smtpServer.address();
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtpAddress.port);
  process.env.SMTP_SECURE = 'false';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  process.env.MAIL_FROM = 'Janus <no-reply@janus.test>';

  cloudServer = createCloudServer({
    home: cloudHome,
    token: 'smtp-smoke-cloud-token',
    syncToken: 'smtp-smoke-sync-token',
    emailCodeSecret: 'smtp-smoke-email-code-secret',
  });
  const cloudAddress = await cloudServer.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${cloudAddress.port}`;
  const codeResponse = await fetch(`${baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smtp.receiver@example.com', purpose: 'register' }),
  });
  assert.equal(codeResponse.status, 200);
  const codeResult = await codeResponse.json();
  assert.equal(codeResult.delivery, 'email');
  assert.equal(Object.hasOwn(codeResult, 'code'), false);
  assert.equal(Object.hasOwn(codeResult, 'devCode'), false);
  assert.equal(deliveredMessages.length, 1);
  assert.match(deliveredMessages[0], /smtp\.receiver@example\.com/i);
  const decodedMessage = decodeTextBody(deliveredMessages[0]);
  const codes = [...decodedMessage.matchAll(/(?<!\d)\d{6}(?!\d)/g)].map((match) => match[0]);
  assert.equal(codes.length, 1, `expected one six-digit code in SMTP message, got ${codes.length}`);

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'smtp.receiver@example.com',
      code: codes[0],
      password: 'smtp-password',
      displayName: 'SMTP Receiver',
    }),
  });
  assert.equal(registration.status, 201);
  assert.equal((await registration.json()).user.emailVerified, true);
  process.stdout.write('SMTP delivery and registration smoke passed.\n');
} finally {
  if (cloudServer) await cloudServer.close();
  await new Promise((resolve) => smtpServer.close(resolve));
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(cloudHome, { recursive: true, force: true });
}

function decodeTextBody(message = '') {
  const splitAt = message.indexOf('\r\n\r\n');
  if (splitAt < 0) return message;
  const headers = message.slice(0, splitAt);
  const body = message.slice(splitAt + 4);
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    const unfolded = body.replace(/=\r\n/g, '');
    return Buffer.from(unfolded.replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16))), 'binary').toString('utf8');
  }
  return body;
}
