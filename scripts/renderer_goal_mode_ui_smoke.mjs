import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-goal-mode-ui-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const goalSession = {
  id: 'goal_ui_session', title: '目标模式会话', departmentId: 'general', agentId: '', interactionMode: 'goal',
  goal: { objective: '持续整理推荐系统选题', status: 'active', tokensUsed: 12000, tokenBudget: 100000, timeUsedSeconds: 610 },
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-30T09:00:00.000Z',
};
const legacySession = {
  id: 'legacy_mode_session', title: '历史普通会话', departmentId: 'general', agentId: '', interactionMode: 'plan',
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-30T09:01:00.000Z',
};
const legacyMessage = {
  id: 'legacy_mode_message', sessionId: legacySession.id, role: 'assistant', content: '这是一条历史回复，应按普通消息展示。',
  createdAt: '2026-07-30T09:02:00.000Z', metadata: { interactionMode: 'plan', plan: { steps: [{ step: '历史步骤', status: 'pending' }] } },
};
const sessions = [goalSession, legacySession];
const bootstrap = {
  root: tempRoot, org: { departments: [], agents: [], hrs: [] }, sessions, projects: [], tasks: [],
  agentStatuses: [], evolution: null, currentUser: { id: 'goal_user', displayName: '目标模式用户', role: 'member', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [],
  agentDelegations: [], collaborationOverview: { groups: [], tasks: [] }, socialStatus: { enabled: false, connected: false },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null,
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', contextWindowTokens: 128000, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
  employeeOverview: { capabilities: { multiMemory: { enabled: false, readOnly: true } }, quota: { used: 0, limit: 10 }, roster: [], recruitableFamilies: [] },
  userAgentSettings: [], personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null,
};
const htmlPath = path.join(tempRoot, 'renderer-goal-mode-smoke.html');
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__goalModeSmoke={errors:[],goalActions:[]};
window.addEventListener('error',(event)=>window.__goalModeSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__goalModeSmoke.errors.push(String(event.reason?.stack||event.reason)));
const sessions=${JSON.stringify(sessions)};
const base={
 bootstrap:async()=>(${JSON.stringify(bootstrap)}),listSessions:async()=>sessions,
 listMessages:async(sessionId)=>sessionId===${JSON.stringify(legacySession.id)}?[${JSON.stringify(legacyMessage)}]:[],
 listMessagePage:async({sessionId})=>({items:sessionId===${JSON.stringify(legacySession.id)}?[${JSON.stringify(legacyMessage)}]:[],nextCursor:null,hasMore:false}),chatContextStatus:async()=>null,
 updateSession:async(payload)=>{const session=sessions.find((item)=>item.id===payload.sessionId);if(session)Object.assign(session,payload);return session||payload;},
 updateGoal:async(payload)=>{window.__goalModeSmoke.goalActions.push(payload);const session=sessions.find((item)=>item.id===payload.sessionId);if(payload.action==='pause')session.goal.status='paused';if(payload.action==='resume')session.goal.status='active';if(payload.action==='edit')session.goal.objective=payload.objective;if(payload.action==='delete')session.goal=null;return session;},
 updateStatus:async()=>({enabled:false}),agentUpdateStatus:async()=>({enabled:false}),pptxPluginStatus:async()=>({installed:true,available:true}),
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `document.querySelector('#sidebar-chat-search-trigger')`);
  await openSession(browserWindow, goalSession.id);
  await waitFor(browserWindow, `document.querySelector('.goal-status-card') && document.querySelector('#chat-form')`);
  const goalSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-composer-tool-menu-toggle]')?.click();
    const menu=document.querySelector('.composer-tool-menu');
    return {card:document.querySelector('.goal-status-card')?.innerText||'',menu:menu?.innerText||'',goal:Boolean(document.querySelector('[data-composer-interaction-mode="goal"]')),legacyMode:Boolean(document.querySelector('[data-composer-interaction-mode="plan"]')),errors:window.__goalModeSmoke.errors};
  })()`);
  assert.match(goalSnapshot.card, /进行中的目标/);
  assert.match(goalSnapshot.card, /已用 12K Token/);
  assert.doesNotMatch(goalSnapshot.card, /100K|Token 预算/);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelectorAll('[data-goal-action]').length`), 3);
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-goal-expand]'))`), true);
  assert.equal(goalSnapshot.goal, true);
  assert.equal(goalSnapshot.legacyMode, true);
  assert.match(goalSnapshot.menu, /计划模式/);
  assert.deepEqual(goalSnapshot.errors, []);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-composer-tool-menu-toggle]')?.click();document.querySelector('[data-goal-expand]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.goal-status-details')?.innerText.includes('已推进 10 分钟')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-goal-expand]')?.click();document.querySelector('[data-goal-action="pause"]')?.click()`);
  await waitFor(browserWindow, `window.__goalModeSmoke.goalActions.some((item)=>item.action==='pause') && document.querySelector('[data-goal-action="resume"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-goal-action="edit"]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('[data-goal-editor-input]')`);
  await browserWindow.webContents.executeJavaScript(`(() => {const input=document.querySelector('[data-goal-editor-input]');input.value='编辑后的目标标题';document.querySelector('[data-goal-editor-form]').requestSubmit();})()`);
  await waitFor(browserWindow, `window.__goalModeSmoke.goalActions.some((item)=>item.action==='edit'&&item.objective==='编辑后的目标标题') && document.body.innerText.includes('编辑后的目标标题')`);

  await openSession(browserWindow, legacySession.id);
  await waitFor(browserWindow, `document.body.innerText.includes('这是一条历史回复，应按普通消息展示。')`);
  const legacySnapshot = await browserWindow.webContents.executeJavaScript(`(() => ({
    text:document.body.innerText,
    indicator:Boolean(document.querySelector('.composer-interaction-indicator')),
    specialView:Boolean(document.querySelector('[data-chat-plan-toggle],.chat-plan-viewer,[data-implement-chat-plan],[data-download-chat-plan]')),
    errors:window.__goalModeSmoke.errors,
  }))()`);
  assert.match(legacySnapshot.text, /这是一条历史回复，应按普通消息展示/);
  assert.equal(legacySnapshot.indicator, true);
  assert.equal(legacySnapshot.specialView, true);
  assert.match(legacySnapshot.text, /实施计划/);
  assert.match(legacySnapshot.text, /单独打开/);
  assert.deepEqual(legacySnapshot.errors, []);

  process.stdout.write('Renderer Goal + Plan coexistence UI smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-goal-mode', stateExpression: 'window.__goalModeSmoke?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function openSession(window, sessionId) {
  await window.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger')?.click()`);
  await waitFor(window, `document.querySelector('[data-session="${sessionId}"]')`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-session="${sessionId}"]').click()`);
  await window.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(window, `!document.querySelector('#chat-search-overlay')`);
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const snapshot = await window.webContents.executeJavaScript(`({text:document.body?.innerText?.slice(0,2400)||'',errors:window.__goalModeSmoke?.errors||[]})`).catch(() => ({}));
  throw new Error(`Timed out waiting for: ${expression}\n${JSON.stringify(snapshot)}`);
}
