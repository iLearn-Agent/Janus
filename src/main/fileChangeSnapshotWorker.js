import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const SNAPSHOT_EXTENSIONS = new Set([
  '.doc', '.docx', '.pptx', '.pdf', '.xls', '.xlsx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
]);
const IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.janus', 'node_modules', 'dist', 'build', 'out', 'coverage',
  '.cache', '.next', '.nuxt', '.turbo', 'workspace', 'test-artifacts', 'vendor',
]);

function normalizedPath(value = '') {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function copyFileClone(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try { fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE); }
  catch { fs.copyFileSync(source, target); }
  try { fs.chmodSync(target, 0o600); } catch {}
}

function captureBaseline({ workspaceRoot, baselineRoot, maxFiles, maxBytes, maxFileBytes }) {
  const baselines = [];
  let capturedBytes = 0;
  let scanTruncated = false;
  let scanError = '';
  try {
    fs.mkdirSync(baselineRoot, { recursive: true, mode: 0o700 });
    const stack = [normalizedPath(workspaceRoot)];
    while (stack.length && baselines.length < maxFiles && capturedBytes < maxBytes) {
      const directory = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
      catch { scanError ||= 'baseline_scan_read_failed'; continue; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) stack.push(target);
          continue;
        }
        if (!entry.isFile() || !SNAPSHOT_EXTENSIONS.has(path.extname(target).toLowerCase())) continue;
        if (baselines.length >= maxFiles || capturedBytes >= maxBytes) { scanTruncated = true; break; }
        let stat;
        try { stat = fs.statSync(target); } catch { continue; }
        if (stat.size > maxFileBytes || capturedBytes + stat.size > maxBytes) { scanTruncated = true; continue; }
        const key = normalizedPath(target);
        const ext = path.extname(target).toLowerCase();
        const baselinePath = path.join(baselineRoot, `${String(baselines.length + 1).padStart(4, '0')}${ext}`);
        try {
          copyFileClone(key, baselinePath);
          baselines.push([key, { path: baselinePath, sizeBytes: stat.size, capturedAt: new Date().toISOString() }]);
          capturedBytes += stat.size;
        } catch {
          scanError ||= 'baseline_copy_failed';
        }
      }
    }
    if (stack.length || baselines.length >= maxFiles || capturedBytes >= maxBytes) scanTruncated = true;
  } catch {
    scanError = 'baseline_scan_failed';
  }
  return { baselines, capturedBytes, scanTruncated, scanError };
}

function handleRequest(message = {}) {
  const requestId = String(message.requestId || 'initial');
  try {
    parentPort?.postMessage({ requestId, ok: true, result: captureBaseline(message.data || message) });
  } catch (error) {
    parentPort?.postMessage({ requestId, ok: false, error: String(error?.message || error) });
  }
}

if (workerData) {
  handleRequest({ requestId: 'initial', data: workerData });
  parentPort?.close();
} else {
  parentPort?.on('message', handleRequest);
}
