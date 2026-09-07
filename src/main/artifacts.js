import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureDirSync, newId } from './utils.js';

export const ARTIFACT_MARKER = '__JANUS_ARTIFACT__';
const GENERATED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export function outputsDir(root) {
  return path.join(root, 'outputs');
}

export function sessionOutputsDir(root, sessionId) {
  const cleanRoot = String(root || '').trim();
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanRoot) throw new Error('A workspace root is required for session outputs.');
  if (!cleanSessionId) throw new Error('A session ID is required for session outputs.');
  const encodedSessionId = encodeURIComponent(cleanSessionId).replaceAll('.', '%2E');
  return path.join(outputsDir(path.resolve(cleanRoot)), encodedSessionId);
}

export function artifactMessage(kind, data) {
  return `${ARTIFACT_MARKER}${JSON.stringify({ kind, data })}`;
}

export function parseArtifactMessage(content) {
  const text = String(content || '');
  if (!text.startsWith(ARTIFACT_MARKER)) return null;
  try {
    const payload = JSON.parse(text.slice(ARTIFACT_MARKER.length));
    if (!payload?.kind || typeof payload.data !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

export function artifactFileInfo(root, file, extra = {}) {
  const resolved = path.resolve(file);
  const base = path.basename(resolved);
  const outputs = outputsDir(root);
  ensureDirSync(outputs);
  let relativePath = '';
  try {
    relativePath = path.relative(outputs, resolved).replace(/\\/g, '/');
    if (relativePath.startsWith('..')) relativePath = '';
  } catch {
    relativePath = '';
  }
  return {
    id: extra.id || newId('artifact'),
    name: extra.name || base,
    filename: extra.filename || extra.name || base,
    kind: extra.kind || artifactKind(base),
    content_type: extra.content_type || guessArtifactContentType(base),
    type: extra.type || extra.content_type || guessArtifactContentType(base),
    path: resolved,
    relative_path: relativePath,
    workspace_relative_path: path.relative(root, resolved).replace(/\\/g, '/'),
    preview_url: pathToFileURL(resolved).href,
    file_url: pathToFileURL(resolved).href,
    download_url: pathToFileURL(resolved).href,
    render_url: `janus-render://artifact/${encodeURIComponent(path.relative(root, resolved).replace(/\\/g, '/'))}`,
    office_pdf_url: '',
    size: fs.existsSync(resolved) ? fs.statSync(resolved).size : 0,
    ...extra,
  };
}

export function archiveCodexGeneratedImageArtifact({ workspaceRoot, outputRoot = workspaceRoot, sourcePath }) {
  const requestedRoot = String(workspaceRoot || '').trim();
  const requestedOutputRoot = String(outputRoot || '').trim();
  const requestedSource = String(sourcePath || '').trim();
  if (!requestedRoot) throw new Error('没有可用于保存生成图片的工作区。');
  if (!requestedOutputRoot) throw new Error('没有可用于归档生成图片的会话产物目录。');
  if (!requestedSource) throw new Error('图片工具没有返回可归档的文件路径。');

  const canonicalRoot = canonicalDirectory(requestedRoot, '当前工作区不存在或不可访问。');
  const resolvedOutputRoot = path.resolve(requestedOutputRoot);
  if (!pathIsInside(canonicalRoot, resolvedOutputRoot)) {
    throw new Error('会话产物目录不在当前工作区内，已拒绝归档。');
  }
  const canonicalOutputAncestor = canonicalExistingAncestor(resolvedOutputRoot);
  if (!pathIsInside(canonicalRoot, canonicalOutputAncestor)) {
    throw new Error('会话产物目录通过链接指向当前工作区外，已拒绝归档。');
  }
  ensureDirSync(resolvedOutputRoot);
  const canonicalOutputRoot = canonicalDirectory(resolvedOutputRoot, '会话产物目录不存在或不可访问。');
  if (!pathIsInside(canonicalRoot, canonicalOutputRoot)) {
    throw new Error('会话产物目录不在当前工作区内，已拒绝归档。');
  }
  const canonicalSource = canonicalFile(requestedSource, '图片工具返回的文件不存在或不可访问。');
  const extension = path.extname(canonicalSource).toLowerCase();
  if (!GENERATED_IMAGE_EXTENSIONS.has(extension)) throw new Error('图片工具返回的文件不是支持的图片格式。');

  let target = canonicalSource;
  if (!pathIsInside(canonicalOutputRoot, canonicalSource)) {
    target = copyGeneratedImageIntoDirectory(canonicalOutputRoot, canonicalSource);
  }

  const canonicalTarget = canonicalFile(target, '生成图片复制完成后无法读取。');
  if (!pathIsInside(canonicalRoot, canonicalTarget)) {
    throw new Error('生成图片的真实路径不在当前工作区内，已拒绝注册。');
  }

  return {
    kind: 'image',
    ...artifactFileInfo(canonicalRoot, canonicalTarget, {
      kind: 'image',
      preview: {
        kind: 'image',
        title: 'Agent 生成图片',
        subtitle: '',
      },
    }),
  };
}

function canonicalDirectory(value, errorMessage) {
  try {
    const resolved = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(resolved).isDirectory()) throw new Error(errorMessage);
    return resolved;
  } catch {
    throw new Error(errorMessage);
  }
}

function canonicalFile(value, errorMessage) {
  try {
    const resolved = fs.realpathSync(path.resolve(value));
    if (!fs.statSync(resolved).isFile()) throw new Error(errorMessage);
    return resolved;
  } catch {
    throw new Error(errorMessage);
  }
}

function canonicalExistingAncestor(value) {
  let candidate = path.resolve(value);
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return fs.realpathSync(candidate);
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function copyGeneratedImageIntoDirectory(outputRoot, source) {
  const extension = path.extname(source).toLowerCase();
  const rawStem = path.basename(source, path.extname(source));
  const safeStem = rawStem
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 96) || `agent-generated-${newId('img').split('_').pop().slice(0, 8)}`;
  for (let index = 1; index < 10_000; index += 1) {
    const suffix = index === 1 ? '' : `-${index}`;
    const candidate = path.join(outputRoot, `${safeStem}${suffix}${extension}`);
    try {
      fs.copyFileSync(source, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw new Error(`无法将生成图片复制到当前工作区：${error?.message || error}`);
    }
  }
  throw new Error('无法为生成图片分配唯一的工作区文件名。');
}

export function latestArtifact(store, sessionId, kind = '') {
  if (!sessionId) return null;
  const messages = store.listMessages(sessionId).slice().reverse();
  for (const message of messages) {
    const artifact = parseArtifactMessage(message.content);
    if (artifact && (!kind || artifact.kind === kind)) return artifact.data;
  }
  return null;
}

function artifactKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (['.txt', '.json', '.csv', '.tsv', '.html', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py'].includes(ext)) return 'text';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';
  return 'binary';
}

function guessArtifactContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
  }[ext] || 'application/octet-stream';
}
