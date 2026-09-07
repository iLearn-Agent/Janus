
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputDirectory = path.resolve(
  process.env.JANUS_UI_PICTURES_DIR || path.join(os.tmpdir(), 'janus-ui-pictures'),
);
const testRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-artifact-file-actions-'));
const runtimeRoot = path.join(testRoot, 'runtime');
const workspaceRoot = path.join(testRoot, 'workspace');
const profileRoot = path.join(testRoot, 'profile');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.JANUS_ARTIFACT_ACTIONS_UI_PORT || 9517);
const screenshots = { artifacts: path.join(outputDirectory, 'artifact-file-actions-single-click.png') };
let child;
let cdp;
let stderr = '';

mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });
for (const file of Object.values(screenshots)) rmSync(file, { force: true });

const imagePath = path.join(workspaceRoot, 'image-real-generated.png');
const deckPath = path.join(workspaceRoot, 'generated-real-deck.pptx');
const documentPath = path.join(workspaceRoot, 'generated-real-document.md');
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAdklEQVR4nO3QMQEAAAgDINc/9F1hBxyQkLQNzLTvAI4rWAAsABaACwAFwAJgAbAAWAAsABYAC4AFwAJgAbAAWAAsABYAC4AFwAJgAbAAWAAsABYAC4AFwAJgAbAAWAAsABYAC4AFwAJgAbAAWAAsABYAC4AFwAJgAc72Af3QAr4wIbzWAAAAAElFTkSuQmCC', 'base64'));
writeFileSync(documentPath, '# Agent 生成文档\n\n用于验证文档预览和文件按钮不会重复触发。\n');
const templateDirectory = path.join(root, 'assets', 'departments', 'ppt_department', 'templates');
const templateDeck = path.join(templateDirectory, readdirSync(templateDirectory).find((name) => name.endsWith('.pptx')) || '');
assert.ok(existsSync(templateDeck), 'PPT template not found in: ' + templateDirectory);
copyFileSync(templateDeck, deckPath);

try {
  assert.ok(existsSync(electronExe), `Electron binary not found: ${electronExe}`);
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  const user = runtime.authRegister({
    email: 'artifact-ui-verifier@example.com', password: 'artifact-ui-password', displayName: 'Artifact UI verifier',
  });
  const agent = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(agent?.id, 'Default general Agent instance is required.');
  const project = runtime.createProject({ title: 'Artifact Actions Workspace', workspaceRoot });
  const session = runtime.store.createSession({ title: '????? PPT ??????', departmentId: 'general', agentId: 'general_agent', agentInstanceId: agent.id, projectId: project.id, workspaceRoot, userId: user.id });
  runtime.store.addMessage({ sessionId: session.id, role: 'user', content: '??????? PPT ??????/??????', agentId: 'general_agent', agentInstanceId: agent.id, departmentId: 'general' });
  const imageMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: `__JANUS_ARTIFACT__${JSON.stringify({ kind: 'image', data: { name: path.basename(imagePath), path: imagePath, file_url: pathToFileURL(imagePath).href, download_url: pathToFileURL(imagePath).href, size: statSync(imagePath).size, model: 'gpt-image-2', preview: { subtitle: '?? PNG ??' } } })}`,
    agentId: 'general_agent', agentInstanceId: agent.id, departmentId: 'general',
  });
  const pptMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: `__JANUS_ARTIFACT__${JSON.stringify({ kind: 'ppt', data: { deck_name: path.basename(deckPath), deck: deckPath, deck_file: { path: deckPath, size: statSync(deckPath).size }, preview: { title: '?? PPT ??', subtitle: '????????' } } })}`,
    agentId: 'general_agent', agentInstanceId: agent.id, departmentId: 'general',
  });
  const documentMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'Agent 文档已生成。',
    metadata: { outputArtifacts: [{ name: path.basename(documentPath), filename: path.basename(documentPath), path: documentPath, kind: 'markdown', size: statSync(documentPath).size }] },
    agentId: 'general_agent', agentInstanceId: agent.id, departmentId: 'general',
  });
  runtime.close();

  const electronEnv = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', JANUS_HOME: runtimeRoot, JANUS_AUTH_URL: '', JANUS_CLOUD_AUTO_SYNC_ENABLED: '0', JANUS_MODEL_REFRESH_ENABLED: '0', JANUS_LOCAL_EVOLUTION_ENABLED: '0', JANUS_UPDATES_ENABLED: '0' };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronArgs = ['--no-sandbox', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${port}`, '.'];
  const command = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : electronExe;
  const args = command === electronExe ? electronArgs : ['-a', electronExe, ...electronArgs];
  child = spawn(command, args, {
    cwd: root,
    env: electronEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await waitForPageTarget(port, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.querySelector('[data-tab=\"employees\"]')", 30_000);
  await click('[data-tab=\"employees\"]');
  await waitFor(`document.querySelector('[data-employee-open-chat="${agent.id}"]')`, 30_000);
  await click(`[data-employee-open-chat="${agent.id}"]`);
  await waitFor(`document.querySelector('[data-message-id="${imageMessage.id}"] .artifact-image-card') && document.querySelector('[data-message-id="${pptMessage.id}"].ppt-artifact-message') && document.querySelector('[data-message-id="${documentMessage.id}"] .message-output-artifacts')`, 20_000);
  await click(`[data-message-id="${documentMessage.id}"] .message-output-artifacts > summary`);
  await capture(screenshots.artifacts);

  const listenerTargets = [
    ['image save', `[data-message-id="${imageMessage.id}"] [data-save-file]`],
    ['image open', `[data-message-id="${imageMessage.id}"] [data-open-file]`],
    ['ppt save', `[data-message-id="${pptMessage.id}"] [data-save-file]`],
    ['ppt open', `[data-message-id="${pptMessage.id}"] [data-open-file]`],
    ['document save', `[data-message-id="${documentMessage.id}"] [data-save-file]`],
    ['document open', `[data-message-id="${documentMessage.id}"] [data-open-file]`],
  ];
  const listenerProbe = [];
  for (const [label, selector] of listenerTargets) {
    listenerProbe.push({ label, present: await elementExists(selector), listeners: await clickListenerCount(selector) });
  }
  assert.equal(listenerProbe.every((row) => row.present && row.listeners === 1), true, `Artifact buttons must each have exactly one click listener: ${JSON.stringify(listenerProbe)}`);

  const previewTargets = [
    ['document preview actions', `[data-message-id="${documentMessage.id}"] [data-preview-file]`],
  ];
  const previewListenerProbe = [];
  for (const [label, selector] of previewTargets) {
    await click(selector);
    await waitFor("document.querySelector('.preview-modal [data-open-file]')", 20_000);
    const actions = {};
    for (const action of ['save', 'show', 'open']) {
      const actionSelector = `.preview-modal [data-${action}-file]`;
      actions[action] = await clickListenerCount(actionSelector);
    }
    previewListenerProbe.push({ label, actions });
    assert.deepEqual(actions, { save: 1, show: 1, open: 1 }, `${label} must bind every file action exactly once`);
    await click('#close-preview-btn');
    await waitFor("!document.querySelector('.preview-modal')", 10_000);
  }

  console.log(JSON.stringify({ passed: true, screenshots, imageMessageId: imageMessage.id, pptMessageId: pptMessage.id, documentMessageId: documentMessage.id, listenerProbe, previewListenerProbe }, null, 2));
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-8000)}`);
} finally {
  cdp?.close?.();
  signalProcessTree(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  signalProcessTree(child, 'SIGKILL');
  rmSync(testRoot, { recursive: true, force: true });
}

function signalProcessTree(handle, signal) {
  if (!handle?.pid) return;
  try {
    if (process.platform === 'win32') {
      if (handle.exitCode === null) handle.kill(signal);
    } else {
      process.kill(-handle.pid, signal);
    }
  } catch {}
}

async function elementExists(selector) {
  return evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
}

async function clickListenerCount(selector) {
  const result = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, objectGroup: 'artifact-action-listeners' });
  const objectId = result.result?.objectId;
  if (!objectId) return null;
  const listeners = await cdp.send('DOMDebugger.getEventListeners', { objectId });
  return (listeners.listeners || []).filter((listener) => listener.type === 'click').length;
}

async function click(selector) {
  const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; element.scrollIntoView({ block: 'center', inline: 'center' }); const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }; })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 250));
}
async function capture(filePath) { const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(filePath, Buffer.from(screenshot.data, 'base64')); }
async function evaluate(expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed'); return result.result?.value; }
async function waitFor(expression, timeoutMs = 12_000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out waiting for renderer expression: ${expression}`); }
async function waitForPageTarget(debugPort, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); const targets = await response.json(); const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch {} await new Promise((resolve) => setTimeout(resolve, 200)); } throw new Error('Timed out waiting for Electron renderer target.'); }
async function connectCdp(webSocketUrl) { const socket = new WebSocket(webSocketUrl); const pending = new Map(); let nextId = 1; await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (!message.id || !pending.has(message.id)) return; const { resolve, reject } = pending.get(message.id); pending.delete(message.id); if (message.error) reject(new Error(message.error.message)); else resolve(message.result || {}); }); return { send(method, params = {}) { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }, close() { socket.close(); } }; }
