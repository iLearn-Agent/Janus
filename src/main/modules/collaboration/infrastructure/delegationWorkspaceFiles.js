import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseArtifactMessage } from '../../../artifacts.js';
import { uploadFileFromPath } from '../../../files.js';
import { dataDir } from '../../../paths.js';
import { sha256Text, writeTextAtomicSync } from '../../../utils.js';
import { normalizeWorkspaceKey } from '../../projects/index.js';
import {
  publicDelegationAttachment,
  uniqueDelegationAttachments,
} from '../domain/delegationWorkspaceRules.js';
import { ensureCollaborationGroupWorkspace } from './collaborationGroupWorkspaceFiles.js';
import { cacheRemoteMessageFile, cacheRemoteMessageFileFromPath } from '../remoteMessageFileCache.js';
import {
  FAST_REMOTE_FILE_BYTES,
  MAX_REMOTE_FILE_BYTES,
  retryTransientFileTransfer,
  sha256File,
  uploadResumableFileFromPath,
} from '../resumableFileTransfer.js';

const DELEGATION_DELIVERABLE_EXTENSIONS = new Set([
  '.pptx', '.docx', '.xlsx', '.pdf', '.md', '.markdown', '.txt', '.csv', '.tsv', '.json',
  '.html', '.svg', '.drawio', '.mmd', '.mermaid', '.png', '.jpg', '.jpeg', '.webp',
]);

function ensureDelegationTaskWorkspace(runtimeRoot, userId, delegation = {}) {
  const groupId = String(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '').trim();
  if (groupId) return ensureCollaborationGroupWorkspace(runtimeRoot, userId, groupId);
  const safeUserId = safeDelegationWorkspaceSegment(userId || 'user');
  const safeDelegationId = safeDelegationWorkspaceSegment(delegation.id || 'task');
  const workspaceRoot = path.join(dataDir(runtimeRoot), 'task-workspaces', safeUserId, safeDelegationId);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const instructionsPath = path.join(workspaceRoot, 'AGENTS.md');
  if (!fs.existsSync(instructionsPath)) {
    writeTextAtomicSync(instructionsPath, [
      '# Private uBuddy task workspace',
      '',
      '- Work only inside this task workspace and on attachments explicitly supplied for this task.',
      '- You may create and edit draft deliverables inside this workspace without asking for approval.',
      '- Do not inspect the owner’s other projects, home folders, credentials, or unrelated local files.',
      '- Do not publish, email, upload, purchase, delete external data, or make commitments on the owner’s behalf.',
      '- If an external or sensitive action is requested, prepare a draft and a confirmation checklist instead of performing the action.',
      '- Clearly mark missing facts with placeholders; never fabricate project data, evidence, budgets, dates, or approvals.',
      '- Keep intermediate work private. Only the owner can submit selected results to the shared task group.',
      '',
    ].join('\n'));
  }
  return fs.realpathSync(workspaceRoot);
}

function safeDelegationWorkspaceSegment(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'task';
}


function collectDelegationGeneratedFiles({
  runtimeRoot,
  store,
  sessionId = '',
  workspaceRoot = '',
  userId = '',
  previous = [],
  delegationId = '',
  groupId = '',
  workspaceEpoch = '',
  candidateMessageId = '',
  workspaceBaseline = null,
} = {}) {
  const existing = uniqueDelegationAttachments(Array.isArray(previous) ? previous : []);
  const existingSources = new Set(existing.map((item) => normalizeWorkspaceKey(item.source_path || item.sourcePath || '')).filter(Boolean));
  const candidates = new Set();
  const replacementSources = new Set();
  for (const message of store.listMessages(sessionId)) {
    const artifact = parseArtifactMessage(message.content);
    if (!artifact?.data) continue;
    for (const filePath of delegationArtifactPaths(artifact.kind, artifact.data)) {
      if (filePath && fs.existsSync(filePath)) candidates.add(path.resolve(filePath));
    }
  }
  for (const filePath of listDelegationWorkspaceDeliverables(workspaceRoot)) {
    const key = normalizeWorkspaceKey(filePath);
    const currentFingerprint = delegationWorkspaceFileFingerprint(filePath);
    const baselineFingerprint = workspaceBaseline?.[key] || '';
    if (baselineFingerprint && baselineFingerprint === currentFingerprint) continue;
    if (baselineFingerprint && existingSources.has(key)) replacementSources.add(key);
    candidates.add(filePath);
  }
  const added = [];
  const replacedSources = new Set();
  for (const sourcePath of candidates) {
    const sourceKey = normalizeWorkspaceKey(sourcePath);
    if (existingSources.has(sourceKey) && !replacementSources.has(sourceKey)) continue;
    try {
      const uploaded = uploadFileFromPath(runtimeRoot, { sourcePath, filename: path.basename(sourcePath) }, userId);
      const workspaceRelativePath = workspaceRoot
        ? path.relative(workspaceRoot, sourcePath).replace(/\\/g, '/')
        : '';
      added.push({
        ...uploaded,
        source_path: sourcePath,
        ...(workspaceRelativePath && !workspaceRelativePath.startsWith('../') ? { workspace_relative_path: workspaceRelativePath } : {}),
        ...(groupId ? { group_id: groupId } : {}),
        generated_for_delegation: delegationId,
      });
      existingSources.add(sourceKey);
      if (replacementSources.has(sourceKey)) replacedSources.add(sourceKey);
    } catch {
      // Oversized or transient renderer files are not attached to the task result.
    }
  }
  if (added.length) {
    const session = store.getSession(sessionId);
    const relatedCandidateId = String(candidateMessageId || [...store.listMessages(sessionId)].reverse().find((message) => message.role === 'assistant' && message.metadata?.publishCandidate)?.id || '');
    store.addMessage({
      sessionId,
      role: 'system',
      content: `uBuddy \u5df2\u5728\u79c1\u6709\u4efb\u52a1\u5de5\u4f5c\u533a\u751f\u6210 ${added.length} \u4e2a\u53ef\u7f16\u8f91\u4ea4\u4ed8\u6587\u4ef6\u3002`,
      agentId: session?.agentId || '',
      agentInstanceId: session?.agentInstanceId || '',
      departmentId: session?.departmentId || 'agent_delegation',
      metadata: { delegationId, privateTaskWorkspace: true, workspaceEpoch, generatedTaskFiles: true, candidateMessageId: relatedCandidateId, attachments: added },
    });
  }
  return uniqueDelegationAttachments([
    ...added,
    ...existing.filter((item) => !replacedSources.has(normalizeWorkspaceKey(item.source_path || item.sourcePath || ''))),
  ]).slice(0, 20);
}

function snapshotDelegationWorkspaceDeliverables(workspaceRoot = '') {
  return Object.fromEntries(listDelegationWorkspaceDeliverables(workspaceRoot).map((filePath) => [
    normalizeWorkspaceKey(filePath),
    delegationWorkspaceFileFingerprint(filePath),
  ]));
}

function delegationWorkspaceFileFingerprint(filePath = '') {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

function delegationArtifactPaths(kind = '', data = {}) {
  if (kind === 'ppt') {
    return [data.deck, data.deck_file?.path, data.notes, data.notes_file?.path, data.pdf_file?.path].filter(Boolean);
  }
  if (kind === 'image') return [data.path, data.file?.path].filter(Boolean);
  return [];
}

function listDelegationWorkspaceDeliverables(workspaceRoot = '') {
  const root = path.resolve(String(workspaceRoot || ''));
  if (!workspaceRoot || !fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory, depth = 0) => {
    if (depth > 5 || files.length >= 80) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'AGENTS.md' || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'inputs') continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target, depth + 1);
        continue;
      }
      if (!entry.isFile() || !DELEGATION_DELIVERABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const relative = path.relative(root, target).replace(/\\/g, '/');
      if (relative.startsWith('../')) continue;
      if (/\/(?:slides?|preview|covers?)\//i.test(`/${relative}`) && /\.(?:png|jpe?g|webp)$/i.test(entry.name)) continue;
      files.push(path.resolve(target));
    }
  };
  visit(root);
  return files;
}

function ensureDelegationEditableDraftFile({ workspaceRoot = '', delegation = {}, answer = '', previous = [], force = false } = {}) {
  const content = String(answer || '').trim();
  if (!workspaceRoot || !content) return '';
  const previousSources = new Set((Array.isArray(previous) ? previous : [])
    .map((item) => normalizeWorkspaceKey(item.source_path || item.sourcePath || ''))
    .filter(Boolean));
  const hasNewDeliverable = listDelegationWorkspaceDeliverables(workspaceRoot)
    .some((filePath) => !previousSources.has(normalizeWorkspaceKey(filePath)));
  const declaredDeliverable = declaredDeliverableBody(content);
  if (hasNewDeliverable && (declaredDeliverable || !force)) return '';
  if (declaredDeliverable) {
    const target = path.join(workspaceRoot, `${safeDelegationDeliverableName(delegation.title || '任务交付物')}.md`);
    writeTextAtomicSync(target, `${declaredDeliverable}\n`);
    return target;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const target = path.join(workspaceRoot, `ubuddy-draft-${stamp}.md`);
  const sharedGroupWorkspace = Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId);
  writeTextAtomicSync(target, [
    `# ${delegation.title || 'uBuddy 任务初稿'}`,
    '',
    '## 原始任务',
    '',
    String(delegation.instruction || '未提供').trim(),
    '',
    '## uBuddy 初步处理结果',
    '',
    content,
    '',
    '## 提交说明',
    '',
    sharedGroupWorkspace
      ? '- 这是任务群共享工作区中的可编辑草稿，所有活跃群成员都可以看到文件内容。'
      : '- 这是接收方私人任务工作区中的可编辑草稿。',
    sharedGroupWorkspace
      ? '- 请在修改前同步最新版本；对外发布和正式承诺仍需任务负责人确认。'
      : '- 请补充缺失事实并确认细节后，再由任务接收人交付给发起方。',
    sharedGroupWorkspace
      ? '- 不要在此文件中写入私聊、个人 Memory、凭据或与任务无关的隐私信息。'
      : '- 本文件不会自动发布到外部平台或共享群聊。',
    '',
  ].join('\n'));
  return target;
}

function declaredDeliverableBody(content = '') {
  const clean = String(content || '').trim();
  const match = /^<!--\s*janus-content-type\s*:\s*deliverable\s*-->\s*/i.exec(clean);
  if (!match) return '';
  return clean.slice(match[0].length)
    .replace(/\n*你可以继续告诉我需要修改的地方，或回复“(?:确认提交|提交到任务群)”。\s*$/u, '')
    .trim();
}

function safeDelegationDeliverableName(value = '') {
  return String(value || '任务交付物')
    .replace(/\.(?:md|markdown)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || '任务交付物';
}


async function uploadCollaborationTaskAttachments({
  runtimeRoot = '', socialRelay, delegationId = '', groupId = '', userId = '', workspaceId = '', attachments = [],
} = {}) {
  const prepared = [];
  for (const attachment of uniqueDelegationAttachments(attachments).slice(0, 20)) {
    if (attachment?.remote_file_id || attachment?.remoteFileId) {
      prepared.push({ attachment, remote: true });
      continue;
    }
    const sourcePath = collaborationAttachmentSourcePath(runtimeRoot, attachment);
    if (sourcePath) {
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”不是有效文件，未执行提交。`);
      if (!stat.size) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”是空文件，未执行提交。`);
      if (stat.size > MAX_REMOTE_FILE_BYTES) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”超过 2 GB，未执行提交。`);
      prepared.push({ attachment, sourcePath, size: stat.size, mtimeMs: stat.mtimeMs });
      continue;
    }
    const recovered = await recoverCollaborationGroupWorkspaceAttachment({
      socialRelay, groupId: groupId || attachment?.group_id || attachment?.groupId || '', workspaceId, attachment,
    });
    if (!recovered) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”的本地文件已经不可用，未执行提交。`);
    if (!recovered.data.length) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”是空文件，未执行提交。`);
    if (recovered.data.length > MAX_REMOTE_FILE_BYTES) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”超过 2 GB，未执行提交。`);
    prepared.push({ attachment, data: recovered.data, size: recovered.data.length, recoveredFromGroupWorkspace: true });
  }
  const concurrency = prepared.some((item) => Number(item.size || 0) > FAST_REMOTE_FILE_BYTES)
    ? 1
    : Math.min(4, Math.max(1, prepared.length));
  return mapWithConcurrency(prepared, concurrency, async (item) => {
    if (item.remote) {
      return publicDelegationAttachment(item.attachment);
    }
    const { attachment, sourcePath } = item;
    let data = item.data || null;
    let currentSize = Number(item.size || data?.length || 0);
    if (sourcePath) {
      const currentStat = fs.statSync(sourcePath);
      if (!currentStat.isFile() || currentStat.size !== item.size || currentStat.mtimeMs !== item.mtimeMs) {
        throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”在提交前已发生变化，请重新确认后提交。`);
      }
      currentSize = currentStat.size;
      data = currentStat.size <= FAST_REMOTE_FILE_BYTES ? fs.readFileSync(sourcePath) : null;
    }
    const sha256 = data ? crypto.createHash('sha256').update(data).digest('hex') : await sha256File(sourcePath);
    const fileId = `collab_file_${sha256Text(`${delegationId}:${userId}:${sha256}`).slice(0, 40)}`;
    const filename = safeCollaborationFilename(attachment?.filename || attachment?.name || path.basename(sourcePath || ''));
    const contentType = attachment?.content_type || attachment?.type || 'application/octet-stream';
    const response = data
      ? await retryTransientFileTransfer(() => socialRelay.uploadCollaborationFile(delegationId, fileId, {
        workspaceId, filename, contentType, size: currentSize, sha256, body: data,
      }))
      : await uploadResumableFileFromPath({
        socialRelay, sourcePath, fileId, scopeKind: 'collaboration_task', scopeId: delegationId,
        workspaceId, filename, contentType, size: currentSize, sha256,
      });
    if (!response?.attachment?.remote_file_id) throw new Error(`任务附件“${attachment?.name || attachment?.filename || 'file'}”上传后未返回有效文件标识，未执行提交。`);
    const cachePayload = {
      runtimeRoot, userId: socialRelay.remoteUserId?.(userId) || userId, fileId: response.attachment.remote_file_id,
      filename: response.attachment.filename || response.attachment.name || attachment?.filename || attachment?.name || path.basename(sourcePath || ''),
      sha256: response.attachment.sha256 || sha256,
    };
    try {
      if (data) cacheRemoteMessageFile({ ...cachePayload, data, size: currentSize });
      else cacheRemoteMessageFileFromPath({ ...cachePayload, sourcePath, size: currentSize });
    } catch {
      // The authoritative upload succeeded; a local cache failure must not
      // turn a valid remote delivery into a failed task submission.
    }
    return publicDelegationAttachment({
      ...response.attachment,
      relative_path: attachment.relative_path || attachment.relativePath
        || attachment.workspace_relative_path || attachment.workspaceRelativePath || '',
    });
  });
}

async function mapWithConcurrency(items = [], limit = 1, iteratee) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit || 1)), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iteratee(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function collaborationAttachmentSourcePath(runtimeRoot = '', attachment = {}) {
  const candidates = [attachment.path, attachment.source_path, attachment.sourcePath]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const relative = String(attachment.relative_path || attachment.relativePath || '').trim();
  if (relative) candidates.push(path.join(runtimeRoot, relative));
  const rawOwnerId = String(attachment.user_id || attachment.owner_id || attachment.userId || attachment.ownerId || '').trim();
  const rawUploadId = String(attachment.id || '').trim();
  const ownerId = rawOwnerId ? safeDelegationWorkspaceSegment(rawOwnerId) : '';
  const uploadId = rawUploadId ? safeDelegationWorkspaceSegment(rawUploadId) : '';
  const filename = safeCollaborationFilename(attachment.filename || attachment.name || '');
  if (ownerId && uploadId && filename) candidates.push(path.join(dataDir(runtimeRoot), 'uploads', ownerId, uploadId, filename));
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return '';
}

async function recoverCollaborationGroupWorkspaceAttachment({ socialRelay, groupId = '', workspaceId = '', attachment = {} } = {}) {
  const cleanGroupId = String(groupId || '').trim();
  if (!cleanGroupId || typeof socialRelay?.collaborationGroupWorkspace !== 'function'
    || typeof socialRelay?.downloadCollaborationGroupWorkspaceFile !== 'function') return null;
  const relativePath = delegationAttachmentWorkspaceRelativePath(attachment, cleanGroupId);
  const workspace = await socialRelay.collaborationGroupWorkspace(cleanGroupId, { workspaceId, sinceRevision: 0 }).catch(() => null);
  const available = (Array.isArray(workspace?.files) ? workspace.files : []).filter((item) => !item?.deleted);
  let remoteFile = relativePath
    ? available.find((item) => normalizeDelegationWorkspaceRelativePath(item.relativePath || item.relative_path || '') === relativePath)
    : null;
  if (!remoteFile) {
    const filename = safeCollaborationFilename(attachment.filename || attachment.name || '');
    const matches = available.filter((item) => safeCollaborationFilename(item.filename || item.name || path.basename(item.relativePath || item.relative_path || '')) === filename
      && (!Number(attachment.size || 0) || Number(item.size || item.size_bytes || 0) === Number(attachment.size || 0)));
    if (matches.length === 1) [remoteFile] = matches;
  }
  if (!remoteFile?.id) return null;
  const data = Buffer.from(await socialRelay.downloadCollaborationGroupWorkspaceFile(cleanGroupId, remoteFile.id, { workspaceId }));
  const expectedSha256 = String(remoteFile.sha256 || attachment.sha256 || '').trim().toLowerCase();
  if (expectedSha256) {
    const actualSha256 = crypto.createHash('sha256').update(data).digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error(`共享工作区中的任务附件“${attachment?.name || attachment?.filename || 'file'}”校验失败，未执行提交。`);
  }
  return { data, remoteFile };
}

function delegationAttachmentWorkspaceRelativePath(attachment = {}, groupId = '') {
  const explicit = normalizeDelegationWorkspaceRelativePath(
    attachment.workspace_relative_path || attachment.workspaceRelativePath || '',
  );
  if (explicit) return explicit;
  const sourcePath = String(attachment.source_path || attachment.sourcePath || '').replace(/\\/g, '/');
  const marker = `/${String(groupId || '').trim()}/`;
  const markerIndex = sourcePath.lastIndexOf(marker);
  return markerIndex >= 0 ? normalizeDelegationWorkspaceRelativePath(sourcePath.slice(markerIndex + marker.length)) : '';
}

function normalizeDelegationWorkspaceRelativePath(value = '') {
  const clean = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return '';
  return clean;
}

function safeCollaborationFilename(value = '') {
  return path.basename(String(value || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 180) || 'file';
}


export {
  collectDelegationGeneratedFiles,
  ensureDelegationEditableDraftFile,
  ensureDelegationTaskWorkspace,
  listDelegationWorkspaceDeliverables,
  safeCollaborationFilename,
  snapshotDelegationWorkspaceDeliverables,
  uploadCollaborationTaskAttachments,
};
