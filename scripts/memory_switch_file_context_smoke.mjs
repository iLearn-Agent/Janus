import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-memory-switch-files-'));
const runtimeRoot = path.join(tempRoot, 'workspace');
const fakeCodex = path.join(tempRoot, 'fake-codex.mjs');
const promptLog = path.join(tempRoot, 'prompt.log');
const turnStarted = path.join(tempRoot, 'turn-started');
const previousBin = process.env.JANUS_CODEX_BIN;
const previousLog = process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG;
const previousTurnStarted = process.env.JANUS_MEMORY_SWITCH_TURN_STARTED;

await writeFile(fakeCodex, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli memory-switch-smoke'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'memory-switch-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'memory-switch-thread' } } });
    else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else if (message.method === 'turn/start') {
      const stdin = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      if (process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG) fs.writeFileSync(process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG, stdin, 'utf8');
      if (process.env.JANUS_MEMORY_SWITCH_TURN_STARTED) fs.writeFileSync(process.env.JANUS_MEMORY_SWITCH_TURN_STARTED, 'started', 'utf8');
      send({ id: message.id, result: { turn: { id: 'memory-switch-turn' } } });
      await new Promise((resolve) => setTimeout(resolve, 300));
      send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'MEMORY_SWITCH_CONTEXT_OK' } } });
      send({ method: 'turn/completed', params: { turn: { id: 'memory-switch-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'MEMORY_SWITCH_CONTEXT_OK' }] } } });
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
}
`, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;
process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG = promptLog;
process.env.JANUS_MEMORY_SWITCH_TURN_STARTED = turnStarted;

const runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
try {
  const user = runtime.currentUser();
  const instance = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'ppt',
    commandId: 'memory-switch-file-context:recruit-ppt',
  }).instance;
  runtime.saveCodexConfig({ apiKey: 'sk-memory-switch-smoke', model: 'gpt-5.6-sol', reasoningEffort: 'medium' });

  const memoryA = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id })
    .find((item) => item.scope === 'general');
  const linkedOutput = path.join(runtimeRoot, 'outputs', 'alpha-linked.md');
  fs.mkdirSync(path.dirname(linkedOutput), { recursive: true });
  fs.writeFileSync(linkedOutput, 'ALPHA_MEMORY_LINKED_FILE_ONLY', 'utf8');
  runtime.store.appendMemoryDocumentVersion({
    memoryDocumentId: memoryA.id,
    content: '# memory-a\n\nMEMORY_ALPHA_ONLY\n\n[关联产出](outputs/alpha-linked.md)',
    sourceKind: 'smoke',
    sourceId: 'memory-alpha',
    createdBy: user.id,
  });
  const session = runtime.store.createSession({
    title: 'Memory switch isolation',
    departmentId: 'ppt_department',
    agentId: 'ppt',
    agentInstanceId: instance.id,
    userId: user.id,
  });
  const alphaFile = runtime.uploadFile({
    filename: 'alpha-memory.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('ALPHA_FILE_CONTENT_ONLY').toString('base64'),
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'ALPHA_CONVERSATION_ONLY',
    agentId: 'ppt',
    agentInstanceId: instance.id,
    departmentId: 'ppt_department',
    metadata: { attachments: [alphaFile] },
  });
  runtime.store.updateSessionThread(session.id, 'alpha-old-thread');

  const memoryB = runtime.store.createNextGeneralMemoryDocument({
    agentInstanceId: instance.id,
    displayName: 'memory-beta.md',
    content: '# memory-b\n\nMEMORY_BETA_MUST_NOT_LEAK',
  });
  const betaFile = runtime.uploadFile({
    filename: 'beta-memory.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('BETA_FILE_MUST_NOT_LEAK').toString('base64'),
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'BETA_CONVERSATION_MUST_NOT_LEAK',
    agentId: 'ppt',
    agentInstanceId: instance.id,
    departmentId: 'ppt_department',
    metadata: { attachments: [betaFile] },
  });
  runtime.store.updateSessionThread(session.id, 'beta-old-thread');

  const switchedMemory = runtime.store.switchCurrentMemory({ agentInstanceId: instance.id, memoryDocumentId: memoryA.id });
  assert.equal(runtime.store.getSession(session.id).codexThreadId, '', 'switching Memory must reset the backend thread');
  assert.equal(switchedMemory.lifecycleState, 'active');
  assert.equal(runtime.store.getMemoryDocument(memoryB.id).lifecycleState, 'inactive');

  const sendPromise = runtime.sendChat({
    sessionId: session.id,
    departmentId: 'ppt_department',
    agentId: 'ppt',
    message: '请只使用当前 Memory 和它的文件回答。',
  });
  const markerDeadline = Date.now() + 5_000;
  while (!fs.existsSync(turnStarted) && Date.now() < markerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(turnStarted), true, 'fake Codex turn must start before switching Memory');
  assert.throws(() => runtime.switchEmployeeMemory({
    agentInstanceId: instance.id,
    memoryDocumentId: memoryB.id,
  }), (error) => error?.code === 'memory_switch_during_active_chat');

  const result = await sendPromise;
  assert.equal(result.answer, 'MEMORY_SWITCH_CONTEXT_OK');
  const persistedTurn = runtime.store.listMessages(session.id, { includeAllContexts: true })
    .filter((item) => ['请只使用当前 Memory 和它的文件回答。', 'MEMORY_SWITCH_CONTEXT_OK'].includes(item.content));
  assert.equal(persistedTurn.length, 2);
  assert.deepEqual(persistedTurn.map((item) => item.memoryId), [memoryA.id, memoryA.id]);
  assert.deepEqual(persistedTurn.map((item) => item.contextSpaceId), [memoryA.contextSpaceId, memoryA.contextSpaceId]);
  const prompt = fs.readFileSync(promptLog, 'utf8');
  assert.match(prompt, /MEMORY_ALPHA_ONLY/);
  assert.match(prompt, /ALPHA_CONVERSATION_ONLY/);
  assert.match(prompt, /ALPHA_FILE_CONTENT_ONLY/);
  assert.match(prompt, /ALPHA_MEMORY_LINKED_FILE_ONLY/);
  assert.doesNotMatch(prompt, /MEMORY_BETA_MUST_NOT_LEAK/);
  assert.doesNotMatch(prompt, /BETA_CONVERSATION_MUST_NOT_LEAK/);
  assert.doesNotMatch(prompt, /BETA_FILE_MUST_NOT_LEAK/);
  const codexConfig = fs.readFileSync(path.join(runtimeRoot, 'data', 'codex_backend_sessions', session.id, 'config.toml'), 'utf8');
  assert.match(codexConfig, /use_memories\s*=\s*false/);
  console.log('Memory switch file context smoke passed.');
} finally {
  runtime.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  if (previousLog === undefined) delete process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG;
  else process.env.JANUS_MEMORY_SWITCH_PROMPT_LOG = previousLog;
  if (previousTurnStarted === undefined) delete process.env.JANUS_MEMORY_SWITCH_TURN_STARTED;
  else process.env.JANUS_MEMORY_SWITCH_TURN_STARTED = previousTurnStarted;
}
