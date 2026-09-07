import { state, userInitials } from '../state.js';
import { renderUserAvatar } from '../utils/avatar.js';
import { iconSvg } from '../ui/icons.js';
import { clipInline, escapeAttr, escapeHtml, formatMessageTime } from '../utils/format.js';
import { agentAvatarLabel, agentAvatarTone, agentInstanceDisplayNameForUi, employeeRouteEligibleForChat, renderAgentAvatarContent } from '../utils/agentIdentity.js';
import { messagesForSocialTaskGroup, socialTaskGroups } from '../utils/socialTaskGroups.js';
import { TASK_CARD_ACTIONS, normalizeTaskSourceContext } from '../../../shared/contracts/taskCard.js';
import { deriveTaskLifecycleProgress } from '../../../shared/contracts/uBuddyDeliveryReview.js';
import { parseOrganizationInviteLink } from '../../../shared/organizationInvites.js';
import {
  currentModelValue,
  currentReasoningValue,
  renderAttachmentTray,
  renderMessageAttachmentCards,
  renderModelReasoningPicker,
  renderTaskArtifactMessage,
} from './chatView.js';
import { renderTaskProgressCard } from './taskProgressView.js';
import { renderAgentWorkStatus } from '../components/agentWorkStatus.js';
import { workProjectionEnvelope, workProjectionForNode } from '../components/agentWorkProjection.js';
import { agentWorkStatusFor } from '../features/ubuddy/coordinationState.js';
import { uBuddyPendingTaskCount } from '../features/ubuddy/taskDisplayState.js';
import { agentRunNoticeCount, navigationMessageUnreadCount } from '../features/navigation/notificationState.js';
import { translateUiText } from '../i18n.js';
import { compactTaskGroupTitle } from '../../../shared/taskGroupTitle.js';

const text = {
  panelLabel: '消息与通讯录',
  friends: '通讯录',
  messages: '\u6d88\u606f',
  close: '\u6536\u8d77',
  tabLabel: '消息与通讯录切换',
  messageCount: '条联系人消息',
  noFriendMessages: '暂无联系人消息',
  emptyMessages: '暂无联系人或联系人 Agent 消息',
  friendRequest: '\u597d\u53cb\u7533\u8bf7',
  requestFriend: '\u8bf7\u6c42\u6dfb\u52a0\u597d\u53cb',
  requestPreview: '\u60f3\u4e0e\u4f60\u5efa\u7acb Agent \u534f\u4f5c\u5173\u7cfb',
  accept: '\u63a5\u53d7',
  reject: '\u62d2\u7edd',
  fromAgent: '\u7684',
  receivedMessage: '\u53d1\u6765\u6d88\u606f',
  friendAgent: 'uBuddy',
  friendMessage: '\u597d\u53cb\u6d88\u606f',
  searchPlaceholder: '\u90ae\u7bb1\u3001\u7528\u6237\u540d\u3001\u7528\u6237 ID',
  search: '\u641c\u7d22',
  addFriend: '\u6dfb\u52a0\u597d\u53cb',
  delegate: '\u59d4\u6258',
  delegateTask: '\u59d4\u6258\u4efb\u52a1',
  delegatedTask: 'uBuddy \u59d4\u6258',
  startProcessing: '\u5f00\u59cb\u5904\u7406',
  retryProcessing: '\u91cd\u8bd5\u5904\u7406',
  processing: '\u5904\u7406\u4e2d',
  completed: '\u5df2\u5b8c\u6210',
  failed: '\u5904\u7406\u5931\u8d25',
  acceptedStatus: '\u5df2\u63a5\u6536',
  assignedStatus: '\u5f85\u63a5\u6536',
  waitingRecipient: '\u7b49\u5f85\u5bf9\u65b9\u5904\u7406',
  viewResult: '\u67e5\u770b\u7ed3\u679c',
  sentToAgent: '\u5df2\u59d4\u6258\u7ed9',
  secretaryAgent: 'uBuddy',
  incomingRequests: '\u6536\u5230\u7684\u7533\u8bf7',
  outgoingRequests: '\u53d1\u51fa\u7684\u7533\u8bf7',
  friendList: '联系人',
  refresh: '\u5237\u65b0',
  noFriends: '通讯录暂无联系人',
  searchResults: '\u641c\u7d22\u7ed3\u679c',
  add: '\u6dfb\u52a0',
  apply: '\u7533\u8bf7\u597d\u53cb',
  cancel: '\u53d6\u6d88',
  remove: '\u5220\u9664',
  block: '\u62c9\u9ed1',
  user: '\u7528\u6237',
  accepted: '\u5df2\u662f\u597d\u53cb',
  sent: '\u5df2\u53d1\u9001',
  pendingAccept: '\u5f85\u63a5\u53d7',
  none: '\u672a\u6dfb\u52a0',
};

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

let networkViewDeps = {};

export function renderNetworkPanel(deps = {}) {
  networkViewDeps = deps;
  const view = ['friends', 'tasks'].includes(state.networkPanelView) ? state.networkPanelView : 'messages';
  const conversationOpen = view === 'tasks' && Boolean(state.networkDelegationId);
  return `
    <aside id="network-panel" class="network-panel ${conversationOpen ? 'is-conversation-open' : ''}" data-page-kind="${escapeAttr(view)}" aria-label="${text.panelLabel}">
      ${conversationOpen ? '' : renderNetworkPanelHeader(view)}
      ${view === 'friends' ? renderFriendsNetworkView() : view === 'tasks' ? renderTasksNetworkView() : renderMessagesNetworkView()}
    </aside>
  `;
}

function renderNetworkPanelHeader(view = 'messages') {
  if (view !== 'messages') return `<header class="network-panel-head">
    <div><h2 id="network-panel-title">${view === 'friends' ? text.friends : '协作任务'}</h2><span>${networkPanelSubtitle(view)}</span></div>
    ${view === 'friends' ? renderContactsResponsiveTabs() : ''}
  </header>`;
  const unread = messageUnreadCount();
  return `<header class="network-panel-head message-panel-head">
    <button class="message-groups-trigger ${state.messageGroupSidebarOpen ? 'active' : ''}" type="button" data-message-groups-toggle title="${state.messageGroupSidebarOpen ? '收起消息分组' : '展开消息分组'}" aria-label="${state.messageGroupSidebarOpen ? '收起消息分组' : '展开消息分组'}" aria-pressed="${state.messageGroupSidebarOpen ? 'true' : 'false'}">${iconSvg('menu')}<span>${iconSvg(state.messageGroupSidebarOpen ? 'chevronLeft' : 'chevronRight')}</span></button>
    <div class="message-panel-title"><h2 id="network-panel-title">${text.messages}</h2>${unread ? `<b class="is-dot" aria-label="${unread} 条未读消息"></b>` : ''}</div>
    <button class="icon-btn sidebar-search-icon-btn message-panel-search-btn" id="sidebar-chat-search-trigger" type="button" title="搜索聊天（Ctrl/⌘ + F）" aria-label="搜索聊天" aria-keyshortcuts="Control+F Meta+F" aria-haspopup="dialog" aria-expanded="${state.chatSearchOpen ? 'true' : 'false'}">${iconSvg('search')}</button>
    ${renderMessageResponsiveTabs()}
  </header>`;
}

function renderMessageResponsiveTabs() {
  const activePane = state.messageActivePane === 'conversation' ? 'conversation' : 'list';
  return `<nav class="responsive-page-tabs message-responsive-tabs" aria-label="消息页面切换">
    <button type="button" data-message-pane="list" class="${activePane === 'list' ? 'active' : ''}" aria-pressed="${activePane === 'list' ? 'true' : 'false'}">消息</button>
    <button type="button" data-message-pane="conversation" class="${activePane === 'conversation' ? 'active' : ''}" aria-pressed="${activePane === 'conversation' ? 'true' : 'false'}">会话</button>
  </nav>`;
}

function renderContactsResponsiveTabs() {
  const activePane = ['directory', 'contacts', 'employees'].includes(state.contactsActivePane) ? state.contactsActivePane : 'directory';
  return `<nav class="responsive-page-tabs contacts-responsive-tabs" aria-label="通讯录页面切换">
    ${[['directory', '通讯录'], ['contacts', '联系人'], ['employees', '我的员工']].map(([pane, label]) => `<button type="button" data-contacts-pane="${pane}" class="${activePane === pane ? 'active' : ''}" aria-pressed="${activePane === pane ? 'true' : 'false'}">${label}</button>`).join('')}
  </nav>`;
}

export function messageUnreadCount() {
  return navigationMessageUnreadCount(state) + agentRunNoticeCount(state);
}
function networkPanelSubtitle(view) {
  const prefix = state.networkPanelLoading ? '同步中 · ' : state.networkPanelError ? '离线数据 · ' : '';
  if (view === 'friends') {
    return `${prefix}联系人、群组与组织`;
  }
  if (view === 'tasks') {
    const tasks = [...safeArray(state.tasks), ...allDelegationTasks()];
    const active = tasks.filter((item) => !['closed', 'completed', 'rejected', 'failed', 'cancelled'].includes(String(item.status || ''))).length;
    return `${prefix}${active ? `${active} 项进行中的任务` : '暂无进行中的任务'}`;
  }
  const directItems = directMessageItems();
  const chatItems = chatGroupItems();
  const groupItems = collaborationGroupItems();
  const legacyGroups = networkMessageItems().filter((item) => item.groupId);
  const agentConversations = visibleMessageAgentItems();
  const unreadMessageCount = directItems.reduce((total, item) => total + Number(item.unreadCount || 0), 0)
    + chatItems.filter((item) => !item.archived).reduce((total, item) => total + Number(item.unreadCount || 0), 0)
    + groupItems.filter((item) => !item.archived).reduce((total, item) => total + Number(item.unreadCount || 0), 0)
    + legacyGroups.reduce((total, item) => total + Number(item.unreadCount || 0), 0)
    + agentRunNoticeCount(state);
  return `${prefix}${2 + agentConversations.length + directItems.length + chatItems.length + groupItems.length + legacyGroups.length} 个会话 · ${unreadMessageCount ? `${unreadMessageCount} 条未读消息` : '暂无未读'}`;
}

function renderMessagesNetworkView() {
  const agentItems = visibleMessageAgentItems();
  const directItems = directMessageItems();
  const chatItems = chatGroupItems();
  const groupItems = collaborationGroupItems();
  const legacyItems = networkMessageItems().filter((item) => item.groupId);
  const allRecentItems = [
    ...agentItems.map((item, index) => ({ kind: 'agent', item, index, time: messageAgentItemTime(item) })),
    ...directItems.map((item) => ({ kind: 'direct', item, time: messageTimeValue(item.last?.createdAt || item.last?.created_at || item.last?.updatedAt || item.last?.updated_at) })),
    ...chatItems.map((item) => ({ kind: 'chat_group', item, time: messageTimeValue(item.updatedAt) })),
    ...groupItems.map((item) => ({ kind: 'collaboration', item, time: messageTimeValue(item.updatedAt) })),
    ...legacyItems.map((item) => ({ kind: 'legacy', item, time: messageTimeValue(item.time) })),
  ].sort(compareRecentConversationEntries);
  const recentItems = allRecentItems.filter((entry) => recentConversationMatchesFilter(entry, state.networkMessageListFilter || 'all'));
  return `
    <section class="network-content network-messages im-conversation-view" role="region" aria-label="消息会话">
      <div class="im-message-shortcuts" aria-label="快捷入口">
        ${renderUBuddyMessageShortcut()}
        ${renderPrivateAssistantMessageShortcut()}
        ${renderFollowerMessageShortcut()}
      </div>
      <div class="im-conversation-list" data-message-section="conversations" data-preserve-scroll data-scroll-key="network-panel:messages">
        ${recentItems.map(renderRecentConversationItem).join('') || '<div class="im-list-empty" role="status" aria-live="polite">暂无会话</div>'}
      </div>
      ${renderConversationContextMenu()}
    </section>
  `;
}

function recentConversationMatchesFilter(entry = {}, filter = 'all') {
  const archived = recentConversationArchived(entry);
  if (filter === 'archived') return archived;
  if (archived) return false;
  const key = recentConversationKey(entry);
  const completionTime = Number(state.completedConversationTimes?.[key] || 0);
  const hasNewActivity = completionTime > 0 && Number(entry.time || 0) > completionTime;
  const hasUnreadActivity = recentConversationUnreadCount(entry) > 0;
  const manuallyCompleted = Boolean(key && safeArray(state.completedConversationKeys).includes(key)
    && !hasNewActivity && !hasUnreadActivity);
  if (filter === 'completed') return manuallyCompleted || recentConversationEnded(entry);
  if (filter === 'all') return !manuallyCompleted;
  if (filter === 'unread') return recentConversationUnreadCount(entry) > 0;
  if (filter === 'pinned') return recentConversationPinned(entry);
  if (filter === 'mentions') return recentConversationMentionsCurrentUser(entry);
  if (filter === 'direct') return entry.kind === 'direct';
  if (filter === 'group') return entry.kind === 'chat_group' || entry.kind === 'legacy';
  if (filter === 'agent') return entry.kind === 'agent';
  if (filter === 'task') return entry.kind === 'collaboration';
  return true;
}

function recentConversationArchived(entry = {}) {
  if (entry.item?.archived) return true;
  const target = conversationArchiveTarget(recentConversationKey(entry));
  return Boolean(target?.archived);
}

function recentConversationCompleted(entry = {}) {
  const key = recentConversationKey(entry);
  const completionTime = Number(state.completedConversationTimes?.[key] || 0);
  const hasNewActivity = completionTime > 0 && Number(entry.time || 0) > completionTime;
  const hasUnreadActivity = recentConversationUnreadCount(entry) > 0;
  return Boolean(key && safeArray(state.completedConversationKeys).includes(key) && !hasNewActivity && !hasUnreadActivity)
    || recentConversationEnded(entry);
}

function recentConversationKey(entry = {}) {
  if (entry.kind === 'agent') {
    if (entry.item?.session?.id) return `agent:${entry.item.session.id}`;
    const runSessionId = entry.item?.run?.displaySessionId || entry.item?.run?.sessionId || entry.item?.run?.session_id || '';
    if (runSessionId) return `agent:${runSessionId}`;
    if (entry.item?.run && !(entry.item.run.displaySessionId || entry.item.run.sessionId)) {
      const agentId = entry.item?.agent?.id || '';
      const employeeId = entry.item?.employee?.id || entry.item?.run?.agentInstanceId || '';
      return agentId ? `agent-pending:${agentId}${employeeId ? `:${employeeId}` : ''}` : '';
    }
    const agentId = entry.item?.agent?.id || '';
    const employeeId = entry.item?.employee?.id || '';
    return agentId ? `agent-pending:${agentId}${employeeId ? `:${employeeId}` : ''}` : '';
  }
  if (entry.kind === 'direct') return entry.item?.conversationId ? `direct:${entry.item.conversationId}` : (entry.item?.friend?.id ? `direct:${entry.item.friend.id}` : '');
  if (entry.kind === 'chat_group') return entry.item?.id ? `chat-group:${entry.item.id}` : '';
  if (entry.kind === 'collaboration') return entry.item?.id ? `task:${entry.item.id}` : '';
  if (entry.kind === 'legacy') return entry.item?.peerId && entry.item?.groupId ? `group:${entry.item.peerId}:${entry.item.groupId}` : '';
  return '';
}

function recentConversationPinned(entry = {}) {
  const key = recentConversationKey(entry);
  const target = entry.item?.session || entry.item || {};
  return Boolean((key && safeArray(state.markedConversationKeys).includes(key)) || target.pinned || target.isPinned || target.pinnedAt || target.pinned_at);
}

function recentConversationMentionsCurrentUser(entry = {}) {
  const user = state.currentUser || {};
  const source = entry.kind === 'direct'
    ? `${entry.item?.last?.content || ''} ${JSON.stringify(entry.item?.last?.metadata || {})}`
    : entry.kind === 'legacy'
      ? `${entry.item?.preview || ''} ${entry.item?.sender || ''}`
      : entry.kind === 'chat_group'
        ? `${entry.item?.lastMessage || ''}`
      : entry.kind === 'collaboration'
        ? `${entry.item?.lastMessage || ''}`
        : '';
  const needles = ['@我', '@我的uBuddy', user.id, user.username, user.displayName, user.display_name].filter(Boolean);
  return needles.some((needle) => source.includes(String(needle)));
}

function compareRecentConversationEntries(left = {}, right = {}) {
  const endedOrder = Number(recentConversationEnded(left)) - Number(recentConversationEnded(right));
  if (endedOrder) return endedOrder;
  const unreadOrder = recentConversationUnreadCount(right) - recentConversationUnreadCount(left);
  return unreadOrder || right.time - left.time;
}

function recentConversationEnded(entry = {}) {
  if (entry.kind === 'chat_group') return entry.item?.status === 'dissolved';
  if (entry.kind === 'collaboration') return entry.item?.status === 'closed';
  if (entry.kind === 'legacy') return Boolean(entry.item?.ended);
  return false;
}

function recentConversationUnreadCount(entry = {}) {
  const manuallyUnread = safeArray(state.unreadConversationKeys).includes(recentConversationKey(entry));
  let count = 0;
  if (entry.kind === 'direct' || entry.kind === 'legacy') count = Number(entry.item?.unreadCount || 0);
  if (entry.kind === 'chat_group') count = Number(entry.item?.unreadCount || 0);
  if (entry.kind === 'collaboration') count = Number(entry.item?.unreadCount || 0);
  if (entry.kind === 'agent') count = Number(entry.item?.session?.unreadDeliveryCount || entry.item?.session?.unreadCount || 0);
  return Math.max(manuallyUnread ? 1 : 0, count);
}

function renderRecentConversationItem(entry = {}) {
  const content = entry.kind === 'agent'
    ? renderAgentMessageItem(entry.item, entry.index)
    : entry.kind === 'direct'
      ? renderDirectMessageItem(entry.item)
      : entry.kind === 'chat_group'
        ? renderChatGroupItem(entry.item)
        : entry.kind === 'collaboration'
        ? renderCollaborationGroupItem(entry.item)
        : renderNetworkMessageItem(entry.item);
  const key = recentConversationKey(entry);
  const completed = recentConversationCompleted(entry);
  const archived = recentConversationArchived(entry);
  const archiveTarget = conversationArchiveTarget(key);
  const marked = recentConversationPinned(entry);
  const manuallyUnread = safeArray(state.unreadConversationKeys).includes(key);
  if (!key) return content;
  const tooltip = recentConversationTitle(entry);
  const rowAction = archiveTarget
    ? `<button class="im-conversation-complete" type="button" data-conversation-archive="${escapeAttr(key)}" title="${archived ? '移出归档' : '归档会话（保留消息、任务和文件）'}" aria-label="${archived ? '移出归档' : '归档会话'}">${iconSvg('archive')}</button>`
    : `<button class="im-conversation-complete" type="button" data-conversation-complete="${escapeAttr(key)}" title="${completed ? '\u79fb\u51fa\u5df2\u5b8c\u6210' : '\u6807\u8bb0\u4e3a\u5df2\u5b8c\u6210'}" aria-label="${completed ? '\u79fb\u51fa\u5df2\u5b8c\u6210' : '\u6807\u8bb0\u4e3a\u5df2\u5b8c\u6210'}">${iconSvg('check')}</button>`;
  return `<div class="im-conversation-row ${completed ? 'is-completed' : ''} ${archived ? 'is-archived' : ''} ${marked ? 'is-marked' : ''} ${manuallyUnread ? 'is-manually-unread' : ''}" data-conversation-row-key="${escapeAttr(key)}" ${tooltip ? `data-conversation-tooltip="${escapeAttr(tooltip)}"` : ''}>${content}${marked ? `<span class="im-conversation-flag" title="\u5df2\u6807\u8bb0" aria-label="\u5df2\u6807\u8bb0">${iconSvg('flag')}</span>` : ''}${rowAction}</div>`;
}

function recentConversationTitle(entry = {}) {
  if (entry.kind === 'chat_group') return entry.item?.title || '群聊';
  if (entry.kind === 'collaboration') return compactTaskGroupTitle(entry.item);
  if (entry.kind === 'legacy') return entry.item?.title || '\u7fa4\u804a';
  return '';
}

function renderConversationContextMenu() {
  const menu = state.conversationContextMenu;
  const key = String(menu?.key || '').trim();
  if (!key) return '';
  const marked = safeArray(state.markedConversationKeys).includes(key);
  const unread = safeArray(state.unreadConversationKeys).includes(key);
  const completed = safeArray(state.completedConversationKeys).includes(key);
  const archiveTarget = conversationArchiveTarget(key);
  const left = Math.max(8, Number(menu.x) || 8);
  const top = Math.max(8, Number(menu.y) || 8);
  return `<div class="im-conversation-context-layer" data-conversation-context-dismiss>
    <div class="im-conversation-context-menu" role="menu" aria-label="会话分组操作" style="left:${left}px;top:${top}px" data-conversation-context-key="${escapeAttr(key)}">
      <button type="button" role="menuitem" data-conversation-group-action="unread">${iconSvg('clock')}<span>${unread ? '取消标为未读' : '标为未读'}</span></button>
      <button type="button" role="menuitem" data-conversation-group-action="mark">${iconSvg('flag')}<span>${marked ? '取消标记' : '标记'}</span></button>
      <button type="button" role="menuitem" data-conversation-group-action="complete">${iconSvg('check')}<span>${completed ? '移出已完成' : '完成'}</span></button>
      ${archiveTarget ? `<button type="button" role="menuitem" data-conversation-group-action="archive">${iconSvg('archive')}<span>${archiveTarget.archived ? '恢复到消息' : '归档会话'}</span></button>` : ''}
    </div>
  </div>`;
}

function conversationArchiveTarget(key = '') {
  const value = String(key || '').trim();
  if (value.startsWith('chat-group:')) {
    const id = value.slice('chat-group:'.length);
    const group = safeArray(state.chatGroupsOverview?.groups).find((item) => item.id === id);
    return group ? { conversationKind: 'chat_group', conversationId: id, archived: Boolean(group.archived), revision: Number(group.archiveRevision || 0) } : null;
  }
  if (value.startsWith('task:')) {
    const id = value.slice('task:'.length);
    const group = safeArray(state.collaborationOverview?.groups).find((item) => item.id === id);
    return group ? { conversationKind: 'collaboration_group', conversationId: id, archived: Boolean(group.archived), revision: Number(group.archiveRevision || 0) } : null;
  }
  if (value.startsWith('direct:')) {
    const id = value.slice('direct:'.length);
    const pref = safeArray(state.conversationPreferences?.preferences).find((item) => item.conversationKind === 'social_direct' && item.conversationId === id);
    return { conversationKind: 'social_direct', conversationId: id, archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
  }
  if (value.startsWith('agent:')) {
    const id = value.slice('agent:'.length);
    const pref = safeArray(state.conversationPreferences?.preferences).find((item) => item.conversationKind === 'agent_session' && item.conversationId === id);
    return { conversationKind: 'agent_session', conversationId: id, archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
  }
  if (value.startsWith('agent-pending:')) {
    const parts = value.slice('agent-pending:'.length).split(':');
    const agentId = parts.shift() || '';
    const employeeId = parts.join(':');
    const session = safeArray(state.sessions)
      .filter((item) => item?.status !== 'deleted' && String(item.agentId || item.agent_id || '') === agentId
        && (!employeeId || String(item.agentInstanceId || item.agent_instance_id || '') === employeeId))
      .sort((a, b) => new Date(b.updatedAt || b.updated_at || 0) - new Date(a.updatedAt || a.updated_at || 0))[0];
    const fallback = session?.id ? session : safeArray(state.sessions).find((item) => item?.id === state.currentSessionId
      && String(item.agentId || item.agent_id || '') === agentId && item?.status !== 'deleted');
    if (fallback?.id) {
      const pref = safeArray(state.conversationPreferences?.preferences).find((item) => item.conversationKind === 'agent_session' && item.conversationId === fallback.id);
      return { conversationKind: 'agent_session', conversationId: fallback.id, archived: Boolean(pref?.archived), revision: Number(pref?.stateRevision || 0) };
    }
  }
  return null;
}

function renderUBuddyMessageShortcut() {
  const opening = Boolean(state.uBuddyConversationOpening);
  const pendingCount = uBuddyPendingTaskCount({ tasks: state.tasks, taskViewsById: state.uBuddyTaskViewsById });
  const pendingLabel = state.languageMode === 'en'
    ? `uBuddy, ${pendingCount} item${pendingCount === 1 ? ' needs' : 's need'} your attention`
    : `uBuddy，有 ${pendingCount} 条待处理`;
  return `<button class="im-message-shortcut is-ubuddy ${isUBuddySessionActive() ? 'active' : ''} ${opening ? 'is-opening' : ''} ${pendingCount ? 'has-pending' : ''}" type="button" data-network-peer="self-secretary" aria-busy="${opening ? 'true' : 'false'}" aria-label="${escapeAttr(pendingCount ? pendingLabel : 'uBuddy')}" ${opening ? 'disabled' : ''}>
    <span class="im-message-shortcut-avatar">${iconSvg('spark')}<small class="im-message-shortcut-pending-badge" data-ubuddy-pending-badge data-no-localize ${pendingCount ? '' : 'hidden'}>${pendingCount > 99 ? '99+' : pendingCount}</small></span>
    <span class="im-message-shortcut-copy"><strong>uBuddy</strong></span>
  </button>`;
}

function renderPrivateAssistantMessageShortcut() {
  const session = safeArray(state.sessions).find((item) => item.departmentId === 'private_assistant' && item.status !== 'deleted') || null;
  const active = !state.networkMessageHomeOpen && (state.homeMode === 'private_assistant' || Boolean(session?.id && state.currentSessionId === session.id));
  const usage = state.privateAssistant || {};
  const running = safeArray(state.chatRuns).some((run) => (
    (run.targetKind === 'private_assistant' || run.departmentId === 'private_assistant') && !run.terminal
  ));
  const resultUnread = Boolean(state.privateAssistantResultUnread);
  const status = running ? '运行中' : resultUnread ? '待查看' : '本地';
  const privateLabel = state.languageMode === 'en' ? 'Private' : '私人助理';
  const statusLabel = translateUiText(status, state.languageMode);
  const privacyTitle = translateUiText('本地隔离空间：不与其他 Agent 通信，不同步到 Janus 云端，也不占员工额度；当前请求仍会发送给你选择的模型服务。', state.languageMode);
  const ariaSeparator = state.languageMode === 'en' ? ', ' : '，';
  return `<button class="im-message-shortcut is-private ${active ? 'active' : ''} ${running ? 'is-running' : ''} ${resultUnread ? 'has-result' : ''} ${usage.exhausted ? 'is-exhausted' : ''}" type="button" data-network-peer="self-private-assistant" data-private-assistant-entry aria-busy="${running ? 'true' : 'false'}" aria-label="${escapeAttr(`${privateLabel}${ariaSeparator}${statusLabel}`)}" title="${escapeAttr(privacyTitle)}">
    <span class="im-message-shortcut-avatar">${iconSvg('shield')}${status === '本地' ? '' : `<small class="im-message-shortcut-badge" data-no-localize>${escapeHtml(statusLabel)}</small>`}</span>
    <span class="im-message-shortcut-copy"><strong data-no-localize>${escapeHtml(privateLabel)}</strong></span>
  </button>`;
}

function renderFollowerMessageShortcut() {
  const overview = state.followerOverview || {};
  const running = Boolean(overview.status?.activeRun);
  const unread = Math.max(0, Number(overview.unreadCount || 0));
  const attention = overview.status?.state === 'attention';
  const english = state.languageMode === 'en';
  const aria = attention
    ? (english ? 'Follower needs attention' : 'Follower，需要处理')
    : running
      ? (english ? 'Follower, generating a report' : 'Follower，正在生成报告')
      : unread
        ? (english ? `Follower, ${unread} unread reports` : `Follower，有 ${unread} 份未读报告`)
        : (english ? 'Follower, idle' : 'Follower，空闲');
  return `<button class="im-message-shortcut is-follower ${state.followerWorkspaceOpen ? 'active' : ''} ${running ? 'is-running' : ''} ${unread ? 'has-result' : ''} ${attention ? 'has-attention' : ''}" type="button" data-message-system-entry="follower" aria-label="${escapeAttr(aria)}">
    <span class="im-message-shortcut-avatar">${iconSvg('telescope')}<small class="im-message-shortcut-beta" data-no-localize>Beta</small>${unread ? `<small class="im-message-shortcut-badge">${unread > 9 ? '9+' : unread}</small>` : ''}</span>
    <span class="im-message-shortcut-copy"><strong>Follower</strong></span>
  </button>`;
}

function messageTimeValue(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeConversationSearch(value = '') {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function conversationSearchAttributes(value = '', sessionId = '') {
  const searchable = normalizeConversationSearch(value);
  return `data-conversation-search-text="${escapeAttr(searchable)}"${sessionId ? ` data-conversation-search-session="${escapeAttr(sessionId)}"` : ''}`;
}

function messageAgentItems() {
  const employeeRoster = [...new Map(safeArray(state.employeeOverview?.roster)
    .filter((employee) => employee?.id)
    .map((employee) => [String(employee.id), employee])).values()];
  const employeeById = new Map(employeeRoster.map((employee) => [employee.id, employee]));
  const agentById = new Map(safeArray(state.org?.agents).map((agent) => [agent.id, agent]));
  const employeesByFamily = new Map();
  for (const employee of employeeRoster) {
    const familyId = employee.agentFamilyId || employee.agent_family_id || '';
    if (!familyId) continue;
    const familyEmployees = employeesByFamily.get(familyId) || [];
    familyEmployees.push(employee);
    employeesByFamily.set(familyId, familyEmployees);
  }
  const sessions = safeArray(state.sessions)
    .filter(messageSessionIsVisible)
    .filter((session) => {
      const employeeId = session.agentInstanceId || session.agent_instance_id || '';
      const employee = employeeId ? employeeById.get(employeeId) : null;
      return !employee || employeeRouteEligibleForChat(employee);
    })
    .sort((left, right) => messageSessionTime(right) - messageSessionTime(left));
  const latestByRoute = new Map();
  for (const session of sessions) {
    const agentId = session.agentId || session.agent_id || '';
    if (!agentId) continue;
    const employeeId = session.agentInstanceId || session.agent_instance_id || '';
    const routeKey = employeeId ? `instance:${employeeId}` : `agent:${agentId}`;
    const current = latestByRoute.get(routeKey);
    const priority = messageSessionRoutePriority(session);
    const currentPriority = messageSessionRoutePriority(current);
    if (!current || priority > currentPriority
      || (priority === currentPriority && messageSessionTime(session) > messageSessionTime(current))) {
      latestByRoute.set(routeKey, session);
    }
  }
  const items = [];
  const representedInstanceIds = new Set();
  for (const agent of agentById.values()) {
    const agentId = agent.id || '';
    const departmentId = agent.departmentId || agent.department_id || '';
    if (!agentId || agent.routable === false || departmentId === 'secretary_department' || agentId === 'secretary_agent') continue;
    const familyEmployees = (employeesByFamily.get(agentId) || []).filter(employeeRouteEligibleForChat);
    for (const employee of familyEmployees) {
      representedInstanceIds.add(employee.id);
      items.push({
        agent,
        employee,
        session: latestByRoute.get(`instance:${employee.id}`) || null,
        run: messageAgentRun(agentId, employee.id),
        label: messageEmployeeLabel(employee, agent),
        note: String(employee.note || '').trim(),
        departmentLabel: messageDepartmentLabel(employee.family?.departmentId || departmentId),
      });
    }
    const genericSession = latestByRoute.get(`agent:${agentId}`) || null;
    const genericRun = messageAgentRun(agentId, '');
    const selectedGeneric = state.selectionSource !== 'employee' && state.currentAgentId === agentId;
    if ((!familyEmployees.length || genericSession || genericRun || selectedGeneric) && agentId !== 'general_agent') {
      items.push({
        agent,
        employee: null,
        session: genericSession,
        run: genericRun,
        label: messageAgentLabel(agent),
        note: '',
        departmentLabel: messageDepartmentLabel(departmentId),
      });
    }
  }
  for (const [routeKey, session] of latestByRoute) {
    if (!routeKey.startsWith('instance:')) continue;
    const employeeId = routeKey.slice('instance:'.length);
    if (!employeeId || representedInstanceIds.has(employeeId) || employeeById.has(employeeId)) continue;
    const agentId = session.agentId || session.agent_id || '';
    const agent = agentById.get(agentId);
    if (!agent || agent.routable === false || agentId === 'secretary_agent') continue;
    items.push({
      agent,
      employee: null,
      agentInstanceId: employeeId,
      session,
      run: messageAgentRun(agentId, employeeId),
      label: session.title || messageAgentLabel(agent),
      note: '',
      departmentLabel: messageDepartmentLabel(session.departmentId || session.department_id || agent.departmentId || ''),
    });
  }
  const uniqueItems = new Map();
  for (const item of items) {
    const employeeId = item.employee?.id || item.agentInstanceId || item.session?.agentInstanceId || item.session?.agent_instance_id || item.run?.agentInstanceId || '';
    const routeKey = employeeId ? `instance:${employeeId}` : `agent:${item.agent?.id || ''}`;
    const current = uniqueItems.get(routeKey);
    if (!current || messageAgentItemTime(item) > messageAgentItemTime(current)) uniqueItems.set(routeKey, item);
  }
  const result = [...uniqueItems.values()];
  const archivedSessionIds = new Set(safeArray(state.conversationPreferences?.preferences)
    .filter((item) => item.conversationKind === 'agent_session' && item.archived)
    .map((item) => String(item.conversationId || '').trim()).filter(Boolean));
  for (const sessionId of archivedSessionIds) {
    if (result.some((item) => item.session?.id === sessionId || item.run?.displaySessionId === sessionId || item.run?.sessionId === sessionId || item.run?.session_id === sessionId)) continue;
    const session = safeArray(state.sessions).find((item) => item?.id === sessionId && item.status !== 'deleted');
    if (!session) continue;
    const agentId = session.agentId || session.agent_id || '';
    const agent = agentById.get(agentId);
    if (!agent || agent.routable === false || agentId === 'secretary_agent') continue;
    const employeeId = session.agentInstanceId || session.agent_instance_id || '';
    const employee = employeeId ? employeeById.get(employeeId) || null : null;
    result.push({ agent, employee, session, run: null, agentInstanceId: employeeId, label: employee ? messageEmployeeLabel(employee, agent) : (session.title || messageAgentLabel(agent)), note: '', departmentLabel: messageDepartmentLabel(session.departmentId || session.department_id || agent.departmentId || '') });
  }
  return result.sort((left, right) => {
    const recent = messageAgentItemTime(right) - messageAgentItemTime(left);
    return recent || left.label.localeCompare(right.label, 'zh-CN');
  });
}

function visibleMessageAgentItems() {
  return messageAgentItems().filter((item) => item.employee
    ? employeeRouteEligibleForChat(item.employee)
    : Boolean(item.session) || Boolean(item.run) || (
      !state.currentSessionId
      && state.homeMode === 'department'
      && state.currentAgentId === item.agent?.id
      && !state.currentAgentInstanceId
    ));
}

function messageAgentRun(agentId = '', agentInstanceId = '') {
  return safeArray(state.chatRuns)
    .filter((run) => {
      if ((run.terminal && !run.unreadNotice) || run.nonBlocking || run.agentId !== agentId) return false;
      const runInstanceId = run.agentInstanceId || run.agent_instance_id || '';
      return agentInstanceId ? runInstanceId === agentInstanceId : !runInstanceId;
    })
    .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0] || null;
}

function messageAgentItemTime(item = {}) {
  return Math.max(messageSessionTime(item.session), Number(item.run?.startedAt || 0));
}

function messageSessionRoutePriority(session = {}) {
  if (session.readOnly || (session.writeState || session.write_state) === 'read_only') return 0;
  return (session.conversationRole || session.conversation_role) === 'primary' ? 2 : 1;
}

function messageSessionIsVisible(session = {}) {
  const status = String(session.status || '');
  const departmentId = session.departmentId || session.department_id || '';
  return Boolean(session.id)
    && status !== 'archived'
    && status !== 'deleted'
    && session.archived !== true
    && departmentId !== 'agent_delegation';
}

function messageSessionTime(session = {}) {
  const value = session?.updatedAt || session?.updated_at || session?.createdAt || session?.created_at || 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function renderAgentMessageItem(item = {}, index = 0) {
  const agent = item.agent || {};
  const employee = item.employee || null;
  const employeeId = employee?.id || item.agentInstanceId || item.session?.agentInstanceId || item.session?.agent_instance_id || item.run?.agentInstanceId || '';
  const session = item.session;
  const run = item.run;
  const pendingRun = run && !(run.displaySessionId || run.sessionId);
  const departmentId = agent.departmentId || agent.department_id || '';
  const active = !state.networkMessageHomeOpen && (pendingRun
    ? !state.currentSessionId && state.currentChatKey === run.chatKey && !state.networkConversationPeerId
    : session?.id
      ? state.currentSessionId === session.id
      : !state.currentSessionId && state.currentAgentId === agent.id
        && (!employeeId || state.currentAgentInstanceId === employeeId) && !state.networkConversationPeerId);
  const target = pendingRun || !session?.id
    ? `data-agent-inbox="${escapeAttr(agent.id || '')}" data-agent-inbox-department="${escapeAttr(departmentId)}"${employeeId ? ` data-agent-inbox-instance="${escapeAttr(employeeId)}"` : ''}${run?.channelId ? ` data-agent-inbox-run="${escapeAttr(run.channelId)}"` : ''}`
    : `data-network-session="${escapeAttr(session.id)}"`;
  const agentNoticeCount = agentRunNoticeCount(state, {
    sessionId: pendingRun ? '' : session?.id || '',
    agentId: agent.id || '',
    agentInstanceId: employeeId,
  });
  const unreadCount = Number(session?.unreadDeliveryCount || session?.unreadCount || 0) + agentNoticeCount;
  const employeeState = agentMessageEmployeeState(item, session, run);
  const pinned = recentConversationPinned({ item });
  const displayTime = run?.startedAt || session?.updatedAt || session?.updated_at || session?.createdAt || '';
  const persistedLastMessage = session?.lastMessage || session?.last_message || '';
  const persistedLastMessageRole = session?.lastMessageRole || session?.last_message_role || '';
  const persistedPreview = persistedLastMessage
    ? `${persistedLastMessageRole === 'user' ? '你：' : ''}${persistedLastMessage}`
    : '';
  const previewTitle = clipInline(run?.assistantContent || run?.userMessage || persistedPreview
    || run?.sessionTitle || session?.title || item.departmentLabel || '点击进入会话', 240);
  const note = String(item.note || '').trim();
  const displayLabel = localizedAgentMessageLabel(item);
  const displayDepartment = translateUiText(item.departmentLabel || '专业 Agent', state.languageMode);
  const displayState = translateUiText(employeeState.systemLabel || employeeState.label, state.languageMode);
  const rawEmployeeLabel = String(employee?.displayName || employee?.display_name || '').trim();
  const previewIsSystemLabel = previewTitle === item.label || previewTitle === rawEmployeeLabel || previewTitle === item.departmentLabel || previewTitle === '点击进入会话';
  const displayPreviewTitle = previewTitle === item.label || (rawEmployeeLabel && previewTitle === rawEmployeeLabel)
    ? displayLabel
    : previewIsSystemLabel ? translateUiText(previewTitle, state.languageMode) : previewTitle;
  const previewDetail = String(employeeState.detail || '').trim();
  const previewTail = [previewDetail, displayPreviewTitle].filter(Boolean);
  const avatarLabel = agentAvatarLabel(agent.id, displayLabel);
  const singleLetterAvatarLabel = [...avatarLabel].length === 1 ? ' is-single-letter-agent-label' : '';
  return `<button class="network-message-item network-agent-item im-conversation-item ${unreadCount ? 'is-unread' : ''} ${agentNoticeCount ? 'has-agent-notice' : ''} ${pinned ? 'is-pinned' : ''} ${active ? 'active' : ''}" type="button" ${target} data-agent-message-row="${escapeAttr(agent.id || '')}"${employeeId ? ` data-agent-instance-row="${escapeAttr(employeeId)}"` : ''} data-agent-preview-title="${escapeAttr(previewTitle)}" data-agent-preview-label="${escapeAttr(displayPreviewTitle)}" data-unread-count="${escapeAttr(formatConversationUnreadCount(unreadCount))}" data-agent-notice-count="${escapeAttr(agentNoticeCount)}" title="${escapeAttr(`${displayLabel} · ${displayDepartment} · ${displayState}${previewDetail ? ` · ${previewDetail}` : ''}${note ? ` · ${note}` : ''}`)}" ${conversationSearchAttributes(`${item.label} ${note} ${item.departmentLabel || ''} ${employeeState.label} ${agent.id || ''} ${employeeId} ${previewTitle}`, pendingRun ? '' : session?.id || '')}>
    <span class="network-message-avatar agent-avatar tone-${agentAvatarTone(agent.id, item.label)}${singleLetterAvatarLabel}">${renderAgentAvatarContent(agent.id, displayLabel)}</span>
    <span class="network-message-main"><span class="network-message-line"><span class="im-conversation-title-line"><strong data-no-localize>${escapeHtml(displayLabel)}</strong>${agent.id === 'ppt' ? '' : '<b class="im-conversation-badge is-agent">Agent</b>'}</span><time>${displayTime ? escapeHtml(formatMessageTime(displayTime)) : ''}</time></span>
    <span class="network-message-preview"><span data-agent-preview-state data-no-localize>${escapeHtml(displayState)}</span>${previewTail.length ? ` · <span data-agent-preview-tail data-no-localize>${escapeHtml(clipInline(previewTail.join(' · '), 76))}</span>` : ''}</span></span>
  </button>`;
}

function localizedAgentMessageLabel(item = {}) {
  const raw = String(item.label || 'Agent');
  const employee = item.employee || null;
  const customName = String(employee?.displayName || employee?.display_name || '').trim();
  const familyName = String(employee?.family?.name || '').trim();
  if (customName && (!familyName || customName !== familyName)) return raw;
  return translateUiText(raw, state.languageMode);
}

function agentMessageEmployeeState(item = {}, session = {}, run = null) {
  if (run) return { label: '生成中', systemLabel: '生成中', detail: '', tone: 'busy' };
  const employeeId = item.employee?.id || session?.agentInstanceId || session?.agent_instance_id || '';
  const employee = item.employee || safeArray(state.employeeOverview?.roster).find((candidate) => candidate.id === employeeId) || null;
  if (!employee) return { label: 'Agent 会话', systemLabel: 'Agent 会话', detail: '', tone: 'online' };
  const status = agentWorkStatusFor(state, employee);
  if (status.availability === 'working') {
    const stateLabel = ({ reserved: '已预留', queued: '排队中', running: '执行中', blocked: '受阻' })[status.workState] || '工作中';
    return {
      label: status.currentWork ? `${stateLabel} · ${status.currentWork}` : stateLabel,
      systemLabel: stateLabel,
      detail: status.currentWork || '',
      tone: status.workState === 'blocked' ? 'warning' : 'busy',
    };
  }
  return { label: '空闲', systemLabel: '空闲', detail: '', tone: 'online' };
}

function messageAgentLabel(agent = {}) {
  return networkViewDeps.agentNameById?.(agent.id) || agent.displayName || agent.display_name || agent.name || agent.id || 'Agent';
}

function messageEmployeeLabel(employee = {}, agent = {}) {
  return agentInstanceDisplayNameForUi(employee, employee.family?.name || messageAgentLabel(agent));
}

function messageDepartmentLabel(departmentId = '') {
  if (!departmentId) return '专业 Agent';
  return networkViewDeps.departmentName?.(departmentId)
    || safeArray(state.org?.departments).find((department) => department.id === departmentId)?.name
    || '专业 Agent';
}

function renderTasksNetworkView() {
  if (state.networkDelegationId) return renderNetworkDelegationDetail();
  const currentUserId = state.currentUser?.id || '';
  const allTasks = allDelegationTasks();
  const incoming = allTasks.filter((item) => (item.recipientUserId || item.recipient_user_id) === currentUserId);
  const outgoing = allTasks.filter((item) => (item.requesterUserId || item.requester_user_id) === currentUserId);
  return `<section class="network-content network-tasks" data-preserve-scroll data-scroll-key="network-panel:tasks">
    ${renderLocalTaskListSection('我的协作任务', safeArray(state.tasks))}
    ${renderTaskListSection('交给我的', incoming)}
    ${renderTaskListSection('我发起的', outgoing)}
  </section>`;
}

function renderLocalTaskListSection(label, tasks = []) {
  const ordered = [...tasks].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return `<section class="network-task-list-section"><div class="network-section-title"><strong>${escapeHtml(label)}</strong><span>${ordered.length}</span></div>
    <div class="network-task-list">${ordered.length ? ordered.map(renderLocalTaskListItem).join('') : '<div class="network-group-list-empty">暂无协作任务</div>'}</div></section>`;
}

function renderLocalTaskListItem(task = {}) {
  const status = String(task.status || 'pending');
  const statusLabel = status === 'failed' && task.metadata?.resultState === 'needs_revision'
    ? '需要修正'
    : localTaskStatusLabel(status);
  const completed = Number(task.completedNodeCount || task.completedCount || 0);
  const total = Number(task.nodeCount || 0);
  const workProjection = workProjectionEnvelope(state.uBuddyFeatureFlags?.agentWorkDetailProjection === true ? task.agentWorkStatusProjection : null);
  const currentActor = workProjection?.actors.find((actor) => ['running', 'blocked', 'waiting', 'queued', 'reserved'].includes(actor.status) && !['ubuddy', 'remote_ubuddy'].includes(actor.actorKind))
    || workProjection?.actors.find((actor) => ['ubuddy', 'remote_ubuddy'].includes(actor.actorKind)) || null;
  return `<button class="network-task-item local-collaboration-task status-${escapeAttr(status)} ${state.taskDetail?.id === task.id ? 'active' : ''}" type="button" data-local-collaboration-task="${escapeAttr(task.id || '')}">
    <span class="network-secretary-avatar">U</span><span class="network-message-main"><span class="network-message-line"><strong>${escapeHtml(task.title || '协作任务')}</strong><time>${escapeHtml(formatMessageTime(task.updatedAt || task.createdAt))}</time></span>
    <span class="network-message-meta">${escapeHtml(statusLabel)} · ${completed}/${total || '?'} 节点</span>
    <span class="network-message-preview">${escapeHtml(clipInline(currentActor?.currentAction || task.summary || task.prompt || '查看任务图谱与 Agent 协作进度', 76))}</span>${currentActor?.blocker ? `<span class="network-task-work-alert">阻塞：${escapeHtml(clipInline(currentActor.blocker.summary, 60))} · 下一步：${escapeHtml(clipInline(currentActor.nextStep || '检查任务详情', 60))}</span>` : ''}</span>
  </button>`;
}

function localTaskStatusLabel(status = '') {
  return ({ pending: '等待中', ready: '待执行', queued: '排队中', running: '处理中', retry_wait: '等待自动重试', verifying: '校验交付物', waiting: '等待协作', blocked: '依赖失败阻塞', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || status || '未知';
}

function renderTaskListSection(label, tasks = []) {
  const ordered = [...tasks].sort((a, b) => String(b.updatedAt || b.updated_at || '').localeCompare(String(a.updatedAt || a.updated_at || '')));
  return `<section class="network-task-list-section"><div class="network-section-title"><strong>${escapeHtml(label)}</strong><span>${ordered.length}</span></div>
    <div class="network-task-list">${ordered.length ? ordered.map(renderTaskListItem).join('') : '<div class="network-group-list-empty">暂无任务</div>'}</div></section>`;
}

function renderTaskListItem(task = {}) {
  const currentUserId = state.currentUser?.id || '';
  const incoming = (task.recipientUserId || task.recipient_user_id) === currentUserId;
  const peer = incoming ? task.requester : task.recipient;
  const status = String(task.status || 'assigned');
  const progress = state.networkDelegationProgressById?.[task.id] || task.metadata?.executionProgress || null;
  const localTask = state.networkDelegationTaskById?.[task.id] || null;
  const workProjection = workProjectionEnvelope(state.uBuddyFeatureFlags?.agentWorkDetailProjection === true ? task.metadata?.agentWorkStatusProjection : null);
  const currentActor = workProjection?.actors.find((actor) => ['running', 'blocked', 'waiting', 'queued', 'reserved'].includes(actor.status) && !['ubuddy', 'remote_ubuddy'].includes(actor.actorKind))
    || workProjection?.actors.find((actor) => ['ubuddy', 'remote_ubuddy'].includes(actor.actorKind)) || null;
  const total = Number(progress?.total || 0);
  const completed = Number(progress?.completed || 0);
  const lifecycleProgress = delegationLifecycleProgress(progress, localTask || task);
  const percent = lifecycleProgress.percent;
  const alert = Number(progress?.failed || 0) > 0 || ['blocked', 'failed'].includes(status);
  return `<button class="network-task-item status-${escapeAttr(status)}" type="button" data-network-delegation="${escapeAttr(task.id || '')}">
    <span class="network-secretary-avatar">U</span><span class="network-message-main"><span class="network-message-line"><strong>${escapeHtml(task.title || 'uBuddy 任务')}</strong><time>${escapeHtml(formatMessageTime(task.updatedAt || task.updated_at))}</time></span>
    <span class="network-message-meta">${escapeHtml(displayUserName(peer || {}))} · ${escapeHtml(delegationStatusLabel(task, incoming))}${total ? ` · ${completed}/${total} 执行节点` : ''} · ${escapeHtml(lifecycleProgress.label)} ${percent}%${alert ? ' · 需关注' : ''}${task.metadata?.syncState === 'pending' ? ' · 等待同步' : ''}</span>
    ${total ? `<span class="network-task-progress"><i style="width:${percent}%"></i></span>` : ''}
    <span class="network-message-preview">${escapeHtml(clipInline(currentActor?.currentAction || progress?.message || progress?.currentStep?.title || task.metadata?.intakeSummary || task.instruction || '', 76))}</span>${currentActor?.blocker ? `<span class="network-task-work-alert">阻塞：${escapeHtml(clipInline(currentActor.blocker.summary, 60))} · 下一步：${escapeHtml(clipInline(currentActor.nextStep || '等待接收方处理', 60))}</span>` : ''}</span>
  </button>`;
}

function directMessageItems() {
  const currentUserId = state.currentUser?.id || '';
  const threadByPeer = new Map();
  for (const thread of safeArray(state.socialThreads)) {
    const peerId = String(thread?.friend?.id || '').trim();
    if (peerId) threadByPeer.set(peerId, thread);
  }
  const relationships = [...safeArray(state.friendOverview?.friends)];
  if (currentUserId && !relationships.some((item) => String(item?.friend?.id || item?.user?.id || '') === String(currentUserId))) {
    relationships.push({ friend: state.currentUser, self: true });
  }
  const peerIds = new Set(relationships.map((item) => String(item?.friend?.id || item?.user?.id || '').trim()).filter(Boolean));
  for (const thread of safeArray(state.socialThreads)) {
    const peerId = String(thread?.friend?.id || '').trim();
    if (peerId) peerIds.add(peerId);
  }
  return [...peerIds].map((peerId) => {
    const relationship = relationships.find((item) => String(item?.friend?.id || item?.user?.id || '') === peerId);
    const thread = threadByPeer.get(peerId) || { friend: relationship?.friend || relationship?.user || {} };
    const selfConversation = peerId === String(currentUserId);
    const friend = selfConversation ? {
      ...(thread.friend || {}),
      ...(state.currentUser || {}),
      id: currentUserId,
      remark: '',
    } : {
      ...(thread.friend || relationship?.friend || relationship?.user || {}),
      remark: relationship?.remark || relationship?.friend?.remark || thread.friend?.remark || '',
    };
    const messages = safeArray(thread.messages).filter((message) => {
      const metadata = message?.metadata || {};
      return !metadata.taskGroupId && !metadata.groupId;
    });
    const last = messages.at(-1) || null;
    const unreadCount = messages.filter((message) => (
      (message.recipientUserId || message.recipient_user_id) === currentUserId
      && message.status !== 'read'
    )).length;
    const searchText = messages.slice(-100).map((message) => recentMessagePreview(message)).filter(Boolean).join(' ');
    return {
      friend,
      last,
      conversationId: last?.conversationId || last?.conversation_id || thread.conversationId || thread.conversation_id || '',
      unread: unreadCount > 0,
      unreadCount,
      searchText,
    };
  }).sort((a, b) => new Date(b.last?.updatedAt || b.last?.createdAt || 0) - new Date(a.last?.updatedAt || a.last?.createdAt || 0));
}


function currentAwareUser(user = {}) {
  const id = String(user?.id || user?.userId || user?.user_id || '').trim();
  const currentId = String(state.currentUser?.id || '').trim();
  if (id && currentId && id === currentId) return { ...user, ...state.currentUser };
  return user || {};
}

function renderNetworkUserAvatar(user = {}, { className = 'network-user-avatar', title = '', viewerUserId = '' } = {}) {
  const avatarUser = currentAwareUser(user);
  return renderUserAvatar(avatarUser, {
    className,
    title: title || displayUserName(avatarUser),
    fallbackLabel: userInitials(avatarUser),
    viewerUserId,
  });
}

function renderDirectMessageItem(item = {}) {
  const friend = item.friend || {};
  const active = !state.networkMessageHomeOpen && state.networkConversationMode === 'person' && state.networkConversationPeerId === friend.id;
  const lastSenderId = item.last?.senderUserId || item.last?.sender_user_id || '';
  const lastPreview = recentMessagePreview(item.last);
  return `<button class="network-message-item direct-message-item im-conversation-item ${item.unread ? 'is-unread' : ''} ${active ? 'active' : ''}" type="button" data-network-peer="${escapeAttr(friend.id || '')}" data-network-mode="person" data-unread-count="${escapeAttr(formatConversationUnreadCount(item.unreadCount))}" title="${escapeAttr(`${displayUserName(friend)} · ${clipInline(lastPreview || '暂无消息', 88)}`)}" aria-label="与 ${escapeAttr(displayUserName(friend))} 的会话" ${conversationSearchAttributes(`${displayUserName(friend)} ${originalUserName(friend)} ${friend.username || ''} ${friend.email || ''} ${item.searchText || lastPreview} 双人私聊`)}>
    ${renderNetworkUserAvatar(friend)}<span class="network-message-main"><span class="network-message-line"><span class="im-conversation-title-line"><strong>${escapeHtml(displayUserName(friend))}</strong><b class="im-conversation-badge is-direct">联系人</b></span><time>${escapeHtml(formatMessageTime(item.last?.updatedAt || item.last?.createdAt))}</time></span>
    <span class="network-message-preview">${renderConversationMessagePreview({ content: lastPreview, senderId: lastSenderId, senderName: displayUserName(friend) })}</span></span></button>`;
}

function recentMessagePreview(message = {}) {
  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const content = String(message?.content || '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .trim();
  if (content) return content;
  if (metadata.withdrawn === true) return '消息已撤回';
  if (metadata.favoriteEmoji === true) return '表情';
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  if (attachments.length) {
    const imageCount = attachments.filter((item) => String(item?.mimeType || item?.mime_type || '').toLowerCase().startsWith('image/')).length;
    const fileCount = attachments.length - imageCount;
    if (imageCount && fileCount) return `图片 ${imageCount} · 文件 ${fileCount}`;
    if (imageCount) return imageCount > 1 ? `图片 ${imageCount} 张` : '图片';
    return fileCount > 1 ? `文件 ${fileCount} 个` : '文件';
  }
  return '';
}

function renderConversationMessagePreview({ content = '', senderId = '', senderName = '', fallback = '暂无消息' } = {}) {
  const currentUserId = String(state.currentUser?.id || '');
  const normalizedSenderId = String(senderId || '');
  const showSender = Boolean(senderName) && (!normalizedSenderId || normalizedSenderId !== currentUserId);
  const displaySenderName = translateUiText(senderName, state.languageMode);
  const preview = content
    ? `<span data-no-localize>${escapeHtml(clipInline(content, 76))}</span>`
    : escapeHtml(translateUiText(fallback, state.languageMode));
  return `${showSender ? `<span class="im-conversation-preview-prefix" data-no-localize>${escapeHtml(displaySenderName)} · </span>` : ''}${preview}`;
}

function collaborationGroupItems() {
  const groups = new Map();
  for (const group of safeArray(state.collaborationOverview?.groups)) {
    const id = String(group?.id || '').trim();
    if (!id) continue;
    const previous = groups.get(id);
    if (!previous) {
      groups.set(id, group);
      continue;
    }
    const previousTime = new Date(previous.updatedAt || previous.updated_at || 0).getTime();
    const incomingTime = new Date(group.updatedAt || group.updated_at || 0).getTime();
    const newer = incomingTime >= previousTime ? group : previous;
    const older = newer === group ? previous : group;
    groups.set(id, {
      ...older,
      ...newer,
      unreadCount: Math.max(Number(previous.unreadCount || 0), Number(group.unreadCount || 0)),
    });
  }
  return [...groups.values()].sort((a, b) => new Date(b.updatedAt || b.updated_at || 0) - new Date(a.updatedAt || a.updated_at || 0));
}

function chatGroupItems() {
  return [...safeArray(state.chatGroupsOverview?.groups)]
    .filter((group) => group?.id)
    .sort((left, right) => new Date(right.updatedAt || right.updated_at || 0) - new Date(left.updatedAt || left.updated_at || 0));
}

function renderChatGroupItem(group = {}) {
  const ended = group.status === 'dissolved';
  const active = !state.networkMessageHomeOpen && state.chatGroupId === group.id;
  const hasStructuredPreview = group.lastMessageContent !== undefined || group.last_message_content !== undefined;
  const previewContent = hasStructuredPreview ? (group.lastMessageContent ?? group.last_message_content ?? '') : (group.lastMessage || '');
  const previewSenderId = group.lastMessageSenderUserId || group.last_message_sender_user_id || '';
  const previewSenderName = group.lastMessageSenderName || group.last_message_sender_name || '';
  const displayTitle = group.membership?.remark || group.title;
  const groupTitle = displayTitle
    ? `<strong data-no-localize>${escapeHtml(displayTitle)}</strong>`
    : '<strong>新群聊</strong>';
  return `<button class="network-message-item natural-chat-group-item im-conversation-item ${group.unreadCount ? 'is-unread' : ''} ${group.archived ? 'is-archived' : ''} ${ended ? 'is-ended' : ''} ${active ? 'active' : ''}" type="button" data-chat-group="${escapeAttr(group.id || '')}" data-conversation-kind="chat-group" data-unread-count="${escapeAttr(formatConversationUnreadCount(group.unreadCount))}" aria-label="群聊 ${escapeAttr(displayTitle || '新群聊')}" ${conversationSearchAttributes(`${displayTitle || '新群聊'} ${group.title || ''} 群聊 ${group.lastMessage || ''} ${group.archived ? '已归档' : ''} ${ended ? '已解散' : '进行中'}`)}>
    <span class="network-message-avatar natural-group-avatar">${escapeHtml(groupAvatarLabel(group))}</span><span class="network-message-main"><span class="network-message-line"><span class="im-conversation-title-line">${groupTitle}</span><time>${escapeHtml(formatMessageTime(group.updatedAt))}</time></span>
    <span class="network-message-preview">${renderConversationMessagePreview({ content: previewContent, senderId: previewSenderId, senderName: previewSenderName, fallback: `${group.memberCount || 0} 位成员` })}</span></span>
  </button>`;
}

function renderChatGroupCreateDialog() {
  if (!state.chatGroupCreateOpen) return '';
  const selected = new Set(safeArray(state.chatGroupCreateMemberIds));
  const activeOrganization = currentDirectoryOrganization();
  const organizationContacts = safeArray(activeOrganization?.members).map((item) => ({
    ...(item.user || {}), online: item.online === true || item.user?.online === true, directoryKind: 'internal',
  }));
  const organizationIds = new Set(organizationContacts.map((user) => String(user.id || '')));
  const externalContacts = safeArray(state.friendOverview?.friends).map((item) => item.friend || item.user || {})
    .filter((user) => !organizationIds.has(String(user.id || ''))).map((user) => ({ ...user, directoryKind: 'external' }));
  const contacts = [...organizationContacts, ...externalContacts]
    .filter((user, index, users) => user.id && user.id !== state.currentUser?.id && users.findIndex((item) => item.id === user.id) === index);
  const selectedContactCount = contacts.reduce((count, user) => count + (selected.has(user.id) ? 1 : 0), 0);
  return `<div class="friend-search-dialog-scrim chat-group-create-overlay" role="presentation" data-chat-group-create-overlay><section class="friend-search-dialog contact-add-dialog chat-group-create-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-group-create-title">
    <header><div><strong id="chat-group-create-title">创建联系人群聊</strong><span>可同时选择组织内联系人和外部联系人</span></div><button type="button" class="chat-group-create-close" data-chat-group-create-close aria-label="关闭创建群聊窗口" title="关闭">${iconSvg('x')}</button></header>
    <form data-chat-group-create-form><label><span>群名（可选）</span><input id="chat-group-create-name" value="${escapeAttr(state.chatGroupCreateTitle || '')}" maxlength="80" placeholder="例如 产品讨论组" /></label>
      <fieldset><legend>选择成员</legend><div class="chat-group-create-selection-bar"><label><input type="checkbox" data-chat-group-create-select-all ${contacts.length && selectedContactCount === contacts.length ? 'checked' : ''} ${contacts.length ? '' : 'disabled'}><span>全选</span></label><span data-chat-group-create-selected-count>已选 ${selectedContactCount} / ${contacts.length}</span></div><div class="chat-group-create-members" data-preserve-scroll data-scroll-key="chat-group-create-members">${contacts.length ? contacts.map((user) => `<label data-chat-group-create-member-row="${escapeAttr(user.id)}"><input type="checkbox" value="${escapeAttr(user.id)}" data-chat-group-create-member ${selected.has(user.id) ? 'checked' : ''}>${renderNetworkUserAvatar(user)}<span><strong>${escapeHtml(displayUserName(user))}</strong><small><i class="contact-presence-dot ${user.online === true ? 'is-online' : 'is-offline'}" aria-hidden="true"></i>${user.online === true ? '在线' : '离线'} · ${user.directoryKind === 'internal' ? '组织内联系人' : '外部联系人'} · ${escapeHtml(user.username ? `@${user.username}` : user.email || user.id)}</small></span></label>`).join('') : '<div class="friend-request-empty">暂无可选联系人</div>'}</div></fieldset>
      <footer><button type="button" class="btn secondary" data-chat-group-create-close>取消</button><button class="btn primary" type="submit" ${state.chatGroupCreateBusy || !selected.size ? 'disabled' : ''}>${state.chatGroupCreateBusy ? '正在创建…' : '创建群聊'}</button></footer>
    </form>
  </section></div>`;
}

function allDelegationTasks() {
  const tasks = new Map();
  for (const item of [
    ...safeArray(state.collaborationGroupDetail?.tasks),
    ...safeArray(state.agentDelegations),
    ...safeArray(state.collaborationOverview?.tasks),
  ]) {
    if (!item?.id) continue;
    const existing = tasks.get(item.id) || {};
    tasks.set(item.id, {
      ...existing,
      ...item,
      metadata: { ...(existing.metadata || {}), ...(item.metadata || {}) },
    });
  }
  return [...tasks.values()];
}

function renderCollaborationGroupItem(group = {}) {
  const localHistoryOnly = group.localHistoryOnly === true || group.metadata?.localHistoryOnly === true;
  const ended = group.status === 'closed' || localHistoryOnly;
  const active = !state.networkMessageHomeOpen && state.collaborationGroupId === group.id;
  const compactTitle = compactTaskGroupTitle(group);
  return `<button class="network-message-item collaboration-group-item im-conversation-item ${group.unreadCount ? 'is-unread' : ''} ${group.archived ? 'is-archived' : ''} ${ended ? 'is-ended' : ''} ${active ? 'active' : ''}" type="button" data-collaboration-group="${escapeAttr(group.id || '')}" data-conversation-kind="task-group" data-unread-count="${escapeAttr(formatConversationUnreadCount(group.unreadCount))}" aria-label="工作群 ${escapeAttr(compactTitle)}" ${conversationSearchAttributes(`${compactTitle} ${group.title || ''} 工作群 ${group.lastMessage || ''} ${group.archived ? '已归档' : ''} ${localHistoryOnly ? '本机历史' : ended ? '已结束' : '进行中'}`)}>
    <span class="network-message-avatar">${iconSvg(ended ? 'archive' : 'network')}</span>
    <span class="network-message-main">
      <span class="network-message-line"><span class="im-conversation-title-line"><strong>${escapeHtml(compactTitle)}</strong><b class="im-conversation-badge is-task">${localHistoryOnly ? '本机历史' : '工作群'}</b></span><time>${escapeHtml(formatMessageTime(group.updatedAt))}</time></span>
      <span class="network-message-preview"><span class="im-conversation-preview-prefix">${group.memberCount || 0} 人 · </span>${escapeHtml(clipInline(group.lastMessage || '暂无消息', 76))}</span>
    </span>
  </button>`;
}

function formatConversationUnreadCount(value = 0) {
  const count = Math.max(0, Number(value || 0));
  return count > 99 ? '99+' : String(count || 0);
}

function renderSocialGroupListSection(key = 'active', label = '', items = []) {
  const open = state.socialGroupSectionsOpen?.[key] !== false;
  return `<section class="network-group-list-section ${open ? 'open' : ''}">
    <button class="network-group-list-toggle" type="button" data-social-group-section="${escapeAttr(key)}" aria-expanded="${open ? 'true' : 'false'}">
      <span>${iconSvg(open ? 'chevronDown' : 'chevronRight')}</span><strong>${escapeHtml(label)}</strong><b>${items.length}</b>
    </button>
    ${open ? `<div class="network-message-list">${items.length ? items.map(renderNetworkMessageItem).join('') : `<div class="network-group-list-empty">暂无${escapeHtml(label)}的群聊</div>`}</div>` : ''}
  </section>`;
}

function isUBuddySessionActive() {
  if (state.networkMessageHomeOpen) return false;
  if (state.homeMode === 'secretary') return true;
  const session = (state.sessions || []).find((item) => item.id === state.currentSessionId);
  return session?.departmentId === 'secretary_department' && session?.agentId === 'secretary_agent';
}

function renderNetworkDelegationDetail() {
  const delegation = delegationById(state.networkDelegationId);
  const backLabel = state.taskWorkspaceReturnContext?.collaborationGroupId
    || state.activeTaskSourceContext?.source_group_id
    ? '返回工作群'
    : '返回消息';
  if (!delegation) {
    return `<section class="network-conversation network-delegation-detail">
      <header class="network-conversation-head"><button type="button" ${delegationTaskActionAttributes(TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT, { id: state.networkDelegationId, metadata: state.activeTaskSourceContext || {} })} title="${backLabel}">${iconSvg('chevronLeft')}</button><span class="network-secretary-avatar is-owner-ubuddy">${iconSvg('spark')}</span><span><strong>委托任务</strong><small>任务记录暂未同步</small></span></header>
      <div class="network-conversation-empty">正在等待任务数据同步，请稍后返回重试。</div>
    </section>`;
  }
  const currentUserId = state.currentUser?.id || '';
  const recipientId = delegation.recipientUserId || delegation.recipient_user_id || '';
  const isRecipient = recipientId === currentUserId;
  const status = String(delegation.status || 'assigned');
  const workspaceMessages = delegationTimelineMessages(delegation, privateWorkspaceMessagesForDelegation(delegation.id));
  const originalRequestMessage = workspaceMessages.find((message) => (
    message.role === 'system' && String(message.metadata?.type || '') === 'task_assigned'
  )) || null;
  const activityMessages = originalRequestMessage
    ? workspaceMessages.filter((message) => message !== originalRequestMessage)
    : workspaceMessages;
  const publishCandidate = delegationPublishCandidate(workspaceMessages, delegation);
  const sharedProgress = sharedDelegationProgress(delegation);
  const activeRuns = (state.networkDelegationRunsById?.[delegation.id] || []).filter((run) => ['queued', 'running'].includes(String(run.deliveryStatus || '')));
  const sharedActive = sharedProgress && ['queued', 'preparing', 'planning', 'executing', 'verifying', 'delivering'].includes(String(sharedProgress.phase || ''));
  const candidateReadyToSubmit = isRecipient && Boolean(publishCandidate)
    && ['working', 'running', 'draft_ready', 'revision_requested', 'blocked'].includes(status);
  const busy = state.networkBusyDelegationId === delegation.id
    || (!candidateReadyToSubmit && (activeRuns.length > 0 || (isRecipient && sharedActive)));
  const decisionAction = String(state.collaborationTaskActionBusyById?.[delegation.id] || '');
  const draft = state.networkDelegationCommentDrafts?.[delegation.id] || '';
  const uBuddyEnabled = state.networkDelegationUBuddyEnabled?.[delegation.id] !== false;
  const editingMessageId = state.networkDelegationEditingMessageId || '';
  const workspaceView = ['activity', 'result'].includes(state.taskWorkspaceViewById?.[delegation.id])
    ? state.taskWorkspaceViewById[delegation.id]
    : 'activity';
  const task = state.networkDelegationTaskById?.[delegation.id] || null;
  const taskProgress = task ? taskProgressForDelegation(task) : sharedProgress || {};
  const completedNodes = Number(taskProgress.completed || 0);
  const totalNodes = Number(taskProgress.total || task?.nodes?.length || 0);
  return `
    <section class="network-conversation network-delegation-detail">
      <header class="network-conversation-head network-task-workspace-head">
        <button type="button" ${delegationTaskActionAttributes(TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT, delegation)} title="${backLabel}">${iconSvg('chevronLeft')}</button>
        <span class="network-secretary-avatar is-owner-ubuddy">${iconSvg('spark')}</span>
        <span><strong>${escapeHtml(delegation.title || text.delegateTask)}</strong><small>${escapeHtml(delegation.instruction || '未提供任务目标')}</small><em>${escapeHtml(delegationStatusLabel(delegation, isRecipient))}${totalNodes ? ` · ${completedNodes}/${totalNodes} 节点` : ''} · ${escapeHtml(isRecipient ? `来自 ${displayUserName(delegation.requester || {})}` : `交给 ${displayUserName(delegation.recipient || {})}`)}</em></span>
      </header>
      <div class="network-delegation-body" data-preserve-scroll data-scroll-key="network-delegation:${escapeAttr(delegation.id)}" data-scroll-follow-bottom>
        ${renderTaskWorkspaceTabs(delegation, workspaceView, { resultReady: Boolean(publishCandidate) || ['draft_ready', 'submitted', 'result_accepted', 'completed', 'closed'].includes(status) })}
        ${workspaceView === 'activity' && originalRequestMessage ? renderDelegationIngress(originalRequestMessage, delegation) : ''}
        ${renderRecentWorkDigestState(delegation, { isRecipient, busy })}
        ${workspaceView === 'result'
            ? renderDelegationResultView(delegation, { task, workspaceMessages, publishCandidate, isRecipient, busy, decisionAction })
            : `${renderDelegationUnifiedProgress(delegation, { isRecipient, sharedProgress, activeRuns })}
              <section class="network-delegation-private-workspace network-delegation-chat-timeline">
                <div class="network-delegation-update-list" id="network-delegation-message-list">
                  ${activityMessages.length
                    ? activityMessages.map((message) => renderDelegationUpdate(message, delegation, { isRecipient })).join('')
                    : '<div class="network-delegation-no-comments">这里暂时还没有消息。</div>'}
                  ${status === 'draft_ready' ? renderDelegationDraftReady(publishCandidate) : ''}
                  ${renderDelegationSyncState(delegation)}
                  ${renderDelegationClarificationState(delegation, { isRecipient })}
                  ${renderDelegationFailureState(delegation, { isRecipient })}
                  ${renderDelegationDecisionActions(delegation, { isRecipient, busy, publishCandidate, decisionAction })}
                </div>
              </section>`}
      </div>
      ${['rejected', 'declined', 'withdrawn'].includes(status) ? '<div class="network-task-readonly-banner">任务已结束，当前工作区为只读。</div>' : renderDelegationComposer({
        delegation, draft, editingMessageId, isRecipient, busy, uBuddyEnabled,
      })}
    </section>
  `;
}

function renderRecentWorkDigestState(delegation = {}, { isRecipient = false, busy = false } = {}) {
  if (String(delegation.metadata?.taskKind || '') !== 'recent_work_report' || !isRecipient) return '';
  const spec = delegation.metadata?.workReportSpec || {};
  const coverage = delegation.metadata?.workDigestCoverage || {};
  const stateValue = String(delegation.metadata?.workDigestState || '');
  const range = translateUiText(spec.startAt && spec.endAt
    ? `${String(spec.startAt).slice(0, 10)} 至 ${String(spec.endAt).slice(0, 10)}`
    : '等待范围同步', state.languageMode);
  if (stateValue !== 'awaiting_owner_supplement') {
    const coverageText = translateUiText(`已纳入 ${Number(coverage.includedTaskCount || 0)} 个结构化任务`, state.languageMode);
    return `<section class="network-work-digest-status"><strong>${escapeHtml(translateUiText('近期工作汇报', state.languageMode))}</strong><span>${escapeHtml(range)} · ${escapeHtml(coverageText)}</span></section>`;
  }
  const expiresAt = delegation.metadata?.workDigestExpiresAt || '';
  return `<section class="network-work-digest-supplement">
    <header><strong>${escapeHtml(translateUiText('暂未找到结构化工作记录', state.languageMode))}</strong><span>${escapeHtml(range)}</span></header>
    <p>${escapeHtml(translateUiText('你可以补充未记录的工作；若不补充，等待期结束后只会返回“未找到结构化记录”，不会代表你确认没有开展其他工作。', state.languageMode))}</p>
    <form id="work-digest-supplement-form" data-delegation-id="${escapeAttr(delegation.id || '')}">
      <textarea rows="3" maxlength="4000" data-work-digest-supplement placeholder="${escapeAttr(translateUiText('补充已完成、进行中、阻塞或下一步', state.languageMode))}" ${busy ? 'disabled' : ''}></textarea>
      <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${escapeHtml(translateUiText('生成私人草稿', state.languageMode))}</button>
    </form>
    ${expiresAt ? `<time>${escapeHtml(translateUiText(`等待截止：${formatMessageTime(expiresAt)}`, state.languageMode))}</time>` : ''}
  </section>`;
}

function renderTaskWorkspaceTabs(delegation = {}, selected = 'activity', { resultReady = false } = {}) {
  const tabs = [
    ['activity', '动态'],
    ['result', resultReady ? '结果' : '结果 · 待生成'],
  ];
  return `<nav class="network-task-workspace-tabs" aria-label="任务工作区视图">${tabs.map(([value, label]) => `<button type="button" class="${selected === value ? 'active' : ''}" data-task-workspace-view="${value}" data-task-workspace-id="${escapeAttr(delegation.id || '')}" aria-pressed="${selected === value ? 'true' : 'false'}">${escapeHtml(label)}</button>`).join('')}</nav>`;
}

function renderDelegationFlowView(delegation = {}, task = null, progress = {}) {
  const nodes = Array.isArray(task?.nodes) && task.nodes.length
    ? task.nodes
    : Array.isArray(progress?.nodes) ? progress.nodes : [];
  const groups = [
    ['待执行', ['pending', 'ready']],
    ['处理中', ['queued', 'running']],
    ['等待 / 阻塞', ['waiting', 'retry_wait', 'blocked']],
    ['已结束', ['completed', 'failed', 'cancelled']],
  ];
  const projectionEnvelope = state.uBuddyFeatureFlags?.agentWorkDetailProjection === true
    ? task?.agentWorkStatusProjection || delegation.metadata?.agentWorkStatusProjection || null
    : null;
  return `<section class="network-task-flow-view" aria-label="${escapeAttr(delegation.title || '任务')}流程图">
    <header><strong>任务流程图</strong><span>流程仅在当前视图展示；切回“动态”可继续查看消息。</span></header>
    <div class="network-task-flow-columns">${groups.map(([label, statuses]) => {
      const items = nodes.filter((node) => statuses.includes(String(node.status || 'pending')));
      return `<section><h3>${escapeHtml(label)}<b>${items.length}</b></h3><div>${items.length ? items.map((node) => { const projection = workProjectionForNode(projectionEnvelope, node); return `<article class="is-${escapeAttr(node.status || 'pending')}"><strong>${escapeHtml(node.title || '任务节点')}</strong><span>${escapeHtml(delegationTaskNodeStatusLabel(node.status))}${projection?.actorLabel || node.agentName || node.agentId ? ` · ${escapeHtml(projection?.actorLabel || node.agentName || node.agentId)}` : ''}</span>${projection?.currentAction || node.summary || node.objective ? `<p>${escapeHtml(projection?.currentAction || node.summary || node.objective)}</p>` : ''}${projection?.timeline?.length ? `<small>${escapeHtml(projection.timeline.at(-1)?.summary || '')}</small>` : ''}</article>`; }).join('') : '<p class="network-task-flow-empty">暂无节点</p>'}</div></section>`;
    }).join('')}</div>
  </section>`;
}

function renderDelegationResultView(delegation = {}, { task = null, workspaceMessages = [], publishCandidate = null, isRecipient = false, busy = false, decisionAction = '' } = {}) {
  const deliverable = task?.metadata?.deliverableResult || task?.metadata?.deliverable || null;
  const latestAssistant = workspaceMessages.slice().reverse().find((message) => message.role === 'assistant' && String(message.content || '').trim()) || null;
  const attachments = delegationMessageAttachments(deliverable?.files
    || delegation.metadata?.resultAttachments
    || delegation.metadata?.attachments
    || latestAssistant?.metadata?.attachments
    || []);
  const summary = deliverable?.summary
    || delegation.metadata?.latestResult
    || latestAssistant?.content
    || delegation.metadata?.preliminaryResult
    || '';
  const ready = Boolean(deliverable || publishCandidate || summary || ['submitted', 'result_accepted', 'completed', 'closed'].includes(String(delegation.status || '')));
  return `<section class="network-task-result-view collaboration-card ${ready ? 'is-ready' : 'is-pending'}">
    <header><span>${ready ? '任务结果' : '等待结果'}</span><strong>${escapeHtml(deliverable?.title || delegation.title || '任务交付')}</strong></header>
    <p>${escapeHtml(summary || 'uBuddy 正在整理结果。完成后，交付摘要和文件会显示在这里。')}</p>
    ${attachments.length ? `<div class="network-delegation-file-block">${renderMessageAttachmentCards(attachments)}</div>` : ''}
    ${ready ? renderDelegationDecisionActions(delegation, { isRecipient, busy, publishCandidate, decisionAction }) : ''}
    ${renderDelegationFailureState(delegation, { isRecipient })}
  </section>`;
}

function delegationTaskActionAttributes(action = '', delegation = {}) {
  const context = normalizeTaskSourceContext({
    ...(state.activeTaskSourceContext || {}),
    ...(delegation.metadata || {}),
    task_workspace_id: delegation.id || state.networkDelegationId || '',
  });
  const taskRunId = String(
    state.networkDelegationTaskById?.[delegation.id]?.id
    || state.networkDelegationMemory?.taskRunId
    || delegation.taskRunId
    || delegation.task_run_id
    || delegation.metadata?.activeTaskRunId
    || '',
  ).trim();
  return [
    `data-task-card-action="${escapeAttr(action)}"`,
    `data-task-workspace-id="${escapeAttr(context.task_workspace_id)}"`,
    `data-task-source-conversation-id="${escapeAttr(context.source_conversation_id)}"`,
    `data-task-source-message-id="${escapeAttr(context.source_message_id)}"`,
    `data-task-source-group-id="${escapeAttr(context.source_group_id)}"`,
    `data-task-return-anchor-id="${escapeAttr(state.activeTaskReturnAnchorId || '')}"`,
    `data-task-return-surface="${escapeAttr(state.activeTaskReturnSurface || '')}"`,
    `data-task-group-id="${escapeAttr(delegation.groupId || delegation.group_id || delegation.metadata?.groupId || '')}"`,
    `data-task-run-id="${escapeAttr(taskRunId)}"`,
  ].join(' ');
}

function renderDelegationUnifiedProgress(delegation = {}, { isRecipient = false, sharedProgress = null, activeRuns = [] } = {}) {
  const task = isRecipient ? state.networkDelegationTaskById?.[delegation.id] || null : null;
  const taskRunId = String(task?.id || state.networkDelegationMemory?.taskRunId || delegation.taskRunId || delegation.task_run_id || '').trim();
  if (!taskRunId && activeRuns.length) return renderDelegationActiveRun(activeRuns[0], delegation);
  const latestRunEvent = activeRuns.flatMap((run) => run.events || []).sort((left, right) => Number(left.sequenceNo || 0) - Number(right.sequenceNo || 0)).at(-1) || null;
  const receiptProgress = latestRunEvent?.payload?.taskProgress || null;
  const progress = task ? taskProgressForDelegation(task) : sharedProgress || receiptProgress || null;
  if (!progress && !taskRunId) return '';
  const nodes = task
    ? (task.nodes || []).map(delegationTaskNodeView)
    : Array.isArray(progress?.nodes) ? progress.nodes : [];
  const activeNodes = nodes.filter((node) => ['ready', 'queued', 'running'].includes(String(node.status || '')));
  const taskStatus = String(task?.status || '');
  const delegationStatus = String(delegation.status || 'running');
  const clarificationQuestion = delegationStatus === 'blocked'
    ? String(delegation.metadata?.clarification?.question || '').trim()
    : '';
  const blocker = clarificationQuestion ? {
    ...(progress?.blocker || {}),
    summary: progress?.blocker?.summary || clarificationQuestion,
    displayLabel: isRecipient ? '等待你补充信息' : '等待接收方回复',
    userActionRequired: isRecipient,
    requiresUserAction: isRecipient,
    suggestedNextStep: isRecipient
      ? '请在私有任务工作区回复，uBuddy 会继续原任务。'
      : '等待接收方回复后自动继续原任务。',
  } : progress?.blocker || null;
  const terminal = Boolean(progress?.terminal)
    || ['result_accepted', 'closed', 'withdrawn', 'declined', 'rejected', 'failed'].includes(delegationStatus);
  const canCancel = isRecipient && Boolean(taskRunId) && !terminal && ['pending', 'ready', 'queued', 'running', 'waiting', 'verifying'].includes(taskStatus);
  const canRerun = isRecipient && Boolean(taskRunId) && (['failed', 'cancelled'].includes(taskStatus) || ['blocked', 'failed'].includes(delegationStatus));
  return renderTaskProgressCard({
    content: latestRunEvent?.message || progress?.message || delegationProgressLabel(progress?.phase),
    taskRunId,
    delegationId: delegation.id || '',
    taskType: task?.metadata?.taskType || '',
    objective: task?.metadata?.objective || null,
    phase: delegationProgressPhase(progress?.phase, delegationStatus),
    taskStatus: taskStatus || delegationStatus,
    progress: progress || {},
    activeNodes,
    nodes,
    milestones: progress?.milestones || [],
    blocker,
    deliverable: task?.metadata?.deliverableResult || progress?.deliverable || null,
    resultState: task?.metadata?.resultState || progress?.resultState || '',
    technicalDetails: progress?.technicalDetails || null,
    coordinationSnapshot: task?.metadata?.coordinationSnapshot || task?.metadata?.coordination || delegation.metadata?.coordinationSnapshot || delegation.metadata?.coordination || null,
    terminal,
    open: !terminal,
    title: clarificationQuestion
      ? (isRecipient ? '等待你补充信息' : '等待接收方回复')
      : terminal || ['completed', 'draft_ready', 'submitted', 'result_accepted'].includes(delegationStatus)
        ? '委托执行过程'
        : 'uBuddy 正在推进委托',
    wrapperClass: 'network-delegation-unified-progress collaboration-run-message',
    controls: {
      canOpen: isRecipient && Boolean(taskRunId),
      canSupplement: isRecipient && !terminal,
      canCancel,
      canRerun,
      canRetry: isRecipient,
    },
    agentName: (agentId) => state.org?.agents?.find((agent) => agent.id === agentId)?.name || agentId || 'Agent',
    taskNodeStatusLabel: delegationTaskNodeStatusLabel,
    taskTypeLabel: delegationTaskTypeLabel,
  });
}

function taskProgressForDelegation(task = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const previous = state.networkDelegationProgressById?.[task.metadata?.delegationId] || {};
  const counts = {
    ...previous,
    total: nodes.length,
    pending: nodes.filter((node) => node.status === 'pending').length,
    ready: nodes.filter((node) => node.status === 'ready').length,
    queued: nodes.filter((node) => node.status === 'queued').length,
    running: nodes.filter((node) => node.status === 'running').length,
    waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
    completed: nodes.filter((node) => node.status === 'completed').length,
    failed: nodes.filter((node) => node.status === 'failed').length,
  };
  const lifecycle = deriveTaskLifecycleProgress({
    phase: previous.lifecyclePhase || previous.phase || task.status || '',
    taskStatus: task.status || '',
    executionPercent: counts.total ? Math.round((counts.completed / counts.total) * 100) : 0,
    reviewState: task.deliveryReview?.state || task.metadata?.deliveryReview?.state || task.metadata?.deliveryReviewState || '',
    finalDelivery: task.metadata?.finalDelivery || null,
    acceptanceSource: task.metadata?.deliveryReviewOutcome || '',
    hasConfirmationProtocol: Boolean(
      task.metadata?.finalDelivery || task.deliveryReview || task.metadata?.deliveryReview || task.metadata?.deliveryReviewState,
    ),
  });
  return { ...counts, ...lifecycle, lifecyclePhase: lifecycle.phase };
}

function delegationTaskNodeView(node = {}) {
  return {
    id: node.id || '',
    title: node.title || '任务节点',
    agentId: node.agentId || '',
    status: node.status || 'pending',
    summary: delegationTaskNodeStatusLabel(node.status),
    attemptCount: Number(node.attemptCount || 0),
    maxAttempts: Number(node.maxAttempts || 3),
    nextRetryAt: node.nextRetryAt || '',
  };
}

function delegationTaskNodeStatusLabel(status = '') {
  return ({ pending: '等待依赖', ready: '待执行', queued: '排队中', running: '执行中', retry_wait: '等待自动重试', waiting: '等待信息', blocked: '依赖失败阻塞', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] || '处理中';
}

function delegationTaskTypeLabel(value = '') {
  return ({ code_change: '代码修改', file_generation: '文件生成', command_execution: '命令执行', research: '调研', explanation: '解释说明', qa: '问答', collaboration: '多 Agent 协作' })[value] || '委托任务';
}

function delegationProgressPhase(phase = '', status = '') {
  if (['submitted', 'result_accepted', 'completed', 'closed'].includes(status)) return 'delivering';
  if (phase === 'preparing' || phase === 'queued') return 'planning';
  if (phase === 'delivered') return 'delivered';
  if (phase === 'awaiting_delivery' || phase === 'delivering') return 'delivering';
  return phase || (status === 'verifying' ? 'verifying' : 'executing');
}

function delegationProgressLabel(phase = '') {
  return ({ queued: '等待接收方 uBuddy', preparing: '正在准备执行环境', planning: '正在规划任务', executing: 'uBuddy 正在处理', verifying: '正在校验交付物', awaiting_delivery: '等待确认交付', delivering: '正在交付到任务群', delivered: '已交付' })[phase] || '任务进度已更新';
}

function sharedDelegationProgress(delegation = {}) {
  return state.networkDelegationProgressById?.[delegation.id]
    || delegation.metadata?.executionProgress
    || null;
}

function delegationLifecycleProgress(progress = {}, delegation = {}) {
  const total = Number(progress?.total || 0);
  const completed = Number(progress?.completed || 0);
  const metadata = delegation.metadata || {};
  return deriveTaskLifecycleProgress({
    phase: progress?.lifecyclePhase || delegationProgressPhase(progress?.phase, delegation.status),
    taskStatus: progress?.taskStatus || delegation.status || '',
    failureStage: progress?.failureStage || metadata.failureStage || '',
    executionPercent: Number.isFinite(Number(progress?.executionPercent))
      ? Math.max(Number(progress.executionPercent), total ? Math.round((completed / total) * 100) : 0)
      : total ? Math.round((completed / total) * 100) : 0,
    reviewState: progress?.reviewState || metadata.deliveryReview?.state || metadata.deliveryReviewState || '',
    finalDelivery: progress?.finalDelivery || metadata.finalDelivery || null,
    acceptanceSource: progress?.acceptanceSource || metadata.deliveryReviewOutcome || '',
    hasConfirmationProtocol: progress?.confirmationRequired === true || Boolean(
      metadata.finalDelivery || metadata.deliveryReview || metadata.deliveryReviewState,
    ),
  });
}

function renderDelegationDraftReady(publishCandidate = null) {
  return `<article class="network-delegation-draft-result"><strong>任务结果已准备完成</strong><span>${publishCandidate ? '结果仍在接收方私有工作区，确认后才会交付到任务群。' : '正在同步可交付结果，请稍后刷新。'}</span></article>`;
}

function renderDelegationActiveRun(run = {}, delegation = {}) {
  const events = Array.isArray(run.events) ? run.events : [];
  const latest = events.at(-1) || null;
  const payload = latest?.payload || {};
  const queued = String(run.deliveryStatus || '') === 'queued';
  const message = latest?.message || run.metadata?.lastMessage || (queued ? '正在等待 uBuddy FIFO 队列' : 'uBuddy 正在处理任务');
  const progress = payload.taskProgress || null;
  const lifecycleProgress = delegationLifecycleProgress(progress || {}, delegation);
  const percent = lifecycleProgress.percent;
  return `<article class="network-delegation-progress-card" data-delegation-work-id="${escapeAttr(run.workId || '')}">
    <div class="network-delegation-progress-head"><span class="network-secretary-avatar">U</span><div><strong>${queued ? '已进入 uBuddy 队列' : 'uBuddy 正在处理'}</strong><small>${escapeHtml(message)}</small></div><button type="button" class="btn secondary" data-delegation-run-cancel="${escapeAttr(run.workId || '')}" data-delegation-id="${escapeAttr(delegation.id || '')}">取消</button></div>
    ${progress?.total ? `<div class="network-delegation-progress-track"><i style="width:${percent}%"></i></div><div class="network-delegation-progress-count">${escapeHtml(lifecycleProgress.label)} ${percent}% · 已完成 ${Number(progress.completed || 0)} / ${Number(progress.total)} 个执行节点</div>` : ''}
    ${events.length ? `<details class="network-delegation-process"><summary>查看处理过程 · ${events.length} 条</summary><div>${events.slice(-30).map((event) => `<p><strong>${escapeHtml(event.stage || event.kind || '处理')}</strong><span>${escapeHtml(event.message || '')}</span></p>`).join('')}</div></details>` : ''}
  </article>`;
}

function renderDelegationFailureState(delegation = {}, { isRecipient = false } = {}) {
  const status = String(delegation.status || '');
  if (!['blocked', 'failed'].includes(status)) return '';
  if (status === 'blocked' && delegation.metadata?.clarification?.question) return '';
  const code = String(delegation.metadata?.failureCode || '').trim();
  const labels = {
    no_active_employee: '没有可执行该任务的在职 Agent',
    ppt_skill_install_required: '接收方设备缺少 PPT 制作 Skill',
    ppt_employee_not_active: '接收方没有已启用的 PPT Agent',
    leadership_capacity_unavailable: 'Agent Leader 不可用，等待切换为 uBuddy 平面协调',
    model_unavailable: '模型服务暂时不可用',
    deliverable_missing: '必要交付物未通过校验',
    workspace_permission_denied: '任务工作区权限不足',
    execution_cancelled: '任务执行已取消',
    execution_failed: 'Agent 执行失败',
  };
  const title = status === 'blocked' ? '任务可恢复' : '任务执行失败';
  const publicFailure = delegation.metadata?.publicFailure || {};
  const failureStage = String(publicFailure.stage || delegation.metadata?.failureStage || '').trim();
  const publicMessage = translateUiText(
    String(publicFailure.message || delegation.lastError || labels[code] || 'uBuddy 已保留任务上下文。').trim(),
    state.languageMode,
  );
  const privateDetail = isRecipient ? String(delegation.metadata?.executionFailureDetail || '').trim() : '';
  const failureStageSuffix = failureStage
    ? state.languageMode === 'en' ? ` · Failure stage: ${failureStage}` : ` · 失败阶段：${failureStage}`
    : '';
  return `<div class="network-delegation-waiting"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(publicMessage)}${escapeHtml(failureStageSuffix)}</span>${privateDetail ? `<details><summary>查看本地诊断</summary><pre>${escapeHtml(privateDetail)}</pre></details>` : ''}</div>`;
}

function renderDelegationClarificationState(delegation = {}, { isRecipient = false } = {}) {
  if (String(delegation.status || '') !== 'blocked') return '';
  const question = String(delegation.metadata?.clarification?.question || '').trim();
  if (!question) return '';
  const next = isRecipient
    ? '请在下方回复。uBuddy 收到后会继续原任务，不会新建任务。'
    : '已通知接收方；对方回复后，uBuddy 会自动继续。';
  return `<div class="network-delegation-waiting is-action-required"><strong>${escapeHtml(isRecipient ? '等待你补充信息' : '等待接收方回复')}</strong><span>${escapeHtml(question)}</span><small>${escapeHtml(next)}</small></div>`;
}

function renderDelegationSyncState(delegation = {}) {
  if (delegation.metadata?.syncState !== 'pending') return '';
  const status = String(delegation.status || '');
  const hasLocalResult = ['draft_ready', 'submitted', 'result_accepted', 'completed'].includes(status)
    || Boolean(delegation.metadata?.draftReadyAt || delegation.metadata?.preliminaryResult || delegation.metadata?.generatedTaskFiles?.length);
  if (hasLocalResult) {
    return '<div class="network-delegation-waiting"><strong>本地结果已保存，等待同步</strong><span>网络恢复后 uBuddy 会自动把最新状态和私有工作区增量同步到云端。</span></div>';
  }
  return '<div class="network-delegation-waiting"><strong>云端同步暂时中断</strong><span>uBuddy 会继续使用本地任务上下文处理；网络恢复后自动补同步进度和工作区增量。</span></div>';
}

function renderDelegationComposer({ delegation = {}, draft = '', editingMessageId = '', isRecipient = false, busy = false, uBuddyEnabled = true } = {}) {
  const placeholder = editingMessageId
    ? '修改这条私有内容…'
    : isRecipient
      ? Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId)
        ? '告诉 uBuddy 如何补充、修改初稿，或回复“提交到任务群”…'
        : '告诉 uBuddy 如何补充、修改初稿，或回复“确认提交”…'
      : '告诉 uBuddy 如何修改要求；需要文件时请明确说明…';
  return `<div class="network-delegation-composer-shell">
    <div class="composer-stack compact-stack network-delegation-composer-stack">
      ${editingMessageId ? `<div class="network-delegation-editing-banner"><span>正在修改私有内容；修改完成后仍需由你确认是否发布。</span><button type="button" data-delegation-edit-cancel>取消修改</button></div>` : ''}
      <form id="network-delegation-comment-form" class="composer compact-composer network-delegation-comment-form is-ubuddy-mode ${state.attachments.length ? 'has-attachments' : ''}" data-delegation-id="${escapeAttr(delegation.id)}">
        <div class="composer-main">
          ${renderAttachmentTray()}
          <div class="composer-input-line">
            <textarea id="network-delegation-comment-input" rows="1" placeholder="${escapeAttr(busy ? '可继续编辑下一条消息，当前消息处理完成后即可发送…' : placeholder)}">${escapeHtml(draft)}</textarea>
          </div>
        </div>
        <div class="composer-quick-actions">
          <button class="composer-plus" type="button" title="上传文件">+</button>
          <button class="composer-ubuddy-action ${uBuddyEnabled ? 'active' : ''}" type="button" data-delegation-ubuddy-toggle="${escapeAttr(delegation.id)}" title="${uBuddyEnabled ? '自己的 uBuddy 将协助整理并转达' : '启用自己的 uBuddy 协助'}">
            <span class="composer-ubuddy-mark">U</span><span>uBuddy</span><span class="ubuddy-beta-badge">Beta</span>
          </button>
        </div>
        <div class="composer-controls">
          ${renderModelReasoningPicker(currentModelValue(), currentReasoningValue())}
          <button class="send-btn" type="submit" title="${editingMessageId ? '保存修改' : '发送回复'}" aria-label="${editingMessageId ? '保存修改' : '发送回复'}" ${!String(draft).trim() && !state.attachments.length ? 'disabled' : ''}>${iconSvg('send')}</button>
        </div>
      </form>
      ${renderDelegationComposerMeta(delegation, { uBuddyEnabled })}
    </div>
  </div>`;
}

function renderDelegationComposerMeta(delegation = {}, { uBuddyEnabled = true } = {}) {
  const memory = state.networkDelegationMemory || {};
  const coordinator = memory.coordinator || null;
  const workspaceRoot = memory.workspaceRoot || delegation.metadata?.taskWorkspaceRoot || '';
  const sharedGroupWorkspace = memory.workspaceScope === 'collaboration_group' || Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId);
  const memoryLabel = coordinator?.displayName || `${String(delegation.title || '任务').slice(0, 28)}.md`;
  const executionDocuments = memory.executionDocuments || [];
  return `<div class="composer-meta-bar network-delegation-meta-bar">
    <button class="composer-meta-action network-delegation-workspace-action" type="button" data-delegation-workspace-open title="${sharedGroupWorkspace ? '打开任务群共享文件工作区' : '打开本任务的独立文件工作区'}" ${workspaceRoot ? '' : 'disabled'}>
      ${iconSvg('folder')}<span>${sharedGroupWorkspace ? '群共享工作区' : '任务工作区'}</span>
    </button>
    <div class="composer-memory-picker network-delegation-memory-picker model-picker menu-align-left menu-above ${state.networkDelegationMemoryMenuOpen ? 'is-open' : ''}">
      <button class="composer-meta-action model-trigger composer-memory-trigger" type="button" data-delegation-memory-toggle title="查看本任务独立 Memory" aria-haspopup="menu" aria-expanded="${state.networkDelegationMemoryMenuOpen ? 'true' : 'false'}">
        ${iconSvg('memory')}<span>${escapeHtml(memoryLabel)}</span>${iconSvg('chevronDown')}
      </button>
      ${state.networkDelegationMemoryMenuOpen ? `<div class="model-menu composer-memory-menu network-delegation-task-memory-menu" role="menu" aria-label="任务 Memory">
        <div class="composer-memory-menu-head"><strong>本任务独立 Memory</strong><small>与 memory0、memory1 隔离；离开页面后仍继续保留并随任务更新</small></div>
        ${coordinator ? renderDelegationMemoryDocument(coordinator, '我的 uBuddy · 协调整理', true) : '<div class="composer-memory-loading">正在准备本任务 Memory…</div>'}
        ${executionDocuments.length ? `<div class="model-menu-divider"></div><div class="network-delegation-memory-section-label">执行 Agent 的任务 Memory</div>${executionDocuments.map((document) => renderDelegationMemoryDocument(document, document.agentName || '执行 Agent')).join('')}` : ''}
      </div>` : ''}
    </div>
    <span class="composer-meta-action network-delegation-permission" title="任务执行仅可访问本任务工作区；超出范围的操作仍会请求批准">
      ${iconSvg('permissionAsk')}<span>请求批准</span>
    </span>
    <span class="network-delegation-send-hint">${sharedGroupWorkspace ? '对话仅自己可见 · 工作区文件群内可见' : (uBuddyEnabled ? '由我的 uBuddy 整理 · 仅自己可见' : '直接记录 · 仅自己可见')}</span>
  </div>`;
}

function renderDelegationMemoryDocument(document = {}, label = '', open = false) {
  const content = document.decryptionState === 'unavailable'
    ? '此设备暂时无法解密这份任务 Memory。'
    : String(document.content || '').trim() || '这份任务 Memory 尚未写入内容。';
  return `<details class="network-delegation-memory-document" ${open ? 'open' : ''}>
    <summary>${iconSvg('document')}<span><strong>${escapeHtml(document.displayName || 'task-memory.md')}</strong><small>${escapeHtml(label)}</small></span>${iconSvg('chevronDown')}</summary>
    <pre>${escapeHtml(content)}</pre>
  </details>`;
}

function renderDelegationUpdate(message = {}, delegation = null, { isRecipient = false } = {}) {
  const metadata = message.metadata || {};
  const generatedFiles = message.role === 'system' && Boolean(metadata.generatedTaskFiles);
  if (message.role === 'system' && !generatedFiles) return renderDelegationIngress(message, delegation);
  const mine = message.role === 'user';
  const agent = message.role === 'assistant' || generatedFiles;
  if (!mine && !agent) return '';
  const actor = mine ? displayUserName(state.currentUser || {}) : '我的 uBuddy';
  const avatarLabel = agent ? iconSvg('spark') : userInitials(state.currentUser);
  const avatar = mine
    ? renderUserAvatar(state.currentUser || {}, { className: 'network-delegation-update-avatar', title: actor, fallbackLabel: avatarLabel })
    : `<span class="network-delegation-update-avatar is-ubuddy" title="${escapeAttr(actor)}" aria-label="${escapeAttr(`${actor}的头像`)}">${avatarLabel}</span>`;
  const withdrawn = Boolean(metadata.withdrawn);
  const attachments = delegationMessageAttachments(metadata.attachments);
  const artifact = agent ? renderTaskArtifactMessage(message.content) : '';
  const visibility = workspaceMessageVisibility(message, delegation, null);
  const typeLabel = mine ? '仅自己可见' : visibility.label;
  const coordinatedAgentIds = Array.isArray(metadata.assignedAgentIds) ? metadata.assignedAgentIds : [];
  const coordinatedAgentNames = coordinatedAgentIds.map((agentId) => (
    state.org?.agents?.find((item) => item.id === agentId)?.name || agentId
  ));
  const processLabel = withdrawn
    ? '已撤回'
    : metadata.sendFailed
      ? '发送失败 · 内容已放回输入框'
      : metadata.optimistic
        ? '已发送 · uBuddy 正在处理'
        : metadata.edited
          ? '已修改'
          : metadata.ubuddyTeamCoordination
            ? `uBuddy 已协调 ${Math.max(1, coordinatedAgentIds.length)} 个 Agent`
            : metadata.processedByOwnUBuddy || metadata.relayedByOwnUBuddy
              ? 'uBuddy 已整理'
              : '';
  return `
    <article class="network-delegation-update ${mine ? 'mine' : 'agent'} ${withdrawn ? 'is-withdrawn' : ''} ${metadata.optimistic ? 'is-pending' : ''} ${metadata.sendFailed ? 'is-send-failed' : ''}" data-workspace-message-id="${escapeAttr(message.id || '')}">
      ${avatar}
      <div class="network-delegation-message-shell">
        <div class="network-delegation-update-head">
          <strong>${escapeHtml(actor)}</strong>
          <time>${escapeHtml(formatMessageTime(message.updatedAt || message.updated_at || message.createdAt || message.created_at))}</time>
          <span class="network-delegation-message-visibility ${escapeAttr(visibility.tone)}">${escapeHtml(typeLabel)}</span>
          <div class="network-delegation-update-tools">${processLabel ? `<em>${escapeHtml(processLabel)}</em>` : ''}</div>
        </div>
        <div class="network-delegation-message-content">
          ${withdrawn ? '<p class="network-delegation-message-bubble network-delegation-withdrawn-copy">这条内容已撤回，uBuddy 会从任务整理中移除它。</p>' : `
            ${artifact || (String(message.content || '').trim() ? `<p class="network-delegation-message-bubble">${escapeHtml(message.content)}</p>` : '')}
            ${metadata.ubuddyTeamCoordination ? `<div class="network-delegation-agent-coordination">${iconSvg('users')}<span>本次由 uBuddy 按 Skill、等级和队列分配给：${escapeHtml(coordinatedAgentNames.join('、') || '已选员工 Agent')}</span></div>` : ''}
            ${attachments.length ? `<div class="network-delegation-file-block">${renderMessageAttachmentCards(attachments)}</div>` : ''}
          `}
        </div>
      </div>
    </article>
  `;
}

function delegationMessageAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item?.uploaded && item?.file) {
      return {
        id: item.id || '',
        kind: item.kind || '',
        name: item.file.name || item.name || 'file',
        filename: item.file.name || item.name || 'file',
        size: item.file.size || item.size || 0,
        type: item.file.type || '',
        fileUrl: item.localPreviewUrl || '',
      };
    }
    if (!item?.uploaded) return item;
    const name = item.uploaded.filename || item.file?.name || item.name || 'file';
    return {
      ...item.uploaded,
      id: item.uploaded.id || item.id || '',
      kind: item.kind || item.uploaded.kind || '',
      name,
      filename: name,
      size: item.uploaded.size || item.file?.size || item.size || 0,
    };
  });
}

function renderDelegationIngress(message = {}, delegation = {}) {
  const metadata = message.metadata || {};
  const sharedGroupWorkspace = Boolean(delegation?.groupId || delegation?.group_id || delegation?.metadata?.groupId || metadata.groupId);
  const label = metadata.type === 'task_assigned' || metadata.virtualOriginalRequest
    ? '原始任务要求'
    : metadata.type === 'requirements_update' || ['publish', 'update_requirements', 'request_revision'].includes(metadata.action)
    ? (sharedGroupWorkspace ? '来自任务群的新要求' : '来自发起方的新要求')
    : metadata.type === 'submission_update' || metadata.action === 'submit'
      ? (sharedGroupWorkspace ? '任务群有新的公开提交' : '接收方已交付任务结果')
      : (sharedGroupWorkspace ? '来自任务群的公开更新' : '委托状态更新');
  const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
  return `<div class="network-delegation-ingress ${metadata.virtualOriginalRequest ? 'is-original' : ''}" data-workspace-message-id="${escapeAttr(message.id || '')}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(message.content || '')}</span><time>${escapeHtml(formatMessageTime(message.updatedAt || message.updated_at || message.createdAt || message.created_at))}</time>${attachments.length ? `<div class="network-delegation-ingress-files">${renderMessageAttachmentCards(attachments)}</div>` : ''}</div>`;
}

function delegationTimelineMessages(delegation = {}, messages = []) {
  if (messages.some((message) => message.role === 'system' && message.metadata?.type === 'task_assigned')) return messages;
  const original = {
    id: `original:${delegation.id || ''}`,
    role: 'system',
    content: delegation.instruction || delegation.title || '未提供任务要求。',
    metadata: {
      delegationId: delegation.id || '',
      privateTaskWorkspace: true,
      type: 'task_assigned',
      virtualOriginalRequest: true,
      attachments: Array.isArray(delegation.metadata?.attachments) ? delegation.metadata.attachments : [],
    },
    createdAt: delegation.createdAt || delegation.created_at || '',
    updatedAt: delegation.createdAt || delegation.created_at || '',
  };
  return [original, ...messages];
}

function privateWorkspaceMessagesForDelegation(delegationId = '') {
  const seen = new Set();
  const pending = state.networkDelegationPendingMessages?.[delegationId];
  return [...(state.networkConversationMessages || []), ...(Array.isArray(pending) ? pending : pending ? [pending] : [])]
    .filter((message) => messageDelegationId(message) === delegationId)
    .filter((message) => ['user', 'assistant', 'system'].includes(String(message.role || '')))
    .filter((message) => {
      const metadata = message.metadata || {};
      const key = String(message.sourceEventId || message.source_event_id || message.sourceGroupMessageId || message.source_group_message_id || metadata.sourceEventId || metadata.source_event_id || metadata.sourceGroupMessageId || metadata.source_group_message_id || metadata.localMessageId || message.id || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => new Date(left.createdAt || left.created_at || 0).getTime() - new Date(right.createdAt || right.created_at || 0).getTime());
}

function delegationPublishCandidate(messages = [], delegation = {}) {
  const lastUserIndex = messages.findLastIndex((item) => item.role === 'user');
  const publishable = messages
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => index > lastUserIndex && item.role === 'assistant');
  const candidate = publishable.at(-1);
  const message = candidate?.item;
  if (!message) return null;
  const metadata = message.metadata || {};
  const publishedMessageId = publishedWorkspaceMessageId(delegation);
  return {
    messageId: message.id || '',
    revisionId: metadata.revisionId || metadata.revision_id || metadata.revisionNo || metadata.revision_no || message.id || '',
    content: message.content || '',
    relatedMessageIds: messages.slice((candidate?.index || 0) + 1).filter((item) => item.role === 'system' && item.metadata?.generatedTaskFiles).map((item) => item.id),
    published: Boolean(message.id && publishedMessageId === message.id),
  };
}

function publishedWorkspaceMessageId(delegation = {}) {
  return String(
    state.networkDelegationPublishedMessages?.[delegation.id]
    || delegation.metadata?.sourceWorkspaceMessageId
    || delegation.metadata?.publishedWorkspaceMessageId
    || delegation.metadata?.submittedWorkspaceMessageId
    || '',
  );
}

function workspaceMessageVisibility(message = {}, delegation = {}, publishCandidate = null) {
  const metadata = message.metadata || {};
  if (metadata.publishedToGroup || metadata.sharedToGroup || (message.id && publishedWorkspaceMessageId(delegation) === message.id)) return { label: '已发布到群聊', tone: 'published' };
  if (publishCandidate?.messageId === message.id || publishCandidate?.relatedMessageIds?.includes(message.id)) return { label: publishCandidate.published ? '已发布到群聊' : '待确认发布', tone: publishCandidate.published ? 'published' : 'pending' };
  return { label: '仅自己可见', tone: 'private' };
}

function renderDelegationWorkflow(status = 'assigned') {
  const steps = [
    ['assigned', '已派发'],
    ['running', '处理中'],
    ['draft_ready', '待交付'],
    ['submitted', '已交付'],
    ['result_accepted', '已验收'],
  ];
  const order = steps.map(([value]) => value);
  const statusAliases = { preparing: 'assigned', accepted: 'assigned', working: 'running', revision_requested: 'running', completed: 'submitted' };
  const effectiveStatus = statusAliases[status] || (['failed', 'blocked'].includes(status) ? 'running' : status === 'rejected' ? 'assigned' : status);
  const currentIndex = Math.max(0, order.indexOf(effectiveStatus));
  return steps.map(([value, label], index) => `
    <span class="${index < currentIndex ? 'done' : index === currentIndex ? 'active' : ''}"><i>${index < currentIndex ? '✓' : index + 1}</i><em>${label}</em></span>
  `).join('');
}

function renderDelegationDecisionActions(delegation = {}, { isRecipient = false, busy = false, publishCandidate = null, decisionAction = '' } = {}) {
  const status = String(delegation.status || 'assigned');
  if (busy) return `<div class="network-delegation-waiting">uBuddy 正在处理任务，进度会持续同步到任务群。</div>${isRecipient && publishCandidate ? `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-submit data-delegation-publish-draft="${escapeAttr(publishCandidate.messageId)}" data-delegation-revision-id="${escapeAttr(publishCandidate.revisionId)}" data-delegation-id="${escapeAttr(delegation.id)}" disabled>处理中，暂不可交付</button></div>` : ''}`;
  if (!isRecipient) {
    if (status === 'submitted') {
      const pending = Boolean(decisionAction);
      const acceptLabel = decisionAction === 'accept_result' ? '确认中…' : '确认任务结束';
      const revisionLabel = decisionAction === 'request_revision' ? '同步中…' : '打回重做';
      return `<div class="network-delegation-actions" aria-busy="${pending ? 'true' : 'false'}"><button class="btn primary" type="button" data-collaboration-task-action="accept_result" data-delegation-id="${escapeAttr(delegation.id)}" ${pending ? 'disabled' : ''}>${acceptLabel}</button><button class="btn secondary" type="button" data-collaboration-task-action="request_revision" data-delegation-id="${escapeAttr(delegation.id)}" ${pending ? 'disabled' : ''}>${revisionLabel}</button></div>`;
    }
    return '';
  }
  if (publishCandidate && ['working', 'running', 'draft_ready', 'revision_requested', 'blocked'].includes(status)) {
    return `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-submit data-delegation-publish-draft="${escapeAttr(publishCandidate.messageId || '')}" data-delegation-revision-id="${escapeAttr(publishCandidate.revisionId || '')}" data-delegation-id="${escapeAttr(delegation.id)}">${status === 'blocked' ? '重新交付' : '确认并交付到任务群'}</button><button class="btn secondary" type="button" data-delegation-continue-editing="${escapeAttr(delegation.id)}">继续修改</button></div>`;
  }
  if (status === 'accepted') return `<div class="network-delegation-actions">
    <p class="network-delegation-permission-note">当前任务默认使用完全开放模式。你可以选择 AI 自动审查；实际权限只在你的设备上生效。</p>
    <button class="btn primary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="full-access" data-delegation-id="${escapeAttr(delegation.id)}">完全开放执行</button>
    <button class="btn secondary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="auto-approve" data-delegation-id="${escapeAttr(delegation.id)}">AI 自动审查</button>
    <button class="btn secondary danger" type="button" data-agent-delegation-respond="reject" data-delegation-id="${escapeAttr(delegation.id)}">拒绝</button>
  </div>`;
  if (status === 'awaiting_approval') return `<div class="network-delegation-actions">
    <p class="network-delegation-permission-note">当前任务默认使用完全开放模式。你可以选择 AI 自动审查；实际权限只在你的设备上生效。</p>
    <button class="btn primary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="full-access" data-delegation-id="${escapeAttr(delegation.id)}">完全开放执行</button>
    <button class="btn secondary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="auto-approve" data-delegation-id="${escapeAttr(delegation.id)}">AI 自动审查</button>
    <button class="btn secondary danger" type="button" data-agent-delegation-respond="reject" data-delegation-id="${escapeAttr(delegation.id)}">拒绝</button>
  </div>`;
  if (status === 'draft_ready') return `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-submit data-delegation-publish-draft="${escapeAttr(publishCandidate?.messageId || '')}" data-delegation-revision-id="${escapeAttr(publishCandidate?.revisionId || '')}" data-delegation-id="${escapeAttr(delegation.id)}" disabled>正在同步可交付结果</button><button class="btn secondary" type="button" data-delegation-continue-editing="${escapeAttr(delegation.id)}">继续修改</button></div>`;
  if (['blocked', 'failed'].includes(status)) {
    if (status === 'blocked' && delegation.metadata?.clarification?.question) return '';
    const deliveryFailure = String(delegation.metadata?.publicFailure?.stage || delegation.metadata?.failureStage || '').startsWith('delivery');
    if (deliveryFailure && publishCandidate) return `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-submit data-delegation-publish-draft="${escapeAttr(publishCandidate.messageId)}" data-delegation-revision-id="${escapeAttr(publishCandidate.revisionId)}" data-delegation-id="${escapeAttr(delegation.id)}">重新交付</button></div>`;
    const failureCode = String(delegation.metadata?.failureCode || delegation.metadata?.publicFailure?.code || '');
    if (failureCode === 'ppt_skill_install_required') {
      return state.pptxPluginStatus?.installed
        ? `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-respond="accept" data-delegation-id="${escapeAttr(delegation.id)}">Skill 已安装，重新调度 Agent</button></div>`
        : `<div class="network-delegation-actions"><button class="btn primary" type="button" data-plugin-install="ppt_creation" data-plugin-agent-family="ppt">${iconSvg('download')}<span>安装 PPT 制作 Skill</span></button><button class="btn secondary" type="button" data-open-plugin-settings data-plugin-id="ppt_creation" data-plugin-agent-family="ppt">查看 Skill</button></div>`;
    }
    return `<div class="network-delegation-actions"><button class="btn primary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="full-access" data-delegation-id="${escapeAttr(delegation.id)}">完全开放重试</button><button class="btn secondary" type="button" data-agent-delegation-respond="accept" data-delegation-permission="auto-approve" data-delegation-id="${escapeAttr(delegation.id)}">AI 自动审查</button></div>`;
  }
  return '';
}

export function isUBuddyConversationMessage(message = {}) {
  const metadata = message.metadata || {};
  return message.kind === 'agent'
    || Boolean(message.senderAgentId || message.sender_agent_id)
    || Boolean(metadata.delegationId || metadata.delegation_id || metadata.agentDelegationId)
    || metadata.type === 'agent_delegation';
}

function messageDelegationId(message = {}) {
  const metadata = message.metadata || {};
  return message.delegationId || message.delegation_id || metadata.delegationId || metadata.delegation_id || metadata.agentDelegationId || '';
}

function delegationStatusText(status = '') {
  const labels = {
    assigned: '等待对方 uBuddy 接收',
    accepted: '已接收',
    running: '处理中',
    completed: '已完成',
    draft_ready: '初稿已就绪',
    submitted: '等待验收',
    revision_requested: '需要修改',
    result_accepted: '结果已接受',
    closed: '任务已关闭',
    failed: '处理失败',
    rejected: '已拒绝',
  };
  return labels[status] || 'uBuddy 委托';
}

function networkMessageItems() {
  const currentUserId = state.currentUser?.id || '';
  return safeArray(state.socialThreads)
    .flatMap((thread) => {
      const friend = thread.friend || {};
      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const groups = socialTaskGroups(messages);
      if (!groups.length) {
        const last = messages.at(-1) || {};
        return messages.length ? [networkMessageItemForMessages({ friend, messages, last, currentUserId, group: null })] : [];
      }
      return groups.map((group) => {
        const groupMessages = messagesForSocialTaskGroup(messages, group);
        return networkMessageItemForMessages({ friend, messages: groupMessages, last: group.lastMessage || groupMessages.at(-1) || {}, currentUserId, group });
      });
    })
    .filter((item) => item.peerId)
    .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())
    .slice(0, 24);
}

function networkMessageItemForMessages({ friend = {}, messages = [], last = {}, currentUserId = '', group = null } = {}) {
  const senderId = last.senderUserId || last.sender_user_id || '';
  const agentMessage = isUBuddyConversationMessage(last);
  const actor = senderId === currentUserId
    ? ''
    : agentMessage ? `${displayUserName(friend)} 的 uBuddy` : displayUserName(friend);
  const unreadCount = messages.filter((message) => (
    (message.recipientUserId || message.recipient_user_id) === currentUserId
    && message.status !== 'read' && !message.readAt && !message.read_at
  )).length;
  return {
    id: group?.id || `thread-${friend.id}`,
    peerId: friend.id,
    groupId: group?.id || '',
    ended: Boolean(group?.dissolved),
    icon: group?.dissolved ? 'archive' : agentMessage ? 'network' : 'message',
    tone: unreadCount ? 'blue' : group?.dissolved ? 'muted' : 'blue',
    title: group?.title || displayUserName(friend),
    sender: actor,
    conversationType: group ? '群聊' : '私聊',
    kind: group ? `${displayUserName(friend)} · ${group.dissolved ? '已结束' : '进行中'}` : '普通聊天',
    preview: last.content || last.title || '',
    time: group?.updatedAt || last.updatedAt || last.updated_at || last.createdAt || last.created_at,
    unread: unreadCount > 0,
    unreadCount,
  };
}

function delegationById(delegationId = '') {
  const cleanId = String(delegationId || '').trim();
  if (!cleanId) return null;
  return allDelegationTasks().find((item) => item.id === cleanId) || null;
}

function delegationStatusLabel(delegation = {}, isRecipient = false) {
  const status = String(delegation.status || 'assigned');
  if (status === 'completed') return '结果已提交';
  if (status === 'preparing') return 'uBuddy 正在处理';
  if (status === 'awaiting_approval') return '等待安全准备确认';
  if (status === 'draft_ready') return isRecipient ? '等待我确认交付' : '等待对方确认交付';
  if (status === 'working') return '调整处理中';
  if (status === 'submitted') return isRecipient ? '等待发起人验收' : '待我验收';
  if (status === 'revision_requested') return isRecipient ? '需要继续修改' : '等待重新提交';
  if (status === 'result_accepted') return isRecipient ? '发出方已确认任务结束' : '任务已确认结束';
  if (status === 'blocked') return '任务受阻';
  if (status === 'declined') return '已拒绝';
  if (status === 'withdrawn') return '已撤回';
  if (status === 'closed') return '任务已关闭';
  if (status === 'rejected') return '已拒绝';
  if (status === 'failed') return '任务执行失败';
  if (status === 'accepted') return isRecipient ? 'uBuddy 准备初稿' : '对方 uBuddy 准备初稿';
  if (status === 'running') return isRecipient ? '处理中' : '对方处理中';
  if (status === 'assigned') return isRecipient ? 'uBuddy 接收中' : '等待对方 uBuddy 接收';
  return status;
}

function renderNetworkMessageItem(item) {
  return `
    <button class="network-message-item im-conversation-item ${item.ended ? 'is-ended' : ''} ${item.tone ? `tone-${escapeAttr(item.tone)}` : ''} ${item.unread ? 'is-unread' : ''} ${!state.networkMessageHomeOpen && state.networkConversationPeerId === item.peerId && String(state.networkConversationGroupId || '') === String(item.groupId || '') ? 'active' : ''}" type="button" data-network-peer="${escapeAttr(item.peerId || '')}" data-network-group="${escapeAttr(item.groupId || '')}" data-network-mode="group" data-conversation-kind="group-chat" data-unread-count="${escapeAttr(formatConversationUnreadCount(item.unreadCount))}" aria-label="群聊 ${escapeAttr(item.title || '')}" ${conversationSearchAttributes(`${item.title || ''} 群聊 ${item.sender || ''} ${item.preview || ''} ${item.ended ? '已结束' : '进行中'}`)}>
      <span class="network-message-avatar">${iconSvg(item.icon || 'message')}</span>
      <span class="network-message-main">
        <span class="network-message-line">
          <span class="im-conversation-title-line"><strong>${escapeHtml(item.title)}</strong><b class="im-conversation-badge is-group">群聊</b></span>
          <time>${escapeHtml(formatMessageTime(item.time))}</time>
        </span>
        <span class="network-message-preview">${item.sender ? `<span class="im-conversation-preview-prefix">${escapeHtml(item.sender)} · </span>` : ''}${escapeHtml(clipInline(item.preview || '暂无消息', 76))}</span>
      </span>
    </button>
  `;
}

function renderFriendsNetworkView() {
  const overview = state.friendOverview || {};
  const friends = contactDirectoryRelationships(overview);
  const requests = overview.requests && typeof overview.requests === 'object' ? overview.requests : {};
  const incoming = safeArray(requests.incoming).length;
  const outgoing = safeArray(requests.outgoing).length;
  const searchActive = Boolean(normalizeConversationSearch(state.friendSearchQuery));
  const activeCategory = state.friendDirectoryView === 'requests' ? 'new' : normalizeContactCategory(state.friendDirectoryCategory);
  const organization = currentDirectoryOrganization();
  const activeOrganizationId = state.activeAccountWorkspace?.kind === 'organization' ? state.activeAccountWorkspace.organizationId : '';
  const startupOrganizationId = state.startupAccountWorkspace?.kind === 'organization' ? state.startupAccountWorkspace.organizationId : '';
  const organizationHelper = organization
    ? organization.id === activeOrganizationId && organization.id === startupOrganizationId
      ? '当前组织 · 默认组织'
      : organization.id === activeOrganizationId
        ? '当前组织'
        : organization.id === startupOrganizationId
          ? '默认组织'
          : '组织'
    : '前往创建、加入或设置组织';
  const internalCount = safeArray(organization?.members).filter((item) => item?.user?.id).length;
  const internalIds = new Set(safeArray(organization?.members).map((item) => String(item?.user?.id || '')));
  const externalCount = friends.filter((item) => !internalIds.has(String(item?.friend?.id || item?.user?.id || ''))).length;
  return `
    <section class="network-content network-friends im-directory-nav" role="navigation" aria-label="通讯录目录" data-preserve-scroll data-scroll-key="network-panel:friends" data-contact-directory-context>
      <div class="directory-add-search">
        <label>${iconSvg('search')}<input id="friend-search-query" type="search" role="searchbox" value="${escapeAttr(state.friendSearchQuery || '')}" placeholder="搜索通讯录" autocomplete="off" enterkeyhint="search" aria-label="搜索通讯录" /></label>
        <button type="button" data-contact-add-open="contact">${iconSvg('userPlus')}<span>添加</span></button>
      </div>
      ${searchActive ? renderContactDirectorySearchResults(friends) : `
        <button class="im-directory-organization ${activeCategory === 'organizations' ? 'active' : ''}" type="button" data-account-organization-action="manage" title="管理组织"><span class="im-directory-organization-avatar">${escapeHtml((organization?.name || '组').slice(0, 1))}</span><span><strong>${escapeHtml(organization?.name || '尚未加入组织')}</strong><small>${escapeHtml(organizationHelper)}</small></span>${iconSvg('chevronRight')}</button>
        ${renderContactNavItem('internal', '组织内联系人', `${internalCount} 位成员`, 'network', activeCategory)}
        ${renderContactNavItem('external', '外部联系人', `${externalCount} 位联系人`, 'users', activeCategory)}
        ${renderContactNavItem('new', '新的联系人', incoming ? `${incoming} 条申请等待处理` : outgoing ? `${outgoing} 条申请等待验证` : '查看联系人申请', 'userPlus', activeCategory, incoming)}
        ${renderContactNavItem('starred', '星标联系人', `${starredContacts(friends).length} 位联系人`, 'star', activeCategory)}
        ${renderContactNavItem('groups', '我的群组', `${chatGroupItems().filter((group) => !group.archived).length + collaborationGroupItems().filter((group) => !group.archived).length} 个群组`, 'users', activeCategory)}
      `}
    </section>
  `;
}

function renderContactDirectorySearchResults(friends = []) {
  const internal = contactsForCategory(friends, 'internal').filter((item) => directoryTextMatchesSearch(contactSearchText(item)));
  const external = contactsForCategory(friends, 'external').filter((item) => directoryTextMatchesSearch(contactSearchText(item)));
  const contactGroups = contactGroupEntries('contact').filter(directoryEntryMatchesSearch);
  const workGroups = contactGroupEntries('work').filter(directoryEntryMatchesSearch);
  const organizations = safeArray(state.friendOverview?.organizations)
    .filter((organization) => directoryTextMatchesSearch(organizationSearchText(organization)));
  const categories = [
    ['internal', '组织内联系人', internal, renderFriendRow],
    ['external', '外部联系人', external, renderFriendRow],
    ['contact-groups', '联系人群聊', contactGroups, renderDirectoryGroupRow],
    ['work-groups', '工作群组', workGroups, renderDirectoryGroupRow],
    ['organizations', '组织', organizations, renderOrganizationCard],
  ].filter(([, , items]) => items.length);
  const total = categories.reduce((count, [, , items]) => count + items.length, 0);
  return `<div class="directory-global-search-results" aria-live="polite">
    <header><strong>搜索结果</strong><span>${total} 项</span></header>
    ${categories.map(([key, label, items, renderer]) => `<section class="directory-search-category" data-directory-search-category="${escapeAttr(key)}">
      <h3><span>${escapeHtml(label)}</span><small>${items.length}</small></h3>
      <div>${items.map((item) => renderer(item)).join('')}</div>
    </section>`).join('') || '<div class="directory-search-no-results">没有匹配的联系人、群聊或组织</div>'}
  </div>`;
}

function renderContactNavItem(category, label, helper, icon, activeCategory, badge = 0) {
  const active = activeCategory === category;
  return `<button class="im-directory-nav-item ${active ? 'active' : ''}" type="button" data-friend-directory-category="${escapeAttr(category)}" aria-pressed="${active ? 'true' : 'false'}">
    <span class="im-directory-nav-icon tone-blue">${iconSvg(icon)}</span>
    <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(helper)}</small></span>
    ${badge ? `<em class="im-directory-nav-badge" aria-label="${badge} 条待处理联系人申请">${badge > 99 ? '99+' : badge}</em>` : ''}
  </button>`;
}

export function renderContactsWorkspace() {
  const overview = state.friendOverview || {};
  const friends = contactDirectoryRelationships(overview);
  const category = state.friendDirectoryView === 'requests' ? 'new' : normalizeContactCategory(state.friendDirectoryCategory);
  const activePane = ['directory', 'employees'].includes(state.contactsActivePane) ? state.contactsActivePane : 'contacts';
  const contactsTabActive = activePane === 'contacts'
    || (activePane === 'directory' && state.responsiveLayoutMode !== 'single');
  return `
    <section class="contacts-workspace" style="--contacts-list-percent:${Number(state.contactsListRatio || 0.38) * 100}%" data-active-pane="${escapeAttr(activePane)}" role="region" aria-label="通讯录工作区">
      <nav class="contacts-workspace-tabs" aria-label="通讯录内容切换">
        <button type="button" data-contacts-pane="directory" class="contacts-directory-tab ${activePane === 'directory' ? 'active' : ''}" aria-pressed="${activePane === 'directory' ? 'true' : 'false'}">通讯录</button>
        <button type="button" data-contacts-pane="contacts" class="${contactsTabActive ? 'active' : ''}" aria-pressed="${contactsTabActive ? 'true' : 'false'}">联系人</button>
        <button type="button" data-contacts-pane="employees" class="${activePane === 'employees' ? 'active' : ''}" aria-pressed="${activePane === 'employees' ? 'true' : 'false'}">我的员工</button>
      </nav>
      <div class="contacts-workspace-columns">
        ${category === 'new' ? renderFriendRequestsPane() : renderContactsListPane(friends, category)}
        <div class="contacts-pane-resizer" role="separator" aria-orientation="vertical" aria-label="调整联系人与员工列表宽度" aria-valuemin="18" aria-valuemax="72" aria-valuenow="${Math.round(Number(state.contactsListRatio || 0.38) * 100)}" tabindex="0" data-contacts-pane-resizer></div>
        ${renderContactsEmployeesPane()}
      </div>
      ${renderContactAddDialog()}
      ${renderContactDirectoryContextMenu()}
      ${renderOrganizationActionDialog()}
      ${renderOrganizationInvitePrompt()}
      ${renderChatGroupCreateDialog()}
      ${state.networkContactProfileOpen ? renderContactProfileDialog(friends) : ''}
    </section>
  `;
}

function renderContactsListPane(friends = [], category = 'all') {
  if (category === 'organizations') return renderOrganizationsPane();
  if (category === 'groups') return renderContactGroupsPane();
  if (category === 'internal') {
    const organizations = safeArray(state.friendOverview?.organizations);
    const selected = selectedDirectoryOrganization(organizations);
    if (selected) return renderSelectedOrganizationPane(selected);
  }
  const categorized = contactsForCategory(friends, category);
  const visibleFriends = categorized.filter((item) => directoryTextMatchesSearch(contactSearchText(item))).length;
  const directorySearchActive = Boolean(normalizeConversationSearch(state.friendSearchQuery));
  const error = String(state.friendDirectoryError || '').trim();
  const emptyText = directorySearchActive
    ? '没有匹配的联系人，可以按 Enter 查找新用户'
      : category === 'starred'
        ? '暂无星标联系人'
        : category === 'internal'
          ? '当前组织暂无其他成员'
          : category === 'external'
            ? '暂无外部联系人'
        : '暂无联系人';
  return `<section class="contacts-list-pane" aria-label="${escapeAttr(contactCategoryLabel(category))}">
    ${renderContactsPaneHeader(contactCategoryLabel(category), `${categorized.length} 位`)}
    <div class="contacts-list-scroll" data-preserve-scroll data-scroll-key="contacts-list:${escapeAttr(category)}" data-contact-directory-context>
      <div class="network-friend-list im-directory-list contacts-plain-list" id="network-directory-contacts">
        ${categorized.map((item) => renderFriendRow(item)).join('')}
        ${error && !categorized.length
          ? renderContactsLoadError(error)
          : visibleFriends
            ? ''
            : `<div class="im-list-empty im-contact-empty" role="status" aria-live="polite" data-directory-empty="contacts">${emptyText}</div>`}
      </div>
    </div>
  </section>`;
}

function renderOrganizationsPane() {
  const organizations = safeArray(state.friendOverview?.organizations);
  const organization = selectedDirectoryOrganization(organizations);
  if (!organization) return `<section class="contacts-list-pane contacts-organizations-pane organization-settings-pane" aria-label="当前组织设置">
    ${renderContactsPaneHeader('当前组织', '尚未加入')}
    <div class="contacts-list-scroll organization-settings-scroll">
      <div class="organization-settings-empty">${iconSvg('building')}<strong>尚未加入组织</strong><span>创建或加入组织后，可在这里查看组织号、管理邀请码并设置默认组织。</span><div><button class="btn secondary" type="button" data-contact-add-open="join-organization">加入组织</button><button class="btn primary" type="button" data-contact-add-open="create-organization">创建组织</button></div></div>
    </div>
  </section>`;
  return renderOrganizationSettingsPane(organization, organizations);
}

function selectedDirectoryOrganization(organizations = safeArray(state.friendOverview?.organizations)) {
  const selectedId = state.contactsSelectedOrganizationId || currentDirectoryOrganization()?.id || '';
  return organizations.find((item) => String(item.id || '') === String(selectedId || '')) || organizations[0] || null;
}

function accountWorkspaceForOrganization(organization = {}) {
  return safeArray(state.accountWorkspaces).find((workspace) => workspace?.kind === 'organization'
    && String(workspace.organizationId || workspace.organization_id || '') === String(organization.id || '')) || null;
}

function orderedOrganizationSettingsWorkspaces(selectedOrganization = {}, organizations = []) {
  const selectedId = String(selectedOrganization.id || '');
  const organizationById = new Map(safeArray(organizations)
    .filter((organization) => String(organization?.id || '') !== selectedId)
    .map((organization) => [String(organization.id || ''), organization]));
  const workspaceById = new Map(safeArray(state.accountWorkspaces)
    .filter((workspace) => workspace?.kind === 'organization' && workspace.id)
    .map((workspace) => [String(workspace.id), workspace]));
  const recentIds = [
    state.activeAccountWorkspace?.kind === 'organization' ? state.activeAccountWorkspace.id : '',
    ...safeArray(state.recentAccountWorkspaceIds),
  ];
  const ordered = [];
  new Set(recentIds).forEach((workspaceId) => {
    const workspace = workspaceById.get(String(workspaceId || ''));
    const organizationId = String(workspace?.organizationId || workspace?.organization_id || '');
    const organization = organizationById.get(organizationId);
    if (!organization) return;
    ordered.push(organization);
    organizationById.delete(organizationId);
  });
  ordered.push(...organizationById.values());
  return ordered;
}

function renderOrganizationSettingsWorkspaceOption(organization = {}, location = 'primary') {
  const workspace = accountWorkspaceForOrganization(organization);
  return `<button type="button" data-account-workspace-id="${escapeAttr(workspace?.id || '')}"
    data-organization-settings-workspace-location="${escapeAttr(location)}" ${workspace ? '' : 'disabled'}>
    <span class="contacts-organization-avatar">${iconSvg('building')}</span>
    <span><strong>${escapeHtml(organization.name || '未命名组织')}</strong><small>${escapeHtml(organization.organizationNumber || '')}</small></span>
    ${iconSvg('chevronRight')}
  </button>`;
}

function renderOrganizationSettingsPane(organization = {}, organizations = []) {
  const workspace = accountWorkspaceForOrganization(organization);
  const active = String(state.activeAccountWorkspace?.organizationId || '') === String(organization.id || '');
  const startup = String(state.startupAccountWorkspace?.organizationId || '') === String(organization.id || '');
  const shareLink = String(state.organizationShareLinks?.[organization.id] || '').trim();
  const storedInvitationCode = shareLink ? String(parseOrganizationInviteLink(shareLink)?.verificationCode || '') : '';
  const role = translateUiText(organization.role === 'owner' ? '创建者' : organization.role === 'admin' ? '管理员' : '成员', state.languageMode);
  const orderedOrganizations = orderedOrganizationSettingsWorkspaces(organization, organizations);
  const recentOrganizations = orderedOrganizations.slice(0, 3);
  const otherOrganizations = orderedOrganizations.slice(3);
  const morePosition = state.organizationSettingsWorkspaceMorePosition || {};
  const organizationNameDraft = String(state.organizationNameEditDraft || organization.name || '');
  const organizationNameEditSize = Math.max(8, Math.min(24, Array.from(organizationNameDraft).length + 2));
  return `<section class="contacts-list-pane contacts-organizations-pane organization-settings-pane" aria-label="当前组织设置">
    ${renderContactsPaneHeader('当前组织', '组织设置')}
    <div class="contacts-list-scroll organization-settings-scroll" data-preserve-scroll data-scroll-key="contacts-list:organization-settings">
      ${renderOrganizationNotices()}
      <section class="organization-settings-hero">
        <span class="organization-settings-avatar">${escapeHtml((organization.name || '组').slice(0, 1))}</span>
        <div class="organization-settings-hero-main">${state.organizationNameEditId === organization.id
          ? `<form class="organization-name-edit-form" data-organization-name-form="${escapeAttr(organization.id || '')}" style="--organization-name-edit-size:${organizationNameEditSize}"><input data-organization-name-input size="${organizationNameEditSize}" value="${escapeAttr(organizationNameDraft)}" maxlength="60" aria-label="组织名称" /><button type="submit" class="organization-name-edit-save" title="保存组织名称" aria-label="保存组织名称" ${state.organizationNameEditBusy ? 'disabled' : ''}>${iconSvg('check')}</button><button type="button" class="organization-name-edit-cancel" data-organization-name-cancel title="取消编辑" aria-label="取消编辑" ${state.organizationNameEditBusy ? 'disabled' : ''}>${iconSvg('x')}</button></form>`
          : `<div class="organization-name-display"><strong data-organization-name-dblclick="${escapeAttr(organization.id || '')}">${escapeHtml(organization.name || '未命名组织')}</strong>${organization.role === 'owner' ? `<button type="button" class="organization-name-edit-button" data-organization-name-edit="${escapeAttr(organization.id || '')}" title="编辑组织名" aria-label="编辑组织名">${iconSvg('edit')}</button>` : ''}</div>`}<span>${escapeHtml(role)}${active ? ' · 当前使用' : ''}${startup ? ' · 默认组织' : ''}</span></div>
      </section>
      <section class="organization-settings-card" aria-label="组织信息">
        <header><div><strong>组织信息</strong><span>用于识别和邀请成员</span></div></header>
        <div class="organization-settings-row"><span><strong>组织号</strong><small>成员可凭组织号和邀请码加入</small></span><code>${escapeHtml(organization.organizationNumber || '未设置')}</code></div>
        <div class="organization-settings-row"><span><strong>邀请码</strong><small>${storedInvitationCode ? '本机已保存最近生成分享链接中的邀请码' : '为安全起见，邀请码不会从云端明文读取'}</small></span><span class="organization-settings-value">${storedInvitationCode ? `<code>${escapeHtml(storedInvitationCode)}</code>` : '<em>未在本机保存</em>'}<span class="organization-help" tabindex="0" aria-label="邀请码查看说明" title="生成分享链接后，可在本机查看和复制该链接使用的邀请码。">${iconSvg('helpCircle')}<span role="tooltip">生成分享链接后，可在本机查看和复制该链接使用的邀请码；忘记邀请码时可通过邮箱验证重置。</span></span></span></div>
      </section>
      <section class="organization-settings-card" aria-label="邀请与分享">
        <header><div><strong>邀请与分享</strong><span>只把加入凭据发送给可信成员</span></div></header>
        <div class="organization-settings-actions">
          <button type="button" ${shareLink ? `data-organization-share-view="${escapeAttr(organization.id || '')}"` : `data-organization-share-generate="${escapeAttr(organization.id || '')}"`}>${iconSvg('share')}<span><strong>${shareLink ? '查看分享链接' : '生成分享链接'}</strong><small>${shareLink ? '查看邀请码、复制或重新生成' : '验证当前邀请码后生成'}</small></span><span class="organization-help" tabindex="0" aria-label="分享链接说明" title="分享链接包含组织号和邀请码。">${iconSvg('helpCircle')}<span role="tooltip">分享链接包含组织号和邀请码。邀请码修改或重置后，旧链接会立即失效。</span></span></button>
          ${organization.role === 'owner' ? `<button type="button" data-organization-action="update_invitation_code" data-organization-id="${escapeAttr(organization.id || '')}">${iconSvg('edit')}<span><strong>修改邀请码</strong><small>知道当前邀请码时使用</small></span><span class="organization-help" tabindex="0" aria-label="忘记邀请码说明" title="忘记当前邀请码时，可在修改界面转到邮箱重置。">${iconSvg('helpCircle')}<span role="tooltip">忘记当前邀请码？进入后选择“通过账号邮箱验证后重置”。</span></span></button>` : ''}
        </div>
      </section>
      <section class="organization-settings-card" aria-label="组织偏好">
        <header><div><strong>组织偏好</strong><span>切换只影响当前使用；默认组织影响下次启动</span></div></header>
        <div class="organization-settings-row"><span><strong>当前使用</strong><small>${active ? '正在使用这个组织' : '切换后载入该组织的工作内容'}</small></span><button class="btn secondary" type="button" data-account-workspace-id="${escapeAttr(workspace?.id || '')}" ${!workspace || active || state.workspaceSwitchBusy ? 'disabled' : ''}>${active ? '当前组织' : '切换到此组织'}</button></div>
        <div class="organization-settings-row"><span><strong>默认组织</strong><small>Janus 下次启动时自动进入</small></span><button class="btn secondary" type="button" data-organization-set-default="${escapeAttr(workspace?.id || '')}" ${!workspace || startup ? 'disabled' : ''}>${startup ? '已设为默认' : '设为默认组织'}</button></div>
        ${recentOrganizations.length ? `<div class="organization-settings-switch-list"><span>最近使用的组织</span>
          ${recentOrganizations.map((item) => renderOrganizationSettingsWorkspaceOption(item)).join('')}
          ${otherOrganizations.length ? `<button class="organization-settings-workspace-more-toggle" type="button"
            data-organization-settings-workspace-more-toggle data-organization-settings-workspace-more-count="${otherOrganizations.length}"
            aria-haspopup="menu" aria-expanded="${state.organizationSettingsWorkspaceMoreOpen ? 'true' : 'false'}">
            <span class="contacts-organization-avatar">${iconSvg('more')}</span><span><strong>更多组织</strong><small>${otherOrganizations.length}</small></span>${iconSvg('chevronRight')}
          </button>` : ''}
          ${otherOrganizations.length && state.organizationSettingsWorkspaceMoreOpen ? `<div class="organization-settings-workspace-more-submenu" role="menu" aria-label="其他组织"
            style="left:${Number(morePosition.left || 0)}px;top:${Number(morePosition.top || 0)}px">
            <span>其他组织</span>${otherOrganizations.map((item) => renderOrganizationSettingsWorkspaceOption(item, 'more')).join('')}
          </div>` : ''}
        </div>` : ''}
      </section>
    </div>
  </section>`;
}

function renderOrganizationNotices() {
  const notices = safeArray(state.friendOverview?.organizationNotices).filter((item) => !item.read).slice(0, 3);
  if (!notices.length) return '';
  return `<div class="contacts-organization-notices" aria-label="组织提醒">${notices.map((notice) => `<article><span>${iconSvg('bell')}</span><div><strong>${escapeHtml(notice.title || '组织提醒')}</strong><small>${escapeHtml(notice.content || '')}</small></div><button type="button" data-organization-notice-ack="${escapeAttr(notice.id || '')}" data-organization-id="${escapeAttr(notice.organizationId || '')}" aria-label="知道了">${iconSvg('x')}</button></article>`).join('')}</div>`;
}

function renderOrganizationCard(organization = {}) {
  const owner = organizationOwnerUser(organization);
  const ownerLabel = String(owner.id || '') === String(state.currentUser?.id || '') ? '我' : displayUserName(owner);
  return `<button type="button" class="contacts-organization-card" data-directory-search-text="${escapeAttr(normalizeConversationSearch(organizationSearchText(organization)))}" data-organization-id="${escapeAttr(organization.id || '')}" data-organization-open="${escapeAttr(organization.id || '')}">
    <span class="contacts-organization-avatar">${iconSvg('building')}</span>
    <span class="contacts-organization-title"><strong>${escapeHtml(organization.name || '未命名组织')}</strong><small>组织号 ${escapeHtml(organization.organizationNumber || '')}</small><em>创建人：${escapeHtml(ownerLabel || '未知')}</em></span>
    <span class="contacts-organization-summary"><strong>${Number(organization.memberCount || safeArray(organization.members).length)} 人</strong><small>${organization.role === 'owner' ? '我创建的' : organization.role === 'admin' ? '我是管理员' : '已加入'}</small>${iconSvg('chevronRight')}</span>
  </button>`;
}

function organizationOwnerUser(organization = {}) {
  return organization.owner || safeArray(organization.members).find((member) => member.role === 'owner')?.user || {};
}

function renderSelectedOrganizationPane(organization = {}) {
  const members = safeArray(organization.members);
  const contactMembers = members.filter((member) => member?.user?.id);
  const visibleMembers = contactMembers.filter((member) => directoryTextMatchesSearch(contactSearchText({ friend: member.user }))).length;
  const searchActive = Boolean(normalizeConversationSearch(state.friendSearchQuery));
  return `<section class="contacts-list-pane contacts-organizations-pane is-organization-selected" aria-label="组织 ${escapeAttr(organization.name || '')}">
    ${renderSelectedOrganizationHeader(organization)}
    <div class="contacts-list-scroll contacts-organization-scroll" data-preserve-scroll data-scroll-key="contacts-list:organization:${escapeAttr(organization.id || '')}" data-contact-directory-context>
      ${renderOrganizationNotices()}
      <div class="network-friend-list im-directory-list contacts-plain-list contacts-organization-member-list">
        ${contactMembers.map((member) => renderOrganizationMember(member, organization)).join('')}
        ${visibleMembers ? '' : `<div class="im-list-empty im-contact-empty" role="status" aria-live="polite" data-directory-empty="contacts">${searchActive ? '没有匹配的组织联系人' : '该组织暂时没有成员'}</div>`}
      </div>
    </div>
  </section>`;
}

function renderSelectedOrganizationHeader(organization = {}) {
  const contactCount = safeArray(organization.members).filter((member) => member?.user?.id).length;
  return `<header class="contacts-pane-head contacts-organization-detail-head">
    <div class="contacts-organization-heading">
      <h2><span>组织内联系人</span><small>${contactCount} 位</small></h2>
    </div>
  </header>`;
}

function renderOrganizationMember(member = {}, organization = {}) {
  const user = member.user || {};
  const relationship = contactDirectoryRelationships(state.friendOverview || {}).find((item) => String(item?.friend?.id || item?.user?.id || '') === String(user.id || ''));
  const account = user.username ? `@${user.username}` : user.email || '组织联系人';
  const isSelf = String(user.id || '') === String(state.currentUser?.id || '');
  const role = normalizeOrganizationRole(member.role);
  return renderFriendRow(relationship || { friend: user, organizationContact: true }, {
    helper: `${isSelf ? '我 · ' : ''}${organization.name || '组织成员'} · ${account}`,
    organizationId: organization.id || '',
    organizationRole: role,
    roleTag: organizationRoleLabel(role),
  });
}

function organizationSearchText(organization = {}) {
  return `${organization.name || ''} ${organization.organizationNumber || ''} ${safeArray(organization.members).map((member) => {
    const user = member?.user || {};
    return `${displayUserName(user)} ${user.username || ''} ${user.email || ''}`;
  }).join(' ')}`;
}

function renderContactGroupsPane() {
  const tab = state.contactGroupDirectoryTab === 'work' ? 'work' : 'contact';
  const groups = contactGroupEntries(tab);
  const visibleGroups = groups.filter(directoryEntryMatchesSearch).length;
  const searchActive = Boolean(normalizeConversationSearch(state.friendSearchQuery));
  return `<section class="contacts-list-pane contacts-groups-pane" aria-label="我的群组">
    <header class="contacts-pane-head contacts-groups-head"><div><h2>我的群组</h2><span>${groups.length} 个</span></div>${tab === 'contact' ? '<button class="btn primary" type="button" data-chat-group-create-open>创建群聊</button>' : ''}</header>
    <nav class="contacts-group-tabs" aria-label="群组类型"><button type="button" data-contact-group-tab="contact" class="${tab === 'contact' ? 'active' : ''}">联系人群聊</button><button type="button" data-contact-group-tab="work" class="${tab === 'work' ? 'active' : ''}">工作群组</button></nav>
    <div class="contacts-list-scroll" data-preserve-scroll data-scroll-key="contacts-list:groups" data-contact-directory-context>
      <div class="network-friend-list im-directory-list contacts-group-list" id="network-directory-contacts">
        ${groups.map(renderDirectoryGroupRow).join('')}
        ${visibleGroups ? '' : `<div class="im-list-empty im-contact-empty contacts-group-empty" role="status" aria-live="polite" data-directory-empty="contacts"><span>${searchActive ? '没有匹配的群组' : tab === 'contact' ? '暂无联系人群聊' : '暂无工作群组'}</span>${searchActive ? '' : tab === 'contact' ? '<button type="button" data-chat-group-create-open>去创建群聊</button>' : '<button type="button" data-contact-group-ubuddy>用uBuddy开始协作</button>'}</div>`}
      </div>
    </div>
  </section>`;
}

function renderContactsPaneHeader(title, count) {
  return `<header class="contacts-pane-head"><div><h2>${escapeHtml(title)}</h2><span>${escapeHtml(count)}</span></div></header>`;
}

function renderContactsLoadError(error) {
  return `<div class="contacts-state contacts-load-error" role="alert"><strong>加载联系人失败</strong><span>${escapeHtml(error)}</span><button type="button" data-friends-refresh>重新加载</button></div>`;
}

function renderFriendRequestsPane() {
  const overview = state.friendOverview || {};
  const requests = overview.requests && typeof overview.requests === 'object' ? overview.requests : {};
  const incoming = safeArray(requests.incoming);
  const outgoing = safeArray(requests.outgoing);
  return `<section class="contacts-list-pane contact-requests-pane" aria-label="新联系人">
    ${renderContactsPaneHeader('新联系人', incoming.length ? `${incoming.length} 条待处理` : '暂无待处理')}
    <div class="friend-requests-workspace-body" data-preserve-scroll data-scroll-key="contacts-list:requests" data-contact-directory-context>
      ${incoming.length
        ? renderFriendRequestList('收到的申请', incoming, 'incoming')
        : `<section class="friend-request-group"><h2>收到的申请</h2><div class="friend-request-empty">暂无待处理的联系人申请</div></section>`}
      ${outgoing.length ? renderFriendRequestList('发出的申请', outgoing, 'outgoing') : ''}
    </div>
  </section>`;
}

function renderContactsEmployeesPane() {
  const roster = safeArray(state.employeeOverview?.roster)
    .filter((item) => item
      && item.agentFamilyId !== 'secretary_agent'
      && employeeRouteEligibleForChat(item))
    .sort(compareContactEmployees);
  const loading = !state.employeeOverview && !state.employeeOverviewError;
  const error = String(state.employeeOverviewError || '').trim();
  return `<section class="contacts-employees-pane" aria-label="我的员工" aria-busy="${state.employeeRefreshBusy ? 'true' : 'false'}">
    <header class="contacts-pane-head contacts-employees-head"><div><h2>我的员工</h2><span>${roster.length} 位</span></div></header>
    <div class="contacts-employees-scroll" data-preserve-scroll data-scroll-key="contacts-list:employees">
      <div class="contacts-employee-grid">
        ${roster.map(renderContactsEmployeeCard).join('')}
      </div>
      ${roster.length ? '' : loading
        ? '<div class="contacts-state" role="status">正在加载员工状态…</div>'
        : error
          ? `<div class="contacts-state contacts-load-error" role="alert"><strong>员工状态暂不可用</strong><span>${escapeHtml(error)}</span><button type="button" data-employees-refresh>重新加载</button></div>`
          : '<div class="contacts-state" role="status">暂无已招募员工</div>'}
    </div>
  </section>`;
}

function renderContactsEmployeeCard(item = {}, index = 0) {
  const name = agentInstanceDisplayNameForUi(item, item.family?.name || item.agentFamilyId || '专业 Agent');
  const status = agentWorkStatusFor(state, item);
  const starred = employeeIsStarred(item.id);
  const department = messageDepartmentLabel(item.family?.departmentId || item.departmentId || item.department_id || '');
  const statusLabel = translateUiText(status.availability === 'working' ? '工作中' : '空闲', state.languageMode);
  const starredLabel = starred ? translateUiText('已星标', state.languageMode) : '';
  const interactionHint = state.languageMode === 'en'
    ? 'click for details, double-click to chat, right-click to manage'
    : '单击查看详情，双击开始聊天，右键管理';
  const titleHintSeparator = state.languageMode === 'en' ? '; ' : '；';
  const ariaSeparator = state.languageMode === 'en' ? ', ' : '，';
  const chatLabel = state.languageMode === 'en' ? `Chat with ${name}` : `与 ${name} 对话`;
  return `<article class="contacts-employee-card tone-${agentAvatarTone(item.agentFamilyId, name)} ${starred ? 'is-starred' : ''}" data-contacts-employee-card="${escapeAttr(item.id || '')}" role="button" tabindex="0" title="${escapeAttr(`${name} · ${statusLabel}${starredLabel ? ` · ${starredLabel}` : ''}${titleHintSeparator}${interactionHint}`)}" aria-label="${escapeAttr(`${name}${ariaSeparator}${statusLabel}${starredLabel ? `${ariaSeparator}${starredLabel}` : ''}${titleHintSeparator}${interactionHint}`)}">
    <span class="contacts-employee-avatar">${renderAgentAvatarContent(item.agentFamilyId, name)}</span>
    <span class="contacts-employee-copy"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(department)}</small>${renderAgentWorkStatus(status)}</span>
    <button class="contacts-employee-chat-button" type="button" data-contacts-employee-chat="${escapeAttr(item.id || '')}" title="${escapeAttr(chatLabel)}" aria-label="${escapeAttr(chatLabel)}">
      ${iconSvg('message')}
    </button>
    ${starred ? `<span class="contacts-employee-star" title="已设为星标员工" aria-label="已设为星标员工">${iconSvg('star')}</span>` : ''}
  </article>`;
}

function employeeIsStarred(agentInstanceId = '') {
  const id = String(agentInstanceId || '').trim();
  return Boolean(id && safeArray(state.directoryStars?.employees).includes(id));
}

function compareContactEmployees(left = {}, right = {}) {
  const leftInactive = Number(['inactive', 'conflict'].includes(String(left.employmentState || '')));
  const rightInactive = Number(['inactive', 'conflict'].includes(String(right.employmentState || '')));
  const leftName = left.family?.name || left.agentFamilyId || '';
  const rightName = right.family?.name || right.agentFamilyId || '';
  return leftInactive - rightInactive || leftName.localeCompare(rightName, 'zh-CN');
}

function normalizeContactCategory(value = '') {
  return ['internal', 'external', 'starred', 'groups', 'organizations'].includes(value) ? value : 'internal';
}

function contactCategoryLabel(category = 'all') {
  return ({ internal: '组织内联系人', external: '外部联系人', starred: '星标联系人', groups: '我的群组', organizations: '组织管理' })[category] || '组织内联系人';
}

function contactsForCategory(friends = [], category = 'all') {
  if (category === 'starred') return starredContacts(friends);
  const organization = currentDirectoryOrganization();
  const members = safeArray(organization?.members).filter((item) => item?.user?.id);
  const internalIds = new Set(members.map((item) => String(item.user.id)));
  if (category === 'internal') {
    const relationships = new Map(safeArray(friends).map((item) => [String(item?.friend?.id || item?.user?.id || ''), item]));
    return members.map((member) => relationships.get(String(member.user.id))
      || organizationMemberRelationship(member, String(state.currentUser?.id || '')))
      .sort(compareContacts);
  }
  if (category === 'external') return safeArray(friends)
    .filter((item) => {
      const userId = String(item?.friend?.id || item?.user?.id || '');
      return userId && userId !== String(state.currentUser?.id || '') && !internalIds.has(userId);
    }).sort(compareContacts);
  return [...safeArray(friends)].sort(compareContacts);
}

function currentDirectoryOrganization() {
  const organizationId = state.activeAccountWorkspace?.organizationId || state.activeAccountWorkspace?.organization_id
    || state.startupAccountWorkspace?.organizationId || state.startupAccountWorkspace?.organization_id || '';
  return safeArray(state.friendOverview?.organizations).find((item) => String(item.id || '') === String(organizationId || ''))
    || safeArray(state.friendOverview?.organizations)[0] || null;
}

function recentContacts(friends = []) {
  const recentById = new Map(directMessageItems().map((entry) => [
    String(entry.friend?.id || ''),
    messageTimeValue(entry.last?.updatedAt || entry.last?.createdAt),
  ]));
  return safeArray(friends)
    .filter((item) => recentById.has(String(item?.friend?.id || item?.user?.id || '')))
    .sort((left, right) => recentById.get(String(right?.friend?.id || right?.user?.id || ''))
      - recentById.get(String(left?.friend?.id || left?.user?.id || '')));
}

function starredContacts(friends = []) {
  return safeArray(friends).filter(contactIsStarred).sort(compareContacts);
}

function contactLegacyStarred(item = {}) {
  const friend = item?.friend || item?.user || {};
  return Boolean(item.starred || item.favorite || item.favourite || item.pinned
    || friend.starred || friend.favorite || friend.favourite || friend.pinned);
}

function contactIsStarred(item = {}) {
  const friend = item?.friend || item?.user || {};
  const friendId = String(friend.id || '').trim();
  const overrides = state.directoryStars?.contacts || {};
  if (friendId && Object.prototype.hasOwnProperty.call(overrides, friendId)) return overrides[friendId] === true;
  return contactLegacyStarred(item);
}

function contactGroupEntries(tab = 'contact') {
  const entries = tab === 'work'
    ? collaborationGroupItems().filter((group) => !group.archived).map((group) => ({ type: 'collaboration', group }))
    : chatGroupItems().filter((group) => !group.archived).map((group) => ({ type: 'natural', group }));
  return entries.sort((left, right) => {
    const leftTime = left.group?.updatedAt || left.group?.updated_at;
    const rightTime = right.group?.updatedAt || right.group?.updated_at;
    return messageTimeValue(rightTime) - messageTimeValue(leftTime);
  });
}

function renderContactAddDialog() {
  if (!state.contactAddDialogOpen) return '';
  const tab = ['contact', 'join-organization', 'create-organization'].includes(state.contactAddDialogTab)
    ? state.contactAddDialogTab
    : 'contact';
  return `<div class="friend-search-dialog-scrim contact-add-dialog-scrim" role="presentation" data-contact-add-close>
    <section class="friend-search-dialog contact-add-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-add-dialog-title" data-contact-add-dialog tabindex="-1">
      <header><div><strong id="contact-add-dialog-title">添加联系人与组织</strong><span>联系人搜索与通讯录筛选彼此独立</span></div><button type="button" data-contact-add-close aria-label="关闭">${iconSvg('x')}</button></header>
      <nav class="contact-add-tabs" aria-label="添加类型">
        ${renderContactAddTab('contact', '添加联系人', tab)}
        ${renderContactAddTab('join-organization', '加入组织', tab)}
        ${renderContactAddTab('create-organization', '创建组织', tab)}
      </nav>
      <div class="contact-add-dialog-body">
        ${tab === 'join-organization' ? renderJoinOrganizationForm() : tab === 'create-organization' ? renderCreateOrganizationForm() : renderAddContactPanel()}
      </div>
    </section>
  </div>`;
}

function renderContactAddTab(value, label, active) {
  return `<button type="button" data-contact-add-tab="${escapeAttr(value)}" class="${active === value ? 'active' : ''}" aria-pressed="${active === value ? 'true' : 'false'}">${escapeHtml(label)}</button>`;
}

function renderAddContactPanel() {
  const query = state.friendAddSearchQuery || state.friendSearchResultQuery || '';
  return `<div class="contact-add-panel">
    <form id="contact-add-search-form" class="contact-add-search-form">
      <label>${iconSvg('search')}<input id="friend-add-search-query" value="${escapeAttr(query)}" placeholder="邮箱、用户名或用户 ID" autocomplete="off" aria-label="查找新联系人" /></label>
      <button class="btn primary" type="submit">查找</button>
    </form>
    ${state.friendSearchResultQuery ? renderFriendSearchResults() : '<div class="contact-add-hint"><strong>查找 Janus 用户</strong><span>输入对方的邮箱、用户名或用户 ID，再发送联系人申请。</span></div>'}
    ${renderFriendRequestComposer()}
  </div>`;
}

function renderJoinOrganizationForm() {
  const draft = state.organizationJoinDraft || {};
  const busy = state.contactAddBusy === 'join-organization';
  return `<div class="contact-organization-join">
    <div class="contact-add-hint compact contact-organization-join-guide"><strong>任选一种方式即可加入</strong><span>“组织号 + 邀请码”和“分享链接”是两种独立方式，不需要同时填写。</span></div>
    <label class="organization-workspace-default-option"><input id="organization-join-default" type="checkbox" ${draft.setAsDefault !== false ? 'checked' : ''} /><span><strong>设该组织为默认工作空间</strong><small>加入后立即切换，并在下次启动时默认进入</small></span></label>
    <section class="contact-organization-method">
      <header><b>方式一</b><div><strong>使用组织号和邀请码</strong><span>向组织创建者获取这两项信息</span></div></header>
      <form id="organization-join-form" class="contact-organization-form" data-organization-join-method="credentials">
        <label><span>组织号</span><input id="organization-join-number" value="${escapeAttr(draft.organizationNumber || '')}" maxlength="32" placeholder="例如 JANUS-2026" autocomplete="off" required /></label>
        <label><span>组织邀请码</span><input id="organization-join-code" value="${escapeAttr(draft.verificationCode || '')}" type="password" minlength="6" maxlength="128" placeholder="至少 6 个字符" autocomplete="one-time-code" required /></label>
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在加入…' : '使用邀请码加入'}</button>
      </form>
    </section>
    <div class="contact-organization-method-divider"><span>或者</span></div>
    <section class="contact-organization-method">
      <header><b>方式二</b><div><strong>粘贴组织分享链接</strong><span>链接中已包含加入所需的信息</span></div></header>
      <form id="organization-join-link-form" class="contact-organization-form" data-organization-join-method="share-link">
        <label><span>组织分享链接</span><input id="organization-join-link" value="${escapeAttr(draft.shareLink || '')}" type="text" placeholder="粘贴 janus://organization/join?..." autocomplete="off" spellcheck="false" required /></label>
        <small class="contact-organization-link-note">分享链接包含邀请码，请仅使用可信成员发送的链接。</small>
        <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在加入…' : '使用分享链接加入'}</button>
      </form>
    </section>
  </div>`;
}

function renderCreateOrganizationForm() {
  const draft = state.organizationCreateDraft || {};
  const busy = state.contactAddBusy === 'create-organization';
  return `<form id="organization-create-form" class="contact-organization-form">
    <div class="contact-add-hint compact"><strong>创建新组织</strong><span>组织号可留空，系统会生成类似 ORG-0001 的唯一编号；创建后，其他人可凭组织号和邀请码加入，后续可生成分享链接。</span></div>
    <label><span>组织名称</span><input id="organization-create-name" value="${escapeAttr(draft.name || '')}" maxlength="60" placeholder="例如 分布式系统实验室" autocomplete="organization" required /></label>
    <label><span>组织号（可选）</span><input id="organization-create-number" value="${escapeAttr(draft.organizationNumber || '')}" maxlength="32" placeholder="留空将自动生成，例如 ORG-0001" autocomplete="off" /></label>
    <label><span>组织邀请码</span><input id="organization-create-code" value="${escapeAttr(draft.verificationCode || '')}" type="password" minlength="6" maxlength="128" placeholder="至少 6 个字符" autocomplete="new-password" required /></label>
    <button class="btn primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在创建…' : '创建组织'}</button>
  </form>`;
}

function renderContactDirectoryContextMenu() {
  const menu = state.contactDirectoryContextMenu;
  if (!menu) return '';
  const organization = safeArray(state.friendOverview?.organizations).find((item) => item.id === menu.organizationId) || null;
  const targetIsSelf = menu.targetUserId && menu.targetUserId === state.currentUser?.id;
  const contact = menu.targetUserId
    ? contactDirectoryRelationships(state.friendOverview || {}).find((item) => String(item?.friend?.id || item?.user?.id || '') === String(menu.targetUserId))
    : null;
  const starred = contact ? contactIsStarred(contact) : false;
  const management = organization && menu.targetUserId && !targetIsSelf ? renderOrganizationManagementMenuItems(organization, menu.targetUserId, menu.targetRole) : '';
  return `<div class="contact-directory-context-menu" role="menu" style="left:${Math.max(8, Number(menu.x || 0))}px;top:${Math.max(8, Number(menu.y || 0))}px" data-contact-directory-menu>
    ${menu.targetUserId ? `<button type="button" role="menuitem" data-network-peer="${escapeAttr(menu.targetUserId)}" data-network-mode="person">${iconSvg('message')}<span>消息</span></button>` : ''}
    ${contact && !targetIsSelf ? `<button type="button" role="menuitemcheckbox" aria-checked="${starred ? 'true' : 'false'}" data-contact-star-toggle="${escapeAttr(menu.targetUserId)}">${iconSvg('star')}<span>${starred ? '取消星标联系人' : '设为星标联系人'}</span></button>` : ''}
    ${management}
    ${menu.targetUserId ? '<hr />' : ''}
    <button type="button" role="menuitem" data-chat-group-create-open data-chat-group-create-target="${escapeAttr(menu.targetUserId || '')}">${iconSvg('users')}<span>创建群聊</span></button>
    <button type="button" role="menuitem" data-contact-add-open="contact" data-contact-add-target="${escapeAttr(menu.targetUserId || '')}">${iconSvg('userPlus')}<span>添加联系人</span></button>
    <button type="button" role="menuitem" data-contact-add-open="join-organization">${iconSvg('building')}<span>加入组织</span></button>
    <button type="button" role="menuitem" data-contact-add-open="create-organization">${iconSvg('plus')}<span>创建组织</span></button>
  </div>`;
}

function renderOrganizationManagementMenuItems(organization, targetUserId, targetRole) {
  const actorRole = normalizeOrganizationRole(organization.role);
  const role = normalizeOrganizationRole(targetRole);
  const attrs = `data-organization-id="${escapeAttr(organization.id || '')}" data-organization-target="${escapeAttr(targetUserId || '')}"`;
  const items = [];
  if (actorRole === 'owner' && role === 'member') items.push(`<button type="button" role="menuitem" data-organization-action="promote_admin" ${attrs}>${iconSvg('pin')}<span>设为管理员</span></button>`);
  if (actorRole === 'owner' && role === 'admin') items.push(`<button type="button" role="menuitem" data-organization-action="revoke_admin" ${attrs}>${iconSvg('x')}<span>移除管理员权限</span></button>`);
  if (actorRole === 'owner') items.push(`<button type="button" role="menuitem" data-organization-action="transfer_owner" ${attrs}>${iconSvg('users')}<span>转让创建者</span></button>`);
  if ((actorRole === 'owner' && role !== 'owner') || (actorRole === 'admin' && role === 'member')) items.push(`<button type="button" role="menuitem" class="is-danger" data-organization-action="remove_member" ${attrs}>${iconSvg('trash')}<span>移出组织</span></button>`);
  return items.join('');
}

function renderOrganizationActionDialog() {
  const dialog = state.organizationActionDialog;
  if (!dialog) return '';
  const organization = safeArray(state.friendOverview?.organizations).find((item) => item.id === dialog.organizationId) || {};
  const target = safeArray(organization.members).find((item) => item?.user?.id === dialog.targetUserId)?.user || dialog.requester || {};
  const action = dialog.action || '';
  const shareLinkAction = ['generate_invitation_link', 'view_invitation_link'].includes(action);
  const storedShareLink = String(state.organizationShareLinks?.[organization.id] || '').trim();
  const parsedShareLink = storedShareLink ? parseOrganizationInviteLink(storedShareLink) : null;
  const shareVerificationCode = String(dialog.verificationCode ?? parsedShareLink?.verificationCode ?? '');
  const shareLinkValue = String(dialog.shareLink || storedShareLink || '').trim();
  const sensitive = !['request_exit', 'generate_invitation_link', 'view_invitation_link', 'update_invitation_code', 'reset_invitation_code'].includes(action);
  const secondaryVerificationRemembered = Boolean(state.organizationSecondaryVerificationById?.[organization.id]);
  const title = ({ promote_admin: '设为管理员', revoke_admin: '移除管理员权限', remove_member: '移出组织', transfer_owner: '转让组织创建者', update_invitation_code: '修改邀请码', reset_invitation_code: '重置邀请码', generate_invitation_link: dialog.regenerate ? '重新生成组织分享链接' : '生成组织分享链接', view_invitation_link: '查看组织分享链接', request_exit: '申请退出组织', resolve_exit: dialog.decision === 'reject' ? '拒绝退出申请' : '同意退出申请', owner_exit: '退出或解散组织' })[action] || '组织操作';
  const members = safeArray(organization.members).filter((item) => item?.user?.id && item.user.id !== state.currentUser?.id);
  const shareLinkPanel = shareLinkAction ? `<div class="organization-share-link-panel">
    <p>${action === 'view_invitation_link' ? '分享链接包含加入凭据，请确认后复制给可信成员。' : '输入当前邀请码生成分享链接；生成后可直接查看并复制。'}</p>
    <div class="organization-share-link-fields">
      <label class="organization-share-code-field"><span class="organization-share-code-heading"><span>邀请码</span><span class="organization-invitation-help" tabindex="0" aria-label="生成分享链接说明" title="分享链接包含邀请码，修改或重置邀请码后旧链接会失效。">${iconSvg('helpCircle')}<span role="tooltip">分享链接包含邀请码，修改或重置邀请码后旧链接会失效。</span></span></span><input id="organization-share-invitation-code" type="text" value="${escapeAttr(shareVerificationCode)}" minlength="6" maxlength="128" autocomplete="off" placeholder="输入当前邀请码" required /></label>
      <label class="organization-share-url-field"><span>分享链接</span><div><input id="organization-share-link-value" type="text" value="${escapeAttr(shareLinkValue)}" placeholder="生成后将在这里显示" readonly /><button type="button" class="btn secondary" data-organization-share-link-copy ${shareLinkValue ? '' : 'disabled'}>${iconSvg('copy')}<span>复制</span></button></div></label>
    </div>
    ${action === 'generate_invitation_link' && organization.role === 'owner' ? `<button type="button" class="organization-share-reset-entry" data-organization-invitation-reset-from-share><span><strong>忘记当前邀请码？</strong><small>通过账号邮箱验证后重置</small></span>${iconSvg('chevronRight')}</button>` : ''}
    ${action === 'view_invitation_link' ? `<section class="organization-share-link-management"><div><strong>链接管理</strong><span>邀请码修改后，需要重新生成分享链接。</span></div><button type="button" class="btn secondary" data-organization-share-regenerate>${iconSvg('share')}<span>重新生成分享链接</span></button></section>` : ''}
  </div>` : '';
  return `<div class="organization-action-scrim" data-organization-action-close>
    <form class="organization-action-dialog ${shareLinkAction ? 'organization-share-link-dialog' : ''}" id="organization-action-form" data-organization-action-dialog>
      <header><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(organization.name || dialog.organizationName || '')}</span></div><button type="button" data-organization-action-close aria-label="关闭">${iconSvg('x')}</button></header>
      <div class="organization-action-body">
        ${target?.id ? `<p class="organization-action-target">对象：<strong>${escapeHtml(displayUserName(target))}</strong></p>` : ''}
        ${action === 'request_exit' ? '<p>退出申请会发送给有权限的管理员；任意一人处理后即完成。确认发送申请吗？</p>' : ''}
        ${shareLinkPanel}
        ${action === 'transfer_owner' ? `<label><span>转让后我的身份</span><select id="organization-transfer-retain-admin"><option value="true" selected>保留管理员身份</option><option value="false">成为普通成员</option></select></label><p class="organization-action-warning">新创建者将获得最高管理权限；你仍会留在组织中。</p>` : ''}
        ${action === 'owner_exit' ? `<label><span>退出方式</span><select id="organization-owner-exit-mode"><option value="auto">自动顺位继任</option><option value="transfer">指定下一任创建者</option><option value="dissolve">直接解散组织</option></select></label><label data-owner-successor-field hidden><span>下一任创建者</span><select id="organization-owner-successor"><option value="">请选择组织成员</option>${members.map((item) => `<option value="${escapeAttr(item.user.id)}">${escapeHtml(displayUserName(item.user))} · ${escapeHtml(organizationRoleLabel(item.role))}</option>`).join('')}</select></label><p class="organization-action-warning">解散后不可恢复；转让或自动继任后你将退出该组织。</p>` : ''}
        ${action === 'update_invitation_code' ? `<div class="organization-invitation-form">
          <div class="organization-invitation-section-heading"><strong>设置新邀请码</strong><span class="organization-invitation-help" tabindex="0" aria-label="邀请码修改说明" title="修改后，旧邀请码和已有分享链接会立即失效。">${iconSvg('helpCircle')}<span role="tooltip">修改后，旧邀请码和已有分享链接会立即失效。请保存新邀请码，并按需重新生成分享链接。</span></span></div>
          <div class="organization-invitation-fields"><label><span>新邀请码</span><input id="organization-new-invitation-code" type="password" minlength="6" maxlength="128" autocomplete="new-password" placeholder="至少 6 个字符" required /></label><label><span>确认新邀请码</span><input id="organization-confirm-invitation-code" type="password" minlength="6" maxlength="128" autocomplete="new-password" placeholder="再次输入新邀请码" required /></label></div>
          <section class="organization-invitation-verification"><div class="organization-invitation-section-heading"><strong>验证当前身份</strong><span>${secondaryVerificationRemembered ? '本次登录已验证' : '无需邮箱验证'}</span></div>${secondaryVerificationRemembered
            ? '<p class="organization-secondary-verification-active">本次登录中，该组织的敏感操作无需再次输入邀请码和账号密码。</p>'
            : '<label><span>当前邀请码</span><input id="organization-action-code" type="password" autocomplete="one-time-code" required /></label><label><span>当前账号密码</span><input id="organization-action-password" type="password" autocomplete="current-password" required /></label><label class="organization-secondary-verification-remember"><input id="organization-remember-secondary-verification" type="checkbox" /><span>本次登录不再进行二次验证</span></label>'}</section>
          <button type="button" class="organization-invitation-reset-entry" data-organization-invitation-reset-open><span><strong>忘记当前邀请码？</strong><small>通过账号邮箱验证后重置</small></span>${iconSvg('chevronRight')}</button>
        </div>` : ''}
        ${action === 'reset_invitation_code' ? `<div class="organization-invitation-form organization-invitation-reset-form">
          <div class="organization-invitation-reset-summary"><span>${iconSvg('shield')}</span><div><strong>使用邮箱重置</strong><small>验证码将发送至 ${escapeHtml(state.currentUser?.email || '尚未绑定邮箱')}</small></div><span class="organization-invitation-help" tabindex="0" aria-label="邮箱重置说明" title="仅在忘记当前邀请码时使用。">${iconSvg('helpCircle')}<span role="tooltip">仅在忘记当前邀请码时使用。邮箱验证成功后，旧邀请码和分享链接会立即失效。</span></span></div>
          <div class="organization-invitation-fields"><label><span>新邀请码</span><input id="organization-new-invitation-code" type="password" minlength="6" maxlength="128" autocomplete="new-password" placeholder="至少 6 个字符" required /></label><label><span>确认新邀请码</span><input id="organization-confirm-invitation-code" type="password" minlength="6" maxlength="128" autocomplete="new-password" placeholder="再次输入新邀请码" required /></label></div>
          <label><span>邮箱验证码</span><div class="organization-invitation-email-code-row"><input id="organization-invitation-reset-email-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位验证码" required /><button type="button" class="btn secondary" data-organization-invitation-reset-send-code>发送验证码</button></div></label>
        </div>` : ''}
        ${sensitive ? `<div class="organization-action-verification">${secondaryVerificationRemembered
          ? '<p class="organization-secondary-verification-active">本次登录已完成二次验证，确认后将直接执行该敏感操作。</p>'
          : '<p>敏感操作需要同时验证组织邀请码与当前账号密码。</p><label><span>组织邀请码</span><input id="organization-action-code" type="password" autocomplete="one-time-code" required /></label><label><span>当前账号密码</span><input id="organization-action-password" type="password" autocomplete="current-password" required /></label><label class="organization-secondary-verification-remember"><input id="organization-remember-secondary-verification" type="checkbox" /><span>本次登录不再进行二次验证</span></label>'}</div>` : ''}
      </div>
      <footer>${action === 'view_invitation_link' ? `<button type="button" class="btn primary" data-organization-action-close>完成</button>` : `${action === 'reset_invitation_code' ? '<button type="button" class="btn" data-organization-invitation-reset-back>返回普通修改</button>' : '<button type="button" class="btn" data-organization-action-close>取消</button>'}${action === 'resolve_exit' ? `<button type="submit" class="btn" data-organization-exit-decision="reject" ${state.organizationActionBusy ? 'disabled' : ''}>拒绝</button><button type="submit" class="btn primary" data-organization-exit-decision="approve" ${state.organizationActionBusy ? 'disabled' : ''}>同意退出</button>` : `<button type="submit" class="btn primary" ${state.organizationActionBusy ? 'disabled' : ''}>${state.organizationActionBusy ? '处理中…' : action === 'generate_invitation_link' ? dialog.regenerate ? '重新生成' : '生成链接' : action === 'reset_invitation_code' ? '验证并重置' : '确认'}</button>`}`}</footer>
    </form>
  </div>`;
}

function renderOrganizationInvitePrompt() {
  const invite = state.organizationInvitePrompt;
  if (!invite) return '';
  const organizationName = invite.organizationName || invite.organizationNumber || '该组织';
  const ownerName = invite.ownerName || '邀请链接未提供';
  const accountName = displayUserName(state.currentUser || {});
  return `<div class="organization-action-scrim" data-organization-invite-close>
    <section class="organization-action-dialog organization-invite-dialog" role="dialog" aria-modal="true" aria-labelledby="organization-invite-title" data-organization-invite-dialog>
      <header><div><strong id="organization-invite-title">加入组织邀请</strong><span>${escapeHtml(invite.organizationNumber || '')}</span></div><button type="button" data-organization-invite-close aria-label="关闭">${iconSvg('x')}</button></header>
      <div class="organization-action-body">
        <div class="organization-invite-mark">${iconSvg('building')}</div>
        <p>你复制了一个组织邀请链接，请核对以下信息：</p>
        <div class="organization-invite-summary">
          <div><span>组织名称</span><strong>${escapeHtml(organizationName)}</strong></div>
          <div><span>组织号</span><strong>${escapeHtml(invite.organizationNumber || '未提供')}</strong></div>
          <div><span>创建者</span><strong>${escapeHtml(ownerName)}</strong></div>
        </div>
        <p>当前账号“${escapeHtml(accountName)}”尚未加入该组织，是否确认加入？</p>
        <label class="organization-workspace-default-option"><input id="organization-invite-default" type="checkbox" ${invite.setAsDefault !== false ? 'checked' : ''} /><span><strong>设该组织为默认工作空间</strong><small>加入后立即切换，并在下次启动时默认进入</small></span></label>
        <small class="organization-invite-note">以上信息来自邀请链接，加入资格仍会由服务端校验。</small>
        <code class="organization-invite-link-preview">${escapeHtml(invite.link || '')}</code>
      </div>
      <footer><button type="button" class="btn" data-organization-invite-close>暂不加入</button><button type="button" class="btn primary" data-organization-invite-confirm ${state.organizationInviteBusy ? 'disabled' : ''}>${state.organizationInviteBusy ? '正在加入…' : '确认加入'}</button></footer>
    </section>
  </div>`;
}

function renderDirectorySectionToggle(key, label, count, open, searchActive = false, { unreadCount = 0, newCount = 0 } = {}) {
  return `<button class="im-directory-section-head im-directory-section-toggle" type="button" data-directory-section="${escapeAttr(key)}" aria-expanded="${open ? 'true' : 'false'}" aria-controls="network-directory-${escapeAttr(key)}" ${searchActive ? 'disabled title="搜索时会临时展开全部板块"' : ''}>
    <i aria-hidden="true">${iconSvg(open ? 'chevronDown' : 'chevronRight')}</i><strong>${escapeHtml(label)}</strong><span>${Number(count || 0)}</span>${newCount ? `<em class="im-directory-section-alert is-new">新增 ${Number(newCount)}</em>` : unreadCount ? `<em class="im-directory-section-alert">${Number(unreadCount)} 未读</em>` : ''}
  </button>`;
}

function renderDirectoryGroupRow(entry = {}) {
  if (entry.type === 'natural') {
    const group = entry.group || {};
    const ended = group.status === 'dissolved';
    const unread = directoryGroupUnreadCount(entry);
    const key = groupDirectoryPreferenceKey('contact', group.id);
    const remark = String(group.membership ? group.membership.remark : state.groupDirectoryPreferences?.remarks?.[key] || '').trim();
    const starred = state.groupDirectoryPreferences?.starred?.[key] === true;
    const active = state.networkGroupProfileOpen && state.networkSelectedGroupKind === 'contact' && state.networkSelectedGroupId === group.id;
    const row = `<button class="im-directory-row im-group-directory-row ${ended ? 'is-ended' : ''} ${active ? 'active' : ''} ${starred ? 'is-starred' : ''}" type="button" data-contact-group-profile="${escapeAttr(group.id || '')}" data-contact-group-kind="contact" ${directorySearchAttributes(`${remark} ${group.title || '联系人群聊'} ${group.lastMessage || ''}`)}>
      <span class="im-directory-avatar group natural-group-avatar">${escapeHtml(groupAvatarLabel(group))}</span>
      <span class="im-directory-main"><strong>${escapeHtml(remark || group.title || '联系人群聊')}${starred ? `<em class="contact-row-star" title="已星标">${iconSvg('star')}</em>` : ''}</strong><small>${remark ? `${escapeHtml(group.title || '联系人群聊')} · ` : ''}${Number(group.memberCount || 0)} 位成员 · ${ended ? '已解散' : '联系人群聊'}</small></span>
      <span class="im-directory-unread ${unread ? '' : 'is-empty'}">${unread || ''}</span><span class="im-directory-chevron">${iconSvg('chevronRight')}</span>
    </button>`;
    const archiveLabel = state.languageMode === 'en' ? 'Archive group chat' : '归档群聊';
    return ended ? `<div class="im-directory-group-row-wrap">${row}<button class="im-directory-group-remove" type="button" data-conversation-archive="chat-group:${escapeAttr(group.id || '')}" title="${escapeAttr(archiveLabel)}" aria-label="${escapeAttr(`${archiveLabel} ${remark || group.title || (state.languageMode === 'en' ? 'contact group' : '联系人群聊')}`)}">${iconSvg('archive')}</button></div>` : row;
  }
  if (entry.type === 'collaboration') {
    const group = entry.group || {};
    const localHistoryOnly = group.localHistoryOnly === true || group.metadata?.localHistoryOnly === true;
    const ended = group.status === 'closed' || localHistoryOnly;
    const unread = directoryGroupUnreadCount(entry);
    const key = groupDirectoryPreferenceKey('work', group.id);
    const remark = String(group.membership ? group.membership.remark : state.groupDirectoryPreferences?.remarks?.[key] || '').trim();
    const starred = state.groupDirectoryPreferences?.starred?.[key] === true;
    const active = state.networkGroupProfileOpen && state.networkSelectedGroupKind === 'work' && state.networkSelectedGroupId === group.id;
    return `<button class="im-directory-row im-group-directory-row ${ended ? 'is-ended' : ''} ${active ? 'active' : ''} ${starred ? 'is-starred' : ''}" type="button" data-contact-group-profile="${escapeAttr(group.id || '')}" data-contact-group-kind="work" ${directorySearchAttributes(`${remark} ${group.title || 'uBuddy 任务群'} ${localHistoryOnly ? '本机历史' : ended ? '已结束' : '进行中'}`)}>
      <span class="im-directory-avatar group">${iconSvg(ended ? 'archive' : 'network')}</span>
      <span class="im-directory-main"><strong>${escapeHtml(remark || group.title || 'uBuddy 任务群')}${starred ? `<em class="contact-row-star" title="已星标">${iconSvg('star')}</em>` : ''}</strong><small>${remark ? `${escapeHtml(group.title || 'uBuddy 任务群')} · ` : ''}${Number(group.memberCount || 0)} 位成员 · ${localHistoryOnly ? '本机历史' : ended ? '已结束' : '进行中'}</small></span>
      <span class="im-directory-unread ${unread ? '' : 'is-empty'}" ${unread ? `aria-label="${unread} 条未读消息"` : 'aria-hidden="true"'}>${unread || ''}</span>
      <span class="im-directory-chevron">${iconSvg('chevronRight')}</span>
    </button>`;
  }
  const item = entry.item || {};
  const unread = directoryGroupUnreadCount(entry);
  const active = state.networkConversationMode === 'group' && state.networkConversationPeerId === item.peerId && String(state.networkConversationGroupId || '') === String(item.groupId || '');
  return `<button class="im-directory-row im-group-directory-row ${item.ended ? 'is-ended' : ''} ${active ? 'active' : ''}" type="button" data-network-peer="${escapeAttr(item.peerId || '')}" data-network-group="${escapeAttr(item.groupId || '')}" data-network-mode="group" ${directorySearchAttributes(`${item.title || ''} ${item.sender || ''} ${item.kind || ''}`)}>
    <span class="im-directory-avatar group">${iconSvg(item.ended ? 'archive' : 'network')}</span>
    <span class="im-directory-main"><strong>${escapeHtml(item.title || '群聊')}</strong><small>${escapeHtml(item.kind || (item.ended ? '已结束' : '进行中'))}</small></span>
    <span class="im-directory-unread ${unread ? '' : 'is-empty'}" ${unread ? `aria-label="${unread} 条未读消息"` : 'aria-hidden="true"'}>${unread || ''}</span>
    <span class="im-directory-chevron">${iconSvg('chevronRight')}</span>
  </button>`;
}

function groupDirectoryPreferenceKey(kind = '', groupId = '') {
  const id = String(groupId || '').trim();
  return id ? `${kind === 'work' ? 'work' : 'contact'}:${id}` : '';
}

function directoryGroupEnded(entry = {}) {
  if (entry.type === 'natural') return entry.group?.status === 'dissolved';
  return entry.type === 'collaboration'
    ? entry.group?.status === 'closed' || entry.group?.localHistoryOnly === true || entry.group?.metadata?.localHistoryOnly === true
    : Boolean(entry.item?.ended);
}

function directoryGroupUnreadCount(entry = {}) {
  if (['natural', 'collaboration'].includes(entry.type)) return Math.max(0, Number(entry.group?.unreadCount || 0));
  return entry.item?.unread ? 1 : 0;
}

function directoryEntryMatchesSearch(entry = {}) {
  if (['natural', 'collaboration'].includes(entry.type)) return directoryTextMatchesSearch(`${entry.group?.title || ''} ${entry.group?.status || ''} ${entry.group?.lastMessage || ''}`);
  return directoryTextMatchesSearch(`${entry.item?.title || ''} ${entry.item?.sender || ''} ${entry.item?.kind || ''}`);
}

function groupAvatarLabel(group = {}) {
  const title = String(group.title || '群').trim();
  return [...title][0] || '群';
}

function directoryTextMatchesSearch(value = '') {
  const query = normalizeConversationSearch(state.friendSearchQuery);
  return !query || normalizeConversationSearch(value).includes(query);
}

function directorySearchAttributes(value = '') {
  const searchable = normalizeConversationSearch(value);
  return `data-directory-search-text="${escapeAttr(searchable)}"${directoryTextMatchesSearch(searchable) ? '' : ' hidden'}`;
}

function renderFriendSearchResults() {
  const resultQuery = String(state.friendSearchResultQuery || '').trim();
  if (!resultQuery) return '';
  const results = safeArray(state.friendSearchResults);
  return `
    <div class="network-friend-block network-user-search-results" aria-live="polite">
      <div class="network-section-title"><strong>查找新用户</strong><span>“${escapeHtml(resultQuery)}”</span></div>
      ${results.length ? results.map((user) => {
        const status = user.friendshipStatus || 'none';
        const action = status === 'none'
          ? `<button class="mini-btn" type="button" data-friend-request="${escapeAttr(user.id)}">${text.apply}</button>`
          : status === 'accepted'
            ? `<button class="mini-btn" type="button" data-network-ubuddy-target="${escapeAttr(user.id)}">uBuddy 发任务</button>`
            : status === 'incoming_pending'
              ? `<button class="mini-btn" type="button" data-friend-accept="${escapeAttr(user.requestId)}">${text.accept}</button>`
              : `<span class="network-friend-status">${escapeHtml(friendshipStatusLabel(status))}</span>`;
        return renderFriendIdentityRow(user, action);
      }).join('') : '<div class="im-list-empty compact">未找到可添加的用户</div>'}
    </div>
  `;
}

function renderFriendRequestComposer() {
  const targetId = String(state.friendRequestTargetId || '').trim();
  if (!targetId) return '';
  const target = (state.friendSearchResults || []).find((item) => item.id === targetId);
  if (!target) return '';
  return `
    <form id="friend-request-form" class="network-friend-request-card">
      <div class="network-friend-request-head">
        ${renderNetworkUserAvatar(target)}
        <div>
          <strong>申请添加 ${escapeHtml(displayUserName(target))}</strong>
          <small>${escapeHtml(target.email || target.username || target.id || '')}</small>
        </div>
      </div>
      <label>
        <span>打个招呼 <small>选填，最多 200 字</small></span>
        <textarea id="friend-request-message" maxlength="200" rows="3" placeholder="例如：你好，我是项目组的王明，想和你协作处理本周报告。">${escapeHtml(state.friendRequestMessage || '')}</textarea>
      </label>
      <div class="network-friend-request-actions">
        <button class="mini-btn" id="cancel-friend-request-btn" type="button">取消</button>
        <button class="btn primary" type="submit">发送好友申请</button>
      </div>
    </form>
  `;
}

function renderFriendRequestList(title, items, direction) {
  return `
    <section class="friend-request-group" data-friend-request-group="${escapeAttr(direction)}">
      <h2>${escapeHtml(title)}<span>${safeArray(items).length}</span></h2>
      ${safeArray(items).map((item) => {
        const busy = state.friendRequestActionId === item.id;
        const action = direction === 'incoming'
          ? `<button class="friend-request-btn is-primary" type="button" data-friend-accept="${escapeAttr(item.id)}" ${busy ? 'disabled' : ''}>${busy ? '处理中…' : text.accept}</button><button class="friend-request-btn" type="button" data-friend-reject="${escapeAttr(item.id)}" ${busy ? 'disabled' : ''}>${text.reject}</button>`
          : `<span class="friend-request-status">等待验证</span><button class="friend-request-btn" type="button" data-friend-cancel="${escapeAttr(item.id)}" ${busy ? 'disabled' : ''}>${busy ? '处理中…' : text.cancel}</button>`;
        return renderFriendRequestRow(item, action, direction);
      }).join('')}
    </section>
  `;
}

function renderFriendRequestRow(item = {}, action = '', direction = 'incoming') {
  const user = item.user && typeof item.user === 'object' ? item.user : {};
  const account = user.username ? `@${user.username}` : user.email || user.id || '';
  const message = String(item.message || '').trim();
  const time = item.updatedAt || item.updated_at || item.createdAt || item.created_at || '';
  return `<article class="friend-request-row" data-friend-request-id="${escapeAttr(item.id || '')}">
    ${renderNetworkUserAvatar(user, { className: 'friend-request-avatar' })}
    <div class="friend-request-copy">
      <div class="friend-request-name-line"><strong>${escapeHtml(displayUserName(user))}</strong>${time ? `<time>${escapeHtml(formatMessageTime(time))}</time>` : ''}</div>
      ${account ? `<small>${escapeHtml(account)}</small>` : ''}
      <p>${escapeHtml(message || (direction === 'incoming' ? '请求添加你为好友' : '好友申请已发送'))}</p>
    </div>
    <div class="friend-request-actions">${action}</div>
  </article>`;
}

function renderFriendRow(item, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {};
  const friend = item?.friend || item?.user || null;
  if (!friend || typeof friend !== 'object') return '';
  const friendId = String(friend.id || '').trim();
  if (!friendId) return '';
  const accountName = originalUserName(friend);
  const helper = options.helper || (friend.remark
    ? `${accountName} · ${friend.username ? `@${friend.username}` : friend.email || '联系人'}`
    : friend.username ? `@${friend.username}` : friend.email || '联系人');
  const unread = directContactUnreadCount(friendId);
  const active = state.networkContactProfileOpen && selectedContactId() === friendId;
  const starred = contactIsStarred(item);
  const presence = contactPresenceDisplayState(item, { loading: state.networkPanelLoading });
  return `<button class="network-friend-row im-contact-row ${active ? 'active' : ''} ${starred ? 'is-starred' : ''}" type="button" data-contact-profile="${escapeAttr(friendId)}" ${options.organizationId ? `data-organization-member="${escapeAttr(options.organizationId)}" data-organization-role="${escapeAttr(options.organizationRole || 'member')}"` : ''} aria-pressed="${active ? 'true' : 'false'}" title="${escapeAttr(`${displayUserName(friend)} · ${helper}${starred ? ' · 已星标' : ''}`)}" ${directorySearchAttributes(contactSearchText(item))}>
    ${renderNetworkUserAvatar(friend)}
    <span class="network-friend-main"><strong><span data-no-localize>${escapeHtml(displayUserName(friend))}</span>${options.roleTag ? `<em class="organization-role-tag is-${escapeAttr(options.organizationRole || 'member')}">${escapeHtml(options.roleTag)}</em>` : ''}</strong><small><i class="contact-presence-dot ${presence.className}" aria-hidden="true"></i>${presence.label} · ${escapeHtml(helper)}</small></span>
    <span class="contact-row-end">${starred ? `<span class="contact-row-star" title="已设为星标联系人" aria-label="已设为星标联系人">${iconSvg('star')}</span>` : ''}<span class="im-directory-unread ${unread ? '' : 'is-empty'}" ${unread ? `aria-label="${unread} 条未读消息"` : 'aria-hidden="true"'}>${unread || ''}</span></span>
  </button>`;
}

export function contactPresenceDisplayState(item = {}, { loading = false } = {}) {
  const user = item?.friend || item?.user || {};
  const online = item?.online === true || user.online === true;
  const known = item?.presenceKnown === true || user.presenceKnown === true;
  if (!known) return { label: loading ? '同步中' : '状态未知', className: 'is-unknown', known: false, online: false };
  return { label: online ? '在线' : '离线', className: online ? 'is-online' : 'is-offline', known: true, online };
}

export function contactDirectoryRelationships(overview = {}, currentUserId = String(state.currentUser?.id || '')) {
  const relationships = safeArray(overview.friends)
    .filter((item) => item && typeof item === 'object' && (item.friend?.id || item.user?.id));
  const byUserId = new Map(relationships.map((item) => [String(item.friend?.id || item.user?.id || ''), item]));
  for (const organization of safeArray(overview.organizations)) {
    for (const member of safeArray(organization.members)) {
      const user = member?.user || {};
      const userId = String(user.id || '');
      if (!userId || userId === currentUserId || byUserId.has(userId)) continue;
      const synthetic = organizationMemberRelationship(member, currentUserId);
      relationships.push(synthetic);
      byUserId.set(userId, synthetic);
    }
  }
  return relationships.sort(compareContacts);
}

export function organizationMemberRelationship(member = {}, currentUserId = '') {
  const user = member?.user || {};
  return {
    id: `organization_contact_${String(user.id || '')}`,
    status: 'accepted',
    organizationContact: true,
    selfContact: String(user.id || '') === String(currentUserId || ''),
    online: member?.online === true || user.online === true,
    presenceKnown: member?.presenceKnown === true || user.presenceKnown === true,
    lastSeenAt: member?.lastSeenAt || member?.last_seen_at || user.lastSeenAt || user.last_seen_at || '',
    friend: user,
  };
}

function compareContacts(left = {}, right = {}) {
  const leftName = displayUserName(left?.friend || left?.user || {});
  const rightName = displayUserName(right?.friend || right?.user || {});
  return leftName.localeCompare(rightName, 'zh-CN');
}

function renderContactProfileDialog(friends = []) {
  const contacts = safeArray(friends).map((item) => ({ item, friend: item?.friend || item?.user || null })).filter((entry) => entry.friend?.id);
  const selectedId = selectedContactId();
  const selectedOrganization = safeArray(state.friendOverview?.organizations).find((item) => item.id === state.networkSelectedContactOrganizationId) || null;
  const organizationMember = safeArray(selectedOrganization?.members).find((item) => String(item?.user?.id || '') === selectedId) || null;
  const entry = contacts.find((item) => String(item.friend.id || '') === selectedId) || (organizationMember ? { item: organizationMember, friend: organizationMember.user } : null);
  if (!entry) return '';
  const friend = entry.friend || {};
  const friendId = String(friend.id || '').trim();
  const accountName = originalUserName(friend);
  const displayName = displayUserName(friend);
  const detail = friend.remark ? `${accountName} · ${friend.username ? `@${friend.username}` : friend.email || '联系人'}` : friend.username ? `@${friend.username}` : friend.email || '联系人';
  const isSelf = friendId === String(state.currentUser?.id || '');
  const starred = contactIsStarred(entry.item);
  const management = !isSelf && selectedOrganization ? renderOrganizationProfileManagement(selectedOrganization, friendId, organizationMember?.role) : '';
  return `<div class="contact-profile-scrim" role="presentation" data-contact-profile-close>
    <article class="contact-profile-card contact-profile-drawer" role="dialog" aria-modal="false" aria-label="联系人详情" data-contact-profile-dialog>
      <div class="contact-profile-cover"><button type="button" class="contact-profile-more" data-contact-profile-close aria-label="关闭">${iconSvg('x')}</button></div>
      <div class="contact-profile-body" data-contact-profile-id="${escapeAttr(friendId)}">
        ${renderNetworkUserAvatar(friend, { className: 'contact-profile-avatar', title: displayName, viewerUserId: friendId })}
        <h2>${escapeHtml(displayName)}</h2>
        <p>${escapeHtml(detail)}</p>
        <div class="contact-profile-actions">
          <button type="button" class="is-primary" data-contact-profile-message="${escapeAttr(friendId)}">${iconSvg('message')}<span>消息</span></button>
          ${isSelf ? '' : `<button type="button" class="is-secondary" data-contact-profile-call="${escapeAttr(friendId)}">${iconSvg('phone')}<span>语音通话</span></button>`}
          ${isSelf ? (selectedOrganization ? `<button type="button" class="is-secondary" data-organization-display-name="${escapeAttr(selectedOrganization.id)}" data-current-display-name="${escapeAttr(organizationMember?.displayNameOverride || '')}">${iconSvg('edit')}<span>组织显示名</span></button>` : '') : `<button type="button" class="is-secondary ${starred ? 'is-starred' : ''}" aria-pressed="${starred ? 'true' : 'false'}" data-contact-star-toggle="${escapeAttr(friendId)}" title="${starred ? '取消星标联系人' : '设为星标联系人'}" aria-label="${starred ? '取消星标联系人' : '设为星标联系人'}">${iconSvg('star')}<span>${starred ? '已星标' : '星标'}</span></button><button type="button" class="is-secondary" data-friend-remark="${escapeAttr(friendId)}">${iconSvg('edit')}<span>备注</span></button><button type="button" class="is-secondary" data-contact-collaboration="${escapeAttr(friendId)}" title="前往 uBuddy，并 @${escapeAttr(displayName)}">${iconSvg('tasks')}<span>uBuddy</span></button>`}
        </div>
        ${renderContactUBuddyCapabilityProfile(friendId)}
        ${management}
      </div>
    </article>
  </div>`;
}

function renderContactUBuddyCapabilityProfile(friendId = '') {
  if (state.uBuddyFeatureFlags?.profilePublication !== true) return '';
  const item = state.uBuddyCapabilityProfilesByUserId?.[friendId] || null;
  const loading = state.uBuddyCapabilityProfileLoadingByUserId?.[friendId] === true;
  const profile = item?.profile || null;
  if (!profile) {
    return `<section class="contact-ubuddy-profile is-empty" aria-label="uBuddy 团队简介">
      <header><span>${iconSvg('network')}</span><div><strong>uBuddy 团队简介</strong><small>${loading ? '正在获取公开能力信息…' : '对方暂未公开可用简介'}</small></div></header>
    </section>`;
  }
  const tags = safeArray(profile.capabilityTags).slice(0, 12);
  const tasks = safeArray(profile.supportedTaskTypes).slice(0, 8);
  const deliverables = safeArray(profile.deliverableTypes).slice(0, 8);
  const updatedAt = item.fetchedAt || profile.publishedAt || profile.generatedAt || '';
  const status = item.stale ? '离线缓存已过期' : item.cached || item.fetchedAt ? '已缓存，可离线查看' : '来自云端';
  return `<section class="contact-ubuddy-profile" aria-label="uBuddy 团队简介">
    <header><span>${iconSvg('network')}</span><div><strong>uBuddy 团队简介</strong><small>${escapeHtml(status)}${updatedAt ? ` · ${escapeHtml(formatMessageTime(updatedAt))}` : ''}${loading ? ' · 正在刷新' : ''}</small></div></header>
    <p>${escapeHtml(profile.introduction || '')}</p>
    ${tags.length ? `<div class="contact-ubuddy-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>` : ''}
    ${tasks.length ? `<dl><dt>适配任务</dt><dd>${tasks.map((task) => `<span>${escapeHtml(task)}</span>`).join('')}</dd></dl>` : ''}
    ${deliverables.length ? `<dl><dt>交付类型</dt><dd>${deliverables.map((type) => `<span>${escapeHtml(type)}</span>`).join('')}</dd></dl>` : ''}
  </section>`;
}

export function renderGroupProfileDialog() {
  const kind = state.networkSelectedGroupKind === 'work' ? 'work' : 'contact';
  const groupId = String(state.networkSelectedGroupId || '').trim();
  if (!groupId) return '';
  const overviewGroup = kind === 'work'
    ? collaborationGroupItems().find((item) => String(item.id || '') === groupId)
    : chatGroupItems().find((item) => String(item.id || '') === groupId);
  const detail = state.groupDirectoryProfileDetail || {};
  const group = detail.group && String(detail.group.id || '') === groupId ? detail.group : overviewGroup || {};
  const key = groupDirectoryPreferenceKey(kind, groupId);
  const remark = String(detail.membership ? detail.membership.remark : group.membership ? group.membership.remark : state.groupDirectoryPreferences?.remarks?.[key] || '').trim();
  const starred = state.groupDirectoryPreferences?.starred?.[key] === true;
  const displayTitle = remark || group.title || (kind === 'work' ? 'uBuddy 工作群' : '联系人群聊');
  const originalTitle = group.title || displayTitle;
  const members = safeArray(detail.members).filter((member) => member.status === 'active');
  const membership = detail.membership || members.find((member) => String(member.userId || member.user_id || '') === String(state.currentUser?.id || '')) || {};
  const manager = ['owner', 'admin'].includes(membership.role);
  const owner = membership.role === 'owner';
  const ended = ['closed', 'dissolved'].includes(group.status);
  const alreadyInConversation = kind === 'contact' && String(state.chatGroupId || '') === groupId;
  return `<div class="contact-profile-scrim group-profile-scrim" role="presentation" data-group-profile-close>
    <article class="contact-profile-card contact-profile-drawer group-profile-drawer" role="dialog" aria-modal="false" aria-label="群组详情" data-group-profile-dialog>
      <div class="contact-profile-cover group-profile-cover"><button type="button" class="contact-profile-more" data-group-profile-close aria-label="关闭群组详情">${iconSvg('x')}</button></div>
      <div class="contact-profile-body group-profile-body" data-group-profile-id="${escapeAttr(groupId)}" data-group-profile-kind="${escapeAttr(kind)}">
        <span class="contact-profile-avatar group-profile-avatar">${kind === 'work' ? iconSvg('network') : escapeHtml(groupAvatarLabel(group))}</span>
        <h2>${escapeHtml(displayTitle)}</h2>
        <p>${remark ? `${escapeHtml(originalTitle)} · ` : ''}${kind === 'work' ? 'uBuddy 工作群' : '联系人群聊'} · ${Number(group.memberCount || members.length || 0)} 位成员${ended ? ' · 已结束' : ''}</p>
        <div class="contact-profile-actions group-profile-actions">
          ${alreadyInConversation
            ? `<button type="button" class="is-primary is-current" disabled aria-disabled="true" title="当前已在此群聊中">${iconSvg('message')}<span>当前群聊</span></button>`
            : `<button type="button" class="is-primary" data-group-profile-message="${escapeAttr(groupId)}" data-group-kind="${escapeAttr(kind)}">${iconSvg('message')}<span>消息</span></button>`}
          ${kind === 'work' ? `<button type="button" class="is-secondary" data-contact-group-ubuddy>${iconSvg('spark')}<span>前往 uBuddy</span></button>` : ''}
          <button type="button" class="is-secondary ${starred ? 'is-starred' : ''}" data-group-star-toggle="${escapeAttr(groupId)}" data-group-kind="${escapeAttr(kind)}" aria-pressed="${starred ? 'true' : 'false'}">${iconSvg('star')}<span>${starred ? '已星标' : '星标'}</span></button>
          <button type="button" class="is-secondary" data-group-remark="${escapeAttr(groupId)}" data-group-kind="${escapeAttr(kind)}" data-group-title="${escapeAttr(originalTitle)}">${iconSvg('edit')}<span>备注</span></button>
          ${membership.status === 'active' && !ended ? `<button type="button" class="is-secondary" data-group-display-name="${escapeAttr(groupId)}" data-group-kind="${escapeAttr(kind)}" data-current-display-name="${escapeAttr(membership.displayNameOverride || membership.display_name_override || '')}">${iconSvg('user')}<span>群内昵称</span></button>` : ''}
        </div>
        ${kind === 'contact' ? `<section class="group-profile-settings"><header><span>${iconSvg('settings')}</span><div><strong>群聊设置</strong><small>${manager ? '你可以管理该群聊' : '查看群聊信息'}</small></div></header><div>
          ${manager && !ended ? `<button type="button" data-chat-group-invite-open data-chat-group-id="${escapeAttr(groupId)}">${iconSvg('userPlus')}<span>邀请新成员</span></button><button type="button" data-chat-group-rename data-chat-group-id="${escapeAttr(groupId)}">${iconSvg('edit')}<span>修改群名</span></button>` : ''}
          ${owner && !ended ? `<button type="button" class="is-danger" data-chat-group-dissolve data-chat-group-id="${escapeAttr(groupId)}">${iconSvg('trash')}<span>解散群聊</span></button>` : ''}
          ${!owner && !ended ? `<button type="button" class="is-danger" data-chat-group-leave data-chat-group-id="${escapeAttr(groupId)}">${iconSvg('external')}<span>退出群聊</span></button>` : ''}
          ${ended && !group.archived ? `<button type="button" class="is-secondary group-profile-archive-button" data-conversation-archive="chat-group:${escapeAttr(groupId)}" title="归档群聊" aria-label="归档群聊">${iconSvg('archive')}</button>` : ''}
        </div></section>` : ''}
        <section class="group-profile-members"><header><strong>群内成员</strong><span>${members.length || Number(group.memberCount || 0)} 位</span></header>${members.length ? `<div>${members.map((member) => { const user = member.user || {}; const self = user.id === state.currentUser?.id; const memberName = self && (member.displayNameOverride || member.display_name_override) ? `我 · ${displayUserName(user)}` : self ? '我' : displayUserName(user); return `<article>${renderNetworkUserAvatar(user)}<span><strong>${escapeHtml(memberName)}</strong><small>${member.role === 'owner' ? '群主' : member.role === 'admin' ? '管理员' : kind === 'work' ? '成员 · uBuddy 参与协作' : '成员'}</small></span></article>`; }).join('')}</div>` : '<p>正在载入成员信息…</p>'}</section>
      </div>
    </article>
  </div>`;
}

function renderOrganizationProfileManagement(organization, targetUserId, targetRole) {
  const items = renderOrganizationManagementMenuItems(organization, targetUserId, targetRole);
  return items ? `<section class="contact-profile-organization-actions"><header><span>${iconSvg('building')}</span><div><strong>组织管理</strong><small>${escapeHtml(organization.name || '当前组织')} · ${escapeHtml(organizationRoleLabel(targetRole))}</small></div></header><div>${items}</div></section>` : '';
}

function normalizeOrganizationRole(role = '') {
  const value = String(role || '').toLowerCase();
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function organizationRoleLabel(role = '') {
  return translateUiText(({ owner: '创建者', admin: '管理员', member: '成员' })[normalizeOrganizationRole(role)] || '成员', state.languageMode);
}

function selectedContactId() {
  const selected = String(state.networkSelectedContactId || '').trim();
  if (selected) return selected;
  return state.networkConversationMode === 'person' ? String(state.networkConversationPeerId || '').trim() : '';
}

function contactSearchText(item = {}) {
  const friend = item?.friend || item?.user || {};
  const accountName = originalUserName(friend);
  return `${displayUserName(friend)} ${accountName} ${friend.username || ''} ${friend.email || ''} ${friend.id || ''}`;
}

function directContactUnreadCount(friendId = '') {
  const currentUserId = state.currentUser?.id || '';
  const thread = safeArray(state.socialThreads).find((item) => String(item?.friend?.id || '') === String(friendId || ''));
  return safeArray(thread?.messages).filter((message) => {
    const metadata = message?.metadata || {};
    return (message.recipientUserId || message.recipient_user_id) === currentUserId
      && message.status !== 'read'
      && !metadata.taskGroupId && !metadata.groupId;
  }).length;
}

function renderFriendIdentityRow(user = {}, action = '', note = '', showAccountDetails = true) {
  return `
    <article class="network-friend-row">
      ${renderNetworkUserAvatar(user)}
      <div class="network-friend-main">
        <strong>${escapeHtml(displayUserName(user))}</strong>
        ${showAccountDetails ? `<small>${escapeHtml(user.username ? `@${user.username}` : user.id || '')}${user.email ? ` - ${escapeHtml(user.email)}` : ''}</small>` : ''}
        ${note ? `<span>${escapeHtml(note)}</span>` : ''}
      </div>
      ${action ? `<div class="network-friend-actions">${action}</div>` : ''}
    </article>
  `;
}

function renderNetworkEmpty(value) {
  return `<div class="network-empty" role="status" aria-live="polite">${escapeHtml(value)}</div>`;
}

function displayUserName(user = {}) {
  return user.remark || user.displayName || user.display_name || user.username || user.email || user.id || text.user;
}

function originalUserName(user = {}) {
  return user.accountDisplayName || user.account_display_name || user.displayName || user.display_name || user.username || user.email || user.id || text.user;
}

function friendshipStatusLabel(status) {
  if (status === 'accepted') return text.accepted;
  if (status === 'outgoing_pending') return text.sent;
  if (status === 'incoming_pending') return text.pendingAccept;
  return text.none;
}
