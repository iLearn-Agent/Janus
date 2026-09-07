import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const outputRoot = path.join(root, 'docs', 'ubuddy-core-guide', 'screenshots');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-core-guide-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const profileRoot = path.join(tempRoot, 'profile');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const port = Number(process.env.JANUS_UBUDDY_CORE_GUIDE_PORT || 9627);
const captures = [];
let child;
let cdp;
let stderr = '';

mkdirSync(outputRoot, { recursive: true });

try {
  assert.ok(existsSync(electron), `Electron binary not found: ${electron}`);
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true, requireExplicitAuthentication: true });
  runtime.authRegister({ email: 'ubuddy-core-guide@example.test', password: 'uBuddy-Core-Guide-Password1!', displayName: 'uBuddy 核心手册演示用户' });
  await runtime.authUpdateProfile({ displayName: 'uBuddy 核心手册演示用户', username: 'ubuddy_core_guide' });
  const user = runtime.currentUser();
  const workspaceId = runtime.store.activeAccountWorkspace({ userId: user.id })?.id || 'workspace_personal';
  const session = runtime.ensureSecretarySession({ accountWorkspaceId: workspaceId });
  runtime.store.addMessage({ id: 'core-user', sessionId: session.id, role: 'user', content: '请帮我发布一项市场研究任务。', agentId: 'secretary_agent', departmentId: 'secretary_department' });
  runtime.store.addMessage({ id: 'core-assistant', sessionId: session.id, role: 'assistant', content: '我会先确认执行方，再创建任务。', agentId: 'secretary_agent', departmentId: 'secretary_department' });
  await runtime.close();

  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', JANUS_HOME: runtimeRoot, JANUS_AUTH_URL: '', JANUS_CLOUD_AUTO_SYNC_ENABLED: '0', JANUS_MODEL_REFRESH_ENABLED: '0', JANUS_LOCAL_EVOLUTION_ENABLED: '0', JANUS_UPDATES_ENABLED: '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electron, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${port}`, '.'], { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForTarget(port, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await setViewport(1600, 1000);
  await evaluate(`localStorage.setItem('janus-language-mode', 'zh-CN'); localStorage.setItem('janus-theme-mode', 'light'); location.reload()`);
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);

  await captureSingleContactPublish(session.id);
  await capturePublishedTaskCard(session.id);

  writeFileSync(path.join(outputRoot, 'capture-index.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), captures }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, outputRoot, captures: captures.map((item) => ({ filename: item.filename, controls: item.controls.length })) }, null, 2));
} catch (error) {
  console.error(error?.stack || error);
  if (stderr.trim()) console.error(stderr.slice(-5000));
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch {}
  await stopChild(child);
  rmSync(tempRoot, { recursive: true, force: true });
}

async function captureSingleContactPublish(sessionId) {
  await setState(`
    state.currentTab = 'chat'; state.networkPanelOpen = true; state.networkPanelView = 'messages'; state.networkMessageHomeOpen = false;
    state.currentSessionId = ${JSON.stringify(sessionId)}; state.currentDepartmentId = 'secretary_department'; state.currentAgentId = 'secretary_agent'; state.homeMode = 'secretary';
    state.uBuddyFeatureFlags = { ...(state.uBuddyFeatureFlags || {}), messageModeV1: true, structuredTaskReference: true };
    state.uBuddyMessageMode = 'task'; state.chatRuns = []; state.activeChatRun = null; state.attachments = [];
    state.friendOverview = { ...(state.friendOverview || {}), friends: [
      { id: 'friend-linran', status: 'accepted', online: true, friend: { id: 'core-peer-linran', displayName: '林然', username: 'linran' } },
      { id: 'friend-zhouning', status: 'accepted', online: false, friend: { id: 'core-peer-zhouning', displayName: '周宁', username: 'zhouning' } }
    ] };
    state.messages = [
      { id: 'core-contact-user', sessionId: ${JSON.stringify(sessionId)}, role: 'user', content: '请让林然完成竞品研究，并提交一份可编辑报告。', createdAt: '2026-08-17T02:00:00.000Z', metadata: {} },
      { id: 'core-contact-target', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '', createdAt: '2026-08-17T02:00:03.000Z', metadata: { secretaryControl: true, dispatchClarification: true, uBuddyPlanningCheckpoint: { planningSessionId: 'core-contact-plan', revision: 1 }, clarifications: [{ id: 'executionTarget', question: '这项任务由本机 Agent 完成，还是交给联系人？', answerType: 'execution_target', required: true }] } }
    ];
    state.uBuddyContactPickerOnly = true; state.socialMentionMenuOpen = true; state.composerMentionQuery = ''; state.composerMentionActiveIndex = 0;
    state.chatDraft = '由该联系人完成刚才讨论的任务。'; state.composerMentions = []; state.secretaryMentions = [];
  `);
  await forceRender();
  await setState(`
    state.friendOverview = { ...(state.friendOverview || {}), friends: [
      { id: 'friend-linran', status: 'accepted', online: true, friend: { id: 'core-peer-linran', displayName: '林然', username: 'linran' } },
      { id: 'friend-zhouning', status: 'accepted', online: false, friend: { id: 'core-peer-zhouning', displayName: '周宁', username: 'zhouning' } }
    ] };
    state.uBuddyContactPickerOnly = true; state.socialMentionMenuOpen = true; state.composerMentionQuery = ''; state.chatDraft = '由该联系人完成刚才讨论的任务。';
  `);
  await forceRender();
  await waitFor(`document.querySelector('.ubuddy-execution-target-card') && document.querySelector('.social-mention-menu.is-contact-only')`);
  await capture('03-single-contact-publish.png', '.conversation-panel');
}

async function capturePublishedTaskCard(sessionId) {
  await setState(`
    state.uBuddyContactPickerOnly = false; state.socialMentionMenuOpen = false; state.chatDraft = ''; state.composerMentions = []; state.secretaryMentions = [];
    state.agentDelegations = [{ id: 'core-published-task', requesterUserId: state.currentUser.id, recipientUserId: 'core-peer-linran', title: '竞品研究与结论报告', instruction: '完成三家竞品研究并提交可编辑报告。', status: 'working', recipient: { id: 'core-peer-linran', displayName: '林然' }, metadata: { executionProgress: { phase: 'executing', message: '正在整理竞品差异与引用来源', completed: 2, total: 4, nodes: [{ id: 'scope', title: '确认研究范围', status: 'completed' }, { id: 'collect', title: '收集公开资料', status: 'completed' }, { id: 'compare', title: '整理竞品差异', status: 'running' }] } } }];
    state.messages = [
      { id: 'core-task-user', sessionId: ${JSON.stringify(sessionId)}, role: 'user', content: '@林然 完成三家竞品研究并提交可编辑报告。', createdAt: '2026-08-17T02:10:00.000Z', metadata: {} },
      { id: 'core-task-published', sessionId: ${JSON.stringify(sessionId)}, role: 'assistant', content: '任务已经发布给林然。', createdAt: '2026-08-17T02:10:04.000Z', metadata: { secretaryControl: true, publishedTaskCards: [{ delegationId: 'core-published-task', taskWorkspaceId: 'core-published-task', workspaceKind: 'delegation', title: '竞品研究与结论报告', instruction: '完成三家竞品研究并提交可编辑报告。', status: 'working' }] } }
    ];
  `);
  await forceRender();
  await waitFor(`document.querySelector('.ubuddy-published-task-card, .collaboration-card[data-task-workspace-id="core-published-task"]')`);
  await scrollTo('.ubuddy-published-task-card, .collaboration-card[data-task-workspace-id="core-published-task"]');
  await capture('05-published-task-card.png', '.ubuddy-published-task-card, .collaboration-card[data-task-workspace-id="core-published-task"]');
}

async function capture(filename, selector, filter = null) {
  await sleep(200);
  const metadata = await evaluate(`(() => {
    const visible = (element) => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
    const roots = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const controls = [...new Set(roots.flatMap((root) => [...root.querySelectorAll('button, summary, [role="button"], [role="option"], [role="menuitem"], input:not([type="hidden"]), textarea')]))].map((element) => { const r = element.getBoundingClientRect(); return { label: (element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || element.value || element.tagName).replace(/\\s+/g, ' ').trim().slice(0, 100), tag: element.tagName.toLowerCase(), disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'), visible: visible(element), x: Math.max(0, Math.min(100, ((r.left + r.width / 2) / innerWidth) * 100)), y: Math.max(0, Math.min(100, ((r.top + r.height / 2) / innerHeight) * 100)), width: r.width, height: r.height, attributes: Object.fromEntries([...element.attributes].filter((a) => a.name.startsWith('data-') || ['id','type','role'].includes(a.name)).map((a) => [a.name, a.value])) }; });
    return { viewport: { width: innerWidth, height: innerHeight }, controls };
  })()`);
  let controls = metadata.controls;
  if (filter) controls = controls.filter(filter);
  controls = controls.map((control, index) => ({ ...control, number: index + 1 }));
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(outputRoot, filename), Buffer.from(image.data, 'base64'));
  captures.push({ filename, viewport: metadata.viewport, controls });
}

async function setState(source) { await evaluate(`(async () => { const { state } = await import('./app/state.js'); ${source} })()`); }
async function forceRender() { const viewport = await evaluate(`({ width: innerWidth, height: innerHeight })`); await cdp.send('Emulation.setDeviceMetricsOverride', { width: 700, height: viewport.height, deviceScaleFactor: 1, mobile: false }); await sleep(150); await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false }); await sleep(350); }
async function evaluate(expression) { const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
async function waitFor(expression, timeout = 12_000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await sleep(100); } throw new Error(`Timed out waiting for ${expression}`); }
async function scrollTo(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`); await sleep(250); }
async function setViewport(width, height) { await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(250); }
async function waitForTarget(debugPort, timeout) { const end = Date.now() + timeout; while (Date.now() < end) { try { const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`); const pages = await response.json(); const page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl); if (page) return page; } catch {} await sleep(200); } throw new Error('Timed out waiting for Electron renderer.'); }
async function connectCdp(url) { const socket = new WebSocket(url); const pending = new Map(); let id = 1; await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result || {}); }); return { send(method, params = {}) { const next = id++; return new Promise((resolve, reject) => { pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); }); }, close() { socket.close(); } }; }
async function stopChild(handle) { if (!handle || handle.exitCode !== null) return; try { if (process.platform !== 'win32') process.kill(-handle.pid, 'SIGTERM'); else handle.kill('SIGTERM'); } catch {} await Promise.race([new Promise((resolve) => handle.once('exit', resolve)), sleep(2500)]); if (handle.exitCode === null) { try { if (process.platform !== 'win32') process.kill(-handle.pid, 'SIGKILL'); else handle.kill('SIGKILL'); } catch {} } }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
