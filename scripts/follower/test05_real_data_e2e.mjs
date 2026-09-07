import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRuntime } from '../../src/main/runtime.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';
import { FollowerContextBroker } from '../../src/main/modules/follower/infrastructure/context/FollowerContextBroker.js';
import { followerWindow } from '../../src/main/modules/follower/domain/timeWindow.js';
import { FOLLOWER_RELEASE_BASELINE_VERSION } from '../../src/shared/follower/cloudContracts.js';

const serverUrl = process.env.JANUS_FOLLOWER_E2E_SERVER_URL || 'http://127.0.0.1:8788';
const codexHome = process.env.JANUS_E2E_CODEX_HOME || path.join(os.homedir(), '.codex');
const remoteUserId = postgresScalar("SELECT id FROM users WHERE username='test05'");
if (!remoteUserId) throw new Error('test05 cloud account was not found.');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-follower-test05-'));
const suffix = crypto.randomUUID().replaceAll('-', '');
const deviceId = `device_follower_test05_${suffix}`;
const grantId = `grant_follower_test05_${suffix}`;
const grantToken = `dgr_${crypto.randomBytes(32).toString('base64url')}`;
const tokenHash = crypto.createHash('sha256').update(grantToken).digest('hex');
const before = cloudInventory();
let runtime = null;
let service = null;

try {
  await mkdir(path.join(tempRoot, 'config', 'codex'), { recursive: true });
  await copyFile(path.join(codexHome, 'config.toml'), path.join(tempRoot, 'config', 'codex', 'config.toml'));
  await copyFile(path.join(codexHome, 'auth.json'), path.join(tempRoot, 'config', 'codex', 'auth.json'));
  createTemporaryGrant();

  process.env.JANUS_CODEX_BIN = process.env.JANUS_E2E_CODEX_BIN || '/usr/bin/codex';
  process.env.JANUS_MODEL_REFRESH_ENABLED = '0';
  runtime = await createRuntime({ root: tempRoot, isDev: true, appVersion: FOLLOWER_RELEASE_BASELINE_VERSION });
  const localUser = runtime.currentUser();
  assert.ok(localUser?.id, 'temporary local user is missing');
  runtime.db.prepare(`UPDATE auth_users SET remote_id=?,remote_bound_at=?,auth_provider='cloud',email_verified=1,updated_at=? WHERE id=?`)
    .run(remoteUserId, new Date().toISOString(), new Date().toISOString(), localUser.id);
  runtime.store.settingSet('database:fresh_recovery_state', JSON.stringify({
    mode: 'fresh_database_recovery', quarantineId: `test05_read_only_${suffix}`,
    cloudPullCompleted: false, localAuditCompleted: true, bidirectionalSyncEnabled: false,
  }));
  runtime.cloudSync.saveConfig({ serverUrl, userId: remoteUserId, deviceId, autoSync: false });
  runtime.db.prepare(`UPDATE cloud_sync_state SET device_grant=?,evolution_grant=?,sync_schema_version=6,updated_at=? WHERE id='default'`)
    .run(grantToken, grantToken, new Date().toISOString());

  const sync = await runtime.cloudSync.syncNow({ reason: 'test05_follower_read_only_pull' });
  assert.equal(sync.sourceBatchStatus, 'pull_only', `test05 sync was not pull-only: ${JSON.stringify(sync)}`);
  assert.equal(runtime.cloudSync.freshDatabaseRecoveryState().cloudPullCompleted, true, 'test05 pull-only reconciliation did not complete');
  runtime.cloudSync.close();

  const sessions = runtime.db.prepare(`SELECT id,agent_id,department_id,title,created_at,updated_at FROM sessions
    WHERE user_id=? AND account_workspace_id='workspace_personal' AND status<>'deleted' ORDER BY updated_at DESC`).all(localUser.id);
  const messages = runtime.db.prepare(`SELECT m.id,m.role,m.created_at,s.agent_id,s.title FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.user_id=? AND s.account_workspace_id='workspace_personal' AND s.status<>'deleted' AND m.visible=1
    ORDER BY m.created_at,m.id`).all(localUser.id);
  assert.ok(sessions.some((item) => item.agent_id === 'general_agent'), 'test05 Generalist session was not pulled');
  assert.ok(messages.length > 0, 'test05 messages were not pulled');

  const broker = new FollowerContextBroker({ store: runtime.store });
  const currentWindow = followerWindow('daily_brief', { timezone: 'Asia/Shanghai' });
  const window = { ...currentWindow, startAt: new Date(Date.parse(currentWindow.endAt) - 24 * 60 * 60 * 1000).toISOString() };
  const collected = broker.collect({ ownerUserId: localUser.id, workspaceId: 'workspace_personal', window,
    grants: { agent_conversations: true }, runId: `test05_probe_${suffix}`, authorizationEpoch: 1,
    currentAuthorizationEpoch: () => 1 });
  const conversationSources = collected.sources.filter((item) => item.sourceKind === 'agent_message');
  assert.ok(conversationSources.length > 0, `test05 has no Agent conversation sources in ${JSON.stringify(window)}`);

  service = new FollowerService({
    root: tempRoot, store: runtime.store, auth: runtime.auth, org: runtime.org,
    contextBroker: broker, modelCatalog: runtime.modelCatalog, deviceId: () => deviceId,
  });
  service.updateAccess({ disclosureConfirmed: true, grants: {
    agent_conversations: true, task_activity: false, project_change_metadata: false,
    project_file_content: false, sync_sanitized_reports: false,
  } });
  const overview = service.overview();
  service.updatePreferences({ expectedRevision: overview.preferenceRevision, preferences: {
    ...overview.preferences, model: 'gpt-5.5', reasoningEffort: 'medium', language: 'zh-CN',
  } });
  runtime.db.prepare(`UPDATE follower_workspace_state SET report_sync_enabled=0,evolution_enabled=0,updated_at=?
    WHERE owner_user_id=? AND account_workspace_id='workspace_personal'`).run(new Date().toISOString(), localUser.id);
  runtime.db.prepare(`UPDATE follower_access_grants SET enabled=0,revoked_at=?,updated_at=?
    WHERE owner_user_id=? AND account_workspace_id='workspace_personal' AND category='sync_sanitized_reports'`)
    .run(new Date().toISOString(), new Date().toISOString(), localUser.id);
  const isolatedAccess = runtime.store.followerAccessSnapshot({ ownerUserId: localUser.id, workspaceId: 'workspace_personal' });
  assert.equal(isolatedAccess.reportSyncEnabled, false, 'test05 validation failed to disable report sync');

  const queued = service.runNow({ kind: 'daily_brief', clientRequestId: `test05_real_${suffix}`,
    timezone: 'Asia/Shanghai', window });
  const completed = await waitForRun(runtime.store, queued.id);
  const report = service.report({ reportId: completed.reportId });
  const run = service.runs({ limit: 20 }).find((item) => item.id === queued.id);
  assert.ok(report.report.claims.length > 0, 'test05 real report contains no claims');
  assert.ok(report.sources.length > 0, 'test05 real report contains no sources');
  assert.ok(run?.processEvents?.length > 0, 'test05 real Codex process events were not retained');
  const followup = await service.openFollowup({ reportId: completed.reportId });
  const firstFollowupPromise = service.sendFollowup({ threadId: followup.id,
    content: '请只根据这份报告，用一句话说明目前最值得关注的事项。' });
  const steeredFollowupPromise = service.sendFollowup({ threadId: followup.id,
    content: '追加引导：请把最终回答聚焦为下一步应核对什么，并保持一句话。' });
  const [firstFollowup, steeredFollowup] = await Promise.all([firstFollowupPromise, steeredFollowupPromise]);
  assert.deepEqual(steeredFollowup.messages.map((message) => message.role), ['user', 'user', 'assistant']);
  assert.ok(firstFollowup.messages.at(-1)?.content, 'test05 first real Codex follow-up answer is empty');
  assert.ok(steeredFollowup.messages.at(-1)?.content, 'test05 steered real Codex follow-up answer is empty');
  const followupExecutions = runtime.db.prepare(`SELECT id,status,metadata_json FROM model_executions
    WHERE execution_kind='follower_followup' ORDER BY started_at,id`).all();
  assert.equal(followupExecutions.length, 1, 'test05 steering created a second model execution');
  assert.equal(followupExecutions.every((item) => item.status === 'completed'), true, 'test05 follow-up execution did not complete');
  const steerMessageIds = JSON.parse(followupExecutions[0].metadata_json || '{}').steerMessageIds || [];
  assert.deepEqual(steerMessageIds, [steeredFollowup.messages[1].id], 'test05 execution did not retain the guided user message ID');
  assert.equal(runtime.db.prepare("SELECT count(*) count FROM follower_sync_outbox").get().count, 0,
    'test05 read-only validation unexpectedly queued a report upload');

  const after = cloudInventory();
  assert.deepEqual(after, before, 'test05 cloud conversations, messages, or Follower reports changed during validation');
  console.log(JSON.stringify({
    ok: true,
    account: 'test05',
    mode: 'real_cloud_data_real_codex_read_only',
    sync: { status: sync.status, sourceBatchStatus: sync.sourceBatchStatus,
      remoteChangeCount: sync.remoteChangeCount, snapshotEntityCount: sync.snapshotEntityCount },
    localReplica: { sessionCount: sessions.length, messageCount: messages.length,
      generalistSessionCount: sessions.filter((item) => item.agent_id === 'general_agent').length,
      conversationSourceCount: conversationSources.length },
    report: { summary: report.report.summary, claimCount: report.report.claims.length,
      sourceCount: report.sources.length, processEventCount: run.processEvents.length,
      claims: report.report.claims.map((item) => ({ status: item.status, text: item.text })) },
    followup: { messageCount: steeredFollowup.messages.length, executionCount: followupExecutions.length,
      executionStatuses: followupExecutions.map((item) => item.status), steerMessageCount: steerMessageIds.length },
    cloudPreserved: after,
  }, null, 2));
} finally {
  service?.close();
  runtime?.close();
  cleanupTemporaryGrant();
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForRun(store, runId, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let run = store.getFollowerRun(runId);
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled_authorization_changed', 'cancelled_user_changed'].includes(run?.status)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    run = store.getFollowerRun(runId);
  }
  assert.equal(run?.status, 'completed', run?.errorText || run?.errorCode || 'test05 Follower run did not complete');
  return run;
}

function cloudInventory() {
  return JSON.parse(postgresScalar(`WITH target AS (SELECT '${sql(remoteUserId)}'::text AS user_id)
    SELECT json_build_object(
      'conversationCount',(SELECT count(*) FROM cloud_conversations_v6 c,target WHERE c.user_id=target.user_id),
      'conversationHash',(SELECT md5(COALESCE(string_agg(c.id||':'||c.revision||':'||c.payload_json::text,'|' ORDER BY c.id),'')) FROM cloud_conversations_v6 c,target WHERE c.user_id=target.user_id),
      'messageCount',(SELECT count(*) FROM cloud_messages_v6 m,target WHERE m.user_id=target.user_id),
      'messageHash',(SELECT md5(COALESCE(string_agg(m.id||':'||m.revision||':'||m.payload_json::text,'|' ORDER BY m.id),'')) FROM cloud_messages_v6 m,target WHERE m.user_id=target.user_id),
      'followerReportCount',(SELECT count(*) FROM cloud_follower_raw_reports r,target WHERE r.owner_user_id=target.user_id)
    )::text`));
}

function createTemporaryGrant() {
  postgres(`INSERT INTO cloud_devices_v6(user_id,device_id,display_name,status,approved_by_device_id,approved_at,metadata_json)
    VALUES('${sql(remoteUserId)}','${deviceId}','Follower test05 read-only validation','approved','test05_validation',now(),
      '{"purpose":"follower-test05-real-data-read-only"}'::jsonb);
    INSERT INTO cloud_sync_grants(id,user_id,device_id,token_hash,scopes_json,status,expires_at,grant_version,issued_at)
    VALUES('${grantId}','${sql(remoteUserId)}','${deviceId}','${tokenHash}',
      '["sync:read","sync:write","sync:files","sync:keys","devices:approve","evolution:read","evolution:write","employees:read","employees:write"]'::jsonb,
      'active',now()+interval '1 hour',6,now());`);
}

function cleanupTemporaryGrant() {
  try { postgres(`DELETE FROM cloud_sync_grants WHERE id='${grantId}'; DELETE FROM cloud_devices_v6 WHERE user_id='${sql(remoteUserId)}' AND device_id='${deviceId}';`); } catch {}
}

function postgresScalar(query) {
  return postgres(`SELECT (${query});`, ['-At']).trim();
}

function postgres(input, extraArgs = []) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'janus', ...extraArgs], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sql(value) {
  return String(value || '').replaceAll("'", "''");
}
