import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRuntime } from '../src/main/runtime.js';

const projectRoot = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-employee-lifecycle-ui-'));
const hangCloudCommand = process.env.JANUS_EMPLOYEE_UI_HANG_CLOUD === '1';
const commandDelayMs = 4_000;
const remoteUserId = 'employee_ui_remote_user';
const deviceId = 'employee_ui_device';
let remoteInstance = null;
let family = null;
let employeeId = '';
let memoryId = '';
let sessionId = '';
let commandRequestCount = 0;
let child = null;
let cdp = null;
let stderr = '';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/v1/employees/capabilities') {
    return json(res, 200, {
      enabled: true,
      authority: 'cloud',
      authorityLocked: true,
      contractVersion: 2,
      lifecycleMutation: 'command_only',
      profileSequenceAuthority: 'server',
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/employees') {
    return json(res, 200, employeeOverview());
  }
  if (req.method === 'POST' && url.pathname === '/v1/employees/commands') {
    commandRequestCount += 1;
    const payload = await readJson(req);
    if (hangCloudCommand) {
      await new Promise((resolve) => res.once('close', resolve));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, commandDelayMs));
    const action = String(payload.action || '');
    const previousState = remoteInstance.employmentState;
    const nextState = action === 'deactivate' ? 'inactive' : 'active';
    const now = new Date().toISOString();
    remoteInstance = {
      ...remoteInstance,
      status: nextState,
      employmentState: nextState,
      stateRevision: Number(remoteInstance.stateRevision || 1) + 1,
      deactivatedAt: nextState === 'inactive' ? now : '',
      lastStateChangedAt: now,
      updatedAt: now,
    };
    return json(res, 201, {
      status: 'confirmed',
      action,
      commandId: payload.commandId,
      instance: remoteInstance,
      event: {
        id: `employee_ui_event_${commandRequestCount}`,
        agentFamilyId: remoteInstance.agentFamilyId,
        agentInstanceId: remoteInstance.id,
        eventType: action === 'deactivate' ? 'deactivated' : 'reactivated',
        previousState,
        nextState,
        commandId: payload.commandId,
        quotaBefore: previousState === 'active' ? 1 : 0,
        quotaAfter: nextState === 'active' ? 1 : 0,
        createdAt: now,
      },
    });
  }
  return json(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
});

try {
  await listen(server);
  const cloudUrl = `http://127.0.0.1:${server.address().port}`;
  let runtime = await createRuntime({ root: testRoot, isDev: true, serverAuthoritativeSkills: true });
  try {
    family = runtime.store.listRecruitableAgentFamilies({ userId: 'local_admin' })
      .find((item) => item.id === 'general_agent')
      || runtime.store.listRecruitableAgentFamilies({ userId: 'local_admin' })[0];
    assert.ok(family?.id, 'A recruitable employee family is required for the UI test.');
    const recruited = runtime.store.recruitUserAgent({
      userId: 'local_admin', agentFamilyId: family.id, commandId: 'employee-ui-seed-recruit',
    }).instance;
    employeeId = recruited.id;
    const memory = runtime.store.listMemoryDocuments({ agentInstanceId: employeeId })[0];
    memoryId = memory.id;
    runtime.store.appendMemoryDocumentVersion({
      memoryDocumentId: memory.id,
      content: `${memory.content}\n- EMPLOYEE_UI_STORAGE_SENTINEL`,
      sourceKind: 'employee_ui_lifecycle_test',
    });
    const session = runtime.store.createSession({
      title: 'Employee lifecycle storage sentinel', userId: 'local_admin', departmentId: family.departmentId || 'general',
      agentId: family.id, agentInstanceId: employeeId, reusePrimary: false,
    });
    sessionId = session.id;
    runtime.store.addMessage({
      sessionId, role: 'user', content: 'EMPLOYEE_UI_SESSION_SENTINEL', departmentId: family.departmentId || 'general',
      agentId: family.id, agentInstanceId: employeeId,
    });
    runtime.db.prepare(`UPDATE auth_users SET remote_id=?,remote_bound_at=?,updated_at=? WHERE id='local_admin'`)
      .run(remoteUserId, new Date().toISOString(), new Date().toISOString());
    runtime.cloudSync.saveConfig({ serverUrl: cloudUrl, userId: remoteUserId, deviceId, autoSync: false });
    runtime.db.prepare(`UPDATE cloud_sync_state SET device_grant='employee-ui-grant',evolution_grant='employee-ui-grant',
      sync_schema_version=6,updated_at=? WHERE id='default'`).run(new Date().toISOString());
    remoteInstance = {
      id: recruited.id,
      agentFamilyId: recruited.agentFamilyId,
      baseAgentVersionId: recruited.baseAgentVersionId || '',
      activePersonalSkillVersionId: recruited.activePersonalSkillVersionId || '',
      status: 'active',
      instanceKind: 'employee',
      employmentState: 'active',
      quotaExempt: false,
      recruitedAt: recruited.recruitedAt || new Date().toISOString(),
      deactivatedAt: '',
      lastStateChangedAt: recruited.lastStateChangedAt || new Date().toISOString(),
      stateRevision: Number(recruited.stateRevision || 1),
      recruitmentSource: 'user',
      policyVersion: 'employee_cloud_authority_v1',
      syncEnabled: true,
      createdAt: recruited.createdAt || new Date().toISOString(),
      updatedAt: recruited.updatedAt || new Date().toISOString(),
    };
  } finally {
    await Promise.resolve(runtime.close());
    runtime = null;
  }

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
    JANUS_CLOUD_REQUEST_TIMEOUT_MS: hangCloudCommand ? '600000' : '10000',
    ELECTRON_DISABLE_SANDBOX: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronExe, [
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(testRoot, 'profile')}`,
    `--remote-debugging-port=${debuggingPort}`,
    '.',
  ], { cwd: projectRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(debuggingPort, 20_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitForRenderer(cdp, `document.querySelector('[data-app-nav="friends"]')`);
  await clickSelector(cdp, '[data-app-nav="friends"]');
  try {
    await waitForRenderer(cdp, `document.querySelector('[data-contacts-employee-card="${employeeId}"]')`, 20_000);
    await clickSelector(cdp, `[data-contacts-employee-card="${employeeId}"]`);
    await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer [data-employee-deactivate="${employeeId}"]')`);
  } catch (error) {
    const diagnostic = await evaluate(cdp, `(() => ({
      body: document.body.innerText.slice(0, 3000),
      cards: [...document.querySelectorAll('.talent-directory-card')].map((item) => item.innerText.slice(0, 500)),
      nav: document.querySelector('[data-app-nav="employees"]')?.outerHTML || '',
    }))()`);
    throw new Error(`${error.message}\nUI diagnostic: ${JSON.stringify(diagnostic)}\nElectron stderr: ${stderr.slice(-2000)}`);
  }
  await evaluate(cdp, `window.confirm = () => true`);

  const memoryCountBefore = await evaluate(cdp, `window.janus.employeeMemoryDocuments({ agentInstanceId: '${employeeId}' }).then((items) => items.length)`);
  const deactivateStartedAt = Date.now();
  await clickSelector(cdp, `.employee-overview-drawer [data-employee-deactivate="${employeeId}"]`);
  await clickSelector(cdp, '[data-app-nav="friends"]');
  await waitForRenderer(cdp, `(() => {
    return !document.querySelector('[data-contacts-employee-card="${employeeId}"]')
      && !document.querySelector('.talent-directory-card.is-busy');
  })()`, 2_000);
  const deactivateUiMs = Date.now() - deactivateStartedAt;
  assert.ok(deactivateUiMs < 1_500, `Deactivate UI waited for cloud (${deactivateUiMs}ms).`);
  assert.equal(await evaluate(cdp, `document.body.innerText.includes('正在等待云端确认停用')`), false);
  assert.equal(await evaluate(cdp, `window.janus.employeeOverview({ refreshCloud: false }).then((overview) => {
    const employee = overview.roster.find((item) => item.id === '${employeeId}');
    return employee?.employmentState === 'inactive' && employee?.authorityState === 'pending' && employee?.pendingTargetState === 'inactive';
  })`), true, 'deactivation must be locally inactive while its cloud command remains queued');
  assert.equal(commandRequestCount, 1, 'Deactivate should submit one background cloud command.');
  assert.equal(await evaluate(cdp, `window.janus.employeeMemoryDocuments({ agentInstanceId: '${employeeId}' }).then((items) => items.length)`), memoryCountBefore);

  await clickSelector(cdp, '[data-app-nav="employees"]');
  await waitForRenderer(cdp, `document.querySelector('[data-employee-market-reactivate="${employeeId}"]')`, 2_000);
  const reactivateStartedAt = Date.now();
  await clickSelector(cdp, `[data-employee-market-reactivate="${employeeId}"]`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-open-chat="${employeeId}"]') && !document.querySelector('.talent-directory-card.is-busy')`, 2_000);
  const reactivateUiMs = Date.now() - reactivateStartedAt;
  assert.ok(reactivateUiMs < 1_500, `Reactivate UI waited for cloud (${reactivateUiMs}ms).`);
  assert.equal(await evaluate(cdp, `window.janus.employeeOverview({ refreshCloud: false }).then((overview) => {
    const employee = overview.roster.find((item) => item.id === '${employeeId}');
    return employee?.employmentState === 'pending_cloud_confirmation' && employee?.authorityState === 'pending'
      && employee?.pendingTargetState === 'active' && employee?.routeEligible === true;
  })`), true, 'reactivation must restore local routing while cloud lifecycle commands remain queued');
  await clickSelector(cdp, '[data-app-nav="friends"]');
  await waitForRenderer(cdp, `document.querySelector('[data-contacts-employee-card="${employeeId}"]')?.innerText.includes('本机已启用 · 云端待同步')`, 2_000);
  await clickSelector(cdp, `[data-contacts-employee-card="${employeeId}"]`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer [data-employee-sync-retry="${employeeId}"]')`, 2_000);
  await evaluate(cdp, `document.querySelector('.employee-overview-drawer').dataset.lifecycleStabilityProbe = 'stable'`);
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 1_200))`);
  assert.equal(await evaluate(cdp, `document.querySelector('.employee-overview-drawer')?.dataset.lifecycleStabilityProbe === 'stable'`), true,
    'unchanged lifecycle polling must not rebuild the employee detail drawer');
  await clickSelector(cdp, '[data-employee-detail-close]');

  if (!hangCloudCommand) {
    await waitFor(() => commandRequestCount === 2, 8_000, 'Reactivate should submit one background cloud command.');
    await waitFor(() => remoteInstance.employmentState === 'active', 8_000, 'Cloud did not confirm reactivation.');
    await waitForRenderer(cdp, `window.janus.employeeOverview({ refreshCloud: false }).then((overview) => {
      const employee = overview.roster.find((item) => item.id === '${employeeId}');
      return employee?.employmentState === 'active' && employee?.authorityState === 'cloud_confirmed';
    })`, 8_000);
    await evaluate(cdp, `document.querySelector('[data-app-nav="friends"]')?.click()`);
    try {
      await waitForRenderer(cdp, `(() => {
        const text = document.querySelector('[data-contacts-employee-card="${employeeId}"]')?.innerText || '';
        return text && !text.includes('云端待同步') && !text.includes('状态更新中');
      })()`, 8_000);
    } catch (error) {
      const diagnostic = await evaluate(cdp, `(async () => ({
        cardText: document.querySelector('[data-contacts-employee-card="${employeeId}"]')?.innerText || '',
        employee: (await window.janus.employeeOverview({ refreshCloud: false })).roster.find((item) => item.id === '${employeeId}') || null,
      }))()`);
      throw new Error(`${error.message}\nFinal UI diagnostic: ${JSON.stringify(diagnostic)}\nRemote: ${JSON.stringify(remoteInstance)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-contacts-employee-card="${employeeId}"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer [data-employee-deactivate="${employeeId}"]')`, 5_000);
  }
  assert.equal(await evaluate(cdp, `window.janus.employeeMemoryDocuments({ agentInstanceId: '${employeeId}' }).then((items) => items.length)`), memoryCountBefore);

  cdp.close();
  cdp = null;
  await stopChild(child);
  child = null;

  const db = new DatabaseSync(path.join(testRoot, 'data', 'janus.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_documents WHERE user_agent_instance_id=?').get(employeeId).count, memoryCountBefore);
    assert.match(db.prepare('SELECT content FROM memory_document_versions WHERE memory_document_id=? ORDER BY version_no DESC LIMIT 1').get(memoryId).content, /EMPLOYEE_UI_STORAGE_SENTINEL/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=? AND agent_instance_id=?').get(sessionId, employeeId).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id=? AND content='EMPLOYEE_UI_SESSION_SENTINEL'").get(sessionId).count, 1);
    if (hangCloudCommand) {
      const local = db.prepare('SELECT employment_state,pending_target_state,authority_state FROM user_agent_instances WHERE id=?').get(employeeId);
      assert.equal(local.employment_state, 'pending_cloud_confirmation');
      assert.equal(local.pending_target_state, 'active');
      assert.equal(local.authority_state, 'pending');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employee_command_outbox WHERE local_agent_instance_id=? AND action='deactivate' AND status IN ('pending','failed','sending')").get(employeeId).count, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM employee_command_outbox WHERE local_agent_instance_id=? AND action='reactivate' AND status IN ('pending','failed','sending')").get(employeeId).count, 1);
    }
  } finally {
    db.close();
  }
  console.log(hangCloudCommand
    ? `employee hung-cloud UI e2e passed (deactivate ${deactivateUiMs}ms, reactivate ${reactivateUiMs}ms, cloud command never responded)`
    : `employee lifecycle UI e2e passed (deactivate ${deactivateUiMs}ms, reactivate ${reactivateUiMs}ms, cloud ${commandDelayMs}ms each)`);
} finally {
  try { cdp?.close(); } catch {}
  if (child) await stopChild(child);
  await new Promise((resolve) => server.close(resolve));
  server.closeAllConnections?.();
  fs.rmSync(testRoot, { recursive: true, force: true });
}

function employeeOverview() {
  const active = remoteInstance?.employmentState === 'active' ? 1 : 0;
  return {
    authority: 'cloud',
    policyVersion: 'employee_cloud_authority_v1',
    bootstrap: { required: false, status: 'completed' },
    quota: { used: active, active, reserved: 0, limit: 10, remaining: 10 - active },
    systemRoster: [],
    roster: remoteInstance ? [remoteInstance] : [],
    recruitableFamilies: family ? [{ id: family.id, name: family.name, departmentId: family.departmentId }] : [],
  };
}

function json(res, statusCode, payload) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once('error', reject);
    target.listen(0, '127.0.0.1', () => {
      target.off('error', reject);
      resolve();
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
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

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
