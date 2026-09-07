import { strict as assert } from 'node:assert';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime, uBuddyModelProviderReadiness, withWorkspaceBoundary } from '../src/main/runtime.js';
import { classifyTaskNodeError } from '../src/main/scheduler.js';
import { taskNodeModelTimeoutMs, taskNodeRecoveryTimeoutMs } from '../src/main/modules/orchestration/domain/taskNodeTimeoutPolicy.js';
import { buildTaskNodePrompt } from '../src/main/prompts.js';

assert.equal(taskNodeModelTimeoutMs({ node: { estimatedMinutes: 30 }, env: {} }), 35 * 60_000);
assert.equal(taskNodeModelTimeoutMs({ node: { estimatedMinutes: 1 }, env: {} }), 30 * 60_000);
assert.equal(taskNodeModelTimeoutMs({ node: { estimatedMinutes: 90 }, env: {} }), 60 * 60_000);
assert.equal(taskNodeRecoveryTimeoutMs({ node: { estimatedMinutes: 30 }, env: {} }), 37 * 60_000);
assert.equal(taskNodeModelTimeoutMs({ node: { estimatedMinutes: 30 }, env: { JANUS_UBUDDY_TASK_NODE_MODEL_TIMEOUT_MS: '12345' } }), 12345);
assert.equal(taskNodeRecoveryTimeoutMs({ node: { estimatedMinutes: 30 }, overrideMs: 42, env: {} }), 42);

const bounded = withWorkspaceBoundary('Complete the task.', 'C:\\Users\\User\\Desktop\\hello');
assert.match(bounded, /workspace-relative paths/);
assert.match(bounded, /do not prefix paths with the project root, a drive letter, \$HOME/);

const retryPromptNode = {
  id: 'retry-prompt-node', title: '生成 DOCX', objective: '生成可编辑 DOCX 报告。', status: 'running',
  agentId: 'general_agent', attemptCount: 2, maxAttempts: 3, estimatedMinutes: 30,
  lastErrorCode: 'execution_timeout', errorText: 'Timed out.', dependencies: [], notify: [], recoveryActions: [], blocking: true,
};
const retryPrompt = buildTaskNodePrompt({
  taskRun: {
    id: 'retry-prompt-task', title: '文献报告', prompt: '检索文献并生成 DOCX。', leadAgentId: 'general_agent',
    metadata: {}, nodes: [retryPromptNode], events: [
      { taskNodeId: retryPromptNode.id, eventType: 'node_activity', status: 'completed', summary: '两篇研究已经完成全文核验。', payload: { itemType: 'agentMessage' } },
      { taskNodeId: retryPromptNode.id, eventType: 'node_activity', status: 'failed', summary: '文件处理失败：C:\\tmp\\build.py', payload: { itemType: 'fileChange' } },
    ],
  },
  node: retryPromptNode,
  agent: { id: 'general_agent', name: 'Generalist', description: 'General task Agent.' },
  skill: '', memory: '',
});
assert.match(retryPrompt, /Continue from useful verified work instead of restarting the entire node/);
assert.match(retryPrompt, /两篇研究已经完成全文核验/);
assert.match(retryPrompt, /never pass an absolute path to a file-edit tool/);
assert.match(retryPrompt, /Use workspace-relative paths for every file-edit operation/);

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-retry-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-retry-bin-'));
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-retry-project-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
process.exit(0);
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

assert.deepEqual(uBuddyModelProviderReadiness({
  root,
  codexBin: '/tmp/fake-codex.mjs',
  configStatus: () => ({ credentialSource: 'missing' }),
}), { ready: true, source: 'test' });
assert.equal(uBuddyModelProviderReadiness({
  root,
  codexBin: '/usr/bin/codex',
  testMode: false,
  configStatus: () => ({ credentialSource: 'missing' }),
}).code, 'model_provider_not_ready');
assert.equal(uBuddyModelProviderReadiness({
  root,
  codexBin: '/usr/bin/codex',
  configStatus: () => ({ credentialSource: 'stored', hasApiKey: true, baseUrl: 'https://provider.invalid', model: 'model', userProviderOverrideValidated: false }),
}).ready, false);
assert.equal(uBuddyModelProviderReadiness({
  root,
  codexBin: '/usr/bin/codex',
  configStatus: () => ({ credentialSource: 'stored', hasApiKey: true, baseUrl: 'https://provider.invalid', model: 'model', userProviderOverrideValidated: true }),
}).ready, true);

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const session = runtime.ensureSecretarySession();
  const project = runtime.createProject({ title: 'Retry reliability', workspaceRoot: projectRoot });

  const preflightTask = runtime.store.createTaskRun({
    id: 'task-provider-preflight', ownerUserId: runtime.currentUser().id, title: 'Provider preflight',
    prompt: 'Verify provider preflight.', initialStatus: 'ready', deferAgentInstanceBinding: true,
  });
  const preflightNode = runtime.store.createTaskNode({
    taskRunId: preflightTask.id, title: 'Preflight node', objective: 'Must not be claimed.',
    agentId: 'general_agent', departmentId: 'general', status: 'ready', deferAgentInstanceBinding: true,
  });
  const originalReadiness = runtime.scheduler.modelProviderReadiness;
  runtime.scheduler.modelProviderReadiness = () => ({
    ready: false, code: 'model_provider_not_ready', message: 'Provider configuration must be validated.',
  });
  await assert.rejects(
    runtime.scheduler.runReadyNodes(preflightTask.id),
    (error) => error.code === 'model_provider_not_ready',
  );
  assert.equal(runtime.store.getTaskNode(preflightNode.id).status, 'ready',
    'provider preflight must fail before a node is claimed');
  runtime.scheduler.modelProviderReadiness = originalReadiness;

  const circuitTask = runtime.store.createTaskRun({
    id: 'task-credential-circuit', ownerUserId: runtime.currentUser().id, title: 'Credential circuit',
    prompt: 'Verify credential circuit.', initialStatus: 'running', deferAgentInstanceBinding: true,
  });
  const credentialNode = runtime.store.createTaskNode({
    taskRunId: circuitTask.id, title: 'Credential failure', objective: 'Fail authentication.',
    agentId: 'general_agent', departmentId: 'general', status: 'running', blocking: true, deferAgentInstanceBinding: true,
  });
  const pausedNode = runtime.store.createTaskNode({
    taskRunId: circuitTask.id, title: 'Independent pending node', objective: 'Wait for credentials.',
    agentId: 'general_agent', departmentId: 'general', status: 'ready', blocking: true, deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskNode(credentialNode.id, { attemptCount: 1 });
  const credentialFailure = classifyTaskNodeError(new Error('401 Unauthorized: Invalid API key'));
  assert.equal(credentialFailure.code, 'credential_required');
  assert.equal(credentialFailure.blocked, true);
  runtime.scheduler.handleNodeExecutionFailure(runtime.store.getTaskRun(circuitTask.id), runtime.store.getTaskNode(credentialNode.id), {
    errorSummary: '401 Unauthorized: Invalid API key', failure: credentialFailure,
  });
  assert.equal(runtime.store.getTaskNode(credentialNode.id).status, 'blocked');
  assert.equal(runtime.scheduler.canRequestUBuddyFailureRecovery(
    runtime.store.getTaskRun(circuitTask.id),
    runtime.store.getTaskNode(credentialNode.id),
    credentialFailure,
  ), false, 'credential failures must require user action instead of automatic bounded recovery');
  assert.equal(runtime.store.getTaskNode(pausedNode.id).lastErrorCode, 'credential_dependency_blocked');
  runtime.store.updateTaskNode(credentialNode.id, { status: 'completed', lastErrorCode: '', errorText: '', completedAt: new Date().toISOString() });
  runtime.scheduler.restoreCredentialBlockedNodes(circuitTask.id);
  assert.equal(runtime.store.getTaskNode(pausedNode.id).status, 'ready');
  assert.equal(runtime.store.getTaskNode(pausedNode.id).lastErrorCode, '');

  const manualRetryTask = runtime.store.createTaskRun({
    id: 'task-manual-retry-reset', ownerUserId: runtime.currentUser().id, title: 'Manual retry reset',
    prompt: 'Verify stale errors are cleared.', initialStatus: 'failed', deferAgentInstanceBinding: true,
  });
  const manualRetryNode = runtime.store.createTaskNode({
    taskRunId: manualRetryTask.id, title: 'Retry reset', objective: 'Reset stale errors.',
    agentId: 'general_agent', departmentId: 'general', status: 'failed', blocking: true,
    deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskNode(manualRetryNode.id, {
    lastErrorCode: 'credential_required', errorText: '401 Unauthorized', completedAt: new Date().toISOString(),
  });
  await runtime.scheduler.retryFailedNode(manualRetryTask.id, manualRetryNode.id, { deferExecution: true });
  assert.equal(runtime.store.getTaskNode(manualRetryNode.id).status, 'ready');
  assert.equal(runtime.store.getTaskNode(manualRetryNode.id).lastErrorCode, '');
  assert.equal(runtime.store.getTaskNode(manualRetryNode.id).errorText, '');

  const task = runtime.store.createTaskRun({
    id: 'task-retry-reliability', ownerUserId: runtime.currentUser().id, title: '自动重试通知验证',
    prompt: '验证自动重试任务卡。', initialStatus: 'running', deferAgentInstanceBinding: true,
    metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, workspaceRoot: project.workspaceRoot },
  });
  const node = runtime.store.createTaskNode({
    taskRunId: task.id, title: '生成报告文件', objective: '生成报告文件。', agentId: 'general_agent',
    departmentId: 'general', status: 'running', blocking: true, maxAttempts: 3, estimatedMinutes: 30,
    deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskNode(node.id, { attemptCount: 1, startedAt: new Date().toISOString() });
  runtime.store.recordTaskEvent({
    taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity', actorId: 'general_agent',
    status: 'completed', summary: '两篇文献已经完成全文核验。', payload: { activityType: 'agent', itemType: 'agentMessage' },
  });
  runtime.store.recordTaskEvent({
    taskRunId: task.id, taskNodeId: node.id, eventType: 'node_activity', actorId: 'general_agent',
    status: 'failed', summary: '文件处理失败：$HOME\\Desktop\\hello\\build.py', payload: { activityType: 'file', itemType: 'fileChange' },
  });
  const cardMessage = runtime.store.addMessage({
    sessionId: session.id, role: 'assistant', content: '任务已进入队列。', agentId: 'secretary_agent',
    departmentId: 'secretary_department', metadata: { uBuddyTaskQueued: true, taskRunId: task.id },
  });
  const messageCount = runtime.store.listMessages(session.id).length;
  const waitingNode = runtime.scheduler.handleNodeExecutionFailure(
    runtime.store.getTaskRun(task.id), runtime.store.getTaskNode(node.id), {
      errorSummary: 'Codex app-server timed out after 900000ms.',
      failure: { code: 'execution_timeout', retryable: true, userActionRequired: false, userMessage: '执行超时，系统将自动重试。' },
    },
  );
  assert.equal(waitingNode.status, 'retry_wait');
  assert.equal(runtime.store.listMessages(session.id).length, messageCount);
  let card = runtime.store.getMessage(cardMessage.id);
  assert.match(card.content, /文件写入步骤未完成，随后执行超时/);
  assert.match(card.content, /第 2\/3 次自动重试/);
  assert.doesNotMatch(card.content, /app-server|\$HOME|[A-Z]:\\/i);
  assert.equal(card.metadata.retryNotice?.state, 'scheduled');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 })
    .find((item) => item.id === task.id)?.retryingNodeCount, 1);
  assert.equal(runtime.scheduler.retryWakeTimers.has(task.id), true);

  runtime.scheduler.releaseScheduledRetries(task.id, { now: Date.now() + 120_000 });
  card = runtime.store.getMessage(cardMessage.id);
  assert.match(card.content, /第 2\/3 次自动重试已进入执行队列/);
  assert.equal(card.metadata.retryNotice?.state, 'queued');
  assert.doesNotMatch(JSON.stringify(card.metadata.progressMilestones), /app-server|\$HOME|[A-Z]:\\/i);
  assert.equal(runtime.scheduler.retryWakeTimers.has(task.id), false);

  const runningNode = runtime.store.updateTaskNode(node.id, {
    status: 'running', attemptCount: 2, startedAt: new Date().toISOString(), completedAt: null,
  });
  runtime.scheduler.reconcileTaskStatus(task.id);
  runtime.scheduler.notifyTaskUpdated(task.id, { type: 'node_running', node: runningNode });
  card = runtime.store.getMessage(cardMessage.id);
  assert.match(card.content, /正在进行第 2\/3 次自动重试/);
  assert.doesNotMatch(JSON.stringify(card.metadata.progressMilestones), /app-server|\$HOME|[A-Z]:\\/i);
  assert.equal(runtime.store.getTaskRun(task.id).summary, 'Task graph has running nodes.');
  runtime.cancelTaskRun({ taskRunId: task.id });

  const artifactRecoveryTask = runtime.store.createTaskRun({
    id: 'task-artifact-writer-recovery', ownerUserId: runtime.currentUser().id, title: '宿主交付恢复验证',
    prompt: '写一份报告，md 格式上交。', initialStatus: 'running', deferAgentInstanceBinding: true,
    metadata: {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, workspaceRoot: project.workspaceRoot,
      executionKernelVersion: 'agent_work_v2',
      deliverableContract: { requested_output_type: 'report', requires_file: true, required_extensions: ['.md'] },
    },
  });
  const artifactRecoveryNode = runtime.store.createTaskNode({
    taskRunId: artifactRecoveryTask.id, title: '生成 Markdown 报告', objective: '生成最终报告。', agentId: 'general_agent',
    departmentId: 'general', status: 'running', blocking: true, maxAttempts: 3, estimatedMinutes: 30,
    deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskRunMetadata(artifactRecoveryTask.id, { finalTaskNodeId: artifactRecoveryNode.id });
  runtime.store.updateTaskNode(artifactRecoveryNode.id, { attemptCount: 1, startedAt: new Date().toISOString() });
  const artifactCard = runtime.store.addMessage({
    sessionId: session.id, role: 'assistant', content: '文件交付任务已进入队列。', agentId: 'secretary_agent',
    departmentId: 'secretary_department', metadata: { uBuddyTaskQueued: true, taskRunId: artifactRecoveryTask.id },
  });
  const artifactRetryNode = runtime.scheduler.handleNodeExecutionFailure(
    runtime.store.getTaskRun(artifactRecoveryTask.id), runtime.store.getTaskNode(artifactRecoveryNode.id), {
      errorSummary: 'sandbox_workspace_write_unavailable: Windows sandbox setup failed.',
      failure: { code: 'sandbox_workspace_write_unavailable', retryable: false, blocked: true, userActionRequired: true, userMessage: 'sandbox unavailable' },
    },
  );
  assert.equal(artifactRetryNode.status, 'retry_wait');
  assert.equal(artifactRetryNode.lastErrorCode, 'task_artifact_writer_recovery');
  assert.match(artifactRetryNode.waitReason, /同一 Agent 会话.*Janus 宿主交付工具/);
  assert.match(runtime.store.getMessage(artifactCard.id).content, /补丁通道不可用.*宿主交付工具/);
  runtime.cancelTaskRun({ taskRunId: artifactRecoveryTask.id });
  runtime.scheduler.scheduleTaskRetryWake(artifactRecoveryTask.id);

  const sourceEditTask = runtime.store.createTaskRun({
    id: 'task-source-edit-sandbox-block', ownerUserId: runtime.currentUser().id, title: '源码沙箱阻塞验证',
    prompt: '修改源码。', initialStatus: 'running', deferAgentInstanceBinding: true,
    metadata: {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id, workspaceRoot: project.workspaceRoot,
      executionKernelVersion: 'agent_work_v2', taskType: 'code_change',
      deliverableContract: { requested_output_type: 'code_change', requires_file: true, required_extensions: [] },
    },
  });
  const sourceEditNode = runtime.store.createTaskNode({
    taskRunId: sourceEditTask.id, title: '修改源码', objective: '修改源码。', agentId: 'general_agent',
    departmentId: 'general', status: 'running', blocking: true, maxAttempts: 3, deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskRunMetadata(sourceEditTask.id, { finalTaskNodeId: sourceEditNode.id });
  runtime.store.updateTaskNode(sourceEditNode.id, { attemptCount: 1, startedAt: new Date().toISOString() });
  const blockedSourceNode = runtime.scheduler.handleNodeExecutionFailure(
    runtime.store.getTaskRun(sourceEditTask.id), runtime.store.getTaskNode(sourceEditNode.id), {
      errorSummary: 'sandbox_workspace_write_unavailable: Windows sandbox setup failed.',
      failure: { code: 'sandbox_workspace_write_unavailable', retryable: false, blocked: true, userActionRequired: true, userMessage: '任务工作区写入沙箱不可用。' },
    },
  );
  assert.equal(blockedSourceNode.status, 'blocked');
  assert.equal(blockedSourceNode.lastErrorCode, 'sandbox_workspace_write_unavailable');
  runtime.cancelTaskRun({ taskRunId: sourceEditTask.id });

  const wakeTask = runtime.store.createTaskRun({
    id: 'task-retry-wake', ownerUserId: runtime.currentUser().id, title: '重试到期唤醒验证',
    prompt: '验证重试到期唤醒。', initialStatus: 'waiting', deferAgentInstanceBinding: true,
  });
  const wakeNode = runtime.store.createTaskNode({
    taskRunId: wakeTask.id, title: '等待重试', objective: '等待到期。', agentId: 'general_agent',
    departmentId: 'general', status: 'retry_wait', blocking: true, deferAgentInstanceBinding: true,
  });
  runtime.store.updateTaskNode(wakeNode.id, {
    attemptCount: 1, lastErrorCode: 'execution_timeout', nextRetryAt: new Date(Date.now() + 10).toISOString(),
  });
  const recoverActiveTasks = runtime.scheduler.recoverActiveTasks;
  let wakeCount = 0;
  runtime.scheduler.recoverActiveTasks = async () => {
    wakeCount += 1;
    runtime.store.updateTaskNode(wakeNode.id, { status: 'cancelled', nextRetryAt: '' });
    return { skipped: false, recovered: [] };
  };
  runtime.scheduler.scheduleTaskRetryWake(wakeTask.id);
  await new Promise((resolve) => setTimeout(resolve, 400));
  runtime.scheduler.recoverActiveTasks = recoverActiveTasks;
  assert.equal(wakeCount, 1);
  assert.equal(runtime.scheduler.retryWakeTimers.has(wakeTask.id), false);

  console.log('uBuddy retry reliability smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}
