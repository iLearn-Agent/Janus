import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { buildUBuddyPlannerCandidates, planUBuddyRoute } from '../src/main/modules/orchestration/index.js';

const repoRoot = path.resolve(process.cwd());
const runtimeRoot = path.resolve(process.env.JANUS_REAL_ACCOUNT_ROOT || path.join(repoRoot, 'workspace'));
const projectRoot = path.join(runtimeRoot, 'real-codex-routing-e2e');
const reportDir = path.join(repoRoot, 'test-artifacts', 'real-ubuddy-routing');
const startedAt = new Date().toISOString();
const permissionMode = String(process.env.JANUS_REAL_E2E_PERMISSION_MODE || 'task-workspace').trim();
const report = { startedAt, runtimeRoot, permissionMode, checks: [], routes: [], executions: [], errors: [] };
let runtime = null;

fs.rmSync(projectRoot, { recursive: true, force: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

try {
  runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  assert.ok(user?.id, 'A real active database account is required.');
  assert.notEqual(user.authProvider, 'local_mock', 'The active account must be a real cloud-bound database account.');
  report.account = { username: maskAccount(user.username || user.displayName || user.id), provider: user.authProvider || '' };

  const project = runtime.createProject({ title: `uBuddy real routing ${Date.now()}`, workspaceRoot: projectRoot });
  const session = runtime.ensureSecretarySession();
  const taskCountBefore = runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length;
  const events = [];
  const common = {
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    reasoningEffort: 'low',
    sandboxPermission: permissionMode,
    onEvent: (event) => events.push({ kind: event.kind, stage: event.stage || '', message: String(event.message || '').slice(0, 300) }),
  };

  console.log('[real-ubuddy] 1/7 local greeting');
  const greeting = await runtime.secretaryChat({ sessionId: session.id, message: 'hi' });
  assert.equal(greeting.uBuddyMode, 'control');
  record('local_greeting', greeting, { output: greeting.answer });

  console.log('[real-ubuddy] 2/7 uBuddy direct text');
  const directText = await runtime.secretaryChat({
    ...common,
    message: '这是一次真实链路测试。请只回复以下文本，不要添加任何其他内容：REAL_DIRECT_OK',
  });
  assert.equal(directText.uBuddyMode, 'direct');
  assert.match(directText.answer, /REAL_DIRECT_OK/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length, taskCountBefore);
  record('direct_text', directText, { output: directText.answer });

  console.log('[real-ubuddy] 3/7 uBuddy direct project file');
  const relativeFile = path.join('real-ubuddy-e2e', 'direct.txt');
  const expectedFileText = 'REAL_UBUDDY_FILE_OK';
  const directFile = await runtime.secretaryChat({
    ...common,
    message: `这是一个低风险单步骤项目任务，请由 uBuddy 直接完成，不要调用任何 Agent：在当前项目根目录创建 ${relativeFile}，文件内容必须恰好为 ${expectedFileText}，完成后简短确认。`,
  });
  assert.equal(directFile.uBuddyMode, 'direct');
  const directFilePath = path.join(projectRoot, relativeFile);
  assert.equal(fs.readFileSync(directFilePath, 'utf8').trim(), expectedFileText);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length, taskCountBefore);
  record('direct_file', directFile, { output: directFile.answer, artifact: relativeFile });

  console.log('[real-ubuddy] 4/7 explicit single Agent FIFO');
  const explicitAgent = await runtime.secretaryChat({
    ...common,
    message: '告诉通用Agent，让它只回复以下文本，不要添加其他内容：REAL_AGENT_OK',
  });
  assert.equal(explicitAgent.uBuddyMode, 'agent_queued');
  assert.equal(explicitAgent.route.targetAgentId, 'general_agent');
  const explicitReceipt = await waitForDelivery(runtime, explicitAgent.workId);
  assert.equal(explicitReceipt.deliveryStatus, 'completed', JSON.stringify(publicReceipt(explicitReceipt)));
  const explicitNotification = runtime.store.listMessages(session.id).find((message) => message.metadata?.workId === explicitAgent.workId && message.metadata?.agentDeliveryCompleted);
  assert.match(explicitNotification?.content || '', /REAL_AGENT_OK/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 500 }).length, taskCountBefore);
  record('explicit_single_agent', explicitAgent, { receipt: publicReceipt(explicitReceipt), output: explicitNotification?.content || '' });

  console.log('[real-ubuddy] 5/7 model-declared automatic escalation');
  const escalationPrompt = [
    '请处理一项明确不属于秘书整理职责的专业程序验证：',
    '计算字符串“Janus real escalation”的 SHA-256 十六进制摘要，并验证结果长度为 64。',
    '这属于专业程序执行，不是普通问答、整理、改写或低风险项目文件操作；请按职责与能力边界处理。',
    '执行者完成验证后最终只回复 REAL_ESCALATED_OK，不要添加其他内容。',
  ].join('');
  const routeCandidates = buildUBuddyPlannerCandidates({ store: runtime.store, org: runtime.org, userId: user.id });
  assert.equal(planUBuddyRoute({ prompt: escalationPrompt, candidates: routeCandidates, organization: runtime.org.list() }).mode, 'direct',
    'The deterministic router must leave this case to uBuddy capability-boundary evaluation.');
  const escalated = await runtime.secretaryChat({ ...common, message: escalationPrompt });
  assert.equal(escalated.uBuddyMode, 'agent_queued');
  assert.equal(escalated.route.source, 'direct_escalation');
  assert.equal(escalated.route.targetAgentId, 'general_agent');
  const escalatedReceipt = await waitForDelivery(runtime, escalated.workId);
  assert.equal(escalatedReceipt.deliveryStatus, 'completed', JSON.stringify(publicReceipt(escalatedReceipt)));
  const escalatedNotification = runtime.store.listMessages(session.id).find((message) => message.metadata?.workId === escalated.workId && message.metadata?.agentDeliveryCompleted);
  assert.match(escalatedNotification?.content || '', /REAL_ESCALATED_OK/);
  assert.equal(runtime.store.listMessages(session.id).some((message) => String(message.content || '').includes('JANUS_UBUDDY_ESCALATION_V1')), false);
  record('automatic_escalation', escalated, { receipt: publicReceipt(escalatedReceipt), output: escalatedNotification?.content || '' });

  console.log('[real-ubuddy] 6/7 multi-Agent workflow and progress query');
  const workflow = await runtime.secretaryChat({
    ...common,
    message: '请使用多 Agent workflow：先由通用 Agent 产出一个两页演示文稿大纲，主题是“真实路由验证”且必须包含 REAL_WORKFLOW_DRAFT_OK；再由 PPT Agent 根据该大纲生成可编辑 PPTX，成品正文必须包含 REAL_WORKFLOW_OK。',
  });
  assert.equal(workflow.uBuddyMode, 'task_queued');
  assert.ok(workflow.taskRunId);
  assert.ok(workflow.task.nodes.length >= 2, `Expected at least two workflow nodes, got ${workflow.task.nodes.length}`);
  const progressQuery = await runtime.secretaryChat({ sessionId: session.id, message: '当前任务进度怎么样？' });
  assert.equal(progressQuery.uBuddyMode, 'task_query_control');
  assert.match(progressQuery.answer, /任务|节点|进度/);
  const workflowTask = await waitForTask(runtime, workflow.taskRunId);
  assert.equal(workflowTask.status, 'completed', summarizeTask(workflowTask));
  const finalNode = workflowTask.nodes.filter((node) => node.status === 'completed' && node.resultText).at(-1);
  assert.match(finalNode?.resultText || '', /REAL_WORKFLOW_OK/);
  record('multi_agent_workflow', workflow, { task: summarizeTask(workflowTask), output: finalNode?.resultText || '' });

  console.log('[real-ubuddy] 7/7 database and execution audit');
  const executions = runtime.db.prepare(`SELECT execution_kind,agent_id,status,error_text,effective_model,started_at,completed_at
    FROM model_executions WHERE user_id=? AND started_at>=? ORDER BY started_at`).all(user.id, startedAt);
  report.executions = executions.map((row) => ({
    executionKind: row.execution_kind,
    agentId: row.agent_id,
    status: row.status,
    error: row.error_text ? String(row.error_text).slice(0, 300) : '',
    model: row.effective_model,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
  assert.ok(report.executions.length >= 5, `Expected real model executions, got ${report.executions.length}`);
  assert.equal(report.executions.some((execution) => execution.status !== 'completed'), false, JSON.stringify(report.executions));
  assert.ok(events.some((event) => event.kind === 'routing'));
  assert.ok(events.some((event) => event.kind === 'task-progress'));

  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: true,
    account: report.account,
    checks: report.checks.map((check) => ({ name: check.name, mode: check.mode, status: check.status })),
    realExecutionCount: report.executions.length,
    models: [...new Set(report.executions.map((execution) => execution.model).filter(Boolean))],
    report: path.join(reportDir, 'report.json'),
  }, null, 2));

  function record(name, result, details = {}) {
    const entry = {
      name,
      status: 'passed',
      mode: result.uBuddyMode || '',
      route: result.route ? { mode: result.route.mode, source: result.route.source, reasonCode: result.route.reasonCode, targetAgentId: result.route.targetAgentId } : null,
      ...details,
    };
    report.checks.push(entry);
    report.routes.push(entry.route);
  }
} catch (error) {
  report.status = 'failed';
  report.completedAt = new Date().toISOString();
  report.errors.push({ message: String(error?.message || error), stack: String(error?.stack || '').slice(0, 5000) });
  fs.writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  runtime?.close();
}

async function waitForDelivery(runtime, workId, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const receipt = runtime.store.getAgentDeliveryReceiptByWorkId(workId);
    if (['completed', 'failed', 'cancelled'].includes(String(receipt?.deliveryStatus || ''))) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Agent delivery ${workId}`);
}

async function waitForTask(runtime, taskRunId, timeoutMs = 15 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = runtime.store.getTaskRun(taskRunId);
    if (['completed', 'failed', 'cancelled'].includes(String(task?.status || ''))) return task;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for task ${taskRunId}`);
}

function summarizeTask(task = {}) {
  return JSON.stringify({
    id: task.id,
    status: task.status,
    nodes: (task.nodes || []).map((node) => ({ title: node.title, agentId: node.agentId, status: node.status, error: node.errorText || '' })),
  });
}

function publicReceipt(receipt = {}) {
  return {
    workId: receipt.workId || '',
    deliveryStatus: receipt.deliveryStatus || '',
    targetAgentId: receipt.metadata?.targetAgentId || '',
    lastStage: receipt.metadata?.lastStage || '',
  };
}

function maskAccount(value = '') {
  const text = String(value || '');
  if (text.length <= 4) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
