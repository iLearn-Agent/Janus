import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-direct-dispatch-'));
const previousAutoFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const originalQueryRecipientPresence = SocialRelayService.prototype.queryRecipientPresence;
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
SocialRelayService.prototype.queryRecipientPresence = async function queryRecipientPresenceForDirectDispatchSmoke({ userIds = [] } = {}) {
  return { items: userIds.map((userId) => ({ userId, online: true, lastSeenAt: new Date().toISOString() })) };
};
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true,
    auditUBuddyTaskReadinessImpl: async ({ intake }) => ({
      version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true,
      intake: { ...intake, state: 'ready', missingFields: [], clarifications: [],
        readiness: { status: 'ready', reason: 'smoke fixture' } },
    }),
  });
  const alice = runtime.currentUser();
  const bobRegistration = runtime.auth.registerWithEmail({
    email: 'ubuddy-direct-bob@example.com',
    password: 'ubuddy-direct-password-123',
    displayName: 'Direct Dispatch Bob',
  });
  const bob = bobRegistration.user || bobRegistration;
  runtime.store.provisionNewUserAgentDefaults({ userId: bob.id });
  const [userA, userB] = [alice.id, bob.id].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('ubuddy-direct-friendship',?,?,'accepted')`).run(userA, userB);
  runtime.auth.setActiveUser(alice.id);

  const ownUBuddyMention = {
    principalType: 'ubuddy',
    ownerUserId: alice.id,
    agentId: 'secretary_agent',
    displayText: '@我的uBuddy',
    mentionId: 'own-ubuddy-direct-dispatch',
    source: 'picker',
  };
  const command = {
    content: '@我的uBuddy 请让 Bob 整理一份环境治理报告，并返回可核验结论。',
    sourcePeerId: bob.id,
    sourceConversationId: `direct:${alice.id}:${bob.id}`,
    sourceMessageId: 'direct-dispatch-command-1',
    mentions: [ownUBuddyMention],
  };

  const first = await runtime.dispatchCollaborationCommand(command);
  assert.equal(first.dispatched, true);
  assert.equal(first.dispatchType, 'task_group');
  assert.ok(first.group?.id);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.tasks[0].recipientUserId, bob.id);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 1);
  const firstLedger = runtime.store.getUBuddyDispatchCommand(command.sourceMessageId);
  assert.equal(firstLedger?.status, 'published');
  assert.equal(firstLedger?.command?.selectionMode, 'explicit_single');
  assert.deepEqual(firstLedger?.command?.candidateUserIds, [bob.id]);
  assert.deepEqual(firstLedger?.command?.requiredUserIds, [bob.id]);
  assert.deepEqual(firstLedger?.command?.selectedUserIds, [bob.id]);
  assert.deepEqual(firstLedger?.command?.profileRevisionSnapshots, []);
  assert.equal(firstLedger?.command?.selectionDecision?.strategyVersion, 'legacy_all_mentions_v1');
  assert.deepEqual(first.source?.uBuddySelection?.selectedUserIds, [bob.id]);
  assert.deepEqual(first.group?.metadata?.uBuddySelection?.selectedUserIds, [bob.id]);
  assert.equal(first.group?.metadata?.taskSummary?.version, 1);
  assert.match(first.group?.metadata?.taskSummary?.objective || '', /环境治理报告/);
  assert.deepEqual(first.tasks[0]?.metadata?.taskSummary, first.group?.metadata?.taskSummary,
    'every grouped delegation must receive the same shared final objective snapshot');
  const persistedEntityCounts = entityCounts(runtime);

  const repeated = await runtime.dispatchCollaborationCommand(command);
  assert.equal(repeated.dispatched, true);
  assert.equal(repeated.group?.id, first.group.id);
  assert.equal(repeated.result?.idempotent, true);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 1);
  assert.equal(runtime.agentDelegations({ direction: 'outgoing' }).length, 1);
  assert.deepEqual(entityCounts(runtime), persistedEntityCounts,
    'replaying a dispatch command must not add tasks, messages, Memory, attachments, or execution records');
  assert.equal(runtime.store.getUBuddyDispatchCommand(command.sourceMessageId)?.attemptCount, firstLedger.attemptCount,
    'a published replay must reuse the persisted selection without reclaiming the command');

  await assert.rejects(runtime.dispatchCollaborationCommand({
    ...command,
    content: '@我的uBuddy 请让 Bob 改为整理另一份完全不同的报告。',
  }), (error) => error?.code === 'ubuddy_dispatch_idempotency_conflict');
  assert.deepEqual(entityCounts(runtime), persistedEntityCounts,
    'a command-id payload conflict must be rejected before creating side effects');

  const missingRequirement = await runtime.dispatchCollaborationCommand({
    ...command,
    content: '@我的uBuddy',
    sourceMessageId: 'direct-dispatch-command-missing-requirement',
  });
  assert.equal(missingRequirement.dispatched, false);
  assert.equal(missingRequirement.clarification?.reasonCode, 'missing_requirement');
  assert.equal(missingRequirement.clarification?.localOnly, true);
  assert.match(missingRequirement.clarification?.content || '', /任务要求/);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 1);

  const missingRecipient = await runtime.dispatchCollaborationCommand({
    content: '@我的uBuddy 请整理一份环境治理报告。',
    sourcePeerId: '',
    sourceConversationId: `direct:${alice.id}:unknown`,
    sourceMessageId: 'direct-dispatch-command-missing-recipient',
    mentions: [ownUBuddyMention],
  });
  assert.equal(missingRecipient.dispatched, false);
  assert.equal(missingRecipient.clarification?.reasonCode, 'missing_recipient');
  assert.equal(missingRecipient.clarification?.localOnly, true);
  assert.match(missingRecipient.clarification?.content || '', /结构化接收人/);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 1);

  const secretarySession = runtime.ensureSecretarySession();
  const v3Command = {
    version: 3,
    id: 'ubuddy-direct-v3-dispatch-1',
    title: 'V3 环境治理报告',
    dispatchType: 'external_delegation',
    intent: 'single_agent_task',
    objective: '整理一份 V3 环境治理报告。',
    deliverables: ['可核验报告'],
    sourceSecretarySessionId: secretarySession.id,
    sourceMessageId: 'ubuddy-direct-v3-source-1',
    sourceContent: '请 Bob 整理一份 V3 环境治理报告。',
    participants: [{ userId: bob.id, selected: true }],
    assignments: [{ recipientId: bob.id, title: 'V3 环境治理报告', instruction: '整理一份 V3 环境治理报告。' }],
    selectionMode: 'explicit_single',
    candidateUserIds: [bob.id],
    selectedUserIds: [bob.id],
    selectionDecision: {
      status: 'ready',
      strategyVersion: 'ubuddy_dispatch_v3_test',
      rationale: '用户明确选择唯一好友。',
    },
  };
  const v3Dispatch = await runtime.executeSecretaryDispatch({
    sessionId: secretarySession.id,
    dispatch: v3Command,
  });
  assert.equal(v3Dispatch.dispatchType, 'external_delegation');
  assert.equal(v3Dispatch.delegation?.recipientUserId, bob.id);
  assert.deepEqual(v3Dispatch.message?.metadata?.uBuddySelection?.selectedUserIds, [bob.id]);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 1,
    'a V3 single-peer dispatch must not create a task group');

  const delegationCountAfterV3 = runtime.agentDelegations({ direction: 'outgoing' }).length;
  const repeatedV3Dispatch = await runtime.executeSecretaryDispatch({
    sessionId: secretarySession.id,
    dispatch: v3Command,
  });
  assert.equal(repeatedV3Dispatch.idempotent, true);
  assert.equal(repeatedV3Dispatch.delegation?.id, v3Dispatch.delegation?.id);
  assert.equal(runtime.agentDelegations({ direction: 'outgoing' }).length, delegationCountAfterV3,
    'replaying a saved external delegation must not create a duplicate');

  const localAgent = runtime.store.activeEmployeeAgentsForUser({ userId: alice.id })
    .find((item) => item.agentFamilyId === 'general_agent');
  assert.ok(localAgent?.id);
  runtime.store.settingSet('ubuddy:feature_flags:v1', JSON.stringify({ bounded_delivery_rework_v1: 'on' }));
  runtime.scheduler.runReadyNodes = async (taskRunId) => runtime.store.getTaskRun(taskRunId);
  const boundedLocalDispatch = await runtime.executeSecretaryDispatch({
    sessionId: secretarySession.id,
    dispatch: {
      version: 3,
      id: 'ubuddy-direct-bounded-local-agent-1',
      title: '有限验收本地任务',
      dispatchType: 'local_agent',
      intent: 'single_agent_task',
      objective: '完成一份由 uBuddy 大模型验收的本地结果。',
      deliverables: ['可直接交付的结果'],
      sourceSecretarySessionId: secretarySession.id,
      sourceMessageId: 'ubuddy-direct-bounded-local-source-1',
      sourceContent: '请本地 Agent 完成结果，并由 uBuddy 验收。',
      agents: [{ agentId: 'general_agent', agentInstanceId: localAgent.id }],
      participants: [],
      selectionMode: 'explicit_single',
      candidateAgentInstanceIds: [localAgent.id],
      selectedAgentInstanceIds: [localAgent.id],
    },
  });
  assert.equal(boundedLocalDispatch.dispatchType, 'local_agent');
  assert.ok(boundedLocalDispatch.taskRunId);
  assert.ok(boundedLocalDispatch.task?.nodes?.length === 1,
    'bounded delivery review must materialize even an idle single-Agent dispatch as a task graph');
  assert.equal(boundedLocalDispatch.task?.metadata?.featureFlagSnapshot?.boundedDeliveryReworkV1, true);
  assert.equal(Boolean(boundedLocalDispatch.workId), false,
    'the bounded review path must not use the legacy direct Agent delivery receipt flow');
  runtime.cancelTaskRun({ taskRunId: boundedLocalDispatch.taskRunId });
  runtime.store.settingSet('ubuddy:feature_flags:v1', '{}');

  runtime.db.prepare(`INSERT INTO agent_delegations(id,requester_user_id,recipient_user_id,title,instruction)
    VALUES('legacy-delegation-a',?,?,?,?),('legacy-delegation-b',?,?,?,?)`).run(
    alice.id, bob.id, 'Legacy A', 'Preserve A', alice.id, bob.id, 'Legacy B', 'Preserve B',
  );
  assert.deepEqual(runtime.db.prepare(`SELECT id,client_request_id FROM agent_delegations
    WHERE id LIKE 'legacy-delegation-%' ORDER BY id`).all().map((row) => ({ ...row })), [
    { id: 'legacy-delegation-a', client_request_id: '' },
    { id: 'legacy-delegation-b', client_request_id: '' },
  ]);
  assert.throws(() => runtime.db.prepare(`INSERT INTO agent_delegations(
    id,account_workspace_id,requester_user_id,recipient_user_id,client_request_id,title,instruction
  ) VALUES('duplicate-request-delegation','workspace_personal',?,?,?,'Duplicate','Duplicate')`).run(
    alice.id, bob.id, 'ubuddy-direct-v3-dispatch-1',
  ), /UNIQUE constraint failed/);
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_agent_delegations_client_request'").get().count, 1);
  const recoveryCommand = structuredClone(firstLedger.command);
  recoveryCommand.id = 'ubuddy-dispatch-recovery-selection-1';
  recoveryCommand.sourceType = 'direct_chat';
  recoveryCommand.sourceMessageId = 'ubuddy-dispatch-recovery-source-1';
  runtime.store.reserveUBuddyDispatchCommand({
    command: recoveryCommand,
    ownerUserId: alice.id,
    sourceSessionId: recoveryCommand.sourceConversationId,
    sourceMessageId: recoveryCommand.sourceMessageId,
  });
  runtime.store.claimUBuddyDispatchCommand({ commandId: recoveryCommand.id, leaseMs: 5_000 });
  runtime.db.prepare("UPDATE ubuddy_dispatch_commands SET lease_expires_at='2020-01-01T00:00:00.000Z' WHERE command_id=?")
    .run(recoveryCommand.id);
  const recoveredCommands = runtime.store.recoverUBuddyDispatchCommands();
  const recoveredCommand = recoveredCommands.find((item) => item.commandId === recoveryCommand.id);
  assert.equal(recoveredCommand?.status, 'retry_wait');
  assert.deepEqual(recoveredCommand?.command?.selectedUserIds, firstLedger.command.selectedUserIds);
  assert.deepEqual(recoveredCommand?.command?.selectionDecision, firstLedger.command.selectionDecision,
    'recovery must use the saved selection instead of recomputing it');
  const ledgerBeforeReopen = runtime.db.prepare(`SELECT command_id,status,payload_hash,command_json,result_json,attempt_count,max_attempts,
    created_at,updated_at,completed_at FROM ubuddy_dispatch_commands ORDER BY command_id`).all();
  const delegationsBeforeReopen = runtime.db.prepare(`SELECT id,client_request_id,title,instruction,created_at FROM agent_delegations ORDER BY id`).all();
  runtime.close();
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true,
    auditUBuddyTaskReadinessImpl: async ({ intake }) => ({
      version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true,
      intake: { ...intake, state: 'ready', missingFields: [], clarifications: [],
        readiness: { status: 'ready', reason: 'smoke fixture' } },
    }),
  });
  assert.deepEqual(runtime.db.prepare(`SELECT command_id,status,payload_hash,command_json,result_json,attempt_count,max_attempts,
    created_at,updated_at,completed_at FROM ubuddy_dispatch_commands ORDER BY command_id`).all(), ledgerBeforeReopen,
  'opening the database a second time must preserve the command ledger exactly');
  assert.deepEqual(runtime.db.prepare(`SELECT id,client_request_id,title,instruction,created_at FROM agent_delegations ORDER BY id`).all(), delegationsBeforeReopen,
  'opening the database a second time must preserve legacy and idempotent delegations exactly');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id='ubuddy_dispatch_command_v3'").get().count, 1);
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);

  console.log('uBuddy direct dispatch smoke passed');
} finally {
  runtime?.close();
  rmSync(root, { recursive: true, force: true });
  if (previousAutoFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousAutoFlag;
  SocialRelayService.prototype.queryRecipientPresence = originalQueryRecipientPresence;
}

function entityCounts(targetRuntime) {
  return Object.fromEntries([
    'task_runs',
    'task_nodes',
    'task_events',
    'agent_delegations',
    'collaboration_group_messages',
    'messages',
    'memory_documents',
    'memory_document_versions',
    'message_attachments',
    'model_executions',
    'agent_work_queue',
    'agent_delivery_receipts',
    'agent_delivery_events',
  ].map((table) => [table, Number(targetRuntime.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)]));
}
