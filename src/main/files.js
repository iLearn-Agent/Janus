import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

import { dataDir } from './paths.js';
import { parseArtifactMessage } from './artifacts.js';
import { resolvePythonInvocation } from './python.js';
import { ensureDirSync, newId } from './utils.js';
import { readZipEntries } from './zip.js';
import { inspectOfficeFile, officeFileLabel } from './officeArtifacts.js';

const DESKTOP_USER_ID = 'desktop';
const MAX_UPLOAD_FILE_BYTES = 60 * 1024 * 1024;
const MAX_PATH_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 90_000;
const MAX_MEMORY_FILE_CONTEXT_CHARS = 60_000;
const MAX_MEMORY_CONTEXT_FILES = 12;
const DEFAULT_ATTACHMENT_CATALOG_EXCERPT_CHARS = 8_000;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.js', '.mjs', '.ts', '.tsx',
  '.jsx', '.py', '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.go', '.rs', '.html', '.css', '.xml',
  '.toml', '.yaml', '.yml', '.tex', '.bib', '.log',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']);
const WORD_EXTENSIONS = new Set(['.doc', '.docx']);
const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx']);
const PRESENTATION_EXTENSIONS = new Set(['.ppt', '.pptx']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz']);
const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.dmg', '.pkg', '.apk', '.appimage', '.deb', '.rpm', '.iso']);
const PPT_SOURCE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const OOXML_MEDIA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_PPT_SOURCE_VISUALS = Number(process.env.JANUS_PPT_SOURCE_VISUAL_MAX || 8);
const MAX_PPT_SOURCE_VISUAL_BYTES = Number(process.env.JANUS_PPT_SOURCE_VISUAL_BYTES || 18 * 1024 * 1024);
const MAX_DOCX_PREVIEW_IMAGES = Number(process.env.JANUS_DOCX_PREVIEW_IMAGE_MAX || 24);
const MAX_DOCX_PREVIEW_IMAGE_BYTES = Number(process.env.JANUS_DOCX_PREVIEW_IMAGE_BYTES || 10 * 1024 * 1024);
const MAX_SPREADSHEET_PREVIEW_SHEETS = Number(process.env.JANUS_SPREADSHEET_PREVIEW_SHEETS || 6);
const MAX_SPREADSHEET_PREVIEW_ROWS = Number(process.env.JANUS_SPREADSHEET_PREVIEW_ROWS || 80);
const MAX_SPREADSHEET_PREVIEW_COLS = Number(process.env.JANUS_SPREADSHEET_PREVIEW_COLS || 24);

export function uploadFile(root, { filename = 'file', contentType = '', dataBase64 = '' } = {}, userId = DESKTOP_USER_ID) {
  const data = decodeUploadData(dataBase64);
  if (data.length > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`文件超过限制，最大支持 ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB。`);
  }
  return saveUploadedFile(root, {
    filename,
    contentType,
    size: data.length,
    write: (target) => fs.writeFileSync(target, data),
  }, userId);
}

export function uploadFileFromPath(root, { sourcePath = '', filename = '', contentType = '' } = {}, userId = DESKTOP_USER_ID) {
  const source = path.resolve(String(sourcePath || ''));
  if (!sourcePath || !fs.existsSync(source)) throw new Error('没有找到所选文件。');
  const stat = fs.statSync(source);
  if (!stat.isFile()) throw new Error('暂不支持上传文件夹。');
  if (stat.size > MAX_PATH_UPLOAD_FILE_BYTES) {
    throw new Error('文件超过限制，最大支持 2 GB。');
  }
  return saveUploadedFile(root, {
    filename: filename || path.basename(source),
    contentType,
    size: stat.size,
    write: (target) => fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE),
  }, userId);
}

function saveUploadedFile(root, { filename = 'file', contentType = '', size = 0, write } = {}, userId = DESKTOP_USER_ID) {
  const uploadId = newId('upload');
  const safeName = safeUploadFilename(filename);
  const ownerId = safePathSegment(userId || DESKTOP_USER_ID) || DESKTOP_USER_ID;
  const uploadDir = path.join(dataDir(root), 'uploads', ownerId, uploadId);
  ensureDirSync(uploadDir);
  const target = path.join(uploadDir, safeName);
  write(target);
  return {
    ...filePreviewInfo(root, target, {
      id: uploadId,
      filename: safeName,
      name: safeName,
      content_type: contentType || guessContentType(safeName),
      type: contentType || guessContentType(safeName),
      size,
      user_id: ownerId,
      owner_id: ownerId,
    }),
    render_url: `janus-render://${uploadId}/${encodeURIComponent(safeName)}`,
    office_pdf_url: '',
  };
}

export function renderUploadedFile(root, { id = '', filename = '', path: filePath = '', relative_path: relativePath = '', relativePath: camelRelativePath = '' } = {}, options = {}) {
  const relative = relativePath || camelRelativePath;
  const target = filePath
    ? safePathInside(root, filePath, options.allowedRoots)
    : relative
      ? resolveFileTarget(root, { relative_path: relative }, DESKTOP_USER_ID, options)
      : uploadedFileTarget(root, { id, name: filename });
  return renderFilePreview(root, target, options);
}

export function uploadedFileTarget(root, attachment, fallbackUserId = DESKTOP_USER_ID) {
  const id = safePathSegment(attachment?.id || '');
  const filename = safeUploadFilename(attachment?.name || attachment?.filename || '');
  if (!id || !filename) throw new Error('附件信息不完整。');
  const ownerIds = [
    safePathSegment(attachment?.user_id || attachment?.owner_id || attachment?.userId || attachment?.ownerId || ''),
    safePathSegment(fallbackUserId || ''),
    DESKTOP_USER_ID,
  ].filter(Boolean);
  for (const ownerId of [...new Set(ownerIds)]) {
    const uploadsRoot = path.resolve(dataDir(root), 'uploads', ownerId);
    const target = path.resolve(uploadsRoot, id, filename);
    if (target.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(target)) return target;
  }
  throw new Error('没有找到可引用的上传文件。');
}

export function buildMessageWithAttachments(root, message, attachments = [], userId = DESKTOP_USER_ID) {
  if (!attachments.length) return message;
  const sections = [];
  for (const attachment of attachments) {
    const target = resolveAttachmentPath(root, attachment, userId);
    const name = path.basename(target);
    const type = attachment.type || attachment.content_type || guessContentType(name);
    const size = fs.statSync(target).size;
    sections.push([
      `文件: ${name} (${type || 'unknown'}, ${formatBytes(size)})`,
      `工作区相对路径: ${path.relative(root, target).replace(/\\/g, '/')}`,
      `预览链接: ${pathToFileURL(target).href}`,
      `下载链接: ${pathToFileURL(target).href}`,
      `渲染链接: janus-render://${attachment.id || ''}/${encodeURIComponent(name)}`,
      '真实渲染链接: ',
      '请根据任务需要使用可用工具读取该文件；如果系统提供了私有附件正文上下文，应优先结合该上下文完成任务。',
    ].join('\n'));
  }
  return `${message}\n\n附加资源:\n\n${sections.join('\n\n')}`;
}

export function buildAttachmentContext(root, message, attachments = [], userId = DESKTOP_USER_ID) {
  const targets = uploadedAttachmentTargets(root, message, attachments, userId);
  if (!targets.length) return '';
  const blocks = [];
  let used = 0;
  for (const target of targets) {
    const remaining = MAX_ATTACHMENT_CONTEXT_CHARS - used;
    if (remaining <= 0) {
      blocks.push('[其余附件因上下文长度限制未展开。]');
      break;
    }
    const rel = path.relative(root, target).replace(/\\/g, '/');
    let text = '';
    try {
      text = extractFileContextText(target);
      if (text.length > remaining) text = `${text.slice(0, remaining).trimEnd()}\n[附件正文因上下文长度限制截断。]`;
    } catch (error) {
      text = `自动正文提取失败: ${error.message || error}`;
    }
    blocks.push(`文件: ${path.basename(target)}\n工作区相对路径: ${rel}\n已提取正文:\n${text}`);
    used += blocks[blocks.length - 1].length;
  }
  return [
    'Private attachment context for this turn. Use it as source material when relevant.',
    'This context is not user-facing; do not mention backend extraction, internal paths, or tool errors to the user.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

export function buildMemoryFileContext(root, messages = [], {
  workspaceRoot = '',
  userId = DESKTOP_USER_ID,
  memoryContent = '',
  excludePaths = [],
  maxFiles = MAX_MEMORY_CONTEXT_FILES,
  maxChars = MAX_MEMORY_FILE_CONTEXT_CHARS,
} = {}) {
  const excluded = new Set(excludePaths.map((item) => path.resolve(String(item || ''))).filter(Boolean));
  const projectReferenceStates = collectProjectReferenceStates(messages, { workspaceRoot });
  const files = collectMemoryContextFiles(root, messages, { workspaceRoot, userId, memoryContent })
    .filter((item) => !excluded.has(item.path))
    .slice(0, Math.max(1, Math.min(24, Number(maxFiles) || MAX_MEMORY_CONTEXT_FILES)));
  const unavailableReferences = projectReferenceStates.filter((item) => item.status !== 'available');
  if (!files.length && !unavailableReferences.length) return { context: '', files: [] };
  const blocks = [];
  let used = 0;
  const cleanLimit = Math.max(4_000, Math.min(MAX_ATTACHMENT_CONTEXT_CHARS, Number(maxChars) || MAX_MEMORY_FILE_CONTEXT_CHARS));
  for (const file of files) {
    const remaining = cleanLimit - used;
    if (remaining <= 0) break;
    let content = '';
    try {
      content = extractFileContextText(file.path);
    } catch (error) {
      content = `文件正文提取失败：${error.message || error}`;
    }
    if (content.length > remaining) content = `${content.slice(0, remaining).trimEnd()}\n[文件正文因 Memory 上下文长度限制截断。]`;
    const block = `文件：${file.name}\nMemory 相对路径：${file.displayPath}\n已读取正文：\n${content}`;
    blocks.push(block);
    used += block.length;
  }
  const unavailableBlock = unavailableReferences.length
    ? ['Historical project references that are not readable now:', ...unavailableReferences.map((item) => (
      `- ${item.relativePath}: ${item.status === 'changed' ? 'file changed after it was referenced; require the user to reselect or confirm the current version' : 'file is missing or inaccessible'}`
    ))].join('\n')
    : '';
  if (!blocks.length && !unavailableBlock) return { context: '', files: [] };
  return {
    context: [
      'Files linked exclusively to the currently selected Janus Memory context.',
      'Use their extracted contents together with the selected Memory. Do not use files or conversation state from another Memory context.',
      '',
      blocks.join('\n\n---\n\n'),
      unavailableBlock,
    ].join('\n'),
    files: files.slice(0, blocks.length),
  };
}

export function collectMemoryContextFiles(root, messages = [], {
  workspaceRoot = '',
  userId = DESKTOP_USER_ID,
  memoryContent = '',
} = {}) {
  const allowedRoots = [...new Set([root, workspaceRoot].map((item) => String(item || '').trim()).filter(Boolean).map((item) => path.resolve(item)))];
  const found = new Map();
  const addFile = (candidate, source = 'message') => {
    const resolved = resolveMemoryContextFile(candidate, allowedRoots);
    if (!resolved || found.has(resolved)) return;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_UPLOAD_FILE_BYTES || memoryContextFileExcluded(resolved)) return;
    found.set(resolved, {
      path: resolved,
      name: path.basename(resolved),
      displayPath: memoryFileDisplayPath(resolved, allowedRoots),
      size: stat.size,
      source,
    });
  };
  for (const message of messages || []) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : parseMessageMetadata(message?.metadata_json);
    for (const attachment of Array.isArray(metadata.attachments) ? metadata.attachments : []) {
      try {
        addFile(resolveAttachmentPath(root, attachment, userId), 'attachment');
      } catch {
        for (const candidate of fileDescriptorCandidates(attachment)) addFile(candidate, 'attachment');
      }
    }
    for (const reference of collectProjectReferenceStates([message], { workspaceRoot }).filter((item) => item.status === 'available')) {
      addFile(reference.path, 'project_reference');
    }
    const artifact = parseArtifactMessage(message?.content || '');
    if (artifact?.data) {
      for (const candidate of fileDescriptorCandidates(artifact.data)) addFile(candidate, `artifact:${artifact.kind}`);
    }
    for (const candidate of messageContentFileCandidates(message?.content || '')) addFile(candidate, 'message_link');
  }
  for (const candidate of messageContentFileCandidates(memoryContent)) addFile(candidate, 'memory_link');
  return [...found.values()];
}

export function collectMessageOutputArtifacts(root, content = '', { workspaceRoot = '', changedPaths = null } = {}) {
  const requestedRoot = String(workspaceRoot || root || '').trim();
  if (!requestedRoot) return [];
  let allowedRoot = '';
  try {
    allowedRoot = fs.realpathSync(path.resolve(requestedRoot));
    if (!fs.statSync(allowedRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const artifacts = [];
  const seen = new Set();
  for (const candidate of messageContentFileCandidates(content)) {
    const resolved = resolveDeclaredOutputFile(candidate, allowedRoot);
    if (!resolved || seen.has(resolved)) continue;
    if (changedPaths instanceof Set && !changedPaths.has(resolved)) continue;
    seen.add(resolved);
    const info = filePreviewInfo(root, resolved, {}, { allowedRoots: [allowedRoot] });
    const workspaceRelativePath = path.relative(allowedRoot, resolved).replace(/\\/g, '/');
    artifacts.push({
      ...info,
      relative_path: workspaceRelativePath,
      workspace_relative_path: workspaceRelativePath,
    });
  }
  return artifacts;
}

/**
 * Return files that Codex reported as changed during the current turn.
 * Paths are normalized to absolute workspace paths so they can safely be
 * intersected with the answer's declared output files.
 */
export function collectTurnChangedFilePaths(processEvents = [], { workspaceRoot = '' } = {}) {
  const root = path.resolve(String(workspaceRoot || ''));
  if (!root) return new Set();
  const changed = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const change of Array.isArray(value.changes) ? value.changes : []) {
      const operation = String(change?.kind || change?.operation || '').toLowerCase();
      if (!['add', 'create', 'update', 'modify', 'edit', 'move', 'rename'].includes(operation)) continue;
      for (const candidate of [change.path, change.movePath, change.move_path]) {
        const raw = String(candidate || '').trim();
        if (!raw) continue;
        const resolved = path.resolve(root, raw);
        const relative = path.relative(root, resolved);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) changed.add(resolved);
      }
    }
    Object.values(value).forEach(visit);
  };
  visit(processEvents);
  return changed;
}



export function buildAttachmentCatalog(root, message, attachments = [], userId = DESKTOP_USER_ID, { excerptChars = DEFAULT_ATTACHMENT_CATALOG_EXCERPT_CHARS } = {}) {
  return uploadedAttachmentTargets(root, message, attachments, userId).map((target, index) => {
    const stat = fs.statSync(target);
    const name = path.basename(target);
    let excerpt = '';
    try {
      excerpt = extractFileContextExcerpt(target, excerptChars);
    } catch (error) {
      excerpt = `附件内容预览失败：${error.message || error}`;
    }
    return {
      id: String(attachments[index]?.id || `attachment_${index + 1}`),
      name,
      type: attachments[index]?.type || attachments[index]?.content_type || guessContentType(name),
      size: stat.size,
      relativePath: path.relative(root, target).replace(/\\/g, '/'),
      excerpt,
    };
  });
}

export function stripAttachmentResourceBlock(value = '') {
  const text = String(value || '');
  const marker = '\n\n附加资源:\n';
  const index = text.indexOf(marker);
  return (index >= 0 ? text.slice(0, index) : text).trim();
}

export function uploadedAttachmentTargets(root, message = '', attachments = [], userId = DESKTOP_USER_ID) {
  const targets = [];
  for (const attachment of attachments || []) {
    try {
      const target = resolveAttachmentPath(root, attachment, userId);
      if (!targets.includes(target)) targets.push(target);
    } catch {
      // Ignore stale attachment metadata.
    }
  }
  const relativePaths = [];
  const pattern = /工作区相对路径:\s*([^\n\r]+)/g;
  let match;
  while ((match = pattern.exec(String(message || '')))) {
    relativePaths.push(match[1].trim());
  }
  for (const rel of relativePaths) {
    try {
      const target = safePathInside(root, path.join(root, rel));
      if (fs.existsSync(target) && fs.statSync(target).isFile() && !targets.includes(target)) targets.push(target);
    } catch {
      // Ignore unsafe paths.
    }
  }
  return targets;
}

export function extractPptSourceVisuals(root, message = '', attachments = [], userId = DESKTOP_USER_ID) {
  const targets = uploadedAttachmentTargets(root, message, attachments, userId);
  const visuals = [];
  const seen = new Set();
  for (const target of targets) {
    const remaining = MAX_PPT_SOURCE_VISUALS - visuals.length;
    if (remaining <= 0) break;
    for (const visual of pptSourceVisualsForPath(root, target, remaining)) {
      const resolved = path.resolve(visual);
      if (!fs.existsSync(resolved)) continue;
      if (seen.has(resolved)) continue;
      try {
        safePathInside(root, resolved);
      } catch {
        continue;
      }
      seen.add(resolved);
      visuals.push(resolved);
      if (visuals.length >= MAX_PPT_SOURCE_VISUALS) break;
    }
  }
  return visuals;
}

function pptSourceVisualsForPath(root, file, remaining) {
  if (remaining <= 0 || !fs.existsSync(file)) return [];
  const ext = path.extname(file).toLowerCase();
  if (PPT_SOURCE_IMAGE_EXTENSIONS.has(ext)) return [file];
  if (ext === '.pptx' || ext === '.docx') {
    const embedded = extractOoxmlEmbeddedImages(root, file, remaining);
    if (embedded.length >= remaining) return embedded.slice(0, remaining);
    if (ext === '.pptx') return embedded;
    return embedded;
  }
  if (ext === '.pdf') return renderPdfPagesForPpt(root, file, remaining);
  return [];
}

function extractOoxmlEmbeddedImages(root, file, limit = MAX_PPT_SOURCE_VISUALS) {
  const cacheDir = pptSourceCacheDir(root, file, 'ooxml');
  ensureDirSync(cacheDir);
  const entries = readZipEntries(file);
  const images = [];
  for (const [name, read] of entries) {
    if (images.length >= limit) break;
    const normalized = name.replace(/\\/g, '/').toLowerCase();
    if (!/(^|\/)(word|ppt)\/media\//.test(normalized)) continue;
    const ext = path.extname(normalized);
    if (!OOXML_MEDIA_EXTENSIONS.has(ext)) continue;
    let data;
    try {
      data = read();
    } catch {
      continue;
    }
    if (!data?.length || data.length > MAX_PPT_SOURCE_VISUAL_BYTES) continue;
    const out = path.join(cacheDir, `${String(images.length + 1).padStart(2, '0')}-${path.basename(normalized)}`);
    if (!fs.existsSync(out) || fs.statSync(out).size !== data.length) {
      fs.writeFileSync(out, data);
    }
    images.push(out);
  }
  return images;
}

function renderPdfPagesForPpt(root, file, limit = MAX_PPT_SOURCE_VISUALS) {
  const cacheDir = pptSourceCacheDir(root, file, 'pdf-figures');
  ensureDirSync(cacheDir);
  const script = [
    'from __future__ import annotations',
    'import json, re, sys',
    'from pathlib import Path',
    'pdf=Path(sys.argv[1])',
    'out=Path(sys.argv[2])',
    'limit=max(0, int(sys.argv[3]))',
    'paths=[]',
    'FIG_RE=re.compile(r"\\b(?:fig(?:ure)?\\.?|table)\\s*(\\d{1,2})\\b|图\\s*(\\d{1,2})", re.I)',
    'def rect_area(r):',
    ' return max(0.0, float(r.width))*max(0.0, float(r.height))',
    'def intersect_area(a,b):',
    ' ix0=max(float(a.x0), float(b.x0)); iy0=max(float(a.y0), float(b.y0)); ix1=min(float(a.x1), float(b.x1)); iy1=min(float(a.y1), float(b.y1))',
    ' return max(0.0, ix1-ix0)*max(0.0, iy1-iy0)',
    'def rect_coverage(rects, rect):',
    ' denom=max(1.0, rect_area(rect))',
    ' return min(1.0, sum(intersect_area(item, rect) for item in rects) / denom)',
    'def text_blocks_from_data(data):',
    ' blocks=[]',
    ' for block in data.get("blocks", []):',
    '  if block.get("type") != 0:',
    '   continue',
    '  text=" ".join(span.get("text","") for line in block.get("lines", []) for span in line.get("spans", [])).strip()',
    '  if text:',
    '   blocks.append((fitz.Rect(block.get("bbox")), text))',
    ' return blocks',
    'def text_metrics(text_blocks, rect):',
    ' denom=max(1.0, rect_area(rect))',
    ' area=0.0; chars=0',
    ' for block_rect, text in text_blocks:',
    '  hit=intersect_area(block_rect, rect)',
    '  if hit <= 0:',
    '   continue',
    '  area += hit',
    '  if hit / max(1.0, rect_area(block_rect)) >= 0.18:',
    '   chars += len(text)',
    ' return min(1.0, area / denom), chars',
    'def page_visual_fallback_ok(page):',
    ' data=page.get_text("dict")',
    ' page_rect=page.rect',
    ' page_area=max(1.0, rect_area(page_rect))',
    ' image_rects=[fitz.Rect(block.get("bbox")) for block in data.get("blocks", []) if block.get("type") == 1]',
    ' image_cov=rect_coverage(image_rects, page_rect)',
    ' text_cov, chars=text_metrics(text_blocks_from_data(data), page_rect)',
    ' return image_cov >= 0.35 and text_cov <= 0.18 and chars <= 260',
    'def expand_rect(r, page_rect, pad):',
    ' return fitz.Rect(max(page_rect.x0, r.x0-pad), max(page_rect.y0, r.y0-pad), min(page_rect.x1, r.x1+pad), min(page_rect.y1, r.y1+pad))',
    'def rect_key(r):',
    ' return (round(r.x0,1), round(r.y0,1), round(r.x1,1), round(r.y1,1))',
    'def merge_rects(rects, margin):',
    ' groups=[]',
    ' for rect in rects:',
    '  if rect_area(rect) <= 0:',
    '   continue',
    '  placed=False',
    '  probe=fitz.Rect(rect.x0-margin, rect.y0-margin, rect.x1+margin, rect.y1+margin)',
    '  for i, group in enumerate(groups):',
    '   gprobe=fitz.Rect(group.x0-margin, group.y0-margin, group.x1+margin, group.y1+margin)',
    '   if probe.intersects(gprobe):',
    '    groups[i]=group | rect',
    '    placed=True',
    '    break',
    '  if not placed:',
    '   groups.append(rect)',
    ' changed=True',
    ' while changed:',
    '  changed=False',
    '  merged=[]',
    '  for rect in groups:',
    '   probe=fitz.Rect(rect.x0-margin, rect.y0-margin, rect.x1+margin, rect.y1+margin)',
    '   hit=None',
    '   for i, existing in enumerate(merged):',
    '    eprobe=fitz.Rect(existing.x0-margin, existing.y0-margin, existing.x1+margin, existing.y1+margin)',
    '    if probe.intersects(eprobe):',
    '     hit=i',
    '     break',
    '   if hit is None:',
    '    merged.append(rect)',
    '   else:',
    '    merged[hit]=merged[hit] | rect',
    '    changed=True',
    '  groups=merged',
    ' return groups',
    'def page_captions(page):',
    ' captions=[]',
    ' data=page.get_text("dict")',
    ' for block in data.get("blocks", []):',
    '  if block.get("type") != 0:',
    '   continue',
    '  text=" ".join(span.get("text","") for line in block.get("lines", []) for span in line.get("spans", [])).strip()',
    '  if not text:',
    '   continue',
    '  match=FIG_RE.search(text)',
    '  if match:',
    '   raw=match.group(1) or match.group(2)',
    '   captions.append((fitz.Rect(block.get("bbox")), int(raw) if raw else None, text))',
    ' return captions',
    'def visual_candidates(page, page_index):',
    ' page_rect=page.rect',
    ' page_area=max(1.0, rect_area(page_rect))',
    ' candidates=[]',
    ' data=page.get_text("dict")',
    ' text_blocks=text_blocks_from_data(data)',
    ' image_rects=[]',
    ' for block in data.get("blocks", []):',
    '  if block.get("type") == 1:',
    '   r=fitz.Rect(block.get("bbox"))',
    '   image_rects.append(r)',
    '   area=rect_area(r)/page_area',
    '   if area >= 0.018 and r.width >= page_rect.width*0.18 and r.height >= page_rect.height*0.045:',
    '    candidates.append({"rect": r, "score": 90+area*80, "kind": "image", "fig": None})',
    ' drawing_rects=[]',
    ' try:',
    '  drawings=page.get_drawings()',
    ' except Exception:',
    '  drawings=[]',
    ' for item in drawings:',
    '  r=item.get("rect")',
    '  if not r:',
    '   continue',
    '  r=fitz.Rect(r)',
    '  if r.width < 3 or r.height < 3:',
    '   continue',
    '  if rect_area(r)/page_area > 0.75:',
    '   continue',
    '  drawing_rects.append(r)',
    ' for group in merge_rects(drawing_rects, max(4.0, page_rect.width*0.018)):',
    '  area=rect_area(group)/page_area',
    '  if area < 0.018 or area > 0.62:',
    '   continue',
    '  if group.width < page_rect.width*0.18 or group.height < page_rect.height*0.045:',
    '   continue',
    '  if group.width / max(group.height, 1) > 12 or group.height / max(group.width, 1) > 9:',
    '   continue',
    '  candidates.append({"rect": group, "score": 70+area*95, "kind": "drawing", "fig": None})',
    ' captions=page_captions(page)',
    ' for cap_rect, fig_no, text in captions:',
    '  best_i=None',
    '  best_dist=10**9',
    '  for i, item in enumerate(candidates):',
    '   r=item["rect"]',
    '   if r.y1 <= cap_rect.y0 + page_rect.height*0.04:',
    '    overlap=max(0.0, min(r.x1, cap_rect.x1)-max(r.x0, cap_rect.x0)) / max(1.0, min(r.width, cap_rect.width))',
    '    dist=cap_rect.y0-r.y1 - overlap*80',
    '    if dist < best_dist:',
    '     best_i=i',
    '     best_dist=dist',
    '  if best_i is not None and best_dist < page_rect.height*0.22:',
    '   item=candidates[best_i]',
    '   item["rect"]=item["rect"] | cap_rect',
    '   item["fig"]=fig_no or item.get("fig")',
    '   item["score"] += 35',
    '  else:',
    '   top=max(page_rect.y0, cap_rect.y0-page_rect.height*0.34)',
    '   r=fitz.Rect(page_rect.x0+page_rect.width*0.08, top, page_rect.x1-page_rect.width*0.08, min(page_rect.y1, cap_rect.y1+page_rect.height*0.015))',
    '   visual_cov=rect_coverage(image_rects, r)+rect_coverage(drawing_rects, r)',
    '   text_cov, text_chars=text_metrics(text_blocks, r)',
    '   if rect_area(r)/page_area >= 0.045 and visual_cov >= 0.12 and not (text_cov > 0.32 and text_chars > 180):',
    '    candidates.append({"rect": r, "score": 42, "kind": "caption-region", "fig": fig_no})',
    ' unique=[]',
    ' seen=set()',
    ' for item in sorted(candidates, key=lambda it: it["score"], reverse=True):',
    '  r=expand_rect(item["rect"], page_rect, max(3.0, page_rect.width*0.018))',
    '  area=rect_area(r)/page_area',
    '  if area > 0.72 or area < 0.012:',
    '   continue',
    '  image_cov=rect_coverage(image_rects, r)',
    '  drawing_cov=rect_coverage(drawing_rects, r)',
    '  visual_cov=image_cov + drawing_cov',
    '  text_cov, text_chars=text_metrics(text_blocks, r)',
    '  if item.get("kind") == "caption-region" and visual_cov < 0.14:',
    '   continue',
    '  if text_cov > 0.42 and visual_cov < 0.20:',
    '   continue',
    '  if text_chars > 260 and visual_cov < 0.28:',
    '   continue',
    '  if r.height > page_rect.height*0.40 and text_cov > 0.22 and visual_cov < 0.22:',
    '   continue',
    '  key=rect_key(r)',
    '  if key in seen:',
    '   continue',
    '  seen.add(key)',
    '  item={**item, "rect": r, "page": page_index, "score": item["score"] + visual_cov*32 - min(text_cov, 0.7)*18}',
    '  unique.append(item)',
    ' return sorted(unique, key=lambda it: it["score"], reverse=True)[:3]',
    'def render_clip(page, rect, target):',
    ' scale=max(1.6, min(4.0, 1300 / max(float(rect.width), 1.0)))',
    ' pix=page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rect, alpha=False)',
    ' if pix.width < 160 or pix.height < 100:',
    '  return False',
    ' pix.save(str(target))',
    ' return target.exists() and target.stat().st_size > 0',
    'def render_page(page, target):',
    ' scale=max(1.0, 1400 / max(float(page.rect.width), 1.0))',
    ' pix=page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)',
    ' pix.save(str(target))',
    ' return target.exists() and target.stat().st_size > 0',
    'try:',
    ' import fitz',
    ' doc=fitz.open(str(pdf))',
    ' try:',
    '  all_candidates=[]',
    '  max_pages=min(doc.page_count, max(limit*3, min(10, doc.page_count)))',
    '  for idx in range(max_pages):',
    '   page=doc.load_page(idx)',
    '   all_candidates.extend(visual_candidates(page, idx+1))',
    '  all_candidates=sorted(all_candidates, key=lambda it: (it["page"], -it["score"]))',
    '  used_pages={}',
    '  for item in all_candidates:',
    '   if len(paths) >= limit:',
    '    break',
    '   used_pages[item["page"]]=used_pages.get(item["page"], 0)+1',
    '   if used_pages[item["page"]] > 2:',
    '    continue',
    '   page=doc.load_page(item["page"]-1)',
    '   fig=item.get("fig")',
    '   prefix=f"figure-{fig:02d}" if fig else f"visual-{len(paths)+1:02d}"',
    '   target=out / f"{prefix}-page-{item[\'page\']:03d}.png"',
    '   if not target.exists() or target.stat().st_size <= 0:',
    '    render_clip(page, item["rect"], target)',
    '   if target.exists() and target.stat().st_size > 0:',
    '    paths.append(str(target))',
    '  if not paths:',
    '   for idx in range(min(limit, doc.page_count)):',
    '    page=doc.load_page(idx)',
    '    if not page_visual_fallback_ok(page):',
    '     continue',
    '    target=out / f"page-{idx+1:03d}.png"',
    '    if not target.exists() or target.stat().st_size <= 0:',
    '     render_page(page, target)',
    '    if target.exists() and target.stat().st_size > 0:',
    '     paths.append(str(target))',
    ' finally:',
    '  doc.close()',
    'except Exception as exc:',
    ' print(json.dumps({"error": str(exc)}, ensure_ascii=False))',
    ' sys.exit(0)',
    'print(json.dumps({"paths": paths}, ensure_ascii=False))',
  ].join('\n');
  const invocation = resolvePythonInvocation(['-c', script, file, cacheDir, String(limit)]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });
  if (result.error) return [];
  try {
    const payload = JSON.parse(String(result.stdout || '{}'));
    return Array.isArray(payload.paths) ? payload.paths.filter((item) => fs.existsSync(item)) : [];
  } catch {
    return [];
  }
}

function pptSourceCacheDir(root, file, kind) {
  const stat = fs.statSync(file);
  const digest = crypto
    .createHash('sha256')
    .update(`${path.resolve(file)}:${stat.mtimeMs}:${stat.size}:${kind}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(dataDir(root), 'preview_cache', 'ppt_source_visuals', digest);
}

export function extractFileContextText(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return fs.readFileSync(file, 'utf8').slice(0, MAX_ATTACHMENT_CONTEXT_CHARS);
  if (ext === '.docx') return extractDocxText(file);
  if (SPREADSHEET_EXTENSIONS.has(ext)) return extractSpreadsheetText(file);
  if (ext === '.pptx') return extractPptxText(file);
  if (ext === '.pdf') return extractPdfText(file);
  if (IMAGE_EXTENSIONS.has(ext)) return `[图片附件: ${path.basename(file)}。可用于图像编辑或 PPT 视觉参考。]`;
  return `[${path.basename(file)} 暂无自动正文抽取器。]`;
}

export function extractFileContextExcerpt(file, maxChars = DEFAULT_ATTACHMENT_CATALOG_EXCERPT_CHARS) {
  const cleanMax = Math.max(400, Math.min(20_000, Number(maxChars) || DEFAULT_ATTACHMENT_CATALOG_EXCERPT_CHARS));
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(fs.statSync(file).size, cleanMax * 4));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8').slice(0, cleanMax);
    } finally {
      fs.closeSync(fd);
    }
  }
  if (ext === '.xlsx') return extractSpreadsheetText(file).slice(0, cleanMax);
  if (ext === '.pptx') {
    return extractPptxSlides(file)
      .slice(0, 8)
      .map((slide) => `Slide ${slide.index}\n${slide.text.join('\n')}`)
      .join('\n\n')
      .slice(0, cleanMax);
  }
  if (ext === '.pdf') return extractPdfTextExcerpt(file, cleanMax);
  return extractFileContextText(file).slice(0, cleanMax);
}

export function renderFilePreview(root, file, options = {}) {
  const ext = path.extname(file).toLowerCase();
  const base = filePreviewInfo(root, file, {}, options);
  if (TEXT_EXTENSIONS.has(ext)) {
    return {
      ...base,
      kind: ['.md', '.markdown'].includes(ext) ? 'markdown' : 'text',
      text: fs.readFileSync(file, 'utf8').slice(0, 160_000),
      truncated: base.size > 160_000,
    };
  }
  if (WORD_EXTENSIONS.has(ext)) {
    const format = inspectOfficeFile(file, ext);
    if (!format.valid) return officePreviewFallback(base, ext, format);
    const officePreview = renderOfficePdfPreview(root, file, 'word', options);
    if (officePreview.ok) return { ...base, kind: ext.slice(1), office_pdf_url: officePreview.file_url, fileUrl: officePreview.file_url, file_url: officePreview.file_url, preview_render_mode: 'office', preview_converter: officePreview.converter || '', page_count: officePreview.page_count || 1, page_image_urls: officePreview.page_image_urls || [], page_image_render_mode: officePreview.page_image_render_mode || 'thumbnails', action_file: base };
    if (ext === '.docx') {
      const blocks = extractDocxBlocks(file, { root, allowedRoots: options.allowedRoots });
      return { ...base, kind: 'docx', text: extractDocxText(file), blocks, preview_render_mode: 'native', preview_converter_error: officePreview.code || '' };
    }
    return officePreviewFallback(base, ext, officePreview);
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    const format = inspectOfficeFile(file, ext);
    if (!format.valid) return officePreviewFallback(base, ext, format);
    if (ext === '.xlsx') {
      const sheets = extractSpreadsheetSheets(file);
      if (sheets.length) return { ...base, kind: 'xlsx', text: extractSpreadsheetText(file), sheets, preview_render_mode: 'native' };
    }
    const officePreview = renderOfficePdfPreview(root, file, 'spreadsheet', options);
    if (officePreview.ok) return { ...base, kind: ext.slice(1), office_pdf_url: officePreview.file_url, fileUrl: officePreview.file_url, file_url: officePreview.file_url, preview_render_mode: 'office', preview_converter: officePreview.converter || '', page_count: officePreview.page_count || 1, page_image_urls: officePreview.page_image_urls || [], page_image_render_mode: officePreview.page_image_render_mode || 'thumbnails', action_file: base };
    return officePreviewFallback(base, ext, officePreview, extractSpreadsheetText(file));
  }
  if (ext === '.pptx') {
    const format = inspectOfficeFile(file, ext);
    if (!format.valid) return officePreviewFallback(base, ext, format);
    return { ...base, kind: 'pptx', slides: extractPptxSlides(file), aspectRatio: 16 / 9 };
  }
  if (ext === '.ppt') {
    const format = inspectOfficeFile(file, ext);
    if (!format.valid) return officePreviewFallback(base, ext, format);
    const officePreview = renderOfficePdfPreview(root, file, 'presentation', options);
    if (officePreview.ok) return {
      ...base,
      kind: 'ppt',
      office_pdf_url: officePreview.file_url,
      fileUrl: officePreview.file_url,
      file_url: officePreview.file_url,
      preview_render_mode: 'office',
      preview_converter: officePreview.converter || '',
      page_count: officePreview.page_count || 1,
      page_image_urls: officePreview.page_image_urls || [],
      page_image_render_mode: officePreview.page_image_render_mode || 'thumbnails',
      action_file: base,
    };
    return officePreviewFallback(base, ext, officePreview);
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { ...base, kind: 'image', fileUrl: base.file_url };
  }
  if (ext === '.pdf') {
    const pages = renderNativePdfPreviewPages(root, file, options);
    return {
      ...base,
      kind: 'pdf',
      text: extractPdfText(file),
      fileUrl: base.file_url,
      page_count: pages.page_count || 1,
      page_image_urls: pages.page_image_urls || [],
      page_image_render_mode: pages.page_image_render_mode || 'thumbnails',
    };
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return {
      ...base,
      kind: 'archive',
      preview_render_mode: 'metadata',
      safety_note: '压缩包不会自动解压或执行。请下载后使用可信工具检查内容。',
    };
  }
  if (INSTALLER_EXTENSIONS.has(ext)) {
    return {
      ...base,
      kind: 'installer',
      preview_render_mode: 'metadata',
      safety_note: '安装包和可执行文件不会自动运行。打开前请确认发送者可信并核对 SHA-256。',
    };
  }
  return { ...base, kind: 'binary', fileUrl: base.file_url };
}

function renderNativePdfPreviewPages(root, file, options = {}) {
  const stat = fs.statSync(file);
  const digest = crypto.createHash('sha256')
    .update(`${path.resolve(file)}:${stat.mtimeMs}:${stat.size}:pdf-pages-v2`)
    .digest('hex')
    .slice(0, 24);
  const cacheDir = path.join(dataDir(root), 'preview_cache', 'pdf_pages', digest);
  ensureDirSync(cacheDir);
  return renderPdfPageThumbnails(root, file, cacheDir, options);
}

function officePreviewFallback(base = {}, extension = '', failure = {}, fallbackText = '') {
  const ext = String(extension || '').toLowerCase();
  const label = officeFileLabel(ext);
  const code = String(failure?.code || 'office_conversion_failed');
  const message = String(failure?.message || '').trim() || (code === 'office_converter_unavailable'
    ? `未找到可用的 ${label} 转换器。Windows 可使用 Microsoft Office 或 WPS，其他系统可安装 LibreOffice；也可以点击右上角直接打开原文件。`
    : `已找到 Office 兼容组件，但 ${label} 转换为预览 PDF 失败。文件可能损坏、受密码保护，或 Office/WPS 自动化组件未正确注册。`);
  return {
    ...base,
    kind: ext.replace(/^\./, '') || 'office',
    text: [message, fallbackText && !String(fallbackText).startsWith('[') ? fallbackText : ''].filter(Boolean).join('\n\n'),
    preview_render_mode: 'fallback',
    preview_error_code: code,
    preview_error: message,
    preview_converter: failure?.converter || '',
  };
}

export function resolveAttachmentPath(root, attachment, userId = DESKTOP_USER_ID) {
  if (attachment?.path) return safePathInside(root, attachment.path);
  if (attachment?.relative_path || attachment?.relativePath) {
    return safePathInside(root, path.join(root, attachment.relative_path || attachment.relativePath));
  }
  return uploadedFileTarget(root, attachment, userId);
}

export function resolveFileTarget(root, file = {}, userId = DESKTOP_USER_ID, options = {}) {
  if (typeof file === 'string') return safePathInside(root, file, options.allowedRoots);
  if (file?.path) return safePathInside(root, file.path, options.allowedRoots);
  if (file?.relative_path || file?.relativePath) {
    const relativePath = file.relative_path || file.relativePath;
    for (const candidateRoot of [root, ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : [])]) {
      try {
        const candidate = safePathInside(root, path.join(candidateRoot, relativePath), options.allowedRoots);
        if (fs.existsSync(candidate)) return candidate;
      } catch {}
    }
    return safePathInside(root, path.join(root, relativePath), options.allowedRoots);
  }
  return uploadedFileTarget(root, file, userId);
}

export function describeFile(root, file = {}, userId = DESKTOP_USER_ID, options = {}) {
  const target = resolveFileTarget(root, file, userId, options);
  return filePreviewInfo(root, target, file, options);
}

export function filePreviewInfo(root, file, extra = {}, options = {}) {
  const target = safePathInside(root, file, options.allowedRoots);
  const stat = fs.statSync(target);
  const name = extra.name || extra.filename || path.basename(target);
  const contentType = extra.content_type || extra.type || guessContentType(name);
  const url = pathToFileURL(target).href;
  const relativeRoot = matchingAllowedRoot(root, target, options.allowedRoots) || path.resolve(root);
  const relativePath = path.relative(relativeRoot, target).replace(/\\/g, '/');
  return {
    id: extra.id || '',
    name,
    filename: extra.filename || name,
    kind: extra.kind || fileKind(name, contentType),
    content_type: contentType,
    type: contentType,
    size: Number(extra.size || stat.size || 0),
    user_id: extra.user_id || extra.userId || '',
    owner_id: extra.owner_id || extra.ownerId || extra.user_id || extra.userId || '',
    path: target,
    relative_path: relativePath,
    preview_url: extra.preview_url || url,
    download_url: extra.download_url || url,
    render_url: extra.render_url || `janus-render://file/${encodeURIComponent(relativePath)}`,
    office_pdf_url: extra.office_pdf_url || '',
    file_url: extra.file_url || url,
    fileUrl: extra.fileUrl || extra.file_url || url,
  };
}

function decodeUploadData(value) {
  let payload = String(value || '').trim();
  if (payload.startsWith('data:') && payload.includes(',')) payload = payload.split(',', 2)[1];
  return Buffer.from(payload, 'base64');
}

function safeUploadFilename(filename) {
  const base = path.basename(String(filename || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return base.slice(0, 180) || 'file';
}

function safePathSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function parseMessageMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function fileDescriptorCandidates(value = {}) {
  return [
    value.path,
    value.workspace_relative_path,
    value.workspaceRelativePath,
    value.relative_path,
    value.relativePath,
    value.file_url,
    value.fileUrl,
    value.download_url,
    value.downloadUrl,
  ].filter(Boolean);
}

function messageContentFileCandidates(value = '') {
  const text = String(value || '');
  const candidates = [];
  const add = (candidate) => {
    const clean = cleanMemoryFileCandidate(candidate);
    if (clean && !candidates.includes(clean)) candidates.push(clean);
  };
  for (const pattern of [
    /(?:工作区相对路径|Memory 相对路径|交付文件|最终文件|产物文件|输出文件|文件路径|文件下载|deliverable\s*files?|output\s*files?)\s*[:：]\s*([^\n\r]+)/gi,
    /file:\/\/\/[^\s<>)\]}]+/g,
    /\[[^\]\n]*\]\(([^)\n]+)\)/g,
    /`([^`\n]+\.(?:txt|md|markdown|json|jsonl|csv|tsv|pdf|docx?|pptx|xlsx?|png|jpe?g|webp|gif|js|mjs|ts|tsx|jsx|py|html|css|xml|toml|ya?ml|tex|bib))`/gi,
  ]) {
    let match;
    while ((match = pattern.exec(text))) add(match[1] || match[0]);
  }
  return candidates;
}

function resolveDeclaredOutputFile(candidate = '', allowedRoot = '') {
  let value = cleanMemoryFileCandidate(candidate);
  if (!value || /^(?:https?|mailto|data|janus-render):/i.test(value)) return '';
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); } catch { return ''; }
  }
  const requested = path.isAbsolute(value) ? path.resolve(value) : path.resolve(allowedRoot, value);
  let resolved = '';
  try {
    resolved = fs.realpathSync(requested);
    if (!pathInsideRoot(resolved, allowedRoot) || !fs.statSync(resolved).isFile()) return '';
  } catch {
    return '';
  }
  return resolved;
}

function cleanMemoryFileCandidate(value = '') {
  let candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('<') && candidate.endsWith('>')) candidate = candidate.slice(1, -1).trim();
  candidate = candidate.replace(/^['"]|['"]$/g, '').trim();
  const titledLink = candidate.match(/^(\S+)\s+["'][^"']*["']$/);
  if (titledLink) candidate = titledLink[1];
  candidate = candidate.replace(/:(\d+)(?::\d+)?$/, '');
  try { candidate = decodeURIComponent(candidate); } catch {}
  return candidate;
}

function resolveMemoryContextFile(candidate, allowedRoots = []) {
  let value = cleanMemoryFileCandidate(candidate);
  if (!value || /^(?:https?|janus-render):/i.test(value)) return '';
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); } catch { return ''; }
  }
  const possibilities = path.isAbsolute(value)
    ? [path.resolve(value)]
    : allowedRoots.map((root) => path.resolve(root, value));
  for (const resolved of possibilities) {
    try {
      const real = fs.realpathSync(resolved);
      if (!pathInsideAllowedRoots(real, allowedRoots)) continue;
      if (fs.statSync(real).isFile()) return real;
    } catch {}
  }
  return '';
}

function collectProjectReferenceStates(messages = [], { workspaceRoot = '' } = {}) {
  const root = String(workspaceRoot || '').trim();
  if (!root) return [];
  const results = [];
  const seen = new Set();
  for (const message of messages || []) {
    const metadata = message?.metadata && typeof message.metadata === 'object'
      ? message.metadata
      : parseMessageMetadata(message?.metadata_json);
    for (const reference of Array.isArray(metadata.fileReferences) ? metadata.fileReferences : []) {
      if (String(reference?.referenceKind || reference?.reference_kind || 'file') !== 'file') continue;
      const relativePath = String(reference?.relativePath || reference?.relative_path || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
      if (!relativePath || relativePath.startsWith('/') || /^[A-Za-z]:\//.test(relativePath)
        || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) continue;
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const resolved = resolveMemoryContextFile(path.join(root, relativePath), [root]);
      if (!resolved) {
        results.push({ relativePath, path: '', status: 'missing' });
        continue;
      }
      const expectedHash = String(reference?.contentHash || reference?.content_hash || '').trim().toLowerCase();
      const currentHash = expectedHash ? crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') : '';
      results.push({ relativePath, path: resolved, status: expectedHash && currentHash !== expectedHash ? 'changed' : 'available' });
    }
  }
  return results;
}

function pathInsideAllowedRoots(candidate, allowedRoots = []) {
  const resolved = path.resolve(candidate);
  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function memoryContextFileExcluded(file) {
  const name = path.basename(file);
  if (/^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials?(?:\..*)?)$/i.test(name)) return true;
  if (/(^|[._-])(?:auth|secret|token|password|passwd|credential)(?:[._-]|$)/i.test(name)) return true;
  return /\.(?:db|sqlite|sqlite3|wal|shm|env)$/i.test(name);
}

function memoryFileDisplayPath(file, allowedRoots = []) {
  for (const root of allowedRoots) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (relative && relative !== '..' && !relative.startsWith('../')) return relative;
  }
  return path.basename(file);
}

function safePathInside(root, candidate, allowedRoots = []) {
  const roots = resolvedAllowedRoots(root, allowedRoots);
  const requested = path.resolve(candidate);
  let resolved = requested;
  try { resolved = fs.realpathSync(requested); } catch {}
  if (!roots.some((allowedRoot) => pathInsideRoot(resolved, allowedRoot))) {
    throw new Error('文件路径不在工作区内。');
  }
  return resolved;
}

function matchingAllowedRoot(root, candidate, allowedRoots = []) {
  const resolved = path.resolve(candidate);
  return resolvedAllowedRoots(root, allowedRoots).find((allowedRoot) => pathInsideRoot(resolved, allowedRoot)) || '';
}

function resolvedAllowedRoots(root, allowedRoots = []) {
  return [...new Set([root, ...(Array.isArray(allowedRoots) ? allowedRoots : [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => {
      const resolved = path.resolve(item);
      try { return fs.realpathSync(resolved); } catch { return resolved; }
    }))];
}

function pathInsideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}


function renderOfficePdfPreview(root, file, kind = 'office', options = {}) {
  const target = safePathInside(root, file, options.allowedRoots);
  const stat = fs.statSync(target);
  const digest = crypto.createHash('sha256')
    .update(`${path.resolve(target)}:${stat.mtimeMs}:${stat.size}:office-pdf-v4`)
    .digest('hex')
    .slice(0, 24);
  const cacheDir = path.join(dataDir(root), 'preview_cache', 'office_pdf', digest);
  ensureDirSync(cacheDir);
  const pdfPath = path.join(cacheDir, `${path.basename(target, path.extname(target))}.pdf`);
  let converter = 'office-pdf-cache';
  if (!fs.existsSync(pdfPath)) {
    const converters = findOfficeConverters();
    if (!converters.length) return {
      ok: false,
      code: 'office_converter_unavailable',
      message: `未找到可用的 ${officeFileLabel(path.extname(target))} 转换器。Windows 可使用 Microsoft Office 或 WPS，其他系统可安装 LibreOffice。`,
    };
    const conversion = convertOfficeDocumentToPdf(converters, target, pdfPath, cacheDir);
    if (!conversion.ok) return conversion;
    converter = conversion.converter || 'Office';
  }
  const previewInfo = filePreviewInfo(root, pdfPath, {
    kind: 'pdf',
    name: `${path.basename(target)}.pdf`,
    filename: `${path.basename(target)}.pdf`,
    content_type: 'application/pdf',
    type: 'application/pdf',
  }, { allowedRoots: [dataDir(root), ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : [])] });
  const pages = renderPdfPageThumbnails(root, pdfPath, cacheDir, options);
  return {
    ok: true,
    ...previewInfo,
    converter,
    page_count: pages.page_count || 1,
    page_image_urls: pages.page_image_urls || [],
    page_image_render_mode: pages.page_image_render_mode || 'thumbnails',
  };
}

function renderPdfPageThumbnails(root, pdfPath, cacheDir, options = {}) {
  const thumbDir = path.join(cacheDir, 'pages');
  ensureDirSync(thumbDir);
  const script = `
import json
import sys
from pathlib import Path

pdf_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
payload = {"page_count": 1, "files": []}
try:
    import fitz
    doc = fitz.open(str(pdf_path))
    payload["page_count"] = max(1, int(doc.page_count or 1))
    payload["page_image_render_mode"] = "pages" if payload["page_count"] <= 40 else "thumbnails"
    if payload["page_image_render_mode"] == "pages":
        scale = 2.0 if payload["page_count"] <= 10 else 1.75 if payload["page_count"] <= 24 else 1.55
    else:
        scale = 0.22
    for index, page in enumerate(doc, start=1):
        target = out_dir / f"page-{index:03d}.png"
        if not target.exists():
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pix.save(str(target))
        payload["files"].append(str(target))
    doc.close()
except Exception as exc:
    payload["error"] = str(exc)
print(json.dumps(payload, ensure_ascii=False))
`;
  try {
    const invocation = resolvePythonInvocation(['-c', script, pdfPath, thumbDir], { required: true, root });
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: 35_000,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) return { page_count: 1, page_image_urls: [] };
    const payload = JSON.parse(String(result.stdout || '{}'));
    const files = Array.isArray(payload.files) ? payload.files : [];
    return {
      page_count: Math.max(1, Number(payload.page_count || files.length || 1)),
      page_image_render_mode: payload.page_image_render_mode === 'pages' ? 'pages' : 'thumbnails',
      page_image_urls: files.map((file) => filePreviewInfo(root, file, {
        kind: 'image',
        content_type: 'image/png',
        type: 'image/png',
      }, { allowedRoots: [dataDir(root), ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : [])] }).file_url),
    };
  } catch {
    return { page_count: 1, page_image_urls: [] };
  }
}

function findOfficeConverters() {
  const configured = String(process.env.JANUS_OFFICE_CONVERTER || '').trim();
  const converters = [];
  const seen = new Set();
  const add = (kind, command) => {
    const resolved = String(command || '').trim();
    const key = `${kind}:${resolved.toLowerCase()}`;
    if (!resolved || seen.has(key)) return;
    seen.add(key);
    converters.push({ kind, command: resolved });
  };
  const libreOfficeCandidates = [
    configured,
    ...(process.platform === 'win32' ? [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'LibreOffice', 'program', 'soffice.exe'),
    ] : process.platform === 'darwin' ? [
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice',
    ] : [
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/snap/bin/libreoffice',
    ]),
  ].filter(Boolean);
  for (const candidate of libreOfficeCandidates) {
    if (path.isAbsolute(candidate) && isExecutableFile(candidate)) add('libreoffice', candidate);
  }
  if (configured && !path.isAbsolute(configured)) {
    const resolvedConfigured = executableOnPath(configured);
    if (resolvedConfigured) add('libreoffice', resolvedConfigured);
  }
  for (const command of ['soffice', 'libreoffice']) {
    const resolved = executableOnPath(command);
    if (resolved) add('libreoffice', resolved);
  }
  if (process.platform === 'win32') {
    const powershell = ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']
      .map(executableOnPath)
      .find(Boolean);
    if (powershell) add('windows-office-com', powershell);
  }
  return converters;
}

function convertOfficeDocumentToPdf(converters, source, target, cacheDir) {
  const failures = [];
  for (const converter of converters) {
    try { fs.rmSync(target, { force: true }); } catch {}
    const result = converter?.kind === 'windows-office-com'
      ? convertOfficeWithWindowsCom(converter.command, source, target, cacheDir)
      : converter?.kind === 'libreoffice'
        ? convertOfficeWithLibreOffice(converter.command, source, target, cacheDir)
        : { ok: false, code: 'office_converter_unsupported', message: '不支持的 Office 转换器。' };
    if (result.ok) return result;
    failures.push(result);
  }
  const timedOut = failures.find((item) => item.code === 'office_conversion_timeout');
  return timedOut || failures.at(-1) || {
    ok: false,
    code: 'office_conversion_failed',
    message: 'Office 文件转换失败。',
  };
}

function convertOfficeWithLibreOffice(command, source, target, cacheDir) {
  const outDir = fs.mkdtempSync(path.join(cacheDir, 'convert-'));
  const profileDir = fs.mkdtempSync(path.join(cacheDir, 'libreoffice-profile-'));
  try {
    const result = spawnSync(command, [
      '--headless',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      source,
    ], {
      encoding: 'utf8',
      timeout: 45_000,
      windowsHide: true,
    });
    const produced = path.join(outDir, `${path.basename(source, path.extname(source))}.pdf`);
    if (result.error?.code === 'ETIMEDOUT') return {
      ok: false, code: 'office_conversion_timeout', converter: 'LibreOffice',
      message: 'LibreOffice 转换预览超时。请关闭可能卡住的 Office 进程后重试。',
    };
    if (result.error || result.status !== 0 || !fs.existsSync(produced)) return {
      ok: false, code: 'office_conversion_failed', converter: 'LibreOffice',
      message: 'LibreOffice 已检测到，但无法将该文件转换为 PDF。文件可能损坏、受密码保护或格式不匹配。',
    };
    fs.copyFileSync(produced, target);
    return fs.existsSync(target) && fs.statSync(target).size > 0
      ? { ok: true, converter: 'LibreOffice' }
      : { ok: false, code: 'office_conversion_output_missing', converter: 'LibreOffice', message: 'LibreOffice 没有生成可用的预览 PDF。' };
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
  }
}

function convertOfficeWithWindowsCom(command, source, target, cacheDir) {
  const script = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = 'Stop'
$extension = [System.IO.Path]::GetExtension($Source).ToLowerInvariant()
$family = ''
$progIds = @()
if ($extension -eq '.doc' -or $extension -eq '.docx') {
  $family = 'word'
  $progIds = @('Word.Application', 'KWPS.Application', 'KWPS.Application.12')
} elseif ($extension -eq '.xls' -or $extension -eq '.xlsx') {
  $family = 'spreadsheet'
  $progIds = @('Excel.Application', 'KET.Application', 'KET.Application.12')
} elseif ($extension -eq '.ppt' -or $extension -eq '.pptx') {
  $family = 'presentation'
  $progIds = @('PowerPoint.Application', 'KWPP.Application', 'KWPP.Application.12')
} else {
  throw "Unsupported Office extension: $extension"
}
$errors = New-Object System.Collections.Generic.List[string]
foreach ($progId in $progIds) {
  $application = $null
  $document = $null
  try {
    $application = New-Object -ComObject $progId
    try { $application.Visible = $false } catch {}
    try { $application.DisplayAlerts = 0 } catch {}
    try { $application.AutomationSecurity = 3 } catch {}
    if ($family -eq 'word') {
      $document = $application.Documents.Open($Source, $false, $true, $false)
      if ($document.PSObject.Methods.Name -contains 'ExportAsFixedFormat') {
        $document.ExportAsFixedFormat($Target, 17)
      } else {
        $document.SaveAs($Target, 17)
      }
    } elseif ($family -eq 'spreadsheet') {
      $document = $application.Workbooks.Open($Source, 0, $true)
      $document.ExportAsFixedFormat(0, $Target)
    } else {
      $document = $application.Presentations.Open($Source, $true, $false, $false)
      try { $document.SaveAs($Target, 32) } catch { $document.ExportAsFixedFormat($Target, 2) }
    }
    if (Test-Path -LiteralPath $Target) {
      Write-Output ('JANUS_CONVERTER=' + $progId)
      exit 0
    }
    throw ($progId + ' did not create the PDF target.')
  } catch {
    $errors.Add($progId + ': ' + $_.Exception.Message)
    Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
  } finally {
    if ($null -ne $document) {
      try { $document.Close($false) } catch { try { $document.Close() } catch {} }
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) } catch {}
    }
    if ($null -ne $application) {
      try { $application.Quit() } catch {}
      try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application) } catch {}
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
  }
}
throw ($errors -join '; ')
`;
  const scriptDir = fs.mkdtempSync(path.join(cacheDir, 'office-com-'));
  const scriptPath = path.join(scriptDir, 'export-office-preview.ps1');
  try {
    fs.writeFileSync(scriptPath, `\ufeff${script}`, 'utf8');
    const result = spawnSync(command, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta',
      '-File', scriptPath, '-Source', source, '-Target', target,
    ], {
      encoding: 'utf8',
      timeout: 75_000,
      windowsHide: true,
    });
    if (result.error?.code === 'ETIMEDOUT') return {
      ok: false, code: 'office_conversion_timeout', converter: 'Microsoft Office/WPS',
      message: 'Microsoft Office/WPS 自动导出预览超时。请关闭可能卡住的 Office 窗口或后台进程后重试。',
    };
    const converterId = /JANUS_CONVERTER=([^\r\n]+)/.exec(String(result.stdout || ''))?.[1]?.trim() || '';
    if (!result.error && result.status === 0 && fs.existsSync(target) && fs.statSync(target).size > 0) {
      return { ok: true, converter: /^(?:KWP|KET)/i.test(converterId) ? 'WPS Office' : 'Microsoft Office' };
    }
    return {
      ok: false,
      code: 'office_conversion_failed',
      converter: 'Microsoft Office/WPS',
      message: '已检测到 PowerShell，但 Microsoft Office/WPS 自动化导出失败。请确认桌面版 Office/WPS 已安装、COM 组件已注册，且文件未损坏或加密。',
    };
  } finally {
    try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch {}
  }
}

function executableOnPath(command) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  if (result.error || result.status !== 0) return '';
  return String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).find(isExecutableFile) || '';
}

function isExecutableFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function extractSpreadsheetText(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.xlsx') return `[Excel file: ${path.basename(file)}. Legacy .xls preview needs a local Office-compatible exporter.]`;
  try {
    const sections = extractSpreadsheetSheets(file).map((sheet) => {
      const rows = (sheet.rows || []).map((row) => (row || []).join('\t').replace(/\t+$/g, '')).filter(Boolean);
      return rows.length ? `${sheet.name}\n${rows.join('\n')}` : '';
    }).filter(Boolean);
    return sections.join('\n\n').slice(0, MAX_ATTACHMENT_CONTEXT_CHARS) || `[Excel file: ${path.basename(file)}. No previewable worksheet cells were found.]`;
  } catch {
    return `[Excel file: ${path.basename(file)}. The worksheet content could not be parsed.]`;
  }
}

export function extractSpreadsheetSheets(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.xlsx') return [];
  const entries = readZipEntries(file);
  const sharedStrings = readXlsxSharedStrings(entries);
  const sheetTargets = xlsxSheetTargets(entries);
  const fallbackSheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name.replace(/\\/g, '/')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((entry, index) => ({ name: `Sheet ${index + 1}`, entry }));
  const sheets = (sheetTargets.length ? sheetTargets : fallbackSheets).slice(0, MAX_SPREADSHEET_PREVIEW_SHEETS);
  return sheets.map((sheet, index) => {
    const read = entries.get(sheet.entry);
    if (!read) return null;
    const rows = parseXlsxWorksheet(read().toString('utf8'), sharedStrings);
    const previewRows = rows.slice(0, MAX_SPREADSHEET_PREVIEW_ROWS);
    return {
      name: sheet.name || `Sheet ${index + 1}`,
      rows: previewRows,
      row_count: rows.length,
      column_count: spreadsheetColumnCount(previewRows),
      column_widths: spreadsheetColumnWidths(previewRows),
      truncated: rows.length > MAX_SPREADSHEET_PREVIEW_ROWS,
    };
  }).filter((sheet) => sheet && sheet.rows.length);
}


function spreadsheetColumnCount(rows = []) {
  return Math.max(0, ...rows.map((row) => Array.isArray(row) ? row.length : 0));
}

function spreadsheetColumnWidths(rows = []) {
  const count = spreadsheetColumnCount(rows);
  return Array.from({ length: count }, (_, columnIndex) => {
    const maxLength = Math.max(4, ...rows.map((row) => String(row?.[columnIndex] || '').length));
    return Math.max(76, Math.min(260, maxLength * 9 + 28));
  });
}

function xlsxSheetTargets(entries) {
  const workbook = entries.get('xl/workbook.xml');
  const rels = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) return [];
  const relTargets = new Map();
  const relXml = rels().toString('utf8');
  for (const match of relXml.matchAll(/<Relationship\b([^>]*?)\/?>(?:<\/Relationship>)?/g)) {
    const attrs = xmlAttrs(match[1] || '');
    if (!attrs.Id || !attrs.Target) continue;
    relTargets.set(attrs.Id, normalizeXlsxRelationshipTarget(attrs.Target));
  }
  const workbookXml = workbook().toString('utf8');
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*?)\/?>(?:<\/sheet>)?/g)) {
    const attrs = xmlAttrs(match[1] || '');
    const entry = relTargets.get(attrs.id || attrs.Id || '');
    if (entry) sheets.push({ name: attrs.name || `Sheet ${sheets.length + 1}`, entry });
  }
  return sheets;
}

function normalizeXlsxRelationshipTarget(target = '') {
  const clean = String(target || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  if (clean.startsWith('xl/')) return clean;
  return path.posix.normalize(`xl/${clean}`);
}

function parseXlsxWorksheet(xml = '', sharedStrings = []) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = xmlAttrs(cellMatch[1] || '');
      const colIndex = xlsxColumnIndex(attrs.r || '') ?? row.length;
      if (colIndex >= MAX_SPREADSHEET_PREVIEW_COLS) continue;
      while (row.length < colIndex) row.push('');
      row[colIndex] = xlsxCellValue(cellMatch[2] || '', attrs.t || '', sharedStrings);
    }
    const trimmed = row.slice(0, MAX_SPREADSHEET_PREVIEW_COLS);
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
    if (trimmed.some(Boolean)) rows.push(trimmed);
  }
  return rows;
}

function xlsxCellValue(body = '', type = '', sharedStrings = []) {
  if (type === 'inlineStr') {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXmlEntities(part[1] || '')).join('');
  }
  const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? '';
  const clean = decodeXmlEntities(value);
  if (type === 's') return sharedStrings[Number(clean)] || '';
  if (type === 'b') return clean === '1' ? 'TRUE' : clean === '0' ? 'FALSE' : clean;
  return clean;
}

function xlsxColumnIndex(ref = '') {
  const letters = String(ref || '').match(/^[A-Za-z]+/)?.[0] || '';
  if (!letters) return null;
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function readXlsxSharedStrings(entries) {
  const read = entries.get('xl/sharedStrings.xml');
  if (!read) return [];
  const xml = read().toString('utf8');
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => (
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXmlEntities(part[1] || '')).join('')
  ));
}

function decodeXmlEntities(value = '') {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractDocxText(file) {
  const entries = readZipEntries(file);
  const document = entries.get('word/document.xml');
  if (!document) return '';
  return xmlText(document().toString('utf8')).slice(0, MAX_ATTACHMENT_CONTEXT_CHARS);
}

export function extractDocxBlocks(file, options = {}) {
  const entries = readZipEntries(file);
  const document = entries.get('word/document.xml');
  if (!document) return [];
  const xml = document().toString('utf8');
  const body = xml.match(/<w:body[\s\S]*?<\/w:body>/)?.[0] || xml;
  const imageUrls = docxRelationshipImageUrls(file, entries, options);
  const blocks = [];
  const blockPattern = /<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g;
  let match;
  while ((match = blockPattern.exec(body))) {
    const raw = match[0];
    if (match[1] === 'tbl') {
      const rows = [];
      const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let rowMatch;
      while ((rowMatch = rowPattern.exec(raw))) {
        const cells = [];
        const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let cellMatch;
        while ((cellMatch = cellPattern.exec(rowMatch[0]))) {
          cells.push(xmlText(cellMatch[0]));
        }
        if (cells.some(Boolean)) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    const text = xmlText(raw);
    const style = raw.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] || '';
    const heading = style.match(/Heading([1-6])|\u6807\u9898([1-6])/i);
    const isList = /<w:numPr\b/.test(raw);
    if (text) {
      blocks.push({
        type: isList ? 'list' : heading ? 'heading' : 'paragraph',
        level: heading ? Number(heading[1] || heading[2] || 1) : 0,
        text,
      });
    }
    for (const relId of docxImageRelationshipIds(raw)) {
      const image = imageUrls.get(relId);
      if (image) blocks.push({ type: 'image', ...image });
    }
    if (blocks.length >= 500) {
      blocks.push({ type: 'truncated', text: '\u6587\u6863\u8f83\u957f\uff0c\u9884\u89c8\u5df2\u622a\u65ad\u3002' });
      break;
    }
  }
  return blocks;
}

function docxImageRelationshipIds(raw = '') {
  const ids = [];
  for (const match of raw.matchAll(/(?:r:embed|r:link)="([^"]+)"/g)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

function docxRelationshipImageUrls(file, entries, options = {}) {
  const rels = entries.get('word/_rels/document.xml.rels');
  if (!rels || !options.root) return new Map();
  const relationships = new Map();
  const relXml = rels().toString('utf8');
  for (const match of relXml.matchAll(/<Relationship\b([^>]*?)\/?>(?:<\/Relationship>)?/g)) {
    const attrs = xmlAttrs(match[1] || '');
    if (!attrs.Id || !attrs.Target || !/image/i.test(attrs.Type || '')) continue;
    relationships.set(attrs.Id, attrs.Target);
  }
  if (!relationships.size) return new Map();
  const stat = fs.statSync(file);
  const digest = crypto.createHash('sha256')
    .update(`${path.resolve(file)}:${stat.mtimeMs}:${stat.size}:docx-media-v1`)
    .digest('hex')
    .slice(0, 24);
  const cacheDir = path.join(dataDir(options.root), 'preview_cache', 'docx_media', digest);
  ensureDirSync(cacheDir);
  const result = new Map();
  let count = 0;
  for (const [relId, target] of relationships) {
    if (count >= MAX_DOCX_PREVIEW_IMAGES) break;
    const entryName = normalizeDocxRelationshipTarget(target);
    const read = entries.get(entryName);
    if (!read) continue;
    const buffer = read();
    if (!buffer.length || buffer.length > MAX_DOCX_PREVIEW_IMAGE_BYTES) continue;
    const ext = path.extname(entryName).toLowerCase();
    if (!OOXML_MEDIA_EXTENSIONS.has(ext)) continue;
    const filename = `${String(count + 1).padStart(2, '0')}-${path.basename(entryName).replace(/[^A-Za-z0-9_.-]/g, '_')}`;
    const targetPath = path.join(cacheDir, filename);
    if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, buffer);
    result.set(relId, {
      src: pathToFileURL(targetPath).href,
      alt: path.basename(entryName),
      size: buffer.length,
    });
    count += 1;
  }
  return result;
}

function normalizeDocxRelationshipTarget(target = '') {
  const clean = String(target || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (clean.startsWith('/')) return clean.replace(/^\/+/, '');
  if (clean.startsWith('word/')) return clean;
  return path.posix.normalize(`word/${clean}`);
}

function xmlAttrs(value = '') {
  const attrs = {};
  for (const match of String(value || '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attrs[match[1].split(':').pop()] = decodeXmlEntities(match[2] || '');
  }
  return attrs;
}

function extractPptxText(file) {
  return extractPptxSlides(file)
    .map((slide) => `Slide ${slide.index}\n${slide.text.join('\n')}`)
    .join('\n\n')
    .slice(0, MAX_ATTACHMENT_CONTEXT_CHARS);
}

export function extractPptxSlides(file) {
  const entries = readZipEntries(file);
  const slidesByName = new Map();
  for (const [name, read] of entries) {
    const match = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
    if (!match) continue;
    const text = xmlText(read().toString('utf8')).split(/\n+/).map((item) => item.trim()).filter(Boolean);
    slidesByName.set(name, { sourceIndex: Number(match[1]), text });
  }
  const orderedNames = pptxSlideEntryOrder(entries).filter((name) => slidesByName.has(name));
  for (const name of [...slidesByName.keys()].sort((left, right) => (
    slidesByName.get(left).sourceIndex - slidesByName.get(right).sourceIndex
  ))) {
    if (!orderedNames.includes(name)) orderedNames.push(name);
  }
  return orderedNames.map((name, index) => ({
    index: index + 1,
    sourceIndex: slidesByName.get(name).sourceIndex,
    text: slidesByName.get(name).text,
  }));
}

function pptxSlideEntryOrder(entries) {
  const presentation = entries.get('ppt/presentation.xml');
  const relationships = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presentation || !relationships) return [];
  const relTargets = new Map();
  const relationshipXml = relationships().toString('utf8');
  for (const match of relationshipXml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    const id = match[0].match(/\bId="([^"]+)"/)?.[1] || '';
    const rawTarget = match[0].match(/\bTarget="([^"]+)"/)?.[1] || '';
    const target = path.posix.normalize(`ppt/${rawTarget}`).replace(/^\/+/, '');
    if (id && /^ppt\/slides\/slide\d+\.xml$/.test(target)) relTargets.set(id, target);
  }
  const ordered = [];
  const presentationXml = presentation().toString('utf8');
  for (const match of presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)) {
    const target = relTargets.get(match[1]);
    if (target && !ordered.includes(target)) ordered.push(target);
  }
  return ordered;
}

export function extractPdfText(file) {
  const script = [
    'import sys',
    'p=sys.argv[1]',
    'try:',
    ' import fitz',
    ' doc=fitz.open(p)',
    ' print("\\n\\n".join(page.get_text("text") for page in doc)[:90000])',
    'except Exception as e:',
    ' print("PDF 正文抽取暂不可用：" + str(e))',
  ].join('\n');
  const invocation = resolvePythonInvocation(['-c', script, file]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  if (result.error) return `PDF 正文抽取暂不可用：${result.error.message}`;
  return String(result.stdout || result.stderr || 'PDF 正文抽取暂不可用。').trim();
}

function extractPdfTextExcerpt(file, maxChars) {
  const script = [
    'import sys',
    'p=sys.argv[1]',
    'limit=max(400, int(sys.argv[2]))',
    'try:',
    ' import fitz',
    ' doc=fitz.open(p)',
    ' chunks=[]',
    ' for i in range(min(6, doc.page_count)):',
    '  page=doc.load_page(i)',
    '  chunks.append(page.get_text("text"))',
    '  if sum(len(x) for x in chunks) >= limit: break',
    ' print("\\n\\n".join(chunks)[:limit])',
    'except Exception as e:',
    ' print("PDF 正文抽取暂不可用：" + str(e))',
  ].join('\n');
  const invocation = resolvePythonInvocation(['-c', script, file, String(maxChars)]);
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', timeout: 12_000, windowsHide: true });
  if (result.error) return `PDF 正文抽取暂不可用：${result.error.message}`;
  return String(result.stdout || result.stderr || 'PDF 正文抽取暂不可用。').trim().slice(0, maxChars);
}

function xmlText(xml) {
  return String(xml || '')
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function guessContentType(filename) {
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
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.py': 'text/x-python',
    '.c': 'text/x-c',
    '.cc': 'text/x-c++src',
    '.cpp': 'text/x-c++src',
    '.h': 'text/x-c',
    '.hpp': 'text/x-c++hdr',
  }[ext] || 'application/octet-stream';
}

function fileKind(filename, contentType = '') {
  const ext = path.extname(filename).toLowerCase();
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.doc') return 'doc';
  if (ext === '.xlsx') return 'xlsx';
  if (ext === '.xls') return 'xls';
  if (ext === '.pptx') return 'pptx';
  if (ext === '.ppt') return 'ppt';
  if (String(contentType || '').startsWith('image/')) return 'image';
  if (String(contentType || '').startsWith('text/')) return 'text';
  return OFFICE_EXTENSIONS.has(ext) || PRESENTATION_EXTENSIONS.has(ext) ? ext.slice(1) : 'binary';
}

function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
