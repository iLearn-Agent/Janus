import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { appendDiagnosticEvent, testDiagnosticFile } from '../diagnostics.js';
import {
  diagnosticError,
  newDiagnosticId,
  redactDiagnosticText,
  sanitizeLogMetadata,
} from './redaction.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, fatal: 50 });
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 14;
const MAX_PENDING_EVENTS = 2_000;
const MAX_EARLY_EVENTS = 200;
const ACTIVE_FILE_NAME = 'janus.log';

const state = {
  initialized: false,
  directory: '',
  activePath: '',
  activeBytes: 0,
  activeDate: '',
  appVersion: '',
  releaseChannel: '',
  processType: 'node',
  level: 'info',
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  retentionDays: DEFAULT_RETENTION_DAYS,
  sequence: 0,
  rotationSequence: 0,
  pending: Promise.resolve(),
  pendingCount: 0,
  droppedCount: 0,
  lastWriteAt: '',
  lastError: '',
  fallbackError: '',
  earlyEvents: [],
  now: () => new Date(),
  env: process.env,
};

export function resolveApplicationLogDirectory({ directory = '', userDataDir = '', env = process.env } = {}) {
  const explicit = String(directory || env.JANUS_LOG_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const janusHome = String(env.JANUS_HOME || '').trim();
  if (janusHome) return path.resolve(janusHome, 'logs');
  if (!userDataDir) throw new Error('Application logging requires userDataDir or an explicit directory.');
  return path.resolve(userDataDir, 'logs');
}

export function initializeApplicationLogging({
  directory = '', userDataDir = '', appVersion = '', releaseChannel = '', processType = 'electron-main',
  level = '', maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  retentionDays = DEFAULT_RETENTION_DAYS, env = process.env, now = () => new Date(),
} = {}) {
  const targetDirectory = resolveApplicationLogDirectory({ directory, userDataDir, env });
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(targetDirectory, 0o700); } catch {}
  const activePath = path.join(targetDirectory, ACTIVE_FILE_NAME);
  if (!fs.existsSync(activePath)) fs.writeFileSync(activePath, '', { mode: 0o600 });
  try { fs.chmodSync(activePath, 0o600); } catch {}

  state.initialized = true;
  state.directory = targetDirectory;
  state.activePath = activePath;
  const activeStat = safeStat(activePath);
  state.activeBytes = activeStat?.size || 0;
  state.activeDate = state.activeBytes > 0 && activeStat?.mtimeMs
    ? utcDateKey(new Date(activeStat.mtimeMs))
    : utcDateKey(now());
  state.appVersion = String(appVersion || '');
  state.releaseChannel = String(releaseChannel || '');
  state.processType = String(processType || 'node');
  state.level = normalizeLevel(level || env.JANUS_LOG_LEVEL || 'info');
  state.maxFileBytes = positiveNumber(maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  state.maxTotalBytes = positiveNumber(maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  state.retentionDays = positiveNumber(retentionDays, DEFAULT_RETENTION_DAYS);
  state.pending = Promise.resolve();
  state.pendingCount = 0;
  state.droppedCount = 0;
  state.lastError = '';
  state.fallbackError = '';
  state.now = typeof now === 'function' ? now : () => new Date();
  state.env = env;
  state.pending = pruneManagedLogFiles().catch((error) => rememberWriteError(error));

  const earlyEvents = state.earlyEvents.splice(0);
  for (const record of earlyEvents) enqueueRecord(record);
  return applicationLoggingStatus();
}

export function getApplicationLogger(source = 'application', { testFileName = '' } = {}) {
  const fixedSource = cleanName(source, 'application');
  const emit = (level, event, details = {}) => emitApplicationLog({
    source: fixedSource,
    level,
    event,
    testFileName,
    ...normalizeDetails(details),
  });
  const logger = {
    log: emit,
    debug: (event, details) => emit('debug', event, details),
    info: (event, details) => emit('info', event, details),
    warn: (event, details) => emit('warn', event, details),
    error: (event, details) => emit('error', event, details),
    fatal: (event, details) => emit('fatal', event, details),
    child(context = {}) {
      const baseContext = sanitizeLogMetadata(context, { env: state.env });
      return childLogger(logger, baseContext);
    },
  };
  return logger;
}

export function emitApplicationLog({
  source = 'application', level = 'info', event = 'application_event', message = '', data = undefined,
  error = undefined, durationMs = undefined, context = undefined, testFileName = '',
} = {}) {
  const normalizedLevel = normalizeLevel(level);
  const now = state.now();
  const record = buildRecord({ source, level: normalizedLevel, event, message, data, error, durationMs, context, now });
  writeTestSink(record, testFileName);
  if (!state.initialized) {
    state.earlyEvents.push(record);
    if (state.earlyEvents.length > MAX_EARLY_EVENTS) state.earlyEvents.shift();
    return false;
  }
  if (LEVELS[normalizedLevel] < LEVELS[state.level]) return false;
  if (normalizedLevel === 'fatal') return writeRecordSync(record);
  return enqueueRecord(record);
}

export function applicationLoggingStatus() {
  const files = state.directory ? managedFiles(state.directory) : [];
  return {
    enabled: state.initialized,
    level: state.level,
    directory: state.directory,
    activeFileName: ACTIVE_FILE_NAME,
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0),
    retentionDays: state.retentionDays,
    maxFileBytes: state.maxFileBytes,
    maxTotalBytes: state.maxTotalBytes,
    pendingCount: state.pendingCount,
    droppedCount: state.droppedCount,
    lastWriteAt: state.lastWriteAt,
    lastError: state.lastError,
  };
}

export async function flushApplicationLogs() {
  await state.pending;
  return applicationLoggingStatus();
}

export async function closeApplicationLogging() {
  await flushApplicationLogs();
  state.initialized = false;
  return applicationLoggingStatus();
}

export async function clearRotatedApplicationLogs() {
  if (!state.directory) return { removed: 0, bytesFreed: 0 };
  await flushApplicationLogs();
  const files = managedFiles(state.directory).filter((item) => item.path !== state.activePath);
  let removed = 0;
  let bytesFreed = 0;
  for (const item of files) {
    try {
      await fsp.rm(item.path, { force: true });
      removed += 1;
      bytesFreed += item.size;
    } catch (error) {
      rememberWriteError(error);
    }
  }
  getApplicationLogger('logging').info('logs_cleared', { data: { removed, bytesFreed } });
  return { removed, bytesFreed, status: applicationLoggingStatus() };
}

export async function exportApplicationLogs({ destination, manifest = {} } = {}) {
  if (!state.directory || !destination) throw new Error('Application logs and export destination are required.');
  await flushApplicationLogs();
  const files = managedFiles(state.directory)
    .filter((item) => item.path.endsWith('.log') && path.resolve(item.path) !== path.resolve(destination))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const snapshots = files.map((item) => ({ ...item, size: safeStat(item.path)?.size || item.size })).filter((item) => item.size > 0);
  const timestamps = snapshots.map((item) => item.mtimeMs).filter(Number.isFinite);
  const exportEvent = buildRecord({
    source: 'logging', level: 'info', event: 'diagnostic_export_manifest', message: 'Janus diagnostic log export',
    data: {
      appVersion: state.appVersion,
      releaseChannel: state.releaseChannel,
      platform: process.platform,
      arch: process.arch,
      exportedAt: state.now().toISOString(),
      from: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : '',
      to: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : '',
      fileCount: snapshots.length,
      files: snapshots.map((item) => path.basename(item.path)),
      ...manifest,
    },
    now: state.now(),
  });
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.writeFile(destination, `${JSON.stringify(exportEvent)}\n`, { mode: 0o600 });
  for (const item of snapshots) {
    if (!item.size) continue;
    await pipeline(
      fs.createReadStream(item.path, { start: 0, end: item.size - 1 }),
      fs.createWriteStream(destination, { flags: 'a', mode: 0o600 }),
    );
  }
  const stat = await fsp.stat(destination);
  return {
    path: destination,
    name: path.basename(destination),
    size: stat.size,
    fileCount: snapshots.length,
  };
}

async function pruneManagedLogFiles() {
  if (!state.directory) return { removed: 0, bytesFreed: 0 };
  const cutoff = state.now().getTime() - state.retentionDays * 24 * 60 * 60 * 1_000;
  let files = managedFiles(state.directory);
  let removed = 0;
  let bytesFreed = 0;
  for (const item of files.filter((entry) => entry.path !== state.activePath && entry.mtimeMs < cutoff)) {
    try {
      await fsp.rm(item.path, { force: true });
      removed += 1;
      bytesFreed += item.size;
    } catch (error) {
      rememberWriteError(error);
    }
  }
  files = managedFiles(state.directory);
  let totalBytes = files.reduce((sum, item) => sum + item.size, 0);
  for (const item of files.filter((entry) => entry.path !== state.activePath).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= state.maxTotalBytes) break;
    try {
      await fsp.rm(item.path, { force: true });
      removed += 1;
      bytesFreed += item.size;
      totalBytes -= item.size;
    } catch (error) {
      rememberWriteError(error);
    }
  }
  return { removed, bytesFreed };
}

function enqueueRecord(record) {
  if (state.pendingCount >= MAX_PENDING_EVENTS && LEVELS[record.level] < LEVELS.warn) {
    state.droppedCount += 1;
    return false;
  }
  state.pendingCount += 1;
  state.pending = state.pending
    .then(async () => {
      await rotateIfNeeded(record);
      const line = `${JSON.stringify(record)}\n`;
      await fsp.appendFile(state.activePath, line, { encoding: 'utf8', mode: 0o600 });
      state.activeBytes += Buffer.byteLength(line);
      state.lastWriteAt = record.timestamp;
      state.lastError = '';
      state.fallbackError = '';
    })
    .catch((error) => rememberWriteError(error))
    .finally(() => {
      state.pendingCount = Math.max(0, state.pendingCount - 1);
    });
  return true;
}

async function rotateIfNeeded(record) {
  const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
  const recordDate = utcDateKey(new Date(record.timestamp));
  if (state.activeBytes + lineBytes <= state.maxFileBytes && recordDate === state.activeDate) return;
  const rotatedPath = nextRotatedPath();
  try {
    if ((safeStat(state.activePath)?.size || 0) > 0) await fsp.rename(state.activePath, rotatedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fsp.writeFile(state.activePath, '', { mode: 0o600 });
  state.activeBytes = 0;
  state.activeDate = recordDate;
  await pruneManagedLogFiles();
}

function writeRecordSync(record) {
  try {
    const line = `${JSON.stringify(record)}\n`;
    rotateSyncIfNeeded(line, record);
    fs.appendFileSync(state.activePath, line, { encoding: 'utf8', mode: 0o600 });
    state.activeBytes += Buffer.byteLength(line);
    state.lastWriteAt = record.timestamp;
    state.lastError = '';
    return true;
  } catch (error) {
    rememberWriteError(error);
    return false;
  }
}

function rotateSyncIfNeeded(line, record) {
  const recordDate = utcDateKey(new Date(record.timestamp));
  if (state.activeBytes + Buffer.byteLength(line) <= state.maxFileBytes && recordDate === state.activeDate) return;
  if ((safeStat(state.activePath)?.size || 0) > 0) {
    fs.renameSync(state.activePath, nextRotatedPath());
  }
  fs.writeFileSync(state.activePath, '', { mode: 0o600 });
  state.activeBytes = 0;
  state.activeDate = recordDate;
}

function buildRecord({ source, level, event, message = '', data, error, durationMs, context, now }) {
  const timestamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  return sanitizeLogMetadata({
    schemaVersion: 1,
    timestamp,
    sequence: ++state.sequence,
    eventId: newDiagnosticId('log'),
    level: normalizeLevel(level),
    source: cleanName(source, 'application'),
    event: cleanName(event, 'application_event'),
    message: redactDiagnosticText(message || event || 'application_event', { maxLength: 2_000, env: state.env }),
    durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    context: context || undefined,
    data: data || undefined,
    error: error ? diagnosticError(error, { env: state.env }) : undefined,
    appVersion: state.appVersion,
    releaseChannel: state.releaseChannel,
    platform: process.platform,
    arch: process.arch,
    processType: state.processType,
    pid: process.pid,
  }, { env: state.env });
}

function writeTestSink(record, testFileName) {
  if (!testFileName) return;
  const filePath = testDiagnosticFile(testFileName, state.env);
  if (!filePath) return;
  appendDiagnosticEvent(filePath, {
    source: record.source,
    level: record.level,
    event: record.event,
    message: record.message,
    durationMs: record.durationMs,
    data: { context: record.context, ...record.data },
    error: record.error,
  }, { env: state.env });
}

function childLogger(parent, baseContext) {
  const wrap = (method) => (event, details = {}) => parent[method](event, {
    ...normalizeDetails(details),
    context: { ...baseContext, ...(normalizeDetails(details).context || {}) },
  });
  return {
    debug: wrap('debug'), info: wrap('info'), warn: wrap('warn'), error: wrap('error'), fatal: wrap('fatal'),
    child: (context = {}) => childLogger(parent, { ...baseContext, ...sanitizeLogMetadata(context, { env: state.env }) }),
  };
}

function normalizeDetails(details) {
  if (!details) return {};
  if (details instanceof Error) return { error: details, message: details.message || String(details) };
  if (typeof details === 'string') return { message: details };
  return typeof details === 'object' ? details : { message: String(details) };
}

function rememberWriteError(error) {
  const message = redactDiagnosticText(error?.message || String(error), { maxLength: 1_000, env: state.env });
  state.lastError = message;
  if (state.fallbackError === message) return;
  state.fallbackError = message;
  try { process.stderr.write(`[janus-logging] ${message}\n`); } catch {}
}

function managedFiles(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  const files = [];
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'crashes') continue;
      let nestedEntries = [];
      try { nestedEntries = fs.readdirSync(target, { withFileTypes: true }); } catch { nestedEntries = []; }
      for (const nested of nestedEntries) {
        if (!nested.isFile()) continue;
        const nestedPath = path.join(target, nested.name);
        const stat = safeStat(nestedPath);
        if (stat) files.push({ path: nestedPath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      continue;
    }
    if (!entry.isFile() || !/^janus(?:-|\.)/.test(entry.name) || !entry.name.endsWith('.log')) continue;
    const stat = safeStat(target);
    if (stat) files.push({ path: target, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function normalizeLevel(value) {
  const level = String(value || '').trim().toLowerCase();
  return Object.hasOwn(LEVELS, level) ? level : 'info';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cleanName(value, fallback) {
  const clean = String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120);
  return clean || fallback;
}

function utcDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function compactUtcTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace('.', '');
}

function nextRotatedPath() {
  let candidate = '';
  do {
    candidate = path.join(state.directory, `janus-${compactUtcTimestamp(state.now())}-${++state.rotationSequence}.log`);
  } while (fs.existsSync(candidate));
  return candidate;
}
