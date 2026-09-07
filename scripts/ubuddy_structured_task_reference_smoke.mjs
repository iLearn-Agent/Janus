import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { decideUBuddyTurn } from '../src/main/modules/orchestration/application/uBuddyTurnDecisionPlanner.js';
import { state } from '../src/renderer/app/state.js';
import { restoreTaskReferenceRequiredComposerState } from '../src/renderer/app/features/chat/messageSendController.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderTaskProgressCard } from '../src/renderer/app/views/taskProgressView.js';
import { normalizeTaskReference } from '../src/shared/contracts/taskReference.js';

async function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for structured task reference condition.');
}

assert.deepEqual(normalizeTaskReference({
  principalType: 'task', taskRunId: 'task-existing', displayText: '   ', createNewTask: true,
}), { principalType: 'task', taskRunId: 'task-existing', displayText: '@任务' });
const restoredComposer = {};
const restoredAttachments = [{ id: 'attachment-preserved' }];
restoreTaskReferenceRequiredComposerState({
  state: restoredComposer,
  result: { taskReferenceOptions: [{ taskRunId: 'task-a' }] },
  message: '保留这条消息',
  attachments: restoredAttachments,
  fileReferences: [{ referenceId: 'file-ref' }],
  memoryReferences: [{ referenceId: 'memory-ref' }],
  quote: { messageId: 'quoted' },
  mentions: [{ principalType: 'agent', agentId: 'general_agent' }],
});
assert.equal(restoredComposer.chatDraft, '保留这条消息');
assert.equal(restoredComposer.attachments, restoredAttachments);
assert.equal(restoredComposer.taskReferenceMenuOpen, true);
assert.equal(restoredComposer.taskReferenceOptions[0].taskRunId, 'task-a');
await assert.rejects(() => decideUBuddyTurn({
  prompt: '创建一个新任务',
  decisionMode: 'explicit_new_task',
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.95,
    answer: '不应直接回答。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
  }),
}), /explicitly requested new task/i);
await assert.rejects(() => decideUBuddyTurn({
  prompt: '补充后继续原任务',
  decisionMode: 'task_continuation',
  execute: async () => JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.95,
    answer: '不应直接回答。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
  }),
}), /task continuation/i);
const continuedCard = renderTaskProgressCard({
  taskRunId: 'predecessor-task',
  taskStatus: 'cancelled',
  continuedByTaskRunId: 'successor-task',
  terminal: true,
  content: '任务已续接。',
  controls: { canOpen: true, canRerun: false },
});
assert.match(continuedCard, /已续接/);
assert.doesNotMatch(continuedCard, /需要修正|重新执行/);

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-structured-task-reference-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-structured-task-reference-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousBoundedReviewFlag = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && ['structured-query', 'structured-update'].includes(String(message.id))) {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const answer = String(message.id) === 'structured-query'
        ? 'STRUCTURED_QUERY_OK：' + (payload.answer || '')
        : payload.ok ? 'STRUCTURED_UPDATE_OK' : 'STRUCTURED_UPDATE_FAILED';
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'structured-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      continue;
    }
    if (!message.method || message.id == null) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'structured-task-reference-smoke' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'structured-task-reference-thread' } } });
    else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'structured-turn' } } });
      const prompt = message.params?.input?.[0]?.text || '';
      const query = /进度|怎么样|结果|产物|文件/.test(prompt.split('Current owner message:\\n').at(-1) || '');
      send({ id: query ? 'structured-query' : 'structured-update', method: 'item/tool/call', params: {
        threadId: 'structured-task-reference-thread', turnId: 'structured-turn', callId: query ? 'structured-query' : 'structured-update',
        namespace: 'janus', tool: query ? 'query_work' : 'update_task',
        arguments: query ? { query: 'progress' } : { action: 'supplement', content: prompt.split('Current owner message:\\n').at(-1) || '' },
      } });
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
let response = '任务执行完成。';
if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const general = candidates.find((item) => item.agentId === 'general_agent') || candidates[0] || {};
  const firstClarification = stdin.includes('Current owner message:\\n需要澄清的新任务');
  const clarificationContinuation = stdin.includes('Current owner message:\\n补充答案：中文');
  response = firstClarification ? JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.9,
    clarification: { reason: 'language_required', question: '报告使用哪种语言？', options: ['中文', '英文'] },
    nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
  }) : JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
      nodes: [{ localId: 'final', title: '创建独立任务', objective: clarificationContinuation && stdin.includes('需要澄清的新任务') ? '按澄清结果完成新任务' : '完成新任务', agentId: general.agentId || 'general_agent', agentInstanceId: general.agentInstanceId || '', dependencies: [], outputFormat: '完整结果', isFinal: true, blocking: true, fallback: '说明阻塞原因。' }],
      deliverables: [{ id: 'primary', role: 'primary', type: 'document', title: '独立任务结果', ownerLocalId: 'final', deliveryMode: 'inline' }],
      agentSelectionRationale: '使用通用 Agent 执行独立任务。', mentionedAgentsNotSelected: [],
    });
}
if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'structured-task-reference-smoke' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'on';
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';

let runtime = null;
const previousRendererState = {
  homeMode: state.homeMode,
  currentUser: state.currentUser,
  messages: state.messages,
  collaborationGroupId: state.collaborationGroupId,
  chatGroupId: state.chatGroupId,
  networkConversationPeerId: state.networkConversationPeerId,
  activeTaskWorkspaceKind: state.activeTaskWorkspaceKind,
  uBuddyFeatureFlags: state.uBuddyFeatureFlags,
  taskReferenceMenuOpen: state.taskReferenceMenuOpen,
  taskReferenceOptions: state.taskReferenceOptions,
  taskReferenceOptionsLoading: state.taskReferenceOptionsLoading,
  taskReferenceOptionsError: state.taskReferenceOptionsError,
  composerTaskReference: state.composerTaskReference,
};

try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const session = runtime.ensureSecretarySession();
  const createTask = (title, status = 'running', metadata = {}) => {
    const task = runtime.store.createTaskRun({
      title,
      prompt: title,
      departmentId: 'general',
      ownerUserId: user.id,
      metadata: {
        userId: user.id,
        source: 'ubuddy_dispatch',
        sourceSecretarySessionId: session.id,
        ...metadata,
      },
    });
    runtime.store.updateTaskRunStatus(task.id, status, `${title} ${status}`);
    return runtime.store.getTaskRun(task.id);
  };

  const activeTask = createTask('市场分析');
  const sleepingTask = createTask('竞品调研');
  runtime.store.startUBuddyCoordination({
    taskRunId: sleepingTask.id,
    sourceSessionId: session.id,
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_sleeping',
  });
  runtime.store.markUBuddySleeping({
    taskRunId: sleepingTask.id,
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_sleeping',
    sleepReason: '等待 Agent 完成。',
  });
  runtime.store.requestUBuddyWake({
    taskRunId: sleepingTask.id,
    reasonCode: 'user_action_required',
    actorId: 'general_agent',
  });
  runtime.store.markUBuddySleeping({
    taskRunId: sleepingTask.id,
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_sleeping',
    sleepReason: '用户已经补充信息，继续等待 Agent 完成。',
  });
  const waitingTask = createTask('用户访谈总结', 'waiting', { planningState: 'user_action_required' });
  runtime.store.startUBuddyCoordination({ taskRunId: waitingTask.id, sourceSessionId: session.id });
  runtime.store.requestUBuddyWake({
    taskRunId: waitingTask.id,
    reasonCode: 'user_action_required',
    actorId: 'secretary_agent',
  });

  const options = runtime.secretaryTaskReferenceOptions({ sessionId: session.id });
  assert.equal(options.enabled, true);
  assert.equal(options.tasks.length, 3);
  assert.deepEqual(new Set(options.tasks.map((item) => item.statusGroup)), new Set(['active', 'sleeping', 'waiting_user']));

  state.homeMode = 'secretary';
  state.currentUser = user;
  state.messages = [];
  state.collaborationGroupId = '';
  state.chatGroupId = '';
  state.networkConversationPeerId = '';
  state.activeTaskWorkspaceKind = '';
  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, structuredTaskReference: true };
  state.taskReferenceMenuOpen = true;
  state.taskReferenceOptions = options.tasks;
  state.taskReferenceOptionsLoading = false;
  state.taskReferenceOptionsError = '';
  let html = renderChat();
  assert.match(html, /创建新任务/);
  assert.match(html, /市场分析/);
  assert.match(html, /竞品调研/);
  assert.match(html, /用户访谈总结/);
  state.composerTaskReference = options.tasks.find((item) => item.taskRunId === activeTask.id);
  state.taskReferenceMenuOpen = false;
  html = renderChat();
  assert.match(html, /@任务：市场分析/);
  assert.match(html, /消息只进入此任务/);
  const taskReferenceCapability = { taskReferenceVersion: 'structured_task_reference_v1' };

  const ambiguous = await runtime.secretaryChat({ ...taskReferenceCapability, sessionId: session.id, message: '补充要求：把报告中的数据口径改成最新版本。' });
  assert.equal(ambiguous.uBuddyMode, 'task_reference_required');
  assert.equal(ambiguous.taskReferenceOptions.length, 3);
  assert.match(ambiguous.answer, /请选择要继续的任务/);

  const newTaskReference = { principalType: 'task', taskRunId: '', displayText: '@新任务', createNewTask: true };
  const clarification = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '需要澄清的新任务',
    taskReference: newTaskReference,
  });
  assert.equal(clarification.uBuddyMode, 'clarification');
  assert.equal(clarification.message.metadata.taskReference.createNewTask, true);
  const clarifiedTask = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '补充答案：中文',
    taskReference: newTaskReference,
  });
  assert.ok(clarifiedTask.taskRunId);
  assert.equal(runtime.store.getTaskRun(clarifiedTask.taskRunId).metadata.parentTaskRunId, '');
  runtime.cancelTaskRun({ taskRunId: clarifiedTask.taskRunId });

  const independent = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '请创建一份新的渠道策略报告。',
    taskReference: { principalType: 'task', taskRunId: '', displayText: '@新任务', createNewTask: true },
  });
  assert.ok(independent.taskRunId);
  assert.notEqual(independent.taskRunId, activeTask.id);
  assert.notEqual(independent.taskRunId, sleepingTask.id);
  assert.equal(runtime.store.getTaskRun(independent.taskRunId).metadata.parentTaskRunId, '');
  runtime.cancelTaskRun({ taskRunId: independent.taskRunId });

  const waitingContinuation = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '补充信息：访谈范围只包含已付费客户。',
    taskReference: { principalType: 'task', taskRunId: waitingTask.id, displayText: '@任务：用户访谈总结' },
  });
  assert.equal(waitingContinuation.uBuddyMode, 'task_supplement_queued');
  const waitingContinuationWork = await waitFor(() => {
    const work = runtime.store.findAgentWork({
      workKind: 'ubuddy_task_supplement', workId: waitingContinuation.receipt.workId,
    });
    return ['completed', 'failed'].includes(String(work?.status || '')) ? work : null;
  });
  assert.equal(waitingContinuationWork.status, 'completed', JSON.stringify(waitingContinuationWork));
  const continuedWaitingTask = runtime.store.getTaskRun(waitingTask.id);
  assert.equal(continuedWaitingTask.status, 'cancelled');
  assert.ok(continuedWaitingTask.metadata.continuedByTaskRunId);
  const waitingWorkspace = runtime.taskRunWorkspaceMessages({ taskRunId: waitingTask.id });
  const waitingWorkspaceRequest = waitingWorkspace.messages.find((message) => (
    message.metadata?.requestedFromTaskRunId === waitingTask.id
  ));
  assert.ok(waitingWorkspaceRequest?.metadata?.clientMessageId);
  const continuedSuccessor = runtime.store.getTaskRun(continuedWaitingTask.metadata.continuedByTaskRunId);
  assert.equal(continuedSuccessor.metadata.continuationRequestMessageId, waitingWorkspaceRequest.id);
  assert.ok(continuedWaitingTask.events.some((event) => event.eventType === 'task_continued_after_user_input'));
  assert.equal(continuedWaitingTask.events.some((event) => event.eventType === 'task_cancelled'), false);
  assert.equal(runtime.store.getUBuddyCoordinationState(waitingTask.id).state, 'cancelled');
  assert.ok(runtime.store.listUBuddyWakeEvents({ taskRunId: waitingTask.id })
    .every((wake) => !['pending', 'claimed', 'failed_retryable'].includes(wake.status)));
  const taskCountBeforeIdempotentRetry = runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length;
  const idempotentRetry = runtime.taskRunWorkspaceMessage({
    taskRunId: waitingTask.id,
    content: waitingWorkspaceRequest.content,
    clientMessageId: waitingWorkspaceRequest.metadata.clientMessageId,
  });
  assert.equal(idempotentRetry.receipt.id, waitingContinuationWork.id);
  assert.equal(idempotentRetry.receipt.status, 'completed');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length, taskCountBeforeIdempotentRetry);

  runtime.store.updateTaskRunStatus(sleepingTask.id, 'completed', '完成');
  const explicitQueryCount = runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length;
  const explicitQuery = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '这个任务现在进度怎么样？',
    taskReference: { principalType: 'task', taskRunId: sleepingTask.id, displayText: '@任务：竞品调研' },
  });
  assert.equal(explicitQuery.uBuddyMode, 'task_query_control');
  assert.match(explicitQuery.answer, /^STRUCTURED_QUERY_OK/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length, explicitQueryCount);
  const automatic = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '补充要求：增加一页风险说明。',
  });
  assert.equal(automatic.uBuddyMode, 'task_supplement_queued');
  assert.equal(automatic.taskRunId, activeTask.id);
  const automaticRequest = runtime.store.listMessages(session.id).find((message) => (
    message.role === 'user' && message.metadata?.taskReferenceSelectionSource === 'auto_single_active'
  ));
  assert.equal(automaticRequest.metadata.taskReference.taskRunId, activeTask.id);

  const explicit = await runtime.secretaryChat({
    ...taskReferenceCapability,
    sessionId: session.id,
    message: '补充要求：把结论压缩成三条。',
    taskReference: { principalType: 'task', taskRunId: sleepingTask.id, displayText: '@任务：竞品调研' },
  });
  assert.equal(explicit.uBuddyMode, 'task_supplement_queued');
  assert.equal(explicit.taskRunId, sleepingTask.id);
  const explicitWorkspace = runtime.taskRunWorkspaceMessages({ taskRunId: sleepingTask.id });
  const explicitRequest = explicitWorkspace.messages.find((message) => (
    message.metadata?.requestedFromTaskRunId === sleepingTask.id
      && message.content.includes('把结论压缩成三条')
  ));
  assert.ok(explicitRequest);
  await waitFor(() => {
    const work = runtime.store.findAgentWork({
      workKind: 'ubuddy_task_supplement', workId: `task-supplement:${explicitRequest.id}`,
    });
    return ['completed', 'failed'].includes(String(work?.status || '')) ? work : null;
  });
  const contextual = runtime.taskRunWorkspaceMessage({
    taskRunId: sleepingTask.id,
    content: '请结合引用继续处理。',
    fileReferences: [{ referenceId: 'file-ref', relativePath: 'brief.md' }],
    memoryReferences: [{ referenceId: 'memory-ref', displayName: '历史摘要' }],
    supplementContext: 'STRUCTURED_REFERENCE_CONTEXT',
    clientMessageId: 'structured-reference-context-smoke',
  });
  const contextualRequest = runtime.taskRunWorkspaceMessages({ taskRunId: sleepingTask.id }).messages
    .find((message) => message.metadata?.clientMessageId === 'structured-reference-context-smoke');
  assert.equal(contextualRequest.metadata.fileReferences[0].relativePath, 'brief.md');
  assert.equal(contextualRequest.metadata.memoryReferences[0].displayName, '历史摘要');
  const contextualWork = runtime.store.findAgentWork({
    workKind: 'ubuddy_task_supplement', workId: contextual.receipt.workId,
  });
  assert.match(contextualWork.payload.executionContent, /STRUCTURED_REFERENCE_CONTEXT/);
  await waitFor(() => {
    const work = runtime.store.findAgentWork({
      workKind: 'ubuddy_task_supplement', workId: contextual.receipt.workId,
    });
    return ['completed', 'failed'].includes(String(work?.status || '')) ? work : null;
  });

  runtime.store.createTaskRun({
    title: '旧客户端兼容任务', prompt: '验证旧客户端不会被结构化引用阻断', ownerUserId: user.id,
    metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id },
  });
  const legacyClient = await runtime.secretaryChat({
    sessionId: session.id,
    message: '补充要求：旧客户端继续按原逻辑处理。',
  });
  assert.notEqual(legacyClient.uBuddyMode, 'task_reference_required',
    'a client without the structured-reference capability must never be blocked by the new picker protocol');
} finally {
  Object.assign(state, previousRendererState);
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousFlag;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  if (previousBoundedReviewFlag === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedReviewFlag;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  await rm(binRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log('uBuddy structured task reference smoke passed');
