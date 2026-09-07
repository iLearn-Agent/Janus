import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeTextAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

export function writeTextAtomicSync(file, text) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function clipText(text, limit = 4000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  const half = Math.max(1, Math.floor((limit - 32) / 2));
  return `${value.slice(0, half).trimEnd()}\n[...clipped...]\n${value.slice(-half).trimStart()}`;
}

export function normalizePathForDisplay(value) {
  return String(value || '').replaceAll('\\', '/');
}

export async function copyDirIfMissing(source, target) {
  if (fs.existsSync(target)) return;
  await ensureDir(path.dirname(target));
  await fsp.cp(source, target, {
    recursive: true,
    filter: (item) => {
      const name = path.basename(item);
      if (name === '__pycache__') return false;
      if (name === '.DS_Store') return false;
      return true;
    },
  });
}

async function sha256File(file) {
  const content = await fsp.readFile(file);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function listSeedFiles(root, current = root, output = []) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await listSeedFiles(root, fullPath, output);
    } else if (entry.isFile()) {
      output.push(path.relative(root, fullPath));
    }
  }
  return output;
}

export async function syncDirFromSeed(source, target, { previousHashes = {} } = {}) {
  await ensureDir(target);
  const files = (await listSeedFiles(source)).sort();
  const hashes = {};
  const copied = [];
  const updated = [];
  const preserved = [];
  const removed = [];

  for (const [relative, previousHashValue] of Object.entries(previousHashes || {})) {
    if (files.includes(relative)) continue;
    const targetFile = path.join(target, relative);
    if (!fs.existsSync(targetFile)) continue;
    const targetStat = await fsp.stat(targetFile);
    if (!targetStat.isFile()) continue;
    const targetHash = await sha256File(targetFile);
    if (targetHash === String(previousHashValue || '')) {
      await fsp.rm(targetFile, { force: true });
      removed.push(relative);
    } else {
      preserved.push(relative);
    }
  }

  for (const relative of files) {
    const sourceFile = path.join(source, relative);
    const targetFile = path.join(target, relative);
    const sourceHash = await sha256File(sourceFile);
    const previousHash = String(previousHashes?.[relative] || '');

    if (!fs.existsSync(targetFile)) {
      await ensureDir(path.dirname(targetFile));
      await fsp.copyFile(sourceFile, targetFile);
      copied.push(relative);
      hashes[relative] = sourceHash;
      continue;
    }

    const targetStat = await fsp.stat(targetFile);
    if (!targetStat.isFile()) {
      preserved.push(relative);
      continue;
    }

    const targetHash = await sha256File(targetFile);
    if (targetHash === sourceHash) {
      hashes[relative] = sourceHash;
      continue;
    }

    if (previousHash && targetHash === previousHash) {
      await fsp.copyFile(sourceFile, targetFile);
      updated.push(relative);
      hashes[relative] = sourceHash;
      continue;
    }

    // The runtime copy differs from both the current seed and the last known
    // seed. Treat it as user-owned and leave it untouched.
    preserved.push(relative);
  }

  const directories = [];
  const collectDirectories = async (current) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      await collectDirectories(fullPath);
      directories.push(fullPath);
    }
  };
  await collectDirectories(target);
  for (const directory of directories) {
    try { await fsp.rmdir(directory); } catch {}
  }

  return { files, hashes, copied, updated, preserved, removed };
}

export function parseJsonFile(file, fallback = {}) {
  const text = readText(file, '');
  if (!text.trim()) return fallback;
  return safeJsonParse(text, fallback);
}

export function listDirs(parent) {
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

export function listFiles(parent, predicate = () => true) {
  if (!fs.existsSync(parent)) return [];
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(parent, entry.name))
    .filter(predicate)
    .sort();
}
