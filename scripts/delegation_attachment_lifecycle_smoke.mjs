import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { deleteSessionManagedAttachments } from '../src/main/attachmentLifecycle.js';
import { syncDelegationWorkspaceMessages } from '../src/main/modules/collaboration/application/delegationWorkspaceMessages.js';
import { uploadCollaborationTaskAttachments } from '../src/main/modules/collaboration/infrastructure/delegationWorkspaceFiles.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-delegation-attachment-lifecycle-'));

try {
  verifyPendingDeliveryPinsManagedAttachment(runtimeRoot);
  await verifyMissingGroupDeliveryRecoversFromSharedWorkspace(runtimeRoot);
  await verifyWorkspaceSyncKeepsPortableIdentityOnly();
  process.stdout.write('Delegation attachment lifecycle smoke passed.\n');
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}

function verifyPendingDeliveryPinsManagedAttachment(root) {
  const uploadDir = path.join(root, 'data', 'uploads', 'owner', 'upload_delivery');
  const filePath = path.join(uploadDir, 'draft.md');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(filePath, '# completed draft\n');

  const db = new DatabaseSync(path.join(root, 'attachment-lifecycle.db'));
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, metadata_json TEXT NOT NULL);
    CREATE TABLE cloud_file_manifest(local_path TEXT PRIMARY KEY);
    CREATE TABLE cloud_file_refs(session_id TEXT NOT NULL, source_kind TEXT NOT NULL);
  `);
  for (const sessionId of ['source-session', 'confirmation-session']) {
    db.prepare('INSERT INTO sessions(id,status) VALUES(?,?)').run(sessionId, 'active');
  }
  const attachment = {
    id: 'upload_delivery', owner_id: 'owner', name: 'draft.md', filename: 'draft.md', path: filePath,
  };
  db.prepare('INSERT INTO messages(id,session_id,metadata_json) VALUES(?,?,?)').run(
    'generated-file-message', 'source-session', JSON.stringify({ attachments: [attachment] }),
  );
  db.prepare('INSERT INTO messages(id,session_id,metadata_json) VALUES(?,?,?)').run(
    'delivery-confirmation-message', 'confirmation-session',
    JSON.stringify({ externalDelegationDeliveryDraft: { attachments: [attachment] } }),
  );

  const cleanup = deleteSessionManagedAttachments(root, db, 'source-session');
  assert.equal(cleanup.retainedFiles, 1);
  assert.equal(fs.existsSync(filePath), true, 'pending delivery confirmation must retain the managed file');
  db.close();
}

async function verifyMissingGroupDeliveryRecoversFromSharedWorkspace(root) {
  const groupId = 'collab_group_attachment_recovery';
  const bytes = Buffer.from('# recovered shared delivery\n');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let uploadedBody = null;
  const relay = {
    collaborationGroupWorkspace: async () => ({ files: [{
      id: 'group_file_delivery', relativePath: 'deliverables/draft.md', filename: 'draft.md',
      size: bytes.length, sha256,
    }] }),
    downloadCollaborationGroupWorkspaceFile: async (_groupId, fileId) => {
      assert.equal(fileId, 'group_file_delivery');
      return bytes;
    },
    uploadCollaborationFile: async (_delegationId, fileId, request) => {
      uploadedBody = Buffer.from(request.body);
      return { attachment: {
        remote_file_id: fileId, remote_file_kind: 'collaboration_task', filename: request.filename,
        name: request.filename, content_type: request.contentType, type: request.contentType,
        size: request.size, sha256: request.sha256,
      } };
    },
  };

  const uploaded = await uploadCollaborationTaskAttachments({
    runtimeRoot: root,
    socialRelay: relay,
    delegationId: 'delegation_attachment_recovery',
    groupId,
    userId: 'owner',
    workspaceId: 'workspace_personal',
    attachments: [{
      id: 'missing_local_upload', owner_id: 'owner', name: 'draft.md', filename: 'draft.md',
      type: 'text/markdown', size: bytes.length, group_id: groupId,
      source_path: `C:\\Users\\owner\\.janus\\data\\task-group-workspaces\\owner\\${groupId}\\deliverables\\draft.md`,
    }],
  });
  assert.equal(uploaded.length, 1);
  assert.deepEqual(uploadedBody, bytes);
}

async function verifyWorkspaceSyncKeepsPortableIdentityOnly() {
  let sent = null;
  await syncDelegationWorkspaceMessages({
    sendDelegationWorkspaceMessage: async (_delegationId, payload) => { sent = payload; },
  }, 'delegation_sync_portable', 'session_sync_portable', [{
    id: 'message_sync_portable', role: 'system', content: 'generated file',
    metadata: {
      delegationId: 'delegation_sync_portable', privateTaskWorkspace: true, workspaceEpoch: 'epoch_sync_portable',
      attachments: [{
        id: 'upload_sync_portable', name: 'draft.md', path: '/private/uploads/draft.md',
        source_path: '/private/task-group/draft.md', workspace_relative_path: 'deliverables/draft.md',
      }],
    },
  }], 'epoch_sync_portable', 'workspace_personal');

  const attachment = sent?.metadata?.attachments?.[0] || {};
  assert.equal(attachment.path, undefined);
  assert.equal(attachment.source_path, undefined);
  assert.equal(attachment.workspace_relative_path, 'deliverables/draft.md');
}
