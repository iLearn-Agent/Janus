import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime, normalizeSecretaryDispatchCommand } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';
import {
  findPendingUBuddyTaskIntake,
  resolveUBuddyIntakeDispatchAuthorization,
  validateUBuddyTaskIntakeDecision,
} from '../src/main/modules/orchestration/application/uBuddyTaskIntakePlanner.js';
import {
  UBUDDY_MESSAGE_MODE_VERSION,
  resolveUBuddyMessageMode,
} from '../src/shared/contracts/uBuddyMessageMode.js';

assert.deepEqual(resolveUBuddyMessageMode({ enabled: false, version: UBUDDY_MESSAGE_MODE_VERSION, mode: 'ask' }), {
  enabled: false, version: '', mode: 'legacy',
});
assert.deepEqual(resolveUBuddyMessageMode({ enabled: true, version: UBUDDY_MESSAGE_MODE_VERSION }), {
  enabled: true, version: UBUDDY_MESSAGE_MODE_VERSION, mode: 'task',
});
assert.throws(() => resolveUBuddyMessageMode({
  enabled: true, version: UBUDDY_MESSAGE_MODE_VERSION, mode: 'invalid',
}), /Unsupported uBuddy message mode/);
assert.equal(validateUBuddyTaskIntakeDecision({
  version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', intake: null,
}).taskIntent, false);
assert.equal(resolveUBuddyIntakeDispatchAuthorization({
  intakeDecision: {
    taskIntent: true,
    action: 'collect_context',
    intake: { state: 'ready', objective: '任务模式测试', deliverables: ['报告'] },
  },
  hasStagedContext: true,
  composerTaskMode: true,
}).reasonCode, 'composer_task_mode');

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-message-mode-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-message-mode-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousFlag = process.env.JANUS_UBUDDY_MESSAGE_MODE_V1;
const previousProfileRoutingFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const previousStructuredTaskReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && ['message-mode-query', 'message-mode-update'].includes(String(message.id))) {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const answer = String(message.id) === 'message-mode-query'
        ? 'TASK_MODE_QUERY_OK：' + (payload.answer || '')
        : payload.ok ? 'TASK_MODE_UPDATE_OK' : 'TASK_MODE_UPDATE_FAILED';
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-message-mode-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      continue;
    }
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-message-mode-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'ubuddy-message-mode-thread' } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'ubuddy-message-mode-turn' } } });
      const prompt = message.params?.input?.[0]?.text || '';
      const taskReference = JSON.parse(prompt.match(/Current structured task reference:\\n([^\\n]+)/)?.[1] || 'null');
      const ownerMessage = prompt.split('Current owner message:\\n').at(-1) || '';
      const plannerPrompt = /【UBUDDY_(?:CONTINUOUS_PLANNING_V1|CONTINUOUS_PLANNING_REPAIR_V1|TASK_READINESS_AUDIT_V1|TASK_INTAKE_DECISION_V2|COLLABORATION_MODE_DECISION_V1|COLLABORATION_ASSIGNMENT_PLAN_V1|TURN_DECISION_V2)】/.test(prompt);
      if (!plannerPrompt && taskReference?.taskRunId && /补充|增加|修改/.test(ownerMessage)) {
        send({ id: 'message-mode-update', method: 'item/tool/call', params: {
          threadId: 'ubuddy-message-mode-thread', turnId: 'ubuddy-message-mode-turn', callId: 'message-mode-update',
          namespace: 'janus', tool: 'update_task', arguments: { action: 'supplement', content: ownerMessage },
        } });
      } else if (!plannerPrompt && ownerMessage.includes('TASK_MODE_QUERY')) {
        send({ id: 'message-mode-query', method: 'item/tool/call', params: {
          threadId: 'ubuddy-message-mode-thread', turnId: 'ubuddy-message-mode-turn', callId: 'message-mode-query',
          namespace: 'janus', tool: 'query_work', arguments: { query: 'progress' },
        } });
      } else {
        const answer = plannerPrompt ? responseForInput(prompt) : 'ASK_READ_ONLY_OK';
        send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
        send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-message-mode-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      }
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
function responseForInput(stdin) {
let response = 'TASK_EXECUTION_OK';
if (stdin.includes('【UBUDDY_CONTINUOUS_PLANNING_V1】')) {
  const current = stdin.split('Current request: ').at(-1)?.split('\\n\\nSchema:')[0] || '';
  const users = JSON.parse(stdin.split('Authorized remote users: ')[1]?.split('\\n')[0] || '[]');
  const agents = JSON.parse(stdin.split('Authorized local Agent candidates: ')[1]?.split('\\n')[0] || '[]');
  const general = agents.find((item) => item.agentId === 'general_agent') || agents[0];
  if (current.includes('TASK_MODE_INVALID_DIRECT')) return JSON.stringify({
    version: 'UBUDDY_PLANNING_DECISION_V1', decision: 'direct_answer', confidence: 0.99, answer: 'invalid downgrade', intake: null,
    target: { kind: 'direct', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [], selectedAgentInstanceIds: [] },
    collaboration: { mode: 'manager_delegation', initiatorParticipation: 'coordinator_only', participantSelectionIntent: 'all', assignmentIntent: 'auto' },
    assignments: [], clarifications: [], readiness: { status: 'ready', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: [] },
    riskLevel: 'low', rationale: 'invalid direct downgrade fixture',
  });
  const clarification = current.trim().startsWith('TASK_MODE_VAGUE')
    && !current.includes('书面报告，继续执行') && !current.includes('deliverables: 书面报告');
  const questions = clarification ? [{ id: 'deliverables', header: '交付物', question: '最终交付物是什么？', reason: '缺少交付物',
    answerType: 'single_choice', options: [{ value: '书面报告', label: '书面报告' }, { value: '演示文稿', label: '演示文稿' }], allowOther: true, required: true }] : [];
  const targetKind = users.length > 1 ? 'task_group' : users.length === 1 ? 'external_delegation' : 'local_agent';
  const assignments = users.length ? users.map((item, index) => ({ assignmentId: 'user_' + (index + 1), assigneeKind: 'user', userId: item.userId,
    agentInstanceId: '', title: index ? '撰写报告' : '整理资料', objective: index ? '撰写最终报告' : '整理并校验资料',
    deliverables: [index ? '书面报告' : '资料摘要'], dependencies: index ? ['user_1'] : [] }))
    : general ? [{ assignmentId: 'local', assigneeKind: 'agent', userId: '', agentInstanceId: general.agentInstanceId,
      title: '完成任务', objective: current, deliverables: ['书面报告'], dependencies: [] }] : [];
  response = JSON.stringify({
    version: 'UBUDDY_PLANNING_DECISION_V1', decision: clarification ? 'awaiting_clarification' : 'ready_for_dispatch', confidence: 0.96, answer: '',
    intake: { version: 'ubuddy_task_intake_v1', state: clarification ? 'needs_clarification' : 'ready', taskKind: 'general', workReportSpec: null,
      objective: current, deliverables: clarification ? [] : ['书面报告'], acceptanceCriteria: [], constraints: [], deadline: '',
      candidateUsers: users, requiredUsers: users, attachments: [], privacyScope: users.length > 1 ? 'task_group_public' : users.length ? 'direct_delegation' : 'owner_private',
      riskLevel: 'low', missingFields: clarification ? ['deliverables'] : [], clarifications: questions,
      executionPlan: { summary: '执行测试任务', steps: ['完成任务'], requiredInputs: [] }, knownFacts: [], safeAssumptions: [],
      criticalUnknowns: clarification ? [{ id: 'deliverables', name: '交付物', reason: '缺少交付物', questionId: 'deliverables' }] : [],
      readiness: { status: clarification ? 'needs_clarification' : 'ready', reason: '' } },
    target: { kind: targetKind, candidateUserIds: users.map((item) => item.userId), requiredUserIds: users.map((item) => item.userId),
      selectedUserIds: users.map((item) => item.userId), selectedAgentInstanceIds: users.length || !general ? [] : [general.agentInstanceId] },
    collaboration: { mode: 'manager_delegation', initiatorParticipation: 'coordinator_only', participantSelectionIntent: 'all',
      assignmentIntent: current.includes('自动分工') || current.includes('@所有人') ? 'auto' : 'explicit' },
    assignments: clarification ? [] : assignments, clarifications: questions,
    readiness: { status: clarification ? 'needs_clarification' : 'ready', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: clarification ? ['deliverables'] : [] },
    riskLevel: 'low', rationale: '持续规划 smoke fixture',
  });
} else if (stdin.includes('【UBUDDY_TASK_READINESS_AUDIT_V1】')) {
  response = JSON.stringify({ version: 'UBUDDY_TASK_READINESS_AUDIT_V1', dispatchReady: true,
    executionPlan: { summary: '执行测试任务', steps: ['完成任务'], requiredInputs: [] }, knownFacts: [], safeAssumptions: [], criticalUnknowns: [], clarifications: [] });
} else if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const current = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  const mentionedUsers = JSON.parse(stdin.match(/Structured users mentioned in this intake:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const clarification = current.includes('信息不完整');
  response = current.includes('TASK_MODE_QUERY') || current.includes('TASK_MODE_INVALID_DIRECT') ? JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: false, intake: null,
  }) : JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true,
    action: current.includes('不要创建') ? 'collect_context' : 'dispatch_task', continuation: current.includes('继续'),
    intake: {
      version: 'ubuddy_task_intake_v1', state: clarification ? 'needs_clarification' : 'ready',
      objective: current, deliverables: clarification ? [] : ['书面报告'], acceptanceCriteria: [], constraints: [],
      deadline: '', candidateUsers: mentionedUsers, requiredUsers: mentionedUsers, attachments: [],
      privacyScope: mentionedUsers.length > 1 ? 'task_group_public' : mentionedUsers.length ? 'direct_delegation' : 'owner_private', riskLevel: 'low',
      missingFields: clarification ? ['deliverables'] : [],
      clarification: clarification
        ? { reasonCode: 'missing_deliverables', question: '最终交付物是什么？', options: ['书面报告', '演示文稿'] }
        : { reasonCode: '', question: '', options: [] },
    },
  });
} else if (stdin.includes('【UBUDDY_COLLABORATION_MODE_DECISION_V1】')) {
  const users = JSON.parse(stdin.split('Structured mentioned users: ')[1]?.split('\\n')[0] || '[]');
  const automatic = stdin.includes('自动分工');
  response = JSON.stringify({
    version: 'UBUDDY_COLLABORATION_MODE_DECISION_V1', decision: 'ready', collaborationMode: 'manager_delegation',
    initiatorParticipation: 'coordinator_only', assignmentIntent: automatic ? 'auto' : 'explicit', participantSelectionIntent: 'all',
    explicitAssignments: automatic ? [] : users.map((item, index) => ({
      assignmentId: 'explicit_' + (index + 1), assigneeKind: 'user', userId: item.userId,
      title: index === 0 ? '整理数据' : '撰写报告', objective: index === 0 ? '整理并校验数据' : '撰写最终报告',
      deliverables: [index === 0 ? '数据表' : '书面报告'], dependencies: index === 0 ? [] : ['explicit_1'],
    })),
    confidence: 0.96, clarification: { reasonCode: '', question: '', options: [] },
  });
} else if (stdin.includes('【UBUDDY_COLLABORATION_ASSIGNMENT_PLAN_V1】')) {
  const users = JSON.parse(stdin.split('Selected structured users: ')[1]?.split('\\n')[0] || '[]');
  response = JSON.stringify({
    version: 'UBUDDY_COLLABORATION_PLAN_V1', proposalId: 'ignored', revision: 1, status: 'awaiting_confirmation',
    collaborationMode: 'manager_delegation', initiatorParticipation: 'coordinator_only', assignmentSource: 'ubuddy_planned',
    assignments: users.map((item, index) => ({ assignmentId: 'auto_' + (index + 1), assigneeKind: 'user', userId: item.userId,
      title: index === 0 ? '整理资料' : '撰写报告', objective: index === 0 ? '整理任务资料' : '撰写任务报告',
      deliverables: [index === 0 ? '资料摘要' : '书面报告'], dependencies: [] })),
    finalIntegrator: 'self_ubuddy', confirmationRequired: true, confidence: 0.92,
    strategyVersion: 'ubuddy_collaboration_assignment_v1', createdAt: new Date().toISOString(), confirmedAt: '',
  });
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const general = candidates.find((item) => item.agentId === 'general_agent') || candidates[0];
  const current = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  response = current.includes('TASK_MODE_QUERY') ? JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.98, answer: '',
    routingRationale: '查询已有任务由完整 Codex 调用状态工具。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
  }) : JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.98,
    nodes: [{ localId: 'final', title: '完成任务模式请求', objective: current, agentId: general.agentId,
      agentInstanceId: general.agentInstanceId, dependencies: [], outputFormat: '书面报告', isFinal: true,
      blocking: true, fallback: '遇到阻塞时报告原因。' }],
    deliverables: [{ id: 'primary', role: 'primary', type: 'report', title: '书面报告', ownerLocalId: 'final',
      deliveryMode: 'inline', requiredExtensions: [], constraints: {} }],
    agentSelectionRationale: '由可用的通用 Agent 完成正式任务。', mentionedAgentsNotSelected: [],
    routingRationale: '任务模式要求正式 Scheduler 任务。',
  });
}
return response;
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = responseForInput(stdin);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'message-mode-planner' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`, 'utf8');
chmodSync(fakeCodex, 0o755);

let runtime;
try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_UBUDDY_MESSAGE_MODE_V1 = 'on';
  process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'on';
  process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'on';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('message_mode_contact','message-mode@example.com','模式联系人','message_mode_contact',1),
           ('message_mode_contact_b','message-mode-b@example.com','模式联系人乙','message_mode_contact_b',1)`).run();
  const [userA, userB] = [user.id, 'message_mode_contact'].sort();
  const [userC, userD] = [user.id, 'message_mode_contact_b'].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('message_mode_friendship',?,?,'accepted'),
           ('message_mode_friendship_b',?,?,'accepted')`).run(userA, userB, userC, userD);
  const session = runtime.ensureSecretarySession();
  const counts = () => ({
    tasks: runtime.store.listTaskRuns({ userId: user.id }).length,
    groups: runtime.db.prepare('SELECT COUNT(*) count FROM collaboration_groups').get().count,
    delegations: runtime.agentDelegations({ direction: 'outgoing' }).length,
  });
  const before = counts();
  const ask = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '@模式联系人 创建并立即派发一份报告。',
    mentions: [{
      principalType: 'user', userId: 'message_mode_contact', displayText: '@模式联系人',
      mentionId: 'message-mode-contact', source: 'picker',
    }],
  });
  assert.equal(ask.uBuddyMode, 'direct');
  assert.equal(ask.answer, 'ASK_READ_ONLY_OK');
  assert.equal(ask.message.metadata.uBuddyMessageMode, 'ask');
  assert.equal(ask.message.metadata.uBuddyExecutionMode, 'ask');
  assert.deepEqual(counts(), before, 'inquiry mode must not create tasks, groups, or delegations');

  const taskPayload = (message, extra = {}) => ({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'task',
    message,
    ...extra,
  });
  const local = await runtime.secretaryChat(taskPayload('TASK_MODE_LOCAL：整理本周项目进展并交付书面报告。'));
  assert.ok(local.taskRunId, 'task mode without @ must create a formal local task');
  assert.equal(local.task.metadata.uBuddyMessageMode, 'task');
  assert.equal(local.message.metadata.uBuddyTaskPublishProcess?.status, 'completed');
  assert.deepEqual(local.message.metadata.uBuddyTaskPublishProcess?.events.map((event) => event.activityId), [
    'ubuddy-task-publish:intake', 'ubuddy-task-publish:readiness',
    'ubuddy-task-publish:planning', 'ubuddy-task-publish:dispatching',
  ]);
  assert.equal(local.message.metadata.expanded, false);
  const localSource = runtime.store.getMessage(local.task.metadata.sourceSecretaryMessageId);
  assert.equal(localSource.metadata.uBuddyDispatchAuthorization.reasonCode, 'composer_task_mode');

  const askCancellationWithoutTarget = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    taskReferenceVersion: 'structured_task_reference_v1',
    message: '取消任务',
  });
  assert.equal(askCancellationWithoutTarget.uBuddyMode, 'task_reference_required');
  assert.equal(askCancellationWithoutTarget.taskReferenceRequired, true);
  assert.ok(askCancellationWithoutTarget.taskReferenceOptions.some((item) => item.taskRunId === local.taskRunId));
  assert.notEqual(runtime.store.getTaskRun(local.taskRunId).status, 'cancelled',
    'Ask cancellation without a structured target must not cancel the only active task');
  const askCancellationQuestion = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '取消任务会怎样？',
  });
  assert.equal(askCancellationQuestion.uBuddyMode, 'direct');
  assert.notEqual(runtime.store.getTaskRun(local.taskRunId).status, 'cancelled',
    'a question about cancellation must not execute cancellation');

  const askCancellationWithTarget = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '取消任务',
    taskReferenceVersion: 'structured_task_reference_v1',
    taskReference: {
      principalType: 'task', taskRunId: local.taskRunId, displayText: `@任务：${local.task.title}`,
    },
  });
  assert.equal(askCancellationWithTarget.uBuddyMode, 'task_cancel_control');
  assert.equal(askCancellationWithTarget.taskRunId, local.taskRunId);
  assert.ok(['cancelled', 'completed'].includes(runtime.store.getTaskRun(local.taskRunId).status));

  const taskModeCancellationTarget = runtime.store.createTaskRun({
    title: '任务模式取消兼容性', prompt: '任务模式取消兼容性', departmentId: 'general', ownerUserId: user.id,
    metadata: { userId: user.id, source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id },
  });
  runtime.store.updateTaskRunStatus(taskModeCancellationTarget.id, 'running', '验证任务模式原有取消行为。');
  const taskModeCancellation = await runtime.secretaryChat(taskPayload('取消任务'));
  assert.equal(taskModeCancellation.uBuddyMode, 'task_cancel_control');
  assert.equal(taskModeCancellation.task?.id, taskModeCancellationTarget.id);
  assert.equal(runtime.store.getTaskRun(taskModeCancellationTarget.id).status, 'cancelled',
    'Task mode must preserve the existing single-active-task cancellation behavior');

  const beforeNegated = runtime.store.listTaskRuns({ userId: user.id }).length;
  const negated = await runtime.secretaryChat(taskPayload('TASK_MODE_NEGATED：不要创建，只保存上下文；整理发布检查清单并交付书面报告。'));
  assert.ok(negated.taskRunId, 'composer task mode must override creation-negating prose');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeNegated + 1);
  const negatedSource = runtime.store.getMessage(negated.task.metadata.sourceSecretaryMessageId);
  assert.equal(negatedSource.metadata.uBuddyDispatchAuthorization.reasonCode, 'composer_task_mode');

  const beforeClarification = runtime.store.listTaskRuns({ userId: user.id }).length;
  const vague = await runtime.secretaryChat(taskPayload('TASK_MODE_VAGUE：信息不完整。'));
  assert.equal(vague.uBuddyMode, 'clarification');
  assert.match(vague.answer, /最终交付物是什么/);
  assert.equal(vague.message.metadata.uBuddyTaskPublishProcess?.status, 'waiting');
  assert.equal(vague.message.metadata.uBuddyTaskPublishProcess?.events.at(-1)?.status, 'waiting');
  assert.equal(vague.message.metadata.expanded, true);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeClarification,
    'an incomplete task must clarify before creation');
  const askDuringClarification = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '顺便解释一下书面报告和演示文稿的区别。',
  });
  assert.equal(askDuringClarification.uBuddyMode, 'direct');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeClarification,
    'an Ask side question must not create work while a Task clarification is pending');
  assert.ok(findPendingUBuddyTaskIntake(runtime.store.listMessages(session.id)),
    'an Ask side question must preserve the pending Task intake');
  const askCancellationDuringClarification = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    taskReferenceVersion: 'structured_task_reference_v1',
    message: '取消任务',
  });
  assert.ok(askCancellationDuringClarification.taskReferenceRequired === true
    || (askCancellationDuringClarification.uBuddyMode === 'task_cancel_control'
      && !askCancellationDuringClarification.taskRunId),
  JSON.stringify({ uBuddyMode: askCancellationDuringClarification.uBuddyMode,
    taskRunId: askCancellationDuringClarification.taskRunId, answer: askCancellationDuringClarification.answer }));
  assert.ok(findPendingUBuddyTaskIntake(runtime.store.listMessages(session.id)),
    'an unexecuted Ask cancellation must preserve an unrelated pending Task intake');
  const targetedCancellationDuringClarification = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '取消任务',
    taskReferenceVersion: 'structured_task_reference_v1',
    taskReference: {
      principalType: 'task', taskRunId: negated.taskRunId, displayText: `@任务：${negated.task.title}`,
    },
  });
  assert.equal(targetedCancellationDuringClarification.taskRunId, negated.taskRunId);
  assert.ok(['cancelled', 'completed'].includes(runtime.store.getTaskRun(negated.taskRunId).status),
    'the selected task should either be cancelled or remain in its already-completed terminal state');
  assert.ok(findPendingUBuddyTaskIntake(runtime.store.listMessages(session.id)),
    'cancelling an explicitly selected running task in Ask must preserve an unrelated pending intake');
  const clarifiedAfterAsk = await runtime.secretaryChat(taskPayload(
    'TASK_MODE_CLARIFICATION_ANSWER：最终交付物是书面报告，继续执行。',
  ));
  assert.ok(clarifiedAfterAsk.taskRunId, 'switching back to Task must continue the preserved intake');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeClarification + 1);

  const createSyntheticActiveTask = (title) => {
    const task = runtime.store.createTaskRun({
      title, prompt: title, departmentId: 'general', ownerUserId: user.id,
      metadata: { userId: user.id, source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id },
    });
    runtime.store.updateTaskRunStatus(task.id, 'running', `${title} running`);
    return runtime.store.getTaskRun(task.id);
  };
  createSyntheticActiveTask('任务模式活跃任务 A');
  createSyntheticActiveTask('任务模式活跃任务 B');
  const queryCountBefore = runtime.store.listTaskRuns({ userId: user.id }).length;
  const taskModeQuery = await runtime.secretaryChat(taskPayload('TASK_MODE_QUERY：当前任务进度怎么样？'));
  assert.equal(taskModeQuery.uBuddyMode, 'task_query_control');
  assert.match(taskModeQuery.answer, /^TASK_MODE_QUERY_OK/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, queryCountBefore,
    'a read-only existing-work query in task mode must not create another task');
  const beforeContinuationText = runtime.store.listTaskRuns({ userId: user.id }).length;
  const newDespiteContinuationText = await runtime.secretaryChat(taskPayload('继续补充：另行整理一份独立风险报告。'));
  assert.ok(newDespiteContinuationText.taskRunId);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeContinuationText + 1,
    'task mode without a structured task selection must create a new task even when prose says continue');
  assert.notEqual(newDespiteContinuationText.uBuddyMode, 'task_reference_required');

  runtime.store.updateTaskRunStatus(local.taskRunId, 'running', '保持运行以验证结构化续接。');
  const beforeStructuredContinuation = runtime.store.listTaskRuns({ userId: user.id }).length;
  const beforeStructuredMessages = runtime.taskRunWorkspaceMessages({ taskRunId: local.taskRunId }).messages.length;
  const supplement = await runtime.secretaryChat(taskPayload('补充要求：最终报告增加风险复核清单。', {
    taskReferenceVersion: 'structured_task_reference_v1',
    taskReference: {
      principalType: 'task', taskRunId: local.taskRunId, displayText: `@任务：${local.task.title}`,
    },
  }));
  assert.equal(supplement.answer, 'TASK_MODE_UPDATE_OK');
  assert.equal(supplement.uBuddyMode, 'task_supplement_queued');
  const structuredMessages = runtime.taskRunWorkspaceMessages({ taskRunId: local.taskRunId }).messages;
  assert.ok(structuredMessages.length > beforeStructuredMessages);
  assert.match(structuredMessages.at(-1).content, /风险复核清单/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, beforeStructuredContinuation,
    'a structured old-task selection must continue that task instead of creating another one');

  const mentionA = {
    principalType: 'user', userId: 'message_mode_contact', displayText: '@模式联系人',
    mentionId: 'message-mode-contact', source: 'picker',
  };
  const mentionB = {
    principalType: 'user', userId: 'message_mode_contact_b', displayText: '@模式联系人乙',
    mentionId: 'message-mode-contact-b', source: 'picker',
  };
  const askQuestionCounts = counts();
  const askQuestion = await runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'ask',
    message: '@模式联系人 询问他最近在干什么。',
    mentions: [mentionA],
  });
  assert.equal(askQuestion.uBuddyMode, 'direct');
  assert.deepEqual(counts(), askQuestionCounts, 'Ask mode must keep a contact question read-only');
  const socialMessagesBeforeQuestion = runtime.socialConversation({ peerId: 'message_mode_contact' })
    .filter((item) => item.metadata?.type === 'ubuddy_simple_message').length;
  const questionDelegationsBefore = runtime.agentDelegations({ direction: 'outgoing' }).length;
  const questionDispatch = await runtime.secretaryChat(taskPayload('@模式联系人 询问他最近在干什么。', {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [mentionA],
  }));
  assert.equal(questionDispatch.dispatchType, 'external_delegation');
  assert.ok(questionDispatch.delegation?.id || questionDispatch.waitingForPresence,
    'a Task-mode question to a contact must create or queue a formal delegation');
  assert.ok(runtime.agentDelegations({ direction: 'outgoing' }).length >= questionDelegationsBefore);
  assert.equal(runtime.socialConversation({ peerId: 'message_mode_contact' })
    .filter((item) => item.metadata?.type === 'ubuddy_simple_message').length, socialMessagesBeforeQuestion,
    'Task mode must not publish a lightweight social message');

  const singleDelegationsBefore = runtime.agentDelegations({ direction: 'outgoing' }).length;
  const singleDispatch = await runtime.secretaryChat(taskPayload('@模式联系人 整理数据并交付书面报告。', {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [mentionA],
  }));
  assert.equal(singleDispatch.uBuddyMode, 'dispatched');
  assert.equal(singleDispatch.message?.metadata?.uBuddyTaskPublishProcess?.status, 'completed');
  assert.equal(singleDispatch.message?.metadata?.uBuddyTaskPublishProcess?.events.at(-1)?.activityId,
    'ubuddy-task-publish:dispatching');
  assert.ok(runtime.agentDelegations({ direction: 'outgoing' }).length > singleDelegationsBefore || singleDispatch.waitingForPresence,
    'task mode with one picker user mention must dispatch or queue externally');

  const explicitDelegationsBefore = runtime.agentDelegations({ direction: 'outgoing' }).length;
  const explicitDispatch = await runtime.secretaryChat(taskPayload(
    '@模式联系人 @模式联系人乙 明确分工：模式联系人整理数据，模式联系人乙撰写报告。',
    { mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [mentionA, mentionB] },
  ));
  assert.equal(explicitDispatch.uBuddyMode, 'dispatched');
  assert.equal(explicitDispatch.message?.metadata?.uBuddyTaskPublishProcess?.status, 'completed');
  assert.ok(runtime.agentDelegations({ direction: 'outgoing' }).length >= explicitDelegationsBefore
    && (explicitDispatch.waitingForPresence || explicitDispatch.group || explicitDispatch.dispatchType === 'task_group'),
    'complete user-authored assignments must dispatch or queue without an automatic-plan confirmation');

  const automaticBefore = counts();
  const automaticPlan = await runtime.secretaryChat(taskPayload(
    '@模式联系人 @模式联系人乙 请由 uBuddy 自动分工完成市场报告。',
    { mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [mentionA, mentionB] },
  ));
  assert.equal(automaticPlan.uBuddyMode, 'awaiting_confirmation');
  assert.equal(automaticPlan.collaborationPlan.assignmentSource, 'ubuddy_planned');
  assert.equal(automaticPlan.message.metadata.uBuddyTaskPublishProcess?.status, 'waiting');
  assert.equal(automaticPlan.message.metadata.uBuddyTaskPublishProcess?.events.at(-1)?.status, 'waiting');
  assert.deepEqual(counts(), automaticBefore,
    'automatic multi-user assignments must not dispatch before confirmation');
  const confirmedAutomaticPlan = await runtime.secretaryChat(taskPayload('确认派发'));
  assert.equal(confirmedAutomaticPlan.uBuddyMode, 'dispatched');
  const settledAutomaticPlan = runtime.store.getMessage(automaticPlan.message.id);
  assert.equal(settledAutomaticPlan.metadata.uBuddyTaskPublishProcess?.status, 'completed');
  assert.equal(settledAutomaticPlan.metadata.uBuddyTaskPublishProcess?.events.at(-1)?.status, 'completed');
  assert.equal(confirmedAutomaticPlan.message?.metadata?.uBuddyTaskPublishProcess, undefined,
    'confirmed proposals should settle the original process instead of duplicating it on the task card');

  const retryableProposal = await runtime.secretaryChat(taskPayload(
    '@模式联系人 @模式联系人乙 请由 uBuddy 自动分工完成可重试派发报告。',
    { mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [mentionA, mentionB] },
  ));
  assert.equal(retryableProposal.uBuddyMode, 'awaiting_confirmation');
  const originalExecuteSecretaryDispatch = runtime.executeSecretaryDispatch;
  runtime.executeSecretaryDispatch = async () => {
    const error = new Error('simulated dispatch outage');
    error.code = 'simulated_dispatch_outage';
    throw error;
  };
  try {
    await assert.rejects(runtime.secretaryChat(taskPayload('确认派发')), /simulated dispatch outage/);
  } finally {
    runtime.executeSecretaryDispatch = originalExecuteSecretaryDispatch;
  }
  const retryableProposalMessage = runtime.store.getMessage(retryableProposal.message.id);
  assert.equal(retryableProposalMessage.metadata.uBuddyCollaborationPlan.status, 'awaiting_confirmation');
  assert.equal(retryableProposalMessage.metadata.uBuddyCollaborationPlanAwaitingConfirmation, true);
  assert.equal(retryableProposalMessage.metadata.uBuddyCollaborationPlanDispatchRetryable, true);
  const retriedProposal = await runtime.secretaryChat(taskPayload('确认派发'));
  assert.equal(retriedProposal.uBuddyMode, 'dispatched');

  runtime.db.prepare(`INSERT INTO contact_organizations (
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES ('message_mode_org','MESSAGE-MODE-ORG','任务模式组织','salt','hash',?)`).run(user.id);
  runtime.db.prepare(`INSERT INTO contact_organization_members (organization_id,user_id,role)
    VALUES ('message_mode_org',?,'owner'),
           ('message_mode_org','message_mode_contact','member'),
           ('message_mode_org','message_mode_contact_b','member')`).run(user.id);
  runtime.store.ensureAccountWorkspaces({ user: runtime.currentUser() });
  const organizationMention = {
    principalType: 'organization', organizationId: 'message_mode_org', audience: 'all_members',
    displayText: '@所有人', mentionId: 'message-mode-org-all', source: 'picker',
  };
  const organizationQuestion = await runtime.secretaryChat(taskPayload(
    'TASK_MODE_VAGUE @所有人：信息不完整，请共同完成市场报告。',
    { mentionSelectionVersion: 'ubuddy_mention_selection_v1', mentions: [organizationMention] },
  ));
  assert.equal(organizationQuestion.uBuddyMode, 'clarification');
  const organizationCheckpoint = organizationQuestion.message.metadata.uBuddyPlanningCheckpoint;
  assert.ok(organizationCheckpoint?.planningSessionId);
  const organizationPlan = await runtime.secretaryChat(taskPayload('书面报告', {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    clarificationResponse: {
      version: 'ubuddy_clarification_response_v1', sourceMessageId: organizationQuestion.message.id,
      planningSessionId: organizationCheckpoint.planningSessionId, baseRevision: organizationCheckpoint.revision,
      answers: [{ questionId: 'deliverables', value: '书面报告', label: '书面报告' }],
    },
  }));
  assert.equal(organizationPlan.uBuddyMode, 'awaiting_confirmation');
  assert.deepEqual(organizationPlan.collaborationPlan.selectedUserIds.sort(), ['message_mode_contact', 'message_mode_contact_b']);
  assert.equal(organizationPlan.message.metadata.uBuddyPlanningCheckpoint.planningSessionId, organizationCheckpoint.planningSessionId);
  const persistedOrganizationPlanning = runtime.store.getUBuddyPlanningSession({ id: organizationCheckpoint.planningSessionId });
  assert.equal(persistedOrganizationPlanning.status, 'awaiting_confirmation');
  assert.ok(persistedOrganizationPlanning.codexThreadId, 'organization clarification must preserve one physical Codex thread');
  const repeatedOrganizationAnswer = await runtime.secretaryChat(taskPayload('书面报告', {
    mentionSelectionVersion: 'ubuddy_mention_selection_v1',
    clarificationResponse: {
      version: 'ubuddy_clarification_response_v1', sourceMessageId: organizationQuestion.message.id,
      planningSessionId: organizationCheckpoint.planningSessionId, baseRevision: organizationCheckpoint.revision,
      answers: [{ questionId: 'deliverables', value: '书面报告', label: '书面报告' }],
    },
  }));
  assert.equal(repeatedOrganizationAnswer.idempotent, true);
  assert.equal(repeatedOrganizationAnswer.uBuddyMode, 'awaiting_confirmation');
  const originalPresenceQuery = SocialRelayService.prototype.queryRecipientPresence;
  const originalPlannedParticipantsSupport = SocialRelayService.prototype.collaborationPlannedParticipantsSupported;
  SocialRelayService.prototype.queryRecipientPresence = async ({ userIds = [] } = {}) => ({
    items: userIds.map((userId) => ({ userId, online: false, lastSeenAt: '' })),
  });
  SocialRelayService.prototype.collaborationPlannedParticipantsSupported = async () => false;
  let confirmedOrganizationPlan;
  try {
    confirmedOrganizationPlan = await runtime.secretaryChat(taskPayload('确认派发'));
  } finally {
    SocialRelayService.prototype.queryRecipientPresence = originalPresenceQuery;
    SocialRelayService.prototype.collaborationPlannedParticipantsSupported = originalPlannedParticipantsSupport;
  }
  assert.equal(confirmedOrganizationPlan.uBuddyMode, 'dispatched');
  assert.match(confirmedOrganizationPlan.answer, /任务群已创建/);
  assert.match(confirmedOrganizationPlan.answer, /当前离线；完整分工已保存/);
  const deferredOrganizationCommand = runtime.store.getUBuddyDispatchCommand(
    organizationPlan.message.metadata.uBuddyDispatchCommand.id,
  );
  assert.equal(deferredOrganizationCommand.status, 'published');
  assert.ok(deferredOrganizationCommand.result.groupId,
    'an older server must receive full assignments so confirmation still creates the task group');
  assert.deepEqual(runtime.store.pendingDispatchAssignments(deferredOrganizationCommand.command.id)
    .map((item) => [item.recipientUserId, item.status]).sort(), [
    ['message_mode_contact', 'published'],
    ['message_mode_contact_b', 'published'],
  ]);
  assert.equal(runtime.auth.collaborationGroup(deferredOrganizationCommand.result.groupId).tasks.length, 2,
    'legacy compatibility must persist both assignments for recipients to pick up when they come online');

  const informationalTaskCount = runtime.store.listTaskRuns({ userId: user.id }).length;
  const informationalTask = await runtime.secretaryChat(taskPayload('解释量子纠缠是什么，并给出清晰答案。'));
  assert.ok(informationalTask.taskRunId, 'a new informational answer in Task mode must create a formal local task');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, informationalTaskCount + 1);
  const invalidDirectTaskCount = runtime.store.listTaskRuns({ userId: user.id }).length;
  const invalidDirect = await runtime.secretaryChat(taskPayload('TASK_MODE_INVALID_DIRECT：解释一个新的概念。'));
  assert.equal(invalidDirect.uBuddyMode, 'planning_failed');
  assert.equal(invalidDirect.errorCode, 'ubuddy_continuous_planning_validation_failed');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, invalidDirectTaskCount,
    'Task mode must fail closed instead of silently accepting a direct-answer downgrade');

  const legacySimpleCommand = {
    version: 2,
    id: 'message-mode-historical-simple-message',
    title: '历史轻量消息',
    dispatchType: 'simple_message',
    intent: 'simple_message',
    executionMode: 'simple_message',
    objective: '历史轻量消息兼容性验证',
    deliverables: [],
    sourceType: 'secretary_chat',
    sourceSecretarySessionId: session.id,
    sourceMessageId: 'historical-simple-message-source',
    participants: [{ userId: 'message_mode_contact', selected: true }],
    mentions: [mentionA],
    assignments: [],
  };
  await assert.rejects(() => runtime.executeSecretaryDispatch({
    sessionId: session.id,
    dispatch: { ...legacySimpleCommand, id: 'message-mode-new-simple-message-forbidden' },
  }), (error) => error?.code === 'ubuddy_secretary_simple_message_forbidden');
  const frozenLegacySimpleCommand = normalizeSecretaryDispatchCommand(legacySimpleCommand);
  runtime.store.reserveUBuddyDispatchCommand({
    command: frozenLegacySimpleCommand,
    accountWorkspaceId: session.workspaceId || session.accountWorkspaceId,
    ownerUserId: user.id,
    sourceSessionId: session.id,
    sourceMessageId: legacySimpleCommand.sourceMessageId,
  });
  const historicalSimple = await runtime.executeSecretaryDispatch({ sessionId: session.id, dispatch: frozenLegacySimpleCommand });
  assert.equal(historicalSimple.dispatchType, 'simple_message', 'a persisted historical command must remain replayable');

  await assert.rejects(() => runtime.secretaryChat({
    sessionId: session.id,
    uBuddyMessageModeVersion: UBUDDY_MESSAGE_MODE_VERSION,
    uBuddyMessageMode: 'invalid',
    message: '无效模式不应执行。',
  }), (error) => error?.code === 'invalid_ubuddy_message_mode');

  console.log('uBuddy message mode Stage 2 smoke passed');
} finally {
  runtime?.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_MESSAGE_MODE_V1;
  else process.env.JANUS_UBUDDY_MESSAGE_MODE_V1 = previousFlag;
  if (previousProfileRoutingFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousProfileRoutingFlag;
  if (previousStructuredTaskReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredTaskReferenceFlag;
}
