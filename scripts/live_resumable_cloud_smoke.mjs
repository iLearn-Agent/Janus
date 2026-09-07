import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const serverUrl = String(process.env.JANUS_LIVE_TEST_SERVER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = String(process.env.JANUS_LIVE_TEST_TOKEN || '');
const userId = String(process.env.JANUS_LIVE_TEST_USER_ID || '');
if (!token || !userId) throw new Error('Live smoke requires JANUS_LIVE_TEST_TOKEN and JANUS_LIVE_TEST_USER_ID.');

const size = 60 * 1024 * 1024 + 123;
const bytes = Buffer.alloc(size, 0x6c);
bytes.write('JANUS-LIVE-RESUMABLE', 0, 'utf8');
bytes.write('END', size - 3, 'utf8');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const fileId = `live_large_file_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;

const request = async (route, { method = 'GET', body, headers = {}, raw = false } = {}) => {
  const response = await fetch(`${serverUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (raw) return { response, body: Buffer.from(await response.arrayBuffer()) };
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${route} failed (${response.status}): ${text}`);
  return { response, body: parsed };
};

const created = await request('/api/file-uploads', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    fileId,
    scopeKind: 'social',
    scopeId: userId,
    workspaceId: 'workspace_personal',
    filename: 'live-large-package.zip',
    contentType: 'application/zip',
    size,
    sha256,
  }),
});
const uploadId = created.body.uploadId;
const chunkSize = Number(created.body.chunkSize);
const chunkCount = Number(created.body.chunkCount);
assert.ok(uploadId && chunkSize > 0 && chunkCount > 1);

const uploadChunk = async (index) => {
  const chunk = bytes.subarray(index * chunkSize, Math.min(size, (index + 1) * chunkSize));
  return request(`/api/file-uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'x-janus-chunk-sha256': crypto.createHash('sha256').update(chunk).digest('hex'),
    },
    body: chunk,
  });
};

assert.equal((await uploadChunk(0)).response.status, 201);
assert.equal((await uploadChunk(0)).response.status, 200);
const resumed = await request(`/api/file-uploads/${encodeURIComponent(uploadId)}`);
assert.deepEqual(resumed.body.uploadedChunks, [0]);
for (let index = 1; index < chunkCount; index += 1) assert.equal((await uploadChunk(index)).response.status, 201);

const completed = await request(`/api/file-uploads/${encodeURIComponent(uploadId)}/complete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
});
assert.equal(completed.body.attachment.remote_file_id, fileId);
assert.equal(completed.body.attachment.sha256, sha256);
assert.equal(completed.body.attachment.size, size);

const range = await request(`/api/social/files/${encodeURIComponent(fileId)}?workspaceId=workspace_personal`, {
  headers: { range: 'bytes=11-42' }, raw: true,
});
assert.equal(range.response.status, 206);
assert.equal(range.response.headers.get('content-range'), `bytes 11-42/${size}`);
assert.deepEqual(range.body, bytes.subarray(11, 43));

process.stdout.write(`${JSON.stringify({ ok: true, fileId, uploadId, size, sha256, chunkSize, chunkCount })}\n`);
