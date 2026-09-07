import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(typeof message === 'function' ? message() : message);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-stage7-runtime-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-stage7-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previous = Object.fromEntries([
  'JANUS_CODEX_BIN',
  'JANUS_UBUDDY_NEW_DISPATCH_STRATEGY',
  'JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1',
  'JANUS_UBUDDY_INTAKE_CLARIFICATION_V2',
  'JANUS_STAGE7_RETRY_MARKER',
].map((key) => [key, process.env[key]]));

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
function responseFor(input) {
  if (input.includes('【UBUDDY_CONTINUOUS_PLANNING_REPAIR_V1】')) {
    return input.split('Invalid response: ')[1]?.split(String.fromCharCode(10) + String.fromCharCode(10) + 'Required schema:')[0]
      || 'UNEXPECTED_REPAIR_CALL';
  }
  if (input.includes('【UBUDDY_CONTINUOUS_PLANNING_V1】')) {
    if (input.includes('后台重试验证') && process.env.JANUS_STAGE7_RETRY_MARKER
      && !fs.existsSync(process.env.JANUS_STAGE7_RETRY_MARKER)) {
      fs.writeFileSync(process.env.JANUS_STAGE7_RETRY_MARKER, 'failed-once', 'utf8');
      return 'INVALID_FIRST_ATTEMPT';
    }
    const users = JSON.parse(input.split('Authorized remote users: ')[1]?.split(String.fromCharCode(10))[0] || '[]');
    const currentRequest = input.split('Current request: ').at(-1)?.split('Schema:')[0] || '';
    const clarificationPending = currentRequest.includes('连续澄清恢复验证')
      && input.includes('Structured clarification response: None.');
    const questions = clarificationPending ? [{ id: 'initiator_participation', header: '参与方式',
      reason: '需要确认发起人的参与方式', question: '发起人是否也参与工作？', answerType: 'single_choice',
      options: [{ value: 'coordinator_only', label: '只负责协调' }, { value: 'coordinator_and_worker', label: '我也参与' }],
      allowOther: true, required: true }] : [];
    const peer = currentRequest.includes('我负责 PPT');
    const revised = currentRequest.includes('第二位改为复核报告');
    const directExplicit = currentRequest.includes('明确直聊分工');
    const assignments = clarificationPending ? [] : users.map((user, index) => ({
      assignmentId: directExplicit ? (index === 0 ? 'direct_data' : 'direct_report') : 'remote_' + (index + 1),
      assigneeKind: 'user', userId: user.userId, agentInstanceId: '',
      title: index === 0 ? '整理市场数据' : revised ? '复核分析报告 ' + index : '撰写分析报告 ' + index,
      objective: index === 0 ? '整理并校验市场数据' : revised ? '复核第 ' + index + ' 部分的数据和结论' : '撰写市场分析报告第 ' + index + ' 部分',
      deliverables: index === 0 ? ['数据表'] : ['分析报告第 ' + index + ' 部分'], dependencies: [],
    }));
    if (peer && !clarificationPending) assignments.push({
      assignmentId: 'self', assigneeKind: 'self', userId: '', agentInstanceId: '', title: '制作 PPT',
      objective: '根据协作结果制作最终 PPT', deliverables: ['PPT'], dependencies: assignments.map((item) => item.assignmentId),
    });
    const state = clarificationPending ? 'needs_clarification' : 'ready';
    return JSON.stringify({
      version: 'UBUDDY_PLANNING_DECISION_V1', decision: clarificationPending ? 'awaiting_clarification' : 'ready_for_dispatch',
      confidence: clarificationPending ? 0.75 : 0.94, answer: '',
      intake: { version: 'ubuddy_task_intake_v1', state, taskKind: 'general', workReportSpec: null,
        objective: '完成市场分析报告', deliverables: ['市场分析报告'], acceptanceCriteria: [], constraints: [], deadline: '',
        candidateUsers: users, requiredUsers: users, attachments: [], privacyScope: 'task_group_public', riskLevel: 'low',
        missingFields: clarificationPending ? ['initiator_participation'] : [], clarifications: questions,
        executionPlan: { summary: '多人协作完成报告', steps: ['整理数据', '撰写或复核报告'], requiredInputs: [] },
        knownFacts: [], safeAssumptions: [], criticalUnknowns: clarificationPending ? ['initiator_participation'] : [],
        readiness: { status: state, reason: clarificationPending ? '需要确认参与方式' : '' } },
      target: { kind: users.length > 1 ? 'task_group' : 'external_delegation', candidateUserIds: users.map((item) => item.userId),
        requiredUserIds: users.map((item) => item.userId), selectedUserIds: users.map((item) => item.userId), selectedAgentInstanceIds: [] },
      collaboration: { mode: peer ? 'peer_collaboration' : 'manager_delegation',
        initiatorParticipation: peer ? 'coordinator_and_worker' : 'coordinator_only', participantSelectionIntent: 'all',
        assignmentIntent: peer || /明确直聊分工|明确群聊分工|后台重试验证/.test(currentRequest) ? 'explicit' : 'auto' },
      assignments, clarifications: questions,
      readiness: { status: state, reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: clarificationPending ? ['initiator_participation'] : [] },
      riskLevel: 'low', rationale: '持续规划已生成完整协作方案。',
    });
  }
  if (input.includes('【UBUDDY_COLLABORATION_MODE_DECISION_V1】')) {
    if (input.includes('后台重试验证') && process.env.JANUS_STAGE7_RETRY_MARKER
      && !fs.existsSync(process.env.JANUS_STAGE7_RETRY_MARKER)) {
      fs.writeFileSync(process.env.JANUS_STAGE7_RETRY_MARKER, 'failed-once', 'utf8');
      return 'INVALID_FIRST_ATTEMPT';
    }
    const users = JSON.parse(input.split('Structured mentioned users: ')[1]?.split('\\n')[0] || '[]');
    const currentRequest = input.split('Current request: ')[1]?.split('\\n\\nSchema:')[0] || '';
    if (currentRequest.includes('连续澄清恢复验证')) {
      return JSON.stringify({
        version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1', decision: 'clarification',
        collaborationMode: 'manager_delegation', initiatorParticipation: 'coordinator_only',
        assignmentIntent: 'auto', participantSelectionIntent: 'all', explicitAssignments: [], confidence: 0.7,
        clarifications: [{ id: 'initiator_participation', header: '参与方式',
          reasonCode: 'initiator_participation_ambiguous', question: '发起人是否也参与工作？',
          options: ['只负责协调，其他人完成', '我也参与并承担工作'], allowOther: true, required: true }],
      });
    }
    const markerPositions = {
      auto: input.lastIndexOf('请共同完成市场分析报告'),
      peer: input.lastIndexOf('我负责 PPT'),
      direct: input.lastIndexOf('明确直聊分工'),
      natural: Math.max(input.lastIndexOf('明确群聊分工'), input.lastIndexOf('后台重试验证')),
    };
    const latestMarker = Math.max(...Object.values(markerPositions));
    const peer = latestMarker >= 0 && markerPositions.peer === latestMarker;
    const directExplicit = latestMarker >= 0 && markerPositions.direct === latestMarker;
    const naturalExplicit = latestMarker >= 0 && markerPositions.natural === latestMarker;
    return JSON.stringify({
      version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1', decision: 'ready',
      collaborationMode: peer ? 'peer_collaboration' : 'manager_delegation',
      initiatorParticipation: peer ? 'coordinator_and_worker' : 'coordinator_only',
      assignmentIntent: peer || directExplicit || naturalExplicit ? 'explicit' : 'auto',
      participantSelectionIntent: input.includes('自动筛选无 Profile') ? 'auto' : 'all',
      explicitAssignments: peer ? [
        { assignmentId: 'data', assigneeKind: 'user', userId: users[0].userId, title: '整理数据', objective: '整理并校验市场数据', deliverables: ['数据表'], dependencies: [] },
        { assignmentId: 'report', assigneeKind: 'user', userId: users[1].userId, title: '撰写报告', objective: '撰写市场分析报告', deliverables: ['分析报告'], dependencies: ['data'] },
        { assignmentId: 'self', assigneeKind: 'self', userId: '', title: '制作 PPT', objective: '根据协作结果制作最终 PPT', deliverables: ['PPT'], dependencies: ['data', 'report'] },
      ] : directExplicit || naturalExplicit ? [
        { assignmentId: 'direct_data', assigneeKind: 'user', userId: users[0].userId, title: '整理直聊数据', objective: '整理直聊任务数据', deliverables: ['数据表'], dependencies: [] },
        { assignmentId: 'direct_report', assigneeKind: 'user', userId: users[1].userId, title: '撰写直聊报告', objective: '撰写直聊分析报告', deliverables: ['报告'], dependencies: ['direct_data'] },
      ] : [],
      confidence: 0.94,
      clarification: { reasonCode: '', question: '', options: [] },
    });
  }
  if (input.includes('【UBUDDY_COLLABORATION_ASSIGNMENT_PLAN_V1】')) {
    const users = JSON.parse(input.split('Selected structured users: ')[1]?.split('\\n')[0] || '[]');
    const revised = input.includes('第二位改为复核报告');
    return JSON.stringify({
      version: 'UBUDDY_COLLABORATION_PLAN_V1', proposalId: 'ignored', revision: 1,
      status: 'awaiting_confirmation', collaborationMode: 'manager_delegation',
      initiatorParticipation: 'coordinator_only', assignmentSource: 'ubuddy_planned',
      assignments: users.map((user, index) => ({
        assignmentId: 'remote_' + (index + 1), assigneeKind: 'user', userId: user.userId,
        title: index === 0 ? '整理市场数据' : revised ? '复核分析报告' : '撰写分析报告',
        objective: index === 0 ? '整理并校验市场数据' : revised ? '复核报告中的数据和结论' : '基于共享目标撰写分析报告',
        deliverables: index === 0 ? ['数据表'] : ['分析报告'], dependencies: [],
      })),
      finalIntegrator: 'self_ubuddy', confirmationRequired: true, confidence: 0.92,
      strategyVersion: 'ubuddy_collaboration_assignment_v1', createdAt: new Date().toISOString(), confirmedAt: '',
    });
  }
  return 'UNEXPECTED_MODEL_CALL';
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
if (args[0] === 'app-server') {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'stage7-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') emit({ id: message.id, result: { thread: { id: 'stage7-thread' } } });
    else if (message.method === 'turn/start') {
      const input = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const response = responseFor(input);
      emit({ id: message.id, result: { turn: { id: 'stage7-turn' } } });
      emit({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'stage7-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
    } else emit({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = responseFor(stdin);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'stage7-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`, 'utf8');
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_UBUDDY_NEW_DISPATCH_STRATEGY = 'on';
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'on';
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
process.env.JANUS_STAGE7_RETRY_MARKER = path.join(root, 'natural-group-retry.marker');

let runtime;
const originalQueryRecipientPresence = SocialRelayService.prototype.queryRecipientPresence;
const originalCollaborationPlannedParticipantsSupported = SocialRelayService.prototype.collaborationPlannedParticipantsSupported;
const originalConnected = SocialRelayService.prototype.connected;
const originalPoll = SocialRelayService.prototype.poll;
const originalDelegationCreateIdempotencySupported = SocialRelayService.prototype.delegationCreateIdempotencySupported;
const originalUpdateCollaborationGroup = SocialRelayService.prototype.updateCollaborationGroup;
const offlineRecipientIds = new Set();
SocialRelayService.prototype.queryRecipientPresence = async function queryRecipientPresenceForStage7Smoke({ userIds = [] } = {}) {
  return { items: userIds.map((userId) => ({
    userId, online: !offlineRecipientIds.has(userId), lastSeenAt: new Date().toISOString(),
  })) };
};
SocialRelayService.prototype.collaborationPlannedParticipantsSupported = async function plannedParticipantsForStage7Smoke() {
  return true;
};
try {
  let readinessAuditCount = 0;
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true,
    auditUBuddyTaskReadinessImpl: async ({ intake }) => {
      readinessAuditCount += 1;
      return { version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true,
        intake: { ...intake, state: 'ready', missingFields: [], clarifications: [],
          readiness: { status: 'ready', reason: 'smoke fixture' } } };
    },
  });
  const owner = runtime.currentUser();
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('stage7_employee_a','a@example.com','张三','stage7_a',1),
           ('stage7_employee_b','b@example.com','李四','stage7_b',1)`).run();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('stage7_friend_a',?,'stage7_employee_a','accepted'),
           ('stage7_friend_b',?,'stage7_employee_b','accepted')`).run(owner.id, owner.id);
  const session = runtime.ensureSecretarySession();
  const clientCapabilities = {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    taskReferenceVersion: 'structured_task_reference_v1',
  };
  const mentions = [
    { principalType: 'user', userId: 'stage7_employee_a', displayText: '@张三', mentionId: 'stage7-a', source: 'picker' },
    { principalType: 'user', userId: 'stage7_employee_b', displayText: '@李四', mentionId: 'stage7-b', source: 'picker' },
  ];
  const before = {
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const proposed = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 请让所有人参与，由 uBuddy 自动分工完成市场分析报告。',
    mentions,
  });
  assert.equal(proposed.uBuddyMode, 'awaiting_confirmation', JSON.stringify({
    answer: proposed.answer,
    reasonCode: proposed.message?.metadata?.reasonCode,
    planStatus: proposed.message?.metadata?.uBuddyCollaborationPlan?.status,
    processingMode: proposed.message?.metadata?.uBuddyDispatchCommand?.ubuddyProcessingMode,
  }));
  assert.equal(proposed.collaborationPlan.status, 'awaiting_confirmation');
  assert.equal(proposed.collaborationPlan.confirmationRequired, true);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, before);
  const confirmedProposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '确认派发',
  });
  assert.equal(confirmedProposal.uBuddyMode, 'dispatched');
  assert.equal(readinessAuditCount, 0, 'hard cutover must not invoke the legacy readiness auditor');
  const ledger = runtime.db.prepare('SELECT command_id,status,command_json,last_error FROM ubuddy_dispatch_commands').get();
  assert.equal(ledger.status, 'published', JSON.stringify({
    lastError: ledger.last_error,
    pending: runtime.store.pendingDispatchAssignments(ledger.command_id),
  }));
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, before.groups + 1);
  const frozen = JSON.parse(ledger.command_json);
  assert.equal(frozen.collaborationPlan.status, 'confirmed');
  assert.equal(frozen.collaborationPlan.confirmationRequired, true);
  assert.equal(frozen.selectionMode, 'all_selected');
  assert.deepEqual(frozen.selectedUserIds.sort(), ['stage7_employee_a', 'stage7_employee_b']);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, before.delegations + 2);

  const continuationBefore = {
    tasks: runtime.store.listTaskRuns({ userId: owner.id }).length,
    waits: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_agent_wait_requests').get().count,
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const newTaskReference = { principalType: 'task', taskRunId: '', displayText: '@新任务', createNewTask: true, action: 'new_task' };
  const continuationQuestion = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 连续澄清恢复验证：共同完成市场分析报告。',
    mentions,
    taskReference: newTaskReference,
  });
  assert.equal(continuationQuestion.uBuddyMode, 'clarification');
  assert.equal(continuationQuestion.message.metadata.taskReference.createNewTask, true);
  const continuationCheckpoint = continuationQuestion.message.metadata.uBuddyPlanningCheckpoint;
  assert.ok(continuationCheckpoint?.planningSessionId);
  const continued = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '只负责协调，其他人完成',
    mentions: [],
    taskReference: newTaskReference,
    clarificationResponse: {
      version: 'ubuddy_clarification_response_v1',
      sourceMessageId: continuationQuestion.message.id,
      planningSessionId: continuationCheckpoint.planningSessionId,
      baseRevision: continuationCheckpoint.revision,
      answers: [{ questionId: 'initiator_participation', value: '只负责协调，其他人完成', label: '只负责协调，其他人完成' }],
    },
  });
  assert.equal(continued.uBuddyMode, 'awaiting_confirmation', JSON.stringify({
    mode: continued.uBuddyMode, errorCode: continued.errorCode, answer: continued.answer,
  }));
  assert.equal(runtime.store.listTaskRuns({ userId: owner.id }).length, continuationBefore.tasks,
    'coordinator-only clarification continuation must not create an owner-local task');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_agent_wait_requests').get().count, continuationBefore.waits,
    'coordinator-only clarification continuation must not create local Agent wait requests');
  const resolvedCheckpoint = runtime.store.getMessage(continuationQuestion.message.id).metadata.uBuddyPlanningCheckpoint;
  assert.equal(resolvedCheckpoint.planningSessionId, continuationCheckpoint.planningSessionId);
  assert.ok(resolvedCheckpoint.revision > continuationCheckpoint.revision);
  const repeatedContinuation = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '只负责协调，其他人完成',
    mentions: [],
    taskReference: newTaskReference,
    clarificationResponse: {
      version: 'ubuddy_clarification_response_v1', sourceMessageId: continuationQuestion.message.id,
      planningSessionId: continuationCheckpoint.planningSessionId,
      baseRevision: continuationCheckpoint.revision,
      answers: [{ questionId: 'initiator_participation', value: '只负责协调，其他人完成', label: '只负责协调，其他人完成' }],
    },
  });
  assert.equal(repeatedContinuation.idempotent, true);
  assert.equal(runtime.store.listTaskRuns({ userId: owner.id }).length, continuationBefore.tasks);
  const continuationDispatch = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '确认派发',
  });
  assert.equal(continuationDispatch.uBuddyMode, 'dispatched');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, continuationBefore.groups + 1);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, continuationBefore.delegations + 2);
  assert.equal(runtime.store.listTaskRuns({ userId: owner.id }).length, continuationBefore.tasks);

  process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
  const delegationsBeforeFrozenReplay = runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count;
  const repeated = await runtime.executeSecretaryDispatch({ sessionId: session.id, dispatch: frozen });
  assert.equal(repeated.idempotent, true);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, delegationsBeforeFrozenReplay);
  process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'on';

  const allOfflineBefore = {
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  offlineRecipientIds.add('stage7_employee_a');
  offlineRecipientIds.add('stage7_employee_b');
  const allOfflineProposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 请让所有人参与，由 uBuddy 自动分工完成市场分析报告。',
    mentions,
  });
  assert.equal(allOfflineProposal.uBuddyMode, 'awaiting_confirmation');
  const allOfflineDispatch = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '确认派发',
  });
  assert.equal(allOfflineDispatch.uBuddyMode, 'dispatched');
  assert.match(allOfflineDispatch.answer, /已派发 0\/2 项分工/);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, allOfflineBefore.groups + 1,
    'confirming a plan must create its task group even when every recipient is offline');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, allOfflineBefore.delegations,
    'offline recipients must not receive executable delegations before coming online');
  const allOfflineLedger = runtime.store.getUBuddyDispatchCommand(allOfflineProposal.message.metadata.uBuddyDispatchCommand.id);
  assert.ok(allOfflineLedger.result.groupId, 'the waiting dispatch must checkpoint its task group id');
  assert.deepEqual(runtime.auth.collaborationGroup(allOfflineLedger.result.groupId).plannedParticipants
    .map((item) => [item.userId, item.status]).sort(), [
    ['stage7_employee_a', 'awaiting_presence'],
    ['stage7_employee_b', 'awaiting_presence'],
  ]);
  offlineRecipientIds.delete('stage7_employee_a');
  offlineRecipientIds.delete('stage7_employee_b');
  await runtime.executeSecretaryDispatch({
    sessionId: session.id,
    dispatch: allOfflineLedger.command,
  });
  assert.equal(runtime.store.getUBuddyDispatchCommand(allOfflineLedger.command.id).result.groupId, allOfflineLedger.result.groupId,
    'presence recovery must publish into the task group created at confirmation time');
  assert.equal(runtime.store.getUBuddyDispatchCommand(allOfflineLedger.command.id).status, 'published');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=?')
    .get(allOfflineLedger.result.groupId).count, 2);

  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('stage7_employee_09','09@example.com','测试账号 09','stage7_09',1)`).run();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('stage7_friend_09',?,'stage7_employee_09','accepted')`).run(owner.id);
  const mentionsWithOffline09 = [
    ...mentions,
    { principalType: 'user', userId: 'stage7_employee_09', displayText: '@测试账号 09', mentionId: 'stage7-09', source: 'picker' },
  ];
  const offline09Before = {
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const offline09Proposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 @测试账号 09 正式分配 Agent 未来发展趋势研究任务。',
    mentions: mentionsWithOffline09,
  });
  assert.equal(offline09Proposal.uBuddyMode, 'awaiting_confirmation');
  assert.deepEqual(offline09Proposal.collaborationPlan.selectedUserIds.sort(),
    ['stage7_employee_09', 'stage7_employee_a', 'stage7_employee_b']);
  const offline09CommandId = offline09Proposal.message.metadata.uBuddyDispatchCommand.id;
  offlineRecipientIds.add('stage7_employee_09');
  const partial09Dispatch = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '确认派发',
  });
  assert.equal(partial09Dispatch.uBuddyMode, 'dispatched');
  assert.match(partial09Dispatch.answer, /已派发 2\/3 项分工；测试账号 09 当前离线/);
  assert.equal(partial09Dispatch.message.metadata.assignmentCount, 3);
  assert.equal(partial09Dispatch.message.metadata.publishedRecipientCount, 2);
  assert.equal(partial09Dispatch.message.metadata.pendingRecipientCount, 1);
  assert.deepEqual(partial09Dispatch.message.metadata.pendingRecipientIds, ['stage7_employee_09']);
  assert.deepEqual(partial09Dispatch.message.metadata.pendingRecipientLabels, ['测试账号 09']);
  assert.equal(partial09Dispatch.message.metadata.publishedTaskCards.length, 2);
  let offline09Ledger = runtime.store.getUBuddyDispatchCommand(offline09CommandId);
  assert.equal(offline09Ledger.status, 'retry_wait');
  assert.equal(offline09Ledger.lastError, 'awaiting_recipient_presence');
  assert.deepEqual([...offline09Ledger.command.candidateUserIds].sort(),
    ['stage7_employee_09', 'stage7_employee_a', 'stage7_employee_b']);
  assert.deepEqual([...offline09Ledger.command.requiredUserIds].sort(),
    ['stage7_employee_09', 'stage7_employee_a', 'stage7_employee_b']);
  assert.deepEqual([...offline09Ledger.command.selectedUserIds].sort(),
    ['stage7_employee_09', 'stage7_employee_a', 'stage7_employee_b']);
  const offline09GroupId = offline09Ledger.result.groupId;
  assert.ok(offline09GroupId, 'online recipients must start one group while 09 waits for presence');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, offline09Before.groups + 1);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=?').get(offline09GroupId).count, 2);
  assert.deepEqual(runtime.store.pendingDispatchAssignments(offline09CommandId).map((item) => [item.recipientUserId, item.status]).sort(), [
    ['stage7_employee_09', 'awaiting_presence'],
    ['stage7_employee_a', 'published'],
    ['stage7_employee_b', 'published'],
  ]);
  const waitingGroup = runtime.auth.collaborationGroup(offline09GroupId);
  assert.equal(waitingGroup.plannedParticipants.find((item) => item.userId === 'stage7_employee_09')?.status, 'awaiting_presence');

  const delayedRetryAt = new Date(Date.now() + 60_000).toISOString();
  runtime.db.prepare('UPDATE ubuddy_dispatch_commands SET next_attempt_at=? WHERE command_id=?')
    .run(delayedRetryAt, offline09CommandId);
  offlineRecipientIds.delete('stage7_employee_09');
  await runtime.pollSocialNetwork({ autoProcess: false });
  assert.equal(runtime.store.getUBuddyDispatchCommand(offline09CommandId).nextAttemptAt, delayedRetryAt,
    'read-only social polling must not expedite or publish a pending presence dispatch');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=?')
    .get(offline09GroupId).count, 2);

  SocialRelayService.prototype.connected = () => true;
  SocialRelayService.prototype.poll = async function pollForPresenceRecovery() {
    return {
      friends: { friends: [], requests: { incoming: [], outgoing: [] } }, inbox: [], delegations: [],
      collaboration: { groups: [], tasks: [] }, chatGroups: { groups: [] }, incomingMessages: [],
    };
  };
  SocialRelayService.prototype.delegationCreateIdempotencySupported = async () => true;
  SocialRelayService.prototype.updateCollaborationGroup = async function updateGroupForPresenceRecovery(groupId, payload = {}) {
    return this.auth.updateCollaborationGroup({ groupId, ...payload });
  };
  const presenceRecoveryPoll = await runtime.pollSocialNetwork({ autoProcess: true });
  SocialRelayService.prototype.connected = originalConnected;
  SocialRelayService.prototype.poll = originalPoll;
  SocialRelayService.prototype.delegationCreateIdempotencySupported = originalDelegationCreateIdempotencySupported;
  SocialRelayService.prototype.updateCollaborationGroup = originalUpdateCollaborationGroup;
  assert.deepEqual(presenceRecoveryPoll.uBuddyDispatchRecovery, {
    attempted: 1, published: 1, waiting: 0, failed: 0,
  });
  offline09Ledger = runtime.store.getUBuddyDispatchCommand(offline09CommandId);
  assert.equal(offline09Ledger.status, 'published');
  assert.deepEqual(runtime.store.pendingDispatchAssignments(offline09CommandId).map((item) => [item.recipientUserId, item.status]).sort(), [
    ['stage7_employee_09', 'published'],
    ['stage7_employee_a', 'published'],
    ['stage7_employee_b', 'published'],
  ]);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, offline09Before.groups + 1,
    '09 must join the original group instead of creating a second group');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=?').get(offline09GroupId).count, 3);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=? AND recipient_user_id=?')
    .get(offline09GroupId, 'stage7_employee_09').count, 1);
  const completed09Group = runtime.auth.collaborationGroup(offline09GroupId);
  assert.equal(completed09Group.plannedParticipants.find((item) => item.userId === 'stage7_employee_09')?.status, 'active');
  const completed09Message = runtime.store.listMessages(session.id)
    .find((message) => message.metadata?.dispatchCommandId === offline09CommandId
      && message.role === 'assistant');
  assert.equal(completed09Message.id, partial09Dispatch.message.id, 'presence recovery must update the original waiting receipt');
  assert.equal(completed09Message.metadata.dispatchAwaitingPresence, false);
  assert.equal(completed09Message.metadata.dispatchPublished, true);
  assert.match(completed09Message.content, /已派发 3\/3 项分工；所有成员均已加入工作群并收到任务/);
  assert.equal(completed09Message.metadata.publishedRecipientCount, 3);
  assert.equal(completed09Message.metadata.pendingRecipientCount, 0);
  assert.deepEqual(completed09Message.metadata.pendingRecipientIds, []);
  assert.deepEqual(completed09Message.metadata.pendingRecipientLabels, []);
  assert.equal(completed09Message.metadata.publishedTaskCards.length, 3,
    'the completed receipt must retain earlier task cards and append 09 exactly once');
  const replayed09Dispatch = await runtime.executeSecretaryDispatch({ sessionId: session.id, dispatch: offline09Ledger.command });
  assert.equal(replayed09Dispatch.idempotent, true);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations WHERE group_id=?').get(offline09GroupId).count, 3);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, offline09Before.delegations + 3);

  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('stage7_employee_c','c@example.com','王五','stage7_c',1)`).run();
  runtime.db.prepare(`INSERT INTO contact_organizations (
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES ('stage7_organization','STAGE7-ORG','Stage 7 组织','salt','hash',?)`).run(owner.id);
  runtime.db.prepare(`INSERT INTO contact_organization_members (organization_id,user_id,role)
    VALUES ('stage7_organization',?,'owner'),
           ('stage7_organization','stage7_employee_a','member'),
           ('stage7_organization','stage7_employee_b','member')`).run(owner.id);
  runtime.store.ensureAccountWorkspaces({ user: runtime.currentUser() });
  await runtime.switchAccountWorkspace({ workspaceId: 'workspace_personal' });
  const organizationSession = runtime.ensureSecretarySession();
  const organizationMention = {
    principalType: 'organization',
    organizationId: 'stage7_organization',
    audience: 'all_members',
    displayText: '@所有人',
    mentionId: 'stage7-organization-all',
    source: 'picker',
  };
  const organizationBefore = {
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const organizationProposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: organizationSession.id,
    message: '@所有人 请共同完成市场分析报告。',
    mentions: [organizationMention],
  });
  assert.equal(organizationProposal.uBuddyMode, 'awaiting_confirmation');
  assert.deepEqual(
    organizationProposal.message.metadata.uBuddyDispatchCommand.organizationAudienceSnapshot.memberUserIds,
    ['stage7_employee_a', 'stage7_employee_b'],
  );
  assert.equal(organizationProposal.message.metadata.uBuddyDispatchCommand.selectionMode, 'all_selected');
  assert.deepEqual({
    groups: runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, organizationBefore, 'organization audience must not dispatch before confirmation');

  runtime.db.prepare(`INSERT INTO contact_organization_members (organization_id,user_id,role)
    VALUES ('stage7_organization','stage7_employee_c','member')`).run();
  runtime.store.ensureAccountWorkspaces({ user: runtime.currentUser() });
  const staleOrganizationConfirmation = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: organizationSession.id,
    message: '确认派发',
  });
  assert.equal(staleOrganizationConfirmation.uBuddyMode, 'awaiting_confirmation');
  assert.equal(staleOrganizationConfirmation.membershipChanged, true);
  assert.deepEqual(
    staleOrganizationConfirmation.message.metadata.uBuddyDispatchCommand.organizationAudienceSnapshot.memberUserIds,
    ['stage7_employee_a', 'stage7_employee_b', 'stage7_employee_c'],
  );
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
    organizationBefore.delegations, 'a stale organization confirmation must not dispatch');
  const confirmedOrganization = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: organizationSession.id,
    message: '确认派发',
  });
  assert.equal(confirmedOrganization.uBuddyMode, 'dispatched');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
    organizationBefore.delegations + 3);
  assert.throws(() => runtime.auth.createCollaborationGroup({
    workspaceId: 'workspace_personal',
    clientRequestId: 'stage7-forged-organization-audience',
    title: '伪造组织受众不得建群',
    assignments: [{ recipientId: 'stage7_employee_c', instruction: '不得派发。' }],
    metadata: {
      organizationAudienceSnapshot: {
        ...staleOrganizationConfirmation.message.metadata.uBuddyDispatchCommand.organizationAudienceSnapshot,
        membershipHash: 'forged-membership-hash',
      },
    },
  }), /任务群只能邀请当前好友或已确认的组织成员/);
  await runtime.switchAccountWorkspace({ workspaceId: 'workspace_personal' });

  const fallbackBefore = {
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const fallback = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 请自动筛选无 Profile 的候选人并完成市场分析。',
    mentions,
  });
  assert.equal(fallback.uBuddyMode, 'awaiting_confirmation');
  assert.equal(fallback.message.metadata.uBuddyCollaborationPlan.confirmationRequired, true);
  assert.deepEqual(fallback.message.metadata.uBuddyCollaborationPlan.selectedUserIds.sort(), ['stage7_employee_a', 'stage7_employee_b']);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, {
    commands: fallbackBefore.commands,
    delegations: fallbackBefore.delegations,
  }, 'missing Profiles may fall back to all mentioned users, but automatic division must still wait for confirmation');
  const cancelledFallback = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '取消派发',
  });
  assert.equal(cancelledFallback.uBuddyMode, 'cancelled');

  const directExplicit = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@我的uBuddy @张三 @李四 明确直聊分工：张三整理数据，李四写报告。',
    sourcePeerId: 'stage7_employee_a',
    sourceConversationId: `direct:${owner.id}:stage7_employee_a`,
    sourceMessageId: 'stage7-direct-explicit-source',
    mentions: [
      { principalType: 'ubuddy', ownerUserId: owner.id, displayText: '@我的uBuddy', mentionId: 'stage7-own-ubuddy', source: 'picker' },
      ...mentions,
    ],
  });
  assert.equal(directExplicit.dispatched, true, 'complete direct-chat assignments must pass the LLM gate and dispatch without auto-plan confirmation');
  assert.equal(directExplicit.tasks.length, 2);
  assert.deepEqual(directExplicit.tasks.map((item) => item.metadata.assignmentId).sort(), ['direct_data', 'direct_report']);

  const legacyClientCommand = {
    content: '@我的uBuddy @张三 @李四 请选择合适的人完成旧客户端兼容报告。',
    sourcePeerId: 'stage7_employee_a',
    sourceConversationId: `direct:${owner.id}:stage7_employee_a`,
    sourceMessageId: 'stage7-legacy-client-source',
    mentions: [
      { principalType: 'ubuddy', ownerUserId: owner.id, displayText: '@我的uBuddy', mentionId: 'stage7-legacy-own-ubuddy', source: 'picker' },
      ...mentions,
    ],
  };
  const legacyClientProposal = await runtime.dispatchCollaborationCommand(legacyClientCommand);
  assert.equal(legacyClientProposal.dispatched, false,
    'a legacy client new task must enter continuous planning instead of bypassing automatic-plan confirmation');
  assert.equal(legacyClientProposal.clarification?.reasonCode, 'automatic_collaboration_plan_requires_confirmation');
  await runtime.dispatchCollaborationCommand({ confirmationCommandId: legacyClientCommand.sourceMessageId });
  await waitFor(() => runtime.store.getUBuddyDispatchCommand(legacyClientCommand.sourceMessageId)?.status === 'published',
    () => `legacy client continuous-planning dispatch did not publish after confirmation: ${JSON.stringify(runtime.store.getUBuddyDispatchCommand(legacyClientCommand.sourceMessageId))}`);
  const legacyClientDispatch = await runtime.dispatchCollaborationCommand(legacyClientCommand);
  assert.equal(legacyClientDispatch.dispatched, true);
  assert.equal(legacyClientDispatch.tasks.length, 2);
  assert.deepEqual(legacyClientDispatch.tasks.map((item) => item.recipientUserId).sort(),
    ['stage7_employee_a', 'stage7_employee_b']);

  const naturalGroup = await runtime.createChatGroup({
    title: '多人 uBuddy 自动派发来源群',
    memberIds: ['stage7_employee_a', 'stage7_employee_b'],
    clientRequestId: 'stage7-natural-multi-source-group',
  });
  const naturalGroupId = naturalGroup.group.id;
  const naturalMentions = [
    { principalType: 'ubuddy', ownerUserId: 'stage7_employee_a', displayText: '@张三的uBuddy', mentionId: 'stage7-natural-a', source: 'picker' },
    { principalType: 'ubuddy', ownerUserId: 'stage7_employee_b', displayText: '@李四的uBuddy', mentionId: 'stage7-natural-b', source: 'picker' },
  ];
  const naturalAutoSource = await runtime.sendChatGroupMessage({
    groupId: naturalGroupId,
    clientMessageId: 'stage7-natural-auto-plan-source-message',
    content: '@张三的uBuddy @李四的uBuddy 请共同完成市场分析报告。',
    metadata: { mentions: naturalMentions, uBuddyMultiMention: { classification: 'multi_task' } },
  });
  const naturalAutoBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count;
  const naturalAutoDispatch = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 请共同完成市场分析报告。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: naturalAutoSource.messages.at(-1).id,
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(naturalAutoDispatch.queued, true);
  const naturalAutoLedger = await waitFor(
    () => runtime.store.getUBuddyDispatchCommand(naturalAutoSource.messages.at(-1).id)?.status === 'clarification'
      ? runtime.store.getUBuddyDispatchCommand(naturalAutoSource.messages.at(-1).id) : null,
    () => `natural-group automatic division must stop at confirmation instead of creating a task group: ${JSON.stringify(runtime.store.getUBuddyDispatchCommand(naturalAutoSource.messages.at(-1).id))}`,
  );
  assert.equal(naturalAutoLedger.result.reasonCode, 'automatic_collaboration_plan_requires_confirmation');
  assert.equal(naturalAutoLedger.command.collaborationPlan.confirmationRequired, true);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, naturalAutoBefore);
  const naturalSource = await runtime.sendChatGroupMessage({
    groupId: naturalGroupId,
    clientMessageId: 'stage7-natural-multi-source-message',
    content: '@张三的uBuddy @李四的uBuddy 明确群聊分工：张三整理数据，李四撰写报告。',
    metadata: {
      mentions: naturalMentions,
      uBuddyMultiMention: { classification: 'multi_task', commandId: 'stage7-natural-multi-dispatch' },
    },
  });
  const naturalDispatchBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count;
  const naturalDispatch = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 明确群聊分工：张三整理数据，李四撰写报告。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: naturalSource.messages.at(-1).id,
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(naturalDispatch.queued, true);
  const publishedNaturalLedger = await waitFor(
    () => runtime.store.getUBuddyDispatchCommand(naturalSource.messages.at(-1).id)?.status === 'published'
      ? runtime.store.getUBuddyDispatchCommand(naturalSource.messages.at(-1).id) : null,
    () => `natural-group dispatch must finish from the persistent background queue: ${JSON.stringify({
      ledger: runtime.store.getUBuddyDispatchCommand(naturalSource.messages.at(-1).id),
      statuses: runtime.auth.chatGroup(naturalGroupId).messages.filter((item) => item.metadata?.dispatchCommandId === naturalSource.messages.at(-1).id)
        .map((item) => ({ status: item.metadata?.status, content: item.content })),
    })}`,
  );
  const naturalReplayResult = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 明确群聊分工：张三整理数据，李四撰写报告。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: naturalSource.messages.at(-1).id,
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(publishedNaturalLedger.status, 'published');
  assert.equal(naturalReplayResult.dispatched, true);
  assert.equal(naturalReplayResult.tasks.length, 2);
  const naturalTasks = naturalReplayResult.tasks;
  const naturalGroupResult = naturalReplayResult.group;
  assert.deepEqual(naturalTasks.map((item) => item.recipientUserId).sort(), ['stage7_employee_a', 'stage7_employee_b']);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, naturalDispatchBefore + 2);
  const sourceStatuses = runtime.auth.chatGroup(naturalGroupId).messages.filter((item) => item.metadata?.type === 'ubuddy_multi_task_status');
  assert.ok(sourceStatuses.some((item) => item.metadata?.status === 'planning'));
  assert.equal(sourceStatuses.find((item) => item.metadata?.status === 'dispatched'
    && item.metadata?.dispatchCommandId === naturalSource.messages.at(-1).id)?.metadata?.collaborationGroupId, naturalGroupResult.id);
  const naturalReplay = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 明确群聊分工：张三整理数据，李四撰写报告。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: naturalSource.messages.at(-1).id,
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(naturalReplay.idempotent, true);
  assert.equal(runtime.auth.chatGroup(naturalGroupId).messages.filter((item) => item.metadata?.status === 'dispatched'
    && item.metadata?.dispatchCommandId === naturalSource.messages.at(-1).id).length, 1);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, naturalDispatchBefore + 2);
  const summariesBeforeSubmitted = runtime.auth.chatGroup(naturalGroupId).messages
    .filter((item) => item.metadata?.type === 'ubuddy_multi_task_summary').length;
  for (const task of naturalTasks) {
    runtime.db.prepare("UPDATE agent_delegations SET status='submitted',metadata_json=? WHERE id=?").run(
      JSON.stringify({ ...(task.metadata || {}), latestResult: `私人结果：${task.title} 已完成`, resultAttachments: [] }),
      task.id,
    );
  }
  await runtime.pollSocialNetwork();
  assert.equal(runtime.auth.chatGroup(naturalGroupId).messages
    .filter((item) => item.metadata?.type === 'ubuddy_multi_task_summary').length, summariesBeforeSubmitted,
  'submitted work must remain private and must not publish a terminal source-group summary before acceptance');
  runtime.db.prepare("UPDATE agent_delegations SET status='completed' WHERE id=?").run(naturalTasks[0].id);
  runtime.db.prepare("UPDATE agent_delegations SET status='result_accepted' WHERE id=?").run(naturalTasks[1].id);
  await runtime.pollSocialNetwork();
  const naturalSummaries = runtime.auth.chatGroup(naturalGroupId).messages
    .filter((item) => item.metadata?.type === 'ubuddy_multi_task_summary');
  assert.equal(naturalSummaries.length, summariesBeforeSubmitted + 1);
  assert.equal(naturalSummaries.at(-1).metadata.collaborationGroupId, naturalGroupResult.id);
  assert.doesNotMatch(naturalSummaries.at(-1).content, /私人结果/);
  await runtime.pollSocialNetwork();
  assert.equal(runtime.auth.chatGroup(naturalGroupId).messages
    .filter((item) => item.metadata?.type === 'ubuddy_multi_task_summary').length, summariesBeforeSubmitted + 1,
  'repeated polling must not duplicate the source-group completion summary');
  runtime.db.prepare("UPDATE agent_delegations SET status='rejected',updated_at='2026-08-05T12:00:00.000Z' WHERE id=?")
    .run(naturalTasks[0].id);
  await runtime.pollSocialNetwork();
  const revisedNaturalSummaries = runtime.auth.chatGroup(naturalGroupId).messages
    .filter((item) => item.metadata?.type === 'ubuddy_multi_task_summary');
  assert.equal(revisedNaturalSummaries.length, summariesBeforeSubmitted + 2, 'a terminal revision must publish a new versioned source-group summary');
  assert.notEqual(revisedNaturalSummaries.at(-2).metadata.summaryRevision, revisedNaturalSummaries.at(-1).metadata.summaryRevision);

  const retrySource = await runtime.sendChatGroupMessage({
    groupId: naturalGroupId,
    clientMessageId: 'stage7-natural-retry-source',
    content: '@张三的uBuddy @李四的uBuddy 后台重试验证：张三整理数据，李四撰写报告。',
    metadata: { mentions: naturalMentions, uBuddyMultiMention: { classification: 'multi_task' } },
  });
  const retryCommandId = retrySource.messages.at(-1).id;
  const queuedRetry = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 后台重试验证：张三整理数据，李四撰写报告。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: retryCommandId,
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(queuedRetry.queued, true);
  const retriedLedger = await waitFor(
    () => runtime.store.getUBuddyDispatchCommand(retryCommandId)?.status === 'published'
      ? runtime.store.getUBuddyDispatchCommand(retryCommandId) : null,
    'a retry_wait natural-group job must schedule and complete its second attempt',
    10_000,
  );
  assert.equal(retriedLedger.attemptCount, 2);
  assert.ok(runtime.auth.chatGroup(naturalGroupId).messages.some((item) => (
    item.metadata?.dispatchCommandId === retryCommandId && item.metadata?.status === 'retry_wait'
  )));
  const highRiskBefore = runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count;
  const highRisk = await runtime.dispatchCollaborationCommand({
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    content: '@张三的uBuddy @李四的uBuddy 请删除生产数据库并公开发布结果。',
    mentions: naturalMentions,
    sourceType: 'natural_chat_group',
    sourceConversationId: `chat-group:${naturalGroupId}`,
    sourceMessageId: 'stage7-natural-high-risk-source',
    sourceGroupId: naturalGroupId,
    participantPolicy: 'all_mentioned',
    autoExecutionPolicy: 'low_medium_risk',
  });
  assert.equal(highRisk.dispatched, false);
  assert.equal(highRisk.clarification.reasonCode, 'high_risk_confirmation_required');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, highRiskBefore);
  const confirmationCard = runtime.auth.chatGroup(naturalGroupId).messages.find((item) => (
    item.metadata?.status === 'confirmation_required'
    && item.metadata?.confirmationCommandId === 'stage7-natural-high-risk-source'
  ));
  assert.ok(confirmationCard, 'high-risk natural-group work must publish a usable confirmation card');
  const confirmedHighRisk = await runtime.dispatchCollaborationCommand({ confirmationCommandId: 'stage7-natural-high-risk-source' });
  assert.equal(confirmedHighRisk.confirmationAccepted, true);
  const confirmedHighRiskLedger = await waitFor(
    () => runtime.store.getUBuddyDispatchCommand('stage7-natural-high-risk-source')?.status === 'clarification'
      && runtime.store.getUBuddyDispatchCommand('stage7-natural-high-risk-source')?.result?.reasonCode === 'automatic_collaboration_plan_requires_confirmation'
      ? runtime.store.getUBuddyDispatchCommand('stage7-natural-high-risk-source') : null,
    () => `high-risk confirmation may resume planning, but an automatic division plan must still wait for confirmation: ${JSON.stringify(runtime.store.getUBuddyDispatchCommand('stage7-natural-high-risk-source'))}`,
  );
  assert.equal(confirmedHighRiskLedger.result.reasonCode, 'automatic_collaboration_plan_requires_confirmation');
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, highRiskBefore);

  const highRiskUBuddy = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 请删除生产数据库并公开发布结果。',
    mentions,
  });
  assert.equal(highRiskUBuddy.uBuddyMode, 'awaiting_confirmation');
  assert.equal(highRiskUBuddy.message.metadata.reasonCode, 'high_risk_confirmation_required');

  const peer = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@张三 @李四 张三整理数据，李四写报告，我负责 PPT。',
    mentions,
  });
  assert.equal(peer.uBuddyMode, 'dispatched', 'a complete user-explicit peer plan must skip confirmation');
  assert.equal(peer.message.metadata.uBuddyCollaborationPlan.assignmentSource, 'explicit_user');
  assert.equal(peer.message.metadata.uBuddyCollaborationPlan.collaborationMode, 'peer_collaboration');
  assert.ok(peer.taskRunId || peer.task?.id, 'peer collaboration must create an automatic local initiator task');
  assert.ok(peer.group?.group?.id || peer.group?.id, 'remote peers must receive a collaboration group');
  const peerTaskId = peer.taskRunId || peer.task.id;
  assert.equal(runtime.store.getTaskRun(peerTaskId).metadata.externalDependencyState, 'waiting');
  const peerGroupId = peer.group?.group?.id || peer.group?.id;
  const peerDelegations = runtime.db.prepare('SELECT id,metadata_json FROM agent_delegations WHERE group_id=? ORDER BY id').all(peerGroupId);
  for (const [index, delegation] of peerDelegations.entries()) {
    const metadata = JSON.parse(delegation.metadata_json || '{}');
    runtime.db.prepare("UPDATE agent_delegations SET status='submitted',metadata_json=? WHERE id=?").run(
      JSON.stringify({ ...metadata, latestResult: `公开结果 ${index + 1}`, resultAttachments: [] }),
      delegation.id,
    );
  }
  await runtime.pollSocialNetwork();
  assert.equal(runtime.store.getTaskRun(peerTaskId).metadata.externalDependencyState, 'waiting',
    'submitted upstream work must not unlock downstream execution before acceptance');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id=? AND json_extract(metadata_json,'$.type')='ubuddy_dependency_handoff' AND json_extract(metadata_json,'$.handoffState')='accepted'").get(peerGroupId).count, 0);
  runtime.db.prepare("UPDATE agent_delegations SET status='result_accepted',metadata_json=json_set(metadata_json,'$.resultAcceptedAt',?) WHERE group_id=?")
    .run(new Date().toISOString(), peerGroupId);
  await runtime.pollSocialNetwork();
  const activatedPeerTask = runtime.store.getTaskRun(peerTaskId);
  assert.equal(activatedPeerTask.metadata.externalDependencyState, 'ready');
  assert.equal(activatedPeerTask.metadata.externalDependencyResults.length, 2);
  const handoffs = runtime.db.prepare("SELECT metadata_json FROM collaboration_group_messages WHERE group_id=? AND json_extract(metadata_json,'$.type')='ubuddy_dependency_handoff'").all(peerGroupId);
  assert.ok(handoffs.length >= 2, 'confirmed public upstream results must be published as dependency handoffs');
  const firstPeerDelegation = peerDelegations[0];
  runtime.db.prepare("UPDATE agent_delegations SET status='revision_requested' WHERE id=?").run(firstPeerDelegation.id);
  await runtime.pollSocialNetwork();
  const invalidatedPeerTask = runtime.store.getTaskRun(peerTaskId);
  assert.equal(invalidatedPeerTask.metadata.externalDependencyState, 'invalidated');
  runtime.db.prepare("UPDATE agent_delegations SET status='result_accepted',metadata_json=json_set(metadata_json,'$.latestResult','新版公开结果','$.resultAcceptedAt',?) WHERE id=?")
    .run(new Date().toISOString(), firstPeerDelegation.id);
  await runtime.pollSocialNetwork();
  const continuedPeerTask = runtime.store.getTaskRun(peerTaskId);
  assert.ok(continuedPeerTask.metadata.externalDependencySuccessorTaskRunId, 're-accepted dependency must create a successor task');
  const successor = runtime.store.getTaskRun(continuedPeerTask.metadata.externalDependencySuccessorTaskRunId);
  assert.equal(successor.metadata.parentTaskRunId, peerTaskId);
  assert.equal(successor.metadata.externalDependencyState, 'ready');
  console.log('uBuddy collaboration Stage 7 runtime smoke passed');
} finally {
  SocialRelayService.prototype.queryRecipientPresence = originalQueryRecipientPresence;
  SocialRelayService.prototype.collaborationPlannedParticipantsSupported = originalCollaborationPlannedParticipantsSupported;
  SocialRelayService.prototype.connected = originalConnected;
  SocialRelayService.prototype.poll = originalPoll;
  SocialRelayService.prototype.delegationCreateIdempotencySupported = originalDelegationCreateIdempotencySupported;
  SocialRelayService.prototype.updateCollaborationGroup = originalUpdateCollaborationGroup;
  runtime?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
