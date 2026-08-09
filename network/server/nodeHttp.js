import fs from 'node:fs';
import path from 'node:path';

export function isBearerAuthorized(request, token) {
  if (!token) return true;
  const expected = `Bearer ${token}`;
  return request.headers.authorization === expected || request.headers['x-janus-token'] === token;
}

export async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

export function readBody(request) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

export function sendFileResponse(response, file, { filename = path.basename(file), head = false } = {}) {
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${String(filename || '').replaceAll('"', '')}"`,
    'content-length': fs.statSync(file).size,
  });
  if (head) {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
}
