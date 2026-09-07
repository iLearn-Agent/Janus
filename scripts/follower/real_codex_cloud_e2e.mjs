import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRuntime } from '../../src/main/runtime.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';
import { FollowerCloudService } from '../../src/main/modules/follower/application/FollowerCloudService.js';
import { FollowerContextBroker } from '../../src/main/modules/follower/infrastructure/context/FollowerContextBroker.js';
import {
  FOLLOWER_CLOUD_CAPABILITIES,
  FOLLOWER_RELEASE_BASELINE_VERSION,
  createFollowerCloudClientContract,
} from '../../src/shared/follower/cloudContracts.js';

const serverUrl = process.env.JANUS_FOLLOWER_E2E_SERVER_URL || 'http://127.0.0.1:8788';
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-follower-real-cloud-'));
const suffix = crypto.randomUUID().replaceAll('-', '');
const remoteUserId = `user_follower_e2e_${suffix}`;
const deviceId = `device_follower_e2e_${suffix}`;
const grantId = `grant_follower_e2e_${suffix}`;
const grantToken = `dgr_${crypto.randomBytes(32).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(grantToken).digest('hex');
let runtime = null;
let service = null;
let reportId = '';

try {
  await mkdir(path.join(tempRoot, 'config', 'codex'), { recursive: true });
  await copyFile(path.join(codexHome, 'config.toml'), path.join(tempRoot, 'config', 'codex', 'config.toml'));
  await copyFile(path.join(codexHome, 'auth.json'), path.join(tempRoot, 'config', 'codex', 'auth.json'));
  createCloudFixture();

  process.env.JANUS_CODEX_BIN = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  runtime = await createRuntime({ root: tempRoot, isDev: true, appVersion: FOLLOWER_RELEASE_BASELINE_VERSION });
  const user = runtime.currentUser();
  assert.ok(user?.id, 'local authenticated user is missing');
  runtime.cloudSync.saveConfig({ serverUrl, userId: remoteUserId, deviceId, autoSync: false });
  runtime.db.prepare(`UPDATE cloud_sync_state SET device_grant=?,evolution_grant=?,sync_schema_version=6,updated_at=? WHERE id='default'`)
    .run(grantToken, grantToken, new Date().toISOString());

  const contract = createFollowerCloudClientContract({
    appVersion: FOLLOWER_RELEASE_BASELINE_VERSION,
    capabilities: FOLLOWER_CLOUD_CAPABILITIES,
  });
  const capabilities = await runtime.cloudSync.followerCapabilities(contract);
  assert.equal(capabilities.enabled, true);
  assert.ok(capabilities.capabilities.includes('follower-followup-sync-v1'));
  assert.equal(capabilities.clientCompatibility.compatible, true);

  const cloudService = new FollowerCloudService({
    root: tempRoot,
    store: runtime.store,
    cloudSync: runtime.cloudSync,
    appVersion: FOLLOWER_RELEASE_BASELINE_VERSION,
    deviceId: () => deviceId,
  });
  service = new FollowerService({
    root: tempRoot,
    store: runtime.store,
    auth: runtime.auth,
    org: runtime.org,
    cloudService,
    contextBroker: new FollowerContextBroker({ store: runtime.store }),
    modelCatalog: runtime.modelCatalog,
    deviceId: () => deviceId,
  });

  service.updateAccess({
    disclosureConfirmed: true,
    grants: {
      agent_conversations: true,
      task_activity: false,
      project_change_metadata: false,
      project_file_content: false,
      sync_sanitized_reports: true,
    },
  });
  const access = service.overview();
  service.updatePreferences({
    expectedRevision: access.preferenceRevision,
    preferences: {
      ...access.preferences,
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
    },
  });
  const conversation = runtime.store.createSession({
    title: 'Generalist A 工作讨论', departmentId: 'general', agentId: 'general_agent',
    userId: user.id, accountWorkspaceId: 'workspace_personal', reusePrimary: false,
  });
  runtime.store.addMessage({ sessionId: conversation.id, role: 'user', agentId: 'general_agent', departmentId: 'general',
    content: '请继续推进 Follower 云端追问同步，并检查数据库迁移和重复投递的幂等性。' });
  runtime.store.addMessage({ sessionId: conversation.id, role: 'assistant', agentId: 'general_agent', departmentId: 'general',
    content: '正在验证 Follower 云端追问同步、数据库迁移以及重复投递不会产生重复消息。' });

  const now = new Date();
  const queued = service.runNow({
    kind: 'daily_brief',
    clientRequestId: `follower_real_codex_${suffix}`,
    timezone: 'Asia/Shanghai',
    window: {
      startAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
      endAt: new Date(now.getTime() + 1_000).toISOString(),
    },
  });
  const completedRun = await waitForRun(runtime.store, queued.id);
  assert.equal(completedRun.status, 'completed', completedRun.errorText || completedRun.errorCode);
  reportId = completedRun.reportId;
  const report = service.report({ reportId });
  assert.ok(report.report.claims.length > 0, 'real report contains no evidence-backed claims');
  assert.doesNotMatch(report.report.summary, /No reportable Janus activity/i);
  const runProjection = service.runs({ limit: 10 }).find((item) => item.id === queued.id);
  assert.ok(runProjection.processEvents.length > 0, 'real Codex process events were not retained for the running report record');

  runtime.db.prepare(`UPDATE cloud_sync_state SET device_grant=?,evolution_grant=?,sync_schema_version=6,updated_at=? WHERE id='default'`)
    .run(grantToken, grantToken, new Date().toISOString());
  const reportSync = await cloudService.syncReports({ ownerUserId: user.id, workspaceId: 'workspace_personal' });
  assert.ok([0, 1].includes(reportSync.uploaded), `unexpected report upload result: ${JSON.stringify(reportSync)}`);
  assert.equal(cloudScalar(`SELECT count(*) FROM cloud_follower_raw_reports
    WHERE owner_user_id='${remoteUserId}' AND report_id='${sql(reportId)}'`), 1,
  'cloud must contain exactly one raw report whether it was uploaded automatically or by the explicit sync');
  const feedback = await service.recordFeedback({ reportId, rating: 'helpful' });
  assert.ok(['accepted', 'duplicate'].includes(feedback.upload.status),
    `Follower feedback was not uploaded as evolution evidence: ${JSON.stringify(feedback.upload)}`);
  const cloudFeedbackRows = cloudScalar(`SELECT count(*) FROM cloud_follower_preference_signals
    WHERE owner_user_id='${remoteUserId}' AND account_workspace_id='workspace_personal'
      AND source_kind='follower_report_feedback' AND source_id='${sql(reportId)}'
      AND signal_kind='report_feedback' AND normalized_json->>'rating'='helpful'`);
  assert.equal(cloudFeedbackRows, 1, 'cloud did not persist exactly one helpful Follower report feedback evidence row');

  const opened = await service.openFollowup({ reportId });
  const answered = await service.sendFollowup({
    threadId: opened.id,
    content: '这份简报中正在推进的工作是什么？请只根据简报简要回答。',
  });
  assert.deepEqual(answered.messages.map((message) => message.role), ['user', 'assistant']);
  const assistantAnswer = answered.messages.at(-1)?.content || '';
  assert.ok(assistantAnswer.trim(), 'real Codex follow-up answer is empty');
  assert.doesNotMatch(assistantAnswer, /无法根据简报|no such column|\berror\b/i);
  assert.match(assistantAnswer, /同步|迁移/);

  runtime.db.prepare(`UPDATE cloud_sync_state SET device_grant=?,evolution_grant=?,sync_schema_version=6,updated_at=? WHERE id='default'`)
    .run(grantToken, grantToken, new Date().toISOString());
  const firstFollowupSync = await cloudService.syncFollowup({ ownerUserId: user.id, workspaceId: 'workspace_personal' }, answered);
  assert.equal(firstFollowupSync.results.length, 2);
  assert.equal(firstFollowupSync.results.every((item) => ['accepted', 'duplicate'].includes(item.status)), true);
  const cloudCount = cloudScalar(`SELECT count(*) FROM cloud_follower_followup_messages WHERE owner_user_id='${remoteUserId}' AND report_id='${sql(reportId)}'`);
  assert.equal(cloudCount, 2, 'cloud did not persist exactly one user/assistant pair');
  const duplicate = await cloudService.syncFollowup({ ownerUserId: user.id, workspaceId: 'workspace_personal' }, answered);
  assert.equal(duplicate.results.length, 2);
  assert.equal(duplicate.results.every((item) => item.status === 'duplicate'), true);
  assert.equal(cloudScalar(`SELECT count(*) FROM cloud_follower_followup_messages WHERE owner_user_id='${remoteUserId}' AND report_id='${sql(reportId)}'`), 2);

  const reopened = await service.openFollowup({ reportId });
  assert.equal(reopened.messages.length, 2, 'pull-on-open introduced duplicate local messages');
  assert.deepEqual(reopened.messages.map((message) => message.id), answered.messages.map((message) => message.id));

  const executionRows = runtime.db.prepare(`SELECT execution_kind,status,codex_thread_id,error_text FROM model_executions
    WHERE execution_kind IN ('follower_report','follower_followup') ORDER BY started_at`).all();
  assert.equal(executionRows.length, 2);
  assert.equal(executionRows.every((row) => row.status === 'completed' && row.codex_thread_id), true);
  const cloudRows = cloudScalar(`SELECT count(*) FROM cloud_follower_followup_messages WHERE owner_user_id='${remoteUserId}'`);
  const cloudReportRows = cloudScalar(`SELECT count(*) FROM cloud_follower_raw_reports WHERE owner_user_id='${remoteUserId}' AND report_id='${sql(reportId)}'`);
  assert.equal(cloudReportRows, 1);

  console.log(JSON.stringify({
    ok: true,
    mode: 'real_codex_production_cloud',
    capability: 'follower-followup-sync-v1',
    report: {
      id: reportId,
      summary: report.report.summary,
      claimCount: report.report.claims.length,
      sourceCount: report.sources.length,
      cloudRawReportRows: cloudReportRows,
    },
    followup: {
      question: answered.messages[0].content,
      answer: assistantAnswer,
      localMessageCount: reopened.messages.length,
      cloudMessageCount: cloudRows,
      firstSyncStatuses: firstFollowupSync.results.map((item) => item.status),
      duplicateStatuses: duplicate.results.map((item) => item.status),
    },
    feedback: { rating: 'helpful', uploadStatus: feedback.upload.status, cloudEvidenceRows: cloudFeedbackRows },
    executions: executionRows.map((row) => ({ kind: row.execution_kind, status: row.status, threadIdPresent: Boolean(row.codex_thread_id) })),
  }, null, 2));
} finally {
  service?.close();
  runtime?.close();
  cleanupCloudFixture();
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForRun(store, runId, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let run = store.getFollowerRun(runId);
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled_authorization_changed', 'cancelled_user_changed'].includes(run?.status)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    run = store.getFollowerRun(runId);
  }
  if (!run || run.status !== 'completed') throw new Error(`Follower run did not complete: ${JSON.stringify(run)}`);
  return run;
}

function createCloudFixture() {
  const statements = `
    INSERT INTO users(id,email,display_name,username,avatar_url,email_verified,role,password_hash)
    VALUES('${remoteUserId}','${remoteUserId}@example.invalid','Follower E2E','${remoteUserId}','','true','member','e2e-not-login-capable');
    INSERT INTO cloud_devices_v6(user_id,device_id,display_name,status,approved_by_device_id,approved_at,metadata_json)
    VALUES('${remoteUserId}','${deviceId}','Follower real E2E','approved','e2e_fixture',now(),'{"purpose":"follower-real-codex-e2e"}'::jsonb);
    INSERT INTO cloud_sync_grants(id,user_id,device_id,token_hash,scopes_json,status,expires_at,grant_version,issued_at)
    VALUES('${grantId}','${remoteUserId}','${deviceId}','${tokenHash}',
      '["sync:read","sync:write","sync:files","sync:keys","devices:approve","evolution:read","evolution:write","employees:read","employees:write"]'::jsonb,
      'active',now()+interval '1 day',6,now());
  `;
  postgres(statements);
}

function cleanupCloudFixture() {
  try { postgres(`DELETE FROM users WHERE id='${remoteUserId}';`); } catch {}
}

function cloudScalar(query) {
  return Number(postgres(query, ['-At']).trim() || 0);
}

function postgres(input, extraArgs = []) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'janus', ...extraArgs], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sql(value) {
  return String(value || '').replaceAll("'", "''");
}
