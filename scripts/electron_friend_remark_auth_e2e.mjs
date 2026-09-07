import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-friend-remark-ui-'));
const cloudHome = path.join(tempRoot, 'cloud');
const aliceSeedHome = path.join(tempRoot, 'alice-seed');
const bobSeedHome = path.join(tempRoot, 'bob-seed');
const uiHome = path.join(tempRoot, 'ui');
const debugPort = 9500 + (process.pid % 300);
const aliceEmail = 'alice.friend.remark.ui@example.com';
const bobEmail = 'bob.friend.remark.ui@example.com';
const password = 'friend-remark-ui-password';
const remark = '真实 UI 项目联系人';
const sentCodes = new Map();
const previousAuthUrl = process.env.JANUS_AUTH_URL;
let cloud;
let alice;
let bob;
let electron;
let cdp;
let stderr = '';

try {
  cloud = createCloudServer({
    home: cloudHome,
    token: 'friend-remark-ui-cloud-token',
    syncToken: 'friend-remark-ui-sync-token',
    emailCodeSecret: 'friend-remark-ui-email-secret',
    mailer: {
      configured: true,
      async sendEmailCode({ email, purpose, code }) {
        sentCodes.set(`${email}:${purpose}`, code);
      },
    },
  });
  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  const serverUrl = `http://127.0.0.1:${address.port}`;
  process.env.JANUS_AUTH_URL = serverUrl;

  alice = await createRuntime({ root: aliceSeedHome, isDev: true });
  bob = await createRuntime({ root: bobSeedHome, isDev: true });
  await register(alice, aliceEmail, 'Alice Remark UI');
  await register(bob, bobEmail, 'Bob Remark UI');
  const bobUser = (await alice.friendSearch({ query: bobEmail }))[0];
  assert.ok(bobUser?.id, 'seeded Bob user should be searchable');
  await alice.friendSendRequest({ userId: bobUser.id, message: '真实 UI 备注测试' });
  const request = (await bob.friendsOverview()).requests.incoming[0];
  assert.ok(request?.id, 'friend request should reach Bob');
  await bob.friendAcceptRequest({ requestId: request.id });
  alice.close();
  bob.close();
  alice = null;
  bob = null;

  const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
  const childEnv = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: uiHome,
    JANUS_AUTH_URL: serverUrl,
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_UBUDDY_PROCESSING_MODE: 'fallback',
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  electron = spawn(electronExe, [
    '--no-sandbox',
    `--user-data-dir=${path.join(tempRoot, 'profile')}`,
    `--remote-debugging-port=${debugPort}`,
    '.',
  ], { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  electron.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(debugPort, 20_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitForRenderer(cdp, `document.querySelector('#login-form')`);
  await evaluate(cdp, `(() => {
    const identifier = document.querySelector('#login-identifier');
    const password = document.querySelector('#login-password');
    identifier.value = ${JSON.stringify(aliceEmail)};
    password.value = ${JSON.stringify(password)};
    identifier.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#login-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-view="friends"]') && !document.querySelector('#login-form')`, 20_000);
  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]').click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-friend-remark="${bobUser.id}"]')`, 15_000);
  await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-friend-remark="${bobUser.id}"]');
    button.closest('details').open = true;
    button.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('#social-edit-form') && document.querySelector('#social-edit-input')`);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#social-edit-input');
    input.value = ${JSON.stringify(remark)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#social-edit-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('.im-contact-row')?.textContent.includes(${JSON.stringify(remark)})`, 15_000);
  const uiState = await evaluate(cdp, `({
    loggedIn: !document.querySelector('#login-form'),
    remarkVisible: document.querySelector('.im-contact-row')?.textContent.includes(${JSON.stringify(remark)}) || false,
    errorNotice: document.querySelector('.app-notice.error')?.textContent || '',
  })`);
  assert.equal(uiState.loggedIn, true, 'remark save must not log the user out');
  assert.equal(uiState.remarkVisible, true, 'saved remark should appear in the contacts UI');
  assert.equal(uiState.errorNotice, '', `remark save should not show an error: ${uiState.errorNotice}`);

  const friendship = cloud.db.prepare('SELECT * FROM friendships WHERE user_a_id = ? OR user_b_id = ?').get(bobUser.id, bobUser.id);
  assert.ok(friendship, 'cloud friendship should exist');
  const storedRemark = friendship.user_a_id === bobUser.id ? friendship.user_b_remark : friendship.user_a_remark;
  assert.equal(storedRemark, remark, 'remark should be persisted for Alice only');

  await evaluate(cdp, `window.__friendRemarkBeforeReload = true`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitForRenderer(cdp, `!window.__friendRemarkBeforeReload && document.readyState === 'complete' && (() => {
    const button = document.querySelector('[data-network-view="friends"]');
    if (!button || document.querySelector('#login-form')) return false;
    button.click();
    return true;
  })()`, 20_000);
  await waitForRenderer(cdp, `document.querySelector('.im-contact-row')?.textContent.includes(${JSON.stringify(remark)})`, 15_000);

  console.log('real Electron UI friend remark auth flow passed (login, modal edit, cloud persistence, session retention, reload)');
} finally {
  cdp?.close?.();
  if (electron && electron.exitCode === null) {
    const exited = new Promise((resolve) => electron.once('exit', resolve));
    electron.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (electron.exitCode === null) {
      electron.kill('SIGKILL');
      await new Promise((resolve) => electron.once('exit', resolve));
    }
  }
  alice?.close?.();
  bob?.close?.();
  if (cloud) await cloud.close();
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function register(runtime, email, displayName) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = sentCodes.get(`${email}:register`);
  assert.match(code || '', /^\d{6}$/);
  return runtime.authRegister({ email, displayName, password, code });
}

async function waitForRenderer(connection, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(connection, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}\n${stderr.slice(-3000)}`);
}

async function evaluate(connection, expression) {
  const result = await connection.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
  return result.result?.value;
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Electron renderer.\n${stderr.slice(-3000)}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
        socket.send(JSON.stringify({ id, method, params }));
        return response;
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
}
