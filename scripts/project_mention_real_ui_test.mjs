import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const testHome = mkdtempSync(path.join(os.tmpdir(), 'janus-project-mention-ui-'));
const projectRoot = path.join(testHome, 'mention-project');
const port = Number(process.env.JANUS_PROJECT_MENTION_UI_PORT || 9492);
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);

mkdirSync(path.join(projectRoot, 'src', 'renderer'), { recursive: true });
writeFileSync(path.join(projectRoot, 'README.md'), '# project mention UI\n');
writeFileSync(path.join(projectRoot, 'src', 'app.js'), 'export const app = true;\n');
writeFileSync(path.join(projectRoot, 'src', 'renderer', 'panel.js'), 'export const panel = true;\n');

let projectId = '';
const runtime = await createRuntime({ root: testHome, isDev: true, serverAuthoritativeSkills: true });
try {
  projectId = runtime.createProject({ title: 'Project Mention UI', workspaceRoot: projectRoot }).id;
} finally {
  runtime.close();
}

const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_HOME: testHome,
  JANUS_AUTH_URL: '',
  JANUS_UPDATES_ENABLED: '0',
  JANUS_ENABLE_TEST_HOOKS: '1',
  JANUS_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${path.join(testHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
let cdp = null;

try {
  const target = await waitForPageTarget(port, 25_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-action="ubuddy"]')`, 25_000);
  await click(cdp, '[data-message-default-action="ubuddy"]');
  await waitForRenderer(cdp, `document.querySelector('[data-workspace-menu-toggle]')`, 15_000);

  await click(cdp, '[data-workspace-menu-toggle]');
  await waitForRenderer(cdp, `document.querySelector('[data-workspace-project="${projectId}"]')`, 10_000);
  await click(cdp, `[data-workspace-project="${projectId}"]`);
  await waitForRenderer(cdp, `document.querySelector('.project-mention-picker [data-social-mention-toggle]')`, 10_000);
  await click(cdp, '.project-mention-picker [data-social-mention-toggle]');
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-select="README.md"]') && document.querySelector('[data-project-reference-directory="src"]')`, 15_000);
  assert.equal(await evaluate(cdp, `Boolean(document.querySelector('[data-select-project-reference-workspace]'))`), false,
    'Opening @ inside a selected project should browse that project immediately.');

  await evaluate(cdp, `document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitForRenderer(cdp, `!document.querySelector('.project-mention-menu')`, 10_000);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.focus();
    input.value = '@pan';
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-select="src/renderer/panel.js"]') && document.activeElement?.id === 'chat-input'`, 15_000);
  await evaluate(cdp, `document.querySelector('#chat-input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await waitForRenderer(cdp, `document.querySelector('#chat-input')?.value.includes('@src/renderer/panel.js') && document.querySelector('.project-mention-menu') && document.activeElement?.matches('[data-project-reference-query]')`, 15_000);

  await evaluate(cdp, `(() => {
    const search = document.querySelector('[data-project-reference-query]');
    search.value = 'app';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-project-reference-select="src/app.js"]')`, 15_000);
  await evaluate(cdp, `document.querySelector('[data-project-reference-query]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await waitForRenderer(cdp, `document.querySelectorAll('.composer-reference-card.is-file').length === 2 && document.querySelector('.project-mention-menu')`, 15_000);

  const probe = await evaluate(cdp, `(() => ({
    draft: document.querySelector('#chat-input')?.value || '',
    cards: Array.from(document.querySelectorAll('.composer-reference-card.is-file')).map((item) => item.innerText || ''),
    menuOpen: Boolean(document.querySelector('.project-mention-menu')),
    searchFocused: document.activeElement?.matches('[data-project-reference-query]') || false,
    keyboardHelp: document.querySelector('.project-mention-help')?.innerText || '',
  }))()`);
  assert.ok(probe.draft.includes('@src/renderer/panel.js') && probe.draft.includes('@src/app.js'), JSON.stringify(probe));
  assert.ok(probe.cards.some((text) => text.includes('src/renderer/panel.js')) && probe.cards.some((text) => text.includes('src/app.js')), JSON.stringify(probe));
  assert.equal(probe.menuOpen && probe.searchFocused, true, JSON.stringify(probe));
  assert.match(probe.keyboardHelp, /可连续多选/);

  await evaluate(cdp, `document.querySelector('[data-project-reference-query]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await waitForRenderer(cdp, `!document.querySelector('.project-mention-menu') && document.activeElement?.id === 'chat-input'`, 10_000);
  cdp.close();
  console.log('project mention real UI test passed');
} catch (error) {
  const renderer = cdp ? await evaluate(cdp, `({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 1200), html: (document.body?.innerHTML || '').slice(0, 1200) })`).catch(() => null) : null;
  throw new Error(`${error.message}\nRenderer: ${JSON.stringify(renderer)}\nElectron stderr:\n${stderr.slice(-6000)}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
  rmSync(testHome, { recursive: true, force: true });
}

async function click(cdp, selector) {
  const point = await evaluate(cdp, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
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
  throw new Error('Timed out waiting for Electron renderer.');
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
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
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
}
