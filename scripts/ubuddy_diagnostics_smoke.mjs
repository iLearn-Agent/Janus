import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createUBuddyFullChainDiagnostics } from './lib/ubuddyFullChainDiagnostics.mjs';
import { createUBuddyDiagnosticEmitter, createUBuddyDiagnosticReport, sanitizeUBuddyDiagnosticData } from '../src/main/modules/collaboration/infrastructure/ubuddyDiagnostics.js';

const artifactDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-diagnostics-'));
const env = {
  ...process.env,
  JANUS_TEST_DIAGNOSTICS: '1',
  JANUS_TEST_RUN_ID: 'ubuddy-diagnostic-smoke-run',
  JANUS_TEST_CASE_ID: 'ubuddy-diagnostic-smoke',
  JANUS_TEST_ARTIFACT_DIR: artifactDir,
};
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);

try {
  const diagnostics = createUBuddyFullChainDiagnostics({ mode: 'fake', env });
  diagnostics.beginScenario('environment_setup', { actorCount: 3 });
  diagnostics.checkpoint('accounts_ready', { userCount: 3 });
  diagnostics.finishScenario('passed', { friendshipCount: 2 });

  const emitRuntime = createUBuddyDiagnosticEmitter({ source: 'ubuddy-smoke', env });
  emitRuntime('delegation_task_bound', {
    data: {
      delegationId: 'delegation_fixture',
      taskRunId: 'task_fixture',
      status: 'running',
      content: 'PRIVATE_MESSAGE_MUST_NOT_APPEAR',
      taskWorkspaceRoot: '/home/private/workspace',
      username: '2840213075',
      token: 'sk-super-secret-token',
    },
  });

  await diagnostics.writeReport({
    status: 'passed',
    summary: {
      finalStatus: 'closed',
      checks: ['task_bound', 'attachment_roundtrip'],
      taskCount: 2,
      revisionCount: 3,
      fileTransfer: { submitted: 2, uploaded: 2, downloadVerified: true },
      snapshot: {
        totals: { localDelegations: 2, localTaskRuns: 2, modelExecutions: 4 },
        cloud: { collaborationFiles: { count: 2, bytes: 4096 } },
      },
      email: 'private@example.com',
      username: '2840213075',
      identifier: 'private-account',
      secret: 'sk-super-secret-token',
    },
  });
  diagnostics.close();

  for (const file of ['ubuddy-report.json', 'ubuddy-report.md', 'ubuddy-events.jsonl']) {
    assert.equal(fs.existsSync(path.join(artifactDir, file)), true, `${file} was not created`);
  }
  const combined = ['ubuddy-report.json', 'ubuddy-report.md', 'ubuddy-events.jsonl']
    .map((file) => fs.readFileSync(path.join(artifactDir, file), 'utf8'))
    .join('\n');
  assert.doesNotMatch(combined, /PRIVATE_MESSAGE_MUST_NOT_APPEAR|2840213075|private@example\.com|private-account|sk-super-secret-token|\/home\/private\/workspace/);
  assert.match(combined, /delegation_task_bound/);
  assert.match(combined, /attachment_roundtrip/);
  assert.match(combined, /closed/);

  assert.deepEqual(sanitizeUBuddyDiagnosticData({
    status: 'completed', content: 'private', nested: { path: '/tmp/private', count: 2 }, files: [{ filename: 'secret.md', size: 10 }],
  }), { status: 'completed', nested: { count: 2 }, files: [{ size: 10 }] });

  const diagnosticReport = createUBuddyDiagnosticReport({
    userId: 'local_admin',
    workspaceId: 'workspace_personal',
    store: {
      listTaskRuns: () => [{ id: 'task_report_fixture' }],
      getTaskRun: () => ({
        id: 'task_report_fixture', status: 'completed',
        nodes: [{ status: 'completed' }],
        events: [{ id: 'event_fixture', eventType: 'deliverable_contract_passed', status: 'completed' }],
        metadata: {
          deliverableContractVersion: 'deliverable_contract_v1', deliverableValidationMode: 'strict',
          deliveryValidationState: 'passed', resultState: 'accepted', deliverableResult: { files: [{ name: 'private.md' }] },
        },
      }),
      db: {
        prepare(sql) {
          return { all: () => sql.includes('FROM messages')
            ? [{ id: 'message_fixture', session_id: 'session_fixture', conversation_id: 'conversation_fixture', created_at: '2026-07-31T00:00:00.000Z', metadata_json: JSON.stringify({ uBuddyRoute: { mode: 'single_agent', source: 'explicit', reasonCode: 'agent_explicitly_requested', strategyVersion: 'ubuddy_route_v2' } }) }]
            : [] };
        },
      },
    },
  });
  assert.equal(diagnosticReport.taskLifecycle[0].status, 'completed');
  assert.equal(diagnosticReport.routeTransitions[0].strategyVersion, 'ubuddy_route_v2');
  assert.equal(diagnosticReport.deliverableValidation[0].resultState, 'accepted');
  assert.equal(JSON.stringify(diagnosticReport).includes('private.md'), false);

  const failureDir = path.join(artifactDir, 'failure-case');
  const failureEnv = { ...env, JANUS_TEST_ARTIFACT_DIR: failureDir };
  const failureDiagnostics = createUBuddyFullChainDiagnostics({ mode: 'fake', env: failureEnv });
  failureDiagnostics.beginScenario('attachment_roundtrip');
  const injectedFailure = Object.assign(new Error('injected upload failure'), { code: 'upload_failed' });
  await failureDiagnostics.writeReport({ status: 'failed', error: injectedFailure, summary: { finalStatus: 'submitted', checks: ['task_bound'] } });
  failureDiagnostics.close();
  const failedReport = JSON.parse(fs.readFileSync(path.join(failureDir, 'ubuddy-report.json'), 'utf8'));
  assert.equal(failedReport.status, 'failed');
  assert.equal(failedReport.scenarios.at(-1).status, 'failed');
  assert.equal(failedReport.failure.code, 'upload_failed');

  const disabledEmitter = createUBuddyDiagnosticEmitter({ source: 'disabled', env: { JANUS_TEST_DIAGNOSTICS: '0' } });
  assert.equal(disabledEmitter('must_not_write', { data: { status: 'ignored' } }), false);
  console.log('uBuddy diagnostics smoke passed');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fsp.rm(artifactDir, { recursive: true, force: true });
}
