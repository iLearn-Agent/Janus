import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { dataDir, tmpDir } from './paths.js';
import {
  extractDocxBlocks,
  extractPdfText,
  extractPptxSlides,
  extractSpreadsheetText,
} from './files.js';

const SNAPSHOT_EXTENSIONS = new Set([
  '.doc', '.docx', '.pptx', '.pdf', '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const TEXT_CONTENT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.json', '.css', '.scss', '.less', '.html', '.htm', '.xml', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.csv', '.sql', '.py', '.java', '.c', '.h', '.cpp',
  '.hpp', '.go', '.rs', '.sh', '.ps1', '.bat', '.cmd',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.janus', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', 'workspace', 'test-artifacts', 'vendor',
]);
const DEFAULT_MAX_BASELINE_FILES = 300;
const DEFAULT_MAX_BASELINE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PERSISTED_BYTES = 160 * 1024 * 1024;
const MAX_SEMANTIC_UNITS = 300;
const MAX_STORED_CHANGES = 40;
const MAX_STORED_TEXT = 320;
const baselineWorkerPool = [];
let baselineWorkerRequestSequence = 0;

function boundedEnvNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function safeRunId(value = '') {
  return String(value || crypto.randomUUID()).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

function normalizedPath(value = '') {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function pathInsideRoot(candidate = '', root = '') {
  const target = normalizedPath(candidate);
  const base = normalizedPath(root);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function resolveWorkspacePath(value = '', workspaceRoot = '') {
  const target = String(value || '').trim();
  if (!target) return '';
  return normalizedPath(path.isAbsolute(target) ? target : path.join(workspaceRoot, target));
}

function snapshotExtension(file = '') {
  return path.extname(String(file || '')).toLowerCase();
}

function isSnapshotCandidate(file = '') {
  return SNAPSHOT_EXTENSIONS.has(snapshotExtension(file));
}

function isAddedTextCandidate(change = {}) {
  if (operationKind(change.kind) !== 'add') return false;
  return TEXT_CONTENT_EXTENSIONS.has(snapshotExtension(change.movePath || change.path));
}

function isComparisonCandidate(change = {}) {
  return isSnapshotCandidate(change.movePath || change.path) || isAddedTextCandidate(change);
}

function copyFileClone(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(source, target);
  }
  try { fs.chmodSync(target, 0o600); } catch {}
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function compactText(value = '', max = MAX_STORED_TEXT) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function semanticUnit(unit = {}, index = 0) {
  return {
    index: Number(unit.index ?? index + 1),
    type: String(unit.type || 'text'),
    label: compactText(unit.label || '', 80),
    text: compactText(unit.text || ''),
  };
}

function docxSemantics(file) {
  const blocks = extractDocxBlocks(file);
  const metrics = { headings: 0, paragraphs: 0, lists: 0, tables: 0 };
  const units = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'truncated') continue;
    if (block.type === 'table') {
      metrics.tables += 1;
      units.push(semanticUnit({
        index: index + 1,
        type: 'table',
        label: `表格 ${metrics.tables}`,
        text: (block.rows || []).map((row) => row.join(' | ')).join(' / '),
      }, index));
      continue;
    }
    if (block.type === 'heading') metrics.headings += 1;
    else if (block.type === 'list') metrics.lists += 1;
    else metrics.paragraphs += 1;
    units.push(semanticUnit({
      index: index + 1,
      type: block.type || 'paragraph',
      label: block.type === 'heading' ? `标题 ${block.level || 1}` : '',
      text: block.text,
    }, index));
  }
  return { kind: 'docx', metrics, units, truncated: blocks.some((block) => block.type === 'truncated') };
}

function pptxSemantics(file) {
  const slides = extractPptxSlides(file);
  return {
    kind: 'pptx',
    metrics: { slides: slides.length },
    units: slides.map((slide, index) => semanticUnit({
      index: slide.index || index + 1,
      type: 'slide',
      label: `幻灯片 ${slide.index || index + 1}`,
      text: (slide.text || []).join(' / '),
    }, index)),
    truncated: false,
  };
}

function lineSemantics(kind, text = '') {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    kind,
    metrics: { lines: lines.length, characters: String(text || '').length },
    units: lines.map((line, index) => semanticUnit({ index: index + 1, type: 'line', text: line }, index)),
    truncated: lines.length > MAX_SEMANTIC_UNITS,
  };
}

function imageDimensions(buffer, ext) {
  try {
    if (ext === '.png' && buffer.length >= 24 && buffer.subarray(1, 4).toString('ascii') === 'PNG') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (ext === '.gif' && buffer.length >= 10) return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    if (ext === '.bmp' && buffer.length >= 26) return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
    if (['.jpg', '.jpeg'].includes(ext)) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        if (!length) break;
        offset += 2 + length;
      }
    }
    if (ext === '.webp' && buffer.length >= 30 && buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
      const kind = buffer.subarray(12, 16).toString('ascii');
      if (kind === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (ext === '.svg') {
      const text = buffer.toString('utf8', 0, Math.min(buffer.length, 64_000));
      const width = Number(/\bwidth=["']([0-9.]+)/i.exec(text)?.[1] || 0);
      const height = Number(/\bheight=["']([0-9.]+)/i.exec(text)?.[1] || 0);
      const viewBox = /\bviewBox=["'][^"']*?([0-9.]+)[ ,]+([0-9.]+)["']/i.exec(text);
      return { width: width || Number(viewBox?.[1] || 0), height: height || Number(viewBox?.[2] || 0) };
    }
  } catch {}
  return { width: 0, height: 0 };
}

function imageSemantics(file, ext) {
  const stat = fs.statSync(file);
  const buffer = fs.readFileSync(file);
  const dimensions = imageDimensions(buffer, ext);
  return {
    kind: 'image',
    metrics: { width: dimensions.width, height: dimensions.height, bytes: stat.size },
    units: [],
    truncated: false,
  };
}

function extractSemantics(file) {
  const ext = snapshotExtension(file);
  try {
    if (ext === '.docx') return { status: 'complete', ...docxSemantics(file) };
    if (ext === '.pptx') return { status: 'complete', ...pptxSemantics(file) };
    if (ext === '.xlsx') return { status: 'complete', ...lineSemantics('xlsx', extractSpreadsheetText(file)) };
    if (ext === '.pdf') {
      const text = extractPdfText(file);
      if (/^PDF 正文抽取暂不可用/.test(text)) return { status: 'unavailable', kind: 'pdf', reason: 'pdf_text_extraction_unavailable', metrics: {}, units: [], truncated: false };
      return { status: 'complete', ...lineSemantics('pdf', text) };
    }
    if (IMAGE_EXTENSIONS.has(ext)) return { status: 'complete', ...imageSemantics(file, ext) };
    if (TEXT_CONTENT_EXTENSIONS.has(ext)) return { status: 'complete', ...lineSemantics(ext.slice(1) || 'text', fs.readFileSync(file, 'utf8')) };
    return { status: 'hash_only', kind: ext.slice(1) || 'binary', metrics: {}, units: [], truncated: false };
  } catch {
    return { status: 'unavailable', kind: ext.slice(1) || 'binary', reason: 'semantic_extraction_failed', metrics: {}, units: [], truncated: false };
  }
}

function semanticKey(unit = {}) {
  return `${unit.type || ''}\u0000${unit.label || ''}\u0000${unit.text || ''}`;
}

function semanticDiff(before = {}, after = {}) {
  const beforeUnits = (before.units || []).slice(0, MAX_SEMANTIC_UNITS);
  const afterUnits = (after.units || []).slice(0, MAX_SEMANTIC_UNITS);
  const rows = Array.from({ length: beforeUnits.length + 1 }, () => new Uint16Array(afterUnits.length + 1));
  for (let left = beforeUnits.length - 1; left >= 0; left -= 1) {
    for (let right = afterUnits.length - 1; right >= 0; right -= 1) {
      rows[left][right] = semanticKey(beforeUnits[left]) === semanticKey(afterUnits[right])
        ? rows[left + 1][right + 1] + 1
        : Math.max(rows[left + 1][right], rows[left][right + 1]);
    }
  }
  const added = [];
  const removed = [];
  let left = 0;
  let right = 0;
  while (left < beforeUnits.length && right < afterUnits.length) {
    if (semanticKey(beforeUnits[left]) === semanticKey(afterUnits[right])) {
      left += 1;
      right += 1;
    } else if (rows[left + 1][right] >= rows[left][right + 1]) {
      removed.push(beforeUnits[left]);
      left += 1;
    } else {
      added.push(afterUnits[right]);
      right += 1;
    }
  }
  while (left < beforeUnits.length) removed.push(beforeUnits[left++]);
  while (right < afterUnits.length) added.push(afterUnits[right++]);
  const clippedAdded = added.slice(0, MAX_STORED_CHANGES);
  const clippedRemoved = removed.slice(0, MAX_STORED_CHANGES);
  return {
    status: before.status === 'complete' && after.status === 'complete' ? 'complete' : 'partial',
    algorithm: 'semantic_lcs_v1',
    beforeMetrics: before.metrics || {},
    afterMetrics: after.metrics || {},
    added: clippedAdded,
    removed: clippedRemoved,
    addedCount: added.length,
    removedCount: removed.length,
    unchangedCount: rows[0][0],
    truncated: Boolean(before.truncated || after.truncated || added.length > clippedAdded.length || removed.length > clippedRemoved.length),
    reason: before.reason || after.reason || '',
  };
}

function operationKind(value = '') {
  const kind = String(value || '').toLowerCase();
  if (['add', 'added', 'create', 'created'].includes(kind)) return 'add';
  if (['delete', 'deleted', 'remove', 'removed'].includes(kind)) return 'delete';
  if (['move', 'moved', 'rename', 'renamed'].includes(kind)) return 'move';
  return 'update';
}

function snapshotDescriptor(file, displayName) {
  if (!file || !fs.existsSync(file)) return { available: false };
  const stat = fs.statSync(file);
  return {
    available: true,
    sha256: hashFile(file),
    sizeBytes: stat.size,
    snapshot: { path: file, name: displayName || path.basename(file), filename: displayName || path.basename(file) },
    semantics: extractSemantics(file),
  };
}

function comparisonReason({ operation, before, after, baselineCoverage }) {
  if (operation === 'add' && !after.available) return 'added_file_missing_after_turn';
  if (operation === 'delete' && !before.available) return baselineCoverage === 'complete' ? 'deleted_file_missing_from_baseline' : 'baseline_scan_incomplete';
  if (operation === 'move' && (!before.available || !after.available)) return !before.available ? 'move_source_missing_from_baseline' : 'move_target_missing_after_turn';
  if (operation === 'update' && !before.available) return baselineCoverage === 'complete' ? 'file_missing_from_turn_baseline' : 'baseline_scan_incomplete';
  if (operation === 'update' && !after.available) return 'updated_file_missing_after_turn';
  return '';
}

function snapshotName(originalName, side, ext) {
  const stem = path.basename(originalName, ext).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';
  return `${stem}-${side}${ext}`;
}

export function createFileChangeSnapshotRun({ root, cwd, runId = '', baselineState = null } = {}) {
  const workspaceRoot = normalizedPath(cwd || root);
  const id = safeRunId(runId);
  const baselineRoot = path.join(tmpDir(root), 'file-change-baselines', id);
  const persistentRoot = path.join(dataDir(root), 'file_change_snapshots', id);
  const maxFiles = boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_FILES', DEFAULT_MAX_BASELINE_FILES, 1, 2000);
  const maxBytes = boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_BYTES', DEFAULT_MAX_BASELINE_BYTES, 1024 * 1024, 2 * 1024 * 1024 * 1024);
  const maxFileBytes = boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES, 64 * 1024, 256 * 1024 * 1024);
  const maxPersistedBytes = boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_PERSISTED_BYTES', DEFAULT_MAX_PERSISTED_BYTES, 1024 * 1024, 2 * 1024 * 1024 * 1024);
  const baselines = new Map();
  const observed = new Map();
  let capturedBytes = 0;
  let persistedBytes = 0;
  let scanTruncated = false;
  let scanError = '';

  if (baselineState) {
    for (const [key, value] of baselineState.baselines || []) baselines.set(key, value);
    capturedBytes = Math.max(0, Number(baselineState.capturedBytes || 0));
    scanTruncated = Boolean(baselineState.scanTruncated);
    scanError = String(baselineState.scanError || '');
  } else try {
    fs.mkdirSync(baselineRoot, { recursive: true, mode: 0o700 });
    const stack = [workspaceRoot];
    while (stack.length && baselines.size < maxFiles && capturedBytes < maxBytes) {
      const directory = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { scanError ||= 'baseline_scan_read_failed'; continue; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) stack.push(target);
          continue;
        }
        if (!entry.isFile() || !isSnapshotCandidate(target)) continue;
        if (baselines.size >= maxFiles || capturedBytes >= maxBytes) { scanTruncated = true; break; }
        let stat;
        try { stat = fs.statSync(target); } catch { continue; }
        if (stat.size > maxFileBytes || capturedBytes + stat.size > maxBytes) { scanTruncated = true; continue; }
        const key = normalizedPath(target);
        const ext = snapshotExtension(target);
        const baselinePath = path.join(baselineRoot, `${String(baselines.size + 1).padStart(4, '0')}${ext}`);
        try {
          copyFileClone(key, baselinePath);
          baselines.set(key, { path: baselinePath, sizeBytes: stat.size, capturedAt: new Date().toISOString() });
          capturedBytes += stat.size;
        } catch {
          scanError ||= 'baseline_copy_failed';
        }
      }
    }
    if (stack.length || baselines.size >= maxFiles || capturedBytes >= maxBytes) scanTruncated = true;
  } catch {
    scanError = 'baseline_scan_failed';
  }

  const baselineCoverage = scanError || scanTruncated ? 'partial' : 'complete';

  const pendingComparison = (change = {}) => {
    const sourcePath = resolveWorkspacePath(change.path || '', workspaceRoot);
    return {
      version: 1,
      status: 'pending',
      strict: false,
      operation: operationKind(change.kind),
      derivedSource: 'janus_turn_snapshot',
      nativeChangeSource: 'codex_app_server',
      baselineScope: 'turn_start',
      baselineCoverage,
      baselineCaptured: baselines.has(sourcePath),
      reason: 'waiting_for_completed_file_state',
    };
  };

  const persistSide = (source, target, displayName) => {
    if (!source || !fs.existsSync(source)) return { available: false };
    const size = fs.statSync(source).size;
    if (size > maxFileBytes || persistedBytes + size > maxPersistedBytes) return { available: false, reason: 'snapshot_size_limit' };
    copyFileClone(source, target);
    persistedBytes += size;
    return snapshotDescriptor(target, displayName);
  };

  const completedComparison = (change = {}, activityId = '', index = 0) => {
    const operation = operationKind(change.kind);
    const sourcePath = resolveWorkspacePath(change.path || '', workspaceRoot);
    const targetPath = resolveWorkspacePath(change.movePath || change.path || '', workspaceRoot);
    const ext = snapshotExtension(targetPath || sourcePath);
    const originalName = path.basename(change.movePath || change.path || `file${ext}`);
    const comparisonId = crypto.createHash('sha256').update(`${activityId}\u0000${sourcePath}\u0000${targetPath}\u0000${index}`).digest('hex').slice(0, 20);
    const comparisonRoot = path.join(persistentRoot, comparisonId);
    const baseline = baselines.get(sourcePath);
    const beforeName = snapshotName(originalName, 'before', ext);
    const afterName = snapshotName(originalName, 'after', ext);
    const before = operation === 'add'
      ? { available: false, expectedAbsent: true }
      : persistSide(baseline?.path || '', path.join(comparisonRoot, beforeName), beforeName);
    const afterExists = operation !== 'delete' && targetPath && pathInsideRoot(targetPath, workspaceRoot) && fs.existsSync(targetPath);
    const after = operation === 'delete'
      ? { available: false, expectedAbsent: true }
      : afterExists
        ? persistSide(targetPath, path.join(comparisonRoot, afterName), afterName)
        : { available: false };
    const reason = before.reason || after.reason || comparisonReason({ operation, before, after, baselineCoverage });
    const strict = !reason && (
      (operation === 'add' && after.available)
      || (operation === 'delete' && before.available)
      || (['update', 'move'].includes(operation) && before.available && after.available)
    );
    let semantic;
    if (before.available && after.available) {
      semantic = semanticDiff(before.semantics || {}, after.semantics || {});
    } else {
      const addedUnits = operation === 'add' ? (after.semantics?.units || []) : [];
      const removedUnits = operation === 'delete' ? (before.semantics?.units || []) : [];
      semantic = {
        status: strict ? (before.semantics?.status || after.semantics?.status || 'complete') : 'unavailable',
        algorithm: IMAGE_EXTENSIONS.has(ext) ? 'binary_hash_v1' : 'semantic_lcs_v1',
        beforeMetrics: before.semantics?.metrics || {},
        afterMetrics: after.semantics?.metrics || {},
        added: addedUnits.slice(0, MAX_STORED_CHANGES),
        removed: removedUnits.slice(0, MAX_STORED_CHANGES),
        addedCount: addedUnits.length,
        removedCount: removedUnits.length,
        unchangedCount: 0,
        truncated: Boolean(
          before.semantics?.truncated || after.semantics?.truncated
          || addedUnits.length > MAX_STORED_CHANGES || removedUnits.length > MAX_STORED_CHANGES
        ),
        reason,
      };
    }
    if (before.available) delete before.semantics;
    if (after.available) delete after.semantics;
    return {
      version: 1,
      status: strict ? 'complete' : 'unavailable',
      strict,
      operation,
      kind: ext.slice(1) || 'binary',
      derivedSource: 'janus_turn_snapshot',
      nativeChangeSource: 'codex_app_server',
      baselineScope: 'turn_start',
      baselineCoverage,
      capturedAt: new Date().toISOString(),
      snapshotRetention: 'local_persistent',
      before,
      after,
      semantic,
      reason,
    };
  };

  return {
    id,
    workspaceRoot,
    coverage: {
      status: baselineCoverage,
      capturedFiles: baselines.size,
      capturedBytes,
      maxFiles,
      maxBytes,
      scanTruncated,
      reason: scanError,
    },
    pending(changes = []) {
      return (Array.isArray(changes) ? changes : []).map((change) => (
        isComparisonCandidate(change) ? { ...change, comparison: pendingComparison(change) } : change
      ));
    },
    observe(activityId = '', changes = []) {
      const eligible = (Array.isArray(changes) ? changes : []).filter((change) => isComparisonCandidate(change));
      if (eligible.length) observed.set(String(activityId || ''), eligible.map((change) => ({ ...change })));
      return this.pending(changes);
    },
    complete(activityId = '', changes = []) {
      const source = Array.isArray(changes) ? changes : [];
      observed.delete(String(activityId || ''));
      return source.map((change, index) => (
        isComparisonCandidate(change)
          ? { ...change, comparison: completedComparison(change, activityId, index) }
          : change
      ));
    },
    finalizePending() {
      const finalized = [];
      for (const [activityId, changes] of observed) {
        finalized.push({ activityId, changes: this.complete(activityId, changes) });
      }
      return finalized;
    },
    close() {
      try { fs.rmSync(baselineRoot, { recursive: true, force: true }); } catch {}
      try {
        if (fs.existsSync(persistentRoot) && !fs.readdirSync(persistentRoot).length) fs.rmSync(persistentRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function createFileChangeSnapshotRunAsync({ root, cwd, runId = '', signal = null } = {}) {
  const mode = String(process.env.JANUS_FILE_SNAPSHOT_MODE || 'worker').trim().toLowerCase();
  if (mode === 'sync') return createFileChangeSnapshotRun({ root, cwd, runId });
  const workspaceRoot = normalizedPath(cwd || root);
  const id = safeRunId(runId);
  const baselineRoot = path.join(tmpDir(root), 'file-change-baselines', id);
  const limits = {
    maxFiles: boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_FILES', DEFAULT_MAX_BASELINE_FILES, 1, 2000),
    maxBytes: boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_BYTES', DEFAULT_MAX_BASELINE_BYTES, 1024 * 1024, 2 * 1024 * 1024 * 1024),
    maxFileBytes: boundedEnvNumber('JANUS_FILE_SNAPSHOT_MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES, 64 * 1024, 256 * 1024 * 1024),
  };
  if (mode === 'off') {
    const snapshotRun = createFileChangeSnapshotRun({
      root, cwd, runId,
      baselineState: { baselines: [], capturedBytes: 0, scanTruncated: true, scanError: 'baseline_scan_disabled' },
    });
    snapshotRun.baselineDurationMs = 0;
    snapshotRun.baselineFileCount = 0;
    snapshotRun.baselineBytes = 0;
    snapshotRun.baselineMode = 'off';
    return snapshotRun;
  }
  const startedAt = Date.now();
  let baselineState;
  try {
    baselineState = await runBaselineWorker({
      workspaceRoot, baselineRoot, ...limits, signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.code === 'file_snapshot_worker_shutdown') {
      try { fs.rmSync(baselineRoot, { recursive: true, force: true }); } catch {}
      throw error;
    }
    baselineState = {
      baselines: [], capturedBytes: 0, scanTruncated: true,
      scanError: 'baseline_worker_failed',
    };
  }
  const snapshotRun = createFileChangeSnapshotRun({ root, cwd, runId, baselineState });
  snapshotRun.baselineDurationMs = Math.max(0, Date.now() - startedAt);
  snapshotRun.baselineFileCount = Array.isArray(baselineState.baselines) ? baselineState.baselines.length : 0;
  snapshotRun.baselineBytes = Math.max(0, Number(baselineState.capturedBytes || 0));
  snapshotRun.baselineMode = 'worker';
  return snapshotRun;
}

function runBaselineWorker({ signal = null, ...workerData } = {}) {
  return new Promise((resolve, reject) => {
    const record = acquireBaselineWorker();
    const { worker } = record;
    const requestId = `baseline-${++baselineWorkerRequestSequence}`;
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abortHandler);
      worker.removeListener('message', messageHandler);
      worker.removeListener('error', errorHandler);
      worker.removeListener('exit', exitHandler);
    };
    const finish = (error = null, result = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      record.busy = false;
      worker.unref();
      if (error) reject(error);
      else resolve(result);
    };
    const abortHandler = () => {
      void worker.terminate();
      removeBaselineWorker(record);
      const error = signal?.reason instanceof Error ? signal.reason : new Error('File snapshot baseline capture was cancelled.');
      error.code ||= 'file_snapshot_cancelled';
      finish(error);
    };
    const messageHandler = (message = {}) => {
      if (String(message.requestId || '') !== requestId) return;
      if (message.ok) finish(null, message.result || {});
      else finish(new Error(message.error || 'File snapshot worker failed.'));
    };
    const errorHandler = (error) => {
      removeBaselineWorker(record);
      finish(error);
    };
    const exitHandler = (code) => {
      removeBaselineWorker(record);
      if (!settled) {
        const error = new Error(`File snapshot worker exited with code ${code}.`);
        if (record.shutdownRequested) error.code = 'file_snapshot_worker_shutdown';
        finish(error);
      }
    };
    worker.on('message', messageHandler);
    worker.once('error', errorHandler);
    worker.once('exit', exitHandler);
    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (!settled) worker.postMessage({ requestId, data: workerData });
  });
}

function acquireBaselineWorker() {
  const idle = baselineWorkerPool.find((record) => !record.busy && !record.dead);
  if (idle) {
    idle.busy = true;
    idle.worker.ref();
    return idle;
  }
  const worker = new Worker(new URL('./fileChangeSnapshotWorker.js', import.meta.url));
  const record = { worker, busy: true, dead: false, shutdownRequested: false };
  baselineWorkerPool.push(record);
  worker.on('error', () => {
    record.dead = true;
    removeBaselineWorker(record);
  });
  worker.once('exit', () => {
    record.dead = true;
    removeBaselineWorker(record);
  });
  worker.ref();
  return record;
}

function removeBaselineWorker(record) {
  const index = baselineWorkerPool.indexOf(record);
  if (index >= 0) baselineWorkerPool.splice(index, 1);
}

export function fileChangeSnapshotWorkerPoolSnapshot() {
  return {
    total: baselineWorkerPool.length,
    busy: baselineWorkerPool.filter((record) => record.busy).length,
  };
}

export function terminateFileChangeSnapshotWorkers() {
  const records = baselineWorkerPool.splice(0, baselineWorkerPool.length);
  for (const record of records) {
    record.dead = true;
    record.shutdownRequested = true;
    void record.worker.terminate().catch(() => {});
  }
  return records.length;
}
