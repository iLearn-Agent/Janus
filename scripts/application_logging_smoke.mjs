import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applicationLoggingStatus,
  clearRotatedApplicationLogs,
  closeApplicationLogging,
  exportApplicationLogs,
  flushApplicationLogs,
  getApplicationLogger,
  initializeApplicationLogging,
} from '../src/shared/logging/index.js';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-application-logging-'));
const logDir = path.join(root, 'logs');
const exportPath = path.join(root, 'downloads', 'Janus-Diagnostics-test.log');
let now = new Date('2026-07-29T01:00:00.000Z');

try {
  await fsp.mkdir(logDir, { recursive: true });
  const expiredLog = path.join(logDir, 'janus-20260701T000000Z-1.log');
  await fsp.writeFile(expiredLog, '{}\n', 'utf8');
  const expiredAt = new Date('2026-07-01T00:00:00.000Z');
  await fsp.utimes(expiredLog, expiredAt, expiredAt);
  initializeApplicationLogging({
    directory: logDir,
    appVersion: '0.2.7-test',
    releaseChannel: 'test',
    processType: 'logging-smoke',
    level: 'info',
    maxFileBytes: 1_400,
    maxTotalBytes: 8_000,
    retentionDays: 14,
    env: {
      ...process.env,
      HOME: root,
      TMPDIR: path.join(root, 'tmp'),
    },
    now: () => new Date(now),
  });

  const logger = getApplicationLogger('logging-smoke').child({ requestId: 'req_logging_smoke' });
  logger.debug('debug_filtered', { data: { detail: 'must not reach the production file' } });
  logger.info('startup_complete', {
    message: 'Application started for alice@example.com password=hunter2',
    data: {
      prompt: 'private prompt fixture',
      answer: 'private model answer fixture',
      fileContent: 'private file fixture',
      accessToken: 'local-access-secret',
      homePath: path.join(root, 'private', 'document.txt'),
      model: 'gpt-test',
    },
  });
  logger.warn('slow_ipc', { durationMs: 2_500, context: { ipcChannel: 'logging:status' } });
  logger.error('codex_failed', {
    error: Object.assign(new Error('Codex failed apiKey=sk-example-secret-123456789'), { code: 'codex_failed' }),
    data: { stderr: 'raw stderr fixture', exitCode: 1 },
  });
  await flushApplicationLogs();
  assert.equal(fs.existsSync(expiredLog), false, 'retention pruning must delete expired rotated logs');

  const activePath = path.join(logDir, 'janus.log');
  assert.equal(fs.existsSync(activePath), true, 'active production log must be created');
  const initialText = readManagedLogs(logDir);
  const initialEvents = parseJsonLines(initialText);
  assert.equal(initialEvents.some((event) => event.event === 'debug_filtered'), false, 'production level filtering must apply');
  assert.ok(initialEvents.some((event) => event.event === 'startup_complete'));
  assert.ok(initialEvents.some((event) => event.context?.requestId === 'req_logging_smoke'));
  assert.ok(initialEvents.every((event) => event.schemaVersion === 1 && event.timestamp && event.source && event.level));
  for (const secret of [
    'alice@example.com', 'hunter2', 'private prompt fixture', 'private model answer fixture',
    'private file fixture', 'local-access-secret', 'sk-example-secret-123456789', 'raw stderr fixture', root,
  ]) {
    assert.equal(initialText.includes(secret), false, `production logging leaked ${secret}`);
  }
  assert.match(initialText, /a\*\*\*@example\.com/);
  assert.match(initialText, /\$HOME/);

  for (let index = 0; index < 12; index += 1) {
    logger.info('rotation_fixture', { data: { index, detail: `rotation-${index}-${'x'.repeat(300)}` } });
  }
  await flushApplicationLogs();
  const rotatedBeforeDate = managedLogNames(logDir).filter((name) => name !== 'janus.log');
  assert.ok(rotatedBeforeDate.length > 0, 'size rotation must create rotated .log files');

  now = new Date('2026-07-30T01:00:00.000Z');
  logger.info('next_day_fixture');
  await flushApplicationLogs();
  const nextDayActiveEvents = parseJsonLines(await fsp.readFile(activePath, 'utf8'));
  assert.deepEqual(nextDayActiveEvents.map((event) => event.event), ['next_day_fixture'], 'UTC day rotation must start a fresh active file');
  assert.ok(applicationLoggingStatus().totalBytes <= 8_000, 'capacity pruning must enforce the configured cap');

  const exported = await exportApplicationLogs({ destination: exportPath, manifest: { smoke: true } });
  assert.equal(exported.path, exportPath);
  const exportedText = await fsp.readFile(exportPath, 'utf8');
  const exportedEvents = parseJsonLines(exportedText);
  assert.equal(exportedEvents[0].event, 'diagnostic_export_manifest');
  assert.equal(exportedEvents[0].data.smoke, true);
  assert.ok(exportedEvents.some((event) => event.event === 'next_day_fixture'));
  assert.equal(exportedText.includes('private prompt fixture'), false);

  const cleared = await clearRotatedApplicationLogs();
  await flushApplicationLogs();
  assert.ok(cleared.removed > 0, 'clearing logs must remove rotated files');
  assert.deepEqual(managedLogNames(logDir), ['janus.log']);
  assert.ok(parseJsonLines(await fsp.readFile(activePath, 'utf8')).some((event) => event.event === 'logs_cleared'));

  await closeApplicationLogging();

  const failureRoot = path.join(root, 'write-failure');
  initializeApplicationLogging({ directory: failureRoot, level: 'info', now: () => new Date(now) });
  await fsp.rm(failureRoot, { recursive: true, force: true });
  await fsp.writeFile(failureRoot, 'not a directory', 'utf8');
  getApplicationLogger('logging-smoke').error('write_failure_fixture', { error: new Error('expected write failure') });
  await flushApplicationLogs();
  assert.ok(applicationLoggingStatus().lastError, 'write failures must be reported through logger status');
  await closeApplicationLogging();

  process.stdout.write('application logging smoke passed\n');
} finally {
  await closeApplicationLogging().catch(() => {});
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function managedLogNames(directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.log')).sort();
}

function readManagedLogs(directory) {
  return managedLogNames(directory).map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
}

function parseJsonLines(text) {
  return String(text || '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
