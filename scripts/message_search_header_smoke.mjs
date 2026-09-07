import assert from 'node:assert/strict';
import fs from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderChatSearchModal, renderSidebar } from '../src/renderer/app/views/navigationView.js';
import { resolveSessionAgentIdentity, sessionMatchesAgentQuery } from '../src/renderer/app/utils/sessionAgentIdentity.js';

state.currentUser = { id: 'message-search-user', displayName: 'Message Search User', role: 'member', permissions: {} };
state.currentTab = 'chat';
state.networkPanelOpen = true;
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.chatSearchOpen = false;
state.sessions = [
  { id: 'general-session', title: '通用会话', agentId: 'general_agent', agentInstanceId: 'general-employee', departmentId: 'general', status: 'active', updatedAt: '2026-08-06T10:00:00.000Z' },
  { id: 'ppt-session', title: 'PPT 会话', agentId: 'ppt', departmentId: 'ppt_department', status: 'active', updatedAt: '2026-08-06T09:00:00.000Z' },
];
state.socialThreads = [{
  friend: { id: 'friend-with-emoji', displayName: '好友甲' },
  messages: [{
    id: 'favorite-emoji-message', senderUserId: 'friend-with-emoji',
    recipientUserId: 'message-search-user', content: '\u200b',
    metadata: { favoriteEmoji: true, attachments: [{ mimeType: 'image/png' }] },
    createdAt: '2026-08-31T09:00:00.000Z',
  }],
}];
state.socialInbox = [];
state.friendOverview = {
  friends: [
    { friend: { id: 'friend-with-emoji', displayName: '好友甲' } },
    { friend: { id: 'friend-without-message', displayName: '好友乙' } },
  ],
  requests: { incoming: [], outgoing: [] },
};
state.chatGroupsOverview = { groups: [] };
state.collaborationOverview = { groups: [], tasks: [] };
state.employeeOverview = { roster: [{ id: 'general-employee', displayName: 'Generalist A', note: '研究助手', agentFamilyId: 'general_agent', employmentState: 'active', family: { name: 'Generalist', departmentId: 'general' } }] };
state.org = {
  departments: [{ id: 'general', name: '通用' }, { id: 'ppt_department', name: 'PPT' }],
  agents: [
    { id: 'general_agent', name: 'Generalist', departmentId: 'general', routable: true },
    { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', routable: true },
  ],
  hrs: [],
};

const messagePanel = renderNetworkPanel();
assert.doesNotMatch(messagePanel, /id="network-conversation-search"|class="[^"]*im-message-search/);
assert.match(messagePanel, /class="message-panel-title"[\s\S]*?<h2[^>]*>消息<\/h2>[\s\S]*?<\/div>\s*<button[^>]*id="sidebar-chat-search-trigger"/);
assert.match(messagePanel, /class="im-message-shortcuts"[\s\S]*?data-network-peer="self-secretary"[\s\S]*?data-private-assistant-entry/);
assert.match(messagePanel, /agent-avatar[^"\n]*is-single-letter-agent-label[^>]*><img class="agent-avatar-image" src="\.\.\/\.\.\/assets\/system_agents\/general_agent\/avatar\.png"/);
assert.doesNotMatch(messagePanel, /agent-avatar[^"\n]*is-single-letter-agent-label[^>]*>PD<\/span>/);
assert.match(messagePanel, /好友甲[\s\S]*?network-message-preview[\s\S]*?表情/);
assert.match(messagePanel, /好友乙[\s\S]*?暂无消息/);


const identityOptions = {
  employees: state.employeeOverview.roster,
  settings: state.userAgentSettings,
  agents: state.org.agents,
  agentName: (agent) => agent.name,
};
assert.equal(resolveSessionAgentIdentity(state.sessions[0], identityOptions)?.displayName, 'Generalist A');
assert.equal(sessionMatchesAgentQuery(state.sessions[0], 'Generalist A', identityOptions), true);
assert.equal(sessionMatchesAgentQuery(state.sessions[0], '研究助手', identityOptions), true);
assert.equal(sessionMatchesAgentQuery(state.sessions[1], 'Generalist A', identityOptions), false);
assert.equal(resolveSessionAgentIdentity(
  { agentId: 'general_agent', agentInstanceId: 'settings-only' },
  { ...identityOptions, settings: [{ id: 'settings-only', displayName: '自定义备注名', agentFamilyId: 'general_agent' }] },
)?.displayName, '自定义备注名');

state.chatSearchOpen = true;
state.chatSearchQuery = 'Generalist A';
state.chatSearchResults = [state.sessions[0]];
const searchModal = renderChatSearchModal({
  filteredSessions: () => state.chatSearchResults,
  normalizeSearch: (value) => String(value || '').trim().toLowerCase(),
  groupSessionsByMonth: (items) => [{ label: '本月', items }],
  sessionSubtitle: (session) => resolveSessionAgentIdentity(session, identityOptions)?.displayName || '普通聊天',
});
assert.match(searchModal, /class="search-session-meta">Generalist A<\/span>/);
assert.doesNotMatch(searchModal, />普通聊天<\/span>/);

const sidebar = renderSidebar();
assert.doesNotMatch(sidebar, /class="brand"[\s\S]*?id="sidebar-chat-search-trigger"/);

state.networkPanelView = 'friends';
assert.doesNotMatch(renderNetworkPanel(), /id="sidebar-chat-search-trigger"/);

const workspaceCss = fs.readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(workspaceCss, /\.message-panel-head\s*\{[\s\S]*?min-height:\s*48px;[\s\S]*?padding:\s*3px 12px;/);
assert.match(workspaceCss, /\.message-panel-head\s*\{[\s\S]*?grid-template-columns:\s*30px minmax\(0, 1fr\) 28px;/);
assert.match(workspaceCss, /\.im-message-shortcuts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, 36px\);[\s\S]*?justify-content:\s*space-between;[\s\S]*?gap:\s*0;[\s\S]*?padding:\s*10px 52px 11px 16px;/);
assert.match(workspaceCss, /\.network-agent-item \.agent-avatar\.is-single-letter-agent-label\s*\{[\s\S]*?font-size:\s*16px;/);

const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererSource, /querySelector\('#sidebar-chat-search-trigger'\)\?\.addEventListener\('click', openChatSearch\)/);
assert.match(rendererSource, /mergeChatSearchResults\(results, localResults\)/);
assert.match(rendererSource, /document\.addEventListener\('keydown', handleContextualSearchShortcut\)/);
assert.match(rendererSource, /event\.ctrlKey \|\| event\.metaKey/);
assert.match(rendererSource, /document\.addEventListener\('wheel', handleConversationZoomWheel, \{ passive: false, capture: true \}\)/);
assert.match(rendererSource, /Trackpad pinch gestures are exposed/);
assert.doesNotMatch(rendererSource, /changeConversationZoom\(event\.deltaY/);
assert.match(rendererSource, /NumpadAdd/);

const zoomCss = fs.readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(zoomCss, /#message-list\.is-large-conversation-zoom/);
assert.match(zoomCss, /--conversation-font-size:\s*14px/);
assert.match(zoomCss, /\.conversation-zoom-indicator\.is-visible/);

process.stdout.write('Message search header smoke passed.\n');
