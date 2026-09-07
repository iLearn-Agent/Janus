import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const projectRoot = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-employee-profile-rename-'));
const accountEmail = 'employee-profile-rename@example.test';
const accountPassword = 'employee-profile-rename-password';
const renamedDisplayName = 'Research Owner';
const renamedNote = 'Owns research and evidence review.';
let employeeId = '';
let child = null;
let cdp = null;
let stderr = '';

try {
  const runtime = await createRuntime({ root: testRoot, isDev: true, serverAuthoritativeSkills: true });
  try {
    const verification = runtime.authSendEmailCode({ email: accountEmail, purpose: 'register', method: 'email' });
    const account = runtime.authRegister({
      email: accountEmail, password: accountPassword, displayName: 'Employee Profile Rename', code: verification.devCode,
    });
    const userId = account.user.id;
    const family = runtime.store.listRecruitableAgentFamilies({ userId })
      .find((item) => item.id === 'general_agent')
      || runtime.store.listRecruitableAgentFamilies({ userId })[0];
    assert.ok(family?.id, 'A recruitable employee family is required for the profile rename test.');
    employeeId = runtime.store.recruitUserAgent({
      userId, agentFamilyId: family.id, commandId: 'employee-profile-rename-seed',
    }).instance.id;
    await runtime.authLogout();
  } finally {
    await Promise.resolve(runtime.close());
  }

  ({ child, cdp } = await launchElectron());
  await ensureLoggedIn(cdp);
  await openEmployeeProfile(cdp);
  await evaluate(cdp, `(() => {
    const form = document.querySelector('[data-employee-profile-form="${employeeId}"]');
    form.closest('details').open = true;
    form.elements.displayName.value = ${JSON.stringify(renamedDisplayName)};
    form.elements.note.value = ${JSON.stringify(renamedNote)};
  })()`);
  await clickSelector(cdp, `[data-employee-profile-form="${employeeId}"] button[type="submit"]`);
  await waitForRenderer(cdp, `window.janus.employeeOverview({ refreshCloud: false }).then((overview) => {
    const employee = overview.roster.find((item) => item.id === '${employeeId}');
    return employee?.displayName === ${JSON.stringify(renamedDisplayName)}
      && employee?.note === ${JSON.stringify(renamedNote)};
  })`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer > header h2')?.textContent === ${JSON.stringify(renamedDisplayName)}`);
  assert.equal(await evaluate(cdp, `document.querySelector('.app-notice.error')?.textContent || ''`), '');
  cdp.close();
  cdp = null;
  await stopChild(child);
  child = null;

  ({ child, cdp } = await launchElectron());
  await ensureLoggedIn(cdp);
  await waitForRenderer(cdp, `window.janus.employeeOverview({ refreshCloud: false }).then((overview) => {
    const employee = overview.roster.find((item) => item.id === '${employeeId}');
    return employee?.displayName === ${JSON.stringify(renamedDisplayName)}
      && employee?.note === ${JSON.stringify(renamedNote)};
  })`);
  await clickSelector(cdp, '[data-app-nav="friends"]');
  await waitForRenderer(cdp, `document.querySelector('[data-contacts-employee-card="${employeeId}"]')?.innerText.includes(${JSON.stringify(renamedDisplayName)})`);

  console.log('employee profile rename UI smoke passed');
} finally {
  try { cdp?.close(); } catch {}
  if (child) await stopChild(child);
  fs.rmSync(testRoot, { recursive: true, force: true });
}

async function launchElectron() {
  const debuggingPort = await freePort();
  const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const env = {
    ...process.env,
    JANUS_HOME: testRoot,
    JANUS_AUTH_URL: '',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_AGENT_UPDATES_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
    JANUS_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
    ELECTRON_DISABLE_SANDBOX: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  stderr = '';
  const processHandle = spawn(electronExe, [
    '--no-sandbox', '--disable-gpu', `--user-data-dir=${path.join(testRoot, 'profile')}`,
    `--remote-debugging-port=${debuggingPort}`, '.',
  ], { cwd: projectRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
  processHandle.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const target = await waitForPageTarget(debuggingPort, 20_000);
  const connection = await connectCdp(target.webSocketDebuggerUrl);
  await connection.send('Runtime.enable');
  try {
    await waitForRenderer(connection, `document.querySelector('#login-form, [data-app-nav="friends"]')`);
  } catch (error) {
    const diagnostic = await evaluate(connection, `({
      url: location.href,
      title: document.title,
      body: document.body?.innerText?.slice(0, 3000) || '',
      hasBridge: Boolean(window.janus),
    })`).catch(() => null);
    throw new Error(`${error.message}\nLaunch diagnostic: ${JSON.stringify(diagnostic)}\nElectron stderr: ${stderr.slice(-3000)}`);
  }
  return { child: processHandle, cdp: connection };
}

async function ensureLoggedIn(target) {
  if (!await evaluate(target, `Boolean(document.querySelector('#login-form'))`)) return;
  await evaluate(target, `(() => {
    const identifier = document.querySelector('#login-identifier');
    const password = document.querySelector('#login-password');
    identifier.value = ${JSON.stringify(accountEmail)};
    password.value = ${JSON.stringify(accountPassword)};
    identifier.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#login-form').requestSubmit();
  })()`);
  await waitForRenderer(target, `document.querySelector('[data-app-nav="friends"]') && !document.querySelector('#login-form')`, 20_000);
}

async function openEmployeeProfile(target) {
  await clickSelector(target, '[data-app-nav="friends"]');
  await waitForRenderer(target, `document.querySelector('[data-contacts-employee-card="${employeeId}"]')`);
  await clickSelector(target, `[data-contacts-employee-card="${employeeId}"]`);
  await waitForRenderer(target, `document.querySelector('[data-employee-profile-form="${employeeId}"]')`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function clickSelector(target, selector) {
  const point = await evaluate(target, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`UI element is not clickable: ${selector}`);
  await target.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await target.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function evaluate(target, expression) {
  const result = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(target, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(target, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron renderer did not start: ${stderr.slice(-2000)}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

async function stopChild(target) {
  if (!target || target.exitCode !== null) return;
  target.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => target.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_500)),
  ]);
  if (target.exitCode === null) target.kill('SIGKILL');
}
