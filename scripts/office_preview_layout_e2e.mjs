import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Document, HeadingLevel, Packer, PageBreak, Paragraph } from 'docx';

import { createRuntime } from '../src/main/runtime.js';
import { availableTcpPort, terminateSpawnedProcess } from './lib/spawnedElectronDiagnostics.mjs';

const root = process.cwd();
const testRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-office-preview-layout-'));
const runtimeRoot = path.join(testRoot, 'runtime');
const workspaceRoot = path.join(testRoot, 'workspace');
const profileRoot = path.join(testRoot, 'profile');
const documentPath = path.join(workspaceRoot, 'office-preview-layout.docx');
const screenshotPath = String(process.env.JANUS_DOCX_PREVIEW_SCREENSHOT || '').trim();
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.JANUS_OFFICE_PREVIEW_PORT || 0) || await availableTcpPort();
let child = null;
let cdp = null;
let stderr = '';

mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(documentPath, await Packer.toBuffer(new Document({
  sections: [{
    children: Array.from({ length: 4 }, (_, index) => [
      ...(index ? [new Paragraph({ children: [new PageBreak()] })] : []),
      new Paragraph({ text: `Office preview page ${index + 1}`, heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: 'The preview keeps one document scrollbar, compact page thumbnails, and its position across application renders.' }),
    ]).flat(),
  }],
})));

try {
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true });
  const user = runtime.authRegister({
    email: 'office-preview-layout@example.com', password: 'office-preview-layout-password', displayName: 'Office Preview Layout',
  });
  const agent = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
  assert.ok(agent?.id, 'Default Agent is required for the preview fixture session.');
  const project = runtime.createProject({ title: 'Office Preview Layout', workspaceRoot });
  const session = runtime.store.createSession({
    title: 'Office Preview Layout', departmentId: 'general', agentId: 'general_agent', agentInstanceId: agent.id,
    projectId: project.id, workspaceRoot, userId: user.id,
  });
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
  const electronArgs = ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${port}`, '.'];
  const command = process.platform === 'linux' && !process.env.DISPLAY ? 'xvfb-run' : electronExe;
  const args = command === electronExe ? electronArgs : ['-a', electronExe, ...electronArgs];
  child = spawn(command, args, {
    cwd: root,
    env: electronEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(port, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelector('#collapse-sidebar-btn')`, 30_000);

  const preview = await evaluate(`(async () => {
    const result = await window.janus.renderFile(${JSON.stringify({
      path: documentPath,
      filename: path.basename(documentPath),
      sessionId: session.id,
      projectId: project.id,
    })});
    const { state } = await import('./app/state.js');
    state.preview = { ...result, action_file: ${JSON.stringify({
      path: documentPath,
      filename: path.basename(documentPath),
      sessionId: session.id,
      projectId: project.id,
    })} };
    document.querySelector('#collapse-sidebar-btn').click();
    return { kind: result.kind, mode: result.preview_render_mode, pages: result.page_count };
  })()`);
  assert.deepEqual(preview, { kind: 'docx', mode: 'office', pages: 4 });
  await waitFor(`document.querySelectorAll('.preview-page-thumb').length === 4 && document.querySelectorAll('.preview-document-page img').length === 4`, 30_000);
  await waitFor(`[...document.querySelectorAll('.preview-document-page img')].every((image) => image.complete && image.naturalWidth > 600)`, 30_000);
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const layout = await evaluate(`(() => {
    const body = document.querySelector('.preview-body');
    const shell = document.querySelector('.preview-document-shell');
    const sidebar = document.querySelector('.preview-document-sidebar');
    const main = document.querySelector('.preview-document-main');
    const icon = document.querySelector('.preview-document-sidebar-toggle svg');
    const bodyRect = body.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(body).overflowY,
      outerScrollable: body.scrollHeight > body.clientHeight + 1,
      shellFillsBody: Math.abs(shellRect.height - bodyRect.height) <= 1,
      sidebarHeight: Math.round(sidebarRect.height),
      contentBelowSidebar: mainRect.top >= sidebarRect.bottom - 1,
      contentInsideBody: mainRect.bottom <= bodyRect.bottom + 1,
      iconSize: [Math.round(icon.getBoundingClientRect().width), Math.round(icon.getBoundingClientRect().height)],
      nestedScrollableElements: [...document.querySelectorAll('.preview-modal *')].filter((element) => {
        const style = getComputedStyle(element);
        return ['auto', 'scroll'].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).map((element) => element.className),
    };
  })()`);
  assert.equal(layout.overflowY, 'hidden', JSON.stringify(layout));
  assert.equal(layout.outerScrollable, false, JSON.stringify(layout));
  assert.equal(layout.shellFillsBody && layout.contentBelowSidebar && layout.contentInsideBody, true, JSON.stringify(layout));
  assert.ok(layout.sidebarHeight >= 120 && layout.sidebarHeight <= 150, JSON.stringify(layout));
  assert.deepEqual(layout.iconSize, [17, 17]);
  assert.deepEqual(layout.nestedScrollableElements, ['preview-document-main is-pages']);

  const scrollBeforeRender = await evaluate(`(() => {
    const main = document.querySelector('.preview-document-main');
    main.scrollTop = Math.min(300, main.scrollHeight - main.clientHeight);
    main.dataset.persistenceProbe = 'retained';
    document.querySelector('#collapse-sidebar-btn').click();
    return main.scrollTop;
  })()`);
  await waitFor(`document.querySelector('.preview-document-main')?.dataset.persistenceProbe === 'retained'`, 10_000);
  const scrollAfterRender = await evaluate(`document.querySelector('.preview-document-main').scrollTop`);
  assert.ok(scrollBeforeRender > 0, `Office preview fixture must be scrollable: ${scrollBeforeRender}`);
  assert.equal(scrollAfterRender, scrollBeforeRender, `Office preview scroll changed across render: ${scrollBeforeRender} -> ${scrollAfterRender}`);

  if (screenshotPath) {
    await evaluate(`document.querySelector('.preview-document-main').scrollTop = 0`);
    mkdirSync(path.dirname(screenshotPath), { recursive: true });
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  }

  await evaluate(`document.querySelector('#close-preview-btn').click()`);
  await waitFor(`!document.querySelector('.preview-overlay')`, 10_000);
  console.log(JSON.stringify({ passed: true, preview, layout, screenshotPath }, null, 2));
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-8000)}`);
} finally {
  cdp?.close?.();
  await terminateProcessTree(child);
  rmSync(testRoot, { recursive: true, force: true });
}

async function terminateProcessTree(handle) {
  if (!handle?.pid) return;
  if (process.platform === 'win32') {
    await terminateSpawnedProcess(handle, 1_500).catch(() => {});
    return;
  }
  try { process.kill(-handle.pid, 'SIGTERM'); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { process.kill(-handle.pid, 'SIGKILL'); } catch {}
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
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
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
