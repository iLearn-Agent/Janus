import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-routing-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-routing-bin-'));
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-routing-project-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const logPath = path.join(binRoot, 'calls.jsonl');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.UBUDDY_ROUTING_LOG;
const previousDispatchFlag = process.env.JANUS_UBUDDY_NEW_DISPATCH_STRATEGY;
const previousIntakeFlag = process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
const previousStructuredReferenceFlag = process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
const previousAutoRoutingFlag = process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
const previousBoundedReviewFlag = process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
const previousUnifiedAgentWorkFlag = process.env.JANUS_UNIFIED_AGENT_WORK_KERNEL_V2;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
function responseFor(input) {
let response = input.includes('host has already locked this turn to direct uBuddy execution')
  ? 'UBUDDY_DIRECT_OK'
  : 'AGENT_DIRECT_OK';
if (input.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(input.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const currentMessage = input.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  const general = candidates.filter((item) => item.agentId === 'general_agent');
  const ppt = candidates.find((item) => item.agentId === 'ppt');
  const taskDecision = (nodes, deliverables, rationale = '根据有效 Skill 和交付依赖选择执行 Agent。') => JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
    answer: '', clarification: null, nodes, deliverables,
    agentSelectionRationale: rationale, mentionedAgentsNotSelected: [],
  });
  const node = (value) => ({ blocking: true, fallback: '如执行受阻，说明原因和可恢复的下一步。', ...value });
  if (currentMessage.includes('强制统一决策失败')) {
    response = 'not-json';
  } else if (currentMessage.includes('当前任务进度怎么样') || currentMessage.includes('当前进度怎么样')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.98,
      answer: '', routingRationale: '已有任务查询由完整 Codex 调用 Janus 状态工具。',
      nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
  } else if (currentMessage.includes('最终产物不明确')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'clarification', confidence: 0.62,
      answer: '', clarification: { reason: 'ambiguous_final_deliverable', question: '最终需要报告还是PPT？', options: ['报告', 'PPT'] },
      nodes: [], deliverables: [], agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
  } else if (currentMessage.includes('把这句话改得更简洁') || currentMessage.includes('请升级这个请求')) {
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.96,
      answer: 'UBUDDY_DIRECT_OK', clarification: null, nodes: [], deliverables: [],
      agentSelectionRationale: '', mentionedAgentsNotSelected: [],
    });
  } else if (currentMessage.includes('同类双实例协作')) {
    const generalA = general.find((item) => item.name === '通用 Agent A') || general[0];
    const generalB = general.find((item) => item.name === '通用 Agent B') || general[1] || general[0];
    response = taskDecision([
      node({ localId: 'draft', title: 'A 分析', objective: '由通用 Agent A 完成分析', agentId: 'general_agent', agentInstanceId: generalA?.agentInstanceId, dependencies: [], outputFormat: 'text', isFinal: false }),
      node({ localId: 'final', title: 'B 汇总', objective: '由通用 Agent B 汇总交付', agentId: 'general_agent', agentInstanceId: generalB?.agentInstanceId, dependencies: ['draft'], outputFormat: 'text', isFinal: true }),
    ], [{ id: 'primary', role: 'primary', type: 'document', title: '协作结果', ownerLocalId: 'final', deliveryMode: 'inline' }]);
  } else if (currentMessage.includes('中国环境报告') && currentMessage.includes('5页')) {
    response = taskDecision([
      node({ localId: 'report', title: '中国环境报告', objective: '撰写中国环境报告', agentId: 'general_agent', agentInstanceId: general[0]?.agentInstanceId, dependencies: [], outputFormat: '结构化报告', isFinal: false }),
      node({ localId: 'deck', title: '五页中国环境PPT', objective: '基于报告生成五页PPT', agentId: 'ppt', agentInstanceId: ppt?.agentInstanceId, dependencies: ['report'], outputFormat: '可编辑 PPTX', isFinal: true }),
    ], [
      { id: 'report', role: 'intermediate', type: 'report', title: '中国环境报告', ownerLocalId: 'report', deliveryMode: 'inline' },
      { id: 'deck', role: 'primary', type: 'presentation', title: '五页中国环境PPT', ownerLocalId: 'deck', deliveryMode: 'file', requiredExtensions: ['.pptx'], constraints: { exactSlideCount: 5 } },
    ]);
  } else if (currentMessage.includes('跨部门')) {
    response = taskDecision([
      node({ localId: 'draft', title: '协作草稿', objective: '产出跨部门协作草稿', agentId: 'general_agent', agentInstanceId: general[0]?.agentInstanceId, dependencies: [], outputFormat: 'text', isFinal: false }),
      node({ localId: 'final', title: '专业复核', objective: '完成专业复核并交付', agentId: 'ppt', agentInstanceId: ppt?.agentInstanceId, dependencies: ['draft'], outputFormat: 'text', isFinal: true }),
    ], [{ id: 'primary', role: 'primary', type: 'document', title: '跨部门协作结果', ownerLocalId: 'final', deliveryMode: 'inline' }]);
  } else {
    const preferred = currentMessage.includes('通用 Agent B')
      ? general.find((item) => item.name === '通用 Agent B') || general[1] || general[0]
      : general.find((item) => item.status !== 'busy') || general[0];
    response = taskDecision([
      node({ localId: 'final', title: '正式任务交付', objective: '完成用户要求并返回可核验结果', agentId: 'general_agent', agentInstanceId: preferred?.agentInstanceId, dependencies: [], outputFormat: 'text', isFinal: true }),
    ], [{ id: 'primary', role: 'primary', type: 'document', title: '任务结果', ownerLocalId: 'final', deliveryMode: 'inline' }]);
  }
} else if (input.includes('【UBUDDY_TASK_GRAPH_PROPOSAL_V1】') || input.includes('【UBUDDY_TASK_GRAPH_PROPOSAL_V2】')) {
  if (input.includes('同类双实例协作')) {
    const candidates = JSON.parse(input.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const generalA = candidates.find((item) => item.name === '通用 Agent A');
    const generalB = candidates.find((item) => item.name === '通用 Agent B');
    response = JSON.stringify({ nodes: [
      { localId: 'draft', title: 'A 分析', objective: '由通用 Agent A 完成分析', agentId: 'general_agent', agentInstanceId: generalA?.agentInstanceId, dependencies: [], outputFormat: 'text', isFinal: false },
      { localId: 'final', title: 'B 汇总', objective: '由通用 Agent B 汇总交付', agentId: 'general_agent', agentInstanceId: generalB?.agentInstanceId, dependencies: ['draft'], outputFormat: 'text', isFinal: true },
    ] });
  } else response = input.includes('PPT Agent') || input.includes('跨部门')
    ? (() => {
      const candidates = JSON.parse(input.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
      const crossDepartment = input.includes('跨部门');
      return candidates.length === 1 && candidates[0]?.agentId === 'ppt'
        ? JSON.stringify({ nodes: [{ localId: 'final', title: 'PPT 交付', objective: '生成最终 PPT 交付', agentId: 'ppt', agentInstanceId: candidates[0].agentInstanceId, dependencies: [], outputFormat: 'pptx', isFinal: true }] })
        : JSON.stringify({ nodes: [
          { localId: 'draft', title: '协作草稿', objective: '产出协作草稿', agentId: 'general_agent', dependencies: [], outputFormat: 'text', isFinal: false },
          { localId: 'final', title: crossDepartment ? '专业复核' : 'PPT 交付', objective: crossDepartment ? '完成专业复核' : '生成最终 PPT 交付', agentId: 'ppt', dependencies: ['draft'], outputFormat: crossDepartment ? 'text' : 'pptx', isFinal: true },
        ] });
    })()
    : JSON.stringify({ nodes: [{ localId: 'final', title: '协作结果', objective: '完成协作请求', agentId: 'general_agent', dependencies: [], outputFormat: 'text', isFinal: true }] });
} else if (input.includes('Routing policy:') && input.includes('请升级这个请求')) {
  response = '<JANUS_UBUDDY_ESCALATION_V1>{"mode":"single_agent","targetAgentId":"general_agent","reasonCode":"general_execution_required"}</JANUS_UBUDDY_ESCALATION_V1>';
} else if (input.includes('Routing policy:')) {
  response = 'UBUDDY_DIRECT_OK';
} else if (input.includes('<janus_direct_agent_chat>') && input.includes('写一份中国环境报告')) {
  response = '# 中国环境报告\\n\\n## 摘要\\n本报告概述中国环境治理中的污染防治、生态保护、资源利用和碳排放议题。\\n\\n## 现状与主要问题\\n部分地区仍面临废气排放、污水治理、固废分类、土壤修复和能耗控制压力，环境监测与责任台账需要持续完善。\\n\\n## 治理措施\\n健全排放台账和监测制度，强化污水、废气与固废治理，推进资源节约和节能降碳，并明确整改责任人与完成期限。\\n\\n## 实施保障与结论\\n由环境管理责任人按月检查治理指标和整改进度，通过信息公开与持续复核改善生态环境质量。';
}
return response;
}
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && String(message.id) === 'routing-query-work') {
      const payload = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const answer = 'CODEX_ROUTING_QUERY_OK：' + (payload.answer || '已查询任务状态');
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-routing-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
    } else if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-routing-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'ubuddy-routing-thread' } } });
    else if (message.method === 'turn/start') {
      const stdin = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const response = responseFor(stdin);
      if (stdin.includes('GENERAL FIFO blocker') && stdin.includes('<janus_direct_agent_chat>')) await new Promise((resolve) => setTimeout(resolve, 1000));
      if (process.env.UBUDDY_ROUTING_LOG) fs.appendFileSync(process.env.UBUDDY_ROUTING_LOG, JSON.stringify({ cwd: process.cwd(), stdin, response }) + '\\n');
      send({ id: message.id, result: { turn: { id: 'ubuddy-routing-turn' } } });
      const ownerMessage = stdin.split('Current owner message:\\n').at(-1) || '';
      if (ownerMessage.includes('当前任务进度怎么样') || ownerMessage.includes('当前进度怎么样')) {
        const tasks = JSON.parse(stdin.match(/Active uBuddy work summary:\\n(\\[[^\\n]*\\])/)?.[1] || '[]');
        const targetId = tasks.find((item) => ownerMessage.includes(item.id))?.id || '';
        send({ id: 'routing-query-work', method: 'item/tool/call', params: {
          threadId: 'ubuddy-routing-thread', turnId: 'ubuddy-routing-turn', callId: 'routing-query-work',
          namespace: 'janus', tool: 'query_work', arguments: { query: 'progress', ...(targetId ? { targetId } : {}) },
        } });
        continue;
      }
      if (stdin.includes('Routing policy:') && !stdin.includes('请升级这个请求')) {
        send({ method: 'item/started', params: { item: { id: 'ubuddy-direct-check', type: 'commandExecution', command: 'verify direct context', status: 'inProgress' } } });
        send({ method: 'item/completed', params: { item: { id: 'ubuddy-direct-check', type: 'commandExecution', command: 'verify direct context', aggregatedOutput: 'context ok', exitCode: 0, status: 'completed' } } });
      }
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-routing-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
    } else if (message.method === 'thread/memoryMode/set' || message.method.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = responseFor(stdin);
if (stdin.includes('GENERAL FIFO blocker') && stdin.includes('<janus_direct_agent_chat>')) await new Promise((resolve) => setTimeout(resolve, 1000));
if (process.env.UBUDDY_ROUTING_LOG) fs.appendFileSync(process.env.UBUDDY_ROUTING_LOG, JSON.stringify({ cwd: process.cwd(), stdin, response }) + '\\n');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-routing-thread' }));
  if (stdin.includes('Routing policy:') && !stdin.includes('请升级这个请求')) {
    console.log(JSON.stringify({ type: 'item.started', item: { id: 'ubuddy-direct-check', type: 'command_execution', command: 'verify direct context', status: 'in_progress' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'ubuddy-direct-check', type: 'command_execution', command: 'verify direct context', aggregated_output: 'context ok', exit_code: 0, status: 'completed' } }));
  }
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.UBUDDY_ROUTING_LOG = logPath;
process.env.JANUS_UBUDDY_NEW_DISPATCH_STRATEGY = 'off';
process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = 'off';
process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = 'off';
process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = 'off';
process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = 'off';
process.env.JANUS_UNIFIED_AGENT_WORK_KERNEL_V2 = 'on';

let runtime;
const taskUpdates = [];
try {
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true,
    onTaskUpdated: (payload) => taskUpdates.push(payload),
  });
  const userId = runtime.currentUser().id;
  const generalA = runtime.store.activeEmployeeAgentsForUser({ userId })
    .find((item) => item.agentFamilyId === 'general_agent');
  runtime.store.updateUserAgentProfile({
    userId, agentInstanceId: generalA.id, displayName: '通用 Agent A', note: '负责分析',
  });
  const generalBRecruitment = runtime.store.recruitUserAgent({
    userId, agentFamilyId: 'general_agent', commandId: 'ubuddy-routing-runtime-smoke:recruit-general-b',
  });
  const generalB = runtime.store.updateUserAgentProfile({
    userId, agentInstanceId: generalBRecruitment.instance.id, displayName: '通用 Agent B', note: '负责汇总',
  });
  runtime.store.recruitUserAgent({
    userId,
    agentFamilyId: 'ppt',
    commandId: 'ubuddy-routing-runtime-smoke:recruit-ppt',
  });
  const session = runtime.ensureSecretarySession();
  const project = runtime.createProject({ title: 'Routing project', workspaceRoot: projectRoot });
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('routing_admin','routing-admin@example.com','管理员','routing_admin',1)`).run();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('routing_admin_friendship',?, 'routing_admin','accepted')`).run(userId);
  const adminMention = { principalType: 'user', userId: 'routing_admin', displayText: '@管理员', mentionId: 'routing_admin_mention', source: 'picker' };
  const pptInstance = runtime.store.activeEmployeeAgentsForUser({ userId }).find((item) => item.agentFamilyId === 'ppt');
  const pptMention = { principalType: 'agent', agentId: 'ppt', agentInstanceId: pptInstance.id, displayText: '@PPT Agent', mentionId: 'routing_ppt_mention', source: 'picker' };

  const directEvents = [];
  const direct = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '把这句话改得更简洁。',
    onEvent: (event) => directEvents.push(event),
  });
  assert.equal(direct.uBuddyMode, 'direct');
  assert.equal(direct.answer, 'UBUDDY_DIRECT_OK');
  assert.equal(direct.message.metadata.uBuddyDecision, 'direct_answer');
  assert.equal(direct.message.metadata.uBuddyDecisionVersion, 'UBUDDY_TURN_DECISION_V2');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id }).length, 0);
  assert.ok(directEvents.some((event) => event.kind === 'start'));
  assert.ok(directEvents.some((event) => event.kind === 'routing'));
  assert.ok(directEvents.some((event) => event.kind === 'progress'
    && event.stage === 'planning' && /规划执行步骤/.test(event.message || '')),
  'uBuddy direct decisions must expose a visible planning stage while the model call is running');

  const singleAgentDelivery = await runtime.executeSecretaryDispatch({
    sessionId: session.id,
    dispatch: {
      version: 2,
      id: 'ubuddy-routing-single-agent-deliverable-v2',
      title: '中国环境报告',
      dispatchType: 'local_agent',
      objective: '写一份中国环境报告',
      agents: [{ agentId: 'general_agent', agentInstanceId: generalA.id }],
    },
  });
  assert.equal(singleAgentDelivery.receipt.metadata.deliverableContract.version, 'deliverable_contract_v2');
  assert.equal(singleAgentDelivery.receipt.metadata.deliverableContract.declaration_policy, 'host_infer_if_valid');
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(
    runtime.store.getAgentDeliveryReceiptByWorkId(singleAgentDelivery.workId)?.deliveryStatus || '',
  ));
  const completedSingleAgentDelivery = runtime.store.getAgentDeliveryReceiptByWorkId(singleAgentDelivery.workId);
  assert.equal(completedSingleAgentDelivery.deliveryStatus, 'completed', JSON.stringify(completedSingleAgentDelivery));
  assert.equal(completedSingleAgentDelivery.metadata.deliveryValidationCode || '', '');
  const singleAgentResultMessage = runtime.store.getMessage(completedSingleAgentDelivery.targetMessageId);
  assert.equal(singleAgentResultMessage.metadata.contentTypeDeclared, false);
  assert.equal(singleAgentResultMessage.metadata.deliverableResult.contentTypeSource, 'host_inferred_deliverable');
  assert.match(singleAgentResultMessage.content, /治理措施/);
  const directAgentDeliveryRunCount = runtime.store.listAgentDeliveryRuns({ userId })
    .filter((item) => item.metadata?.source === 'ubuddy_direct_agent').length;

  const clarificationTaskCount = runtime.store.listTaskRuns({ userId }).length;
  const clarificationDecision = await runtime.secretaryChat({
    sessionId: session.id,
    message: '这个任务的最终产物不明确，请先判断。',
  });
  assert.equal(clarificationDecision.uBuddyMode, 'clarification');
  assert.match(clarificationDecision.answer, /最终需要报告还是PPT/);
  assert.equal(runtime.store.listTaskRuns({ userId }).length, clarificationTaskCount);

  const failureTaskCount = runtime.store.listTaskRuns({ userId }).length;
  const failedDecision = await runtime.secretaryChat({
    sessionId: session.id,
    message: '强制统一决策失败',
  });
  assert.equal(failedDecision.uBuddyMode, 'decision_failed');
  assert.equal(failedDecision.errorCode, 'ubuddy_turn_decision_failed');
  assert.match(failedDecision.answer, /没有创建任务/);
  assert.equal(runtime.store.listTaskRuns({ userId }).length, failureTaskCount, 'invalid model JSON must not create a fallback task');
  const failedRequestMessage = runtime.store.listMessages(session.id)
    .find((message) => message.id === failedDecision.message.metadata.sourceMessageId);
  assert.equal(failedRequestMessage?.metadata?.uBuddyDecisionFailure?.outputPreview, 'not-json');
  assert.match(failedRequestMessage?.metadata?.uBuddyDecisionFailure?.errorMessage || '', /did not return JSON/i);

  const externalQuestion = await runtime.secretaryChat({
    sessionId: session.id,
    message: '@管理员 问一下他什么时候开会',
    mentions: [adminMention],
  });
  assert.equal(externalQuestion.uBuddyMode, 'dispatched');
  assert.equal(externalQuestion.dispatchType, 'external_delegation');
  assert.ok(externalQuestion.delegation?.id);
  assert.equal(runtime.socialConversation({ peerId: 'routing_admin' }).filter((item) => item.metadata?.type === 'ubuddy_simple_message').length, 0);
  assert.equal(runtime.agentDelegations({ direction: 'outgoing' }).length, 1);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 0);

  const incomplete = await runtime.secretaryChat({
    sessionId: session.id,
    message: '@管理员',
    mentions: [{ ...adminMention, mentionId: 'routing_admin_incomplete' }],
  });
  assert.equal(incomplete.uBuddyMode, 'clarification');
  assert.equal(incomplete.message.metadata.reasonCode, 'missing_requirement');
  assert.match(incomplete.answer, /任务要求/);
  assert.equal(runtime.socialConversation({ peerId: 'routing_admin' }).filter((item) => item.metadata?.type === 'ubuddy_simple_message').length, 0);

  const externalReport = await runtime.secretaryChat({
    sessionId: session.id,
    message: '@管理员 写一份环境治理报告',
    mentions: [{ ...adminMention, mentionId: 'routing_admin_report' }],
  });
  assert.equal(externalReport.uBuddyMode, 'dispatched');
  assert.equal(externalReport.dispatchType, 'external_delegation');
  assert.ok(externalReport.delegation?.id);
  assert.equal(externalReport.delegation?.groupId || '', '');
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM collaboration_groups').get().count, 0);

  const reportToPptEvents = [];
  const reportToPpt = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '让通用Agent写一份中国环境报告，然后交给PPTAgent生成一份5页的PPT',
    onEvent: (event) => reportToPptEvents.push(event),
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(reportToPpt.uBuddyMode), JSON.stringify(reportToPpt));
  assert.ok(reportToPpt.taskRunId, 'report-to-PPT request must create a formal task immediately');
  assert.equal(reportToPpt.planningJob, undefined, 'new local tasks must not create legacy background planning jobs');
  assert.equal(reportToPpt.task.metadata.ubuddyPlannerMode, 'unified_model_decision_v1');
  assert.equal(reportToPpt.task.metadata.featureFlagSnapshot.newDispatchStrategy, false,
    'packaged-off rollout flag must not downgrade the model task decision');
  assert.ok(reportToPpt.task.nodes.some((node) => node.agentId === 'general_agent'));
  assert.ok(reportToPpt.task.nodes.some((node) => node.agentId === 'ppt'));
  assert.ok(reportToPptEvents.some((event) => event.kind === 'progress'
    && event.stage === 'dispatching' && /创建任务并安排执行/.test(event.message || '')),
  'formal uBuddy tasks must expose a dispatching stage before the task progress card takes over');
  assert.equal(reportToPpt.task.metadata.deliverablePlan.deliverables.find((item) => item.role === 'primary')?.constraints.exactSlideCount, 5);
  assert.equal(runtime.cancelTaskRun({ taskRunId: reportToPpt.taskRunId })?.status, 'cancelled');

  const explicitAgent = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '告诉通用 Agent B，让它整理一份名单。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(explicitAgent.uBuddyMode));
  assert.ok(explicitAgent.taskRunId, 'formal single-Agent work must create a one-node task graph');
  assert.equal(explicitAgent.task.metadata.ubuddyPlannerMode, 'unified_model_decision_v1');
  assert.equal(explicitAgent.task.metadata.taskGraphProposal.nodes.length, 1);
  assert.equal(explicitAgent.task.metadata.taskGraphProposal.nodes[0].agentInstanceId, generalB.id);
  assert.equal(explicitAgent.task.metadata.executionKernelVersion, 'agent_work_v2');
  assert.equal(runtime.store.listAgentDeliveryRuns({ userId }).filter((item) => item.metadata?.source === 'ubuddy_direct_agent').length, directAgentDeliveryRunCount,
    'new formal local work must not use the legacy direct Agent delivery queue');
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(runtime.store.getTaskRun(explicitAgent.taskRunId)?.status || ''));
  const completedExplicitTask = runtime.store.getTaskRun(explicitAgent.taskRunId);
  assert.equal(completedExplicitTask.status, 'completed', JSON.stringify(completedExplicitTask));
  const explicitNode = completedExplicitTask.nodes.at(-1);
  const nodeSessions = runtime.db.prepare(`SELECT * FROM sessions WHERE conversation_role='task_node'
    AND id IN (SELECT DISTINCT session_id FROM messages WHERE task_run_id=? AND task_node_id=?)`).all(
    completedExplicitTask.id, explicitNode.id,
  );
  assert.equal(nodeSessions.length, 1, 'a unified task node must own one persistent background Agent session');
  assert.ok(nodeSessions[0].codex_thread_id, 'the background task node must persist its Codex thread');
  assert.equal(runtime.listSessions().some((item) => item.id === nodeSessions[0].id), false,
    'background task-node sessions must not pollute the ordinary session list');
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) count FROM messages WHERE task_run_id=? AND task_node_id=?
    AND role='assistant' AND json_extract(metadata_json,'$.unifiedAgentWork')=1`).get(
    completedExplicitTask.id, explicitNode.id,
  ).count, 1, 'one task-node attempt must persist one unified Agent response');
  assert.ok(runtime.store.listModelExecutionsForTask(completedExplicitTask.id)
    .some((execution) => execution.taskNodeId === explicitNode.id && execution.executionKind === 'task_node'),
  'the shared Agent session execution must remain linked to the task and node');
  const explicitTerminal = runtime.store.listMessages(session.id)
    .find((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === completedExplicitTask.id);
  assert.equal(explicitTerminal?.metadata?.uBuddyFinalDeliveryMessage, true);
  assert.match(explicitTerminal?.metadata?.deliverableResult?.body || '', /AGENT_DIRECT_OK/);
  const deliveryQuery = await runtime.secretaryChat({ sessionId: session.id, message: '当前任务进度怎么样？' });
  assert.equal(deliveryQuery.uBuddyMode, 'task_query_control');
  assert.match(deliveryQuery.answer, /名单|任务/);

  runtime.store.updateTaskNode(explicitNode.id, {
    evidenceRefs: [
      ...(explicitNode.evidenceRefs || []),
      { type: 'file', label: 'outputs/old-task-result.md', path: 'outputs/old-task-result.md' },
    ],
  });
  const taskCountBeforeFollowup = runtime.store.listTaskRuns({ userId, limit: 100 }).length;
  const followupWork = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '另外，请创建一个新的报告，完成后告诉我文件路径。',
  });
  assert.notEqual(followupWork.uBuddyMode, 'task_query_control', 'a new work request must not query the previous task artifact');
  assert.ok(followupWork.taskRunId, 'a follow-up work request must create a new task instead of returning the previous result');
  assert.equal(runtime.store.listTaskRuns({ userId, limit: 100 }).length, taskCountBeforeFollowup + 1);
  assert.doesNotMatch(followupWork.answer, /outputs\/old-task-result\.md/);
  const followupRequest = runtime.store.getMessage(followupWork.message.metadata?.sourceMessageId || '');
  assert.equal(followupRequest?.metadata?.taskQueryIntent, undefined);
  const followupQuery = await runtime.secretaryChat({
    sessionId: session.id,
    message: `${followupWork.taskRunId} 当前进度怎么样？`,
  });
  assert.equal(followupQuery.uBuddyMode, 'task_query_control', 'explicit progress queries must remain available after creating a new task');
  assert.ok(followupQuery.taskRunIds.includes(followupWork.taskRunId));
  runtime.cancelTaskRun({ taskRunId: followupWork.taskRunId });

  const escalated = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '请升级这个请求。',
  });
  assert.equal(escalated.uBuddyMode, 'direct');
  assert.equal(escalated.answer, 'UBUDDY_DIRECT_OK');
  assert.equal(runtime.store.listMessages(session.id).some((message) => message.content.includes('JANUS_UBUDDY_ESCALATION_V1')), false);

  const generalContext = runtime.store.requireRoutableUserAgent({ userId: runtime.currentUser().id, agentFamilyId: 'general_agent' });
  const blocker = runtime.sendChat({
    departmentId: 'general', agentId: 'general_agent', agentInstanceId: generalContext.instance.id,
    projectId: project.id, workspaceRoot: project.workspaceRoot, routePreference: 'explicit', message: 'GENERAL FIFO blocker',
  });
  await waitFor(() => runtime.store.listAgentWorkQueue({ agentInstanceId: generalContext.instance.id, statuses: ['running'] }).length === 1);
  const cancellable = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '告诉通用Agent，让它执行阻塞取消任务。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(cancellable.uBuddyMode));
  assert.ok(cancellable.taskRunId, 'busy explicit target must create an allocation-backed task instead of a queued delivery');
  assert.equal(runtime.store.getUBuddyCoordinationState(cancellable.taskRunId)?.state, 'sleeping');
  assert.notEqual(runtime.store.getTaskRun(cancellable.taskRunId)?.leadAgentInstanceId, generalContext.instance.id,
    'an idle same-family employee must replace the busy explicit preference');
  assert.equal(runtime.cancelTaskRun({ taskRunId: cancellable.taskRunId })?.status, 'cancelled');
  assert.equal(runtime.cancelTaskRun({ taskRunId: cancellable.taskRunId })?.status, 'cancelled');
  assert.equal(runtime.store.listAgentWorkReservations({ taskRunId: cancellable.taskRunId, statuses: ['active'] }).length, 0);
  await blocker;

  const sameFamilyWorkflow = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '请让通用 Agent A 和通用 Agent B 使用多 Agent workflow 完成同类双实例协作。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(sameFamilyWorkflow.uBuddyMode));
  assert.equal(runtime.store.getUBuddyPlanningJob({ taskRunId: sameFamilyWorkflow.taskRunId }), null);
  const sameFamilyTask = runtime.store.getTaskRun(sameFamilyWorkflow.taskRunId);
  assert.deepEqual(new Set(sameFamilyTask.nodes.map((node) => node.agentInstanceId)), new Set([generalA.id, generalB.id]));
  assert.deepEqual(new Set(sameFamilyTask.metadata.participantAgentInstanceIds), new Set([generalA.id, generalB.id]));
  assert.equal(sameFamilyTask.metadata.leadershipCoordinatedAgentCount, 1);
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(runtime.store.getTaskRun(sameFamilyWorkflow.taskRunId)?.status || ''));
  const completedSameFamilyTask = runtime.store.getTaskRun(sameFamilyWorkflow.taskRunId);
  assert.equal(completedSameFamilyTask.status, 'completed', JSON.stringify(completedSameFamilyTask));
  const executedSameFamilyNodes = completedSameFamilyTask.nodes.filter((node) => Number(node.attemptCount || 0) > 0);
  assert.equal(runtime.db.prepare(`SELECT COUNT(DISTINCT session_id) count FROM messages
    WHERE task_run_id=? AND role='assistant' AND json_extract(metadata_json,'$.unifiedAgentWork')=1`).get(
    completedSameFamilyTask.id,
  ).count, executedSameFamilyNodes.length,
  'each executed node in a multi-Agent workflow must own one persistent single-work session');
  const sameFamilyFinalNode = completedSameFamilyTask.nodes.find((node) => node.id === completedSameFamilyTask.metadata.finalTaskNodeId)
    || completedSameFamilyTask.nodes.at(-1);
  const finalNodeRequest = runtime.db.prepare(`SELECT content FROM messages
    WHERE task_run_id=? AND task_node_id=? AND role='user' ORDER BY created_at DESC,id DESC LIMIT 1`).get(
    completedSameFamilyTask.id, sameFamilyFinalNode.id,
  );
  assert.match(finalNodeRequest?.content || '', /handoff_package_v1/,
    'the leader single-work session must receive a structured upstream handoff package');

  const workflow = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '请使用不同专业 Agent 完成跨部门多 Agent workflow 协作测试。',
  });
  assert.ok(['sleeping', 'waiting_for_agents'].includes(workflow.uBuddyMode));
  assert.ok(workflow.taskRunId);
  assert.equal(runtime.store.getUBuddyPlanningJob({ taskRunId: workflow.taskRunId }), null);
  const plannedWorkflowTask = runtime.store.getTaskRun(workflow.taskRunId);
  assert.ok(plannedWorkflowTask.nodes.some((node) => node.agentId === 'general_agent'));
  assert.ok(plannedWorkflowTask.nodes.some((node) => node.agentId === 'ppt'), 'model-planned node ownership must survive task-leader selection');
  const workflowFinalNode = plannedWorkflowTask.nodes.find((node) => node.id === plannedWorkflowTask.metadata.finalTaskNodeId)
    || plannedWorkflowTask.nodes.at(-1);
  assert.equal(workflowFinalNode.agentId, plannedWorkflowTask.leadAgentId);
  assert.ok(['waiting_for_agents', 'sleeping'].includes(runtime.store.getUBuddyCoordinationState(workflow.taskRunId)?.state));
  assert.match(workflow.answer, /任务图/);
  await waitFor(() => runtime.store.getTaskRun(workflow.taskRunId)?.leadAgentInstanceId
    && runtime.store.getUBuddyCoordinationState(workflow.taskRunId)?.state !== 'waiting_for_agents');
  try {
    await waitFor(() => runtime.store.getUBuddyWakeForGeneration({ taskRunId: workflow.taskRunId, generation: 1 })?.status === 'delivered', 20_000);
  } catch (error) {
    throw new Error(`${error.message}\n${JSON.stringify({
      task: runtime.store.getTaskRun(workflow.taskRunId),
      coordination: runtime.store.getUBuddyCoordinationState(workflow.taskRunId),
      wakes: runtime.store.listUBuddyWakeEvents({ taskRunId: workflow.taskRunId }),
    })}`);
  }
  const workflowWake = runtime.store.getUBuddyWakeForGeneration({ taskRunId: workflow.taskRunId, generation: 1 });
  assert.ok(workflowWake?.deliveryMessageId, 'terminal Agent result must wake uBuddy through the persisted outbox');
  assert.equal(runtime.store.getUBuddyCoordinationState(workflow.taskRunId)?.state,
    runtime.store.getTaskRun(workflow.taskRunId)?.status === 'completed' ? 'completed' : 'failed');
  assert.ok(taskUpdates.some((payload) => (
    payload.task?.id === workflow.taskRunId
    && payload.change?.type === 'ubuddy_wake_delivered'
    && ['completed', 'failed'].includes(payload.coordination?.coordinationState)
  )), 'wake acknowledgement must publish the final coordination state to the renderer');

  const actionSourceSession = runtime.store.createSession({
    title: 'uBuddy action source', departmentId: 'secretary_department', agentId: 'secretary_agent',
    userId, accountWorkspaceId: session.workspaceId, reusePrimary: false, conversationRole: 'secondary',
  });
  const actionTask = runtime.scheduler.createTaskRun({
    title: '需要用户操作的任务', prompt: '等待用户补充授权信息', departmentId: 'general', userId,
    metadata: {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: actionSourceSession.id,
      accountWorkspaceId: session.workspaceId,
      objective: { taskType: 'general', summary: '等待用户补充授权信息' },
      taskGraphProposal: { nodes: [{
        localId: 'final', title: '等待授权', objective: '等待用户补充授权信息',
        agentId: 'general_agent', agentInstanceId: generalA.id, dependencies: [], outputFormat: 'text', isFinal: true,
      }] },
    },
  });
  runtime.store.startUBuddyCoordination({
    taskRunId: actionTask.id, sourceSessionId: actionSourceSession.id,
    leaderAgentId: actionTask.leadAgentId, leaderAgentInstanceId: actionTask.leadAgentInstanceId,
  });
  runtime.store.markUBuddySleeping({
    taskRunId: actionTask.id, leaderAgentId: actionTask.leadAgentId,
    leaderAgentInstanceId: actionTask.leadAgentInstanceId, sleepReason: '等待 leader 反馈。',
  });
  const actionWake = runtime.store.requestUBuddyWake({
    taskRunId: actionTask.id, reasonCode: 'user_action_required',
    leaderAgentId: actionTask.leadAgentId, leaderAgentInstanceId: actionTask.leadAgentInstanceId,
    payload: { reportSummary: '请补充授权信息后继续。' },
  });
  runtime.store.updateSession(actionSourceSession.id, { deleted: true });
  runtime.store.updateTaskRunStatus(actionTask.id, 'failed', 'Owner action is required.');
  runtime.scheduler.notifyTaskUpdated(actionTask.id, { type: 'task_failed' });
  await waitFor(() => runtime.store.getUBuddyWakeEvent(actionWake.id)?.status === 'delivered');
  assert.equal(runtime.store.getUBuddyCoordinationState(actionTask.id)?.state, 'awakened',
    'user-action wake must remain awakened instead of becoming a terminal failure state');
  assert.ok(runtime.store.listMessages(session.id).some((message) => (
    message.metadata?.uBuddyWakeEventId === actionWake.id
    && message.metadata?.uBuddyTaskActionRequired === true
    && message.metadata?.sourceSecretarySessionId === actionSourceSession.id
  )), 'a deleted source session must fall back to the owner\'s writable uBuddy session');

  const mixed = await runtime.secretaryChat({
    sessionId: session.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    message: '@管理员 和 @PPT Agent 分工做一个项目方案',
    mentions: [{ ...adminMention, mentionId: 'routing_admin_mixed' }, pptMention],
  });
  assert.equal(mixed.uBuddyMode, 'dispatched');
  assert.equal(mixed.dispatchType, 'task_group');
  assert.ok(mixed.group?.group?.id);
  assert.equal(mixed.group.group.metadata.virtualParticipants[0].agentFamilyId, 'ppt');
  assert.ok(mixed.taskRunId);

  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('routing_org_contact','routing-org-contact@example.com','组织联系人','routing_org_contact',1)`).run();
  runtime.db.prepare(`INSERT INTO contact_organizations (
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES ('routing_org','ROUTING-ORG','Routing Organization','salt','hash',?)`).run(userId);
  runtime.db.prepare(`INSERT INTO contact_organization_members (organization_id,user_id,role)
    VALUES ('routing_org',?,'owner'),('routing_org','routing_org_contact','member')`).run(userId);
  runtime.store.ensureAccountWorkspaces({ user: runtime.currentUser() });
  runtime.store.ensureAccountWorkspaces({ user: { id: 'routing_org_contact', displayName: '组织联系人' } });
  const organizationWorkspaceId = 'workspace_org_routing_org';
  await runtime.switchAccountWorkspace({ workspaceId: organizationWorkspaceId });
  const organizationMention = {
    principalType: 'user', userId: 'routing_org_contact', displayText: '@组织联系人',
    mentionId: 'routing_org_contact_mention', source: 'picker',
  };
  const organizationDispatch = await runtime.secretaryChat({
    message: '@组织联系人 请整理一份组织协作验收说明。',
    mentions: [organizationMention],
  });
  assert.equal(organizationDispatch.uBuddyMode, 'dispatched');
  assert.equal(organizationDispatch.dispatchType, 'external_delegation');
  assert.equal(organizationDispatch.delegation.recipientUserId, 'routing_org_contact');
  assert.equal(organizationDispatch.delegation.workspaceId, organizationWorkspaceId);
  assert.equal(runtime.db.prepare(`SELECT count(*) count FROM friendships
    WHERE (user_a_id=? AND user_b_id='routing_org_contact') OR (user_b_id=? AND user_a_id='routing_org_contact')`).get(userId, userId).count, 0,
  'organization delegation must not create a synthetic friendship');

  runtime.db.prepare(`DELETE FROM contact_organization_members
    WHERE organization_id='routing_org' AND user_id='routing_org_contact'`).run();
  runtime.store.ensureAccountWorkspaces({ user: runtime.currentUser() });
  await assert.rejects(
    () => runtime.secretaryChat({
      message: '@组织联系人 请再次创建一项组织协作任务。',
      mentions: [{ ...organizationMention, mentionId: 'routing_removed_org_contact_mention' }],
    }),
    /已添加的好友或当前组织成员/,
  );
  await runtime.switchAccountWorkspace({ workspaceId: 'workspace_personal' });

  const terminalMessageCountBeforeRestart = runtime.store.listMessages(session.id)
    .filter((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === workflow.taskRunId).length;
  await runtime.close();
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true,
    onTaskUpdated: (payload) => taskUpdates.push(payload),
  });
  await waitFor(() => runtime.store.getUBuddyWakeForGeneration({ taskRunId: workflow.taskRunId, generation: 1 })?.status === 'delivered');
  assert.equal(runtime.store.getUBuddyCoordinationState(workflow.taskRunId)?.state,
    runtime.store.getTaskRun(workflow.taskRunId)?.status === 'completed' ? 'completed' : 'failed');
  assert.equal(runtime.store.listMessages(session.id)
    .filter((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === workflow.taskRunId).length,
  terminalMessageCountBeforeRestart, 'restart recovery must not duplicate an acknowledged wake delivery');
  assert.equal(runtime.store.getUBuddyCoordinationState(actionTask.id)?.state, 'awakened',
    'restart recovery must not put a user-action wake back to sleep');
  assert.equal(runtime.store.listMessages(session.id)
    .filter((message) => message.metadata?.uBuddyWakeEventId === actionWake.id).length,
  1, 'restart recovery must not duplicate a user-action wake delivery');

  const calls = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const unifiedDecisionCalls = calls.filter((call) => call.stdin.includes('【UBUDDY_TURN_DECISION_V2】'));
  assert.ok(unifiedDecisionCalls.length >= 6);
  assert.ok(unifiedDecisionCalls.every((call) => call.cwd === project.workspaceRoot));
  console.log('uBuddy routing runtime smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN; else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.UBUDDY_ROUTING_LOG; else process.env.UBUDDY_ROUTING_LOG = previousLog;
  if (previousDispatchFlag === undefined) delete process.env.JANUS_UBUDDY_NEW_DISPATCH_STRATEGY;
  else process.env.JANUS_UBUDDY_NEW_DISPATCH_STRATEGY = previousDispatchFlag;
  if (previousIntakeFlag === undefined) delete process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2;
  else process.env.JANUS_UBUDDY_INTAKE_CLARIFICATION_V2 = previousIntakeFlag;
  if (previousStructuredReferenceFlag === undefined) delete process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1;
  else process.env.JANUS_STRUCTURED_TASK_REFERENCE_V1 = previousStructuredReferenceFlag;
  if (previousAutoRoutingFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1;
  else process.env.JANUS_UBUDDY_PROFILE_ROUTING_AUTO_V1 = previousAutoRoutingFlag;
  if (previousBoundedReviewFlag === undefined) delete process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1;
  else process.env.JANUS_BOUNDED_DELIVERY_REWORK_V1 = previousBoundedReviewFlag;
  if (previousUnifiedAgentWorkFlag === undefined) delete process.env.JANUS_UNIFIED_AGENT_WORK_KERNEL_V2;
  else process.env.JANUS_UNIFIED_AGENT_WORK_KERNEL_V2 = previousUnifiedAgentWorkFlag;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for uBuddy routing runtime smoke.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
