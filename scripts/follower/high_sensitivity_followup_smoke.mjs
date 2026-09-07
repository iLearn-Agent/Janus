import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerContextBroker } from '../../src/main/modules/follower/infrastructure/context/FollowerContextBroker.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-sensitive-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO accounts(id,account_kind,owner_user_id,name,status) VALUES('account_personal_user_1','personal','user_1','User 1','active')").run();
  db.prepare("INSERT INTO conversation_account_bindings(conversation_id,account_id,binding_role,access_status) VALUES('direct_1','account_personal_user_1','participant','active')").run();
  const insertDirect = db.prepare(`INSERT INTO social_messages(id,account_workspace_id,conversation_id,sender_user_id,recipient_user_id,content,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  insertDirect.run('social_ok','workspace_personal','direct_1','user_2','user_1','visible direct message','{}',now,now);
  insertDirect.run('social_withdrawn','workspace_personal','direct_1','user_2','user_1','withdrawn secret','{"withdrawn":true}',now,now);
  db.prepare(`INSERT INTO chat_groups(id,account_workspace_id,owner_user_id,title,scope_type,chat_mode,binding_type,history_visibility,status,audience_scope,client_request_id)
    VALUES('group_1','workspace_personal','user_1','Safe Group','external','conversation','manual','from_join','active','account_social','group_request_1')`).run();
  db.prepare("INSERT INTO chat_group_members(group_id,user_id,role,status) VALUES('group_1','user_1','owner','active')").run();
  const insertGroup = db.prepare(`INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,content,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  insertGroup.run('group_ok','workspace_personal','group_1','user_2','visible group message','{}',now,now);
  insertGroup.run('group_withdrawn','workspace_personal','group_1','user_2','withdrawn group secret','{"withdrawn":true}',now,now);
  const store = new Store(db, { root });
  const broker = new FollowerContextBroker({ store, org: { agent: (agentId) => agentId === 'general_agent' ? { name: 'Generalist A' } : null } });
  const collected = broker.collect({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', runId: 'sensitive_run', authorizationEpoch: 1,
    currentAuthorizationEpoch: () => 1, window: { startAt: new Date(Date.now() - 60_000).toISOString(), endAt: new Date(Date.now() + 60_000).toISOString() },
    grants: { social_direct: true, social_groups: true } });
  const serialized = JSON.stringify(collected);
  assert.doesNotMatch(serialized, /visible direct message/);
  assert.doesNotMatch(serialized, /visible group message/);
  assert.doesNotMatch(serialized, /withdrawn secret|withdrawn group secret/);

  const access = store.updateFollowerAccess({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', disclosureConfirmed: true, grants: { task_activity: true } });
  const run = store.createFollowerRun({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', kind: 'daily_brief', clientRequestId: 'followup_report',
    window: { startAt: new Date(Date.now() - 60_000).toISOString(), endAt: now, timezone: 'Asia/Shanghai' }, authorization: access });
  const report = store.commitFollowerReport({ runId: run.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window,
    coverage: [], claims: [], suggestions: [], summary: 'Saved report.' }, renderedBody: 'Saved report.', syncBody: 'Saved report.', sources: [],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'saved_hash' } });
  const followupExecutionIds = [];
  const service = new FollowerService({ root, store, auth: { requireUser: () => ({ id: 'user_1' }), currentUser: () => ({ id: 'user_1' }) },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' }, executeModel: async (options) => {
      assert.equal(options.harnessMode, 'raw');
      followupExecutionIds.push(options.executionContext.id);
      store.beginModelExecution({ id: options.executionContext.id, userId: 'user_1', accountWorkspaceId: 'workspace_personal',
        requestMessageId: options.executionContext.requestMessageId, agentId: 'follower_agent', executionKind: 'follower_followup' });
      const tool = await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'read_report', arguments: {} });
      assert.equal(tool.success, true);
      store.completeModelExecution(options.executionContext.id);
      return 'The saved report contains no unsupported claims. (source_private)';
    }, contextBroker: broker });
  const thread = await service.openFollowup({ reportId: report.id });
  const answered = await service.sendFollowup({ threadId: thread.id, content: 'What does this report say?' });
  assert.deepEqual(answered.messages.map((message) => message.role), ['user','assistant']);
  assert.doesNotMatch(answered.messages.at(-1).content, /source_private/,
    'follow-up answers must remove internal evidence identifiers before persistence and cloud sync');
  const answeredAgain = await service.sendFollowup({ threadId: thread.id, content: 'What should I check next?' });
  assert.deepEqual(answeredAgain.messages.map((message) => message.role), ['user','assistant','user','assistant']);
  assert.equal(new Set(followupExecutionIds).size, 2, 'each follow-up turn must use a unique model execution ID');
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM model_executions WHERE execution_kind='follower_followup'").get().count), 2);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM model_executions execution
    JOIN follower_followup_messages message ON message.id=execution.request_message_id
    WHERE execution.execution_kind='follower_followup' AND message.role='user'`).get().count), 2,
  'each follow-up execution must reference its own persisted user message');

  const steeredInputs = [];
  let interruptControlReady;
  const interruptReady = new Promise((resolve) => { interruptControlReady = resolve; });
  const steeredService = new FollowerService({ root, store, auth: { requireUser: () => ({ id: 'user_1' }), currentUser: () => ({ id: 'user_1' }) },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' }, executeModel: async (options) => {
      store.beginModelExecution({ id: options.executionContext.id, userId: 'user_1', accountWorkspaceId: 'workspace_personal',
        requestMessageId: options.executionContext.requestMessageId, agentId: 'follower_agent', executionKind: 'follower_followup',
        metadata: options.executionContext.metadata });
      const tool = await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'read_report', arguments: {} });
      assert.equal(tool.success, true);
      let resolveTurn;
      let rejectTurn;
      const turn = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
      const interruptFixture = options.prompt.includes('Interrupt this response');
      options.onTurnControlReady?.({
        threadId: 'thread-steer-smoke', turnId: `turn-${options.executionContext.id}`,
        steer: async (input) => {
          steeredInputs.push(input);
          resolveTurn(`The active turn followed this guidance: ${input.text}`);
          return { threadId: 'thread-steer-smoke', turnId: `turn-${options.executionContext.id}` };
        },
        interrupt: async () => {
          const error = new Error('Interrupted by the user.');
          error.code = 'codex_turn_interrupted';
          rejectTurn(error);
        },
      });
      if (interruptFixture) interruptControlReady();
      try {
        const answer = await turn;
        const execution = store.getModelExecution(options.executionContext.id);
        store.completeModelExecution(options.executionContext.id, { status: 'completed', metadata: execution.metadata });
        return answer;
      } catch (error) {
        const execution = store.getModelExecution(options.executionContext.id);
        store.completeModelExecution(options.executionContext.id, { status: 'cancelled', errorText: error.message, metadata: execution.metadata });
        throw error;
      } finally {
        options.onTurnControlReady?.(null);
      }
    }, contextBroker: broker });
  const baselineMessageCount = answeredAgain.messages.length;
  const initialTurn = steeredService.sendFollowup({ threadId: thread.id, content: 'Start a response that can be guided.' });
  assert.equal((await steeredService.openFollowup({ reportId: report.id })).active, true, 'open follow-up must expose an active turn');
  const guidedTurn = steeredService.sendFollowup({ threadId: thread.id, content: 'Focus on the next concrete check.' });
  const [initialResult, guidedResult] = await Promise.all([initialTurn, guidedTurn]);
  assert.deepEqual(initialResult.messages.map((message) => message.role).slice(baselineMessageCount), ['user', 'user', 'assistant']);
  assert.deepEqual(guidedResult.messages.map((message) => message.role).slice(baselineMessageCount), ['user', 'user', 'assistant']);
  assert.equal(steeredInputs.length, 1, 'guidance must use the active Codex turn exactly once');
  assert.equal(steeredInputs[0].text, 'Focus on the next concrete check.');
  assert.match(steeredInputs[0].clientUserMessageId, /^follower_followup_message_/);
  const steeredExecution = store.getModelExecution(`follower_followup_execution_${initialResult.messages[baselineMessageCount].id}`);
  assert.equal(steeredExecution.status, 'completed');
  assert.deepEqual(steeredExecution.metadata.steerMessageIds, [steeredInputs[0].clientUserMessageId]);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM model_executions WHERE execution_kind='follower_followup'").get().count), 3,
    'steering an active turn must not create a second model execution');

  const interruptedTurn = steeredService.sendFollowup({ threadId: thread.id, content: 'Interrupt this response.' });
  await interruptReady;
  const interruptedThread = await steeredService.cancelFollowup({ threadId: thread.id });
  assert.equal(interruptedThread.active, false);
  await assert.rejects(interruptedTurn, (error) => error?.code === 'codex_turn_interrupted');
  const interruptedExecution = db.prepare("SELECT * FROM model_executions WHERE execution_kind='follower_followup' ORDER BY started_at DESC,id DESC LIMIT 1").get();
  assert.equal(interruptedExecution.status, 'cancelled', 'interrupt must settle the current model execution as cancelled');
  assert.equal((await steeredService.openFollowup({ reportId: report.id })).messages.filter((message) => message.role === 'assistant').length, 3,
    'an interrupted turn must not persist an assistant reply');
  steeredService.close();

  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM sessions').get().count), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count), 0);
  db.prepare(`INSERT INTO sessions(id,user_id,account_workspace_id,title,department_id,agent_id,status)
    VALUES('source_session','user_1','workspace_personal','新对话','general','general_agent','active')`).run();
  db.prepare(`INSERT INTO messages(id,account_workspace_id,session_id,role,content,agent_id,department_id,visible,created_at,updated_at)
    VALUES('source_user_message','workspace_personal','source_session','user','private user content','general_agent','general',1,?,?)`).run(now, now);
  db.prepare(`INSERT INTO messages(id,account_workspace_id,session_id,role,content,agent_id,department_id,visible,created_at,updated_at)
    VALUES('source_agent_message','workspace_personal','source_session','assistant','private agent content','general_agent','general',1,?,?)`).run(now, now);
  const conversationSources = broker.resolveSources({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', grants: { agent_conversations: true },
    reportSources: [
      { refId: 'source_user', sourceKind: 'agent_message', sourceVersion: now, occurredAt: now,
        localReference: { type: 'session_message', sessionId: 'source_session', messageId: 'source_user_message' } },
      { refId: 'source_agent', sourceKind: 'agent_message', sourceVersion: now, occurredAt: now,
        localReference: { type: 'session_message', sessionId: 'source_session', messageId: 'source_agent_message' } },
    ] });
  assert.deepEqual(conversationSources.map((source) => source.role), ['user', 'assistant']);
  assert.equal(conversationSources[0].groupKey, conversationSources[1].groupKey);
  assert.equal(conversationSources[0].agentLabel, 'Generalist A');
  assert.equal(conversationSources[0].title, '新对话');
  assert.equal(conversationSources[0].occurredAt, now);
  assert.doesNotMatch(JSON.stringify(conversationSources), /private user content|private agent content/,
    'source resolution must return metadata without leaking message bodies');
  const task = store.createTaskRun({ id: 'follower_source_task', title: 'Follower source task', prompt: 'Verify source resolution',
    ownerUserId: 'user_1', workspaceId: 'workspace_personal', initialStatus: 'completed' });
  const taskResolved = broker.resolveSources({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', grants: { task_activity: true },
    reportSources: [{ refId: 'task_ref', sourceKind: 'task_run', sourceId: task.id, sourceVersion: task.updatedAt || task.createdAt,
      localReference: { type: 'task_run', id: task.id } }] });
  assert.equal(taskResolved[0].availabilityState, 'available');
  db.prepare("UPDATE task_runs SET owner_user_id='user_2' WHERE id=?").run(task.id);
  assert.equal(broker.resolveSources({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', grants: { task_activity: true },
    reportSources: [{ refId: 'task_ref', sourceKind: 'task_run', sourceId: task.id, sourceVersion: task.updatedAt || task.createdAt,
      localReference: { type: 'task_run', id: task.id } }] })[0].availabilityState, 'deleted');
  const sourceRef = `source_${crypto.createHash('sha256').update('social_direct_message:social_ok:' + now).digest('hex').slice(0, 32)}`;
  const sourceAccess = store.updateFollowerAccess({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', disclosureConfirmed: true,
    grants: { social_direct: true } });
  const sourceRun = store.createFollowerRun({ ownerUserId: 'user_1', workspaceId: 'workspace_personal', kind: 'daily_brief', clientRequestId: 'source_revalidate',
    window: { startAt: new Date(Date.now() - 60_000).toISOString(), endAt: now, timezone: 'Asia/Shanghai' }, authorization: sourceAccess });
  const sourceReport = store.commitFollowerReport({ runId: sourceRun.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: sourceRun.window,
    coverage: [], claims: [{ id: 'claim_source', status: 'discussed_not_executed', text: 'Visible direct message', sourceRefs: [sourceRef] }], suggestions: [], summary: 'Source report.' },
    renderedBody: 'Source report.', syncBody: 'Source report.', sources: [{ refId: sourceRef, sourceKind: 'social_direct_message', sourceId: 'social_ok',
      sourceVersion: now, contentHash: 'hash', occurredAt: now, observedAt: now, localReference: { type: 'social_direct', conversationId: 'direct_1', messageId: 'social_ok' }, availabilityState: 'available' }],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'source_hash' } });
  assert.equal(service.reportSources({ reportId: sourceReport.id })[0].availabilityState, 'permission_changed');
  db.prepare("UPDATE social_messages SET metadata_json=? WHERE id='social_ok'").run('{"withdrawn":true}');
  assert.equal(service.reportSources({ reportId: sourceReport.id })[0].availabilityState, 'permission_changed');
  assert.equal(String(db.prepare('PRAGMA integrity_check').get()?.integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  service.close();
  console.log('Follower high-sensitivity and follow-up smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
