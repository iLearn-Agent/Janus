import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures/test';
const evidencePath = path.join(outputDirectory, 'long-run-codex-events.json');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-codex-process-replay-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const profileRoot = path.join(tempRoot, 'profile');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const debugPort = 9489;
const marker = 'VISIBLE_RAW_MARKER_2840213075';
const completionMarker = 'LONG_CHAIN_COMPLETE_2840213075';
let child = null;
let cdp = null;
let stderr = '';

assert.ok(existsSync(evidencePath), `Missing real Codex evidence: ${evidencePath}`);
assert.ok(existsSync(electronExe), `Missing Electron binary: ${electronExe}`);
mkdirSync(outputDirectory, { recursive: true });

try {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  const processEvents = Array.isArray(evidence.processEvents) ? evidence.processEvents : [];
  const finalAnswer = String(evidence.assistant?.content || evidence.assistant?.metadata?.responseText || '');
  assert.ok(processEvents.length > 0, 'Real Codex process events are missing.');
  assert.ok(finalAnswer.includes(completionMarker), 'Real Codex final answer marker is missing.');

  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  await runtime.authUpdateProfile({ displayName: '2840213075', username: '2840213075' });
  const user = runtime.currentUser();
  const general = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(general?.id, 'General Agent instance is missing.');
  const project = runtime.createProject({ title: '真实 Codex 全过程回放', workspaceRoot: root });
  const session = runtime.store.createSession({
    title: '真实 Codex 长链路全过程回放', departmentId: 'general', agentId: 'general_agent',
    agentInstanceId: general.id, projectId: project.id, workspaceRoot: root, userId: user.id,
  });
  runtime.store.addMessage({
    sessionId: session.id, role: 'user', agentId: 'general_agent', agentInstanceId: general.id, departmentId: 'general',
    content: `真实 Codex 长链路过程回放：确认 ${marker}，完成两轮实现与测试。`,
  });
  runtime.store.addMessage({
    sessionId: session.id, role: 'assistant', agentId: 'general_agent', agentInstanceId: general.id, departmentId: 'general',
    content: finalAnswer,
    metadata: { processEvents, processDurationMs: 9 * 60_000, replayedRealCodexEvidence: true },
  });
  runtime.close();

  child = launchElectron();
  const target = await waitForPageTarget(debugPort, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1180, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelector('[data-tab="employees"]')`, 30_000);
  await evaluate(`localStorage.setItem('janus-sandbox-permission', 'full-access'); location.reload();`);
  await waitFor(`document.querySelector('[data-tab="employees"]')`, 30_000);
  await click('[data-tab="employees"]');
  await waitFor(`document.querySelector('[data-employee-open-chat="${general.id}"]')`, 30_000);
  await click(`[data-employee-open-chat="${general.id}"]`);
  await waitFor(`document.body.innerText.includes('${completionMarker}') && document.querySelector('.codex-transcript:not(.is-streaming)')`, 30_000);

  const humanProbe = await evaluate(`(() => {
    const transcript = document.querySelector('.codex-transcript:not(.is-streaming)');
    const human = Array.from(transcript?.children || []).filter((node) => !node.classList.contains('codex-technical-stream')).map((node) => node.innerText).join('\\n');
    return {
      stageMilestones: transcript?.querySelectorAll('.type-commentary.is-milestone, .type-commentary.is-conclusion').length || 0,
      technicalStreams: transcript?.querySelectorAll('.codex-technical-stream').length || 0,
      technicalOpen: transcript?.querySelectorAll('.codex-technical-stream[open]').length || 0,
      runtimeNoise: /threadId|turnId|processId|commandActions|Codex 线程状态更新|Codex 本轮执行完成|\\[object Object\\]/.test(human),
    };
  })()`);
  assert.ok(humanProbe.stageMilestones >= 5, `Stage milestones are missing: ${JSON.stringify(humanProbe)}`);
  assert.ok(humanProbe.technicalStreams > 0, 'Collapsed technical stream is missing.');
  assert.equal(humanProbe.technicalOpen, 0, 'Technical stream must be collapsed by default.');
  assert.equal(humanProbe.runtimeNoise, false, 'Runtime protocol noise leaked into the human transcript.');

  await evaluate(`(() => {
    const nodes = document.querySelectorAll('.type-commentary.is-milestone, .type-commentary.is-conclusion');
    nodes[nodes.length - 1]?.scrollIntoView({ block: 'center' });
  })()`);
  await capture('codex-process-12-stage-conclusions-current-ui.png');

  await evaluate(`(() => {
    const transcript = document.querySelector('.codex-transcript:not(.is-streaming)');
    transcript?.querySelectorAll('.codex-command-group, .codex-command-item, .codex-operation-item, .codex-file-change').forEach((item) => { item.open = true; });
    const files = transcript?.querySelectorAll('.codex-operation-item.type-file');
    files?.[files.length - 1]?.scrollIntoView({ block: 'center' });
  })()`);
  await capture('codex-process-13-expanded-human-details-current-ui.png');

  const markerFound = await evaluate(`(() => {
    const item = Array.from(document.querySelectorAll('.codex-command-item')).find((node) => node.textContent.includes('${marker}'));
    if (!item) return false;
    const group = item.closest('.codex-command-group');
    if (group) group.open = true;
    item.open = true;
    item.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  assert.equal(markerFound, true, 'Marker command is missing from the real transcript.');
  await capture('codex-process-14-marker-command-current-ui.png');

  const rawProbe = await evaluate(`(() => {
    const nestedEvents = Array.from(document.querySelectorAll('.codex-raw-protocol > div > details'));
    const nested = nestedEvents.find((node) => {
      const summary = node.querySelector('summary')?.innerText || '';
      return summary.includes('item/') || summary.includes('turn/');
    }) || nestedEvents[0];
    if (!nested) return { found: false };
    const protocol = nested.closest('.codex-raw-protocol');
    const activity = nested.closest('.codex-technical-activity');
    const stream = nested.closest('.codex-technical-stream');
    stream.open = true; activity.open = true; protocol.open = true; nested.open = true;
    const pre = nested.querySelector('pre');
    pre?.scrollIntoView({ block: 'center' });
    return { found: true, raw: pre?.innerText || '' };
  })()`);
  assert.equal(rawProbe.found, true, 'Raw protocol event is missing.');
  assert.match(rawProbe.raw, /"method"\s*:/);
  assert.match(rawProbe.raw, /"envelope"\s*:/);
  await capture('codex-process-15-raw-protocol-current-ui.png');

  await evaluate(`(() => {
    const message = Array.from(document.querySelectorAll('.message.assistant')).find((node) => node.textContent.includes('${completionMarker}'));
    const answer = Array.from(message?.querySelectorAll('.assistant-result, .message-body') || []).find((node) => node.textContent.includes('${completionMarker}')) || message;
    answer?.scrollIntoView({ block: 'center' });
  })()`);
  await capture('codex-process-16-final-answer-current-ui.png');

  writeFileSync(path.join(outputDirectory, 'codex-process-replay-result.json'), `${JSON.stringify({ passed: true, processEventCount: processEvents.length, humanProbe }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, processEventCount: processEvents.length, humanProbe }, null, 2));
} finally {
  try { cdp?.close(); } catch {}
  if (child && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

function launchElectron() {
  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', JANUS_HOME: runtimeRoot, JANUS_AUTH_URL: '', JANUS_MODEL_REFRESH_ENABLED: '0', JANUS_CLOUD_AUTO_SYNC_ENABLED: '0', JANUS_LOCAL_EVOLUTION_ENABLED: '0', JANUS_UPDATES_ENABLED: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${debugPort}`, '.'], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  instance.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return instance;
}

async function capture(name) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(outputDirectory, name), Buffer.from(result.data, 'base64'));
}

async function click(selector) {
  const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({ block: 'center' }); node.click(); return true; })()`);
  assert.equal(clicked, true, `Unable to click ${selector}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}\n${stderr.slice(-4000)}`);
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer.');
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id); pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
        socket.send(JSON.stringify({ id, method, params }));
        return response;
      },
      close() { socket.close(); },
    }));
    socket.addEventListener('error', reject);
  });
}
