import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { buildAgentChatPrompt, buildResumeTurnPrompt } from '../src/main/prompts.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-direct-chat-retry-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-direct-chat-retry-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const counterPath = path.join(binRoot, 'attempts.json');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousRetryBase = process.env.JANUS_DIRECT_CHAT_RETRY_BASE_MS;
const previousAppServerRetryBase = process.env.JANUS_APP_SERVER_TRANSIENT_RETRY_BASE_MS;
const previousCapacityCooldown = process.env.JANUS_MODEL_CAPACITY_COOLDOWN_MS;
let runtime = null;

assert.match(buildAgentChatPrompt({
  agent: { id: 'general_agent', name: '通用 Agent', departmentId: 'general', description: '通用执行' },
  department: { name: '通用', description: '通用任务' },
  userMessage: '你可以干什么',
}), /answer directly without reading AGENTS\.md, inspecting workspace files, or using tools/);
assert.match(buildResumeTurnPrompt('你可以干什么'), /answer directly without reading AGENTS\.md, inspecting workspace files, or using tools/);

await writeFile(counterPath, '{}\n', 'utf8');
await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.144.3'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) {
  console.log('Usage: codex app-server [OPTIONS]\\n  --listen <URL>');
  process.exit(0);
}
const counterPath = process.env.DIRECT_CHAT_RETRY_COUNTER;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let activeFixture = '';
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.id == null || !message.method) continue;
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'direct-chat-retry-smoke' } });
    continue;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'direct-chat-retry-thread' } } });
    continue;
  }
  if (message.method === 'thread/memoryMode/set' || message.method === 'thread/goal/get') {
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
    continue;
  }
  if (message.method !== 'turn/start') {
    send({ id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } });
    continue;
  }
  const prompt = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
  if (prompt.includes('exhausted capacity fixture')) activeFixture = 'exhausted';
  else if (prompt.includes('unsafe completed command fixture')) activeFixture = 'unsafe';
  else if (prompt.includes('transient direct chat retry fixture')) activeFixture = 'safe';
  const key = activeFixture || 'safe';
  const counters = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
  counters[key] = Number(counters[key] || 0) + 1;
  counters[key + '_started_at'] = [...(counters[key + '_started_at'] || []), Date.now()];
  if (counters[key] > 1) counters[key + '_used_continuation_prompt'] = prompt.includes('previous turn was interrupted');
  fs.writeFileSync(counterPath, JSON.stringify(counters));
  const attempt = counters[key];
  send({ id: message.id, result: { turn: { id: key + '-turn-' + attempt } } });
  if (key !== 'exhausted' && attempt >= 2) {
    send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DIRECT_CHAT_RETRY_OK' } } });
    send({ method: 'turn/completed', params: { turn: { id: 'safe-turn-' + attempt, status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'DIRECT_CHAT_RETRY_OK' }] } } });
    continue;
  }
  const command = key === 'unsafe' ? 'touch should-not-retry.txt' : 'Get-Content README.md';
  const exitCode = key === 'unsafe' ? 0 : 1;
  send({ method: 'item/started', params: { item: { id: 'command', type: 'commandExecution', command, status: 'inProgress' } } });
  send({ method: 'item/completed', params: { item: { id: 'command', type: 'commandExecution', command, exitCode, status: exitCode ? 'failed' : 'completed' } } });
  send({ method: 'turn/completed', params: { turn: { id: key + '-turn-' + attempt, status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.' }, items: [] } } });
}
`, 'utf8');
chmodSync(fakeCodex, 0o755);

try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.DIRECT_CHAT_RETRY_COUNTER = counterPath;
  process.env.JANUS_DIRECT_CHAT_RETRY_BASE_MS = '1';
  process.env.JANUS_APP_SERVER_TRANSIENT_RETRY_BASE_MS = '1';
  process.env.JANUS_MODEL_CAPACITY_COOLDOWN_MS = '30';
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const general = runtime.store.requireRoutableUserAgent({ userId: user.id, agentFamilyId: 'general_agent' });

  const recovered = await runtime.sendChat({
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: general.instance.id,
    routePreference: 'explicit',
    chatMode: 'agent',
    message: 'transient direct chat retry fixture',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sandboxPermission: 'request-approval',
  });
  assert.equal(recovered.answer, 'DIRECT_CHAT_RETRY_OK');
  assert.equal(JSON.parse(readFileSync(counterPath, 'utf8')).safe, 2);
  const safeCounters = JSON.parse(readFileSync(counterPath, 'utf8'));
  assert.ok(safeCounters.safe_started_at[1] - safeCounters.safe_started_at[0] >= 20, 'capacity cooldown must delay the continuation turn');
  const executions = runtime.store.listModelExecutionsForConversation(recovered.session.id);
  assert.equal(executions.at(-1).status, 'completed');
  assert.ok(recovered.message.metadata.processEvents.some((event) => event.activityType === 'model' && /自动(?:续跑|重试)/.test(event.title)));
  assert.equal(JSON.parse(readFileSync(counterPath, 'utf8')).safe_used_continuation_prompt, true);

  const continued = await runtime.sendChat({
    sessionId: recovered.session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: general.instance.id,
    routePreference: 'explicit',
    chatMode: 'agent',
    message: 'unsafe completed command fixture',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sandboxPermission: 'request-approval',
  });
  assert.equal(continued.answer, 'DIRECT_CHAT_RETRY_OK');
  const counters = JSON.parse(readFileSync(counterPath, 'utf8'));
  assert.equal(counters.unsafe, 2);
  assert.equal(counters.unsafe_used_continuation_prompt, true, 'the retry must continue the failed thread instead of replaying the original request');
  assert.equal(existsSync(path.join(root, 'should-not-retry.txt')), false, 'the fake command must not actually run');

  await assert.rejects(runtime.sendChat({
    sessionId: recovered.session.id,
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: general.instance.id,
    routePreference: 'explicit',
    chatMode: 'agent',
    message: 'exhausted capacity fixture',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    sandboxPermission: 'request-approval',
  }), /at capacity/i);
  assert.equal(JSON.parse(readFileSync(counterPath, 'utf8')).exhausted, 3, 'exhausted App Server retries must not trigger a second outer retry loop');

  console.log(JSON.stringify({ ok: true, checks: ['capacity_retry', 'capacity_cooldown', 'same_model_retry', 'same_thread_continuation', 'retry_exhaustion', 'simple_prompt_tool_avoidance', 'single_delivery'] }));
} finally {
  runtime?.close();
  await rm(root, { recursive: true, force: true });
  await rm(binRoot, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousRetryBase === undefined) delete process.env.JANUS_DIRECT_CHAT_RETRY_BASE_MS;
  else process.env.JANUS_DIRECT_CHAT_RETRY_BASE_MS = previousRetryBase;
  if (previousAppServerRetryBase === undefined) delete process.env.JANUS_APP_SERVER_TRANSIENT_RETRY_BASE_MS;
  else process.env.JANUS_APP_SERVER_TRANSIENT_RETRY_BASE_MS = previousAppServerRetryBase;
  if (previousCapacityCooldown === undefined) delete process.env.JANUS_MODEL_CAPACITY_COOLDOWN_MS;
  else process.env.JANUS_MODEL_CAPACITY_COOLDOWN_MS = previousCapacityCooldown;
  delete process.env.DIRECT_CHAT_RETRY_COUNTER;
}
