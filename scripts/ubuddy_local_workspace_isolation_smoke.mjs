import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-local-workspace-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-local-workspace-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
const responseFor = (input) => input.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')
  ? JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false,
    action: 'direct', continuation: false, intake: null,
  })
  : input.includes('【UBUDDY_TURN_DECISION_V2】')
  ? JSON.stringify({
    version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.96,
    answer: 'LOCAL_UBUDDY_WORKSPACE_OK', nodes: [], deliverables: [],
    agentSelectionRationale: '', mentionedAgentsNotSelected: [],
  })
  : input.includes('【UBUDDY_TASK_GRAPH_PROPOSAL_V1】')
  ? JSON.stringify({ nodes: [{ localId: 'final', title: '本地隔离任务', objective: '验证本地任务工作区隔离', agentId: 'general_agent', dependencies: [], outputFormat: '简短结论', isFinal: true }] })
  : 'LOCAL_UBUDDY_WORKSPACE_OK';
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-local-workspace-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'ubuddy-local-workspace-thread' } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      const response = responseFor(message.params?.input?.[0]?.text || '');
      send({ id: message.id, result: { turn: { id: 'ubuddy-local-workspace-turn' } } });
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      send({ method: 'turn/completed', params: { turn: { id: 'ubuddy-local-workspace-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const response = responseFor(stdin);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'ubuddy-local-workspace-smoke' }));
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
  const session = runtime.ensureSecretarySession();
  const contaminatedWorkspace = path.join(root, 'data', 'task-group-workspaces', user.id, 'stale-group');
  await mkdir(contaminatedWorkspace, { recursive: true });
  runtime.store.updateSession(session.id, { projectId: '', workspaceRoot: contaminatedWorkspace });

  const healedSession = runtime.ensureSecretarySession({ sessionId: session.id });
  assert.equal(healedSession.workspaceRoot, '', 'personal uBuddy must clear inherited collaboration workspaces');

  const dispatched = await runtime.secretaryChat({
    sessionId: session.id,
    workspaceRoot: contaminatedWorkspace,
    message: '解释本地工作区隔离原则，不要创建文件。',
  });
  assert.equal(dispatched.uBuddyMode, 'direct');
  assert.equal(runtime.store.listTaskRuns({ userId: user.id }).length, 0);
  assert.equal(runtime.store.getSession(session.id).workspaceRoot, '');
  await assert.rejects(access(path.join(root, 'data', 'ubuddy-task-workspaces')), /ENOENT/,
    'direct uBuddy handling without a project must not create a substitute task workspace');
  console.log('uBuddy local workspace isolation smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
}
