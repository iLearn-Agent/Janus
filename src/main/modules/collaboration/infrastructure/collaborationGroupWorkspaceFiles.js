import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { dataDir } from '../../../paths.js';
import { nowIso, sha256Text, writeTextAtomicSync } from '../../../utils.js';

const MAX_SHARED_WORKSPACE_FILE_BYTES = 60 * 1024 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set(['.git', '.janus', 'node_modules']);

function ensureCollaborationGroupWorkspace(runtimeRoot, userId, groupId) {
  const safeUserId = safeSegment(userId || 'user');
  const safeGroupId = safeSegment(groupId || 'group');
  const workspaceRoot = path.join(dataDir(runtimeRoot), 'task-group-workspaces', safeUserId, safeGroupId);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const instructionsPath = path.join(workspaceRoot, 'AGENTS.md');
  if (!fs.existsSync(instructionsPath)) {
    writeTextAtomicSync(instructionsPath, [
      '# Shared uBuddy task-group workspace',
      '',
      '- Every file in this directory is visible to all active members of the task group after synchronization.',
      '- Do not write credentials, private chats, personal memory, unpublished private notes, or unrelated local data here.',
      '- Pull the latest workspace revision before editing an existing file and preserve conflicting versions instead of overwriting them silently.',
      '- Use stable relative paths and descriptive filenames so other members can continue the work.',
      '- External publication, email, purchases, deletion of external data, and commitments still require explicit user confirmation.',
      '- Personal uBuddy conversations and Task Memory remain private even though files in this directory are shared.',
      '',
    ].join('\n'));
  }
  return fs.realpathSync(workspaceRoot);
}

async function syncCollaborationGroupWorkspace({
  runtimeRoot = '', auth, socialRelay, userId = '', groupId = '', workspaceId = '', mode = 'both',
} = {}) {
  const cleanUserId = String(userId || '').trim();
  const cleanGroupId = String(groupId || '').trim();
  if (!auth?.db || !cleanUserId || !cleanGroupId) throw new Error('共享工作区同步参数不完整。');
  const accountWorkspaceId = String(workspaceId || auth.db.prepare(
    'SELECT account_workspace_id FROM collaboration_groups WHERE id=?',
  ).get(cleanGroupId)?.account_workspace_id || 'workspace_personal');
  const workspaceRoot = ensureCollaborationGroupWorkspace(runtimeRoot, cleanUserId, cleanGroupId);
  ensureMirrorRow(auth.db, { groupId: cleanGroupId, userId: cleanUserId, workspaceRoot, syncStatus: 'syncing' });
  if (!socialRelay?.connected?.()) {
    ensureMirrorRow(auth.db, { groupId: cleanGroupId, userId: cleanUserId, workspaceRoot, syncStatus: 'offline' });
    return localWorkspaceResult(auth.db, cleanGroupId, cleanUserId, workspaceRoot, { offline: true });
  }
  try {
    if (mode === 'both' || mode === 'pull') await pullGroupWorkspace({ auth, socialRelay, groupId: cleanGroupId, userId: cleanUserId, workspaceId: accountWorkspaceId, workspaceRoot });
    if (mode === 'both' || mode === 'push') {
      await pushGroupWorkspace({ auth, socialRelay, groupId: cleanGroupId, userId: cleanUserId, workspaceId: accountWorkspaceId, workspaceRoot });
      await pullGroupWorkspace({ auth, socialRelay, groupId: cleanGroupId, userId: cleanUserId, workspaceId: accountWorkspaceId, workspaceRoot });
    }
    ensureMirrorRow(auth.db, { groupId: cleanGroupId, userId: cleanUserId, workspaceRoot, syncStatus: 'synced', lastError: '' });
    return localWorkspaceResult(auth.db, cleanGroupId, cleanUserId, workspaceRoot);
  } catch (error) {
    ensureMirrorRow(auth.db, {
      groupId: cleanGroupId,
      userId: cleanUserId,
      workspaceRoot,
      syncStatus: Number(error?.status || 0) === 409 ? 'conflict' : 'error',
      lastError: String(error?.message || error).slice(0, 2000),
    });
    throw error;
  }
}

async function pullGroupWorkspace({ auth, socialRelay, groupId, userId, workspaceId, workspaceRoot }) {
  const mirror = auth.db.prepare('SELECT * FROM collaboration_group_workspace_mirrors WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  const trackedCount = Number(auth.db.prepare(`SELECT COUNT(*) AS count FROM collaboration_group_workspace_file_state
    WHERE group_id = ? AND user_id = ?`).get(groupId, userId)?.count || 0);
  const remote = await socialRelay.collaborationGroupWorkspace(groupId, {
    workspaceId,
    sinceRevision: trackedCount ? Number(mirror?.last_synced_revision || 0) : 0,
  });
  for (const item of Array.isArray(remote?.files) ? remote.files : []) {
    const relativePath = normalizeRelativePath(item.relativePath || item.relative_path || '');
    const target = resolveWorkspacePath(workspaceRoot, relativePath);
    const state = auth.db.prepare(`SELECT * FROM collaboration_group_workspace_file_state
      WHERE group_id = ? AND user_id = ? AND relative_path = ?`).get(groupId, userId, relativePath);
    if (item.deleted) {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const currentSha = sha256File(target);
        if (!state?.local_sha256 || currentSha !== state.local_sha256) preserveConflictCopy(target, userId);
        fs.rmSync(target, { force: true });
        removeEmptyParents(path.dirname(target), workspaceRoot);
      }
      upsertFileState(auth.db, { groupId, userId, relativePath, fileId: item.id || '', remoteRevision: item.revision, deleted: true });
      continue;
    }
    const localSha = fs.existsSync(target) && fs.statSync(target).isFile() ? sha256File(target) : '';
    if (localSha !== String(item.sha256 || '')) {
      if (localSha && (!state?.local_sha256 || localSha !== state.local_sha256)) preserveConflictCopy(target, userId);
      const data = Buffer.from(await socialRelay.downloadCollaborationGroupWorkspaceFile(groupId, item.id, { workspaceId }));
      const actualSha = crypto.createHash('sha256').update(data).digest('hex');
      if (item.sha256 && actualSha !== String(item.sha256).toLowerCase()) throw new Error(`共享工作区文件“${relativePath}”校验失败。`);
      writeBinaryAtomic(target, data);
    }
    upsertFileState(auth.db, {
      groupId,
      userId,
      relativePath,
      fileId: item.id || '',
      remoteRevision: item.revision,
      remoteSha256: item.sha256 || '',
      localSha256: item.sha256 || '',
      deleted: false,
    });
  }
  const workspace = remote?.workspace || {};
  ensureMirrorRow(auth.db, {
    groupId,
    userId,
    workspaceRoot,
    workspaceEpoch: workspace.workspaceEpoch || workspace.workspace_epoch || '',
    lastSyncedRevision: workspace.revision || mirror?.last_synced_revision || 0,
    syncStatus: workspace.readOnly ? 'readonly' : 'syncing',
  });
}

async function pushGroupWorkspace({ auth, socialRelay, groupId, userId, workspaceId, workspaceRoot }) {
  const files = listWorkspaceFiles(workspaceRoot);
  const seen = new Set();
  for (const filePath of files) {
    const relativePath = normalizeRelativePath(path.relative(workspaceRoot, filePath));
    seen.add(relativePath);
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SHARED_WORKSPACE_FILE_BYTES) throw new Error(`共享工作区文件“${relativePath}”超过 60 MB。`);
    const localSha = sha256File(filePath);
    const state = auth.db.prepare(`SELECT * FROM collaboration_group_workspace_file_state
      WHERE group_id = ? AND user_id = ? AND relative_path = ?`).get(groupId, userId, relativePath);
    if (state && !state.deleted && state.local_sha256 === localSha) continue;
    const fileId = state?.remote_file_id || `group_file_${sha256Text(`${groupId}:${relativePath}`).slice(0, 40)}`;
    try {
      const response = await socialRelay.uploadCollaborationGroupWorkspaceFile(groupId, fileId, {
        workspaceId,
        relativePath,
        filename: path.basename(filePath),
        contentType: contentTypeForPath(filePath),
        size: stat.size,
        sha256: localSha,
        baseRevision: Number(state?.remote_revision || 0),
        body: fs.readFileSync(filePath),
      });
      const remoteFile = response?.file || {};
      upsertFileState(auth.db, {
        groupId,
        userId,
        relativePath,
        fileId: remoteFile.id || fileId,
        remoteRevision: remoteFile.revision || 0,
        remoteSha256: remoteFile.sha256 || localSha,
        localSha256: localSha,
        deleted: false,
      });
    } catch (error) {
      if (Number(error?.status || 0) === 409) preserveConflictCopy(filePath, userId);
      throw error;
    }
  }
  const tracked = auth.db.prepare(`SELECT * FROM collaboration_group_workspace_file_state
    WHERE group_id = ? AND user_id = ? AND deleted = 0`).all(groupId, userId);
  for (const state of tracked) {
    if (seen.has(state.relative_path) || !state.remote_file_id) continue;
    const response = await socialRelay.deleteCollaborationGroupWorkspaceFile(groupId, state.remote_file_id, {
      workspaceId,
      baseRevision: Number(state.remote_revision || 0),
    });
    const remoteFile = response?.file || {};
    upsertFileState(auth.db, {
      groupId,
      userId,
      relativePath: state.relative_path,
      fileId: remoteFile.id || state.remote_file_id,
      remoteRevision: remoteFile.revision || state.remote_revision,
      deleted: true,
    });
  }
}

function localWorkspaceResult(db, groupId, userId, workspaceRoot, extra = {}) {
  const mirror = db.prepare('SELECT * FROM collaboration_group_workspace_mirrors WHERE group_id = ? AND user_id = ?').get(groupId, userId) || {};
  return {
    id: groupId,
    groupId,
    scope: 'collaboration_group',
    workspaceRoot,
    workspaceEpoch: mirror.workspace_epoch || `workspace_${groupId}`,
    revision: Math.max(0, Number(mirror.last_synced_revision || 0)),
    syncStatus: mirror.sync_status || 'idle',
    lastError: mirror.last_error || '',
    ...extra,
  };
}

function ensureMirrorRow(db, {
  groupId, userId, workspaceRoot, workspaceEpoch, lastSyncedRevision, syncStatus = 'idle', lastError,
}) {
  const existing = db.prepare('SELECT * FROM collaboration_group_workspace_mirrors WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  db.prepare(`INSERT INTO collaboration_group_workspace_mirrors (
    group_id,user_id,workspace_root,workspace_epoch,last_synced_revision,sync_status,last_error,metadata_json,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(group_id,user_id) DO UPDATE SET
    workspace_root=excluded.workspace_root,
    workspace_epoch=CASE WHEN excluded.workspace_epoch <> '' THEN excluded.workspace_epoch ELSE collaboration_group_workspace_mirrors.workspace_epoch END,
    last_synced_revision=CASE WHEN excluded.last_synced_revision >= collaboration_group_workspace_mirrors.last_synced_revision THEN excluded.last_synced_revision ELSE collaboration_group_workspace_mirrors.last_synced_revision END,
    sync_status=excluded.sync_status,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(
    groupId,
    userId,
    workspaceRoot,
    workspaceEpoch == null ? String(existing?.workspace_epoch || '') : String(workspaceEpoch || ''),
    lastSyncedRevision == null ? Number(existing?.last_synced_revision || 0) : Math.max(0, Number(lastSyncedRevision || 0)),
    syncStatus,
    lastError == null ? String(existing?.last_error || '') : String(lastError || ''),
    existing?.metadata_json || '{}',
    existing?.created_at || nowIso(),
    nowIso(),
  );
}

function upsertFileState(db, {
  groupId, userId, relativePath, fileId = '', remoteRevision = 0, remoteSha256 = '', localSha256 = '', deleted = false,
}) {
  db.prepare(`INSERT INTO collaboration_group_workspace_file_state (
    group_id,user_id,relative_path,remote_file_id,remote_revision,remote_sha256,local_sha256,deleted,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(group_id,user_id,relative_path) DO UPDATE SET
    remote_file_id=excluded.remote_file_id,remote_revision=excluded.remote_revision,
    remote_sha256=excluded.remote_sha256,local_sha256=excluded.local_sha256,
    deleted=excluded.deleted,updated_at=excluded.updated_at`).run(
    groupId,
    userId,
    relativePath,
    fileId,
    Math.max(0, Number(remoteRevision || 0)),
    String(remoteSha256 || ''),
    String(localSha256 || ''),
    deleted ? 1 : 0,
    nowIso(),
  );
}

function listWorkspaceFiles(workspaceRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'AGENTS.md' || entry.name.endsWith('.tmp')) continue;
      if (entry.isSymbolicLink()) throw new Error('共享工作区中不允许使用符号链接，已停止同步。');
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(workspaceRoot);
  return files.sort();
}

function normalizeRelativePath(value = '') {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) throw new Error('共享工作区文件路径无效。');
  return segments.join('/');
}

function resolveWorkspacePath(workspaceRoot, relativePath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, normalizeRelativePath(relativePath));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('共享工作区文件路径越界。');
  assertNoWorkspaceSymlink(root, target);
  return target;
}

function assertNoWorkspaceSymlink(workspaceRoot, targetPath) {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, path.resolve(targetPath));
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('共享工作区文件路径包含符号链接，已停止同步。');
  }
}

function writeBinaryAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
}

function preserveConflictCopy(filePath, userId) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
  const extension = path.extname(filePath);
  const base = extension ? filePath.slice(0, -extension.length) : filePath;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const conflictPath = `${base}.conflict-${safeSegment(userId)}-${stamp}${extension}`;
  fs.copyFileSync(filePath, conflictPath);
  return conflictPath;
}

function removeEmptyParents(directory, workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  let current = path.resolve(directory);
  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    if (fs.readdirSync(current).length) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function contentTypeForPath(filePath) {
  return ({
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
    '.csv': 'text/csv', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function safeSegment(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'item';
}

export {
  ensureCollaborationGroupWorkspace,
  syncCollaborationGroupWorkspace,
};
