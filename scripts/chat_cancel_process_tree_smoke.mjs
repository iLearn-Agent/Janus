import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-chat-cancel-'));
const binRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-chat-cancel-bin-'));
const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-chat-cancel-project-'));
const fakeCodex = path.join(binRoot, 'fake-codex.mjs');
const readyMarker = path.join(binRoot, 'stubborn-ready');
const previousBin = process.env.JANUS_CODEX_BIN;

await writeFile(fakeCodex, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fake-codex-cancel'); process.exit(0); }
if (args[0] === 'app-server' && args.includes('--help')) { console.log('Usage: codex app-server [OPTIONS]'); process.exit(0); }
if (args[0] === 'app-server') {
  const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'cancel-smoke' } });
    else if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'cancel-smoke-thread' } } });
    else if (message.method === 'thread/memoryMode/set' || message.method?.startsWith('thread/goal/')) {
      if (message.method === 'thread/goal/get') send({ id: message.id, result: { goal: null } });
      else send({ id: message.id, result: {} });
    } else if (message.method === 'turn/start') {
      const prompt = String(message.params?.input?.map((item) => item?.text || '').join('\\n') || '');
      const currentUserInput = prompt.split('Current user message:\\n').at(-1) || prompt;
      send({ id: message.id, result: { turn: { id: 'cancel-smoke-turn' } } });
      if (currentUserInput.includes('stubborn cancellation fixture')) {
        process.on('SIGTERM', () => {});
        const stubbornChild = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),15000);setInterval(()=>{},1000)"], { stdio: 'ignore' });
        stubbornChild.unref();
        fs.writeFileSync(${JSON.stringify(readyMarker)}, String(stubbornChild.pid));
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      } else {
        const response = 'CANCEL_RECOVERY_OK';
        send({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
        send({ method: 'turn/completed', params: { turn: { id: 'cancel-smoke-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response }] } } });
      }
    } else send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
}
`);
chmodSync(fakeCodex, 0o755);
process.env.JANUS_CODEX_BIN = fakeCodex;

let runtime;
try {
  runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });
  await mkdir(projectRoot, { recursive: true });

  const normalEvents = [];
  const normalRun = runtime.sendChat({
    channelId: 'normal-stubborn-cancel',
    chatMode: 'normal',
    sandboxPermission: 'full-access',
    message: 'NORMAL stubborn cancellation fixture',
    onEvent: (event) => normalEvents.push(event),
  });
  await waitFor(() => existsSync(readyMarker));
  const normalDescendantPid = Number(readFileSync(readyMarker, 'utf8'));
  const normalCancelStartedAt = Date.now();
  const normalCancel = await runtime.cancelChat({ channelId: 'normal-stubborn-cancel' });
  assert.equal(normalCancel.ok, true);
  assert.equal(normalCancel.settled, true);
  const cancelledNormal = await normalRun;
  assert.equal(cancelledNormal.cancelled, true);
  assert.ok(Date.now() - normalCancelStartedAt < 5_000, 'normal chat cancellation must settle within five seconds');
  assert.ok(normalEvents.some((event) => event.kind === 'cancelled'));
  assert.equal(runtime.activeRuns.size, 0);
  await waitFor(() => !processExists(normalDescendantPid));

  rmSync(readyMarker, { force: true });
  const project = runtime.createProject({ title: 'Cancellation project', workspaceRoot: projectRoot });
  const secretarySession = runtime.ensureSecretarySession();
  const uBuddyEvents = [];
  const uBuddyRun = runtime.secretaryChat({
    channelId: 'ubuddy-stubborn-cancel',
    sessionId: secretarySession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    sandboxPermission: 'full-access',
    message: 'UBUDDY stubborn cancellation fixture：请改写这句话。',
    onEvent: (event) => uBuddyEvents.push(event),
  });
  await waitFor(() => existsSync(readyMarker));
  const uBuddyDescendantPid = Number(readFileSync(readyMarker, 'utf8'));
  const uBuddyCancelStartedAt = Date.now();
  const uBuddyCancel = await runtime.cancelChat({ channelId: 'ubuddy-stubborn-cancel' });
  assert.equal(uBuddyCancel.ok, true);
  assert.equal(uBuddyCancel.settled, true);
  const cancelledUBuddy = await uBuddyRun;
  assert.equal(cancelledUBuddy.cancelled, true);
  assert.ok(Date.now() - uBuddyCancelStartedAt < 5_000, 'uBuddy cancellation must settle within five seconds');
  assert.ok(uBuddyEvents.some((event) => event.kind === 'cancelled'));
  assert.equal(runtime.activeRuns.size, 0);
  await waitFor(() => !processExists(uBuddyDescendantPid));

  const followUp = await runtime.secretaryChat({
    sessionId: secretarySession.id,
    projectId: project.id,
    workspaceRoot: project.workspaceRoot,
    sandboxPermission: 'full-access',
    message: '停止后继续发送消息。',
  });
  assert.equal(followUp.answer, 'CANCEL_RECOVERY_OK');
  assert.equal(followUp.uBuddyMode, 'direct');
  const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
  assert.match(rendererSource, /result\.settled !== false/,
    'renderer cancellation must wait for backend settlement before unlocking');
  assert.match(rendererSource, /unregisterChatRun\(activeRun\)/,
    'renderer cancellation must remove a settled local run so the composer can send again');
  console.log('chat cancellation process-tree smoke passed');
} finally {
  runtime?.close();
  if (previousBin === undefined) delete process.env.JANUS_CODEX_BIN;
  else process.env.JANUS_CODEX_BIN = previousBin;
  rmSync(root, { recursive: true, force: true });
  rmSync(binRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for stubborn Codex fixture.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}
