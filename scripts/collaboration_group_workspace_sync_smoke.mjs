import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { syncCollaborationGroupWorkspace } from '../src/main/modules/collaboration/infrastructure/collaborationGroupWorkspaceFiles.js';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-group-workspace-sync-'));
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-group-workspace-outside-'));
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE collaboration_groups (id TEXT PRIMARY KEY, account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal');
  INSERT INTO collaboration_groups(id,account_workspace_id) VALUES('group-1','workspace_personal');
  CREATE TABLE collaboration_group_workspace_mirrors (
    group_id TEXT NOT NULL,user_id TEXT NOT NULL,workspace_root TEXT NOT NULL DEFAULT '',workspace_epoch TEXT NOT NULL DEFAULT '',
    last_synced_revision INTEGER NOT NULL DEFAULT 0,sync_status TEXT NOT NULL DEFAULT 'idle',last_error TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(group_id,user_id)
  );
  CREATE TABLE collaboration_group_workspace_file_state (
    group_id TEXT NOT NULL,user_id TEXT NOT NULL,relative_path TEXT NOT NULL,remote_file_id TEXT NOT NULL DEFAULT '',
    remote_revision INTEGER NOT NULL DEFAULT 0,remote_sha256 TEXT NOT NULL DEFAULT '',local_sha256 TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(group_id,user_id,relative_path)
  );
`);

const remote = createRemoteWorkspace();
remote.seed('deliverables/report.md', Buffer.from('remote version 1\n'));
const auth = { db };

try {
  const alice = await syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'alice', groupId: 'group-1', mode: 'pull' });
  const aliceFile = path.join(alice.workspaceRoot, 'deliverables', 'report.md');
  assert.equal(fs.readFileSync(aliceFile, 'utf8'), 'remote version 1\n');

  fs.writeFileSync(aliceFile, 'alice version 2\n');
  const alicePushed = await syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'alice', groupId: 'group-1', mode: 'both' });
  assert.equal(alicePushed.revision, 2);

  const bob = await syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'bob', groupId: 'group-1', mode: 'pull' });
  const bobFile = path.join(bob.workspaceRoot, 'deliverables', 'report.md');
  assert.equal(fs.readFileSync(bobFile, 'utf8'), 'alice version 2\n');

  fs.writeFileSync(aliceFile, 'alice unpushed conflict\n');
  fs.writeFileSync(bobFile, 'bob version 3\n');
  await syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'bob', groupId: 'group-1', mode: 'both' });
  const aliceAfterConflict = await syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'alice', groupId: 'group-1', mode: 'pull' });
  assert.equal(fs.readFileSync(aliceFile, 'utf8'), 'bob version 3\n');
  const conflictFiles = fs.readdirSync(path.dirname(aliceFile)).filter((name) => name.includes('.conflict-alice-'));
  assert.equal(conflictFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(aliceFile), conflictFiles[0]), 'utf8'), 'alice unpushed conflict\n');
  assert.equal(aliceAfterConflict.syncStatus, 'synced');

  const linkedDirectory = path.join(alice.workspaceRoot, 'linked');
  try {
    fs.symlinkSync(outsideRoot, linkedDirectory, 'dir');
    remote.seed('linked/escape.md', Buffer.from('must not escape workspace\n'));
    await assert.rejects(
      syncCollaborationGroupWorkspace({ runtimeRoot, auth, socialRelay: remote, userId: 'alice', groupId: 'group-1', mode: 'pull' }),
      /符号链接/,
    );
    assert.equal(fs.existsSync(path.join(outsideRoot, 'escape.md')), false, 'remote workspace pull escaped through a local symlink');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
  }

  console.log('collaboration group workspace sync smoke passed');
} finally {
  db.close();
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.rmSync(outsideRoot, { recursive: true, force: true });
}

function createRemoteWorkspace() {
  const files = new Map();
  let revision = 0;
  const payload = (item) => ({
    id: item.id,
    groupId: 'group-1',
    relativePath: item.relativePath,
    revision: item.revision,
    ownerUserId: item.ownerUserId,
    filename: path.basename(item.relativePath),
    contentType: 'text/markdown',
    size: item.data.length,
    sha256: item.sha256,
    deleted: item.deleted,
  });
  return {
    connected: () => true,
    seed(relativePath, data) {
      revision += 1;
      files.set(relativePath, makeFile(relativePath, data, revision, 'seed'));
    },
    async collaborationGroupWorkspace(_groupId, { sinceRevision = 0 } = {}) {
      return {
        workspace: { id: 'group-1', groupId: 'group-1', workspaceEpoch: 'workspace_group-1', revision, readOnly: false },
        files: [...files.values()].filter((item) => item.revision > sinceRevision).map(payload),
      };
    },
    async downloadCollaborationGroupWorkspaceFile(_groupId, fileId) {
      const item = [...files.values()].find((candidate) => candidate.id === fileId && !candidate.deleted);
      if (!item) throw new Error('remote file missing');
      return item.data;
    },
    async uploadCollaborationGroupWorkspaceFile(_groupId, fileId, input) {
      const current = files.get(input.relativePath);
      if (Number(input.baseRevision || 0) !== Number(current?.revision || 0)) {
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      revision += 1;
      const next = makeFile(input.relativePath, Buffer.from(input.body), revision, 'member', fileId);
      files.set(input.relativePath, next);
      return { ok: true, file: payload(next) };
    },
    async deleteCollaborationGroupWorkspaceFile(_groupId, fileId, { baseRevision = 0 } = {}) {
      const current = [...files.values()].find((candidate) => candidate.id === fileId);
      if (!current || Number(baseRevision) !== current.revision) {
        const error = new Error('conflict');
        error.status = 409;
        throw error;
      }
      revision += 1;
      const next = { ...current, revision, data: Buffer.alloc(0), sha256: '', deleted: true };
      files.set(current.relativePath, next);
      return { ok: true, file: payload(next) };
    },
  };
}

function makeFile(relativePath, data, revision, ownerUserId, id = '') {
  const body = Buffer.from(data);
  return {
    id: id || `file_${crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`,
    relativePath,
    revision,
    ownerUserId,
    data: body,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    deleted: false,
  };
}
