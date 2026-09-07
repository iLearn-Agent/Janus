import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-mode-choice-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-mode-choice-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousFlag = process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;

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
    if (!message.method && String(message.id) === 'mode-choice-list-work') {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const targetId = payload.work?.[1]?.id || payload.work?.[0]?.id || '';
      send({ id: 'mode-choice-second-query', method: 'item/tool/call', params: {
        threadId: 'mode-choice-thread', turnId: 'mode-choice-turn', callId: 'mode-choice-second-query',
        namespace: 'janus', tool: 'query_work', arguments: { query: 'progress', targetId },
      } });
    } else if (!message.method && ['mode-choice-progress-query', 'mode-choice-second-query'].includes(String(message.id))) {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const answer = 'CODEX_MODE_QUERY_OK：' + (payload.answer || '已查询任务状态');
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'mode-choice-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
    } else if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'mode-choice-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'mode-choice-thread' } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'mode-choice-turn' } } });
      const text = message.params?.input?.[0]?.text || '';
      const ownerMessage = text.split('Current owner message:\\n').at(-1) || '';
      if (ownerMessage.includes('前几个任务中的第2个任务')) {
        send({ id: 'mode-choice-list-work', method: 'item/tool/call', params: {
          threadId: 'mode-choice-thread', turnId: 'mode-choice-turn', callId: 'mode-choice-list-work',
          namespace: 'janus', tool: 'list_capabilities', arguments: { scope: 'work' },
        } });
      } else if (ownerMessage.includes('现在进行到哪一步')) {
        const tasks = JSON.parse(text.match(/Active uBuddy work summary:\\n(\\[[^\\n]*\\])/)?.[1] || '[]');
        send({ id: 'mode-choice-progress-query', method: 'item/tool/call', params: {
          threadId: 'mode-choice-thread', turnId: 'mode-choice-turn', callId: 'mode-choice-progress-query',
          namespace: 'janus', tool: 'query_work', arguments: { query: 'progress', targetId: tasks[0]?.id || '' },
        } });
      } else {
        send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DIRECT_SELECTED_OK' } } });
        send({ method: 'turn/completed', params: { turn: { id: 'mode-choice-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DIRECT_SELECTED_OK' }] } } });
      }
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
let response = 'TASK_NODE_OK';
if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const currentMessage = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  if (currentMessage.includes('现在进行到哪一步') || currentMessage.includes('前几个任务中的第2个任务')) {
    response = JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: true, intake: null,
    });
  } else {
    const research = currentMessage.includes('Agent 自进化');
    response = JSON.stringify({
      version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
      intake: {
        version: 'ubuddy_task_intake_v1', state: 'ready', objective: currentMessage,
        deliverables: research ? ['DOCX 调研报告', 'PPTX 演示文稿'] : ['整理后的材料'],
        acceptanceCriteria: [], constraints: [], deadline: '', candidateUsers: [], requiredUsers: [], attachments: [],
        privacyScope: 'owner_private', riskLevel: 'low', missingFields: [],
        clarification: { reasonCode: '', question: '', options: [] },
      },
    });
  }
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const general = candidates.find((item) => item.agentId === 'general_agent');
  const ppt = candidates.find((item) => item.agentId === 'ppt');
  const forcedScheduler = stdin.includes('owner explicitly selected multi-Agent Scheduler execution');
  const currentMessage = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  if (currentMessage.includes('Agent 自进化') && currentMessage.includes('DOCX') && currentMessage.includes('PPT')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.98,
      nodes: [
        { localId: 'report', title: '调研 Agent 自进化成果并撰写报告', objective: '调研近期 Agent 自进化科研成果并生成 DOCX 报告', agentId: 'general_agent', agentInstanceId: general?.agentInstanceId, dependencies: [], outputFormat: 'DOCX report', isFinal: false, blocking: true, fallback: '报告资料缺失时说明阻塞。' },
        { localId: 'deck', title: '根据报告制作演示文稿', objective: '基于 DOCX 报告制作 PPTX', agentId: 'ppt', agentInstanceId: ppt?.agentInstanceId, dependencies: ['report'], outputFormat: 'editable PPTX', isFinal: true, blocking: true, fallback: '报告不可用时说明阻塞。' },
      ],
      deliverables: [
        { id: 'report_docx', role: 'intermediate', type: 'document', title: 'Agent 自进化调研报告', ownerLocalId: 'report', deliveryMode: 'file', requiredExtensions: ['.docx'], constraints: {} },
        { id: 'deck_pptx', role: 'primary', type: 'presentation', title: 'Agent 自进化调研汇报', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: {} },
      ],
      agentSelectionRationale: '研究 Agent 先形成报告，PPT Agent 基于报告制作演示文稿。', mentionedAgentsNotSelected: [],
    });
  } else if (forcedScheduler && currentMessage.includes('MODE_CHOICE_TASK')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
      nodes: [{ localId: 'final', title: '完成可选模式任务', objective: currentMessage, agentId: 'general_agent', agentInstanceId: general?.agentInstanceId, dependencies: [], outputFormat: 'answer', isFinal: true, blocking: true, fallback: '报告阻塞。' }],
      deliverables: [{ id: 'primary', role: 'primary', type: 'answer', title: '任务结果', ownerLocalId: 'final', deliveryMode: 'inline', requiredExtensions: [], constraints: {} }],
      agentSelectionRationale: '用户明确选择 Scheduler，由可用通用 Agent 执行。', mentionedAgentsNotSelected: [],
    });
  } else if (currentMessage.includes('MODE_CHOICE_TASK')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'execution_mode_choice', confidence: 0.62,
      routingRationale: '该任务可由 uBuddy 快速完成，也可通过 Scheduler 获得独立跟踪。',
      executionModeChoice: { recommendedMode: 'scheduler', routingRationale: '该任务可由 uBuddy 快速完成，也可通过 Scheduler 获得独立跟踪。', directModeSummary: '更快完成。', schedulerModeSummary: '独立跟踪和审核。' },
      nodes: [], deliverables: [],
    });
  } else {
    response = JSON.stringify({ version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.96, answer: '', routingRationale: '直接完成。', nodes: [], deliverables: [], mentionedAgentsNotSelected: [] });
  }
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'mode-choice-planner' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);

let runtime;
try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = 'on';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  runtime.store.recruitUserAgent({ userId: user.id, agentFamilyId: 'ppt', commandId: 'mode-choice-smoke:recruit-ppt' });
  const session = runtime.ensureSecretarySession();

  const researchRequest = await runtime.secretaryChat({
    sessionId: session.id,
    message: '调研近期与 Agent 自进化相关的科研成果，整理成一份合适的 DOCX 调研报告，并根据报告制作一份 PPT，最终交付 DOCX 文件和 PPT。',
  });
  assert.notEqual(researchRequest.uBuddyMode, 'execution_mode_choice');
  assert.ok(researchRequest.taskRunId);
  assert.equal(researchRequest.task.nodes.length, 2);
  const plannedNodes = researchRequest.task.metadata.taskGraphProposal.nodes;
  const reportNode = plannedNodes.find((node) => node.localId === 'report');
  const deckNode = plannedNodes.find((node) => node.localId === 'deck');
  assert.deepEqual(deckNode.dependencies, [reportNode.localId]);
  assert.deepEqual(researchRequest.task.metadata.deliverablePlan.deliverables.map((item) => item.requiredExtensions), [['.docx'], ['.pptx']]);
  const researchProgress = await runtime.secretaryChat({ sessionId: session.id, message: '现在进行到哪一步了？' });
  assert.equal(researchProgress.uBuddyMode, 'task_query_control');
  assert.deepEqual(researchProgress.taskRunIds, [researchRequest.taskRunId]);
  runtime.cancelTaskRun({ taskRunId: researchRequest.taskRunId });
  const baselineTaskCount = runtime.store.listTaskRuns({ userId: user.id }).length;

  const directChoice = await runtime.secretaryChat({ sessionId: session.id, message: 'MODE_CHOICE_TASK_DIRECT：整理一段材料。' });
  assert.equal(directChoice.uBuddyMode, 'execution_mode_choice');
  assert.equal(directChoice.executionModeChoice.status, 'pending');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, baselineTaskCount);
  const direct = await runtime.secretaryChat({
    sessionId: session.id,
    message: '由 uBuddy 直接完成',
    executionModeChoice: { choiceId: directChoice.executionModeChoice.choiceId, mode: 'direct' },
  });
  assert.equal(direct.uBuddyMode, 'direct');
  assert.equal(direct.answer, 'DIRECT_SELECTED_OK');
  assert.equal(direct.message.metadata.uBuddyExecutionModeChoiceId, directChoice.executionModeChoice.choiceId);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, baselineTaskCount);

  const schedulerChoice = await runtime.secretaryChat({ sessionId: session.id, message: 'MODE_CHOICE_TASK_SCHEDULER：整理另一段材料。' });
  assert.equal(schedulerChoice.uBuddyMode, 'execution_mode_choice');
  const scheduled = await runtime.secretaryChat({
    sessionId: session.id,
    message: '使用多 Agent 协作',
    executionModeChoice: { choiceId: schedulerChoice.executionModeChoice.choiceId, mode: 'scheduler' },
  });
  assert.ok(scheduled.taskRunId);
  assert.equal(scheduled.task.metadata.uBuddyExecutionModeChoiceId, schedulerChoice.executionModeChoice.choiceId);
  const secondTaskQuery = await runtime.secretaryChat({ sessionId: session.id, message: '前几个任务中的第2个任务现在是什么情况？' });
  assert.equal(secondTaskQuery.uBuddyMode, 'task_query_control');
  assert.equal(secondTaskQuery.taskRunIds.length, 1);
  assert.equal(secondTaskQuery.taskRunIds[0], researchRequest.taskRunId);
  const taskCount = runtime.store.listTaskRuns({ userId: user.id }).length;
  const repeated = await runtime.secretaryChat({
    sessionId: session.id,
    message: '使用多 Agent 协作',
    executionModeChoice: { choiceId: schedulerChoice.executionModeChoice.choiceId, mode: 'scheduler' },
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.taskRunId, scheduled.taskRunId);
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, taskCount);
  console.log('uBuddy execution mode choice smoke passed');
} finally {
  await runtime?.close?.();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
  else process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = previousFlag;
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}
