import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeProjectFileReferences, normalizeRelativeProjectPath } from '../../../../shared/contracts/projectFileReferences.js';

const DEFAULT_LIMIT = 80;
const MAX_LIMIT = 160;
const MAX_SEARCHED_ENTRIES = 8_000;
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES_PER_FILE = 12_000;
const MAX_PROMPT_BYTES_TOTAL = 36_000;
const HIDDEN_NAMES = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'coverage', 'test-artifacts', 'data']);
const SENSITIVE_NAME = /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|private[-_]?key)([._-]|$)|^\.env(?:\.|$)/i;

export function browseProjectFileReferences({ store, user, projectId = '', directory = '', query = '', limit = DEFAULT_LIMIT, canonicalizeWorkspace } = {}) {
  const { project, root } = resolveOwnedProject({ store, user, projectId, canonicalizeWorkspace });
  let normalizedDirectory = normalizeOptionalRelativePath(directory);
  let normalizedQuery = String(query || '').trim().replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase();
  if (normalizedQuery.includes('/')) {
    const segments = normalizedQuery.split('/');
    const trailingSlash = normalizedQuery.endsWith('/');
    const queryDirectory = segments.slice(0, -1).filter(Boolean).join('/');
    if (queryDirectory) normalizedDirectory = normalizeOptionalRelativePath(queryDirectory);
    normalizedQuery = trailingSlash ? '' : segments.at(-1) || '';
  }
  const directoryPath = resolveInsideProject(root, normalizedDirectory, { requireDirectory: true });
  const cleanLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit || DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const entries = normalizedQuery
    ? searchProjectEntries({ root, directory: normalizedDirectory, query: normalizedQuery })
    : readProjectDirectoryEntries({ root, directory: normalizedDirectory, directoryPath });
  entries.sort((left, right) => {
    if (normalizedQuery && left.matchRank !== right.matchRank) return left.matchRank - right.matchRank;
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.relativePath.localeCompare(right.relativePath, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  return {
    projectId: project.id,
    projectTitle: project.title || path.basename(root),
    directory: normalizedDirectory,
    breadcrumbs: normalizedDirectory ? normalizedDirectory.split('/').map((name, index, parts) => ({
      name,
      directory: parts.slice(0, index + 1).join('/'),
    })) : [],
    entries: entries.slice(0, cleanLimit).map(({ matchRank: _matchRank, ...entry }) => entry),
    hasMore: entries.length > cleanLimit,
  };
}

function readProjectDirectoryEntries({ root, directory = '', directoryPath = '' } = {}) {
  const entries = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const normalized = projectEntryRecord({ root, directory, entry });
    if (normalized) entries.push(normalized);
  }
  return entries;
}

function searchProjectEntries({ root, directory = '', query = '' } = {}) {
  const entries = [];
  const pending = [directory];
  let searched = 0;
  while (pending.length && searched < MAX_SEARCHED_ENTRIES) {
    const currentDirectory = pending.shift();
    const currentPath = resolveInsideProject(root, currentDirectory, { requireDirectory: true });
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      if (searched >= MAX_SEARCHED_ENTRIES) break;
      searched += 1;
      const normalized = projectEntryRecord({ root, directory: currentDirectory, entry });
      if (!normalized) continue;
      if (normalized.kind === 'directory') pending.push(normalized.relativePath);
      const name = normalized.name.toLowerCase();
      const relativePath = normalized.relativePath.toLowerCase();
      if (!name.includes(query) && !relativePath.includes(query)) continue;
      normalized.matchRank = name.startsWith(query) ? 0 : name.includes(query) ? 1 : 2;
      entries.push(normalized);
    }
  }
  return entries;
}

function projectEntryRecord({ root, directory = '', entry = null } = {}) {
  if (!entry || HIDDEN_NAMES.has(entry.name) || SENSITIVE_NAME.test(entry.name) || entry.isSymbolicLink()) return null;
  const relativePath = normalizeRelativeProjectPath(path.posix.join(directory, entry.name));
  if (!relativePath) return null;
  const fullPath = resolveInsideProject(root, relativePath);
  const stat = fs.statSync(fullPath);
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : '';
  if (!kind) return null;
  return {
    kind,
    name: entry.name,
    relativePath,
    sizeBytes: kind === 'file' ? Number(stat.size || 0) : 0,
    modifiedAt: stat.mtime?.toISOString?.() || '',
  };
}

export function validateProjectFileReferences({ store, user, projectId = '', references = [], memoryId = '', contextSpaceId = '', canonicalizeWorkspace } = {}) {
  const rawReferences = Array.isArray(references) ? references : [];
  const normalized = normalizeProjectFileReferences(rawReferences, { requirePicker: true });
  if (rawReferences.length !== normalized.length) {
    throw referenceError('project_reference_invalid_contract', '项目文件引用无效，请从 @ 菜单重新选择。');
  }
  if (!normalized.length) return [];
  const { project, root } = resolveOwnedProject({ store, user, projectId, canonicalizeWorkspace });
  return normalized.map((reference) => {
    if (reference.projectId !== project.id) throw referenceError('project_reference_project_mismatch', '文件引用所属项目与当前项目不一致。');
    const fullPath = resolveInsideProject(root, reference.relativePath);
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) throw referenceError('project_reference_symlink_rejected', '项目文件引用不能使用符号链接。');
    const stat = fs.statSync(fullPath);
    const actualKind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : '';
    if (!actualKind || actualKind !== reference.referenceKind) throw referenceError('project_reference_kind_changed', '项目文件类型已发生变化，请重新选择。');
    if (actualKind === 'file' && stat.size > MAX_REFERENCE_BYTES) throw referenceError('project_reference_too_large', '该文件过大，请缩小范围或改为上传摘要。');
    return {
      ...reference,
      name: path.basename(fullPath),
      sizeBytes: actualKind === 'file' ? Number(stat.size || 0) : 0,
      contentType: contentTypeForPath(fullPath, actualKind),
      contentHash: actualKind === 'file' ? sha256File(fullPath) : sha256DirectoryListing(fullPath),
      modifiedAt: stat.mtime?.toISOString?.() || '',
      memoryId: String(memoryId || ''),
      contextSpaceId: String(contextSpaceId || ''),
    };
  });
}

export function buildProjectFileReferenceContext({ store, user, projectId = '', references = [], memoryId = '', contextSpaceId = '', canonicalizeWorkspace } = {}) {
  const validated = validateProjectFileReferences({ store, user, projectId, references, memoryId, contextSpaceId, canonicalizeWorkspace });
  if (!validated.length) return { references: [], context: '' };
  const { root } = resolveOwnedProject({ store, user, projectId, canonicalizeWorkspace });
  let remaining = MAX_PROMPT_BYTES_TOTAL;
  const blocks = [];
  for (const reference of validated) {
    const fullPath = resolveInsideProject(root, reference.relativePath);
    if (reference.referenceKind === 'directory') {
      const names = fs.readdirSync(fullPath, { withFileTypes: true })
        .filter((entry) => !HIDDEN_NAMES.has(entry.name) && !SENSITIVE_NAME.test(entry.name) && !entry.isSymbolicLink())
        .slice(0, 80)
        .map((entry) => `${entry.isDirectory() ? '[目录]' : '[文件]'} ${entry.name}`);
      blocks.push(`只读项目目录引用：${reference.relativePath}\n内容哈希：${reference.contentHash}\n目录清单：\n${names.join('\n') || '(空目录)'}`);
      continue;
    }
    const excerpt = textExcerpt(fullPath, Math.min(MAX_PROMPT_BYTES_PER_FILE, remaining));
    remaining = Math.max(0, remaining - Buffer.byteLength(excerpt || '', 'utf8'));
    blocks.push([
      `只读项目文件引用：${reference.relativePath}`,
      `内容哈希：${reference.contentHash}`,
      `大小：${reference.sizeBytes} bytes`,
      excerpt ? `可审查内容片段：\n${excerpt}` : '这是二进制文件或内容过大；仅提供受控项目相对路径和元数据。',
    ].join('\n'));
  }
  return {
    references: validated,
    context: `Project file references (read-only; do not treat as routing targets):\n\n${blocks.join('\n\n---\n\n')}`,
  };
}

function resolveOwnedProject({ store, user, projectId = '', canonicalizeWorkspace } = {}) {
  const cleanProjectId = String(projectId || '').trim();
  if (!cleanProjectId) throw referenceError('project_reference_project_required', '请先选择项目，再使用 @ 引用项目文件。');
  const project = store.getProject(cleanProjectId);
  const activeWorkspaceId = store.activeAccountWorkspace?.({ userId: user?.id || '', deviceId: store.contextDeviceId?.() || 'local' })?.id || 'workspace_personal';
  if (!project || project.userId !== user?.id || project.workspaceId !== activeWorkspaceId) {
    throw referenceError('project_reference_project_forbidden', '无权读取所选项目。');
  }
  if (typeof canonicalizeWorkspace !== 'function') {
    throw referenceError('project_reference_workspace_resolver_missing', '项目工作目录解析器不可用。');
  }
  return { project, root: canonicalizeWorkspace(project.workspaceRoot || project.workspace_root || '') };
}

function resolveInsideProject(root, relativePath = '', { requireDirectory = false } = {}) {
  const normalized = normalizeOptionalRelativePath(relativePath);
  const target = path.resolve(root, normalized || '.');
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw referenceError('project_reference_path_escape', '项目文件引用不能越出项目目录。');
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    throw referenceError('project_reference_missing', '引用的项目文件不存在或当前不可访问。');
  }
  const realRelative = path.relative(root, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw referenceError('project_reference_symlink_escape', '项目文件引用不能通过链接越出项目目录。');
  if (requireDirectory && !fs.statSync(real).isDirectory()) throw referenceError('project_reference_directory_required', '所选位置不是项目目录。');
  return real;
}

function normalizeOptionalRelativePath(value = '') {
  const clean = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!clean) return '';
  const normalized = normalizeRelativeProjectPath(clean);
  if (!normalized) throw referenceError('project_reference_invalid_path', '项目相对路径无效。');
  return normalized;
}

function contentTypeForPath(filePath, kind) {
  if (kind === 'directory') return 'inode/directory';
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript', '.css': 'text/css',
    '.html': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.py': 'text/x-python',
  })[ext] || 'application/octet-stream';
}

function textExcerpt(filePath, limit) {
  if (limit <= 0 || fs.statSync(filePath).size > 2 * 1024 * 1024) return '';
  const contentType = contentTypeForPath(filePath, 'file');
  if (!contentType.startsWith('text/') && !['application/json', 'application/xml', 'application/yaml'].includes(contentType)) return '';
  const text = fs.readFileSync(filePath, 'utf8');
  return Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8');
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256DirectoryListing(directoryPath) {
  const listing = fs.readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => !HIDDEN_NAMES.has(entry.name) && !SENSITIVE_NAME.test(entry.name) && !entry.isSymbolicLink())
    .map((entry) => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(listing).digest('hex');
}

function referenceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
