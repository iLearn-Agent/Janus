import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { redactDiagnosticText, redactDiagnosticValue } from '../src/shared/diagnostics.js';
import { createTestDiagnostics } from './lib/testDiagnostics.mjs';
import { pruneTestRuns } from './lib/testRunStorage.mjs';
import { TEST_CASES, testCasesForSuite } from './testManifest.mjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-test-diagnostics-'));
try {
  const artifactDir = path.join(root, 'case');
  const diagnostics = createTestDiagnostics({ runId: 'diagnostic-smoke', caseId: 'redaction', artifactDir });
  diagnostics.event('secret_fixture', {
    message: 'alice@example.com password=hunter2 Authorization: Bearer sample-token-123',
    data: { accessToken: 'local-access-secret', inputTokens: 123, apiKey: 'sk-example-secret-123456789' },
  });
  const stored = fs.readFileSync(path.join(artifactDir, 'events.jsonl'), 'utf8');
  for (const secret of ['alice@example.com', 'hunter2', 'sample-token-123', 'local-access-secret', 'sk-example-secret-123456789']) {
    assert.equal(stored.includes(secret), false, `diagnostic output leaked ${secret}`);
  }
  assert.match(stored, /a\*\*\*@example\.com/);
  assert.equal(redactDiagnosticValue({ inputTokens: 123 }).inputTokens, 123);
  assert.equal(redactDiagnosticValue({ refreshToken: 'secret' }).refreshToken, '[REDACTED]');
  assert.equal(redactDiagnosticText('password=top-secret').includes('top-secret'), false);
  assert.equal(redactDiagnosticText('{"password":"json-secret"}').includes('json-secret'), false);
  assert.equal(redactDiagnosticText('<input type="password" value="html-secret">').includes('html-secret'), false);

  const ids = TEST_CASES.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, 'test case IDs must be unique');
  assert.ok(testCasesForSuite('check').length >= 36, 'main suite must include the existing checks and diagnostics smoke');
  assert.ok(testCasesForSuite('all').length > testCasesForSuite('check').length, 'all suite must add cloud coverage');

  const runs = path.join(root, 'runs');
  const oldSuccess = path.join(runs, 'old-success');
  const oldFailure = path.join(runs, 'old-failure');
  await fsp.mkdir(oldSuccess, { recursive: true });
  await fsp.mkdir(oldFailure, { recursive: true });
  await fsp.writeFile(path.join(oldSuccess, 'run.json'), JSON.stringify({ status: 'passed', endedAt: '2020-01-01T00:00:00.000Z' }));
  await fsp.writeFile(path.join(oldFailure, 'run.json'), JSON.stringify({ status: 'failed', endedAt: '2020-01-01T00:00:00.000Z' }));
  await pruneTestRuns(runs, { now: Date.parse('2026-07-28T00:00:00.000Z'), maxBytes: 1024 * 1024 });
  assert.equal(fs.existsSync(oldSuccess), false);
  assert.equal(fs.existsSync(oldFailure), false);

  if (process.env.JANUS_DIAGNOSTICS_SMOKE_FORCE_FAILURE === '1') {
    throw new Error('intentional diagnostics failure password=diagnostic-secret');
  }

  process.stdout.write('test diagnostics smoke passed\n');
} finally {
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
