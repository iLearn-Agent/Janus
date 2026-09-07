import fs from 'node:fs';
import path from 'node:path';
import {
  diagnosticError,
  isSensitiveDiagnosticKey,
  newDiagnosticId,
  redactDiagnosticText,
  redactDiagnosticValue,
} from './logging/redaction.js';

export { diagnosticError, newDiagnosticId, redactDiagnosticText, redactDiagnosticValue };

export function diagnosticsEnabled(env = process.env) {
  return String(env.JANUS_TEST_DIAGNOSTICS || '').trim() === '1';
}

export function diagnosticContext(env = process.env) {
  return {
    runId: cleanIdentifier(env.JANUS_TEST_RUN_ID),
    caseId: cleanIdentifier(env.JANUS_TEST_CASE_ID),
  };
}

export function appendDiagnosticEvent(filePath, event, { source = 'application', env = process.env } = {}) {
  if (!filePath) return false;
  const context = diagnosticContext(env);
  const payload = redactDiagnosticValue({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    level: event?.level || 'info',
    source: event?.source || source,
    runId: event?.runId || context.runId,
    caseId: event?.caseId || context.caseId,
    stepId: event?.stepId || '',
    event: event?.event || 'diagnostic',
    message: event?.message || '',
    durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : undefined,
    data: event?.data || undefined,
    error: event?.error ? diagnosticError(event.error, { env }) : undefined,
  }, { env });
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function testDiagnosticFile(name = 'application-events.jsonl', env = process.env) {
  if (!diagnosticsEnabled(env)) return '';
  const root = String(env.JANUS_TEST_ARTIFACT_DIR || '').trim();
  return root ? path.join(root, sanitizeFilename(name)) : '';
}

export function cleanDiagnosticHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (isSensitiveDiagnosticKey(key)) continue;
    if (['content-type', 'content-length', 'user-agent', 'x-request-id', 'x-janus-test-run-id', 'x-janus-test-case-id'].includes(key.toLowerCase())) {
      result[key.toLowerCase()] = redactDiagnosticText(value);
    }
  }
  return result;
}

function cleanIdentifier(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 160);
}

function sanitizeFilename(value) {
  return String(value || 'diagnostics.jsonl').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}
