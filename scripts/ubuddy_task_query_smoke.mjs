import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import {
  buildSecretaryTaskQueryReply,
  classifySecretaryTaskQuery,
  isSecretaryWorkRequest,
  resolveSecretaryTaskQueryCandidates,
  selectSecretaryTaskQueryCandidates,
} from '../src/main/modules/collaboration/application/secretaryTaskQuery.js';

assert.equal(classifySecretaryTaskQuery('生成的文档放在哪里了？'), 'artifact');
assert.equal(classifySecretaryTaskQuery('进行到哪里了？'), 'progress');
assert.equal(classifySecretaryTaskQuery('结果呢？'), 'result');
assert.equal(classifySecretaryTaskQuery('请告诉我生成的文档在哪里'), 'artifact');
assert.equal(classifySecretaryTaskQuery('重新生成文档并告诉我保存位置'), null);
assert.equal(classifySecretaryTaskQuery('帮我生成一份文档'), null);
assert.equal(classifySecretaryTaskQuery('请在当前项目根目录创建 review-ui-demo.md，写入一个标题、三个小节和至少 30 行测试内容。完成后告诉我文件路径。'), null);
assert.equal(classifySecretaryTaskQuery('请在当前项目根目录下，新建一个测试文档，完成后告诉我保存位置。'), null);
assert.equal(classifySecretaryTaskQuery('请在当前项目里告诉我生成的文档在哪里'), 'artifact');
assert.equal(classifySecretaryTaskQuery('另外，请创建一个新的报告，完成后告诉我文件路径。'), null);
assert.equal(classifySecretaryTaskQuery('接下来帮我新建 review.md，完成后告诉我保存位置。'), null);
assert.equal(classifySecretaryTaskQuery('我需要你创建一个测试文档，完成后告诉我文件路径。'), null);
assert.equal(classifySecretaryTaskQuery('能否创建一个测试文档，完成后告诉我文件路径？'), null);
assert.equal(classifySecretaryTaskQuery('请基于现有代码编写一份审查报告，完成后告诉我文件路径。'), null);
assert.equal(classifySecretaryTaskQuery('请把现有报告补充一节，完成后告诉我文件路径。'), null);
assert.equal(classifySecretaryTaskQuery('做一份用户调研报告，完成后告诉我保存位置。'), null);
assert.equal(classifySecretaryTaskQuery('Please create review.md and tell me the file path when done.'), null);
assert.equal(classifySecretaryTaskQuery('文件路径使用相对路径，不要使用绝对路径。'), null);
assert.equal(classifySecretaryTaskQuery('重新生成的文档在哪里？'), 'artifact');
assert.equal(classifySecretaryTaskQuery('任务执行到哪里了？'), 'progress');
assert.equal(classifySecretaryTaskQuery('运行结果是什么？'), 'result');
assert.equal(classifySecretaryTaskQuery('前几个任务中的第2个任务现在是什么情况？'), 'progress');
assert.equal(classifySecretaryTaskQuery('第二个任务进度怎么样？'), 'progress');
assert.equal(classifySecretaryTaskQuery('文件路径？'), 'artifact');
assert.equal(isSecretaryWorkRequest('请告诉我生成的文档在哪里'), false);
assert.equal(isSecretaryWorkRequest('另外，请创建一个新的报告，完成后告诉我文件路径。'), true);
assert.equal(isSecretaryWorkRequest('请基于现有代码编写一份审查报告，完成后告诉我文件路径。'), true);
assert.equal(isSecretaryWorkRequest('任务执行到哪里了？'), false);
assert.equal(buildSecretaryTaskQueryReply({ intent: 'progress', tasks: [] }), '当前 uBuddy 会话里没有正在执行或最近完成的任务。');
assert.deepEqual(selectSecretaryTaskQueryCandidates({ intent: 'progress', tasks: [] }), []);
const ordinalFixtures = [
  { id: 'latest', title: '最新任务', createdAt: '2026-08-08T10:03:00.000Z', status: 'running' },
  { id: 'second', title: '第二新任务', createdAt: '2026-08-08T10:02:00.000Z', status: 'completed' },
  { id: 'oldest', title: '最早任务', createdAt: '2026-08-08T10:01:00.000Z', status: 'completed' },
];
assert.equal(resolveSecretaryTaskQueryCandidates({ message: '前几个任务中的第2个任务现在是什么情况？', intent: 'progress', tasks: ordinalFixtures }).tasks[0].id, 'second');
assert.equal(resolveSecretaryTaskQueryCandidates({ message: '上一个任务怎么样？', intent: 'progress', tasks: ordinalFixtures }).tasks[0].id, 'second');
assert.equal(resolveSecretaryTaskQueryCandidates({ message: '刚才那个任务怎么样？', intent: 'progress', tasks: ordinalFixtures }).tasks[0].id, 'latest');
assert.equal(resolveSecretaryTaskQueryCandidates({ message: '第2个任务怎么样？', intent: 'progress', tasks: ordinalFixtures, taskOrderIds: ['oldest', 'latest'] }).tasks[0].id, 'latest');
assert.match(resolveSecretaryTaskQueryCandidates({ message: '第8个任务怎么样？', intent: 'progress', tasks: ordinalFixtures }).issue, /找不到第 8 个/);

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-task-query-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-task-query-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousPrimaryFlag = process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && String(message.id) === 'query-call') {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const rows = payload.answer || (payload.candidates || []).map((item) => item.title).join('、') || '没有可查询的任务';
      const answer = 'CODEX_QUERY_OK：' + rows;
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'query-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      continue;
    }
    if (!message.method || message.id == null) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'task-query-smoke' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'task-query-thread' } } });
    else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'query-turn' } } });
      const prompt = message.params?.input?.[0]?.text || '';
      const ownerMessage = prompt.split('Current owner message:\\n').at(-1) || '';
      const tasks = JSON.parse(prompt.match(/Active uBuddy work summary:\\n(\\[[^\\n]*\\])/)?.[1] || '[]');
      const query = /放在哪里|文件路径|产物/.test(ownerMessage) ? 'artifacts' : /结果/.test(ownerMessage) ? 'result' : 'progress';
      let targetId = tasks.find((item) => ownerMessage.includes(item.id))?.id || '';
      if (!targetId && query === 'artifacts') targetId = tasks.find((item) => item.title === '生成季度总结文档')?.id || '';
      if (!targetId && /第2个/.test(ownerMessage)) targetId = tasks.find((item) => item.title === '整理客户调研')?.id || '';
      send({ id: 'query-call', method: 'item/tool/call', params: {
        threadId: 'task-query-thread', turnId: 'query-turn', callId: 'query-call', namespace: 'janus', tool: 'query_work',
        arguments: { query, ...(targetId ? { targetId } : {}) },
      } });
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
let response = 'TASK_NODE_OK';
if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const currentMessage = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  const createsBrief = currentMessage.includes('询问组织里的所有人') && currentMessage.includes('写成简报');
  response = createsBrief ? JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
    intake: { version: 'ubuddy_task_intake_v1', state: 'needs_clarification', objective: currentMessage,
      deliverables: ['组织周进度简报'], acceptanceCriteria: [], constraints: [], deadline: '', candidateUsers: [], requiredUsers: [], attachments: [],
      privacyScope: 'direct_delegation', riskLevel: 'medium', missingFields: ['candidateUsers'],
      clarification: { reasonCode: 'missing_material_requirement', question: '请选择要询问的组织成员。', options: ['选择当前组织成员', '稍后指定成员'] } },
  }) : JSON.stringify({ version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: true, intake: null });
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  response = JSON.stringify({ version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.98,
    answer: '', routingRationale: '查询已有任务必须由完整 Codex 调用 Janus 状态工具。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [] });
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'task-query-planner' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
let runtime = null;

try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = 'on';
  process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'on';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const secretary = runtime.ensureSecretarySession();

  const completedTask = runtime.store.createTaskRun({
    title: '生成季度总结文档',
    prompt: '生成季度总结文档',
    departmentId: 'general',
    ownerUserId: user.id,
    metadata: {
      userId: user.id,
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: secretary.id,
      taskType: 'file_generation',
    },
  });
  const completedNode = runtime.store.createTaskNode({
    taskRunId: completedTask.id,
    title: '整理并导出文档',
    objective: '生成季度总结文档',
    departmentId: 'general',
    status: 'completed',
    outputFormat: 'Markdown document',
  });
  runtime.store.updateTaskNode(completedNode.id, {
    resultSummary: '季度总结文档已经生成并完成检查。',
    resultText: '文档已生成。',
    evidenceRefs: [{ type: 'file', label: 'outputs/季度总结.md', path: 'outputs/季度总结.md' }],
    completedAt: new Date().toISOString(),
  });
  runtime.store.updateTaskRunStatus(completedTask.id, 'completed', '季度总结文档已经生成。');

  const activeTask = runtime.store.createTaskRun({
    title: '整理客户调研',
    prompt: '整理客户调研',
    departmentId: 'general',
    ownerUserId: user.id,
    metadata: {
      userId: user.id,
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: secretary.id,
      taskType: 'research',
    },
  });
  runtime.store.createTaskNode({
    taskRunId: activeTask.id,
    title: '汇总访谈记录',
    objective: '汇总客户访谈记录',
    departmentId: 'general',
    status: 'running',
    outputFormat: 'research notes',
  });
  runtime.store.updateTaskRunStatus(activeTask.id, 'running', '正在汇总客户访谈记录。');

  runtime.store.createTaskRun({
    title: '其他 uBuddy 会话的任务',
    prompt: '不应出现在当前会话查询中',
    departmentId: 'general',
    ownerUserId: user.id,
    metadata: {
      userId: user.id,
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: 'another-secretary-session',
      taskType: 'qa',
    },
  });

  const beforeCount = runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length;
  const progress = await runtime.secretaryChat({ sessionId: secretary.id, message: '进行到哪里了？' });
  assert.equal(progress.uBuddyMode, 'task_query_control');
  assert.match(progress.answer, /^CODEX_QUERY_OK/);
  assert.match(progress.answer, /整理客户调研/);
  assert.match(progress.answer, /已完成 0\/1 个节点/);
  assert.doesNotMatch(progress.answer, /其他 uBuddy 会话的任务/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length, beforeCount, 'progress queries must not create tasks');

  const artifact = await runtime.secretaryChat({ sessionId: secretary.id, message: '生成的文档放在哪里了？' });
  assert.equal(artifact.uBuddyMode, 'task_query_control');
  assert.match(artifact.answer, /^CODEX_QUERY_OK/);
  assert.match(artifact.answer, /outputs\/季度总结\.md/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length, beforeCount, 'artifact queries must not create tasks');

  const secondActiveTask = runtime.store.createTaskRun({
    title: '检查销售数据',
    prompt: '检查销售数据',
    departmentId: 'general',
    ownerUserId: user.id,
    metadata: {
      userId: user.id,
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: secretary.id,
      taskType: 'qa',
    },
  });
  runtime.store.createTaskNode({
    taskRunId: secondActiveTask.id,
    title: '核对销售指标',
    objective: '核对销售指标',
    departmentId: 'general',
    status: 'queued',
    outputFormat: 'summary',
  });
  runtime.store.updateTaskRunStatus(secondActiveTask.id, 'queued', '等待执行。');
  const multipleCount = runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length;
  const multipleProgress = await runtime.secretaryChat({ sessionId: secretary.id, message: '当前任务进度怎么样？' });
  assert.equal(multipleProgress.uBuddyMode, 'task_query_control');
  assert.match(multipleProgress.answer, /^CODEX_QUERY_OK/);
  assert.match(multipleProgress.answer, /整理客户调研/);
  assert.match(multipleProgress.answer, /检查销售数据/);

  const secondRecent = await runtime.secretaryChat({ sessionId: secretary.id, message: '前几个任务中的第2个任务现在是什么情况？' });
  assert.equal(secondRecent.uBuddyMode, 'task_query_control');
  assert.equal(secondRecent.taskRunIds.length, 1);
  assert.match(multipleProgress.answer, /检查销售数据/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length, multipleCount, 'multi-task progress queries must not create tasks');

  const explicit = await runtime.secretaryChat({ sessionId: secretary.id, message: `${completedTask.id} 的结果呢？` });
  assert.equal(explicit.uBuddyMode, 'task_query_control');
  assert.match(explicit.answer, /季度总结文档已经生成并完成检查/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length, multipleCount, 'result queries must not create tasks');

  const queryMessages = runtime.store.listMessages(secretary.id).filter((message) => message.metadata?.taskQueryIntent);
  assert.equal(queryMessages.length, 10);
  assert.ok(queryMessages.every((message) => message.metadata?.dispatchPlanning !== true));

  const beforeBriefCount = runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length;
  const brief = await runtime.secretaryChat({
    sessionId: secretary.id,
    message: '帮我询问组织里的所有人，这周的进度，并从中筛选出值得我关注的事写成简报',
  });
  assert.equal(brief.uBuddyMode, 'clarification');
  assert.doesNotMatch(brief.answer, /当前 uBuddy 会话里没有正在执行或最近完成的任务/);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id, limit: 100 }).length, beforeBriefCount);
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousPrimaryFlag === undefined) delete process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
  else process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = previousPrimaryFlag;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}

console.log('uBuddy task query smoke passed');
