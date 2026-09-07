import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createRuntime } from '../src/main/runtime.js';
import { databaseMigrationIdsForVersion } from '../src/main/modules/persistence/index.js';

const projectRoot = process.cwd();
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-recovery-ui-'));
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
let sessionId = '';
let messageId = '';
let child = null;
let cdp = null;
let stderr = '';

try {
  const runtime = await createRuntime({ root: testRoot, isDev: true });
  try {
    const user = runtime.currentUser();
    const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' });
    assert.ok(instance, 'default general Agent instance is required');
    const session = runtime.store.createSession({
      title: '数据库恢复真实按钮测试',
      departmentId: 'general',
      agentId: 'general_agent',
      agentInstanceId: instance.id,
      userId: user.id,
      reusePrimary: false,
    });
    sessionId = session.id;
    const message = runtime.store.addMessage({
      sessionId,
      role: 'user',
      content: 'RECOVERY_UI_E2E_PRESERVE_ME',
      agentId: 'general_agent',
      agentInstanceId: instance.id,
    });
    messageId = message.id;
  } finally {
    await Promise.resolve(runtime.close());
  }

  const databasePath = path.join(testRoot, 'data', 'janus.db');
  const applicableMigrationIds = databaseMigrationIdsForVersion('0.2.15');
  const pendingIds = applicableMigrationIds.slice(-4);
  assert.equal(pendingIds.length, 4, 'the recovery UI test requires four migrations');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const removeMigration = legacy.prepare('DELETE FROM schema_migrations WHERE id=?');
    for (const id of pendingIds) removeMigration.run(id);
  } finally {
    legacy.close();
  }

  const port = await freePort();
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: testRoot,
    JANUS_TEST_RECOVERY_NO_RESTART: '1',
    JANUS_TEST_RECOVERY_PROGRESS_DELAY_MS: '80',
    JANUS_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_AGENT_UPDATES_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronExe, [
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${path.join(testRoot, 'profile')}`,
    `--remote-debugging-port=${port}`,
    '.',
    '--repair-database',
  ], { cwd: projectRoot, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(port, 20_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await waitFor(cdp, `document.querySelector('#recommendedButton')?.textContent === 'Quick Repair & Restart'`, 20_000);
  const englishLanguageControl = await evaluate(cdp, `(() => ({
    label: document.querySelector('#languageToggleLabel')?.textContent || '',
    title: document.querySelector('#languageToggleButton')?.title || '',
  }))()`);
  assert.deepEqual(englishLanguageControl, { label: 'EN', title: '切换至中文' });
  await evaluate(cdp, `document.querySelector('#languageToggleButton')?.click()`);
  await waitFor(cdp, `document.querySelector('#recommendedButton')?.textContent === '快速修复并重新启动'`, 20_000);

  const before = await evaluate(cdp, `(() => ({
    badge: document.querySelector('#statusBadge')?.textContent || '',
    detail: document.querySelector('#statusDetail')?.textContent || '',
    disabled: Boolean(document.querySelector('#recommendedButton')?.disabled),
  }))()`);
  assert.equal(before.badge, '可以自动修复');
  assert.match(before.detail, /4 项待迁移结构/);
  assert.equal(before.disabled, false);
  assert.equal(await evaluate(cdp, `document.querySelector('#languageToggleLabel')?.textContent`), '中');

  await evaluate(cdp, `(() => {
    window.__recoveryProgressEvents = [];
    window.janusRecovery.onProgress((progress) => window.__recoveryProgressEvents.push(progress));
    document.querySelector('#recommendedButton')?.click();
  })()`);
  await waitFor(cdp, `document.querySelector('#repairProgress')?.hidden === false`, 2_000);
  const immediate = await evaluate(cdp, `(() => ({
    percent: document.querySelector('#progressPercent')?.textContent || '',
    stage: document.querySelector('#progressStage')?.textContent || '',
    disabled: Boolean(document.querySelector('#recommendedButton')?.disabled),
  }))()`);
  assert.equal(immediate.disabled, true, 'the clicked repair button must immediately enter a busy state');
  assert.match(immediate.percent, /%$/);
  assert.ok(immediate.stage, 'the clicked repair button must immediately show progress text');

  const progressSamples = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, `(() => ({
      percent: document.querySelector('#progressPercent')?.textContent || '',
      stage: document.querySelector('#progressStage')?.textContent || '',
      result: document.querySelector('#operationResult')?.textContent || '',
      badge: document.querySelector('#statusBadge')?.textContent || '',
    }))()`);
    const sample = `${state.percent}:${state.stage}`;
    if (sample !== progressSamples.at(-1)) progressSamples.push(sample);
    if (state.result.includes('"status": "repaired"') && state.percent === '100%') break;
    await delay(100);
  }

  const after = await evaluate(cdp, `(() => ({
    percent: document.querySelector('#progressPercent')?.textContent || '',
    stage: document.querySelector('#progressStage')?.textContent || '',
    result: document.querySelector('#operationResult')?.textContent || '',
    badge: document.querySelector('#statusBadge')?.textContent || '',
    events: window.__recoveryProgressEvents || [],
  }))()`);
  assert.equal(after.percent, '100%', `repair did not complete; progress=${JSON.stringify(progressSamples)} stderr=${stderr.slice(-2000)}`);
  assert.match(after.result, /"status": "repaired"/);
  const observedStages = after.events.map((item) => String(item?.stage || ''));
  assert.deepEqual(observedStages, ['queued', 'inspect', 'backup', 'copy', 'migrate', 'validate', 'checkpoint', 'replace', 'complete']);
  assert.ok(progressSamples.some((sample) => !sample.startsWith('0%:') && !sample.startsWith('100%:')),
    `real recovery UI did not visibly advance before completion: ${JSON.stringify(progressSamples)}`);

  const repaired = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(String(repaired.prepare('PRAGMA integrity_check').get()?.integrity_check || ''), 'ok');
    const applied = new Set(repaired.prepare('SELECT id FROM schema_migrations').all().map((row) => String(row.id)));
    assert.deepEqual(applicableMigrationIds.filter((id) => !applied.has(id)), []);
    assert.equal(Number(repaired.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get(sessionId)?.count || 0), 1);
    const message = repaired.prepare('SELECT content FROM messages WHERE id=?').get(messageId);
    assert.equal(String(message?.content || ''), 'RECOVERY_UI_E2E_PRESERVE_ME');
  } finally {
    repaired.close();
  }

  process.stdout.write(`Electron real database recovery button e2e passed. Progress: ${progressSamples.join(' -> ')}\n`);
} finally {
  try { cdp?.close(); } catch {}
  if (child && child.exitCode == null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode == null) child.kill('SIGKILL');
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(`Electron recovery process exited before creating a window (code ${child.exitCode}): ${stderr.slice(-2000)}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
      const page = targets.find((item) => item.type === 'page' && item.url.includes('/recovery/index.html') && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(100);
  }
  throw new Error(`Electron recovery renderer did not start: ${stderr.slice(-2000)}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || 'CDP error'));
    else request.resolve(message.result || {});
  });
  return {
    send(method, params = {}) {
      const id = ++sequence;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for renderer condition: ${expression}; stderr=${stderr.slice(-2000)}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
