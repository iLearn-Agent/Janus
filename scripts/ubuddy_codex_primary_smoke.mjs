import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-codex-primary-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-codex-primary-bin-'));
const projectRoot = path.join(root, 'project');
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousFlag = process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;

await mkdir(projectRoot, { recursive: true });
await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server --listen <URL>'); process.exit(0); }
if (args[0] === 'doctor') { console.log(JSON.stringify({ overallStatus: 'pass' })); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pendingTool = false;
  let pendingActionId = '';
  for await (const line of input) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method && String(message.id) === 'ubuddy-confirm-initial') {
      const parsed = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      pendingActionId = parsed.actionId || '';
      send({ id: 'ubuddy-user-input', method: 'item/tool/requestUserInput', params: {
        threadId: 'ubuddy-primary-thread', turnId: 'turn-1', itemId: 'confirm-input',
        questions: [{ id: 'confirm', header: '确认派发', question: '确认公开发布这项委托吗？', isOther: false,
          options: [{ label: '确认', description: '继续派发。' }, { label: '取消', description: '不创建委托。' }] }],
      } });
      continue;
    }
    if (!message.method && String(message.id) === 'ubuddy-user-input') {
      const selected = message.result?.answers?.confirm?.answers || [];
      if (!pendingActionId || !selected.includes('确认')) process.exit(9);
      send({ id: 'ubuddy-confirm-final', method: 'item/tool/call', params: {
        threadId: 'ubuddy-primary-thread', turnId: 'turn-1', callId: 'confirm-final-call', namespace: 'janus', tool: 'resolve_pending_action',
        arguments: { actionId: pendingActionId, decision: 'confirm' },
      } });
      continue;
    }
    if (!message.method && String(message.id) === 'ubuddy-confirm-final') {
      const parsed = JSON.parse(message.result?.contentItems?.[0]?.text || '{}');
      const answer = parsed.delegationId ? 'UBUDDY_CONFIRM_DISPATCH_OK' : 'UBUDDY_CONFIRM_DISPATCH_FAILED';
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      continue;
    }
    if (!message.method && String(message.id) === 'ubuddy-tool-call') {
      pendingTool = false;
      const resultText = message.result?.contentItems?.[0]?.text || '';
      const parsed = JSON.parse(resultText || '{}');
      const answer = parsed.taskRunId ? 'UBUDDY_DYNAMIC_DISPATCH_OK'
        : parsed.delegationId ? 'UBUDDY_EXTERNAL_DISPATCH_OK'
          : 'UBUDDY_DYNAMIC_DISPATCH_FAILED:' + resultText;
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      continue;
    }
    if (!message.method || message.id == null) continue;
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'ubuddy-primary-smoke' } });
    else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'ubuddy-primary-thread' } } });
    else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
    else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn-1' } } });
      const text = message.params?.input?.[0]?.text || '';
      if (text.includes('DYNAMIC_CONFIRM_TASK') && text.includes('<janus_ubuddy_chat>')) {
        pendingTool = true;
        send({ id: 'ubuddy-confirm-initial', method: 'item/tool/call', params: {
          threadId: 'ubuddy-primary-thread', turnId: 'turn-1', callId: 'confirm-initial-call', namespace: 'janus', tool: 'prepare_external_dispatch',
          arguments: { recipientUserIds: ['dynamic_friend'], objective: '公开发布 DYNAMIC_CONFIRM_TASK', deliverables: ['private reply'], mode: 'single_delegation' },
        } });
      } else if (text.includes('DYNAMIC_EXTERNAL_TASK') && text.includes('<janus_ubuddy_chat>')) {
        pendingTool = true;
        send({ id: 'ubuddy-tool-call', method: 'item/tool/call', params: {
          threadId: 'ubuddy-primary-thread', turnId: 'turn-1', callId: 'external-task-call', namespace: 'janus', tool: 'prepare_external_dispatch',
          arguments: { recipientUserIds: ['dynamic_friend'], objective: 'DYNAMIC_EXTERNAL_TASK', deliverables: ['private reply'], mode: 'single_delegation' },
        } });
      } else if ((text.includes('DYNAMIC_LOCAL_TASK') || text.includes('DYNAMIC_PLAN_TASK')) && text.includes('<janus_ubuddy_chat>')) {
        pendingTool = true;
        send({ id: 'ubuddy-tool-call', method: 'item/tool/call', params: {
          threadId: 'ubuddy-primary-thread', turnId: 'turn-1', callId: 'local-task-call', namespace: 'janus', tool: 'dispatch_local_task',
          arguments: { objective: text.includes('DYNAMIC_PLAN_TASK') ? 'DYNAMIC_PLAN_TASK' : 'DYNAMIC_LOCAL_TASK', deliverables: ['inline answer'], preferredAgentIds: ['general_agent'] },
        } });
      } else {
        const answer = text.includes('<janus_ubuddy_chat>') ? 'UBUDDY_CODEX_DIRECT_OK' : 'TASK_NODE_OK';
        send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer } } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: answer }] } } });
      }
    } else send({ id: message.id, result: {} });
  }
  process.exit(0);
}
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
let response = 'TASK_NODE_OK';
if (stdin.includes('【UBUDDY_TASK_INTAKE_DECISION_V2】')) {
  const currentMessage = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  const mentioned = JSON.parse(stdin.match(/Structured users mentioned in this intake:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const taskIntent = /DYNAMIC_LOCAL_TASK|DYNAMIC_EXTERNAL_TASK|DYNAMIC_CONFIRM_TASK/.test(currentMessage);
  response = taskIntent ? JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: true, action: 'dispatch_task', continuation: false,
    intake: {
      version: 'ubuddy_task_intake_v1', state: 'ready', objective: currentMessage,
      deliverables: ['测试结果'], acceptanceCriteria: [], constraints: [], deadline: '',
      candidateUsers: mentioned, requiredUsers: mentioned, attachments: [],
      privacyScope: mentioned.length ? 'direct_delegation' : 'owner_private', riskLevel: 'low', missingFields: [],
      clarification: { reasonCode: '', question: '', options: [] },
    },
  }) : JSON.stringify({
    version: 'UBUDDY_TASK_INTAKE_DECISION_V2', taskIntent: false, action: 'direct', continuation: false, intake: null,
  });
} else if (stdin.includes('【UBUDDY_TURN_DECISION_V2】')) {
  const candidates = JSON.parse(stdin.match(/Active employee candidates:\\n(\\[[^\\n]+\\])/)?.[1] || '[]');
  const general = candidates.find((item) => item.agentId === 'general_agent');
  const currentMessage = stdin.split('Current owner message:\\n').at(-1)?.split('\\n\\nSchema:')[0] || '';
  response = currentMessage.includes('DYNAMIC_LOCAL_TASK')
    ? JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'task_plan', confidence: 0.96,
      nodes: [{ localId: 'final', title: 'Dynamic local task', objective: 'Complete DYNAMIC_LOCAL_TASK', agentId: 'general_agent', agentInstanceId: general?.agentInstanceId, dependencies: [], outputFormat: 'inline answer', isFinal: true, blocking: true, fallback: 'Report blocker.' }],
      deliverables: [{ id: 'primary', role: 'primary', type: 'answer', title: 'Answer', ownerLocalId: 'final', deliveryMode: 'inline', requiredExtensions: [], constraints: {} }],
      agentSelectionRationale: 'The explicitly requested Generalist is active.', mentionedAgentsNotSelected: [],
    })
    : JSON.stringify({
      version: 'UBUDDY_TURN_DECISION_V2', decision: 'direct_answer', confidence: 0.96,
      answer: '', routingRationale: 'The full Codex uBuddy can complete this bounded request directly.',
      nodes: [], deliverables: [], mentionedAgentsNotSelected: [],
    });
}
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], response, 'utf8');
if (args.includes('--json')) {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'planner-thread' }));
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
  runtime.db.prepare(`INSERT INTO auth_users (id,email,display_name,username,email_verified)
    VALUES ('dynamic_friend','dynamic-friend@example.com','Dynamic Friend','dynamic_friend',1)`).run();
  const [friendUserA, friendUserB] = [runtime.currentUser().id, 'dynamic_friend'].sort();
  runtime.db.prepare(`INSERT INTO friendships (id,user_a_id,user_b_id,status)
    VALUES ('dynamic_friendship',?,?,'accepted')`).run(friendUserA, friendUserB);
  const session = runtime.ensureSecretarySession();
  const noProject = await runtime.secretaryChat({
    sessionId: session.id,
    message: '没有项目时也请直接回答这个普通问题。',
    sandboxPermission: 'request-approval',
  });
  assert.equal(noProject.uBuddyMode, 'direct');
  assert.equal(noProject.answer, 'UBUDDY_CODEX_DIRECT_OK');
  assert.deepEqual(noProject.artifacts, []);

  const project = runtime.createProject({ title: 'uBuddy Codex primary', workspaceRoot: projectRoot });
  const before = runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length;
  const direct = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    message: '直接回答这个普通问题。', sandboxPermission: 'request-approval',
  });
  assert.equal(direct.uBuddyMode, 'direct');
  assert.equal(direct.answer, 'UBUDDY_CODEX_DIRECT_OK');
  assert.equal(direct.message.metadata.uBuddyCodexPrimary, true);
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length, before);
  assert.ok(direct.session.codexThreadId);

  const directFileTask = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    message: '写一篇关于人形机器人的目前与未来发展分析书，以 md 格式交付。', sandboxPermission: 'request-approval',
  });
  assert.equal(directFileTask.uBuddyMode, 'direct');
  assert.equal(directFileTask.answer, 'UBUDDY_CODEX_DIRECT_OK');
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length, before);

  const planRejected = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    interactionMode: 'plan', message: '请规划但不要执行 DYNAMIC_PLAN_TASK。', sandboxPermission: 'request-approval',
  });
  assert.match(planRejected.answer, /plan_mode_read_only/);
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length, before);

  const dispatched = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    message: '请让通用 Agent 执行 DYNAMIC_LOCAL_TASK。', sandboxPermission: 'request-approval',
  });
  assert.match(dispatched.answer, /任务图已完成/);
  assert.ok(dispatched.taskRunId);
  assert.equal(dispatched.message.metadata.taskRunId, dispatched.taskRunId);
  assert.equal(runtime.store.listTaskRuns({ userId: runtime.currentUser().id, limit: 100 }).length, before + 1);

  const messagesBeforeExternal = runtime.store.listMessages(session.id).length;
  const external = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    message: '@Dynamic Friend 请处理 DYNAMIC_EXTERNAL_TASK。',
    mentions: [{ principalType: 'user', userId: 'dynamic_friend', displayText: '@Dynamic Friend', mentionId: 'dynamic-friend-mention', source: 'picker' }],
    mentionSelectionVersion: 'ubuddy_mention_selection_v1', sandboxPermission: 'request-approval',
  });
  assert.match(external.answer, /一对一委托已发布/);
  assert.equal(external.dispatchType, 'external_delegation');
  assert.equal(external.uBuddyMode, 'dispatched');
  assert.equal(runtime.store.listMessages(session.id).length, messagesBeforeExternal + 2);

  const messagesBeforeConfirmed = runtime.store.listMessages(session.id).length;
  const confirmed = await runtime.secretaryChat({
    sessionId: session.id, projectId: project.id, workspaceRoot: project.workspaceRoot,
    message: '@Dynamic Friend 请公开发布 DYNAMIC_CONFIRM_TASK。',
    mentions: [{ principalType: 'user', userId: 'dynamic_friend', displayText: '@Dynamic Friend', mentionId: 'dynamic-friend-confirm-mention', source: 'picker' }],
    mentionSelectionVersion: 'ubuddy_mention_selection_v1', sandboxPermission: 'request-approval',
    onEvent(event) {
      if (event.kind !== 'user-input-request') return;
      queueMicrotask(() => runtime.resolveChatUserInput({
        runId: event.runId,
        requestId: event.requestId,
        answers: { confirm: { answers: ['确认'] } },
      }));
    },
  });
  assert.match(confirmed.answer, /已发送|已创建|已发布|等待确认|方案/);
  assert.equal(runtime.store.listMessages(session.id).length, messagesBeforeConfirmed + 2);
  console.log('uBuddy Codex primary smoke passed');
} finally {
  await runtime?.close?.();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1;
  else process.env.JANUS_UBUDDY_CODEX_PRIMARY_V1 = previousFlag;
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
}
