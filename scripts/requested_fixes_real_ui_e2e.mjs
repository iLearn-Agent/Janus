import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures';
const testRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-requested-fixes-ui-'));
const runtimeRoot = path.join(testRoot, 'runtime');
const workspaceRoot = path.join(testRoot, 'historical-workspace');
const profileRoot = path.join(testRoot, 'profile');
const outputFile = path.join(workspaceRoot, '历史交付文件.md');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.JANUS_REQUESTED_FIXES_UI_PORT || 9496);
const screenshots = {
  group: path.join(outputDirectory, 'requested-fix-group-sender-message.png'),
  rewrite: path.join(outputDirectory, 'requested-fix-inline-message-rewrite.png'),
  file: path.join(outputDirectory, 'requested-fix-historical-file-preview.png'),
};
let child;
let cdp;
let stderr = '';

mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputFile, '# 历史交付文件\n\n切换或关闭工作区后仍可安全预览。\n');
for (const file of Object.values(screenshots)) rmSync(file, { force: true });

try {
  assert.ok(existsSync(electronExe), `Electron binary not found: ${electronExe}`);
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  await runtime.authUpdateProfile({ displayName: 'UI 验证用户', username: 'ui_verifier' });
  const user = runtime.currentUser();
  runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,password_hash,email_verified,auth_provider,remote_id)
    VALUES('requested_fix_friend','friend@requested-fix.test','群友 Bob','group_bob','member','',1,'local_mock','')`).run();
  runtime.db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status)
    VALUES('requested_fix_friendship',?, 'requested_fix_friend','accepted')`).run(user.id);
  const groupId = 'requested_fix_group';
  runtime.createChatGroup({
    groupId,
    clientRequestId: 'requested-fix-group-create',
    title: '修复验证群',
    memberIds: ['requested_fix_friend'],
  });
  runtime.sendChatGroupMessage({
    groupId,
    clientMessageId: 'requested_fix_group_message',
    content: '发送者和消息必须一起显示',
  });

  const agent = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(agent?.id, 'Default general Agent instance is required.');
  const project = runtime.createProject({ title: '将被关闭的项目', workspaceRoot });
  const session = runtime.store.createSession({
    title: '重新编辑与历史文件验证',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: agent.id,
    projectId: project.id,
    workspaceRoot,
    userId: user.id,
  });
  const userMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: '请生成一份历史交付文件',
    agentId: 'general_agent',
    agentInstanceId: agent.id,
    departmentId: 'general',
  });
  const assistantMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: '已生成交付文件。',
    agentId: 'general_agent',
    agentInstanceId: agent.id,
    departmentId: 'general',
    metadata: { outputArtifacts: [{ name: path.basename(outputFile), path: outputFile, relative_path: path.basename(outputFile) }] },
  });
  runtime.store.removeProjectFromWorkspace(project.id);
  runtime.close();

  const electronEnv = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: '',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_LOCAL_EVOLUTION_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
  };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${port}`, '.'], {
    cwd: root,
    env: electronEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await waitForPageTarget(port, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);

  await click('[data-network-view="messages"]');
  await waitFor(`Array.from(document.querySelectorAll('[data-chat-group]')).some((item) => item.innerText.includes('UI 验证用户：发送者和消息必须一起显示'))`, 20_000);
  await capture(screenshots.group);

  await click('[data-tab="employees"]');
  await waitFor(`document.querySelector('[data-employee-open-chat="${agent.id}"]')`, 20_000);
  await click(`[data-employee-open-chat="${agent.id}"]`);
  await waitFor(`document.querySelector('[data-message-id="${userMessage.id}"]') && document.querySelector('[data-message-id="${assistantMessage.id}"]')`, 20_000);
  await click(`[data-message-inline-more="${userMessage.id}"]`);
  await waitFor(`document.querySelector('[data-message-context-action="edit"]')`, 10_000);
  await click('[data-message-context-action="edit"]');
  await waitFor(`document.querySelector('[data-message-rewrite-form="${userMessage.id}"]')`, 10_000);
  const editorProbe = await evaluate(`(() => {
    const form = document.querySelector('[data-message-rewrite-form="${userMessage.id}"]');
    return { value: form?.querySelector('textarea')?.value || '', composerValue: document.querySelector('#chat-input')?.value || '', label: form?.innerText || '' };
  })()`);
  assert.equal(editorProbe.value, '请生成一份历史交付文件');
  assert.equal(editorProbe.composerValue, '', 'Re-edit must stay inside the sent message instead of returning to the composer.');
  assert.match(editorProbe.label, /保存并重新生成/);
  await capture(screenshots.rewrite);
  await click('[data-message-rewrite-cancel]');

  await click(`[data-message-id="${assistantMessage.id}"] .message-output-artifacts > summary`);
  await click(`[data-message-id="${assistantMessage.id}"] [data-preview-file]`);
  try {
    await waitFor(`document.querySelector('.preview-modal')?.innerText.includes('历史交付文件')`, 20_000);
  } catch (error) {
    const fileProbe = await evaluate(`(async () => {
      const button = document.querySelector('[data-message-id="${assistantMessage.id}"] [data-preview-file]');
      const payload = button?.dataset.previewFile ? JSON.parse(decodeURIComponent(button.dataset.previewFile)) : null;
      let direct = null;
      try { direct = payload ? await window.janus.renderFile(payload) : null; } catch (directError) { direct = { error: directError.message || String(directError) }; }
      return { payload, direct, notice: document.querySelector('.app-notice')?.innerText || '', body: (document.body?.innerText || '').slice(-1200) };
    })()`);
    throw new Error(`${error.message}; file probe: ${JSON.stringify(fileProbe)}`);
  }
  const previewProbe = await evaluate(`(() => ({
    text: document.querySelector('.preview-modal')?.innerText || '',
    actions: document.querySelectorAll('.preview-modal [data-save-file], .preview-modal [data-show-file], .preview-modal [data-open-file]').length,
    actionMessageIds: Array.from(document.querySelectorAll('.preview-modal [data-save-file], .preview-modal [data-show-file], .preview-modal [data-open-file]')).map((button) => {
      const encoded = button.dataset.saveFile || button.dataset.showFile || button.dataset.openFile || '';
      return encoded ? JSON.parse(decodeURIComponent(encoded)).messageId || '' : '';
    }),
  }))()`);
  assert.match(previewProbe.text, /切换或关闭工作区后仍可安全预览/);
  assert.equal(previewProbe.actions, 3, 'Preview must retain download, show-in-folder, and open-file actions.');
  assert.deepEqual(previewProbe.actionMessageIds, [assistantMessage.id, assistantMessage.id, assistantMessage.id],
    'All preview actions must retain the persisted-message authorization context.');
  await capture(screenshots.file);

  console.log(JSON.stringify({ passed: true, screenshots, groupId, sessionId: session.id, detachedProjectId: project.id }, null, 2));
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-8000)}`);
} finally {
  cdp?.close?.();
  if (child?.exitCode === null) {
    child.kill();
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2_000); });
  }
  rmSync(testRoot, { recursive: true, force: true });
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function capture(filePath) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer target.');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
