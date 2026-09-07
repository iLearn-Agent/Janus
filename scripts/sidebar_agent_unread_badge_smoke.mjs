import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { clearAgentRunNotices } from '../src/renderer/app/features/navigation/notificationState.js';
import { primaryNavigationNotice, renderSidebar } from '../src/renderer/app/views/navigationView.js';
import { messageUnreadCount, renderNetworkPanel } from '../src/renderer/app/views/networkView.js';

state.currentUser = { id: 'unread-user', username: 'Unread User', role: 'user' };
state.currentTab = 'chat';
state.networkPanelOpen = true;
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.currentSessionId = '';
state.org = {
  departments: [{ id: 'general', name: '通用部门' }],
  agents: [{ id: 'general_agent', name: '通用 Agent', departmentId: 'general', routable: true }],
  hrs: [],
};
state.employeeOverview = {
  roster: [{ id: 'general-instance', agentFamilyId: 'general_agent', routeEligible: true, employmentState: 'active' }],
};
state.sessions = [{
  id: 'general-session', title: '通用 Agent', departmentId: 'general', agentId: 'general_agent',
  agentInstanceId: 'general-instance', unreadDeliveryCount: 2, unreadCount: 2, updatedAt: new Date().toISOString(),
}];
state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
state.socialInbox = [];
state.socialThreads = [];
state.chatGroupsOverview = { groups: [] };
state.collaborationOverview = { groups: [], tasks: [] };
state.agentDelegations = [];
state.tasks = [];
state.uBuddyTaskViewsById = {};
state.chatRuns = [];

const sidebarWithUnread = renderSidebar();
const messagePanelWithUnread = renderNetworkPanel();
assert.match(sidebarWithUnread, /data-network-view="messages"[^>]*data-unread-count="2"/);
assert.match(sidebarWithUnread, /sidebar-nav-unread is-dot[^>]*><\/b>/);
assert.doesNotMatch(sidebarWithUnread, /sidebar-nav-unread[^>]*>2</);
assert.match(sidebarWithUnread, /2 条未读消息/);
assert.match(messagePanelWithUnread, /message-panel-title[^>]*>[\s\S]*?<b class="is-dot"[^>]*><\/b>/);
assert.doesNotMatch(messagePanelWithUnread, /message-panel-title[^>]*>[\s\S]*?<b[^>]*>2<\/b>/);
assert.match(messagePanelWithUnread, /network-agent-item[^>]*is-unread/);
assert.match(messagePanelWithUnread, /data-unread-count="2"/);

state.sessions[0] = { ...state.sessions[0], unreadDeliveryCount: 0, unreadCount: 0 };
state.sessions.push({
  id: 'hidden-secretary-session', departmentId: 'secretary_department', agentId: 'secretary_agent',
  unreadDeliveryCount: 8, unreadCount: 8,
});
const sidebarRead = renderSidebar();
const messagePanelRead = renderNetworkPanel();
assert.doesNotMatch(sidebarRead, /sidebar-nav-unread/);
assert.match(sidebarRead, /data-network-view="messages"[^>]*data-unread-count="0"/);
assert.doesNotMatch(messagePanelRead, /network-agent-item[^>]*is-unread/);

const directUnread = {
  id: 'direct-unread', senderUserId: 'friend-1', recipientUserId: state.currentUser.id,
  status: 'sent', content: '请查看这条消息。', createdAt: '2026-08-12T09:00:00.000Z',
};
state.socialThreads = [{ friend: { id: 'friend-1', displayName: '联系人' }, messages: [directUnread] }];
state.socialInbox = [directUnread, {
  id: 'hidden-delegation', senderUserId: 'friend-1', recipientUserId: 'another-user',
  status: 'sent', metadata: { type: 'agent_delegation', delegationId: 'delegation-1' },
}];
state.chatGroupsOverview = { groups: [{ id: 'chat-group-unread', unreadCount: 2 }] };
state.collaborationOverview = { groups: [{ id: 'work-group-unread', unreadCount: 3 }], tasks: [] };
const unifiedUnread = primaryNavigationNotice('messages');
assert.equal(unifiedUnread.unreadCount, 6, 'message navigation must include direct, chat-group, and work-group unread counts');
assert.equal(unifiedUnread.badgeCount, 6, 'the inbox copy of a direct message must not be counted twice');
const unifiedUnreadSidebar = renderSidebar();
assert.match(unifiedUnreadSidebar, /data-network-view="messages"[^>]*data-unread-count="6"/);
assert.match(unifiedUnreadSidebar, /sidebar-nav-unread is-dot[^>]*><\/b>/);
assert.doesNotMatch(unifiedUnreadSidebar, /sidebar-nav-unread[^>]*>6</);

state.tasks = [{
  id: 'ubuddy-action', status: 'waiting',
  metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: 'secretary-session', requiresUserAction: true },
}];
state.chatRuns = [{
  channelId: 'approval-run', terminal: false, approvalRequest: { approvalId: 'approval-1' },
  agentId: 'general_agent', agentInstanceId: 'general-instance', unreadNotice: true, unreadNoticeKind: 'request',
}, {
  channelId: 'input-run', terminal: false, userInputRequest: { requestId: 'input-1' },
  agentId: 'general_agent', agentInstanceId: 'general-instance', unreadNotice: true, unreadNoticeKind: 'question',
}];
const pendingNotice = primaryNavigationNotice('messages');
assert.equal(pendingNotice.unreadCount, 6);
assert.equal(pendingNotice.agentNoticeCount, 2);
assert.equal(pendingNotice.badgeCount, 8, 'Agent requests and questions must appear as unread message notifications');
assert.equal(messageUnreadCount(), 8, 'the message panel header must use the same notification total');
assert.equal(pendingNotice.pendingCount, 3, 'uBuddy actions, Agent approvals, and input requests must contribute to pending state');
const pendingSidebar = renderSidebar();
assert.match(pendingSidebar, /data-network-view="messages"[^>]*data-pending-count="3"/);
assert.doesNotMatch(pendingSidebar, /sidebar-nav-pending/);
assert.match(pendingSidebar, /sidebar-nav-unread is-dot[^>]*><\/b>/);
assert.match(pendingSidebar, /6 条未读消息，2 条 Agent 新通知，1 项 uBuddy 待处理，2 项 Agent 确认待处理/);
const pendingPanel = renderNetworkPanel();
assert.match(pendingPanel, /network-agent-item[^>]*is-unread[^>]*has-agent-notice/);
assert.match(pendingPanel, /data-agent-notice-count="2"/);
assert.match(pendingPanel, /message-panel-title[^>]*>[\s\S]*?<b class="is-dot"[^>]*><\/b>/);

state.chatRuns = [{
  channelId: 'completed-run', terminal: true, agentId: 'general_agent', agentInstanceId: 'general-instance',
  displaySessionId: 'general-session', unreadNotice: true, unreadNoticeKind: 'completed',
}];
state.tasks = [];
const completedNotice = primaryNavigationNotice('messages');
assert.equal(completedNotice.badgeCount, 7, 'a completed Agent conversation must remain visible as a new notification');
assert.match(renderNetworkPanel(), /network-agent-item[^>]*is-unread[^>]*has-agent-notice/);

assert.equal(clearAgentRunNotices(state, { sessionId: 'general-session' }), true);
assert.equal(primaryNavigationNotice('messages').badgeCount, 6, 'confirming the Agent conversation must clear its notification');

state.friendOverview = { friends: [], requests: { incoming: [{ id: 'request-1' }, { id: 'request-2' }], outgoing: [] } };
const contactsNotice = primaryNavigationNotice('friends');
assert.equal(contactsNotice.badgeCount, 2);
const contactsSidebar = renderSidebar();
assert.match(contactsSidebar, /data-network-view="friends"[^>]*data-notification-count="2"/);
assert.match(contactsSidebar, /通讯录，2 条联系人申请待处理/);

state.friendOverview.requests.incoming = Array.from({ length: 100 }, (_, index) => ({ id: `request-${index}` }));
assert.match(renderSidebar(), /data-network-view="friends"[^>]*data-notification-count="100"[^>]*[\s\S]*?sidebar-nav-unread[^>]*>99\+</);

console.log('sidebar Agent unread badge smoke passed');
