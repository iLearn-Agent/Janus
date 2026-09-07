import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-real-retry-'));
const codexBin = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
const configuredCodexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(process.cwd(), 'workspace', 'config', 'codex');
const codexHome = existsSync(path.join(configuredCodexHome, 'config.toml'))
  ? configuredCodexHome
  : path.join(os.homedir(), '.codex');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousModelRefresh = process.env.JANUS_MODEL_REFRESH_ENABLED;
let runtime = null;

try {
  assert.ok(existsSync(codexBin), `Real Codex binary not found: ${codexBin}`);
  assert.ok(existsSync(path.join(codexHome, 'config.toml')), `Real Codex config not found: ${codexHome}`);
  assert.ok(existsSync(path.join(codexHome, 'auth.json')), `Real Codex auth not found: ${codexHome}`);
  const configTarget = path.join(root, 'config', 'codex');
  await mkdir(configTarget, { recursive: true });
  await copyFile(path.join(codexHome, 'config.toml'), path.join(configTarget, 'config.toml'));
  await copyFile(path.join(codexHome, 'auth.json'), path.join(configTarget, 'auth.json'));

  process.env.JANUS_CODEX_BIN = codexBin;
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  runtime = await createRuntime({ root, isDev: true });

  const requester = runtime.currentUser();
  const recipientRegistration = runtime.auth.registerWithEmail({
    email: 'ubuddy-real-retry-recipient@example.com',
    password: 'ubuddy-real-retry-password',
    displayName: 'Real Retry Recipient',
  });
  const recipient = recipientRegistration.user || recipientRegistration;
  runtime.store.provisionNewUserAgentDefaults({ userId: recipient.id });
  const [userA, userB] = [requester.id, recipient.id].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('ubuddy-real-retry-friendship',?,?, 'accepted')`).run(userA, userB);

  runtime.auth.setActiveUser(requester.id);
  const delegation = runtime.createAgentDelegation({
    recipientId: recipient.id,
    title: '真实 uBuddy 恢复验证',
    instruction: '请整理三条桌面端任务管理工具的核心能力，形成可编辑 Markdown 初稿；不要访问外部资料。',
  }).delegation;
  runtime.auth.setActiveUser(recipient.id);
  runtime.auth.updateAgentDelegation({ delegationId: delegation.id, status: 'accepted' });

  const first = await runtime.startAgentDelegation({
    delegationId: delegation.id,
    execute: true,
    reasoningEffort: 'low',
  });
  assert.equal(first.delegation.status, 'draft_ready');
  const firstTaskRunId = first.delegation.taskRunId;
  assert.ok(firstTaskRunId);
  assert.equal(runtime.store.getTaskRun(firstTaskRunId)?.status, 'completed');
  const modelExecutionsBeforeRecovery = Number(runtime.db.prepare(
    'SELECT COUNT(*) AS count FROM model_executions',
  ).get().count);
  const taskRunsBeforeRecovery = Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count);

  runtime.store.updateTaskRunMetadata(firstTaskRunId, {
    completionGate: 'delegation_delivery',
    deliveryValidationState: 'pending',
  });
  runtime.store.updateTaskRunStatus(firstTaskRunId, 'verifying', 'Agent nodes completed; validating the final delivery.');
  runtime.auth.updateAgentDelegation({
    delegationId: delegation.id,
    status: 'blocked',
    taskRunId: '',
    lastError: '旧的公开故障信息。',
    metadata: {
      ...(first.delegation.metadata || {}),
      activeTaskRunId: '',
      attemptTaskRunIds: [firstTaskRunId],
      executionState: 'failed',
      deliveryState: 'blocked',
      failureCode: 'not_found',
      failureStage: 'workspace_sync',
      retryable: true,
      publicFailure: {
        code: 'not_found',
        stage: 'workspace_sync',
        message: '旧的公开故障信息。',
        retryable: true,
        occurredAt: new Date().toISOString(),
      },
    },
  });

  const recovered = await runtime.startAgentDelegation({
    delegationId: delegation.id,
    execute: true,
    reasoningEffort: 'low',
  });
  assert.equal(recovered.delegation.status, 'draft_ready');
  assert.equal(recovered.delegation.taskRunId, firstTaskRunId);
  assert.equal(recovered.delegation.metadata.failureCode, '');
  assert.equal(recovered.delegation.metadata.publicFailure, null);
  assert.equal(runtime.store.getTaskRun(firstTaskRunId)?.status, 'completed');
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count), taskRunsBeforeRecovery);
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM model_executions').get().count), modelExecutionsBeforeRecovery);
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM work_scopes
    WHERE federation_type='delegation' AND federation_id=?`).get(delegation.id).count, 1);

  console.log(JSON.stringify({
    ok: true,
    codexMode: 'real',
    firstTaskStatus: 'completed',
    recoveredStatus: recovered.delegation.status,
    reusedTaskRun: true,
    extraModelExecutionsDuringRecovery: 0,
    federationScopeCount: 1,
  }));
} finally {
  runtime?.close();
  await rm(root, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousModelRefresh === undefined) delete process.env.JANUS_MODEL_REFRESH_ENABLED;
  else process.env.JANUS_MODEL_REFRESH_ENABLED = previousModelRefresh;
}
