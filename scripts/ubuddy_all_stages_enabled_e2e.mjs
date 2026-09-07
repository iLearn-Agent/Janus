import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-all-stages-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-all-stages-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const managedEnvKeys = [
  'JANUS_CODEX_BIN',
  'JANUS_UBUDDY_NEW_TASK_WORKSPACE_UI',
  'JANUS_UBUDDY_NEW_DISPATCH_STRATEGY',
  'JANUS_UBUDDY_NEW_PROCESS_EVENT_STREAM',
  'JANUS_UBUDDY_INTAKE_CLARIFICATION_V2',
  'JANUS_STRUCTURED_TASK_REFERENCE_V1',
  'JANUS_UBUDDY_PROFILE_PREVIEW_V1',
  'JANUS_UBUDDY_PROFILE_PREVIEW',
  'JANUS_UBUDDY_PROFILE_HISTORY',
  'JANUS_UBUDDY_PROFILE_PUBLICATION',
  'JANUS_UBUDDY_PROFILE_ROUTING_SHADOW_V1',
  'JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1',
  'JANUS_UBUDDY_AGENT_WORK_DETAIL_PROJECTION',
  'JANUS_BOUNDED_DELIVERY_REWORK_V1',
];
const previousEnv = Object.fromEntries(managedEnvKeys.map((key) => [key, process.env[key]]));

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
const assignmentFailureState = ${JSON.stringify(path.join(root, 'assignment-failure-count.txt'))};
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
function responseFor(input) {
  if (input.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
    const current = input.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
    const users = JSON.parse(input.match(/Structured users mentioned in this intake:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const base = {
      version: 'ubuddy_task_intake_v1', objective: current.includes('技术失败重试卡测试') ? '技术失败重试卡测试：完成跨用户市场分析' : '完成跨用户市场分析', acceptanceCriteria: [], constraints: [],
      deadline: '', candidateUsers: users, requiredUsers: [], attachments: [], privacyScope: 'direct_delegation', riskLevel: 'medium',
    };
    if (current.includes('信息不完整')) return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
      intake: { ...base, state: 'needs_clarification', deliverables: [], missingFields: ['deliverables'],
        clarification: { reasonCode: 'missing_deliverable_type', question: '最终需要什么交付物？', options: ['报告', 'PPT'] } },
    });
    return JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: true,
      intake: { ...base, state: 'ready', deliverables: ['市场分析报告'], missingFields: [],
        clarification: { reasonCode: '', question: '', options: [] } },
    });
  }
  if (input.includes('【UBUDDY_TASK_READINESS_AUDIT_V1】')) {
    return JSON.stringify({
      version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true, reason: '测试任务已具备派发条件',
      clarifications: [], criticalUnknowns: [],
    });
  }
  if (input.includes('【UBUDDY_COLLABORATION_MODE_DECISION_V1】')) {
    const current = input.split('Current request: ').at(-1)?.split('\\n\\nSchema:')[0] || '';
    if (current.includes('模式恢复失败测试')) return 'INVALID_COLLABORATION_MODE';
    if (current.includes('模式主动澄清测试')) return JSON.stringify({
      version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1', decision: 'clarification', collaborationMode: 'manager_delegation',
      initiatorParticipation: 'coordinator_only', assignmentIntent: 'auto', participantSelectionIntent: 'all',
      explicitAssignments: [], confidence: 0.7,
      clarification: { reasonCode: 'initiator_participation_ambiguous', question: '发起人是否也参与工作？', options: ['只负责协调，其他人完成', '我也参与并承担工作'] },
    });
    return JSON.stringify({
      version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1', decision: 'ready', collaborationMode: 'manager_delegation',
      initiatorParticipation: 'coordinator_only', assignmentIntent: 'auto', participantSelectionIntent: 'auto',
      explicitAssignments: [], confidence: 0.94, clarification: { reasonCode: '', question: '', options: [] },
    });
  }
  if (input.includes('【UBUDDY_COLLABORATION_ASSIGNMENT_PLAN_V1】')) {
    if (input.includes('技术失败重试卡测试')) {
      const attempt = Number(fs.existsSync(assignmentFailureState) ? fs.readFileSync(assignmentFailureState, 'utf8') : '0') + 1;
      fs.writeFileSync(assignmentFailureState, String(attempt), 'utf8');
      if (attempt <= 2) return 'INVALID_ASSIGNMENT_PLAN';
    }
    const users = JSON.parse(input.split('Selected structured users: ')[1]?.split('\\n')[0] || '[]');
    const peer = input.includes('"collaborationMode":"peer_collaboration"');
    const assignments = users.map((user, index) => ({
      assignmentId: 'all_stages_' + (index + 1), assigneeKind: 'user', userId: user.userId,
      title: index === 0 ? '整理市场数据' : '撰写分析报告',
      objective: index === 0 ? '整理并核验市场数据' : '根据数据撰写完整分析报告',
      deliverables: index === 0 ? ['数据表'] : ['分析报告'], dependencies: [],
    }));
    if (peer) assignments.push({
      assignmentId: 'all_stages_self', assigneeKind: 'self', userId: '', title: '发起人整合材料',
      objective: '整合远程参与人的结果并完成最终交付', deliverables: ['最终报告'],
      dependencies: users.map((_, index) => 'all_stages_' + (index + 1)),
    });
    return JSON.stringify({
      version: 'UBUDDY_COLLABORATION_PLAN_V1', proposalId: 'ignored', revision: 1,
      status: 'awaiting_confirmation', collaborationMode: peer ? 'peer_collaboration' : 'manager_delegation',
      initiatorParticipation: peer ? 'coordinator_and_worker' : 'coordinator_only',
      assignmentSource: 'ubuddy_planned', assignments, finalIntegrator: 'self_ubuddy', confirmationRequired: true, confidence: 0.9,
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
    if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'ubuddy-all-stages' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') emit({ id: message.id, result: { thread: { id: 'ubuddy-all-stages-thread' } } });
    else if (message.method === 'turn/start') {
      const input = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const response = responseFor(input);
      emit({ id: message.id, result: { turn: { id: 'ubuddy-all-stages-turn' } } });
      emit({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'ubuddy-all-stages-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
    } else emit({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = responseFor(stdin);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-all-stages-thread' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`, 'utf8');
chmodSync(fakeCodex, 0o755);
for (const key of managedEnvKeys) delete process.env[key];
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'on';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'on';

let runtime = null;
const originalQueryRecipientPresence = SocialRelayService.prototype.queryRecipientPresence;
SocialRelayService.prototype.queryRecipientPresence = async function queryRecipientPresenceForAllStagesE2E({ userIds = [] } = {}) {
  return { items: userIds.map((userId) => ({ userId, online: true, lastSeenAt: new Date().toISOString() })) };
};
try {
  runtime = await createRuntime({ root, isDev: false, serverAuthoritativeSkills: true });
  const owner = runtime.currentUser();
  const flags = (await runtime.bootstrap()).uBuddyFeatureFlags;
  for (const key of [
    'newTaskWorkspaceUi', 'newDispatchStrategy', 'newProcessEventStream', 'intakeClarificationV2',
    'structuredTaskReference', 'profilePreviewV1', 'profilePreview', 'profileHistory', 'profilePublication',
    'profileRoutingShadow', 'profileRoutingAuto', 'agentWorkDetailProjection', 'boundedDeliveryReworkV1',
  ]) assert.equal(flags[key], true, `${key} must be enabled by the production default`);
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: owner.id }).enabled, false,
    'default-on Profile capability must not publish without owner authorization');

  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('all_stages_a','all-stages-a@example.com','默认开启甲','all_stages_a',1),
           ('all_stages_b','all-stages-b@example.com','默认开启乙','all_stages_b',1)`).run();
  for (const [friendshipId, peerId] of [
    ['all_stages_friend_a', 'all_stages_a'],
    ['all_stages_friend_b', 'all_stages_b'],
  ]) {
    const [userA, userB] = [owner.id, peerId].sort();
    runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
      VALUES (?,?,?,'accepted')`).run(friendshipId, userA, userB);
  }
  const session = runtime.ensureSecretarySession();
  const clientCapabilities = {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    taskReferenceVersion: 'structured_task_reference_v1',
  };
  const mentions = [
    { principalType: 'user', userId: 'all_stages_a', displayText: '@默认开启甲', mentionId: 'all-stages-a', source: 'picker' },
    { principalType: 'user', userId: 'all_stages_b', displayText: '@默认开启乙', mentionId: 'all-stages-b', source: 'picker' },
  ];
  const before = {
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const clarification = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id, message: '@默认开启甲 @默认开启乙 信息不完整，请协作处理。', mentions,
  });
  assert.equal(clarification.uBuddyMode, 'clarification');
  assert.match(clarification.answer, /最终需要什么交付物/);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count, before.commands);

  const proposal = await runtime.secretaryChat({ ...clientCapabilities, sessionId: session.id, message: '最终交付报告。' });
  assert.equal(proposal.uBuddyMode, 'awaiting_confirmation');
  assert.equal(proposal.collaborationPlan.selectionDecision.strategyVersion,
    'all_mentioned_confirmation_v1');
  assert.deepEqual(proposal.collaborationPlan.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  assert.match(proposal.answer, /请确认后再派发/);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, before, 'clarification and confirmation proposal must not dispatch work');

  const confirmed = await runtime.secretaryChat({ ...clientCapabilities, sessionId: session.id, message: '确认派发' });
  assert.equal(confirmed.uBuddyMode, 'dispatched');
  const ledger = runtime.db.prepare('SELECT command_id,status,command_json FROM ubuddy_dispatch_commands').get();
  assert.equal(ledger.status, 'published');
  const frozen = JSON.parse(ledger.command_json);
  assert.equal(frozen.selectionDecision.strategyVersion, 'all_mentioned_confirmation_v1');
  assert.deepEqual(frozen.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, before.delegations + 2);
  const repeated = await runtime.executeSecretaryDispatch({ sessionId: session.id, dispatch: frozen });
  assert.equal(repeated.idempotent, true);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count, before.delegations + 2);

  const recoveryBefore = {
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const modeFailure = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@默认开启甲 @默认开启乙 模式恢复失败测试：分别完成两部分市场分析。',
    mentions,
  });
  assert.equal(modeFailure.uBuddyMode, 'clarification');
  assert.equal(modeFailure.message.metadata.uBuddyCollaborationClarification.version,
    'UBUDDY_COLLABORATION_CLARIFICATION_V1');
  assert.deepEqual(modeFailure.message.metadata.uBuddyCollaborationClarification.candidateUserIds.sort(),
    ['all_stages_a', 'all_stages_b']);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, recoveryBefore, 'a collaboration-mode failure must only persist resumable context');

  runtime.close();
  runtime = await createRuntime({ root, isDev: false, serverAuthoritativeSkills: true });
  const resumedManager = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '只负责协调，其他人完成',
  });
  assert.equal(resumedManager.uBuddyMode, 'awaiting_confirmation', JSON.stringify(resumedManager));
  assert.equal(resumedManager.collaborationPlan.collaborationMode, 'manager_delegation');
  assert.equal(resumedManager.collaborationPlan.initiatorParticipation, 'coordinator_only');
  assert.deepEqual(resumedManager.collaborationPlan.candidateUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  assert.deepEqual(resumedManager.collaborationPlan.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  const continuationSource = runtime.store.getMessage(resumedManager.message.metadata.sourceMessageId);
  assert.equal(continuationSource.metadata.uBuddyCollaborationClarificationResponse.answer, '只负责协调，其他人完成');
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, recoveryBefore, 'resuming mode clarification must still wait for plan confirmation');
  const repeatedManagerAnswer = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '只负责协调，其他人完成',
  });
  assert.equal(repeatedManagerAnswer.idempotent, true);
  assert.equal(repeatedManagerAnswer.message.id, resumedManager.message.id);
  const cancelledManagerProposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '取消派发',
  });
  assert.equal(cancelledManagerProposal.uBuddyMode, 'cancelled');

  const modelClarification = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@默认开启甲 @默认开启乙 模式主动澄清测试：共同完成市场分析。',
    mentions,
  });
  assert.equal(modelClarification.uBuddyMode, 'clarification');
  assert.equal(modelClarification.message.metadata.uBuddyCollaborationClarification.reasonCode,
    'initiator_participation_ambiguous');
  const resumedPeer = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '我也参与并承担工作',
  });
  assert.equal(resumedPeer.uBuddyMode, 'awaiting_confirmation');
  assert.equal(resumedPeer.collaborationPlan.collaborationMode, 'peer_collaboration');
  assert.equal(resumedPeer.collaborationPlan.initiatorParticipation, 'coordinator_and_worker');
  assert.equal(resumedPeer.collaborationPlan.assignments.filter((item) => item.assigneeKind === 'self').length, 1);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, recoveryBefore, 'peer-mode clarification must not dispatch before confirmation');
  const cancelledPeerProposal = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '取消派发',
  });
  assert.equal(cancelledPeerProposal.uBuddyMode, 'cancelled');

  const cancellableClarification = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@默认开启甲 @默认开启乙 模式恢复失败测试：验证澄清取消。',
    mentions,
  });
  assert.equal(cancellableClarification.uBuddyMode, 'clarification');
  const cancelledClarification = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '取消派发',
  });
  assert.equal(cancelledClarification.uBuddyMode, 'cancelled');
  assert.equal(cancelledClarification.message.metadata.uBuddyCollaborationClarificationCancelled, true);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, recoveryBefore, 'cancelling a pending collaboration clarification must not create work');

  const technicalFailureBefore = {
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  };
  const assignmentFailure = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '@默认开启甲 @默认开启乙 技术失败重试卡测试：共同完成市场分析。',
    mentions,
  });
  assert.equal(assignmentFailure.uBuddyMode, 'collaboration_planning_failed');
  assert.equal(assignmentFailure.message.metadata.dispatchClarification, undefined);
  assert.equal(assignmentFailure.message.metadata.uBuddyCollaborationPlanningFailure.status, 'retryable');
  assert.equal(assignmentFailure.message.metadata.uBuddyCollaborationPlanningFailure.code, 'collaboration_assignment_invalid_json');
  assert.deepEqual(assignmentFailure.message.metadata.uBuddySelection.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, technicalFailureBefore, 'technical assignment failure must not dispatch work');
  const assignmentFailureMessageId = assignmentFailure.message.id;
  runtime.close();
  runtime = await createRuntime({ root, isDev: false, serverAuthoritativeSkills: true });
  const persistedAssignmentFailure = runtime.store.getMessage(assignmentFailureMessageId);
  assert.equal(persistedAssignmentFailure.metadata.uBuddyCollaborationPlanningFailure.status, 'retryable');
  assert.deepEqual(persistedAssignmentFailure.metadata.uBuddySelection.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  const regeneratedAssignment = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '重新生成分工方案',
  });
  assert.equal(regeneratedAssignment.uBuddyMode, 'awaiting_confirmation', JSON.stringify(regeneratedAssignment));
  assert.equal(regeneratedAssignment.message.id, assignmentFailureMessageId);
  assert.equal(regeneratedAssignment.message.metadata.uBuddyCollaborationPlanningFailure.status, 'resolved');
  assert.deepEqual(regeneratedAssignment.collaborationPlan.selectedUserIds.sort(), ['all_stages_a', 'all_stages_b']);
  assert.deepEqual({
    commands: runtime.db.prepare('SELECT COUNT(*) AS count FROM ubuddy_dispatch_commands').get().count,
    delegations: runtime.db.prepare('SELECT COUNT(*) AS count FROM agent_delegations').get().count,
  }, technicalFailureBefore, 'regenerated assignment must still wait for owner confirmation');
  const cancelledRegeneratedAssignment = await runtime.secretaryChat({
    ...clientCapabilities,
    sessionId: session.id,
    message: '取消派发',
  });
  assert.equal(cancelledRegeneratedAssignment.uBuddyMode, 'cancelled');

  delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  runtime.store.settingSet('ubuddy:feature_flags:v1', JSON.stringify({
    ubuddy_profile_routing_auto_v1: false,
    bounded_delivery_rework_v1: 0,
  }));
  const disabled = (await runtime.bootstrap()).uBuddyFeatureFlags;
  assert.equal(disabled.profileRoutingAuto, false);
  assert.equal(disabled.boundedDeliveryReworkV1, false);
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log('uBuddy all stages explicitly-enabled E2E passed');
} finally {
  SocialRelayService.prototype.queryRecipientPresence = originalQueryRecipientPresence;
  runtime?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
