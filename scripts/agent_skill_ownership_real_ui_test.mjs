import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { backup, DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const outputDirectory = '/path/to/ui-pictures';
const testHome = mkdtempSync(path.join(os.tmpdir(), 'janus-agent-skill-ownership-real-ui-'));
const currentDatabase = path.join(root, 'workspace', 'data', 'janus.db');
const targetDatabase = path.join(testHome, 'data', 'janus.db');
const agentInstanceId = 'uagent_4b810c62-717c-445d-87d0-5944f91f2a64';
const expectedUserId = 'user_6968dc2d-bce9-49d0-afac-010f4a3d0b9f';
const screenshotPath = path.join(outputDirectory, 'agentA-skill-ownership-fixed.png');
const renameDialogScreenshotPath = path.join(outputDirectory, 'agentA-memory-rename-dialog.png');
const renamedMemoryScreenshotPath = path.join(outputDirectory, 'agentA-memory-renamed-memory0.png');
const port = Number(process.env.JANUS_AGENT_SKILL_UI_PORT || 9491);
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

mkdirSync(path.dirname(targetDatabase), { recursive: true });
mkdirSync(outputDirectory, { recursive: true });
for (const filePath of [screenshotPath, renameDialogScreenshotPath, renamedMemoryScreenshotPath]) rmSync(filePath, { force: true });
const currentDb = new DatabaseSync(currentDatabase, { readOnly: true });
const syncFixture = currentDb.prepare("SELECT user_id,device_id,server_url,token,device_grant,evolution_grant FROM cloud_sync_state WHERE id='default'").get();
await backup(currentDb, targetDatabase);
currentDb.close();
copyFileSync(path.join(root, 'workspace', 'data', 'task-memory-device-key.json'), path.join(testHome, 'data', 'task-memory-device-key.json'));

assert.equal(syncFixture?.user_id, expectedUserId);
assert.ok(syncFixture?.device_grant, 'The account Device Grant fixture is required.');
const isolatedDb = new DatabaseSync(targetDatabase);
isolatedDb.prepare("UPDATE app_settings SET value=? WHERE key='auth:active_user_id'").run(expectedUserId);
isolatedDb.prepare("UPDATE cloud_auth_state SET server_url='',access_token='',refresh_token='',remote_user_id='',enabled=0,last_error='' WHERE id='default'").run();
isolatedDb.prepare(`UPDATE cloud_sync_state SET user_id=?,device_id=?,server_url=?,token=?,auto_sync=0,
  last_sync_cursor='',last_v6_cursor='',last_success_at='',last_error='',device_grant=?,evolution_grant=? WHERE id='default'`)
  .run(syncFixture.user_id, syncFixture.device_id, syncFixture.server_url, syncFixture.token,
    syncFixture.device_grant, syncFixture.evolution_grant || syncFixture.device_grant);
const activeUserId = isolatedDb.prepare("SELECT value FROM app_settings WHERE key='auth:active_user_id'").get()?.value || '';
const localInstance = isolatedDb.prepare('SELECT id,user_id,status,employment_state FROM user_agent_instances WHERE id=?').get(agentInstanceId);
assert.equal(activeUserId, expectedUserId);
assert.equal(localInstance?.user_id, expectedUserId);
assert.equal(localInstance?.status, 'active');
const activeMemoryId = isolatedDb.prepare(`SELECT active_memory_document_id FROM agent_context_state
  WHERE user_id=? AND account_workspace_id='workspace_personal' AND user_agent_instance_id=?`).get(expectedUserId, agentInstanceId)?.active_memory_document_id || '';
assert.ok(activeMemoryId, 'The account Agent A active Memory fixture is required.');
isolatedDb.close();
let renamedMemoryId = activeMemoryId;

const env = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_HOME: testHome,
  JANUS_AUTH_URL: '',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_UPDATES_ENABLED: '0',
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${path.join(testHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 30_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1420, height: 920, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const startupProbe = await evaluate(cdp, `({ title: document.title, text: (document.body?.innerText || '').slice(0, 1000), html: document.body?.className || '' })`);
  if (!await evaluate(cdp, `Boolean(document.querySelector('[data-tab="employees"]'))`)) {
    throw new Error(`Unexpected startup surface: ${JSON.stringify(startupProbe)}`);
  }
  await click(cdp, '[data-tab="employees"]');
  await waitForRenderer(cdp, `document.querySelector('[data-employee-installed-context="${agentInstanceId}"]')`, 30_000);
  await openEmployeeContextMenu(cdp, agentInstanceId);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-context-action="memory"]')`, 10_000);
  await click(cdp, '[data-employee-context-action="memory"]');
  await waitForRenderer(cdp, `document.querySelector('.employee-memory-drawer') && !document.querySelector('.employee-memory-drawer .employee-drawer-loading')`, 30_000);
  const renderedMemory = await evaluate(cdp, `(() => {
    const button = document.querySelector('[data-employee-memory-rename]');
    return button ? { id: button.dataset.employeeMemoryRename || '', name: button.dataset.memoryName || '' } : null;
  })()`);
  assert.ok(renderedMemory?.id, `Memory rename control was not rendered: ${JSON.stringify(await evaluate(cdp, `document.querySelector('.employee-memory-drawer')?.innerText || ''`))}`);
  renamedMemoryId = renderedMemory.id;
  await click(cdp, `[data-employee-memory-rename="${renamedMemoryId}"]`);
  await waitForRenderer(cdp, `document.querySelector('#memory-name-form') && document.querySelector('#memory-name-title')?.textContent === '重命名 Memory'`, 10_000);
  assert.equal(await evaluate(cdp, `document.querySelector('#memory-name-input')?.value`), renderedMemory.name);
  await captureScreenshot(cdp, renameDialogScreenshotPath);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#memory-name-input');
    input.value = 'memory0-rename-check.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#memory-name-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `!document.querySelector('#memory-name-form') && document.querySelector('.employee-memory-drawer')?.innerText.includes('memory0-rename-check.md')`, 30_000);
  await click(cdp, `[data-employee-memory-rename="${renamedMemoryId}"]`);
  await waitForRenderer(cdp, `document.querySelector('#memory-name-input')?.value === 'memory0-rename-check.md'`, 10_000);
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#memory-name-input');
    input.value = 'memory0.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#memory-name-form').requestSubmit();
  })()`);
  await waitForRenderer(cdp, `!document.querySelector('#memory-name-form') && document.querySelector('.employee-memory-drawer')?.innerText.includes('memory0.md')`, 30_000);
  assert.equal(await evaluate(cdp, `document.querySelector('[data-employee-memory-rename="${renamedMemoryId}"]')?.closest('.employee-memory-document-row')?.querySelector('strong')?.textContent || ''`), 'memory0.md');
  await captureScreenshot(cdp, renamedMemoryScreenshotPath);
  await click(cdp, `[data-employee-detail-tab="skill"]`);
  await waitForRenderer(cdp, `document.querySelector('.employee-market-drawer') && !document.querySelector('.employee-market-drawer .employee-drawer-loading')`, 45_000);
  const probe = await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-market-drawer');
    const text = drawer?.innerText || '';
    return {
      title: drawer?.querySelector('h2')?.textContent || '',
      error: drawer?.querySelector('.employee-drawer-error')?.innerText || '',
      belongsError: text.includes('Agent instance does not belong to this user.'),
      hasSkillSurface: text.includes('Skill 版本') && (text.includes('市场版本') || text.includes('当前有效 Skill') || text.includes('暂无可用')),
    };
  })()`);
  assert.equal(probe.title, 'Skill 版本');
  assert.equal(probe.error, '');
  assert.equal(probe.belongsError, false);
  assert.equal(probe.hasSkillSurface, true);
  await captureScreenshot(cdp, screenshotPath);
  const verifiedDb = new DatabaseSync(targetDatabase, { readOnly: true });
  const grant = verifiedDb.prepare("SELECT device_grant,evolution_grant,user_id FROM cloud_sync_state WHERE id='default'").get();
  const renamedMemory = verifiedDb.prepare('SELECT display_name FROM memory_documents WHERE id=?').get(renamedMemoryId);
  verifiedDb.close();
  assert.equal(grant.user_id, expectedUserId);
  assert.equal(grant.device_grant, grant.evolution_grant);
  assert.equal(renamedMemory?.display_name, 'memory0.md');
  cdp.close();
  console.log(`Agent A Skill ownership real UI test passed: ${screenshotPath}`);
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-8000)}`);
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

async function openEmployeeContextMenu(cdp, instanceId) {
  await evaluate(cdp, `(() => {
    const item = document.querySelector('[data-employee-installed-context="${instanceId}"]');
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20 }));
  })()`);
}

async function captureScreenshot(cdp, filePath) {
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(filePath, Buffer.from(screenshot.data, 'base64'));
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
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 220));
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
