import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SUCCESS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
export const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_RUNS_CAP_BYTES = 10 * 1024 * 1024 * 1024;

export async function pruneTestRuns(runsRoot, {
  now = Date.now(),
  maxBytes = Number(process.env.JANUS_TEST_RUNS_MAX_BYTES || DEFAULT_RUNS_CAP_BYTES),
} = {}) {
  await fsp.mkdir(runsRoot, { recursive: true });
  const entries = await fsp.readdir(runsRoot, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runsRoot, entry.name);
    const metadata = readJson(path.join(directory, 'run.json')) || {};
    const stat = await fsp.stat(directory).catch(() => null);
    const endedAt = Date.parse(metadata.endedAt || metadata.startedAt || '') || stat?.mtimeMs || now;
    const failed = ['failed', 'infrastructure_error'].includes(metadata.status);
    const retention = failed ? FAILURE_RETENTION_MS : SUCCESS_RETENTION_MS;
    runs.push({ directory, id: entry.name, failed, endedAt, size: await directorySize(directory) });
    if (now - endedAt > retention) await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const retained = [];
  for (const run of runs) {
    if (fs.existsSync(run.directory)) retained.push({ ...run, size: await directorySize(run.directory) });
  }
  let total = retained.reduce((sum, run) => sum + run.size, 0);
  const ordered = retained.sort((a, b) => Number(a.failed) - Number(b.failed) || a.endedAt - b.endedAt);
  const removedForCapacity = [];
  for (const run of ordered) {
    if (total <= maxBytes) break;
    await fsp.rm(run.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    total -= run.size;
    removedForCapacity.push(run.id);
  }
  return { totalBytes: Math.max(0, total), removedForCapacity };
}

export async function directorySize(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(filePath);
    else if (entry.isFile()) total += (await fsp.stat(filePath).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}
