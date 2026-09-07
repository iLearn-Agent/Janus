const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { app, BrowserWindow } = require('electron');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-message-mode-ui-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const session = {
  id: 'ubuddy-mode-ui-session', title: 'uBuddy', departmentId: 'secretary_department', agentId: 'secretary_agent',
  status: 'active', writeState: 'writable', updatedAt: new Date().toISOString(),
};
const privateSession = {
  id: 'private-assistant-mode-ui-session', title: 'Private Assistant', departmentId: 'private_assistant', agentId: 'private_assistant',
  status: 'active', writeState: 'writable', updatedAt: new Date().toISOString(),
};
const bootstrap = {
  root: tempRoot, workspaceRoot: '', org: { departments: [], agents: [], hrs: [] }, sessions: [session, privateSession],
  projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: { id: 'ubuddy-mode-ui-user', displayName: '模式测试用户', role: 'member', permissions: {} },
  accountWorkspaces: [], activeAccountWorkspace: { id: 'workspace_personal' }, adminUsers: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [], socialThreads: [],
  agentDelegations: [], collaborationOverview: { groups: [], tasks: [] }, chatGroups: { groups: [] },
  socialStatus: { enabled: false, connected: false }, codexConfig: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' }, codexConfigFiles: null, cloudSync: null,
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
  employees: { quota: { used: 0, limit: 10 }, roster: [], recruitableFamilies: [] },
  userAgentSettings: [], privateAssistant: { weeklyTokensUsed: 0, weeklyTokenLimit: 20_000_000, weeklyTokensRemaining: 20_000_000 }, managedProviderUsage: null,
  uBuddyFeatureFlags: { messageModeV1: true, structuredTaskReference: true, newTaskWorkspaceUi: true, newProcessEventStream: true },
};
const htmlPath = path.join(tempRoot, 'ubuddy-message-mode-ui.html');
writeFileSync(htmlPath, `<!doctype html><html lang="en" data-default-language="en"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__modeSmoke={errors:[]};
window.addEventListener('error',(event)=>window.__modeSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__modeSmoke.errors.push(String(event.reason?.stack||event.reason)));
const bootstrap=${JSON.stringify(bootstrap)};const sessions=${JSON.stringify([session, privateSession])};
const base={bootstrap:async()=>bootstrap,listSessions:async()=>sessions,listMessages:async()=>[],listMessagePage:async()=>({items:[],nextCursor:null,hasMore:false}),chatContextStatus:async()=>null,privateAssistantStatus:async()=>bootstrap.privateAssistant,secretaryTaskReferenceOptions:async()=>({options:[{taskRunId:'mode-task',title:'布局检查任务',displayText:'@任务：布局检查任务',group:'active'}]}),updateStatus:async()=>({enabled:false}),agentUpdateStatus:async()=>({enabled:false}),pptxPluginStatus:async()=>({installed:true,available:true})};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

(async () => {
let browserWindow;
let privateWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `document.querySelector('#sidebar-chat-search-trigger')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${session.id}"]').click();document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.ubuddy-message-mode-switch') && document.querySelector('#chat-input')`);
  const desktop = await layoutSnapshot(browserWindow);
  assertLayout(desktop, 'desktop');
  assert.equal(desktop.activeMode, 'task');
  assert.match(desktop.modelText, /5\.6[ -]SOL.*Medium/i);
  writeFileSync('/tmp/janus-ubuddy-message-mode-desktop.png', (await browserWindow.capturePage()).toPNG());

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-ubuddy-message-mode="ask"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-ubuddy-message-mode="ask"]')?.getAttribute('aria-checked')==='true'`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-ubuddy-message-mode="ask"]').textContent.trim()`), 'Ask');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input').placeholder`), 'Ask uBuddy');

  browserWindow.setSize(520, 720);
  await new Promise((resolve) => setTimeout(resolve, 180));
  const narrow = await layoutSnapshot(browserWindow);
  assertLayout(narrow, 'narrow');
  assert.equal(narrow.activeMode, 'ask');
  writeFileSync('/tmp/janus-ubuddy-message-mode-narrow.png', (await browserWindow.capturePage()).toPNG());
  assert.deepEqual(narrow.errors, []);

  privateWindow = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  await privateWindow.loadFile(htmlPath);
  await waitFor(privateWindow, `document.querySelector('#sidebar-chat-search-trigger')`);
  await privateWindow.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
  await waitFor(privateWindow, `document.querySelector('[data-session="${privateSession.id}"]')`);
  await privateWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${privateSession.id}"]').click();document.querySelector('#close-chat-search-btn')?.click()`);
  await waitFor(privateWindow, `document.querySelector('.composer.is-private-assistant-mode #model-picker-trigger')`);
  const privateDesktop = await privateAssistantLayoutSnapshot(privateWindow);
  assert.equal(privateDesktop.modelClipped, false, `private assistant model or reasoning label was clipped: ${JSON.stringify(privateDesktop)}`);
  assert.match(privateDesktop.modelText, /5\.6[ -]SOL.*Medium/i);
  assert.ok(privateDesktop.modelTrigger.right <= privateDesktop.controls.right + 1, `private assistant model trigger escaped controls: ${JSON.stringify(privateDesktop)}`);
  process.stdout.write('Renderer uBuddy message mode UI smoke passed.\n');
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  if (privateWindow && !privateWindow.isDestroyed()) privateWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
  app.quit();
}

async function layoutSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect=(selector)=>{const element=document.querySelector(selector);if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const trigger=document.querySelector('#model-picker-trigger');
    const modelLabel=trigger?.querySelector('.config-model-label');
    const tuningLabel=trigger?.querySelector('.config-tuning-label');
    return {composer:rect('#chat-form'),mode:rect('.ubuddy-message-mode-switch'),input:rect('#chat-input'),quick:rect('.composer-quick-actions'),controls:rect('.composer-controls'),modelTrigger:rect('#model-picker-trigger'),modelText:trigger?.textContent.replace(/\\s+/g,' ').trim()||'',modelClipped:Boolean(modelLabel&&modelLabel.scrollWidth>modelLabel.clientWidth+1)||Boolean(tuningLabel&&tuningLabel.scrollWidth>tuningLabel.clientWidth+1),activeMode:document.querySelector('.ubuddy-message-mode-switch button[aria-checked="true"]')?.dataset.ubuddyMessageMode||'',errors:window.__modeSmoke.errors};
  })()`);
}

function assertLayout(snapshot, label) {
  for (const key of ['composer', 'mode', 'input', 'quick', 'controls', 'modelTrigger']) assert.ok(snapshot[key], `${label}: missing ${key}`);
  assert.ok(snapshot.mode.left >= snapshot.composer.left && snapshot.mode.right <= snapshot.composer.right, `${label}: mode switch escaped composer`);
  assert.ok(snapshot.mode.bottom <= snapshot.input.top + 1, `${label}: mode switch overlaps input`);
  assert.ok(snapshot.quick.right <= snapshot.controls.left + 1, `${label}: footer controls overlap`);
  assert.ok(snapshot.controls.right <= snapshot.composer.right + 1, `${label}: model controls escaped composer`);
  assert.ok(snapshot.modelTrigger.right <= snapshot.controls.right + 1, `${label}: model trigger escaped controls`);
  assert.equal(snapshot.modelClipped, false, `${label}: model or reasoning label was clipped: ${JSON.stringify(snapshot)}`);
  assert.ok(snapshot.composer.left >= 0 && snapshot.composer.right <= (label === 'narrow' ? 520 : 1280) + 1, `${label}: composer escaped viewport`);
}

async function privateAssistantLayoutSnapshot(window) {
  return window.webContents.executeJavaScript(`(() => {
    const rect=(selector)=>{const element=document.querySelector(selector);if(!element)return null;const r=element.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width};};
    const trigger=document.querySelector('.composer.is-private-assistant-mode #model-picker-trigger');
    const labels=[...trigger.querySelectorAll('.config-model-label,.config-tuning-label')];
    return {controls:rect('.composer.is-private-assistant-mode .composer-controls'),modelTrigger:rect('.composer.is-private-assistant-mode #model-picker-trigger'),modelText:trigger.textContent.replace(/\\s+/g,' ').trim(),modelClipped:labels.some((label)=>label.scrollWidth>label.clientWidth+1)};
  })()`);
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  app.exit(1);
});
