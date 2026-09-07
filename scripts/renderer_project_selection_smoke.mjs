import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-project-selection-ui-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const htmlPath = path.join(tempRoot, 'project-selection-smoke.html');
const existingScreenshotPath = process.env.JANUS_PROJECT_SELECTION_EXISTING_SCREENSHOT || '/tmp/janus-project-selection-existing-ui.png';
const screenshotPath = process.env.JANUS_PROJECT_SELECTION_SCREENSHOT || '/tmp/janus-project-selection-ui.png';
const projectA = { id: 'project-alpha', title: 'Alpha 项目', workspaceRoot: path.join(tempRoot, 'alpha'), status: 'active' };
const projectB = { id: 'project-beta', title: 'Beta 空项目', workspaceRoot: path.join(tempRoot, 'beta'), status: 'active' };
const currentSession = {
  id: 'session-current-agent',
  title: '当前 Agent 对话',
  departmentId: 'general',
  agentId: 'general_agent',
  agentInstanceId: 'general_agent_instance',
  status: 'active',
};

const bootstrap = {
  appVersion: '0.2.2',
  root: tempRoot,
  workspaceRoot: '',
  org: {
    departments: [{ id: 'general', name: '通用部门' }],
    agents: [{ id: 'general_agent', name: '通用 Agent', departmentId: 'general', routable: true }],
    hrs: [],
  },
  sessions: [currentSession],
  projects: [projectA, projectB],
  tasks: [],
  agentStatuses: [],
  evolution: null,
  currentUser: { id: 'project-selection-user', displayName: '项目测试用户', role: 'member', permissions: {} },
  adminUsers: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [],
  agentDelegations: [],
  collaboration: { groups: [], tasks: [] },
  socialStatus: { enabled: false, connected: false },
  codexConfig: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
  codexConfigFiles: null,
  cloudSync: null,
  userAgentSettings: [],
  plugins: [],
  modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
};

writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>Project selection UI smoke</title><link rel="stylesheet" href="${rendererStyle}"></head>
  <body>
    <div id="app"></div>
    <script>
      const bootstrap = ${JSON.stringify(bootstrap)};
      const currentSession = ${JSON.stringify(currentSession)};
      const subscribe = () => () => {};
      window.__projectSelectionTest = { updates: [], projectUpdates: [], confirmCalls: [], errors: [] };
      window.confirm = (message) => { window.__projectSelectionTest.confirmCalls.push(message); return true; };
      window.addEventListener('error', (event) => window.__projectSelectionTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
      window.addEventListener('unhandledrejection', (event) => window.__projectSelectionTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
      window.janus = {
        platform: 'win32',
        bootstrap: async () => bootstrap,
        updateStatus: async () => ({ enabled: true, available: false }),
        agentUpdateStatus: async () => ({ enabled: true, available: false }),
        onCodexEvent: subscribe,
        onUpdateStatus: subscribe,
        onAgentUpdateStatus: subscribe,
        onPluginProgress: subscribe,
        onEvolutionProgress: subscribe,
        onModelsUpdated: subscribe,
        onSocialUpdated: subscribe,
        updateSession: async (payload) => {
          window.__projectSelectionTest.updates.push(payload);
          return { ...currentSession, ...payload };
        },
        listSessions: async () => bootstrap.sessions,
        listMessages: async () => [],
        chatContextStatus: async () => null,
        listProjects: async () => bootstrap.projects.filter((item) => !['archived', 'deleted'].includes(item.status)),
        updateProject: async (payload) => {
          window.__projectSelectionTest.projectUpdates.push(payload);
          const project = bootstrap.projects.find((item) => item.id === payload.projectId);
          if (project && payload.action === 'archive') project.status = 'archived';
          if (project && payload.action === 'remove') project.status = 'deleted';
          return project || null;
        },
        listTasks: async () => [],
        minimizeWindow: async () => null,
        toggleMaximizeWindow: async () => null,
        closeWindow: async () => null,
      };
    </script>
    <script type="module" src="${rendererEntry}"></script>
  </body>
</html>`, 'utf8');

let browserWindow;
const rendererConsole = [];
const waitFor = (expression, failureMessage, timeout = 10000) => browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = Date.now() + ${timeout};
  const poll = () => {
    if (${expression}) return resolve(true);
    if (Date.now() > deadline) return reject(new Error(${JSON.stringify(failureMessage)}));
    setTimeout(poll, 20);
  };
  poll();
})`);

async function selectProject(projectId) {
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-workspace-menu-toggle]').click()`);
  await waitFor(`document.querySelector('[data-workspace-project="${projectId}"]')`, `project option ${projectId} did not render`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-workspace-project="${projectId}"]').click()`);
}

try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  browserWindow.webContents.on('console-message', (_event, level, message) => {
    rendererConsole.push(`[${level}] ${message}`);
  });
  await browserWindow.loadFile(htmlPath);
  await waitFor(`document.querySelector('[data-network-session="${currentSession.id}"]')`, 'current Agent session did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-network-session="${currentSession.id}"]').click()`);
  await waitFor("document.querySelector('#chat-input') && document.querySelector('[data-workspace-menu-toggle]')", 'chat composer did not render');

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.currentSessionId = 'session-current-agent';
    state.messages = [{ id: 'message-existing', role: 'assistant', content: '这条消息必须留在当前聊天中。', departmentId: 'general' }];
    state.currentDepartmentId = 'general';
    state.currentAgentId = 'general_agent';
    state.selectionSource = 'manual';
    state.chatDraft = '继续当前话题';
    document.querySelector('#chat-input').value = state.chatDraft;
  })`);
  await selectProject(projectA.id);
  await waitFor("window.__projectSelectionTest.updates.length === 1", 'existing session was not attached to the project');
  const existingChatSnapshot = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    currentSessionId: state.currentSessionId,
    messageCount: state.messages.length,
    messageText: state.messages[0]?.content || '',
    departmentId: state.currentDepartmentId,
    agentId: state.currentAgentId,
    selectionSource: state.selectionSource,
    chatDraft: state.chatDraft,
    activeProjectId: state.activeProjectId,
    workspaceRoot: state.workspaceRoot,
    projectLabel: document.querySelector('[data-workspace-menu-toggle] span')?.textContent.trim() || '',
    visibleMessage: document.body.innerText.includes('这条消息必须留在当前聊天中。'),
    updatePayload: window.__projectSelectionTest.updates[0],
  }))`);
  assert.equal(existingChatSnapshot.currentSessionId, currentSession.id);
  assert.equal(existingChatSnapshot.messageCount, 1);
  assert.equal(existingChatSnapshot.messageText, '这条消息必须留在当前聊天中。');
  assert.equal(existingChatSnapshot.departmentId, 'general');
  assert.equal(existingChatSnapshot.agentId, 'general_agent');
  assert.equal(existingChatSnapshot.selectionSource, 'manual');
  assert.equal(existingChatSnapshot.chatDraft, '继续当前话题');
  assert.equal(existingChatSnapshot.activeProjectId, projectA.id);
  assert.equal(existingChatSnapshot.workspaceRoot, projectA.workspaceRoot);
  assert.equal(existingChatSnapshot.projectLabel, projectA.title);
  assert.equal(existingChatSnapshot.visibleMessage, true);
  assert.deepEqual(existingChatSnapshot.updatePayload, {
    sessionId: currentSession.id,
    projectId: projectA.id,
    workspaceRoot: projectA.workspaceRoot,
  });
  writeFileSync(existingScreenshotPath, (await browserWindow.capturePage()).toPNG());

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.currentSessionId = '';
    state.messages = [];
    state.currentDepartmentId = 'general';
    state.currentAgentId = 'general_agent';
    state.selectionSource = 'manual';
    state.activeProjectId = '';
    state.workspaceRoot = '';
    state.workspaceDetached = false;
    state.chatDraft = '尚未发送的新 Agent 对话';
    document.querySelector('#chat-input').value = state.chatDraft;
  })`);
  await selectProject(projectB.id);
  const newChatSnapshot = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    currentSessionId: state.currentSessionId,
    messageCount: state.messages.length,
    departmentId: state.currentDepartmentId,
    agentId: state.currentAgentId,
    selectionSource: state.selectionSource,
    chatDraft: state.chatDraft,
    activeProjectId: state.activeProjectId,
    workspaceRoot: state.workspaceRoot,
    projectLabel: document.querySelector('[data-workspace-menu-toggle] span')?.textContent.trim() || '',
    agentTag: document.querySelector('.input-tag.tag-agent .tag-label')?.textContent.trim() || '',
    errors: window.__projectSelectionTest.errors,
  }))`);
  assert.equal(newChatSnapshot.currentSessionId, '');
  assert.equal(newChatSnapshot.messageCount, 0);
  assert.equal(newChatSnapshot.departmentId, 'general');
  assert.equal(newChatSnapshot.agentId, 'general_agent');
  assert.equal(newChatSnapshot.selectionSource, 'manual');
  assert.equal(newChatSnapshot.chatDraft, '尚未发送的新 Agent 对话');
  assert.equal(newChatSnapshot.activeProjectId, projectB.id);
  assert.equal(newChatSnapshot.workspaceRoot, projectB.workspaceRoot);
  assert.equal(newChatSnapshot.projectLabel, projectB.title);
  assert.equal(newChatSnapshot.agentTag, '通用 Agent');
  assert.deepEqual(newChatSnapshot.errors, []);

  writeFileSync(screenshotPath, (await browserWindow.capturePage()).toPNG());
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-workspace-menu-toggle]').click()`);
  await waitFor(`document.querySelector('[data-workspace-project-remove="${projectB.id}"]')`, 'project remove control did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-workspace-project-remove="${projectB.id}"]').click()`);
  await waitFor(`!document.querySelector('[data-workspace-project="${projectB.id}"]')`, 'removed project remained in the picker');
  const removedProject = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    activeProjectId: state.activeProjectId,
    workspaceRoot: state.workspaceRoot,
    workspaceDetached: state.workspaceDetached,
    projectLabel: document.querySelector('[data-workspace-menu-toggle] span')?.textContent.trim() || '',
    chatDraft: state.chatDraft,
    update: window.__projectSelectionTest.projectUpdates.at(-1),
    confirmCalls: window.__projectSelectionTest.confirmCalls,
    visibleProjectIds: [...document.querySelectorAll('[data-workspace-project]')].map((item) => item.dataset.workspaceProject),
  }))`);
  assert.equal(removedProject.activeProjectId, '');
  assert.equal(removedProject.workspaceRoot, '');
  assert.equal(removedProject.workspaceDetached, true);
  assert.equal(removedProject.projectLabel, '无项目');
  assert.equal(removedProject.chatDraft, '尚未发送的新 Agent 对话');
  assert.deepEqual(removedProject.update, { projectId: projectB.id, action: 'remove' });
  assert.deepEqual(removedProject.confirmCalls, []);
  assert.equal(removedProject.visibleProjectIds.includes(projectB.id), false);
  process.stdout.write(`Renderer project selection UI smoke passed.\nExisting chat screenshot: ${existingScreenshotPath}\nNew chat screenshot: ${screenshotPath}\n`);
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-project-selection', stateExpression: 'window.__projectSelectionTest?.errors || []' });
  const rendererErrors = browserWindow && !browserWindow.isDestroyed()
    ? await browserWindow.webContents.executeJavaScript('window.__projectSelectionTest?.errors || []').catch(() => [])
    : [];
  process.stderr.write(`${error?.stack || error}\n${rendererErrors.join('\n')}\n${rendererConsole.join('\n')}\n`);
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
