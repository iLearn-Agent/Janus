import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeFile } from '../src/main/files.js';
import {
  cacheRemoteMessageFile,
  downloadRemoteMessageFile,
} from '../src/main/modules/collaboration/remoteMessageFileCache.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-collaboration-file-cache-'));
const userId = 'cache-user';
const fileId = 'message-file-1';
const filename = 'analysis.py';
const data = Buffer.from('print("offline cache")\n', 'utf8');
const sha256 = crypto.createHash('sha256').update(data).digest('hex');

try {
  const offlineRelay = {
    connected: () => false,
    downloadCollaborationFile: async () => { throw new Error('offline relay must not be called'); },
  };
  const unavailable = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: offlineRelay, describeFile, userId, fileId, filename, sha256,
  });
  assert.deepEqual({ unavailable: unavailable.unavailable, reason: unavailable.reason }, { unavailable: true, reason: 'offline' });

  cacheRemoteMessageFile({ runtimeRoot, userId, fileId, filename, data, sha256 });
  const cached = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: offlineRelay, describeFile, userId, fileId, filename, sha256, type: 'text/x-python',
  });
  assert.equal(fs.readFileSync(cached.path, 'utf8'), data.toString('utf8'));
  assert.match(cached.file_url, /^file:/);

  const remoteFileId = 'message-file-remote';
  let downloadCount = 0;
  const onlineRelay = {
    connected: () => true,
    downloadChatGroupMessageFile: async (groupId, requestedFileId) => {
      downloadCount += 1;
      assert.equal(groupId, 'chat-group-1');
      assert.equal(requestedFileId, remoteFileId);
      return data;
    },
  };
  const downloaded = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: onlineRelay, describeFile, userId, fileId: remoteFileId, filename, sha256,
    remoteFileKind: 'chat_group', groupId: 'chat-group-1', workspaceId: 'workspace_personal',
  });
  assert.equal(downloadCount, 1);
  assert.equal(fs.readFileSync(downloaded.path, 'utf8'), data.toString('utf8'));
  onlineRelay.connected = () => false;
  const reused = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: onlineRelay, describeFile, userId, fileId: remoteFileId, filename, sha256,
    remoteFileKind: 'chat_group', groupId: 'chat-group-1', workspaceId: 'workspace_personal',
  });
  assert.equal(downloadCount, 1, 'offline reuse must not call the remote server after a verified download');
  assert.equal(reused.path, downloaded.path);

  const renamed = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: onlineRelay, describeFile, userId, fileId: remoteFileId, filename: 'renamed-analysis.py', sha256,
    remoteFileKind: 'chat_group', groupId: 'chat-group-1', workspaceId: 'workspace_personal',
  });
  assert.equal(renamed.path, downloaded.path, 'cache lookup must survive a display filename change');

  const identityRelay = { connected: () => false, remoteUserId: () => 'remote-cache-user' };
  cacheRemoteMessageFile({ runtimeRoot, userId: 'remote-cache-user', fileId: 'identity-file', filename, data, sha256 });
  const identityCached = await downloadRemoteMessageFile({
    runtimeRoot, socialRelay: identityRelay, describeFile, userId: 'local-cache-user',
    fileId: 'identity-file', filename, sha256,
  });
  assert.equal(fs.readFileSync(identityCached.path, 'utf8'), data.toString('utf8'), 'remote identity cache key must survive local identity mapping');

  const missing = await downloadRemoteMessageFile({
    runtimeRoot,
    socialRelay: {
      connected: () => true,
      async downloadCollaborationFile() { const error = new Error('missing'); error.status = 404; throw error; },
    },
    describeFile, userId, fileId: 'missing-file', filename, sha256,
  });
  assert.equal(missing.code, 'collaboration_file_missing');
  assert.equal(missing.reason, 'missing');

  let transientAttempts = 0;
  const transient = await downloadRemoteMessageFile({
    runtimeRoot,
    socialRelay: {
      connected: () => true,
      async downloadCollaborationFile() {
        transientAttempts += 1;
        if (transientAttempts === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return data;
      },
    },
    describeFile, userId, fileId: 'transient-file', filename, sha256, size: data.length,
  });
  assert.equal(transientAttempts, 2, 'a transient file download must retry before reporting unavailable');
  assert.equal(fs.readFileSync(transient.path, 'utf8'), data.toString('utf8'));

  const wrongLength = await downloadRemoteMessageFile({
    runtimeRoot,
    socialRelay: { connected: () => true, async downloadCollaborationFile() { return data; } },
    describeFile, userId, fileId: 'wrong-length-file', filename, size: data.length + 1,
  });
  assert.equal(wrongLength.code, 'collaboration_file_integrity_failed');
  assert.equal(wrongLength.reason, 'integrity');

  const attachmentControllerSource = fs.readFileSync(new URL('../src/renderer/app/features/chat/attachmentController.js', import.meta.url), 'utf8');
  assert.match(attachmentControllerSource, /notifyAttachmentActionError/);
  assert.match(attachmentControllerSource, /expectedUnavailable \? 'warning' : 'error'/,
    'known attachment availability states must be warnings instead of generic save failures');

  process.stdout.write('Collaboration file cache smoke passed.\n');
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
