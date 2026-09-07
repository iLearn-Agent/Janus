import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-context-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const session = {
  id: 'context_renderer_session', title: 'Context Renderer', departmentId: 'general', agentId: 'general_agent',
  agentInstanceId: 'context_renderer_agent',
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-25T12:00:00.000Z',
};
const secondSession = {
  id: 'context_renderer_session_b', title: 'Context Renderer B', departmentId: 'general', agentId: '',
  status: 'active', writeState: 'writable', conversationRole: 'standard', updatedAt: '2026-07-25T12:01:00.000Z',
};
const messages = [
  { id: 'context_old_user', sessionId: session.id, role: 'user', content: '保留的历史问题', createdAt: '2026-07-25T11:00:00.000Z' },
  { id: 'context_old_answer', sessionId: session.id, role: 'assistant', content: '保留的历史回答', createdAt: '2026-07-25T11:01:00.000Z' },
  ...Array.from({ length: 48 }, (_, index) => ({
    id: `context_layout_message_${index}`,
    sessionId: session.id,
    role: index % 2 ? 'assistant' : 'user',
    content: `滚动稳定性验证消息 ${index + 1}：这是一段用于撑开真实消息列表高度的测试内容。`,
    createdAt: new Date(Date.parse('2026-07-25T11:02:00.000Z') + index * 1_000).toISOString(),
  })),
];
const bootstrap = {
  root: tempRoot,
  org: {
    departments: [{ id: 'general', name: 'General' }],
    agents: [{ id: 'general_agent', name: 'Generalist', departmentId: 'general', routable: true }],
    hrs: [],
  },
  sessions: [session, secondSession], projects: [], tasks: [],
  agentStatuses: [], evolution: null, currentUser: { id: 'context_renderer_user', displayName: 'Context User', role: 'member', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [],
  agentDelegations: [], collaborationOverview: { groups: [], tasks: [] }, socialStatus: { enabled: false, connected: false },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null, modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', contextWindowTokens: 128000, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
  employees: {
    capabilities: { multiMemory: { enabled: false, readOnly: true } }, quota: { used: 0, limit: 10 },
    roster: [{ id: 'context_renderer_agent', displayName: 'Context Agent', agentFamilyId: 'general_agent', routeEligible: true, employmentState: 'active', family: { departmentId: 'general', name: 'Generalist' } }],
    recruitableFamilies: [],
  },
  userAgentSettings: [], personalEvolutionStatus: null, personalEvolutionProposals: [], stage8EvolutionStatus: null,
  clusterEvolutionOverview: { cohorts: [], runs: [], candidates: [] }, privateAssistant: null,
};

const htmlPath = path.join(tempRoot, 'renderer-context-smoke.html');
writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
window.__contextSmoke={clearCalls:[],errors:[],defer:false,pendingResolve:null,resultMode:'native',usages:{
  ${JSON.stringify(session.id)}:{contextStateId:'chatctx_renderer',sessionId:${JSON.stringify(session.id)},contextEpoch:1,usedTokens:118000,contextWindowTokens:128000,usagePercent:92,remainingPercent:8,measurementState:'available',warningLevel:'critical',canSend:true,stateRevision:4,syncStatus:'synced'},
  ${JSON.stringify(secondSession.id)}:{contextStateId:'chatctx_renderer_b',sessionId:${JSON.stringify(secondSession.id)},contextEpoch:1,usedTokens:1200,contextWindowTokens:128000,usagePercent:1,remainingPercent:99,measurementState:'available',warningLevel:'normal',canSend:true,stateRevision:1,syncStatus:'synced'}
}};
window.addEventListener('error',(event)=>window.__contextSmoke.errors.push(String(event.error?.stack||event.message||event.error)));
window.addEventListener('unhandledrejection',(event)=>window.__contextSmoke.errors.push(String(event.reason?.stack||event.reason)));
const base={
 bootstrap:async()=>(${JSON.stringify(bootstrap)}),listSessions:async()=>[${JSON.stringify(session)},${JSON.stringify(secondSession)}],listMessages:async(sessionId)=>sessionId===${JSON.stringify(session.id)}?${JSON.stringify(messages)}:[],
 listMessagePage:async({sessionId})=>({items:sessionId===${JSON.stringify(session.id)}?${JSON.stringify(messages)}:[],nextCursor:null,hasMore:false}),
 employeeOverview:async()=>(${JSON.stringify(bootstrap.employees)}),
 employeeConversationOverview:async()=>({
   requestedAgentInstanceId:${JSON.stringify(session.agentInstanceId)},resolvedAgentInstanceId:${JSON.stringify(session.agentInstanceId)},identityChanged:false,
   primarySession:${JSON.stringify(session)},activeWork:{route:'task_run',taskRunId:'layout-active-task',title:'不应显示的当前工作',status:'running'},
   historyGroups:[{id:'memory:layout-history',kind:'memory',title:'布局历史',messageCount:2,lastMessageAt:'2026-07-25T11:01:00.000Z'}],historySessions:[],
   timeline:{items:${JSON.stringify(messages.map((message) => ({ id: `timeline_${message.id}`, message })))},nextCursor:null},
 }),
 onCodexEvent:(callback)=>{window.__contextSmoke.codexListener=callback;return()=>{};},
 chatContextStatus:async({sessionId})=>window.__contextSmoke.usages[sessionId]||null,
 clearChatContext:async(payload)=>{window.__contextSmoke.clearCalls.push(payload);if(window.__contextSmoke.defer){await new Promise((resolve)=>{window.__contextSmoke.pendingResolve=resolve;});}const current=window.__contextSmoke.usages[payload.sessionId];const native=window.__contextSmoke.resultMode!=='fallback';window.__contextSmoke.usages[payload.sessionId]={...current,contextEpoch:Number(current?.contextEpoch||1)+(native?0:1),usedTokens:0,usagePercent:0,measurementState:'unknown',warningLevel:native?'provider_compacted':'normal',providerCompactionDetected:native,stateRevision:Number(current?.stateRevision||0)+1,syncStatus:'pending'};return window.__contextSmoke.usages[payload.sessionId];},
 updateStatus:async()=>({enabled:false}),agentUpdateStatus:async()=>({enabled:false}),pptxPluginStatus:async()=>({installed:true,available:true}),
};
window.janus=new Proxy(base,{get(target,key){if(key in target)return target[key];if(String(key).startsWith('on'))return()=>()=>{};return async()=>null;}});
</script><script type="module" src="${rendererEntry}"></script></body></html>`);

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: false, width: 1200, height: 820,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const rendererConsole = [];
  browserWindow.webContents.on('console-message', (_event, level, message) => rendererConsole.push(`[${level}] ${message}`));
  await browserWindow.loadFile(htmlPath);
  await waitFor(browserWindow, `document.querySelector('[data-tab="employees"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-tab="employees"]').click()`);
  await waitFor(browserWindow, `document.querySelector('[data-employee-open-chat="${session.agentInstanceId}"]')`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__contextSmoke.lateInitialScrollApplied = false;
    window.__contextSmoke.initialScrollProbe = setInterval(() => {
      const list = document.querySelector('#message-list');
      if (!list?.textContent?.includes('滚动稳定性验证消息 48') || list.scrollHeight <= list.clientHeight) return;
      clearInterval(window.__contextSmoke.initialScrollProbe);
      setTimeout(() => {
        const current = document.querySelector('#message-list');
        if (!current) return;
        current.scrollTop = Math.max(0, current.scrollTop - 320);
        window.__contextSmoke.lateInitialScrollApplied = true;
      }, 60);
    }, 10);
  })()`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-open-chat="${session.agentInstanceId}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-warning.is-critical') && document.querySelector('.context-usage-control')`);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const before = await browserWindow.webContents.executeJavaScript(`({
    warning: document.querySelector('.context-usage-warning')?.textContent || '',
    notice: document.querySelector('.app-notice')?.textContent || '',
    sendDisabled: document.querySelector('.send-btn')?.disabled,
    history: document.querySelector('#message-list')?.textContent || '',
    control: document.querySelector('.context-usage-control')?.textContent || '',
    scrollKey: document.querySelector('#message-list')?.dataset.messageScrollKey || '',
    distanceFromBottom: (() => { const list=document.querySelector('#message-list'); return list ? list.scrollHeight-list.clientHeight-list.scrollTop : -1; })(),
    shellClass: document.querySelector('.shell')?.className || '',
    listOverflowY: getComputedStyle(document.querySelector('#message-list')).overflowY,
    listClientHeight: document.querySelector('#message-list')?.clientHeight || 0,
    listScrollHeight: document.querySelector('#message-list')?.scrollHeight || 0,
    workspaceOverflow: (() => { const item=document.querySelector('.workspace'); return item ? {clientHeight:item.clientHeight,scrollHeight:item.scrollHeight,scrollTop:item.scrollTop,overflowY:getComputedStyle(item).overflowY} : null; })(),
    mainOverflow: (() => { const item=document.querySelector('.main'); return item ? {clientHeight:item.clientHeight,scrollHeight:item.scrollHeight,scrollTop:item.scrollTop,overflowY:getComputedStyle(item).overflowY} : null; })(),
    lateInitialScrollApplied: window.__contextSmoke.lateInitialScrollApplied,
  })`);
  assert.match(before.warning, /剩余 8%/);
  assert.match(before.warning, /压缩上下文/);
  assert.equal(before.sendDisabled, false);
  assert.match(before.history, /保留的历史问题/);
  assert.match(before.control, /上下文剩余 8%/);
  assert.equal(before.lateInitialScrollApplied, true);
  assert.equal(before.scrollKey, `agent:${session.agentInstanceId}`);
  assert.ok(before.distanceFromBottom <= 2, `newly opened conversation must start at bottom: ${before.distanceFromBottom}`);
  assert.match(before.shellClass, /network-panel-open/);
  assert.equal(before.listOverflowY, 'auto');
  assert.ok(before.listScrollHeight > before.listClientHeight);
  assert.ok(before.workspaceOverflow.scrollHeight <= before.workspaceOverflow.clientHeight + 2, `workspace became the Agent chat scroll container: ${JSON.stringify(before.workspaceOverflow)}`);
  assert.ok(before.mainOverflow.scrollHeight <= before.mainOverflow.clientHeight + 2, `main became the Agent chat scroll container: ${JSON.stringify(before.mainOverflow)}`);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.employeeConversationOverviewByInstanceId = {
      ...state.employeeConversationOverviewByInstanceId,
      ${JSON.stringify(session.agentInstanceId)}: {
        activeWork: {
          route: 'task_run', taskRunId: 'layout-active-task', status: 'running',
          title: '撰写 Agent 自进化与集群进化中文调研文档，并覆盖主要技术路线与应用挑战',
          currentAction: '资料框架已经确定：核心证据将覆盖主要系统、研究进展、应用场景与挑战。',
          progress: { completed: 1, total: 13, percent: 8 },
          nodes: [
            { title: '撰写 Agent 自进化中文调研文档', status: 'running' },
            { title: '资料框架已经确定', status: 'completed' },
            { title: '验证核心证据', status: 'queued' },
            { title: '整理应用场景', status: 'pending' },
          ],
          recentEvents: [
            { summary: 'Clarifying skill loading sequence', createdAt: '2026-07-25T11:35:00.000Z' },
            { summary: '资料框架已经确定：核心证据将覆盖主要系统', createdAt: '2026-07-25T11:36:00.000Z' },
          ],
          updatedAt: '2026-07-25T11:36:00.000Z',
        },
        historyGroups: [{ id: 'memory:layout-history', kind: 'memory', title: '布局历史', messageCount: 2, lastMessageAt: '2026-07-25T11:01:00.000Z' }],
        historySessions: [],
      },
    };
    state.currentDepartmentId = 'general';
    state.currentAgentId = 'general_agent';
    state.currentAgentInstanceId = ${JSON.stringify(session.agentInstanceId)};
    state.homeMode = 'department';
    state.languageMode = 'zh-CN';
    state.themeMode = 'light';
    state.responsiveLayoutMode = 'single';
    window.__contextSmoke.activeWorkOverviewFixture = structuredClone(state.employeeConversationOverviewByInstanceId[${JSON.stringify(session.agentInstanceId)}]);
    window.__contextSmoke.previousMessageList = document.querySelector('#message-list');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list') !== window.__contextSmoke.previousMessageList && document.querySelector('.employee-conversation-history')`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-light') && document.querySelectorAll('.employee-conversation-work-nodes > span').length === 3 && document.querySelectorAll('.employee-conversation-work-events > span').length === 1`);
  const layout = await browserWindow.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.conversation-panel');
    const list = document.querySelector('#message-list');
    const stack = document.querySelector('.conversation-top-stack');
    const card = document.querySelector('.employee-conversation-active-work');
    const title = card?.querySelector('header strong');
    const detail = card?.querySelector('.employee-conversation-work-details');
    const tag = card?.querySelector('.employee-conversation-work-nodes > span');
    const rows = getComputedStyle(panel).gridTemplateRows.split(' ').filter(Boolean);
    return {
      hasActiveWorkCard: Boolean(document.querySelector('.employee-conversation-active-work[aria-label="Agent 当前工作"]')),
      hasHistory: Boolean(document.querySelector('.employee-conversation-history')),
      rows,
      stackHeight: stack?.getBoundingClientRect().height || 0,
      panelHeight: panel?.clientHeight || 0,
      listHeight: list?.clientHeight || 0,
      listScrollHeight: list?.scrollHeight || 0,
      panelScrollHeight: panel?.scrollHeight || 0,
      cardHeight: card?.getBoundingClientRect().height || 0,
      cardOverflow: card ? getComputedStyle(card).overflow : '',
      detailFits: detail ? detail.scrollHeight <= detail.clientHeight : false,
      detailScrollHeight: detail?.scrollHeight || 0,
      detailClientHeight: detail?.clientHeight || 0,
      titleFontSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
      tagBackground: tag ? getComputedStyle(tag).backgroundColor : '',
    };
  })()`);
  assert.equal(layout.hasActiveWorkCard, true);
  assert.equal(layout.hasHistory, true);
  assert.equal(layout.rows.length, 3);
  assert.ok(layout.stackHeight > 0);
  assert.ok(layout.listHeight > 0);
  assert.ok(layout.listScrollHeight > layout.listHeight);
  assert.ok(layout.panelScrollHeight <= layout.panelHeight + 2, 'conversation panel itself must not become the scrolling surface');
  assert.equal(layout.cardHeight, 206);
  assert.equal(layout.cardOverflow, 'visible');
  assert.equal(layout.detailFits, true, JSON.stringify(layout));
  assert.ok(layout.titleFontSize >= 14);
  if (process.env.JANUS_EMPLOYEE_TASK_CARD_LIGHT_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const bounds = await browserWindow.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.employee-conversation-active-work').getBoundingClientRect();
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`);
    writeFileSync(process.env.JANUS_EMPLOYEE_TASK_CARD_LIGHT_SCREENSHOT, (await browserWindow.capturePage(bounds)).toPNG());
  }

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.languageMode = 'en';
    state.themeMode = 'dark';
    const englishOverview = structuredClone(window.__contextSmoke.activeWorkOverviewFixture);
    englishOverview.activeWork.title = 'Write a research report on Agent self-evolution and collective evolution, including major technical paths and application challenges';
    englishOverview.activeWork.currentAction = 'The evidence framework now covers core systems, research progress, application scenarios, and open challenges.';
    englishOverview.activeWork.nodes = [
      { title: 'Write the Agent evolution research report', status: 'running' },
      { title: 'Confirm the evidence framework', status: 'completed' },
      { title: 'Verify the primary evidence', status: 'queued' },
      { title: 'Organize application scenarios', status: 'pending' },
    ];
    englishOverview.activeWork.recentEvents = [
      { summary: 'Clarifying skill loading sequence', createdAt: '2026-07-25T11:35:00.000Z' },
      { summary: 'Evidence framework confirmed for the primary systems', createdAt: '2026-07-25T11:36:00.000Z' },
    ];
    state.employeeConversationOverviewByInstanceId = {
      ...state.employeeConversationOverviewByInstanceId,
      ${JSON.stringify(session.agentInstanceId)}: englishOverview,
    };
    window.__contextSmoke.previousActiveWorkCard = document.querySelector('.employee-conversation-active-work');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-dark') && document.querySelector('.employee-conversation-active-work') !== window.__contextSmoke.previousActiveWorkCard && document.querySelectorAll('.employee-conversation-work-nodes > span').length === 3 && document.querySelectorAll('.employee-conversation-work-events > span').length === 1`);
  const localizedDarkLayout = await browserWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.employee-conversation-active-work');
    const detail = card?.querySelector('.employee-conversation-work-details');
    const tag = card?.querySelector('.employee-conversation-work-nodes > span');
    return {
      text: card?.textContent || '',
      height: card?.getBoundingClientRect().height || 0,
      detailFits: detail ? detail.scrollHeight <= detail.clientHeight : false,
      tagBackground: tag ? getComputedStyle(tag).backgroundColor : '',
    };
  })()`);
  assert.match(localizedDarkLayout.text, /Agent Current Task/);
  assert.equal(localizedDarkLayout.height, layout.cardHeight);
  assert.equal(localizedDarkLayout.detailFits, true);
  assert.notEqual(localizedDarkLayout.tagBackground, layout.tagBackground);
  assert.notEqual(localizedDarkLayout.tagBackground, 'rgb(255, 255, 255)');
  if (process.env.JANUS_EMPLOYEE_TASK_CARD_DARK_SCREENSHOT) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const bounds = await browserWindow.webContents.executeJavaScript(`(() => {
      const rect = document.querySelector('.employee-conversation-active-work').getBoundingClientRect();
      return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
    })()`);
    writeFileSync(process.env.JANUS_EMPLOYEE_TASK_CARD_DARK_SCREENSHOT, (await browserWindow.capturePage(bounds)).toPNG());
  }
  const expandedListHeight = localizedDarkLayout.height ? await browserWindow.webContents.executeJavaScript(`document.querySelector('#message-list')?.clientHeight || 0`) : 0;
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-active-work-toggle]')?.click()`);
  await waitFor(browserWindow, `document.querySelector('.employee-conversation-active-work.is-collapsed') && !document.querySelector('.employee-conversation-work-expanded')`);
  const collapsedEnglishLayout = await browserWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.employee-conversation-active-work');
    const note = card?.querySelector('.employee-conversation-work-collapsed-note')?.getBoundingClientRect();
    const footer = card?.querySelector(':scope > footer')?.getBoundingClientRect();
    const actions = card?.querySelector('.employee-conversation-work-head-actions');
    const status = actions?.querySelector('em')?.getBoundingClientRect();
    const toggle = actions?.querySelector('button')?.getBoundingClientRect();
    return {
      text: card?.textContent || '',
      height: card?.getBoundingClientRect().height || 0,
      listHeight: document.querySelector('#message-list')?.clientHeight || 0,
      expanded: document.querySelector('[data-employee-active-work-toggle]')?.getAttribute('aria-expanded') || '',
      actionsDisplay: actions ? getComputedStyle(actions).display : '',
      statusHeight: status?.height || 0,
      statusRadius: actions?.querySelector('em') ? getComputedStyle(actions.querySelector('em')).borderRadius : '',
      toggleWidth: toggle?.width || 0,
      centerDelta: status && toggle ? Math.abs((status.top + status.height / 2) - (toggle.top + toggle.height / 2)) : 99,
      noteBottom: note?.bottom || 0,
      footerTop: footer?.top || 0,
    };
  })()`);
  assert.match(collapsedEnglishLayout.text, /Task information is collapsed\. Expand it to view progress and execution details\./);
  assert.ok(collapsedEnglishLayout.height >= 112 && collapsedEnglishLayout.height <= 130, JSON.stringify(collapsedEnglishLayout));
  assert.equal(collapsedEnglishLayout.expanded, 'false');
  assert.equal(collapsedEnglishLayout.actionsDisplay, 'flex');
  assert.ok(collapsedEnglishLayout.statusHeight <= 19, JSON.stringify(collapsedEnglishLayout));
  assert.equal(collapsedEnglishLayout.statusRadius, '5px');
  assert.equal(collapsedEnglishLayout.toggleWidth, 26);
  assert.ok(collapsedEnglishLayout.centerDelta <= 1, JSON.stringify(collapsedEnglishLayout));
  assert.ok(collapsedEnglishLayout.footerTop >= collapsedEnglishLayout.noteBottom + 1,
    `collapsed footer divider must stay below the note: ${JSON.stringify(collapsedEnglishLayout)}`);
  assert.ok(collapsedEnglishLayout.listHeight > expandedListHeight, JSON.stringify({ expandedListHeight, collapsedEnglishLayout }));
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.languageMode = 'zh-CN';
    state.themeMode = 'light';
    window.__contextSmoke.previousDarkCard = document.querySelector('.employee-conversation-active-work');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('.shell.theme-light') && document.querySelector('.employee-conversation-active-work') !== window.__contextSmoke.previousDarkCard`);
  const collapsedChineseText = await browserWindow.webContents.executeJavaScript(`document.querySelector('.employee-conversation-active-work')?.textContent || ''`);
  assert.match(collapsedChineseText, /任务信息已折叠，展开后可查看进度和执行详情。/);

  await waitFor(browserWindow, `document.querySelector('[data-agent-inline-trigger]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-agent-inline-trigger]').click()`);
  await waitFor(browserWindow, `document.querySelector('.agent-inline-menu')`);
  const agentMenuPlacement = await browserWindow.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('[data-agent-inline-trigger]').getBoundingClientRect();
    const menu = document.querySelector('.agent-inline-menu').getBoundingClientRect();
    return { triggerTop: trigger.top, menuTop: menu.top, menuBottom: menu.bottom, viewportHeight: innerHeight };
  })()`);
  assert.ok(agentMenuPlacement.menuBottom <= agentMenuPlacement.triggerTop + 1, `agent menu must open above its trigger: ${JSON.stringify(agentMenuPlacement)}`);
  assert.ok(agentMenuPlacement.menuTop >= 0, `agent menu must stay inside the viewport: ${JSON.stringify(agentMenuPlacement)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-agent-inline-trigger]').click()`);

  await waitFor(browserWindow, `document.querySelector('[data-network-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, pointerType: 'mouse' }));
    list.scrollTop = Math.max(0, Math.floor((list.scrollHeight - list.clientHeight) * 0.3));
    window.__contextSmoke.previousMessageList = list;
    document.querySelector('[data-network-session="${session.id}"]').click();
  })()`);
  await waitFor(browserWindow, `document.querySelector('#message-list') !== window.__contextSmoke.previousMessageList && document.querySelector('#message-list')?.textContent?.includes('滚动稳定性验证消息 48')`);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const directSidebarOpenDistance = await browserWindow.webContents.executeJavaScript(`(() => { const list=document.querySelector('#message-list'); return list.scrollHeight-list.clientHeight-list.scrollTop; })()`);
  assert.ok(directSidebarOpenDistance <= 2, `left sidebar Agent record did not force the newly opened conversation to bottom: ${directSidebarOpenDistance}`);

  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -240 }));
    list.scrollTop = Math.max(0, Math.floor((list.scrollHeight - list.clientHeight) * 0.35));
  })()`);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${secondSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${secondSession.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')?.dataset.chatInputSession === ${JSON.stringify(secondSession.id)}`);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${session.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('#chat-input')?.dataset.chatInputSession === ${JSON.stringify(session.id)} && document.querySelector('#message-list')?.textContent?.includes('滚动稳定性验证消息 48')`);
  const reopenedConversation = await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    return { key: list.dataset.messageScrollKey || '', distance: list.scrollHeight-list.clientHeight-list.scrollTop };
  })()`);
  assert.equal(reopenedConversation.key, `agent:${session.agentInstanceId}`);
  assert.ok(reopenedConversation.distance <= 2, `reopened conversation inherited another surface's scroll position: ${JSON.stringify(reopenedConversation)}`);

  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.scrollTop = list.scrollHeight;
  })()`);
  await waitFor(browserWindow, `(() => { const list=document.querySelector('#message-list'); return list && list.scrollHeight-list.clientHeight-list.scrollTop<=2; })()`);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.responsiveLayoutMode = 'single';
    window.__contextSmoke.previousMessageList = document.querySelector('#message-list');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list') !== window.__contextSmoke.previousMessageList`);
  const idleRerenderDistance = await browserWindow.webContents.executeJavaScript(`(() => { const list=document.querySelector('#message-list'); return list.scrollHeight-list.clientHeight-list.scrollTop; })()`);
  assert.ok(idleRerenderDistance <= 2, `bottom scroll position changed after an idle rerender: ${idleRerenderDistance}`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.messages.push({ id: 'context_layout_stream_update', sessionId: ${JSON.stringify(session.id)}, role: 'assistant', content: '模拟 Agent 新输出。', createdAt: new Date().toISOString(), metadata: {} });
    state.responsiveLayoutMode = 'single';
    window.__contextSmoke.previousMessageList = document.querySelector('#message-list');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list') !== window.__contextSmoke.previousMessageList && document.querySelector('[data-message-id="context_layout_stream_update"]')`);
  const outputRerenderDistance = await browserWindow.webContents.executeJavaScript(`(() => { const list=document.querySelector('#message-list'); return list.scrollHeight-list.clientHeight-list.scrollTop; })()`);
  assert.ok(outputRerenderDistance <= 2, `bottom scroll position changed while Agent output was added: ${outputRerenderDistance}`);

  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.scrollTop = list.scrollHeight;
    const body = list.querySelector('[data-message-id="context_layout_stream_update"] .message-body');
    body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 17, pointerType: 'mouse' }));
  })()`);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.messages.push({
      id: 'context_layout_after_plain_click', sessionId: ${JSON.stringify(session.id)}, role: 'assistant',
      content: ${JSON.stringify('普通消息点击后的新增内容。'.repeat(80))}, createdAt: new Date().toISOString(), metadata: {},
    });
    state.responsiveLayoutMode = 'single';
    window.__contextSmoke.previousMessageList = document.querySelector('#message-list');
    window.dispatchEvent(new Event('resize'));
  })`);
  await waitFor(browserWindow, `document.querySelector('#message-list') !== window.__contextSmoke.previousMessageList && document.querySelector('[data-message-id="context_layout_after_plain_click"]')`);
  const plainClickRerenderDistance = await browserWindow.webContents.executeJavaScript(`(() => { const list=document.querySelector('#message-list'); return list.scrollHeight-list.clientHeight-list.scrollTop; })()`);
  assert.ok(plainClickRerenderDistance <= 2, `clicking ordinary message content detached bottom follow: ${plainClickRerenderDistance}`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    const run = {
      channelId: 'context-layout-periodic-run', chatKey: state.currentChatKey,
      sessionId: ${JSON.stringify(session.id)}, displaySessionId: ${JSON.stringify(session.id)}, executionSessionId: ${JSON.stringify(session.id)},
      ownerUserId: state.currentUser?.id || '', accountWorkspaceId: 'workspace_personal', workspaceSwitchGeneration: Number(state.workspaceSwitchGeneration || 0),
      departmentId: 'general', agentId: 'general_agent', agentInstanceId: ${JSON.stringify(session.agentInstanceId)},
      userMessage: '周期状态刷新测试', sessionTitle: '周期状态刷新测试', statusMessageId: '', processMessageId: '',
      assistantMessageId: '', assistantContent: '', assistantStreaming: false, processEvents: [], targetKind: 'chat',
      startedAt: Date.now() - 2_000, lastStatusStage: 'working', lastStatusText: '', terminal: false,
    };
    state.chatRuns = [run];
    state.activeChatRun = run;
    window.__contextSmoke.codexListener({ channelId: run.channelId, event: { kind: 'start', stage: 'working', message: '周期状态刷新测试开始' } });
  })`);
  await waitFor(browserWindow, `document.querySelector('.run-status-message')`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
    list.scrollTop = list.scrollHeight;
    window.__contextSmoke.periodicScrollSamples = [];
    window.__contextSmoke.periodicScrollTimer = setInterval(() => {
      const current = document.querySelector('#message-list');
      window.__contextSmoke.periodicScrollSamples.push({
        top: current?.scrollTop || 0,
        max: current ? Math.max(0, current.scrollHeight - current.clientHeight) : 0,
        distance: current ? Math.max(0, current.scrollHeight - current.clientHeight - current.scrollTop) : -1,
      });
    }, 100);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 4_200));
  const periodicSamples = await browserWindow.webContents.executeJavaScript(`(() => {
    clearInterval(window.__contextSmoke.periodicScrollTimer);
    return window.__contextSmoke.periodicScrollSamples;
  })()`);
  assert.ok(periodicSamples.length >= 30);
  assert.ok(periodicSamples.every((sample) => sample.distance <= 2), `periodic Agent status refresh moved the list away from bottom: ${JSON.stringify(periodicSamples.filter((sample) => sample.distance > 2).slice(0, 8))}`);

  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.scrollTop = list.scrollHeight;
    const target = list.querySelector('[data-message-id="context_layout_stream_update"] .message-body');
    const delayed = document.createElement('div');
    delayed.dataset.delayedMessageLayout = 'true';
    delayed.style.height = '220px';
    target.append(delayed);
  })()`);
  await waitFor(browserWindow, `(() => { const list=document.querySelector('#message-list'); return list && list.scrollHeight-list.clientHeight-list.scrollTop<=2; })()`);
  const delayedLayoutDistance = await browserWindow.webContents.executeJavaScript(`(() => { const list=document.querySelector('#message-list'); return list.scrollHeight-list.clientHeight-list.scrollTop; })()`);
  assert.ok(delayedLayoutDistance <= 2, `delayed message layout moved the list away from bottom: ${delayedLayoutDistance}`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({state}) => {
    state.chatRuns = [];
    state.activeChatRun = null;
  })`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('.context-usage-warning [data-chat-clear-context]').click()`);
  await waitFor(browserWindow, `window.__contextSmoke.clearCalls.length===1 && !document.querySelector('.context-usage-warning') && document.querySelector('.app-notice')?.textContent?.includes('Janus') && document.querySelector('.app-notice')?.textContent?.includes('Memory')`);
  const after = await browserWindow.webContents.executeJavaScript(`({
    call: window.__contextSmoke.clearCalls[0],
    history: document.querySelector('#message-list')?.textContent || '',
    control: document.querySelector('.context-usage-control')?.textContent || '',
    warning: document.querySelector('.context-usage-warning')?.textContent || '',
    notice: document.querySelector('.app-notice')?.textContent || '',
    warningButton: Boolean(document.querySelector('.context-usage-warning [data-chat-clear-context]')),
    errors: window.__contextSmoke.errors,
  })`);
  assert.equal(after.call.sessionId, session.id);
  assert.equal(after.call.expectedStateRevision, 4);
  assert.ok(after.call.commandId);
  assert.match(after.history, /保留的历史问题/);
  assert.equal(after.control.trim(), '上下文');
  assert.equal(after.warning, '');
  assert.match(after.notice, /Janus \u7ebf\u7a0b\u3001\u539f\u59cb\u804a\u5929\u5386\u53f2\u548c Memory \u4fdd\u6301\u4e0d\u53d8/);
  assert.equal(after.warningButton, false);
  assert.deepEqual(after.errors, []);
  await waitFor(browserWindow, `document.querySelector('.app-notice')?.textContent?.includes('Janus 线程、原始聊天历史和 Memory 保持不变')`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__contextSmoke.resultMode='fallback';
    window.__contextSmoke.usages[${JSON.stringify(session.id)}]={...window.__contextSmoke.usages[${JSON.stringify(session.id)}],usedTokens:118000,usagePercent:92,measurementState:'available',warningLevel:'critical',providerCompactionDetected:false};
  })()`);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${session.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-control')?.textContent?.includes('剩余 8%')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.context-usage-control').click()`);
  await waitFor(browserWindow, `window.__contextSmoke.clearCalls.length===2 && document.querySelector('.app-notice')?.textContent?.includes('本地恢复摘要')`);
  const fallbackNotice = await browserWindow.webContents.executeJavaScript(`document.querySelector('.app-notice')?.textContent || ''`);
  assert.match(fallbackNotice, /下次发送将使用新的 Janus 线程/);
  assert.doesNotMatch(fallbackNotice, /Janus 线程、原始聊天历史和 Memory 保持不变/);
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__contextSmoke.resultMode='native';
    window.__contextSmoke.usages[${JSON.stringify(session.id)}]={...window.__contextSmoke.usages[${JSON.stringify(session.id)}],usedTokens:118000,usagePercent:92,measurementState:'available',warningLevel:'critical'};
    window.__contextSmoke.defer=true;
  })()`);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${session.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-control')?.textContent?.includes('剩余 8%')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.context-usage-control').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-control.is-busy')`);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${secondSession.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${secondSession.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-control') && !document.querySelector('.context-usage-control.is-busy')`);
  const isolated = await browserWindow.webContents.executeJavaScript(`({control:document.querySelector('.context-usage-control')?.textContent?.trim()||'',sendDisabled:Boolean(document.querySelector('.send-btn')?.disabled)})`);
  assert.doesNotMatch(isolated.control, /压缩中/);
  assert.equal(isolated.sendDisabled, false);
  await openChatSearch(browserWindow);
  await waitFor(browserWindow, `document.querySelector('[data-session="${session.id}"]')`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-session="${session.id}"]').click()`);
  await waitFor(browserWindow, `document.querySelector('.context-usage-control.is-busy')`);
  await browserWindow.webContents.executeJavaScript(`window.__contextSmoke.pendingResolve();window.__contextSmoke.defer=false`);
  await waitFor(browserWindow, `!document.querySelector('.context-usage-control.is-busy')`);
  process.stdout.write('Renderer context usage smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-context', stateExpression: 'window.__contextSmoke?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function waitFor(window, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(`Boolean(${expression})`).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const snapshot = await window.webContents.executeJavaScript(`({html:document.documentElement?.outerHTML?.slice(0,4000)||'',text:document.body?.innerText?.slice(0,2000)||'',errors:window.__contextSmoke?.errors||[]})`).catch(() => ({}));
  throw new Error(`Timed out waiting for: ${expression}\n${JSON.stringify(snapshot)}`);
}

async function openChatSearch(window) {
  const hasTrigger = await window.webContents.executeJavaScript(`Boolean(document.querySelector('#sidebar-chat-search-trigger'))`);
  if (!hasTrigger) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-app-nav="messages"]')?.click()`);
    await waitFor(window, `document.querySelector('#sidebar-chat-search-trigger')`);
  }
  await window.webContents.executeJavaScript(`document.querySelector('#sidebar-chat-search-trigger').click()`);
}
