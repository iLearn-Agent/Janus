import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  appendDiagnosticEvent,
  diagnosticError,
  redactDiagnosticText,
  redactDiagnosticValue,
} from '../../src/shared/diagnostics.js';

export { diagnosticError, redactDiagnosticText, redactDiagnosticValue };

export function createTestDiagnostics({ runId, caseId, artifactDir, source = 'test', eventsFileName = 'events.jsonl' } = {}) {
  if (!artifactDir) throw new Error('createTestDiagnostics requires artifactDir');
  fs.mkdirSync(artifactDir, { recursive: true });
  const safeEventsFileName = String(eventsFileName || 'events.jsonl').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  const eventsPath = path.join(artifactDir, safeEventsFileName || 'events.jsonl');
  let stepSequence = 0;

  const event = (name, details = {}) => {
    appendDiagnosticEvent(eventsPath, {
      ...details,
      runId,
      caseId,
      source: details.source || source,
      event: name,
    });
  };

  const step = async (name, operation, data = undefined) => {
    const stepId = `${caseId || 'case'}:${++stepSequence}`;
    const started = Date.now();
    event('step_start', { stepId, message: name, data });
    try {
      const result = await operation();
      event('step_end', { stepId, message: name, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      event('step_failed', { stepId, level: 'error', message: name, durationMs: Date.now() - started, error });
      throw error;
    }
  };

  const attach = async (sourcePath, { name = path.basename(sourcePath), kind = 'file' } = {}) => {
    const targetDir = path.join(artifactDir, 'artifacts');
    await fsp.mkdir(targetDir, { recursive: true });
    const safeName = String(name || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
    const targetPath = path.join(targetDir, safeName);
    await fsp.cp(sourcePath, targetPath, { recursive: true, force: true });
    event('attachment', { message: safeName, data: { kind, path: path.relative(artifactDir, targetPath) } });
    return targetPath;
  };

  return { event, step, attach, eventsPath };
}

export function installTestFailureHandlers(diagnostics) {
  const onUnhandledRejection = (error) => diagnostics?.event?.('unhandled_rejection', { level: 'error', error: error instanceof Error ? error : new Error(String(error)) });
  const onUncaughtException = (error) => diagnostics?.event?.('uncaught_exception', { level: 'error', error });
  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtExceptionMonitor', onUncaughtException);
  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtExceptionMonitor', onUncaughtException);
  };
}
