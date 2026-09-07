import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { uploadFileFromPath, uploadedFileTarget } from '../src/main/files.js';
import {
  FAST_REMOTE_FILE_BYTES,
  sha256File,
  uploadResumableFileFromPath,
} from '../src/main/modules/collaboration/resumableFileTransfer.js';
import { cacheRemoteMessageFileFromPath } from '../src/main/modules/collaboration/remoteMessageFileCache.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-resumable-large-file-'));
try {
  const sourcePath = path.join(root, 'large-package.zip');
  const size = FAST_REMOTE_FILE_BYTES + 4097;
  const fd = fs.openSync(sourcePath, 'w');
  try {
    fs.ftruncateSync(fd, size);
    const header = Buffer.from('JANUS-LARGE-FILE');
    fs.writeSync(fd, header, 0, header.length, 0);
    fs.writeSync(fd, Buffer.from('END'), 0, 3, size - 3);
  } finally {
    fs.closeSync(fd);
  }

  const managed = uploadFileFromPath(root, { sourcePath, filename: 'large-package.zip', contentType: 'application/zip' }, 'large_user');
  assert.equal(managed.size, size);
  const managedPath = uploadedFileTarget(root, managed, 'large_user');
  assert.equal(fs.statSync(managedPath).size, size);
  fs.writeFileSync(sourcePath, 'changed after selection');
  assert.equal(fs.statSync(managedPath).size, size, 'managed imports must remain a stable snapshot when the original file changes');

  const expectedSha256 = await sha256File(managedPath);
  const chunkSize = 8 * 1024 * 1024;
  const chunkCount = Math.ceil(size / chunkSize);
  const uploaded = [];
  const chunkAttempts = new Map();
  let createPayload;
  const socialRelay = {
    connected: () => true,
    resumableFileTransferSupported: async () => true,
    createResumableFileUpload: async (payload) => {
      createPayload = payload;
      return { uploadId: 'file_upload_resume_1', chunkSize, chunkCount, uploadedChunks: [0] };
    },
    uploadResumableFileChunk: async (_uploadId, chunkIndex, payload) => {
      chunkAttempts.set(chunkIndex, Number(chunkAttempts.get(chunkIndex) || 0) + 1);
      if (chunkIndex === 1 && chunkAttempts.get(chunkIndex) === 1) {
        throw Object.assign(new Error('temporary connection reset'), { code: 'ECONNRESET' });
      }
      uploaded.push({ chunkIndex, size: payload.body.length, sha256: payload.sha256 });
      return { ok: true };
    },
    completeResumableFileUpload: async () => ({
      ok: true,
      attachment: {
        remote_file_id: 'message_file_large_1', filename: 'large-package.zip', size, sha256: expectedSha256,
      },
    }),
  };
  const result = await uploadResumableFileFromPath({
    socialRelay,
    sourcePath: managedPath,
    fileId: 'message_file_large_1',
    scopeKind: 'social',
    scopeId: 'user_bob',
    workspaceId: 'workspace_personal',
    filename: 'large-package.zip',
    contentType: 'application/zip',
    size,
    sha256: expectedSha256,
  });
  assert.equal(result.attachment.remote_file_id, 'message_file_large_1');
  assert.equal(createPayload.sha256, expectedSha256);
  assert.deepEqual(uploaded.map((item) => item.chunkIndex), Array.from({ length: chunkCount - 1 }, (_, index) => index + 1),
    'resume must skip chunks already acknowledged by the server');
  assert.ok(uploaded.every((item, index) => item.size === Math.min(chunkSize, size - (index + 1) * chunkSize)));
  assert.ok(uploaded.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.equal(chunkAttempts.get(1), 2, 'a transient chunk upload must retry without restarting the whole file');

  const cached = cacheRemoteMessageFileFromPath({
    runtimeRoot: root, userId: 'large_user', fileId: result.attachment.remote_file_id,
    filename: result.attachment.filename, sourcePath: managedPath, size, sha256: expectedSha256,
  });
  assert.equal(cached.byteLength, size);
  assert.equal(cached.sha256, expectedSha256);

  const constantsSource = fs.readFileSync(new URL('../src/renderer/app/constants.js', import.meta.url), 'utf8');
  const controllerSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/attachmentController.js', import.meta.url), 'utf8');
  const overlaysSource = fs.readFileSync(new URL('../src/renderer/app/components/overlays.js', import.meta.url), 'utf8');
  assert.match(constantsSource, /2 \* 1024 \* 1024 \* 1024/);
  assert.match(constantsSource, /'exe'.*'msi'.*'dmg'.*'pkg'.*'apk'.*'appimage'.*'deb'.*'rpm'.*'iso'/s);
  assert.match(controllerSource, /\['exe', 'msi', 'dmg', 'pkg', 'apk', 'appimage', 'deb', 'rpm', 'iso'\].*return 'installer'/s);
  assert.match(overlaysSource, /这是安装包或可执行文件/);
  assert.match(overlaysSource, /不会自动运行/);

  process.stdout.write(`${JSON.stringify({ ok: true, size, chunkCount, resumedFromChunk: 1, sha256: expectedSha256 })}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
