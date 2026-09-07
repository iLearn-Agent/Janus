import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderMessageDefaultPage } from '../src/renderer/app/views/messageHomeView.js';

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const chatStyles = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
const workspaceStyles = readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');

assert.match(renderMessageDefaultPage(0, { animateVariant: false }), /message-default-content[^>]*is-refresh/);
assert.doesNotMatch(renderMessageDefaultPage(0, { animateVariant: true }), /message-default-content[^>]*is-refresh/);
assert.match(workspaceStyles, /\.message-default-content\.is-refresh \.message-default-visual\s*\{\s*animation:\s*none/);
assert.match(rendererSource, /messageDefaultVariantKey !== renderedMessageDefaultVariantKey/);
assert.match(rendererSource, /document\.documentElement\.classList\.add\('is-render-refreshing'\)/);
assert.match(chatStyles, /html\.is-render-refreshing \.composer\s*\{\s*transition:\s*none !important/);

Object.assign(state, {
  languageMode: 'zh-CN',
  currentUser: { id: 'transition-user', displayName: 'Transition User' },
  collaborationGroupId: 'transition-group',
  collaborationGroupDetail: null,
  collaborationGroupWorkspace: null,
  collaborationOverview: {
    groups: [{
      id: 'transition-group',
      title: '稳定跳转任务群',
      memberCount: 3,
      status: 'active',
    }],
    tasks: [],
  },
  networkConversationPeerId: '',
  networkConversationGroupId: '',
  messages: [],
  draggingFiles: false,
});

const loadingMarkup = renderChat();
assert.match(loadingMarkup, /collaboration-group-loading-view/);
assert.match(loadingMarkup, /data-collaboration-group-loading="transition-group"/);
assert.match(loadingMarkup, /稳定跳转任务群/);
assert.match(loadingMarkup, /正在打开(?:任务|工作)群/);
assert.doesNotMatch(loadingMarkup, /class="view chat-view home/);

state.collaborationGroupDetail = {
  group: {
    id: 'transition-group',
    title: '稳定跳转任务群',
    status: 'active',
    ownerUserId: 'transition-user',
  },
  members: [{
    userId: 'transition-user',
    status: 'active',
    user: { id: 'transition-user', displayName: 'Transition User' },
  }],
  tasks: [],
  messages: [],
};

const loadedMarkup = renderChat();
assert.match(loadedMarkup, /collaboration-group-chat-view/);
assert.doesNotMatch(loadedMarkup, /collaboration-group-loading-view/);
assert.match(loadedMarkup, /(?:任务|工作)群已创建/);

Object.assign(state, {
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  currentTab: 'chat',
  currentSessionId: 'employee-history-primary',
  currentAgentInstanceId: 'employee-history-instance',
  sessions: [{
    id: 'employee-history-primary', title: '员工当前会话', agentId: 'general_agent',
    agentInstanceId: 'employee-history-instance', departmentId: 'general', status: 'active',
  }],
  employeeOverview: { roster: [{ id: 'employee-history-instance', displayName: '历史员工', agentFamilyId: 'general_agent' }] },
  employeeConversationOverviewByInstanceId: {
    'employee-history-instance': {
      activeWork: { route: 'task_run', taskRunId: 'employee-active-task', title: '正在整理历史资料' },
      historyGroups: [{ id: 'memory:old', kind: 'memory', title: '旧 Memory', messageCount: 2, lastMessageAt: '2026-08-02T00:00:00.000Z' }],
    },
  },
  employeeConversationHistoryViewer: null,
  messages: [{ id: 'current-message', role: 'assistant', content: '当前对话可见', createdAt: '2026-08-03T00:00:00.000Z', metadata: {} }],
});
const employeeConversationMarkup = renderChat();
assert.match(employeeConversationMarkup, /data-employee-active-work="employee-history-instance"/);
assert.match(employeeConversationMarkup, /Agent 当前工作/);
assert.match(employeeConversationMarkup, /class="conversation-top-stack"/);
assert.match(employeeConversationMarkup, /data-employee-history-group="memory:old"/);
assert.match(employeeConversationMarkup, /历史对话 1/);

state.messages = [
  {
    id: 'direct-source-message', role: 'user', content: '直接对话消息', createdAt: '2026-08-03T00:01:00.000Z',
    metadata: { timelineSource: { sourceKind: 'direct', workspaceName: 'test' } },
  },
  {
    id: 'task-source-message', role: 'assistant', content: '任务消息', createdAt: '2026-08-03T00:02:00.000Z',
    metadata: { timelineSource: { sourceKind: 'task', workspaceName: 'test' } },
  },
];
const timelineSourceMarkup = renderChat();
assert.doesNotMatch(timelineSourceMarkup, /test · 直接对话/);
assert.doesNotMatch(timelineSourceMarkup, /test · 任务/);
assert.doesNotMatch(timelineSourceMarkup, /agent-timeline-source/);

state.agentMenuOpen = true;
state.currentDepartmentId = 'general';
state.currentAgentId = 'general_agent';
const agentMenuMarkup = renderChat({
  agentsForDepartment: () => [{ id: 'general_agent', name: 'Generalist' }],
  shortAgentLabel: (agent) => agent.name,
  agentPickerTitle: () => '选择 agent',
});
assert.match(agentMenuMarkup, /agent-inline-picker model-picker menu-align-right menu-above is-open/);
assert.doesNotMatch(agentMenuMarkup, /agent-inline-picker model-picker menu-align-right menu-below/);
state.agentMenuOpen = false;
state.currentDepartmentId = '';
state.currentAgentId = '';
state.agentMenuOpen = true;
const inferredAgentPickerMarkup = renderChat({
  agentsForDepartment: (departmentId) => departmentId === 'general'
    ? [{ id: 'general_agent', name: 'Generalist' }]
    : [],
  shortAgentLabel: (agent) => agent.name,
  agentPickerTitle: () => '选择 agent',
});
assert.match(inferredAgentPickerMarkup, /data-agent-inline-trigger/,
  'ordinary Agent sessions must keep Agent Details visible while renderer identity state is loading');
assert.match(inferredAgentPickerMarkup, /data-agent-inline-department="general"/,
  'inferred Agent Details options must retain the session department for selection');
assert.match(rendererSource, /btn\.dataset\.agentInlineDepartment \|\| state\.currentDepartmentId/);
state.agentMenuOpen = false;
state.currentDepartmentId = 'general';
state.currentAgentId = 'specialist_agent';
const selectedAgentPickerMarkup = renderChat({
  agentsForDepartment: () => [
    { id: 'general_agent', name: 'Generalist' },
    { id: 'specialist_agent', name: 'Specialist' },
  ],
  shortAgentLabel: (agent) => agent.name,
  agentPickerTitle: () => '选择 agent',
});
assert.match(selectedAgentPickerMarkup, /config-model-label">Specialist</,
  'an explicit Agent selection must override the session fallback after loading');
state.currentDepartmentId = '';
state.currentAgentId = '';

state.composerImageMode = true;
assert.doesNotMatch(renderChat(), /data-agent-inline-trigger/,
  'image composer mode must hide Agent Details even when the session identifies an Agent');
state.composerImageMode = false;

state.employeeConversationHistoryViewer = {
  agentInstanceId: 'employee-history-instance', historyGroupId: 'memory:old', loading: false, error: '',
  detail: {
    group: { id: 'memory:old', kind: 'memory', title: '旧 Memory', messageCount: 2 },
    messages: [
      { id: 'old-user', role: 'user', content: '旧问题', createdAt: '2026-08-01T00:00:00.000Z', metadata: {} },
      { id: 'old-agent', role: 'assistant', content: '旧回答', createdAt: '2026-08-01T00:01:00.000Z', metadata: {} },
    ],
  },
};
const employeeHistoryMarkup = renderChat();
assert.match(employeeHistoryMarkup, /data-employee-history-back/);
assert.match(employeeHistoryMarkup, /旧问题/);
assert.match(employeeHistoryMarkup, /旧回答/);
assert.doesNotMatch(employeeHistoryMarkup, /id="chat-input"/);

Object.assign(state, {
  employeeConversationHistoryViewer: null,
  activeTaskWorkspaceKind: '',
  chatPlanViewer: null,
  networkPanelOpen: true,
  networkPanelView: 'messages',
  networkMessageHomeOpen: false,
  currentSessionId: 'ubuddy-empty',
  currentAgentInstanceId: 'ubuddy-instance',
  currentDepartmentId: '',
  currentAgentId: '',
  homeMode: 'secretary',
  sessions: [{
    id: 'ubuddy-empty', title: 'uBuddy', agentId: 'secretary_agent',
    agentInstanceId: 'ubuddy-instance', departmentId: 'secretary_department', status: 'active',
  }],
  messages: [{
    id: 'ubuddy-welcome', role: 'assistant', content: '我是 uBuddy。',
    metadata: { secretaryControl: true, welcome: true },
  }],
  messagePagination: { sessionId: 'ubuddy-empty', source: 'session', nextCursor: null, hasMore: false, loading: false },
});
const emptyUBuddyMarkup = renderChat();
assert.match(emptyUBuddyMarkup, /chat-view home message-shortcut-initial/);
assert.match(emptyUBuddyMarkup, /composer hero-composer[^"\n]*is-ubuddy-mode/);
assert.doesNotMatch(emptyUBuddyMarkup, /compact-composer/);
assert.doesNotMatch(emptyUBuddyMarkup, /has-context/);
assert.doesNotMatch(emptyUBuddyMarkup, /我是 uBuddy/);

state.messages = [];
state.messagePagination = { sessionId: 'ubuddy-empty', source: 'session', nextCursor: null, hasMore: false, loading: true, initialLoading: true };
const loadingUBuddyMarkup = renderChat();
assert.match(loadingUBuddyMarkup, /chat-view with-messages/);
assert.match(loadingUBuddyMarkup, /conversation-message-loading/);
assert.match(loadingUBuddyMarkup, /aria-label="正在加载对话消息"/);
assert.doesNotMatch(loadingUBuddyMarkup, /message-shortcut-initial/);
assert.doesNotMatch(loadingUBuddyMarkup, /hero-composer/);

state.messages = [
  { id: 'ubuddy-welcome', role: 'assistant', content: '我是 uBuddy。', metadata: { secretaryControl: true, welcome: true } },
  { id: 'ubuddy-user-message', role: 'user', content: '已有真实对话', metadata: {} },
];
state.messagePagination = { sessionId: 'ubuddy-empty', source: 'session', nextCursor: null, hasMore: false, loading: false };
const activeUBuddyConversationMarkup = renderChat();
assert.match(activeUBuddyConversationMarkup, /chat-view with-messages/);
assert.match(activeUBuddyConversationMarkup, /composer compact-composer/);
assert.doesNotMatch(activeUBuddyConversationMarkup, /message-shortcut-initial/);
assert.doesNotMatch(activeUBuddyConversationMarkup, /我是 uBuddy/);

Object.assign(state, {
  currentSessionId: 'private-assistant-empty',
  currentAgentInstanceId: '',
  homeMode: 'private_assistant',
  sessions: [{
    id: 'private-assistant-empty', title: '私人助理', agentId: 'private_assistant',
    departmentId: 'private_assistant', status: 'active',
  }],
  messages: [],
});
const emptyPrivateAssistantMarkup = renderChat();
assert.match(emptyPrivateAssistantMarkup, /chat-view home message-shortcut-initial/);
assert.match(emptyPrivateAssistantMarkup, /composer hero-composer[^"\n]*is-private-assistant-mode/);
assert.doesNotMatch(emptyPrivateAssistantMarkup, /compact-composer/);
assert.match(emptyPrivateAssistantMarkup, /composer hero-composer[^"\n]*has-context[^"\n]*is-private-assistant-mode/);
assert.match(emptyPrivateAssistantMarkup, /composer-context[\s\S]*私人助理/);
assert.doesNotMatch(emptyPrivateAssistantMarkup, /私人助理 · 本地隔离/);
assert.doesNotMatch(emptyPrivateAssistantMarkup, /data-agent-inline-trigger/);

Object.assign(state, {
  currentSessionId: 'ordinary-empty',
  currentAgentInstanceId: 'ordinary-instance',
  homeMode: 'department',
  sessions: [{
    id: 'ordinary-empty', title: '普通员工', agentId: 'general_agent',
    agentInstanceId: 'ordinary-instance', departmentId: 'general', status: 'active',
  }],
});
const emptyOrdinaryConversationMarkup = renderChat();
assert.match(emptyOrdinaryConversationMarkup, /chat-view with-messages/);
assert.match(emptyOrdinaryConversationMarkup, /composer compact-composer/);
assert.doesNotMatch(emptyOrdinaryConversationMarkup, /message-shortcut-initial/);
const emptyOrdinaryAgentPickerMarkup = renderChat({
  agentsForDepartment: (departmentId) => departmentId === 'general'
    ? [{ id: 'general_agent', name: 'Generalist' }]
    : [],
  shortAgentLabel: (agent) => agent.name,
  agentPickerTitle: () => '选择 agent',
});
assert.match(emptyOrdinaryAgentPickerMarkup, /data-agent-inline-trigger/);

const noticeStyles = readFileSync(new URL('../src/renderer/styles/attachments-preview.css', import.meta.url), 'utf8');
const networkStyles = readFileSync(new URL('../src/renderer/styles/network.css', import.meta.url), 'utf8');
const contactProfileTransitionStart = rendererSource.indexOf('function renderContactProfileTransition');
const contactProfileTransitionEnd = rendererSource.indexOf('function closeContactDirectoryContextMenu', contactProfileTransitionStart);
const contactProfileTransitionSource = rendererSource.slice(contactProfileTransitionStart, contactProfileTransitionEnd);
assert.match(rendererSource, /phase: 'entering'/);
assert.match(rendererSource, /function dismissNotice/);
assert.match(rendererSource, /phase: 'leaving'/);
assert.match(rendererSource, /NOTICE_EXIT_MS/);
assert.match(rendererSource, /function notify\(message, tone = 'info', durationMs = 3600, placement = '', action = null\)/);
assert.match(rendererSource, /removedAttachmentCount \? 3600 : 2500/);
assert.match(noticeStyles, /\.app-notice\.is-entering[\s\S]*app-notice-enter/);
assert.match(noticeStyles, /\.app-notice\.is-leaving[\s\S]*app-notice-exit/);
assert.match(noticeStyles, /\.app-notice\s*\{[\s\S]*top:\s*auto/);
assert.match(noticeStyles, /\.app-notice\s*\{[\s\S]*right:\s*24px/);
assert.match(noticeStyles, /\.app-notice\s*\{[\s\S]*bottom:\s*24px/);
assert.match(noticeStyles, /\.app-notice\.is-chat-bottom-center\s*\{[\s\S]*right:\s*auto[\s\S]*left:\s*50%[\s\S]*translate:\s*-50% 0/);
assert.match(noticeStyles, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(rendererSource, /function renderContactProfileTransition/);
assert.match(rendererSource, /document\.startViewTransition/);
assert.match(contactProfileTransitionSource, /outgoingContent\.animate\(/);
assert.match(contactProfileTransitionSource, /incomingContent\.animate\(/);
assert.match(contactProfileTransitionSource, /translate3d\(100%, 0, 0\)/);
assert.match(contactProfileTransitionSource, /translate3d\(-100%, 0, 0\)/);
assert.doesNotMatch(contactProfileTransitionSource, /drawer\.animate\(/);
assert.match(contactProfileTransitionSource, /activeContactProfileAnimation\.cancel\(\)/);
assert.doesNotMatch(contactProfileTransitionSource, /startViewTransition/);
assert.doesNotMatch(rendererSource, /contactProfileClickTimer/);
assert.doesNotMatch(rendererSource, /animateContactProfileSwitch/);
assert.doesNotMatch(networkStyles, /view-transition-name: contact-profile-drawer/);
assert.doesNotMatch(networkStyles, /contact-profile-switch-flash/);
assert.doesNotMatch(networkStyles, /inset 0 0 0 999px/);
assert.match(workspaceStyles, /\.chat-view\.with-messages \.conversation-panel\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
assert.match(workspaceStyles, /\.chat-view\.with-messages \.conversation-top-stack\s*\{/);
assert.match(rendererSource, /activeWork\.route === 'task_run'/);
assert.match(rendererSource, /openEmployeeActiveWork\(employee, overview\)/);
assert.match(rendererSource, /beginTaskWorkspaceNavigation\(sourceContext, \{ workspaceKind: 'task_run'/);

console.log('renderer transition stability check passed');
