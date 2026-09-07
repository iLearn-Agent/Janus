import assert from 'node:assert/strict';
import { chmodSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-chat-approval-cancel-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-chat-approval-cancel-bin-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const previousBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex-approval-cancel'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] !== 'app-server') process.exit(2);

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (!message.method) continue;
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'approval-cancel-smoke' } });
  else if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: 'approval-cancel-thread' } } });
  } else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
    if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
    else send({ id: message.id, result: {} });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'approval-cancel-turn' } } });
    send({ id: 'approval-cancel-1', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'approval-cancel-thread', turnId: 'approval-cancel-turn', itemId: 'approval-item-1',
      command: 'node first-approval.mjs', reason: 'First cancellation approval fixture.',
    } });
    send({ id: 'approval-cancel-2', method: 'item/commandExecution/requestApproval', params: {
      threadId: 'approval-cancel-thread', turnId: 'approval-cancel-turn', itemId: 'approval-item-2',
      command: 'node second-approval.mjs', reason: 'Second cancellation approval fixture.',
    } });
  } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  const approvalEvents = [];
  const run = runtime.sendChat({
    channelId: 'pending-approval-cancel',
    chatMode: 'normal',
    sandboxPermission: 'request-approval',
    message: 'Trigger concurrent approvals and wait.',
    onEvent: (event) => approvalEvents.push(event),
  });

  await waitFor(() => approvalEvents.some((event) => event.kind === 'approval-request'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(approvalEvents.filter((event) => event.kind === 'approval-request').length, 1,
    'concurrent backend approvals must be presented one at a time');

  const firstApproval = approvalEvents.find((event) => event.kind === 'approval-request');
  const firstResolution = runtime.resolveChatApproval({
    channelId: 'pending-approval-cancel',
    approvalId: firstApproval.approvalId,
    approved: true,
  });
  assert.equal(firstResolution.ok, true);
  await waitFor(() => approvalEvents.filter((event) => event.kind === 'approval-request').length === 2);
  const secondApproval = approvalEvents.filter((event) => event.kind === 'approval-request')[1];
  assert.notEqual(secondApproval.approvalId, firstApproval.approvalId,
    'settling one approval must present the next queued approval');

  const cancellation = await runtime.cancelChat({ channelId: 'pending-approval-cancel' });
  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.settled, true);
  const result = await run;
  assert.equal(result.cancelled, true);
  assert.equal(runtime.activeRuns.size, 0);
  console.log('chat approval cancellation smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for approval cancellation fixture.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
