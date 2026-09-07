import { strict as assert } from 'node:assert';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { delegationExecutionFailureDetails } from '../src/main/modules/collaboration/index.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-task-runtime-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-task-bin-'));
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-task-project-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousHeartbeat = process.env.JANUS_UBUDDY_NODE_HEARTBEAT_MS;
const previousLeadershipEnforcement = process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE;
const previousUnifiedExternalTasks = process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousStructuredReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousBoundedReviewFlag = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
const previousRecoveryCounter = process.env.JANUS_FAKE_RECOVERY_COUNTER;
const recoveryCounter = path.join(root, 'recovery-counter.txt');

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
async function fakeResponseForInput(stdin) {
let response = stdin.includes('【UBUDDY_TURN_DECISION_V2】')
  ? (() => {
    const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const general = candidates.find((item) => item.agentId === 'general_agent');
    if (stdin.includes('外部委托澄清续接验证') && !stdin.includes('接收方用户已授权用于本任务的回答：使用ubuddy较多')) {
      return JSON.stringify({
        version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.82,
        clarification: {
          reason: 'authorized_usage_pattern_required',
          question: '请具体说明可授权披露的历史使用规律概括。',
          options: ['使用频率和常见场景', '近期使用变化趋势'],
        },
        nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
      });
    }
    return JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.95,
      nodes: [{ localId: 'final', title: '整理名单', objective: '整理清朝皇帝名单', agentId: 'general_agent', agentInstanceId: general?.agentInstanceId, dependencies: [], outputFormat: '完整名单', isFinal: true, blocking: true, fallback: '说明无法完成的原因。' }],
      deliverables: [{ id: 'primary', role: 'primary', type: 'document', title: '清朝皇帝名单', ownerLocalId: 'final', deliveryMode: 'inline' }],
      agentSelectionRationale: '通用 Agent 适合完成名单整理与核对。', mentionedAgentsNotSelected: [],
    });
  })()
  : stdin.includes('非法 owner 通信接管验证')
    && stdin.includes('executing one node in an Janus complex task graph')
    && !stdin.includes('【uBuddy 专业执行接管】')
    ? '当前节点错误地尝试向人类 owner 发起 Agent 通信。\\n\\n## Agent communication request\\n- request_to: owner\\n- purpose: 补充任务信息\\n- required_information: 请 owner 补充信息\\n- priority: high\\n- blocking: true\\n- expected_format: markdown\\n- context_summary: 非法目标回归验证'
  : '清朝皇帝名单：努尔哈赤、皇太极、顺治、康熙、雍正、乾隆、嘉庆、道光、咸丰、同治、光绪、宣统。';
if (stdin.includes('沙盒权限恢复指南') && stdin.includes('executing one node in an Janus complex task graph')) {
  const counterPath = process.env.JANUS_FAKE_RECOVERY_COUNTER;
  const previous = counterPath && fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8') || 0) : 0;
  const attempt = previous + 1;
  if (counterPath) fs.writeFileSync(counterPath, String(attempt), 'utf8');
  response = attempt === 1
    ? '<!-- janus-content-type: diagnostic -->\\n当前策略不允许申请写权限，任务工作区似乎只读。'
    : '<!-- janus-content-type: deliverable -->\\n后台权限已经由 uBuddy 修正，恢复重试成功。';
}
if (stdin.includes('早绑定慢任务验证') && stdin.includes('executing one node in an Janus complex task graph')) await new Promise((resolve) => setTimeout(resolve, 1500));
if (stdin.includes('慢任务取消验证') && stdin.includes('executing one node in an Janus complex task graph')) await new Promise((resolve) => setTimeout(resolve, 3000));
return response;
}
if (args[0] === 'app-server') {
  let buffer = '';
  let threadId = 'ubuddy-runtime-smoke-app-thread';
  let turnIndex = 0;
  let serverRequestId = 1000;
  const pending = new Map();
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  const requestClient = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serverRequestId;
    pending.set(String(id), { resolve, reject });
    send({ id, method, params });
  });
  const handle = async (message) => {
    if (!message || typeof message !== 'object') return;
    const responseKey = message.id == null ? '' : String(message.id);
    if (responseKey && pending.has(responseKey) && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const waiter = pending.get(responseKey);
      pending.delete(responseKey);
      if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    const id = message.id;
    const method = String(message.method || '');
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: 1, serverInfo: { name: 'fake-codex-app-server', version: 'smoke' }, capabilities: { experimentalApi: true } } });
      return;
    }
    if (method === 'thread/start') {
      threadId = 'ubuddy-runtime-smoke-app-thread-' + Date.now();
      send({ id, result: { thread: { id: threadId, status: 'ready' } } });
      return;
    }
    if (method === 'thread/resume') {
      threadId = String(message.params?.threadId || threadId);
      send({ id, result: { thread: { id: threadId, status: 'ready' } } });
      return;
    }
    if (method === 'thread/memoryMode/set') {
      send({ id, result: { ok: true } });
      return;
    }
    if (method === 'thread/goal/get') {
      send({ id, result: { goal: null } });
      return;
    }
    if (method === 'thread/goal/clear') {
      send({ id, result: { goal: null } });
      return;
    }
    if (method === 'thread/goal/set') {
      send({ id, result: { goal: { objective: String(message.params?.objective || ''), status: String(message.params?.status || 'active'), tokenBudget: null } } });
      return;
    }
    if (method === 'turn/start') {
      const currentThreadId = String(message.params?.threadId || threadId);
      const turnId = 'ubuddy-runtime-smoke-app-turn-' + (++turnIndex);
      const input = (Array.isArray(message.params?.input) ? message.params.input : [])
        .map((item) => String(item?.text || '')).join('\\n');
      send({ id, result: { turn: { id: turnId, status: 'running' } } });
      send({ method: 'turn/started', params: { threadId: currentThreadId, turnId, turn: { id: turnId, status: 'running' } } });
      if (/请使用多 Agent workflow|慢任务取消验证/.test(input)
        && !input.includes('executing one node in an Janus complex task graph')
        && !input.includes('【UBUDDY_TURN_DECISION_V2】')) {
        await requestClient('item/tool/call', {
          threadId: currentThreadId,
          turnId,
          itemId: 'tool-' + turnId,
          callId: 'dispatch-' + turnId,
          namespace: 'janus',
          tool: 'dispatch_local_task',
          arguments: {
            objective: input.includes('沙盒权限恢复指南')
              ? '请撰写《沙盒权限恢复指南》，正文至少三段并保存为 Markdown。'
              : input.includes('慢任务取消验证')
                ? '请使用多 Agent workflow 执行慢任务取消验证。'
                : '请使用多 Agent workflow 整理一份中国清朝皇帝名单。',
            deliverables: ['完整结果'],
            constraints: [],
            preferredAgentIds: ['general_agent'],
            preferredAgentInstanceIds: [],
          },
        });
      }
      const response = await fakeResponseForInput(input);
      const item = { id: 'answer-' + turnId, type: 'agentMessage', phase: 'final_answer', text: response };
      send({ method: 'item/started', params: { threadId: currentThreadId, turnId, item: { id: item.id, type: item.type, phase: item.phase } } });
      send({ method: 'item/completed', params: { threadId: currentThreadId, turnId, item, completedAtMs: Date.now() } });
      send({ method: 'turn/completed', params: { threadId: currentThreadId, turnId, turn: { id: turnId, status: 'completed', items: [item] }, usage: { input_tokens: 10, output_tokens: 5 } } });
      return;
    }
    if (id != null) send({ id, error: { code: -32601, message: 'Unsupported fake app-server method: ' + method } });
  };
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split(/\\r?\\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { await handle(JSON.parse(line)); }
      catch (error) { send({ method: 'error', params: { error: { message: error?.message || String(error) } } }); }
    }
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const outputIndex = args.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : '';
const response = await fakeResponseForInput(stdin);
if (outputPath) fs.writeFileSync(outputPath, response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-runtime-smoke' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_UBUDDY_NODE_HEARTBEAT_MS = '100';
process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS = '0';
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';
process.env.JANUS_FAKE_RECOVERY_COUNTER = recoveryCounter;

let runtime;
try {
  const taskUpdates = [];
  let throwTaskUpdate = false;
  runtime = await createRuntime({
    root,
    isDev: true,
    serverAuthoritativeSkills: true,
    onTaskUpdated: (payload) => {
      taskUpdates.push(payload);
      if (throwTaskUpdate) throw new Error('intentional task update listener failure');
    },
  });
  const session = runtime.ensureSecretarySession();
  const project = runtime.createProject({ title: 'uBuddy runtime project', workspaceRoot: projectRoot });
  const dispatched = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '请使用多 Agent workflow 整理一份中国清朝皇帝名单。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(dispatched.uBuddyMode), JSON.stringify({
    mode: dispatched.uBuddyMode,
    taskRunId: dispatched.taskRunId,
    answer: String(dispatched.answer || '').slice(0, 500),
  }));
  assert.notEqual(runtime.store.getTaskRun(dispatched.taskRunId)?.status, 'planning');
  assert.equal(dispatched.task.metadata.projectId, project.id);
  assert.equal(dispatched.task.metadata.workspaceRoot, project.workspaceRoot);
  await waitFor(
    () => ['completed', 'failed', 'cancelled'].includes(runtime.store.getTaskRun(dispatched.taskRunId)?.status || ''),
    10_000,
    () => runtime.store.getTaskRun(dispatched.taskRunId),
  );
  const task = runtime.store.getTaskRun(dispatched.taskRunId);
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.ok(task.nodes.length >= 1);
  assert.equal(task.metadata.featureFlagSnapshot?.version, 'ubuddy_feature_flags_v1');
  assert.equal(task.metadata.dispatchStrategyVersion, 'ubuddy_route_v2');
  assert.equal(task.metadata.taskWorkspaceUiVersion, 'task_workspace_v2');
  assert.equal(task.metadata.processStreamVersion, 'process_event_stream_v2');
  assert.ok(task.nodes.some((node) => /努尔哈赤/.test(node.resultText || '')));
  assert.ok(runtime.store.listMessages(session.id).some((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === task.id));

  const recoveredDispatch = await runtime.secretaryChat({
    sessionId: session.id,
    parentTaskRunId: 'permission_recovery_parent',
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    sandboxPermission: 'request-approval',
    message: '请使用多 Agent workflow 撰写《沙盒权限恢复指南》，正文至少三段并保存为 Markdown。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(recoveredDispatch.uBuddyMode), JSON.stringify(recoveredDispatch));
  await waitFor(
    () => runtime.store.getTaskRun(recoveredDispatch.taskRunId)?.status === 'completed',
    15_000,
    () => runtime.store.getTaskRun(recoveredDispatch.taskRunId),
  );
  const recoveredTask = runtime.store.getTaskRun(recoveredDispatch.taskRunId);
  assert.equal(recoveredTask.metadata.executionOptions.requestedPermissionMode, 'auto-approve');
  assert.equal(recoveredTask.metadata.executionOptions.permissionMode, 'auto-approve');
  assert.equal(recoveredTask.metadata.backgroundRecovery.attemptCount, 1);
  assert.ok(recoveredTask.nodes.some((node) => /恢复重试成功/.test(node.resultText || '')));
  assert.ok(recoveredTask.events.some((event) => event.eventType === 'ubuddy_failure_recovery_prepared'));
  assert.equal(runtime.store.listMessages(session.id).some((message) => (
    message.metadata?.taskRunId === recoveredTask.id && message.metadata?.uBuddyTaskActionRequired
  )), false, 'a recoverable background permission mismatch must not ask the owner to intervene');
  if (String(process.env.JANUS_UBUDDY_AGENT_WORK_DETAIL_PROJECTION || '').toLowerCase() === 'on') {
    const detailedTaskView = runtime.getTaskView(task.id);
    assert.equal(detailedTaskView.agentWorkStatusProjection?.scopeId, task.id);
    assert.ok(detailedTaskView.agentWorkStatusProjection?.actors?.length >= 2);
    const listedTaskView = runtime.listTaskViews().find((item) => item.id === task.id);
    assert.equal(listedTaskView?.agentWorkStatusProjection?.scopeId, task.id,
      'task list projection must use the batched task facts path');
    assert.equal(Object.hasOwn(listedTaskView || {}, 'nodes'), false,
      'task list projection must not inflate every summary with full task nodes');
  }

  const initialTaskWorkspace = runtime.taskRunWorkspaceMessages({ taskRunId: task.id });
  assert.equal(initialTaskWorkspace.rootTaskRunId, task.id);
  const taskCountBeforeWorkspaceQuery = runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length;
  const workspaceQuery = await runtime.taskRunWorkspaceTurn({
    taskRunId: task.id,
    content: '这个任务现在进度怎么样？',
    clientMessageId: 'task-runtime-query-1',
  });
  assert.equal(workspaceQuery.action, 'query');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length, taskCountBeforeWorkspaceQuery,
    'task workspace queries must not create successor tasks');
  assert.ok(workspaceQuery.messages.some((message) => message.metadata?.taskWorkspaceResponse === true));

  const ownerControlTask = runtime.store.createTaskRun({
    id: 'task-runtime-owner-control', ownerUserId: runtime.currentUser().id, title: 'Owner delivery control',
    prompt: 'Prepare an owner-selectable result.', metadata: {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, workspaceRoot: project.workspaceRoot,
    },
  });
  const ownerControlNode = runtime.store.createTaskNode({
    taskRunId: ownerControlTask.id, title: 'Owner-selectable result', objective: 'Prepare the result.',
    status: 'running', blocking: true, deferAgentInstanceBinding: true,
  });
  const ownerControlSubmission = runtime.store.recordTaskDeliverySubmission({
    taskRunId: ownerControlTask.id, taskNodeId: ownerControlNode.id,
    submissionKey: 'task-runtime-owner-control-submission-1', bodySnapshot: 'Owner-selectable version one.',
  });
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: ownerControlTask.id, submissionId: ownerControlSubmission.id,
    eventId: 'task-runtime-owner-control-submitted', eventType: 'submitted', payload: {},
  });
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: ownerControlTask.id, submissionId: ownerControlSubmission.id,
    eventId: 'task-runtime-owner-control-verifying', eventType: 'verification_started', payload: {},
  });
  runtime.store.updateTaskRunStatus(ownerControlTask.id, 'verifying', 'Waiting for owner decision.');
  const ownerControlTurn = await runtime.taskRunWorkspaceTurn({
    taskRunId: ownerControlTask.id,
    content: '就要第一版，直接交付。',
    clientMessageId: 'task-runtime-owner-control-command-1',
  });
  assert.equal(ownerControlTurn.action, 'accept_submission');
  const ownerControlled = runtime.store.getTaskRun(ownerControlTask.id);
  assert.equal(ownerControlled.status, 'completed');
  assert.equal(ownerControlled.metadata.deliveryReviewOutcome, 'owner_override');
  assert.equal(ownerControlled.metadata.selectedDeliverySubmissionId, ownerControlSubmission.id);
  assert.equal(ownerControlled.nodes[0].status, 'cancelled');

  const externalOwnerControlTask = runtime.store.createTaskRun({
    id: 'task-runtime-external-owner-control', ownerUserId: runtime.currentUser().id, title: 'External requester delivery control',
    prompt: 'Prepare a result that must be accepted by the external requester.', metadata: {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, workspaceRoot: project.workspaceRoot,
      taskOrigin: 'external_delegation', delegationId: 'external-owner-control-delegation',
    },
  });
  const externalOwnerControlNode = runtime.store.createTaskNode({
    taskRunId: externalOwnerControlTask.id, title: 'External delivery candidate', objective: 'Prepare the result.',
    status: 'running', blocking: true, deferAgentInstanceBinding: true,
  });
  const externalOwnerControlSubmission = runtime.store.recordTaskDeliverySubmission({
    taskRunId: externalOwnerControlTask.id, taskNodeId: externalOwnerControlNode.id,
    submissionKey: 'task-runtime-external-owner-control-submission-1', bodySnapshot: 'External requester version one.',
  });
  runtime.store.transitionTaskDeliveryReview({
    taskRunId: externalOwnerControlTask.id, submissionId: externalOwnerControlSubmission.id,
    eventId: 'task-runtime-external-owner-control-submitted', eventType: 'submitted', payload: {},
  });
  runtime.store.updateTaskRunStatus(externalOwnerControlTask.id, 'verifying', 'Waiting for external requester decision.');
  assert.throws(() => runtime.scheduler.acceptTaskDeliverySubmission({
    taskRunId: externalOwnerControlTask.id,
    submissionId: externalOwnerControlSubmission.id,
    actorId: runtime.currentUser().id,
    eventType: 'owner_accepted',
    acceptanceSource: 'owner_override',
    clientCommandId: 'task-runtime-external-owner-control-direct-command',
  }), (error) => error?.code === 'external_delegation_requester_acceptance_required');
  const externalOwnerControlTurn = await runtime.taskRunWorkspaceTurn({
    taskRunId: externalOwnerControlTask.id,
    content: '采用第一版并结束任务。',
    actionHint: 'accept_submission',
    submissionId: externalOwnerControlSubmission.id,
    clientMessageId: 'task-runtime-external-owner-control-command-1',
  });
  assert.equal(externalOwnerControlTurn.action, 'external_delivery_required');
  const externalOwnerControlled = runtime.store.getTaskRun(externalOwnerControlTask.id);
  assert.equal(externalOwnerControlled.status, 'verifying', 'the recipient must not close an externally delegated task');
  assert.notEqual(externalOwnerControlled.metadata.deliveryReviewOutcome, 'owner_override');
  assert.match(externalOwnerControlTurn.messages.at(-1)?.content || '', /最终是否结束由发出方验收或打回决定/);
  const externalOwnerControlRetry = await runtime.taskRunWorkspaceTurn({
    taskRunId: externalOwnerControlTask.id,
    content: '采用第一版并结束任务。',
    actionHint: 'accept_submission',
    submissionId: externalOwnerControlSubmission.id,
    clientMessageId: 'task-runtime-external-owner-control-command-1',
  });
  assert.equal(externalOwnerControlRetry.action, 'external_delivery_required');
  assert.equal(runtime.store.getTaskRun(externalOwnerControlTask.id).status, 'verifying');

  const supplement = runtime.taskRunWorkspaceMessage({
    taskRunId: task.id,
    content: '补充要求：请在结果中说明名单已经复核。',
    clientMessageId: 'task-runtime-supplement-1',
  });
  assert.equal(supplement.receipt.status, 'queued');
  await waitFor(
    () => ['completed', 'failed'].includes(runtime.store.findAgentWork({
      workKind: 'ubuddy_task_supplement', workId: supplement.receipt.workId,
    })?.status || ''),
    10_000,
    () => ({
      work: runtime.store.findAgentWork({ workKind: 'ubuddy_task_supplement', workId: supplement.receipt.workId }),
      messages: runtime.taskRunWorkspaceMessages({ taskRunId: task.id }).messages,
      tasks: runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 20 })
        .map((item) => runtime.store.getTaskRun(item.id))
        .map((item) => ({ id: item.id, status: item.status, parentTaskRunId: item.metadata?.parentTaskRunId || '', nodes: item.nodes.map((node) => ({ status: node.status, title: node.title })) })),
    }),
  );
  const supplementedWorkspace = runtime.taskRunWorkspaceMessages({ taskRunId: task.id });
  const supplementedRequest = supplementedWorkspace.messages.find((message) => message.metadata?.clientMessageId === 'task-runtime-supplement-1');
  assert.equal(supplementedRequest?.metadata?.queueStatus, 'completed');
  const successor = runtime.store.getTaskRun(supplementedRequest.metadata.successorTaskRunId);
  assert.equal(successor?.metadata?.parentTaskRunId, task.id);
  assert.equal(supplementedWorkspace.activeTaskRunId, successor.id);

  const user = runtime.currentUser();
  const pptRecruitment = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'ppt',
    commandId: 'ubuddy-delegation-state-smoke:ppt',
  });
  const generalInstance = runtime.store.activeEmployeeAgentsForUser({ userId: user.id })
    .find((item) => item.agentFamilyId === 'general_agent');
  const gatedTask = runtime.scheduler.createTaskRun({
    title: '跨用户 uBuddy 交付校验',
    prompt: '由两个 Agent 协作生成并校验交付结果。',
    departmentId: 'collaboration',
    userId: user.id,
    metadata: {
      coordinationAuthority: 'owner_ubuddy',
      leadershipEnforcementMode: 'enforce',
      completionGate: 'delegation_delivery',
      deliveryValidationState: 'pending',
      candidateSnapshots: [
        { agentId: 'general_agent', agentInstanceId: generalInstance.id, departmentId: 'general', leadershipLevel: 'L0' },
        { agentId: 'ppt', agentInstanceId: pptRecruitment.instance.id, departmentId: 'ppt_department', leadershipLevel: 'L0' },
      ],
      taskGraphProposal: { nodes: [
        { localId: 'source', title: '准备内容', objective: '准备交付内容', agentId: 'general_agent', dependencies: [], outputFormat: 'markdown', isFinal: false },
        { localId: 'final', title: '生成交付', objective: '生成最终交付', agentId: 'ppt', dependencies: ['source'], outputFormat: 'pptx', isFinal: true },
      ] },
    },
  });
  assert.equal(gatedTask.metadata.coordinationAuthority, 'owner_ubuddy');
  assert.equal(gatedTask.metadata.coordinationMode, 'appointed_agent_leader');
  const gatedFinalNode = gatedTask.nodes.find((node) => node.id === gatedTask.metadata.finalTaskNodeId)
    || gatedTask.nodes.find((node) => node.parallelGroup === 'final') || gatedTask.nodes.at(-1);
  assert.equal(gatedFinalNode.agentId, gatedTask.leadAgentId, 'multi-Agent final synthesis must belong to the selected leader');
  for (const node of gatedTask.nodes) runtime.store.updateTaskNode(node.id, { status: 'completed', resultText: `${node.title}完成` });
  runtime.scheduler.reconcileTaskStatus(gatedTask.id);
  assert.equal(runtime.store.getTaskRun(gatedTask.id).status, 'verifying');
  runtime.scheduler.completeTaskDeliveryValidation(gatedTask.id, { passed: true, summary: '交付校验通过。' });
  assert.equal(runtime.store.getTaskRun(gatedTask.id).status, 'completed');
  assert.equal(runtime.store.getTaskRun(gatedTask.id).metadata.deliveryValidationState, 'passed');

  const legacyInvalidCommunicationTask = runtime.scheduler.createTaskRun({
    title: '历史非法通信目标容错',
    prompt: '验证历史数据库中的 owner 通信不会打断整个协调波次。',
    userId: user.id,
    metadata: {
      userId: user.id,
      candidateSnapshots: [
        { agentId: 'general_agent', agentInstanceId: generalInstance.id, departmentId: 'general', leadershipLevel: 'L0' },
      ],
      taskGraphProposal: { nodes: [
        { localId: 'final', title: '历史通信验证', objective: '验证非法通信目标容错', agentId: 'general_agent', dependencies: [], outputFormat: 'markdown', isFinal: true },
      ] },
    },
  });
  const legacyInvalidNode = legacyInvalidCommunicationTask.nodes[0];
  runtime.store.updateTaskNode(legacyInvalidNode.id, { status: 'waiting', attemptCount: 1, waitReason: '等待 owner 回复。' });
  const legacyInvalidCommunication = runtime.store.createCommunication({
    taskRunId: legacyInvalidCommunicationTask.id,
    fromAgentId: legacyInvalidNode.agentId,
    toAgentId: 'owner',
    purpose: '历史非法目标',
    requestedInfo: '请 owner 回复',
    blocking: true,
    references: [{ taskNodeId: legacyInvalidNode.id, kind: 'blocking_request_source' }],
  });
  await runtime.scheduler.resolveOpenCommunications(legacyInvalidCommunicationTask.id, { dryRun: true });
  assert.equal(runtime.store.getCommunication(legacyInvalidCommunication.id).status, 'rejected');
  assert.equal(runtime.store.getTaskNode(legacyInvalidNode.id).status, 'retry_wait');
  assert.ok(runtime.store.getTaskRun(legacyInvalidCommunicationTask.id).events.some((event) => event.eventType === 'communication_target_rejected'));

  assert.equal(delegationExecutionFailureDetails(new Error('employee_not_active: no active employee')).code, 'no_active_employee');
  const missingPptSkill = new Error('PPT Skill is missing.');
  missingPptSkill.code = 'ppt_skill_install_required';
  assert.equal(delegationExecutionFailureDetails(missingPptSkill).code, 'ppt_skill_install_required');
  assert.match(delegationExecutionFailureDetails(missingPptSkill).publicMessage, /安装 PPT 制作 Skill/);
  const inactivePptEmployee = new Error('PPT employee is inactive.');
  inactivePptEmployee.code = 'ppt_employee_not_active';
  assert.equal(delegationExecutionFailureDetails(inactivePptEmployee).code, 'ppt_employee_not_active');
  assert.equal(delegationExecutionFailureDetails(new Error('PPT Agent 没有生成 PPTX 文件')).code, 'deliverable_missing');

  runtime.db.prepare(`INSERT INTO agent_delegations (
    id, requester_user_id, recipient_user_id, title, instruction, status, metadata_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'draft_ready', ?, ?)`)
    .run('delegation-stale-import', user.id, user.id, '状态防回退', '验证旧云状态不会覆盖新状态', JSON.stringify({ deliveryState: 'draft_ready' }), '2099-01-01T00:00:00.000Z');
  const relay = new SocialRelayService({ db: runtime.db, auth: runtime.auth });
  relay.importDelegation({
    id: 'delegation-stale-import', requesterUserId: user.id, recipientUserId: user.id,
    title: '状态防回退', instruction: '旧状态', status: 'failed', metadata: { deliveryState: 'blocked' },
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  const staleProtected = runtime.auth.agentDelegationById('delegation-stale-import');
  assert.equal(staleProtected.status, 'draft_ready');
  assert.equal(staleProtected.metadata.deliveryState, 'draft_ready');

  const alice = user;
  const bobRegistration = runtime.auth.registerWithEmail({
    email: 'ubuddy-delegation-bob@example.com',
    password: 'ubuddy-password-123',
    displayName: 'Delegation Bob',
  });
  const bob = bobRegistration.user || bobRegistration;
  runtime.store.provisionNewUserAgentDefaults({ userId: bob.id });
  const [userA, userB] = [alice.id, bob.id].sort();
  runtime.db.prepare(`INSERT INTO friendships (id, user_a_id, user_b_id, status)
    VALUES ('ubuddy-delegation-friendship', ?, ?, 'accepted')`).run(userA, userB);
  runtime.auth.setActiveUser(alice.id);
  const earlyBoundDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '早绑定慢任务验证',
    instruction: '早绑定慢任务验证：请整理一份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  runtime.auth.updateAgentDelegation({ delegationId: earlyBoundDelegation.id, status: 'accepted' });
  const taskRunCountBeforeEarlyBinding = Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count);
  const firstEarlyRun = runtime.startAgentDelegation({ delegationId: earlyBoundDelegation.id, execute: true });
  await waitFor(() => {
    const current = runtime.auth.agentDelegationById(earlyBoundDelegation.id);
    const task = current?.taskRunId ? runtime.store.getTaskRun(current.taskRunId) : null;
    return current?.status === 'running' && Boolean(current.taskRunId)
      && task?.nodes?.some((item) => ['queued', 'running'].includes(item.status));
  });
  const earlyBoundTaskRunId = runtime.auth.agentDelegationById(earlyBoundDelegation.id).taskRunId;
  assert.ok(earlyBoundTaskRunId, 'running delegation was not bound to its task graph');
  const [firstEarlyResult, coalescedEarlyA, coalescedEarlyB] = await Promise.all([
    firstEarlyRun,
    runtime.startAgentDelegation({ delegationId: earlyBoundDelegation.id, execute: true }),
    runtime.startAgentDelegation({ delegationId: earlyBoundDelegation.id, execute: true }),
  ]);
  assert.equal(firstEarlyResult.delegation.status, 'running',
    'unified external delegation should return after Scheduler ownership is established, not wait on synchronous wrapper validation');
  assert.equal(firstEarlyResult.delegation.taskRunId, earlyBoundTaskRunId);
  assert.equal(coalescedEarlyA.delegation.taskRunId, earlyBoundTaskRunId);
  assert.equal(coalescedEarlyB.delegation.taskRunId, earlyBoundTaskRunId);
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count), taskRunCountBeforeEarlyBinding + 1);

  const completedEarlyDelegation = runtime.auth.agentDelegationById(earlyBoundDelegation.id);
  runtime.auth.updateAgentDelegation({
    delegationId: earlyBoundDelegation.id,
    status: 'running',
    taskRunId: '',
    metadata: {
      ...(completedEarlyDelegation.metadata || {}),
      activeTaskRunId: '',
      attemptTaskRunIds: [],
      executionState: 'running',
      deliveryState: 'executing',
    },
  });
  const recoveredEarlyDelegation = await runtime.startAgentDelegation({ delegationId: earlyBoundDelegation.id, execute: true });
  assert.equal(recoveredEarlyDelegation.delegation.status, 'running');
  assert.equal(recoveredEarlyDelegation.delegation.taskRunId, earlyBoundTaskRunId);
  assert.equal(recoveredEarlyDelegation.delegation.metadata.resumedAfterRestart, true);
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count), taskRunCountBeforeEarlyBinding + 1);

  runtime.auth.setActiveUser(alice.id);
  const originalDelegationProcessor = runtime.processAgentDelegationContent;
  let releaseSlowIntake;
  let slowIntakeStarted = 0;
  const slowIntakeGate = new Promise((resolve) => { releaseSlowIntake = resolve; });
  runtime.processAgentDelegationContent = async function processSlowIntake(payload = {}) {
    if (payload.phase === 'intake' && String(payload.content || '').includes('慢接单回执验证')) {
      slowIntakeStarted += 1;
      await slowIntakeGate;
    }
    return originalDelegationProcessor.call(this, payload);
  };
  const slowIntakeDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '慢接单回执验证',
    instruction: '慢接单回执验证：请整理一份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  const secondSlowIntakeDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '慢接单回执验证二',
    instruction: '慢接单回执验证二：请整理另一份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  const thirdSlowIntakeDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '慢接单回执验证三',
    instruction: '慢接单回执验证三：请整理第三份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  const slowPollStartedAt = Date.now();
  await runtime.pollSocialNetwork({ autoProcess: true });
  assert.ok(Date.now() - slowPollStartedAt < 1_000, 'slow intake must not block the social poll');
  const promptlyAccepted = runtime.auth.agentDelegationById(slowIntakeDelegation.id);
  assert.equal(promptlyAccepted.status, 'accepted');
  assert.equal(promptlyAccepted.metadata.intakeStatus, 'processing');
  assert.equal(runtime.auth.agentDelegationById(secondSlowIntakeDelegation.id)?.status, 'accepted');
  assert.equal(runtime.auth.agentDelegationById(thirdSlowIntakeDelegation.id)?.status, 'accepted');
  for (const item of [slowIntakeDelegation, secondSlowIntakeDelegation, thirdSlowIntakeDelegation]) {
    assert.ok(taskUpdates.some((payload) => payload.delegation?.id === item.id
      && payload.change?.type === 'delegation_notice_upserted'),
    'every accepted delegation must publish its receipt before entering the bounded intake queue');
    const received = taskUpdates.find((payload) => payload.delegation?.id === item.id
      && payload.change?.type === 'delegation_progress'
      && payload.change?.progress?.milestones?.some((milestone) => milestone.key === 'delegation_received'));
    assert.equal(received?.change?.progress?.phase, 'queued');
    assert.equal(received?.task, undefined);
    assert.equal(received?.delegation?.taskRunId || '', '');
  }
  await waitFor(() => slowIntakeStarted === 2, 3_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slowIntakeStarted, 2, 'delegation intake concurrency must remain bounded');
  const slowDelegationIds = [slowIntakeDelegation.id, secondSlowIntakeDelegation.id, thirdSlowIntakeDelegation.id];
  const startedSlowDelegationIds = slowDelegationIds.filter((delegationId) => taskUpdates.some((payload) => (
    payload.delegation?.id === delegationId
      && payload.change?.progress?.milestones?.some((milestone) => milestone.key === 'intake_started')
  )));
  assert.equal(startedSlowDelegationIds.length, 2, 'exactly two bounded intake jobs must publish intake_started');
  assert.equal(slowDelegationIds.filter((delegationId) => !startedSlowDelegationIds.includes(delegationId)).length, 1,
    'one queued intake must remain visibly queued until a bounded intake slot is available');
  releaseSlowIntake();
  await waitFor(() => runtime.auth.agentDelegationById(slowIntakeDelegation.id)?.status === 'draft_ready');
  await waitFor(() => runtime.auth.agentDelegationById(secondSlowIntakeDelegation.id)?.status === 'draft_ready');
  await waitFor(() => runtime.auth.agentDelegationById(thirdSlowIntakeDelegation.id)?.status === 'draft_ready');
  const repeatedPollUpdateIndex = taskUpdates.length;
  await runtime.pollSocialNetwork({ autoProcess: false });
  assert.equal(taskUpdates.slice(repeatedPollUpdateIndex).some((payload) => (
    slowDelegationIds.includes(payload.delegation?.id)
      && payload.change?.type === 'delegation_progress'
      && payload.change?.progress?.message === 'uBuddy 正在整理任务要求、附件和公开上下文'
  )), false, 'completed intake progress must not regress to intake_started during a later refresh poll');
  runtime.processAgentDelegationContent = originalDelegationProcessor;

  runtime.auth.setActiveUser(alice.id);
  const createdDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '跨用户 uBuddy 调度验证',
    instruction: '请整理一份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE = 'enforce';
  runtime.auth.setActiveUser(bob.id);
  throwTaskUpdate = true;
  try {
    await runtime.pollSocialNetwork({ autoProcess: true });
    await waitFor(() => runtime.auth.agentDelegationById(createdDelegation.id)?.status === 'draft_ready');
  } finally {
    throwTaskUpdate = false;
  }
  const readyDelegation = runtime.auth.agentDelegationById(createdDelegation.id);
  const delegationTask = runtime.store.getTaskRun(readyDelegation.taskRunId);
  assert.equal(readyDelegation.metadata.executionState, 'completed');
  assert.equal(readyDelegation.metadata.deliveryState, 'awaiting_delivery');
  assert.equal(delegationTask.status, 'completed');
  assert.equal(delegationTask.metadata.coordinationAuthority, 'owner_ubuddy');
  assert.ok(['pending', 'passed'].includes(delegationTask.metadata.deliveryValidationState));
  assert.equal(delegationTask.metadata.finalDelivery.state, 'delivered',
    'eligible Scheduler delivery must be visible before the advisory quality review finishes');
  const taskRunCountBeforeResume = Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count);
  runtime.auth.updateAgentDelegation({
    delegationId: readyDelegation.id,
    status: 'running',
    metadata: { ...(readyDelegation.metadata || {}), deliveryState: 'executing', resumedAfterRestart: true },
  });
  const resumedDelegation = await runtime.startAgentDelegation({ delegationId: readyDelegation.id, execute: true });
  assert.equal(resumedDelegation.delegation.status, 'draft_ready');
  assert.equal(resumedDelegation.delegation.taskRunId, readyDelegation.taskRunId);
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count), taskRunCountBeforeResume);
  const firstAttemptTaskRunId = readyDelegation.taskRunId;
  const blockedForFreshAttempt = runtime.auth.updateAgentDelegation({
    delegationId: readyDelegation.id,
    status: 'blocked',
    taskRunId: '',
    lastError: '旧执行尝试未完成。',
    metadata: {
      ...(resumedDelegation.delegation.metadata || {}),
      activeTaskRunId: '',
      attemptTaskRunIds: [firstAttemptTaskRunId],
      executionState: 'failed',
      deliveryState: 'blocked',
      failureCode: 'model_unavailable',
      failureStage: 'execution',
      retryable: true,
      publicFailure: {
        code: 'model_unavailable',
        stage: 'execution',
        message: '旧执行尝试未完成。',
        retryable: true,
        occurredAt: new Date().toISOString(),
      },
    },
  });
  assert.equal(blockedForFreshAttempt.status, 'blocked');
  runtime.store.updateTaskRunMetadata(firstAttemptTaskRunId, {
    completionGate: 'delegation_delivery',
    deliveryValidationState: 'pending',
  });
  runtime.store.updateTaskRunStatus(firstAttemptTaskRunId, 'verifying', 'Agent nodes completed; validating the final delivery.');
  const taskRunCountBeforeFreshAttempt = Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count);
  const freshAttempt = await runtime.startAgentDelegation({ delegationId: readyDelegation.id, execute: true });
  assert.equal(freshAttempt.delegation.status, 'running');
  assert.equal(freshAttempt.delegation.taskRunId, firstAttemptTaskRunId);
  assert.equal(freshAttempt.delegation.metadata.failureCode, '');
  assert.equal(freshAttempt.delegation.metadata.publicFailure, null);
  assert.equal(Number(runtime.db.prepare('SELECT COUNT(*) AS count FROM task_runs').get().count), taskRunCountBeforeFreshAttempt);
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM work_scopes
    WHERE federation_type='delegation' AND federation_id=?`).get(readyDelegation.id).count, 1);
  runtime.store.updateTaskRunStatus(firstAttemptTaskRunId, 'failed', 'Superseded before constructing the latest failed attempt.');
  const failedLatestTask = runtime.scheduler.createTaskRun({
    title: '委托失败新尝试防旧结果复活',
    prompt: '模拟同一委托的最新执行尝试已经失败。',
    userId: bob.id,
    metadata: {
      userId: bob.id,
      delegationId: readyDelegation.id,
      coordinationAuthority: 'owner_ubuddy',
    },
  });
  runtime.store.updateTaskRunStatus(failedLatestTask.id, 'failed', 'Simulated latest attempt failure.');
  runtime.auth.updateAgentDelegation({
    delegationId: readyDelegation.id,
    status: 'blocked',
    taskRunId: '',
    metadata: {
      ...(freshAttempt.delegation.metadata || {}),
      activeTaskRunId: '',
      attemptTaskRunIds: [firstAttemptTaskRunId, failedLatestTask.id],
      executionState: 'failed',
      deliveryState: 'blocked',
      failureCode: 'execution_failed',
      failureStage: 'execution',
      retryable: true,
    },
  });
  const retryAfterLatestFailure = await runtime.startAgentDelegation({ delegationId: readyDelegation.id, execute: true });
  assert.equal(retryAfterLatestFailure.delegation.status, 'running');
  assert.notEqual(retryAfterLatestFailure.delegation.taskRunId, firstAttemptTaskRunId);
  assert.notEqual(retryAfterLatestFailure.delegation.taskRunId, failedLatestTask.id);
  assert.equal(runtime.store.getTaskRun(failedLatestTask.id).status, 'failed');
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM work_scopes
    WHERE federation_type='delegation' AND federation_id=?`).get(readyDelegation.id).count, 1);
  runtime.auth.setActiveUser(alice.id);
  const invalidOwnerTargetDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '非法 owner 通信接管验证',
    instruction: '非法 owner 通信接管验证：请整理一份清朝皇帝名单并形成可提交初稿。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  runtime.auth.updateAgentDelegation({ delegationId: invalidOwnerTargetDelegation.id, status: 'accepted' });
  const invalidOwnerStarted = await runtime.startAgentDelegation({ delegationId: invalidOwnerTargetDelegation.id, execute: true });
  const invalidOwnerTaskRunId = invalidOwnerStarted.delegation.taskRunId;
  await waitFor(() => runtime.store.getTaskRun(invalidOwnerTaskRunId)?.events.some((event) => (
    event.eventType === 'node_retry_scheduled' && event.payload?.errorCode === 'invalid_communication_target'
  )), 5_000);
  const invalidOwnerPending = runtime.store.getTaskRun(invalidOwnerTaskRunId);
  assert.equal(invalidOwnerStarted.delegation.status, 'running');
  assert.equal(invalidOwnerPending.status, 'waiting');
  assert.ok(invalidOwnerPending.nodes.some((node) => node.status === 'retry_wait'
    && node.lastErrorCode === 'invalid_communication_target'));
  assert.ok(invalidOwnerPending.events.some((event) => event.eventType === 'node_retry_scheduled'
    && event.payload?.errorCode === 'invalid_communication_target'));
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM communications
    WHERE task_run_id=? AND to_agent_id='owner'`).get(invalidOwnerTaskRunId).count, 0);
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM work_scopes
    WHERE federation_type='delegation' AND federation_id=?`).get(invalidOwnerTargetDelegation.id).count, 1);
  const bobGeneral = runtime.store.findUserAgentInstance({ userId: bob.id, agentFamilyId: 'general_agent' });
  assert.equal(bobGeneral.employmentState, 'active');
  const bobPpt = runtime.store.findUserAgentInstance({ userId: bob.id, agentFamilyId: 'ppt' });
  if (bobPpt) {
    runtime.db.prepare(`UPDATE user_agent_instances
      SET status = 'inactive', employment_state = 'inactive', pending_target_state = '', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), bobPpt.id);
  }
  runtime.auth.setActiveUser(alice.id);
  const blockedPptDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '电路 PPT 预检',
    instruction: '请制作一个电路设计 PPT，并提交可交付的 PPTX 文件。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  await runtime.pollSocialNetwork({ autoProcess: true });
  await waitFor(() => runtime.auth.agentDelegationById(blockedPptDelegation.id)?.status === 'blocked');
  const pptPreflightBlocked = runtime.auth.agentDelegationById(blockedPptDelegation.id);
  assert.equal(pptPreflightBlocked.metadata.failureCode, 'ppt_employee_not_active');
  assert.equal(pptPreflightBlocked.metadata.failureStage, 'preflight');
  assert.equal(pptPreflightBlocked.taskRunId, '');

  runtime.db.prepare(`UPDATE user_agent_instances
    SET status = 'inactive', employment_state = 'inactive', pending_target_state = '', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), bobGeneral.id);
  runtime.auth.setActiveUser(alice.id);
  const blockedDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '无可用 Agent 预检',
    instruction: '请执行一个需要员工 Agent 的任务。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  await runtime.pollSocialNetwork({ autoProcess: true });
  await waitFor(() => runtime.auth.agentDelegationById(blockedDelegation.id)?.status === 'blocked');
  const preflightBlocked = runtime.auth.agentDelegationById(blockedDelegation.id);
  assert.equal(preflightBlocked.metadata.failureCode, 'no_active_employee');
  assert.equal(preflightBlocked.metadata.deliveryState, 'blocked');
  assert.equal(preflightBlocked.taskRunId, '');

  runtime.db.prepare(`UPDATE user_agent_instances
    SET status = 'active', employment_state = 'active', pending_target_state = '', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), bobGeneral.id);
  runtime.auth.setActiveUser(alice.id);
  const resilientDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    groupId: 'workspace-sync-resilience-group',
    title: '共享工作区断网继续执行',
    instruction: '请整理一份清朝皇帝名单，并形成可提交的任务初稿。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  runtime.auth.updateAgentDelegation({ delegationId: resilientDelegation.id, status: 'accepted' });
  const originalConnected = SocialRelayService.prototype.connected;
  const originalGroupWorkspace = SocialRelayService.prototype.collaborationGroupWorkspace;
  const originalUploadGroupWorkspaceFile = SocialRelayService.prototype.uploadCollaborationGroupWorkspaceFile;
  const originalDelegationWorkspace = SocialRelayService.prototype.delegationWorkspace;
  const originalUpdateDelegation = SocialRelayService.prototype.updateDelegation;
  SocialRelayService.prototype.connected = () => true;
  SocialRelayService.prototype.collaborationGroupWorkspace = async () => {
    const error = new Error('fetch failed: simulated shared workspace outage');
    error.code = 'ECONNRESET';
    throw error;
  };
  SocialRelayService.prototype.uploadCollaborationGroupWorkspaceFile = async () => {
    const error = new Error('fetch failed: simulated shared workspace upload outage');
    error.code = 'ECONNRESET';
    throw error;
  };
  SocialRelayService.prototype.delegationWorkspace = async () => null;
  SocialRelayService.prototype.updateDelegation = async () => ({ ok: true });
  try {
    const resilientStarted = await runtime.startAgentDelegation({ delegationId: resilientDelegation.id, execute: true });
    assert.equal(resilientStarted.delegation.status, 'running');
    assert.ok(resilientStarted.delegation.taskRunId);
    assert.equal(runtime.store.getTaskRun(resilientStarted.delegation.taskRunId).metadata.deliveryAuthority, 'scheduler');
    assert.ok(taskUpdates.some((payload) => payload.delegation?.id === resilientDelegation.id
      && payload.change?.type === 'delegation_progress'
      && ['planning', 'executing'].includes(payload.change?.progress?.phase)));
    runtime.cancelTaskRun({ taskRunId: resilientStarted.delegation.taskRunId });
    await waitFor(() => runtime.store.getTaskRun(resilientStarted.delegation.taskRunId)?.status === 'cancelled');
  } finally {
    SocialRelayService.prototype.connected = originalConnected;
    SocialRelayService.prototype.collaborationGroupWorkspace = originalGroupWorkspace;
    SocialRelayService.prototype.uploadCollaborationGroupWorkspaceFile = originalUploadGroupWorkspaceFile;
    SocialRelayService.prototype.delegationWorkspace = originalDelegationWorkspace;
    SocialRelayService.prototype.updateDelegation = originalUpdateDelegation;
  }
  runtime.auth.setActiveUser(alice.id);
  process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS = '1';
  process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE = 'shadow';
  const clarificationGeneral = runtime.store.recruitUserAgent({
    userId: bob.id,
    agentFamilyId: 'general_agent',
    commandId: 'ubuddy-task-runtime:clarification-general-b',
  }).instance;
  runtime.db.prepare(`UPDATE user_agent_instances
    SET status = 'inactive', employment_state = 'inactive', pending_target_state = '', updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), bobGeneral.id);
  assert.equal(clarificationGeneral.employmentState, 'active');
  const clarificationDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '外部委托澄清续接验证',
    instruction: '请根据已授权披露的历史使用规律，完成外部委托澄清续接验证。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  runtime.auth.updateAgentDelegation({ delegationId: clarificationDelegation.id, status: 'accepted' });
  const clarificationStarted = await runtime.startAgentDelegation({ delegationId: clarificationDelegation.id, execute: true });
  assert.equal(clarificationStarted.clarification?.question, '请具体说明可授权披露的历史使用规律概括。');
  const clarificationWaiting = runtime.auth.agentDelegationById(clarificationDelegation.id);
  assert.equal(clarificationWaiting?.taskRunId, '');
  assert.equal(clarificationWaiting?.status, 'accepted');
  assert.equal(clarificationWaiting?.metadata?.dependencyState, 'waiting');
  assert.equal(clarificationWaiting?.metadata?.dependencyReasonCode, 'owner_input_required');
  assert.equal(clarificationWaiting?.metadata?.executionProgress?.phase, 'waiting');
  assert.equal(clarificationWaiting?.metadata?.executionProgress?.lifecyclePhase, 'confirming');
  assert.match(clarificationWaiting?.metadata?.executionProgress?.message || '', /等待接收方补充信息/);
  assert.equal(clarificationWaiting?.metadata?.executionProgress?.blocker?.userActionRequired, true);
  const clarificationNotice = runtime.store.listMessages(clarificationStarted.message.sessionId)
    .find((message) => message.id === clarificationStarted.message.id);
  assert.equal(clarificationNotice.metadata.externalDelegationClarification.question,
    '请具体说明可授权披露的历史使用规律概括。');
  const clarificationResumed = await runtime.collaborationWorkspaceMessage({
    delegationId: clarificationDelegation.id,
    content: '使用ubuddy较多',
    background: false,
  });
  assert.equal(clarificationResumed.action, 'clarification_response');
  assert.equal(clarificationResumed.unified, true);
  assert.ok(clarificationResumed.task?.id,
    'an external clarification answer must resume the original delegation instead of entering generic task intake');
  const clarificationBound = runtime.auth.agentDelegationById(clarificationDelegation.id);
  assert.equal(clarificationBound.taskRunId, clarificationResumed.task.id);
  assert.equal(clarificationBound.metadata.externalDelegationClarificationAnswers.at(-1).answer, '使用ubuddy较多');
  assert.equal(clarificationBound.metadata.externalDelegationClarificationAnswers.at(-1).source, 'delegation_workspace');
  assert.equal(clarificationResumed.task.metadata.executionOptions.permissionMode, 'full-access');
  assert.equal(runtime.store.getMessage(clarificationStarted.message.id).metadata.externalDelegationClarification, null);
  await waitFor(() => runtime.auth.agentDelegationById(clarificationDelegation.id)?.status === 'draft_ready', 15_000, () => ({
    delegation: runtime.auth.agentDelegationById(clarificationDelegation.id),
    task: runtime.store.getTaskRun(clarificationResumed.task.id),
  }));
  const clarificationTaskAfterDelivery = runtime.store.getTaskRun(clarificationResumed.task.id);
  const retryInheritanceNode = clarificationTaskAfterDelivery.nodes.find((node) => node.status === 'completed') || clarificationTaskAfterDelivery.nodes[0];
  runtime.store.updateTaskRunStatus(clarificationTaskAfterDelivery.id, 'running', 'Simulate manual retry after delivery warning.');
  runtime.store.updateTaskNode(retryInheritanceNode.id, {
    status: 'retry_wait',
    errorText: 'Simulated retry inheritance check.',
    waitReason: 'Simulated retry inheritance check.',
  });
  const retryInherited = await runtime.retryTaskNode({
    taskRunId: clarificationTaskAfterDelivery.id,
    taskNodeId: retryInheritanceNode.id,
    options: { model: '', reasoningEffort: '' },
  });
  assert.equal(retryInherited.metadata.executionOptions.permissionMode, 'full-access',
    'manual node retry must inherit the task permission instead of falling back to the global composer permission');

  runtime.auth.setActiveUser(alice.id);
  const unifiedDelegation = runtime.createAgentDelegation({
    recipientId: bob.id,
    title: '外部委托统一主 uBuddy 链路',
    instruction: '请整理一份清朝皇帝名单，并形成可确认交付的结果。',
  }).delegation;
  runtime.auth.setActiveUser(bob.id);
  runtime.auth.updateAgentDelegation({ delegationId: unifiedDelegation.id, status: 'accepted' });
  const unifiedStarted = await runtime.startAgentDelegation({ delegationId: unifiedDelegation.id, execute: true });
  assert.equal(unifiedStarted.unified, true);
  assert.equal(unifiedStarted.resuming, true);
  assert.ok(taskUpdates.some((payload) => (
    payload.delegation?.id === unifiedDelegation.id
    && payload.change?.type === 'delegation_notice_upserted'
    && payload.message?.metadata?.externalDelegationId === unifiedDelegation.id
    && payload.session?.id === payload.message?.sessionId
  )), 'external delegation intake must emit a renderer-consumable uBuddy notice projection');
  await waitFor(() => runtime.auth.agentDelegationById(unifiedDelegation.id)?.status === 'draft_ready', 15_000, () => {
    const current = runtime.auth.agentDelegationById(unifiedDelegation.id);
    const task = current?.taskRunId ? runtime.store.getTaskRun(current.taskRunId) : null;
    return { delegation: current, task };
  });
  const unifiedReady = runtime.auth.agentDelegationById(unifiedDelegation.id);
  const unifiedTask = runtime.store.getTaskRun(unifiedReady.taskRunId);
  assert.equal(unifiedTask.metadata.source, 'ubuddy_dispatch');
  assert.equal(unifiedTask.metadata.taskOrigin, 'external_delegation');
  assert.equal(unifiedTask.metadata.ubuddyWorkspaceScope, 'isolated_external_delegation');
  assert.equal(unifiedTask.metadata.conversationId, '');
  assert.equal(unifiedTask.metadata.delegationWorkspaceSessionId, unifiedReady.sessionId);
  assert.ok(Array.isArray(unifiedReady.metadata.executionProgress?.nodes));
  assert.ok(unifiedReady.metadata.executionProgress.nodes.every((node) => (
    node.title && node.agentName && node.status && !node.summary.includes('/home/')
  )));
  assert.equal(unifiedReady.metadata.executionProgress?.blocker, null);
  const ownerSessionMessages = runtime.store.listMessages(unifiedReady.metadata.ownerSecretarySessionId);
  const ownerTaskMessage = ownerSessionMessages.find((message) => message.metadata?.externalDelegationId === unifiedDelegation.id
    && message.metadata?.uBuddyTaskQueued && message.metadata?.taskRunId === unifiedTask.id);
  assert.ok(ownerTaskMessage);
  assert.equal(ownerTaskMessage.metadata.externalDelegationDeliveryDraft.submissionText, unifiedReady.metadata.preliminaryResult);
  assert.ok(ownerTaskMessage.metadata.externalDelegationDeliveryDraft.candidateMessageId);
  assert.ok(ownerTaskMessage.metadata.externalDelegationDeliveryDraft.attachments.length > 0);
  assert.ok(ownerTaskMessage.metadata.externalDelegationDeliveryDraft.attachments.every((item) => item.selectionKey));
  const hiddenIngress = runtime.db.prepare('SELECT visible, metadata_json FROM messages WHERE session_id = ? AND visible = 0')
    .all(unifiedReady.metadata.ownerSecretarySessionId)
    .find((message) => JSON.parse(message.metadata_json || '{}')?.externalDelegationIngress);
  assert.ok(hiddenIngress);
  const unifiedSubmitted = await runtime.respondAgentDelegation({
    delegationId: unifiedDelegation.id,
    action: 'submit',
    message: '编辑后的清朝皇帝名单交付结果。',
    selectedGeneratedAttachmentKeys: [],
    sourceWorkspaceMessageId: ownerTaskMessage.metadata.externalDelegationDeliveryDraft.candidateMessageId,
    sourceWorkspaceRevisionId: ownerTaskMessage.metadata.externalDelegationDeliveryDraft.candidateRevisionId,
  });
  assert.equal(unifiedSubmitted.delegation.status, 'submitted');
  assert.equal(unifiedSubmitted.delegation.metadata.latestResult, '编辑后的清朝皇帝名单交付结果。');
  assert.deepEqual(unifiedSubmitted.delegation.metadata.resultAttachments || [], []);
  const submittedOwnerTaskMessage = runtime.store.listMessages(unifiedReady.metadata.ownerSecretarySessionId)
    .find((message) => message.id === ownerTaskMessage.id);
  assert.equal(submittedOwnerTaskMessage.metadata.externalDelegationStatus, 'submitted');
  assert.equal(submittedOwnerTaskMessage.metadata.externalDelegationSubmittedSnapshot.content, '编辑后的清朝皇帝名单交付结果。');
  assert.deepEqual(submittedOwnerTaskMessage.metadata.externalDelegationSubmittedSnapshot.attachments, []);
  process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS = '0';
  runtime.auth.setActiveUser(alice.id);
  assert.equal(runtime.auth.agentDelegationById(unifiedDelegation.id)?.status, 'submitted');
  const localAcceptance = await runtime.collaborationTaskAction({
    delegationId: unifiedDelegation.id, action: 'accept_result', expectedStatus: 'submitted',
  });
  assert.equal(localAcceptance.delegation.status, 'result_accepted');
  const localAcceptanceRevisionCount = runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id = ? AND action = 'accept_result'").get(unifiedDelegation.id).count;
  const localAcceptanceRetry = await runtime.collaborationTaskAction({
    delegationId: unifiedDelegation.id, action: 'accept_result', expectedStatus: 'submitted',
  });
  assert.equal(localAcceptanceRetry.idempotent, true);
  assert.equal(localAcceptanceRetry.delegation.status, 'result_accepted');
  assert.equal(runtime.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id = ? AND action = 'accept_result'").get(unifiedDelegation.id).count, localAcceptanceRevisionCount,
    'local acceptance retry must not create another revision');
  if (previousLeadershipEnforcement === undefined) delete process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE;
  else process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE = previousLeadershipEnforcement;

  const slow = await runtime.secretaryChat({ sessionId: session.id, message: '请使用多 Agent workflow 执行慢任务取消验证。' });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(slow.uBuddyMode));
  await waitFor(() => runtime.store.getTaskRun(slow.taskRunId)?.nodes?.some((node) => node.status === 'running'));
  await waitFor(() => taskUpdates.some((payload) => payload.task?.id === slow.taskRunId && payload.change?.type === 'node_heartbeat'));
  const persistedProgress = runtime.store.listMessages(session.id).find((message) => message.metadata?.taskRunId === slow.taskRunId && message.metadata?.uBuddyTaskQueued);
  assert.equal(persistedProgress?.metadata?.taskSnapshot?.taskStatus, 'running');
  assert.equal(persistedProgress?.metadata?.taskSnapshot?.progress?.running, 1);
  const cancelled = runtime.cancelTaskRun({ taskRunId: slow.taskRunId });
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.nodes.every((node) => ['completed', 'cancelled'].includes(node.status)));
  const rerun = await runtime.rerunTaskRun({ taskRunId: slow.taskRunId });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(rerun.uBuddyMode));
  assert.notEqual(rerun.taskRunId, slow.taskRunId);
  assert.equal(rerun.task.metadata.parentTaskRunId, slow.taskRunId);
  assert.equal(rerun.task.metadata.projectId, project.id);
  assert.equal(rerun.task.metadata.workspaceRoot, project.workspaceRoot);
  runtime.cancelTaskRun({ taskRunId: rerun.taskRunId });
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  console.log('uBuddy task runtime smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousHeartbeat === undefined) delete process.env.JANUS_UBUDDY_NODE_HEARTBEAT_MS;
  else process.env.JANUS_UBUDDY_NODE_HEARTBEAT_MS = previousHeartbeat;
  if (previousLeadershipEnforcement === undefined) delete process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE;
  else process.env.JANUS_LEADERSHIP_ENFORCEMENT_MODE = previousLeadershipEnforcement;
  if (previousUnifiedExternalTasks === undefined) delete process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS;
  else process.env.JANUS_EXTERNAL_UBUDDY_UNIFIED_TASKS = previousUnifiedExternalTasks;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  if (previousStructuredReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredReferenceFlag;
  if (previousBoundedReviewFlag === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedReviewFlag;
  if (previousRecoveryCounter === undefined) delete process.env.JANUS_FAKE_RECOVERY_COUNTER;
  else process.env.JANUS_FAKE_RECOVERY_COUNTER = previousRecoveryCounter;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 10_000, diagnostics = null) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      const details = typeof diagnostics === 'function' ? diagnostics() : null;
      throw new Error(`Timed out waiting for uBuddy task runtime.${details ? ` State: ${JSON.stringify(details)}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
