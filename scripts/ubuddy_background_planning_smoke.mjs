import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-background-planning-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-background-planning-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
async function responseForInput(stdin) {
let response = 'BACKGROUND_NODE_OK';
if (stdin.includes('【UBUDDY_CONTINUOUS_PLANNING_V1】')) {
  if (stdin.includes('强制规划失败')) response = 'not-json';
  else {
    const candidates = JSON.parse(stdin.match(/Authorized local Agent candidates: (\\[[^\\n]+\\])/)?.[1] || '[]');
    const general = candidates.find((item) => item.agentId === 'general_agent') || candidates[0];
    const ppt = candidates.find((item) => item.agentId === 'ppt') || general;
    const selected = [...new Map([general, ppt].filter(Boolean).map((item) => [item.agentInstanceId, item])).values()];
    const assignments = selected.map((item, index) => ({
      assignmentId: index ? 'delivery' : 'research', assigneeKind: 'agent', userId: '', agentInstanceId: item.agentInstanceId,
      title: index ? '完成最终交付' : '研究分析', objective: index ? '整合并完成最终交付物' : '完成调研分析',
      deliverables: ['经过复核的最终交付物'], dependencies: index ? ['research'] : [],
    }));
    response = JSON.stringify({
      version: 'UBUDDY_PLANNING_DECISION_V1', decision: 'ready_for_dispatch', confidence: 0.95, answer: '',
      intake: {
        version: 'ubuddy_task_intake_v1', state: 'ready', taskKind: 'general', workReportSpec: null,
        objective: '完成复杂任务并形成经过复核的最终交付物', deliverables: ['经过复核的最终交付物'],
        acceptanceCriteria: [], constraints: [], deadline: '', candidateUsers: [], requiredUsers: [], attachments: [],
        privacyScope: 'owner_private', riskLevel: 'medium', missingFields: [], clarifications: [],
        executionPlan: { summary: '研究、整合并复核交付物', steps: ['研究分析', '完成最终交付'], requiredInputs: [] },
        knownFacts: [], safeAssumptions: [], criticalUnknowns: [], readiness: { status: 'ready', reason: '' },
      },
      target: { kind: 'local_agent', candidateUserIds: [], requiredUserIds: [], selectedUserIds: [], selectedAgentInstanceIds: selected.map((item) => item.agentInstanceId) },
      collaboration: { mode: 'manager_delegation', initiatorParticipation: 'coordinator_only', participantSelectionIntent: 'all', assignmentIntent: 'auto' },
      assignments, clarifications: [], readiness: { status: 'ready', reason: '', knownFacts: [], safeAssumptions: [], criticalUnknowns: [] },
      riskLevel: 'medium', rationale: '按专业能力完成研究和最终交付。',
    });
  }
} else if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const current = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0]
    || '完成复杂任务并形成经过复核的最终交付物';
  response = JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective: current,
      deliverables: ['经过复核的最终交付物'], acceptanceCriteria: [], constraints: [], deadline: '',
      candidateUsers: [], requiredUsers: [], attachments: [], privacyScope: 'owner_private', riskLevel: 'medium',
      missingFields: [], clarification: { reasonCode: '', question: '', options: [] },
    },
  });
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  if (stdin.includes('强制规划失败')) response = 'not-json';
  else {
    const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const general = candidates.find((item) => item.agentId === 'general_agent');
    const ppt = candidates.find((item) => item.agentId === 'ppt') || general;
    response = JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.95,
      nodes: [
        { localId: 'research', title: '研究', objective: '完成调研分析', agentId: general.agentId, agentInstanceId: general.agentInstanceId, dependencies: [], outputFormat: 'markdown', isFinal: false, blocking: true, fallback: '说明无法完成的原因。' },
        { localId: 'delivery', title: '交付', objective: '完成最终交付', agentId: ppt.agentId, agentInstanceId: ppt.agentInstanceId, dependencies: ['research'], outputFormat: 'markdown', isFinal: true, blocking: true, fallback: '说明无法完成的原因。' }
      ],
      deliverables: [{ id: 'primary', role: 'primary', type: 'document', title: '最终交付', ownerLocalId: 'delivery', deliveryMode: 'inline' }],
      agentSelectionRationale: '按专业能力完成调研和最终交付。', mentionedAgentsNotSelected: [],
    });
  }
} else if (stdin.includes('【UBUDDY_TASK_GRAPH_PROPOSAL_V2】')) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (stdin.includes('强制规划失败')) response = 'not-json';
  else {
    const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
    const general = candidates.find((item) => item.agentId === 'general_agent');
    const ppt = candidates.find((item) => item.agentId === 'ppt') || general;
    response = JSON.stringify({ version: 2, status: 'ready', confidence: 0.95, nodes: [
      { localId: 'research', title: '研究', objective: '完成调研分析', agentId: general.agentId, agentInstanceId: general.agentInstanceId, dependencies: [], outputFormat: 'markdown', isFinal: false, blocking: true },
      { localId: 'delivery', title: '交付', objective: '完成最终交付', agentId: ppt.agentId, agentInstanceId: ppt.agentInstanceId, dependencies: ['research'], outputFormat: 'markdown', isFinal: true, blocking: true }
    ] });
  }
}
return response;
}
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'background-planning-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'background-planning-smoke' } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'background-planning-turn' } } });
      const prompt = message.params?.input?.[0]?.text || '';
      const answer = await responseForInput(prompt);
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'background-planning-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = await responseForInput(stdin);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'background-planning-smoke' }));
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: response } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  runtime.store.recruitUserAgent({ userId: user.id, agentFamilyId: 'ppt', commandId: 'background-planning:ppt' });
  const session = runtime.ensureSecretarySession();
  const startedAt = Date.now();
  const result = await runtime.secretaryChat({
    sessionId: session.id,
    parentTaskRunId: 'background_planning_parent_smoke',
    message: '继续完成这个复杂任务，并形成经过复核的最终交付物。',
  });
  const returnedInMs = Date.now() - startedAt;
  assert.ok(['sleeping', 'waiting_for_agents'].includes(result.uBuddyMode), JSON.stringify(result));
  assert.ok(result.taskRunId);
  assert.ok(returnedInMs < 700, `secretaryChat blocked after the unified decision for ${returnedInMs}ms`);
  assert.notEqual(runtime.store.getTaskRun(result.taskRunId).status, 'planning');
  assert.equal(runtime.store.getUBuddyPlanningJob({ taskRunId: result.taskRunId }), null);
  const task = runtime.store.getTaskRun(result.taskRunId);
  assert.ok(task.nodes.length >= 2);
  assert.equal(task.metadata.coordinationMode, 'appointed_agent_leader');
  const finalNode = task.nodes.find((node) => node.id === task.metadata.finalTaskNodeId) || task.nodes.at(-1);
  assert.equal(finalNode.agentId, task.leadAgentId);
  assert.ok(runtime.store.getUBuddyCoordinationState(task.id));

  const failed = await runtime.secretaryChat({
    sessionId: session.id,
    parentTaskRunId: 'background_planning_failure_parent',
    message: '强制规划失败：继续这个复杂任务并形成最终交付物。',
  });
  assert.equal(failed.uBuddyMode, 'planning_failed');
  assert.equal(failed.errorCode, 'ubuddy_continuous_planning_validation_failed');
  assert.equal(failed.taskRunId, undefined);
  console.log('uBuddy unified planning smoke passed.');
} finally {
  await runtime?.close?.();
  if (previousBin == null) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
}
