import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCodexSession } from '../src/main/codex.js';
import { saveCodexConfig } from '../src/main/codexConfig.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-codex-dynamic-tools-'));
const fakeCodex = path.join(root, 'fake-codex.mjs');
const logPath = path.join(root, 'requests.jsonl');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_DYNAMIC_TOOL_LOG;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server --listen <URL>'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(2);
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.JANUS_DYNAMIC_TOOL_LOG, JSON.stringify(message) + '\\n');
  if (!message.method && String(message.id) === 'dynamic-call-1') {
    const text = message.result?.contentItems?.[0]?.text || '';
    send({ method: 'item/completed', params: { item: { id: 'dynamic-item', type: 'dynamicToolCall', status: 'completed', namespace: 'janus', tool: 'list_capabilities', arguments: { scope: 'agents' }, result: message.result } } });
    send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: text.includes('agent_count') ? 'DYNAMIC_TOOL_OK' : 'DYNAMIC_TOOL_BAD' } } });
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: text.includes('agent_count') ? 'DYNAMIC_TOOL_OK' : 'DYNAMIC_TOOL_BAD' }] } } });
    continue;
  }
  if (!message.method || message.id == null) continue;
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'dynamic-tools-smoke' } });
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'dynamic-thread' } } });
  else if (message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  else if (message.method === 'thread/memoryMode/set') send({ id: message.id, result: {} });
  else if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    send({ id: 'dynamic-call-1', method: 'item/tool/call', params: { threadId: 'dynamic-thread', turnId: 'turn-1', callId: 'call-1', namespace: 'janus', tool: 'list_capabilities', arguments: { scope: 'agents' } } });
  } else send({ id: message.id, result: {} });
}
`);
chmodSync(fakeCodex, 0o755);

try {
  process.env.JANUS_CODEX_BIN = fakeCodex;
  process.env.JANUS_DYNAMIC_TOOL_LOG = logPath;
  saveCodexConfig(root, { baseUrl: 'https://provider.invalid/v1', apiKey: 'fake-key' });
  let called = null;
  const result = await runCodexSession({
    root, cwd: root, sessionId: 'dynamic-tools-session', prompt: 'Use the Janus capability tool.',
    permissionMode: 'request-approval', timeoutMs: 5_000,
    dynamicTools: [{ type: 'namespace', name: 'janus', description: 'Janus tools', tools: [{
      type: 'function', name: 'list_capabilities', description: 'List capabilities',
      inputSchema: { type: 'object', properties: { scope: { type: 'string' } } },
    }] }],
    onDynamicToolCall: async (call) => {
      called = call;
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ agent_count: 2 }) }] };
    },
  });
  assert.equal(result.answer, 'DYNAMIC_TOOL_OK');
  assert.equal(called?.namespace, 'janus');
  assert.equal(called?.tool, 'list_capabilities');
  assert.deepEqual(called?.arguments, { scope: 'agents' });
  const requests = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const threadStart = requests.find((item) => item.method === 'thread/start');
  assert.equal(threadStart.params.dynamicTools[0].name, 'janus');
  const response = requests.find((item) => !item.method && String(item.id) === 'dynamic-call-1');
  assert.equal(response.result.success, true);
  const resumed = await runCodexSession({
    root, cwd: root, sessionId: 'dynamic-tools-session', threadId: 'dynamic-thread', prompt: 'Use the Janus capability tool again.',
    permissionMode: 'request-approval', timeoutMs: 5_000,
    dynamicTools: [{ type: 'namespace', name: 'janus', description: 'Janus tools', tools: [{
      type: 'function', name: 'list_capabilities', description: 'List capabilities',
      inputSchema: { type: 'object', properties: { scope: { type: 'string' } } },
    }] }],
    onDynamicToolCall: async () => ({
      success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ agent_count: 2 }) }],
    }),
  });
  assert.equal(resumed.answer, 'DYNAMIC_TOOL_OK');
  const resumedRequests = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const threadResume = resumedRequests.find((item) => item.method === 'thread/resume');
  assert.ok(threadResume);
  assert.equal(Object.hasOwn(threadResume.params, 'dynamicTools'), false);
  console.log('Codex dynamic tools smoke passed');
} finally {
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_DYNAMIC_TOOL_LOG;
  else process.env.JANUS_DYNAMIC_TOOL_LOG = previousLog;
  await rm(root, { recursive: true, force: true });
}
