import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCodexExec, runCodexSession } from '../src/main/codex.js';
import { saveCodexConfig } from '../src/main/codexConfig.js';
import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ephemeral-app-server-'));
const fakeCodex = path.join(root, 'fake-codex.mjs');
const fakeCodexCmd = path.join(root, 'fake-codex.cmd');
const requestLog = path.join(root, 'requests.log');
const exitMarker = path.join(root, 'app-server-closed.marker');
const strictImagePath = path.join(root, 'strict.png');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_EPHEMERAL_REQUEST_LOG;
const previousExitMarker = process.env.JANUS_EPHEMERAL_EXIT_MARKER;
const previousStallImage = process.env.JANUS_EPHEMERAL_STALL_IMAGE;
const previousImageTimeout = process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS;
const previousFailTurn = process.env.JANUS_EPHEMERAL_FAIL_TURN;
const previousLongProtocol = process.env.JANUS_EPHEMERAL_LONG_PROTOCOL;
const previousApproval = process.env.JANUS_EPHEMERAL_APPROVAL;
const previousPlan = process.env.JANUS_EPHEMERAL_PLAN;
const previousSteerTurn = process.env.JANUS_EPHEMERAL_STEER_TURN;
const previousInterruptTurn = process.env.JANUS_EPHEMERAL_INTERRUPT_TURN;
const previousStallTurn = process.env.JANUS_EPHEMERAL_STALL_TURN;
const previousDelayTurn = process.env.JANUS_EPHEMERAL_DELAY_TURN_MS;
const previousFirstResponseTimeout = process.env.JANUS_CODEX_FIRST_RESPONSE_TIMEOUT_MS;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === 'app-server' && args.includes('--help')) {
  console.log('Usage: codex app-server [OPTIONS]\\n\\nOptions:\\n  --listen <URL>');
  process.exit(0);
}
if (args[0] !== 'app-server') {
  if (process.env.JANUS_EPHEMERAL_FAIL_TURN === '1') {
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'failed-reasoning', type: 'reasoning', text: '被动中断前已经完成分析。' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { id: 'failed-command', type: 'command_execution', command: 'node failing-check.mjs', cwd: '/home/private/Janus-main', aggregated_output: 'partial output\\n', exit_code: 1, duration_ms: 25, status: 'failed' } }));
  }
  process.exit(2);
}

const logPath = process.env.JANUS_EPHEMERAL_REQUEST_LOG;
const exitMarker = process.env.JANUS_EPHEMERAL_EXIT_MARKER;
const goalsPath = process.env.CODEX_HOME + '/goals_1.sqlite';
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
const goalsHandle = fs.openSync(goalsPath, 'a+');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const finishApprovalTurn = () => {
  send({ method: 'serverRequest/resolved', params: { requestId: 'approval-request-1', decision: 'accept' } });
  send({ method: 'item/completed', params: { item: { id: 'approval-answer', type: 'agentMessage', phase: 'final_answer', text: 'APPROVAL_OK' } } });
  send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', items: [{ id: 'approval-answer', type: 'agentMessage', phase: 'final_answer', text: 'APPROVAL_OK' }] } } });
};
const finishPlanTurn = () => {
  const completedPlan = '# Native plan\\n\\n1. Inspect the current behavior.\\n2. Implement the fix.\\n3. Verify the result.';
  send({ method: 'item/started', params: { item: { id: 'native-plan', type: 'plan', text: '' } } });
  send({ method: 'item/plan/delta', params: { itemId: 'native-plan', delta: '# Draft plan' } });
  send({ method: 'item/completed', params: { item: { id: 'native-plan', type: 'plan', text: completedPlan } } });
  send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', items: [{ id: 'native-plan', type: 'plan', text: completedPlan }] } } });
};
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (!message.method && String(message.id || '') === 'approval-request-1') {
    finishApprovalTurn();
    continue;
  }
  if (!message.method && String(message.id || '') === 'plan-input-1') {
    finishPlanTurn();
    continue;
  }
  if (!message.method || message.id == null) continue;
  fs.appendFileSync(logPath, message.method + '\\n');
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-ephemeral-test' } });
  } else if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: message.params?.ephemeral === true ? 'ephemeral-thread-test' : 'session-thread-test' } } });
  } else if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params?.threadId || 'session-thread-test' } } });
  } else if (message.method === 'thread/memoryMode/set' || message.method.startsWith('thread/goal/')) {
    if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else send({ id: message.id, result: {} });
  } else if (message.method === 'turn/steer') {
    if (message.params?.threadId !== 'ephemeral-thread-test' || message.params?.expectedTurnId !== 'turn-test'
      || message.params?.input?.[0]?.text !== 'Use the guided answer.' || !message.params?.clientUserMessageId) {
      send({ id: message.id, error: { code: -32602, message: 'invalid turn/steer params' } });
      continue;
    }
    send({ id: message.id, result: { turnId: 'turn-test' } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', items: [{ id: 'steered-answer', type: 'agentMessage', phase: 'final_answer', text: 'STEERED_PROTOCOL_OK' }] } } });
  } else if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'interrupted', items: [] } } });
  } else if (message.method === 'turn/start') {
    if (message.params?.summary !== 'auto') {
      send({ id: message.id, error: { code: -32602, message: 'reasoning summary must use auto' } });
      continue;
    }
    send({ id: message.id, result: { turn: { id: 'turn-test' } } });
    if (process.env.JANUS_EPHEMERAL_STEER_TURN === '1' || process.env.JANUS_EPHEMERAL_INTERRUPT_TURN === '1') continue;
    if (process.env.JANUS_EPHEMERAL_STALL_TURN === '1') continue;
    const delayedTurnMs = Math.max(0, Number(process.env.JANUS_EPHEMERAL_DELAY_TURN_MS || 0));
    if (delayedTurnMs) await new Promise((resolve) => setTimeout(resolve, delayedTurnMs));
    if (process.env.JANUS_EPHEMERAL_APPROVAL === '1') {
      send({ id: 'approval-request-1', method: 'item/fileChange/requestApproval', params: {
        threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'approval-file', reason: 'Update the document',
        changes: [{ path: '/home/private/Janus-main/docs/approval.docx', kind: 'update', diff: 'Binary files a/docs/approval.docx and b/docs/approval.docx differ' }],
      } });
      continue;
    }
    if (process.env.JANUS_EPHEMERAL_FAIL_TURN === '1') {
      send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'failed-reasoning', summaryIndex: 0, delta: '被动中断前已经完成分析。' } });
      send({ method: 'item/started', params: { item: { id: 'failed-command', type: 'commandExecution', command: 'node failing-check.mjs', cwd: '/home/private/Janus-main', status: 'inProgress' } } });
      send({ method: 'item/completed', params: { item: { id: 'failed-command', type: 'commandExecution', command: 'node failing-check.mjs', cwd: '/home/private/Janus-main', aggregatedOutput: 'partial output\\n', exitCode: 1, durationMs: 25, status: 'failed' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'failed', error: { message: 'intentional passive interruption' }, items: [] } } });
      continue;
    }
    if (process.env.JANUS_EPHEMERAL_STALL_IMAGE === '1') {
      send({ method: 'item/started', params: { item: { id: 'image-test', type: 'imageGeneration' } } });
      continue;
    }
    if (process.env.JANUS_EPHEMERAL_LONG_PROTOCOL === '1') {
      const reasoningParts = [];
      send({ method: 'item/started', params: { item: { id: 'long-reasoning', type: 'reasoning', status: 'inProgress' } } });
      for (let index = 0; index < 205; index += 1) {
        const delta = 'native-detail-' + index + '\\n';
        reasoningParts.push(delta);
        send({ method: 'item/reasoning/textDelta', params: { itemId: 'long-reasoning', contentIndex: 0, delta } });
      }
      send({ method: 'item/completed', params: { item: { id: 'long-reasoning', type: 'reasoning', status: 'completed', content: [reasoningParts.join('')] } } });
      send({ method: 'item/completed', params: { item: { id: 'long-answer', type: 'agentMessage', phase: 'final_answer', text: 'LONG_PROTOCOL_OK' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', items: [{ id: 'long-answer', type: 'agentMessage', phase: 'final_answer', text: 'LONG_PROTOCOL_OK' }] } } });
      continue;
    }
    if (process.env.JANUS_EPHEMERAL_PLAN === '1') {
      send({ id: 'plan-input-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'session-thread-test', turnId: 'turn-test', itemId: 'plan-direction',
        questions: [{
          id: 'direction', header: 'Direction', question: 'Which direction should the plan use?', isOther: true,
          options: [
            { label: 'Focused fix', description: 'Keep the change narrow.' },
            { label: 'Broader redesign', description: 'Refactor the surrounding flow.' },
          ],
        }],
      } });
      continue;
    }
    send({ emittedAtMs: 1000, method: 'item/reasoning/summaryPartAdded', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'reasoning-test', summaryIndex: 0 } });
    send({ emittedAtMs: 1001, method: 'item/reasoning/summaryTextDelta', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'reasoning-test', summaryIndex: 0, delta: '检查临时执行环境。' } });
    send({ emittedAtMs: 1001.5, method: 'item/reasoning/summaryPartAdded', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'reasoning-test', summaryIndex: 1 } });
    send({ emittedAtMs: 1001.6, method: 'item/reasoning/summaryTextDelta', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'reasoning-test', summaryIndex: 1, delta: '核对原生事件边界。' } });
    send({ emittedAtMs: 1002, method: 'item/reasoning/textDelta', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'reasoning-test', contentIndex: 0, delta: '逐项核对 Codex 原生协议。' } });
    send({ method: 'item/completed', params: { item: { id: 'reasoning-test', type: 'reasoning', summary: ['检查临时执行环境。', '核对原生事件边界。'], content: ['逐项核对 Codex 原生协议。'] } } });
    send({ method: 'item/started', params: { item: { id: 'commentary-test', type: 'agentMessage', phase: 'commentary', text: '' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'commentary-test', delta: '正在运行验证命令。' } });
    send({ method: 'item/completed', params: { item: { id: 'commentary-test', type: 'agentMessage', phase: 'commentary', text: '正在运行验证命令。' } } });
    send({ method: 'item/started', params: { startedAtMs: 1000, item: { id: 'command-test', type: 'commandExecution', command: 'rg -n app-server src', cwd: '/home/private/Janus-main', status: 'inProgress' } } });
    send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command-test', delta: 'TOKEN=' } });
    send({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command-test', delta: 'private-value\\nsrc/main/codex.js\\n' } });
    send({ method: 'item/completed', params: { completedAtMs: 1125, item: { id: 'command-test', type: 'commandExecution', command: 'rg -n app-server src', cwd: '/home/private/Janus-main', processId: 'pty-test', source: 'agent', commandActions: [{ type: 'search', command: 'rg -n app-server src', query: 'app-server', path: 'src' }], aggregatedOutput: 'TOKEN=private-value\\nsrc/main/codex.js\\n', exitCode: 0, durationMs: 125, status: 'completed' } } });
    send({ method: 'item/fileChange/patchUpdated', params: { itemId: 'file-test', changes: [{ path: '/home/private/Janus-main/src/demo.js', kind: 'update', diff: '@@ -1 +1 @@\\n-old\\n+new' }] } });
    send({ method: 'item/completed', params: { item: { id: 'file-test', type: 'fileChange', status: 'completed', changes: [{ path: '/home/private/Janus-main/src/demo.js', kind: 'update', diff: '@@ -1 +1 @@\\n-old\\n+new' }] } } });
    const strictImage = path.join(process.cwd(), 'strict.png');
    if (fs.existsSync(strictImage)) {
      const image = Buffer.alloc(64, 0x44);
      Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(image, 0);
      image.writeUInt32BE(13, 8); image.write('IHDR', 12, 'ascii'); image.writeUInt32BE(1280, 16); image.writeUInt32BE(720, 20);
      fs.writeFileSync(strictImage, image);
      const changes = [{ path: strictImage, kind: 'update', diff: 'Binary files a/strict.png and b/strict.png differ' }];
      send({ method: 'item/fileChange/patchUpdated', params: { itemId: 'strict-image-test', changes } });
      send({ method: 'item/completed', params: { item: { id: 'strict-image-test', type: 'fileChange', status: 'completed', changes } } });
    }
    send({ method: 'item/started', params: { item: { id: 'tool-test', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'inProgress', arguments: { query: 'Codex details' } } } });
    send({ method: 'item/completed', params: { item: { id: 'tool-test', type: 'mcpToolCall', server: 'docs', tool: 'search', status: 'completed', arguments: { query: 'Codex details' }, result: { content: [{ type: 'text', text: 'native transcript' }], structuredContent: { hits: 1 }, _meta: { fixture: true } }, durationMs: 80 } } });
    send({ method: 'item/completed', params: { item: { id: 'agent-test', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'ephemeral-thread-test', receiverThreadIds: ['child-thread'], prompt: '核对 UI 细节', model: 'fake-model', reasoningEffort: 'high', agentsStates: { 'child-thread': { status: 'completed', message: '完成' } } } } });
    send({ method: 'warning', params: { threadId: 'ephemeral-thread-test', message: 'fixture warning detail' } });
    send({ method: 'rawResponse/completed', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', responseId: 'response-1', usage: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1 } } });
    send({ method: 'rawResponse/completed', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', responseId: 'response-2', usage: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 1, outputTokens: 5, reasoningOutputTokens: 2 } } });
    send({ emittedAtMs: 1100, method: 'thread/tokenUsage/updated', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', tokenUsage: { total: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 5, cacheWriteInputTokens: 2, outputTokens: 8, reasoningOutputTokens: 3 }, last: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1 }, modelContextWindow: 200000 } } });
    send({ method: 'item/started', params: { item: { id: 'answer-test', type: 'agentMessage', phase: 'final_answer' } } });
    send({ emittedAtMs: 1101, method: 'item/agentMessage/delta', params: { threadId: 'ephemeral-thread-test', turnId: 'turn-test', itemId: 'answer-test', delta: 'EPHEMERAL_APP_SERVER_OK' } });
    send({ emittedAtMs: 1102, method: 'item/completed', params: { item: { id: 'answer-test', type: 'agentMessage', phase: 'final_answer', text: 'EPHEMERAL_APP_SERVER_OK', memoryCitation: { source: 'fixture-memory' } } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-test', status: 'completed', items: [{ id: 'answer-test', type: 'agentMessage', phase: 'final_answer', text: 'EPHEMERAL_APP_SERVER_OK' }] } } });
  } else {
    send({ id: message.id, error: { code: -32601, message: 'unsupported test method: ' + message.method } });
  }
}
await new Promise((resolve) => setTimeout(resolve, 150));
fs.closeSync(goalsHandle);
fs.writeFileSync(exitMarker, 'closed', 'utf8');
`);
chmodSync(fakeCodex, 0o755);
const initialStrictImage = Buffer.alloc(64, 0x33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(initialStrictImage, 0);
initialStrictImage.writeUInt32BE(13, 8);
initialStrictImage.write('IHDR', 12, 'ascii');
initialStrictImage.writeUInt32BE(640, 16);
initialStrictImage.writeUInt32BE(360, 20);
await writeFile(strictImagePath, initialStrictImage);
if (process.platform === 'win32') {
  await writeFile(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`);
}

try {
  process.env.JANUS_CODEX_BIN = process.platform === 'win32' ? fakeCodexCmd : fakeCodex;
  process.env.JANUS_EPHEMERAL_REQUEST_LOG = requestLog;
  process.env.JANUS_EPHEMERAL_EXIT_MARKER = exitMarker;
  saveCodexConfig(root, { baseUrl: 'https://provider.invalid/v1', apiKey: 'fake-key' });

  const processEvents = [];
  const answer = await runCodexExec({
    root,
    cwd: root,
    prompt: 'Verify ephemeral app-server execution.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
    onEvent: (event) => processEvents.push(event),
  });

  assert.equal(answer, 'EPHEMERAL_APP_SERVER_OK');
  assert.ok(processEvents.some((event) => event.activityType === 'model' && event.title === '正在连接模型服务'));
  const reasoningEvent = processEvents.findLast((event) => event.activityId === 'reasoning-test');
  assert.match(reasoningEvent.detail, /临时执行环境/);
  assert.deepEqual(reasoningEvent.summaryParts, [
    { index: 0, text: '检查临时执行环境。' },
    { index: 1, text: '核对原生事件边界。' },
  ]);
  assert.match(reasoningEvent.reasoningText, /原生协议/);
  assert.equal(reasoningEvent.nativeSource, 'codex_app_server');
  assert.ok(processEvents.some((event) => event.protocolEvents?.some((nativeEvent) => nativeEvent.method === 'item/reasoning/textDelta')));
  assert.ok(processEvents.some((event) => event.protocolEvents?.some((nativeEvent) => nativeEvent.method === 'item/reasoning/summaryPartAdded')));
  const nativeReasoningDelta = processEvents.flatMap((event) => event.protocolEvents || [])
    .find((event) => event.method === 'item/reasoning/textDelta');
  assert.equal(nativeReasoningDelta.emittedAtMs, 1002);
  assert.equal(nativeReasoningDelta.envelope.method, 'item/reasoning/textDelta');
  assert.equal(nativeReasoningDelta.envelope.params.delta, '逐项核对 Codex 原生协议。');
  assert.ok(nativeReasoningDelta.protocolEventId);
  assert.ok(processEvents.some((event) => event.protocolEvents?.some((nativeEvent) => (
    nativeEvent.method === 'rpc/response' && nativeEvent.envelope?.result?.turn?.id === 'turn-test'
  ))), 'Codex JSON-RPC responses must remain available in the raw protocol timeline');
  assert.ok(processEvents.some((event) => event.activityType === 'commentary' && event.detail.includes('验证命令')));
  const commandEvent = processEvents.findLast((event) => event.activityId === 'command-test');
  assert.equal(commandEvent.status, 'completed');
  assert.equal(commandEvent.command, 'rg -n app-server src');
  assert.equal(commandEvent.cwd, '/home/private/Janus-main');
  assert.match(commandEvent.output, /TOKEN=private-value/);
  assert.match(commandEvent.output, /src\/main\/codex\.js/);
  assert.equal(commandEvent.exitCode, 0);
  assert.equal(commandEvent.durationMs, 125);
  assert.equal(commandEvent.processId, 'pty-test');
  assert.equal(commandEvent.commandActions[0].type, 'search');
  const fileEvent = processEvents.findLast((event) => event.activityId === 'file-test');
  assert.match(fileEvent.diff, /\+new/);
  assert.match(fileEvent.changes[0].path, /src\/demo\.js$/);
  assert.equal(fileEvent.workspaceRoot, root);
  const strictImageEvent = processEvents.findLast((event) => event.activityId === 'strict-image-test');
  assert.equal(strictImageEvent?.changes?.[0]?.comparison?.strict, true);
  assert.equal(strictImageEvent.changes[0].relativePath, 'strict.png');
  assert.equal(strictImageEvent.changes[0].comparison.semantic.beforeMetrics.width, 640);
  assert.equal(strictImageEvent.changes[0].comparison.semantic.afterMetrics.width, 1280);
  assert.ok(existsSync(strictImageEvent.changes[0].comparison.before.snapshot.path));
  const toolEvent = processEvents.findLast((event) => event.activityId === 'tool-test');
  assert.deepEqual(toolEvent.arguments, { query: 'Codex details' });
  assert.equal(toolEvent.result.structuredContent.hits, 1);
  const agentEvent = processEvents.findLast((event) => event.activityId === 'agent-test');
  assert.equal(agentEvent.prompt, '核对 UI 细节');
  assert.deepEqual(agentEvent.receiverThreadIds, ['child-thread']);
  assert.ok(processEvents.some((event) => event.activityType === 'warning' && /fixture warning/.test(event.detail)));
  const usageEvent = processEvents.findLast((event) => event.activityType === 'usage');
  assert.equal(usageEvent.usage.totalTokens, 25);
  assert.equal(usageEvent.usage.cacheWriteInputTokens, 2);
  assert.equal(usageEvent.usage.reasoningOutputTokens, 3);
  assert.equal(usageEvent.usage.modelContextWindow, 200000);
  assert.equal(usageEvent.usage.last.totalTokens, 10);
  assert.equal(usageEvent.usage.contextInputTokens, 7);
  assert.equal(usageEvent.usage.contextMeasurementState, 'available');
  const answerEvent = processEvents.findLast((event) => event.activityId === 'answer-test');
  assert.equal(answerEvent.activityType, 'answer');
  assert.equal(answerEvent.responseText, 'EPHEMERAL_APP_SERVER_OK');
  assert.deepEqual(answerEvent.memoryCitation, { source: 'fixture-memory' });
  assert.ok(processEvents.some((event) => event.activityId === 'answer-test'
    && event.protocolEvents?.some((nativeEvent) => nativeEvent.method === 'item/agentMessage/delta')));
  assert.equal(readFileSync(exitMarker, 'utf8'), 'closed', 'runCodexExec must wait for app-server close before returning');
  const codexTempRoot = path.join(root, '.janus', 'tmp', 'codex');
  assert.equal(existsSync(codexTempRoot) ? readdirSync(codexTempRoot).length : 0, 0, 'temporary Codex homes must be removed after process close');

  process.env.JANUS_EPHEMERAL_APPROVAL = '1';
  const approvalEvents = [];
  const approvalAnswer = await runCodexExec({
    root,
    cwd: root,
    prompt: 'Verify native file approval events.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'request-approval',
    timeoutMs: 5_000,
    onApproval: async (request) => request.type === 'item/fileChange/requestApproval',
    onEvent: (event) => approvalEvents.push(event),
  });
  delete process.env.JANUS_EPHEMERAL_APPROVAL;
  assert.equal(approvalAnswer, 'APPROVAL_OK');
  const waitingApproval = approvalEvents.find((event) => event.activityType === 'approval' && event.status === 'waiting');
  const resolvedApproval = approvalEvents.findLast((event) => event.activityId === 'request-approval-request-1' && event.status === 'completed');
  assert.equal(waitingApproval?.activityId, 'request-approval-request-1');
  assert.equal(waitingApproval?.approvalType, 'file');
  assert.match(waitingApproval?.changes?.[0]?.path || '', /docs\/approval\.docx$/);
  assert.equal(waitingApproval?.workspaceRoot, root);
  assert.equal(waitingApproval?.nativeSource, 'codex_app_server');
  assert.equal(resolvedApproval?.decision, 'accept');

  const fullAccessSession = await runCodexSession({
    root,
    cwd: root,
    sessionId: 'full-access-session',
    prompt: 'Verify full-access dialogue app-server execution.',
    permissionMode: 'full-access',
    timeoutMs: 5_000,
  });
  assert.equal(fullAccessSession.answer, 'EPHEMERAL_APP_SERVER_OK');
  assert.equal(fullAccessSession.usageEvents.length, 1);
  assert.equal(fullAccessSession.usageEvents[0].usageKind, 'turn');
  assert.equal(fullAccessSession.usageEvents[0].usage.totalTokens, 25, 'all upstream Responses API completions in one Codex turn must be summed');
  assert.equal(fullAccessSession.usageEvents[0].usage.inputTokens, 17);
  assert.equal(fullAccessSession.usageEvents[0].usage.outputTokens, 8);
  assert.equal(fullAccessSession.usageEvents[0].usage.reasoningOutputTokens, 3);
  assert.equal(fullAccessSession.usageEvents[0].cursorUsage.totalTokens, 25);
  assert.equal(fullAccessSession.threadId, 'session-thread-test');
  assert.equal(fullAccessSession.usageEvents[0].turnId, 'turn-test');
  assert.equal(fullAccessSession.usageEvents[0].cursorUsage.last.totalTokens, 10,
    'thread usage must remain available separately for context-window measurement');
  process.env.JANUS_EPHEMERAL_PLAN = '1';
  const planEvents = [];
  const planInputRequests = [];
  const planSession = await runCodexSession({
    root,
    cwd: root,
    sessionId: 'native-plan-session',
    prompt: 'Create a plan without implementing it.',
    interactionMode: 'plan',
    permissionMode: 'request-approval',
    timeoutMs: 5_000,
    onEvent: (event) => planEvents.push(event),
    onUserInput: async (request) => {
      planInputRequests.push(request);
      return { answers: { direction: { answers: ['Focused fix'] } } };
    },
  });
  delete process.env.JANUS_EPHEMERAL_PLAN;
  assert.match(planSession.answer, /^# Native plan/);
  assert.equal(planSession.plan.content, planSession.answer, 'completed plan item text must become the final Plan answer');
  assert.deepEqual(planSession.plan.steps, [], 'completed Plan items must still produce a plan result without turn/plan/updated');
  assert.ok(planEvents.some((event) => event.kind === 'answer' && event.content === planSession.answer));
  assert.equal(planInputRequests.length, 1);
  assert.deepEqual(planInputRequests[0].questions[0].options, [
    { label: 'Focused fix', description: 'Keep the change narrow.' },
    { label: 'Broader redesign', description: 'Refactor the surrounding flow.' },
  ], 'Plan request_user_input options must reach the host unchanged');

  process.env.JANUS_EPHEMERAL_STEER_TURN = '1';
  let resolveSteerControl;
  const steerControlReady = new Promise((resolve) => { resolveSteerControl = resolve; });
  const steeredRun = runCodexExec({
    root,
    cwd: root,
    prompt: 'Hold this turn until it receives guidance.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
    onTurnControlReady: (control) => { if (control) resolveSteerControl(control); },
  });
  const steerControl = await steerControlReady;
  assert.equal(steerControl.threadId, 'ephemeral-thread-test');
  assert.equal(steerControl.turnId, 'turn-test');
  await steerControl.steer({ text: 'Use the guided answer.', clientUserMessageId: 'followup-message-steer-test' });
  assert.equal(await steeredRun, 'STEERED_PROTOCOL_OK');
  delete process.env.JANUS_EPHEMERAL_STEER_TURN;

  process.env.JANUS_EPHEMERAL_INTERRUPT_TURN = '1';
  let resolveInterruptControl;
  const interruptControlReady = new Promise((resolve) => { resolveInterruptControl = resolve; });
  const interruptedRun = runCodexExec({
    root,
    cwd: root,
    prompt: 'Hold this turn until it is interrupted.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
    onTurnControlReady: (control) => { if (control) resolveInterruptControl(control); },
  });
  const interruptControl = await interruptControlReady;
  await interruptControl.interrupt();
  await assert.rejects(interruptedRun, (error) => error?.code === 'codex_turn_interrupted');
  delete process.env.JANUS_EPHEMERAL_INTERRUPT_TURN;

  const methods = readFileSync(requestLog, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(methods, [
    'initialize', 'thread/start', 'turn/start',
    'initialize', 'thread/start', 'turn/start',
    'initialize', 'thread/start', 'thread/memoryMode/set', 'thread/goal/get', 'turn/start',
    'initialize', 'thread/start', 'thread/memoryMode/set', 'thread/goal/get', 'turn/start',
    'initialize', 'thread/start', 'turn/start', 'turn/steer',
    'initialize', 'thread/start', 'turn/start', 'turn/interrupt',
  ], 'full-access dialogue sessions must use the non-ephemeral app-server path');

  const runtimeRoot = path.join(root, 'runtime-failure');
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  try {
    saveCodexConfig(runtimeRoot, { baseUrl: 'https://provider.invalid/v1', apiKey: 'fake-key' });
    const failedSession = runtime.ensurePrivateAssistantSession();
    const skippedPlanSession = runtime.store.createSession({
      title: 'Skipped plan input',
      departmentId: 'general',
      userId: failedSession.userId,
      interactionMode: 'plan',
    });
    process.env.JANUS_EPHEMERAL_PLAN = '1';
    const skippedPlanResult = await runtime.sendChat({
      channelId: 'runtime-plan-skip',
      sessionId: skippedPlanSession.id,
      departmentId: 'general',
      interactionMode: 'plan',
      message: 'Create a three-day travel plan after allowing the user to skip the clarification.',
      sandboxPermission: 'request-approval',
      onEvent: (event) => {
        if (event.kind !== 'user-input-request') return;
        const resolved = runtime.resolveChatUserInput({
          channelId: 'runtime-plan-skip',
          runId: event.runId,
          requestId: event.requestId,
          answers: { direction: { answers: [] } },
          skippedQuestionIds: ['direction'],
        });
        assert.equal(resolved.ok, true);
        assert.deepEqual(resolved.answers, { direction: { answers: [] } });
        assert.deepEqual(resolved.skippedQuestionIds, ['direction']);
      },
    });
    delete process.env.JANUS_EPHEMERAL_PLAN;
    assert.match(skippedPlanResult.answer, /^# Native plan/,
      'skipping a plan clarification must allow the Codex turn to continue with an empty answer');
    assert.equal(skippedPlanResult.message.metadata?.plan?.executable, false,
      'an informational plan must not request execution');
    process.env.JANUS_EPHEMERAL_PLAN = '1';
    const executablePlanResult = await runtime.sendChat({
      channelId: 'runtime-executable-plan',
      sessionId: skippedPlanSession.id,
      departmentId: 'general',
      interactionMode: 'plan',
      message: 'Plan a code fix and repository validation.',
      sandboxPermission: 'request-approval',
      onEvent: (event) => {
        if (event.kind !== 'user-input-request') return;
        runtime.resolveChatUserInput({
          channelId: 'runtime-executable-plan',
          runId: event.runId,
          requestId: event.requestId,
          answers: { direction: { answers: ['Focused fix'] } },
        });
      },
    });
    delete process.env.JANUS_EPHEMERAL_PLAN;
    assert.equal(executablePlanResult.message.metadata?.plan?.executable, true,
      'a code-change plan must expose the execution confirmation flow');
    assert.equal(executablePlanResult.message.metadata?.plan?.taskType, 'code_change');
    process.env.JANUS_EPHEMERAL_LONG_PROTOCOL = '1';
    const longResult = await runtime.sendChat({
      sessionId: failedSession.id,
      chatMode: 'private_assistant',
      message: 'Persist more than 200 raw protocol events.',
      sandboxPermission: 'auto-approve',
    });
    delete process.env.JANUS_EPHEMERAL_LONG_PROTOCOL;
    assert.equal(longResult.answer, 'LONG_PROTOCOL_OK');
    const persistedLongRun = runtime.store.listMessages(failedSession.id)
      .findLast((message) => message.role === 'assistant' && message.metadata?.processEvents
        ?.some((event) => event.activityId === 'long-reasoning'));
    const persistedLongReasoning = persistedLongRun?.metadata?.processEvents
      ?.find((event) => event.activityId === 'long-reasoning');
    assert.equal(persistedLongReasoning?.protocolEvents?.length, 207,
      'persisted conversations must retain item start, every delta, and item completion beyond 200 events');
    assert.equal(persistedLongReasoning.protocolEvents[0].method, 'item/started');
    assert.equal(persistedLongReasoning.protocolEvents.at(-1).method, 'item/completed');
    assert.match(persistedLongReasoning.reasoningText, /native-detail-0/);
    assert.match(persistedLongReasoning.reasoningText, /native-detail-204/);
    process.env.JANUS_EPHEMERAL_FAIL_TURN = '1';
    await assert.rejects(() => runtime.sendChat({
      sessionId: failedSession.id,
      chatMode: 'private_assistant',
      message: 'Trigger a passive process interruption.',
      sandboxPermission: 'auto-approve',
    }), /intentional passive interruption/);
    delete process.env.JANUS_EPHEMERAL_FAIL_TURN;
    const persistedFailure = runtime.store.listMessages(failedSession.id)
      .find((message) => message.role === 'assistant' && message.metadata?.failed);
    assert.ok(persistedFailure, 'passive failures must persist an assistant process-history message');
    assert.equal(persistedFailure.content, '');
    assert.equal(persistedFailure.metadata.expanded, true);
    assert.ok(persistedFailure.metadata.processEvents.some((event) => event.activityId === 'failed-reasoning'));
    assert.ok(persistedFailure.metadata.processEvents.some((event) => event.activityId === 'failed-command'));
    assert.equal(persistedFailure.metadata.processEvents.at(-1)?.status, 'failed');
  } finally {
    runtime.close();
    delete process.env.JANUS_EPHEMERAL_FAIL_TURN;
    delete process.env.JANUS_EPHEMERAL_LONG_PROTOCOL;
  }

  process.env.JANUS_EPHEMERAL_STALL_IMAGE = '1';
  process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS = '100';
  await assert.rejects(() => runCodexExec({
    root,
    cwd: root,
    prompt: 'Start an image generation tool that never finishes.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
  }), /图片生成工具超过 1 秒仍未完成/);
  assert.equal(existsSync(codexTempRoot) ? readdirSync(codexTempRoot).length : 0, 0, 'timed out image tools must clean temporary Codex homes');
  delete process.env.JANUS_EPHEMERAL_STALL_IMAGE;
  delete process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS;
  process.env.JANUS_CODEX_FIRST_RESPONSE_TIMEOUT_MS = '100';
  process.env.JANUS_EPHEMERAL_DELAY_TURN_MS = '250';
  const recoveredFirstResponseEvents = [];
  const recoveredFirstResponse = await runCodexExec({
    root,
    cwd: root,
    prompt: 'Return model output after two reconnecting windows.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
    onEvent: (event) => recoveredFirstResponseEvents.push(event),
  });
  assert.equal(recoveredFirstResponse, 'EPHEMERAL_APP_SERVER_OK');
  assert.deepEqual(
    recoveredFirstResponseEvents.filter((event) => event.activityId?.startsWith('model-first-response-waiting-')).map((event) => event.title),
    ['模型服务响应较慢，继续等待（1/5）', '模型服务响应较慢，继续等待（2/5）'],
    'the first model event must cancel the remaining slow-response wait windows',
  );
  delete process.env.JANUS_EPHEMERAL_DELAY_TURN_MS;
  process.env.JANUS_EPHEMERAL_STALL_TURN = '1';
  const firstResponseReconnectEvents = [];
  await assert.rejects(() => runCodexExec({
    root,
    cwd: root,
    prompt: 'Start a model turn that never produces model output.',
    agentId: 'general_agent',
    role: 'task_node',
    permissionMode: 'auto-approve',
    timeoutMs: 5_000,
    onEvent: (event) => firstResponseReconnectEvents.push(event),
  }), /上游模型服务在连续 5 个等待周期内（每次 0\.1 秒，累计约 0\.5 秒）始终未返回任何模型输出/);
  assert.deepEqual(
    firstResponseReconnectEvents.filter((event) => event.activityId?.startsWith('model-first-response-waiting-')).map((event) => event.title),
    ['模型服务响应较慢，继续等待（1/5）', '模型服务响应较慢，继续等待（2/5）', '模型服务响应较慢，继续等待（3/5）', '模型服务响应较慢，继续等待（4/5）'],
    'a silent first response must remain on the same request for four wait windows before the fifth timeout fails',
  );
  assert.equal(existsSync(codexTempRoot) ? readdirSync(codexTempRoot).length : 0, 0, 'first-response timeouts must clean temporary Codex homes');
  console.log('Codex ephemeral app-server smoke passed.');
} finally {
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_EPHEMERAL_REQUEST_LOG;
  else process.env.JANUS_EPHEMERAL_REQUEST_LOG = previousLog;
  if (previousExitMarker === undefined) delete process.env.JANUS_EPHEMERAL_EXIT_MARKER;
  else process.env.JANUS_EPHEMERAL_EXIT_MARKER = previousExitMarker;
  if (previousStallImage === undefined) delete process.env.JANUS_EPHEMERAL_STALL_IMAGE;
  else process.env.JANUS_EPHEMERAL_STALL_IMAGE = previousStallImage;
  if (previousImageTimeout === undefined) delete process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS;
  else process.env.JANUS_CODEX_IMAGE_TOOL_TIMEOUT_MS = previousImageTimeout;
  if (previousFailTurn === undefined) delete process.env.JANUS_EPHEMERAL_FAIL_TURN;
  else process.env.JANUS_EPHEMERAL_FAIL_TURN = previousFailTurn;
  if (previousLongProtocol === undefined) delete process.env.JANUS_EPHEMERAL_LONG_PROTOCOL;
  else process.env.JANUS_EPHEMERAL_LONG_PROTOCOL = previousLongProtocol;
  if (previousApproval === undefined) delete process.env.JANUS_EPHEMERAL_APPROVAL;
  else process.env.JANUS_EPHEMERAL_APPROVAL = previousApproval;
  if (previousPlan === undefined) delete process.env.JANUS_EPHEMERAL_PLAN;
  else process.env.JANUS_EPHEMERAL_PLAN = previousPlan;
  if (previousSteerTurn === undefined) delete process.env.JANUS_EPHEMERAL_STEER_TURN;
  else process.env.JANUS_EPHEMERAL_STEER_TURN = previousSteerTurn;
  if (previousInterruptTurn === undefined) delete process.env.JANUS_EPHEMERAL_INTERRUPT_TURN;
  else process.env.JANUS_EPHEMERAL_INTERRUPT_TURN = previousInterruptTurn;
  if (previousStallTurn === undefined) delete process.env.JANUS_EPHEMERAL_STALL_TURN;
  else process.env.JANUS_EPHEMERAL_STALL_TURN = previousStallTurn;
  if (previousDelayTurn === undefined) delete process.env.JANUS_EPHEMERAL_DELAY_TURN_MS;
  else process.env.JANUS_EPHEMERAL_DELAY_TURN_MS = previousDelayTurn;
  if (previousFirstResponseTimeout === undefined) delete process.env.JANUS_CODEX_FIRST_RESPONSE_TIMEOUT_MS;
  else process.env.JANUS_CODEX_FIRST_RESPONSE_TIMEOUT_MS = previousFirstResponseTimeout;
  await rm(root, { recursive: true, force: true });
}
