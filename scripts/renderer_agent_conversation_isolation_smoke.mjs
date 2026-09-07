import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-agent-isolation-ui-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const htmlPath = path.join(tempRoot, 'agent-isolation-smoke.html');
const screenshotA = process.env.JANUS_AGENT_ISOLATION_SCREENSHOT_A || '/tmp/janus-agent-a-isolation-ui.png';
const screenshotB = process.env.JANUS_AGENT_ISOLATION_SCREENSHOT_B || '/tmp/janus-agent-b-isolation-ui.png';

const employees = [
  {
    id: 'instance-agent-a', agentFamilyId: 'general_agent', displayName: '通用 Agent A', note: '负责研究与分析', employmentState: 'active', routeEligible: true, stateRevision: 1,
    family: { id: 'general_agent', name: '通用 Agent', departmentId: 'general', metadata: { summary: 'Agent A isolation test' } },
    currentMemory: { id: 'memory-a-0', displayName: 'memory0.md' }, availableMarketVersions: [],
  },
  {
    id: 'instance-agent-b', agentFamilyId: 'general_agent', displayName: '通用 Agent B', note: '负责写作与整理', employmentState: 'active', routeEligible: true, stateRevision: 1,
    family: { id: 'general_agent', name: '通用 Agent', departmentId: 'general', metadata: { summary: 'Agent B isolation test' } },
    currentMemory: { id: 'memory-b-0', displayName: 'memory0.md' }, availableMarketVersions: [],
  },
];
const employeeOverview = {
  roster: employees, recruitable: [], quota: { limit: 10, used: 2 }, capabilities: { multiMemory: { enabled: true, readOnly: false } },
};
const bootstrap = {
  appVersion: '0.2.2', root: tempRoot, workspaceRoot: '',
  org: {
    departments: [{ id: 'general', name: '通用部门' }],
    agents: [{ id: 'general_agent', name: '通用 Agent', departmentId: 'general', routable: true }], hrs: [],
  },
  sessions: [], projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: { id: 'agent-isolation-user', displayName: '隔离测试用户', role: 'member', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } }, socialInbox: [],
  agentDelegations: [], collaboration: { groups: [], tasks: [] }, socialStatus: { enabled: false, connected: false },
  codexConfig: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' }, codexConfigFiles: null, cloudSync: null,
  userAgentSettings: [], plugins: [], employees: employeeOverview,
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
};

writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Agent isolation UI smoke</title>
<link rel="stylesheet" href="${rendererStyle}"></head><body><div id="app"></div><script>
localStorage.removeItem('janus-composer-drafts-v1:agent-isolation-user:workspace_personal');
const bootstrap = ${JSON.stringify(bootstrap)};
const employeeOverview = ${JSON.stringify(employeeOverview)};
const employees = ${JSON.stringify(employees)};
const subscribe = () => () => {};
let codexListener = null;
let employeesUpdatedListener = null;
const sessions = [{
  id: 'history-instance-agent-a', title: 'Agent A historical chat', departmentId: 'general',
  agentId: 'general_agent', agentInstanceId: 'instance-agent-a', status: 'active', conversationRole: 'history',
  writeState: 'read_only', readOnly: true, updatedAt: '2026-01-01T00:00:00.000Z',
}];
const messagesBySession = new Map([['history-instance-agent-a', [{
  id: 'history-a', role: 'assistant', content: 'A_READ_ONLY_HISTORY', agentId: 'general_agent',
  agentInstanceId: 'instance-agent-a', departmentId: 'general', createdAt: '2026-01-01T00:00:00.000Z',
}]]]);
window.__agentIsolationTest = {
  sends: [], errors: [], delayMode: false, terminalEventWindow: '', sessions, messagesBySession,
  overviewDelays: {}, aliasRedirect: false, canonicalRefresh: false, employeeOverviewCalls: 0,
  overviewFailures: {}, listMessagesCalls: [], conversationOverviewCalls: [], historyGroupCalls: [], forceEmptyTimeline: false,
};
window.addEventListener('error', (event) => window.__agentIsolationTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
window.addEventListener('unhandledrejection', (event) => window.__agentIsolationTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
const sessionForInstance = (agentInstanceId) => sessions.find((item) => item.agentInstanceId === agentInstanceId
  && item.writeState !== 'read_only' && !item.readOnly);
const ensureUBuddySession = () => {
  let session = sessions.find((item) => item.departmentId === 'secretary_department');
  if (!session) {
    session = { id: 'session-ubuddy', title: 'uBuddy', departmentId: 'secretary_department',
      agentId: 'secretary_agent', status: 'active', writeState: 'writable' };
    sessions.unshift(session);
    messagesBySession.set(session.id, []);
  }
  return session;
};
const timelineForInstance = (agentInstanceId) => ({
  windowId: 'agent:' + agentInstanceId,
  agentInstanceId,
  items: window.__agentIsolationTest.forceEmptyTimeline ? [] : sessions.filter((item) => item.agentInstanceId === agentInstanceId)
    .flatMap((session) => (messagesBySession.get(session.id) || []).map((message, index) => ({
      id: 'timeline:' + message.id, sequence: index + 1, sourceKind: 'direct', sourceId: message.id,
      sourceConversationId: session.id, sourceMessageId: message.id, workspaceId: 'workspace_personal',
      workspaceKind: 'personal', workspaceName: '个人空间', occurredAt: message.createdAt || new Date().toISOString(),
      accessState: 'full', canOpenSource: false, role: message.role, content: message.content,
      attachments: message.metadata?.attachments || [], message: { ...message },
    }))),
  nextCursor: null,
});
window.janus = {
  platform: 'linux', bootstrap: async () => bootstrap,
  updateStatus: async () => ({ enabled: false, available: false }),
  agentUpdateStatus: async () => ({ enabled: false, available: false }),
  onCodexEvent: (callback) => { codexListener = callback; return () => { if (codexListener === callback) codexListener = null; }; },
  onUpdateStatus: subscribe, onAgentUpdateStatus: subscribe, onPluginProgress: subscribe,
  onEvolutionProgress: subscribe, onModelsUpdated: subscribe, onSocialUpdated: subscribe, onSocialOpenTask: subscribe,
  onEmployeesUpdated: (callback) => {
    employeesUpdatedListener = callback;
    window.__agentIsolationTest.emitEmployeesUpdated = (payload = {}) => callback(payload);
    return () => {
      if (employeesUpdatedListener === callback) employeesUpdatedListener = null;
      window.__agentIsolationTest.emitEmployeesUpdated = null;
    };
  },
  employeeOverview: async () => {
    window.__agentIsolationTest.employeeOverviewCalls += 1;
    return window.__agentIsolationTest.canonicalRefresh
      ? { ...employeeOverview, roster: employees.filter((item) => item.id === 'instance-agent-b') }
      : employeeOverview;
  },
  employeeConversationOverview: async ({ agentInstanceId = '' } = {}) => {
    window.__agentIsolationTest.conversationOverviewCalls.push(agentInstanceId);
    const delay = Number(window.__agentIsolationTest.overviewDelays[agentInstanceId] || 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (window.__agentIsolationTest.overviewFailures[agentInstanceId]) throw new Error('overview unavailable');
    const resolvedAgentInstanceId = window.__agentIsolationTest.aliasRedirect && agentInstanceId === 'instance-agent-a'
      ? 'instance-agent-b'
      : agentInstanceId;
    return {
      requestedAgentInstanceId: agentInstanceId,
      resolvedAgentInstanceId,
      identityChanged: resolvedAgentInstanceId !== agentInstanceId,
      windowId: 'agent:' + resolvedAgentInstanceId,
      primarySession: sessionForInstance(resolvedAgentInstanceId) || null,
      timeline: timelineForInstance(resolvedAgentInstanceId),
      currentMemoryScoped: true,
      historySessions: [],
      historyGroups: [],
      activeWork: { route: 'none', sessionId: '', taskRunId: '' },
      workspaceId: 'workspace_personal',
    };
  },
  employeeConversationHistoryGroup: async ({ agentInstanceId = '', historyGroupId = '' } = {}) => {
    window.__agentIsolationTest.historyGroupCalls.push({ agentInstanceId, historyGroupId });
    if (agentInstanceId !== 'instance-agent-a' || historyGroupId !== 'session:history-instance-agent-a') {
      throw new Error('history group not found');
    }
    return {
      group: {
        id: historyGroupId, kind: 'legacy', title: 'Agent A historical chat',
        messageCount: 1, lastMessageAt: '2026-01-01T00:00:00.000Z', readOnly: true,
      },
      messages: (messagesBySession.get('history-instance-agent-a') || []).map((item) => ({ ...item })),
      attachments: [],
    };
  },
  agentConversationTimeline: async ({ agentInstanceId = '' } = {}) => timelineForInstance(agentInstanceId),
  friendsOverview: async () => bootstrap.friendOverview,
  ensureSecretarySession: async () => ({ ...ensureUBuddySession() }),
  listProjects: async () => [], listSessions: async () => sessions.map((item) => ({ ...item })),
  listMessages: async (sessionId) => {
    window.__agentIsolationTest.listMessagesCalls.push(sessionId);
    if (window.__agentIsolationTest.delayMode) {
      const delay = sessionId.includes('instance-agent-a') ? 220 : 20;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return (messagesBySession.get(sessionId) || []).map((item) => ({ ...item }));
  },
  chatContextStatus: async () => null,
  sendChat: async (payload) => {
    window.__agentIsolationTest.sends.push({ ...payload });
    const employee = employees.find((item) => item.id === payload.agentInstanceId);
    if (!employee) throw new Error('missing agentInstanceId in renderer send payload');
    let session = sessionForInstance(employee.id);
    if (!session) {
      session = { id: 'session-' + employee.id, title: employee.displayName, departmentId: employee.family.departmentId,
        agentId: employee.agentFamilyId, agentInstanceId: employee.id, status: 'active', writeState: 'writable' };
      sessions.unshift(session);
      messagesBySession.set(session.id, []);
    }
    if (payload.sessionId && payload.sessionId !== session.id) throw new Error('cross-Agent session payload detected');
    codexListener?.({ channelId: payload.channelId, event: { kind: 'start', sessionId: session.id,
      agentId: employee.agentFamilyId, departmentId: employee.family.departmentId } });
    const list = messagesBySession.get(session.id);
    const stamp = new Date().toISOString();
    list.push({ id: 'user-' + list.length, role: 'user', content: payload.message, agentId: employee.agentFamilyId,
      agentInstanceId: employee.id, departmentId: employee.family.departmentId, createdAt: stamp });
    const answer = employee.id === 'instance-agent-a' ? 'A_ONLY_REPLY' : 'B_ONLY_REPLY';
    const saved = { id: 'assistant-' + list.length, role: 'assistant', content: answer, agentId: employee.agentFamilyId,
      agentInstanceId: employee.id, departmentId: employee.family.departmentId, createdAt: stamp };
    list.push(saved);
    codexListener?.({ channelId: payload.channelId, event: { kind: 'done', sessionId: session.id,
      agentId: employee.agentFamilyId, departmentId: employee.family.departmentId, answer } });
    window.__agentIsolationTest.terminalEventWindow = employee.id;
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.__agentIsolationTest.terminalEventWindow = '';
    return { session: { ...session }, message: saved, answer, artifacts: [] };
  },
  minimizeWindow: async () => null, toggleMaximizeWindow: async () => null, closeWindow: async () => null,
};
</script><script type="module" src="${rendererEntry}"></script></body></html>`, 'utf8');

let browserWindow;
const rendererConsole = [];
const waitFor = (expression, failureMessage, timeout = 10000) => browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = Date.now() + ${timeout};
  const poll = () => { if (${expression}) return resolve(true); if (Date.now() > deadline) return reject(new Error(${JSON.stringify(failureMessage)})); setTimeout(poll, 20); };
  poll();
})`);
const click = async (selector) => {
  await waitFor(`document.querySelector(${JSON.stringify(selector)})`, `missing selector: ${selector}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
};
const openEmployees = async () => {
  await click('[data-network-view="friends"]');
  await click('[data-contacts-pane="employees"]');
  await waitFor(`document.querySelector('[data-contacts-employee-card]')`, 'contacts employee roster did not render');
};
const openAgent = async (instanceId) => {
  await waitFor(`document.querySelector(${JSON.stringify(`[data-contacts-employee-card="${instanceId}"]`)})`, `missing employee card: ${instanceId}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-contacts-employee-card="${instanceId}"]`)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
  await waitFor(`document.querySelector('#chat-input')`, `chat composer missing for ${instanceId}`);
};
const openUBuddy = async () => {
  await click('[data-network-view="messages"]');
  await click('[data-network-peer="self-secretary"]');
  await waitFor(`document.querySelector('#chat-input')?.dataset.chatInputSession === 'session-ubuddy'`, 'uBuddy conversation did not open');
};
const beginOpenAgent = async (instanceId) => {
  await waitFor(`document.querySelector(${JSON.stringify(`[data-contacts-employee-card="${instanceId}"]`)})`, `missing employee card: ${instanceId}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(`[data-contacts-employee-card="${instanceId}"]`)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
};
const sendMessage = async (text) => {
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input'); input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form .send-btn').click();
  })()`);
  await waitFor(`!document.querySelector('#chat-form .send-btn')?.disabled && document.querySelector('#message-list')?.textContent.includes(${JSON.stringify(text)})`, `message did not finish: ${text}`);
};
const beginMessage = async (text) => {
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input'); input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form .send-btn').click();
  })()`);
};

try {
  await app.whenReady();
  browserWindow = new BrowserWindow({ show: true, width: 1440, height: 920, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false } });
  browserWindow.webContents.on('console-message', (_event, level, message) => rendererConsole.push(`[${level}] ${message}`));
  await browserWindow.loadFile(htmlPath);
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 'message navigation did not render');

  await openEmployees();
  await openAgent('instance-agent-a');
  await sendMessage('A_ONLY_MESSAGE');
  await openEmployees();
  await openAgent('instance-agent-b');
  await beginMessage('B_ONLY_MESSAGE');
  await waitFor(`window.__agentIsolationTest.terminalEventWindow === 'instance-agent-b'`, 'Agent B terminal event window did not open');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const terminalEventState = await browserWindow.webContents.executeJavaScript(
    `import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
      session: state.sessions.find((item) => item.id === 'session-instance-agent-b') || null,
      rowVisible: Boolean(document.querySelector('[data-agent-message-row="general_agent"][data-agent-instance-row="instance-agent-b"]')),
    }))`,
  );
  assert.equal(terminalEventState.session?.agentInstanceId, 'instance-agent-b',
    'Agent B identity was dropped from the pending session before the session refresh');
  assert.equal(terminalEventState.rowVisible, true, 'Agent B disappeared after the terminal event and before the session refresh');
  await waitFor(`!window.__agentIsolationTest.terminalEventWindow && !document.querySelector('#chat-form .send-btn')?.disabled
    && document.querySelector('#message-list')?.textContent.includes('B_ONLY_MESSAGE')`, 'Agent B message did not finish');

  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = 'B_UNSENT_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await openEmployees();
  await openAgent('instance-agent-a');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), '',
    'Agent A inherited Agent B\'s unsent draft');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = 'A_UNSENT_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await openEmployees();
  await openAgent('instance-agent-b');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), 'B_UNSENT_DRAFT',
    'Agent B draft was not restored after switching back');
  await openEmployees();
  await openAgent('instance-agent-a');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), 'A_UNSENT_DRAFT',
    'Agent A draft was not restored after switching back');
  await openUBuddy();
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), '',
    'uBuddy inherited Agent A\'s unsent draft');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = 'UBUDDY_UNSENT_DRAFT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await openEmployees();
  await openAgent('instance-agent-a');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), 'A_UNSENT_DRAFT',
    'Agent A draft was overwritten by uBuddy input');
  await openUBuddy();
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#chat-input')?.value`), 'UBUDDY_UNSENT_DRAFT',
    'uBuddy draft was not restored after returning from Agent A');
  await openEmployees();
  await openAgent('instance-agent-a');
  const isolatedDrafts = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    ...state.agentConversationDrafts,
  }))`);
  assert.deepEqual(isolatedDrafts, {
    'instance-agent-a': 'A_UNSENT_DRAFT',
    'instance-agent-b': 'B_UNSENT_DRAFT',
  });
  const persistedDrafts = await browserWindow.webContents.executeJavaScript(`JSON.parse(
    localStorage.getItem('janus-composer-drafts-v1:agent-isolation-user:workspace_personal') || '{}'
  ).agentConversationDrafts || {}`);
  assert.deepEqual(persistedDrafts, isolatedDrafts, 'Agent drafts were not persisted by Agent instance');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await openEmployees();
  await openAgent('instance-agent-a');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('A_ONLY_MESSAGE')`, 'Agent A history missing');
  const viewA = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    text: document.querySelector('#message-list')?.textContent || '',
    sessionId: state.currentSessionId, messages: state.messages, agentId: state.currentAgentId,
  }))`);
  assert.match(viewA.text, /A_ONLY_MESSAGE/);
  assert.match(viewA.text, /A_ONLY_REPLY/);
  assert.doesNotMatch(viewA.text, /B_ONLY_MESSAGE|B_ONLY_REPLY/);
  assert.equal(viewA.sessionId, 'session-instance-agent-a');
  writeFileSync(screenshotA, (await browserWindow.capturePage()).toPNG());

  await openEmployees();
  await browserWindow.webContents.executeJavaScript(`window.__agentIsolationTest.delayMode = true`);
  await openAgent('instance-agent-a');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.activeProjectId = 'stale-project-from-agent-a';
    state.workspaceRoot = '/tmp/stale-project-from-agent-a';
  })`);
  await openEmployees();
  await openAgent('instance-agent-b');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('B_ONLY_MESSAGE')`, 'Agent B did not win rapid switch race');
  await new Promise((resolve) => setTimeout(resolve, 260));
  const viewB = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    text: document.querySelector('#message-list')?.textContent || '', sessionId: state.currentSessionId,
    messages: state.messages, sends: window.__agentIsolationTest.sends, errors: window.__agentIsolationTest.errors,
    activeProjectId: state.activeProjectId, workspaceRoot: state.workspaceRoot,
  }))`);
  assert.equal(viewB.sessionId, 'session-instance-agent-b');
  assert.match(viewB.text, /B_ONLY_MESSAGE/);
  assert.match(viewB.text, /B_ONLY_REPLY/);
  assert.doesNotMatch(viewB.text, /A_ONLY_MESSAGE|A_ONLY_REPLY/);
  assert.deepEqual(viewB.sends.map((item) => item.agentInstanceId), ['instance-agent-a', 'instance-agent-b']);
  assert.deepEqual(viewB.sends.map((item) => item.agentId), ['general_agent', 'general_agent']);
  assert.equal(viewB.activeProjectId, '', 'Agent B inherited Agent A project selection');
  assert.equal(viewB.workspaceRoot, '', 'Agent B inherited Agent A workspace path');
  assert.deepEqual(viewB.errors, []);
  const messageRows = await browserWindow.webContents.executeJavaScript(`[...document.querySelectorAll('[data-agent-message-row="general_agent"]')].map((row) => ({
    instanceId: row.dataset.agentInstanceRow || '',
    sessionId: row.dataset.networkSession || '',
    label: row.querySelector('strong')?.textContent || '',
    title: row.getAttribute('title') || '',
  })).sort((left, right) => left.instanceId.localeCompare(right.instanceId))`);
  assert.deepEqual(messageRows.map((item) => item.instanceId), ['instance-agent-a', 'instance-agent-b']);
  assert.deepEqual(messageRows.map((item) => item.sessionId), ['session-instance-agent-a', 'session-instance-agent-b']);
  assert.deepEqual(messageRows.map((item) => item.label), ['通用 Agent A', '通用 Agent B']);
  assert.match(messageRows[0].title, /负责研究与分析/);
  assert.match(messageRows[1].title, /负责写作与整理/);
  writeFileSync(screenshotB, (await browserWindow.capturePage()).toPNG());

  const storedSessionOverviewBaseline = await browserWindow.webContents.executeJavaScript(`({
    calls: window.__agentIsolationTest.conversationOverviewCalls.filter((id) => id === 'instance-agent-a').length,
  })`);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.employeeConversationOverviewByInstanceId = {};
  })`);
  await click('[data-network-session="session-instance-agent-a"]');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('A_ONLY_MESSAGE')
    && document.querySelector('#message-list')?.textContent.includes('A_READ_ONLY_HISTORY')
    && document.querySelector('#chat-input')`,
  'stored Agent session did not hydrate the unified Agent timeline');
  const storedSessionHistoryEntry = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    sessionId: state.currentSessionId,
    agentInstanceId: state.currentAgentInstanceId,
    chatKey: state.currentChatKey,
    hasHistoricalMessage: state.messages.some((message) => message.content === 'A_READ_ONLY_HISTORY'),
    composerVisible: Boolean(document.querySelector('#chat-input')),
    overviewCalls: window.__agentIsolationTest.conversationOverviewCalls.filter((id) => id === 'instance-agent-a').length,
  }))`);
  assert.equal(storedSessionHistoryEntry.sessionId, 'session-instance-agent-a');
  assert.equal(storedSessionHistoryEntry.agentInstanceId, 'instance-agent-a');
  assert.equal(storedSessionHistoryEntry.chatKey, 'agent:instance-agent-a');
  assert.equal(storedSessionHistoryEntry.hasHistoricalMessage, true);
  assert.equal(storedSessionHistoryEntry.composerVisible, true);
  assert(storedSessionHistoryEntry.overviewCalls > storedSessionOverviewBaseline.calls,
    'opening a stored Agent session did not request its conversation overview');
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__agentIsolationTest.historyGroupCalls.length`), 0);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    window.__agentIsolationTest.forceEmptyTimeline = true;
    window.__agentIsolationTest.listMessagesCalls = [];
    state.employeeConversationOverviewByInstanceId['instance-agent-a'] = {
      activeWork: { route: 'task_run', taskRunId: 'agent-a-running-task', status: 'running', currentAction: '正在执行任务' },
      historyGroups: [], historySessions: [],
    };
    state.agentWorkStatusByInstanceId = { ...(state.agentWorkStatusByInstanceId || {}), 'instance-agent-a': { availability: 'working', workState: 'running' } };
  })`);
  await click('[data-network-session="session-instance-agent-a"]');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('A_ONLY_MESSAGE')
    && document.querySelector('.employee-conversation-active-work')`,
  'empty Agent timeline erased persisted messages or the running work card');
  const emptyTimelineFallback = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    messages: state.messages.map((message) => message.content),
    listMessagesCalls: window.__agentIsolationTest.listMessagesCalls,
    activeTaskRunId: state.employeeConversationOverviewByInstanceId['instance-agent-a']?.activeWork?.taskRunId || '',
  }))`);
  assert.ok(emptyTimelineFallback.messages.includes('A_ONLY_MESSAGE'));
  assert.ok(emptyTimelineFallback.listMessagesCalls.includes('session-instance-agent-a'));
  assert.equal(emptyTimelineFallback.activeTaskRunId, 'agent-a-running-task');
  await browserWindow.webContents.executeJavaScript(`window.__agentIsolationTest.forceEmptyTimeline = false`);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.employeeConversationOverviewByInstanceId = {};
    window.__agentIsolationTest.overviewFailures['instance-agent-b'] = true;
  })`);
  await click('[data-network-session="session-instance-agent-b"]');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('B_ONLY_MESSAGE')
    && document.querySelector('.app-notice')?.textContent.includes('历史对话加载失败')`,
  'overview failure blocked the stored Agent conversation');
  const overviewFailureFallback = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    sessionId: state.currentSessionId,
    composerVisible: Boolean(document.querySelector('#chat-input')),
    errors: window.__agentIsolationTest.errors,
  }))`);
  assert.equal(overviewFailureFallback.sessionId, 'session-instance-agent-b');
  assert.equal(overviewFailureFallback.composerVisible, true);
  assert.deepEqual(overviewFailureFallback.errors, []);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.employeeConversationOverviewByInstanceId = {};
    window.__agentIsolationTest.overviewFailures['instance-agent-b'] = false;
    window.__agentIsolationTest.aliasRedirect = true;
  })`);
  await click('[data-network-session="session-instance-agent-a"]');
  await waitFor(`document.querySelector('#message-list')?.textContent.includes('B_ONLY_MESSAGE')`,
  'stored Agent identity alias did not redirect to the canonical window');
  const storedSessionIdentityMismatch = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    sessionId: state.currentSessionId,
    agentInstanceId: state.currentAgentInstanceId,
    chatKey: state.currentChatKey,
    text: document.querySelector('#message-list')?.textContent || '',
    cachedOverview: state.employeeConversationOverviewByInstanceId['instance-agent-b'] || null,
  }))`);
  assert.equal(storedSessionIdentityMismatch.sessionId, 'session-instance-agent-b');
  assert.equal(storedSessionIdentityMismatch.agentInstanceId, 'instance-agent-b');
  assert.equal(storedSessionIdentityMismatch.chatKey, 'agent:instance-agent-b');
  assert.match(storedSessionIdentityMismatch.text, /B_ONLY_MESSAGE|B_ONLY_REPLY/);
  assert.doesNotMatch(storedSessionIdentityMismatch.text, /A_ONLY_MESSAGE|A_ONLY_REPLY/);
  assert.ok(storedSessionIdentityMismatch.cachedOverview);
  await browserWindow.webContents.executeJavaScript(`window.__agentIsolationTest.aliasRedirect = false`);

  await openEmployees();
  await browserWindow.webContents.executeJavaScript(`(() => {
    Object.assign(window.__agentIsolationTest, {
      delayMode: false, overviewDelays: { 'instance-agent-b': 220, 'instance-agent-a': 20 },
    });
    return true;
  })()`);
  await beginOpenAgent('instance-agent-b');
  await new Promise((resolve) => setTimeout(resolve, 10));
  await beginOpenAgent('instance-agent-a');
  await new Promise((resolve) => setTimeout(resolve, 320));
  const overviewRace = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    sessionId: state.currentSessionId, agentInstanceId: state.currentAgentInstanceId,
  }))`);
  assert.equal(overviewRace.sessionId, 'session-instance-agent-a', 'late Agent B overview must not replace the newer Agent A selection');
  assert.equal(overviewRace.agentInstanceId, 'instance-agent-a');

  await openEmployees();
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__agentIsolationTest.canonicalRefresh = true;
    window.__agentIsolationTest.emitEmployeesUpdated?.({
      userId: 'agent-isolation-user', accountWorkspaceId: 'workspace_personal', reason: 'test_canonical_refresh',
    });
  })()`);
  await waitFor(`!document.querySelector('[data-contacts-employee-card="instance-agent-a"]')`, 'employee update event did not remove the stale Agent A card');
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__agentIsolationTest.canonicalRefresh = false;
    window.__agentIsolationTest.emitEmployeesUpdated?.({
      userId: 'agent-isolation-user', accountWorkspaceId: 'workspace_personal', reason: 'test_roster_restore',
    });
  })()`);
  await waitFor(`document.querySelector('[data-contacts-employee-card="instance-agent-a"]')`, 'employee update event did not restore the refreshed Agent A card');

  const aliasBaseline = await browserWindow.webContents.executeJavaScript(`({
    bLoads: window.__agentIsolationTest.listMessagesCalls.filter((id) => id === 'session-instance-agent-b').length,
  })`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    Object.assign(window.__agentIsolationTest, {
      aliasRedirect: true, canonicalRefresh: true, overviewDelays: {},
    });
    return true;
  })()`);
  await beginOpenAgent('instance-agent-a');
  await waitFor(`document.querySelector('.app-notice')?.textContent.includes('Agent 身份已同步')`, 'alias redirect did not show the identity refresh notice');
  await waitFor(`!document.querySelector('[data-contacts-employee-card="instance-agent-a"]')`, 'alias redirect did not remove the stale Agent A card');
  const aliasResult = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    sessionId: state.currentSessionId,
    bLoads: window.__agentIsolationTest.listMessagesCalls.filter((id) => id === 'session-instance-agent-b').length,
    errors: window.__agentIsolationTest.errors,
  }))`);
  assert.equal(aliasResult.sessionId, 'session-instance-agent-a', 'alias redirect must stop instead of opening Agent B');
  assert.equal(aliasResult.bLoads, aliasBaseline.bLoads, 'alias redirect must not load Agent B messages');
  assert.deepEqual(aliasResult.errors, []);
  process.stdout.write(`Renderer Agent isolation UI smoke passed.\nAgent A screenshot: ${screenshotA}\nAgent B screenshot: ${screenshotB}\n`);
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-agent-isolation', stateExpression: 'window.__agentIsolationTest?.errors || []' });
  const rendererErrors = browserWindow && !browserWindow.isDestroyed()
    ? await browserWindow.webContents.executeJavaScript('window.__agentIsolationTest?.errors || []').catch(() => []) : [];
  process.stderr.write(`${error?.stack || error}\n${rendererErrors.join('\n')}\n${rendererConsole.join('\n')}\n`);
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
