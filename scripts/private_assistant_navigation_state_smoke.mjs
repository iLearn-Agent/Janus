import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { createChatRunController } from '../src/renderer/app/features/chat/chatRunController.js';
import { isPrivateAssistantComposerMode } from '../src/renderer/app/views/chatView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderSidebar, renderTopbar } from '../src/renderer/app/views/navigationView.js';

const run = {
  channelId: 'private-navigation-run',
  sessionId: 'private-navigation-session',
  displaySessionId: 'private-navigation-session',
  executionSessionId: 'private-navigation-session',
  chatKey: 'session:private-navigation-session',
  departmentId: 'private_assistant',
  agentId: 'private_assistant',
  targetKind: 'private_assistant',
  statusMessageId: 'private-navigation-status',
  assistantContent: '',
  draftContent: '',
  processEvents: [],
  terminal: false,
};

Object.assign(state, {
  currentUser: { id: 'private-navigation-user', displayName: '私人助理测试用户' },
  currentTab: 'employees',
  currentSessionId: 'another-session',
  currentChatKey: 'session:another-session',
  currentDepartmentId: '',
  currentAgentId: '',
  homeMode: 'department',
  languageMode: 'zh-CN',
  networkPanelOpen: false,
  networkPanelView: 'messages',
  networkMessageHomeOpen: true,
  chatRuns: [run],
  activeChatRun: null,
  privateAssistantResultUnread: false,
  privateAssistant: { exhausted: false },
  sessions: [{
    id: 'private-navigation-session',
    departmentId: 'private_assistant',
    agentId: 'private_assistant',
    status: 'active',
    updatedAt: new Date().toISOString(),
  }],
  org: { departments: [], agents: [], hrs: [], leaders: [] },
  projects: [],
  tasks: [],
  socialInbox: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  collaborationOverview: { groups: [], tasks: [] },
  markedConversationKeys: [],
  unreadConversationKeys: [],
  completedConversationKeys: [],
});

const runningPanel = renderNetworkPanel();
assert.match(runningPanel, /data-private-assistant-entry[^>]*is-running|is-running[^>]*data-private-assistant-entry/);
assert.match(runningPanel, /<strong[^>]*>私人助理<\/strong>/);
assert.match(runningPanel, /im-message-shortcut-badge"[^>]*>运行中<\/small>/);
assert.match(runningPanel, /aria-busy="true"/);
assert.match(runningPanel, /title="本地隔离空间：不与其他 Agent 通信/);

const runningSidebar = renderSidebar();
assert.match(runningSidebar, /data-network-view="messages"[^>]*has-active-run|has-active-run[^>]*data-network-view="messages"/);
assert.match(runningSidebar, /私人助理正在运行/);

let renderCount = 0;
const controller = createChatRunController({
  api: {},
  windowRef: {},
  documentRef: { getElementById: () => null },
  state,
  render: () => { renderCount += 1; },
  notify: () => {},
  userVisibleErrorMessage: (value) => String(value || ''),
  chatRunForChannel: (channelId) => state.chatRuns.find((item) => item.channelId === channelId) || null,
  syncCurrentChatRun: () => null,
  upsertRecentSession: () => {},
  expandProject: () => {},
  agentNameById: () => '',
  departmentName: () => '',
  allChatRuns: () => state.chatRuns,
  currentChatRun: () => null,
  captureMessageScrollState: () => null,
  restoreMessageScrollState: () => {},
  renderMessageList: () => '',
  parsePreviewPayload: () => null,
  previewFileInfo: () => {},
  saveFileFromPayload: () => {},
  showFileFromPayload: () => {},
  openFileFromPayload: () => {},
  openCollaborationTask: () => {},
  copyMessageText: () => {},
  editMessageFromHistory: () => {},
  pathBasename: () => '',
  projectForSession: () => null,
  activeProject: () => null,
  scrollMessagesToBottom: () => {},
  imageModelOptions: [],
  runStatusRefreshMs: 1000,
  runUpdateThrottleMs: 0,
  setTimer: (callback) => { callback(); return 1; },
  setRepeatingTimer: () => 1,
  clearRepeatingTimer: () => {},
});

controller.handleChatRunEvent(run.channelId, { kind: 'done', targetKind: 'private_assistant' });
assert.equal(state.privateAssistantResultUnread, true, 'finishing away from the private assistant chat should mark the result for review');
assert.equal(run.terminal, true);

const completedPanel = renderNetworkPanel();
assert.match(completedPanel, /data-private-assistant-entry[^>]*has-result|has-result[^>]*data-private-assistant-entry/);
assert.match(completedPanel, /<strong[^>]*>私人助理<\/strong>/);
assert.match(completedPanel, /im-message-shortcut-badge"[^>]*>待查看<\/small>/);
const completedSidebar = renderSidebar();
assert.match(completedSidebar, /data-network-view="messages"[^>]*has-private-result|has-private-result[^>]*data-network-view="messages"/);
assert.match(completedSidebar, /私人助理有待查看结果/);

Object.assign(state, {
  currentTab: 'chat',
  currentSessionId: 'private-navigation-session',
  currentChatKey: 'session:private-navigation-session',
  homeMode: 'private_assistant',
  networkPanelOpen: true,
  networkPanelView: 'messages',
  networkMessageHomeOpen: false,
});
const privateTopbar = renderTopbar();
assert.match(privateTopbar, /本地隔离 · 仅你可见/);
assert.match(privateTopbar, /title="本地隔离空间：不与其他 Agent 通信/);

state.sessions = [...state.sessions, {
  id: 'generalist-transition-session', departmentId: 'general', agentId: 'general_agent', status: 'active',
}];
Object.assign(state, {
  currentSessionId: 'generalist-transition-session',
  homeMode: 'private_assistant',
  currentDepartmentId: '',
  currentAgentId: '',
  currentAgentInstanceId: '',
});
assert.equal(isPrivateAssistantComposerMode(), false, 'a concrete Generalist session must override stale private home mode');
Object.assign(state, {
  currentSessionId: '',
  homeMode: 'private_assistant',
  currentDepartmentId: 'general',
  currentAgentId: 'general_agent',
});
assert.equal(isPrivateAssistantComposerMode(), false, 'a concrete Agent selection must suppress the private quota during transition');
Object.assign(state, {
  currentSessionId: 'private-navigation-session',
  homeMode: 'department',
  currentDepartmentId: '',
  currentAgentId: '',
});
assert.equal(isPrivateAssistantComposerMode(), true, 'a concrete private session must override stale department home mode');

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const privateEntryStart = rendererSource.indexOf("if (peerId === 'self-private-assistant')");
const privateEntryEnd = rendererSource.indexOf('openNetworkConversation(peerId', privateEntryStart);
const privateEntrySource = rendererSource.slice(privateEntryStart, privateEntryEnd);
assert.match(privateEntrySource, /ensurePrivateAssistantSession/);
assert.match(privateEntrySource, /currentRendererMessageSurfaceKey\(\) !== sourceSurfaceKey/);
assert.match(privateEntrySource, /upsertRecentSession\(session\)/);
assert.match(privateEntrySource, /openSession\(session\.id, \{ preserveNetworkPanel: true \}\)/);
assert.doesNotMatch(privateEntrySource, /startNewPlainChat/);

assert.equal(renderCount, 0, 'background completion should update derived navigation state without repainting the inactive chat');
console.log('private assistant navigation state smoke passed');
