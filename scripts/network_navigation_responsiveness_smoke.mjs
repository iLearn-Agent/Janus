import assert from 'node:assert/strict';

import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';

const pendingPolls = [];
const pendingSecretarySessions = [];
const pendingSocialConversations = [];
const pollPayloads = [];
let renderCount = 0;
let threadRefreshCount = 0;
let conversationPanelVisible = false;

const state = {
  currentUser: { id: 'navigation-user' },
  currentTab: 'employees',
  currentSessionId: '',
  currentChatKey: '',
  workspaceSwitchGeneration: 0,
  activeAccountWorkspace: { id: 'workspace_personal' },
  networkPanelOpen: false,
  networkPanelView: 'messages',
  networkMessageHomeOpen: false,
  messageActivePane: 'list',
  primaryChatReturnContext: null,
  sessions: [],
  tasks: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [],
  agentDelegations: [],
  collaborationOverview: { groups: [], tasks: [] },
  chatGroupsOverview: { groups: [] },
  chatDraft: '',
  attachments: [],
  composerMentions: [],
  secretaryMentions: [],
  chatGroupId: 'open-chat-group',
  chatGroupDetail: { group: { id: 'open-chat-group' } },
  collaborationGroupId: 'open-work-group',
  collaborationGroupDetail: { group: { id: 'open-work-group' } },
};

const controller = createNetworkWorkspaceController({
  api: {
    pollSocialNetwork: (payload) => {
      pollPayloads.push(payload);
      return new Promise((resolve) => pendingPolls.push(resolve));
    },
    ensureSecretarySession: () => new Promise((resolve, reject) => {
      pendingSecretarySessions.push(Object.assign(resolve, { reject }));
    }),
    socialConversation: ({ peerId }) => new Promise((resolve) => pendingSocialConversations.push({ peerId, resolve })),
    listAgentDelegations: async () => [],
    listMessagePage: async ({ sessionId }) => ({
      items: [{ id: 'ubuddy-latest', sessionId, role: 'assistant', content: 'ready' }],
      nextCursor: { createdAt: '2026-01-01T00:00:00.000Z', id: 'ubuddy-older' },
      hasMore: true,
    }),
    chatContextStatus: async () => ({ usagePercent: 0 }),
    friendsOverview: async () => state.friendOverview,
    listAgentDeliveryRuns: async () => [],
    listTasks: async () => [],
    getTask: async () => null,
  },
  state,
  render: () => { renderCount += 1; },
  notify: () => {},
  userErrorMessage: (error) => String(error?.message || error),
  preserveChatDraftFromInput: () => state.chatDraft,
  focusChatInputAtEnd: () => {},
  refreshSocialInbox: async () => {},
  refreshAgentDelegations: async () => {},
  refreshSocialThreads: async () => { threadRefreshCount += 1; },
  refreshCollaborationOverview: async () => {},
  socialTaskGroups: () => [],
  socialTaskGroupById: () => null,
  latestSocialTaskGroup: () => null,
  socialTaskGroupType: 'social_task_group',
  scrollMessagesToBottom: () => {},
  readyAttachmentsForSend: async () => [],
  currentModelValue: () => '',
  currentReasoningValue: () => '',
  persistComposerDrafts: () => {},
  focusActiveComposerInput: () => {},
  materializeCollaborationFile: async () => null,
  isCurrentUserAdmin: () => false,
  windowRef: {},
  documentRef: {
    querySelector: (selector) => conversationPanelVisible && selector === '.chat-view.with-messages .conversation-panel' ? {} : null,
  },
  noteDirectoryGroups: () => {},
  currentChatRun: () => null,
  syncCurrentChatRun: () => {},
  restoreActiveRunTransient: () => {},
  openTaskRunWorkspace: async () => {},
  openAgentSession: async () => {},
});

const firstOpen = controller.openNetworkPanel('friends');
assert.equal(renderCount, 1, 'navigation must render before the social poll settles');
assert.equal(state.currentTab, 'chat');
assert.equal(state.networkPanelOpen, true);
assert.equal(state.networkPanelView, 'friends');
assert.equal(state.chatGroupId, '', 'contacts navigation must leave the open natural group');
assert.equal(state.collaborationGroupId, '', 'contacts navigation must leave the open work group');
assert.equal(state.networkPanelLoading, true);
assert.deepEqual(pollPayloads[0], { autoProcess: false }, 'interactive navigation must not auto-process tasks');

const secondOpen = controller.openNetworkPanel('messages');
assert.equal(renderCount, 2, 'a newer navigation must also paint immediately');
assert.equal(state.networkPanelView, 'messages');

pendingPolls[0]({
  workspaceId: 'workspace_personal',
  friends: { friends: [{ friend: { id: 'stale-friend' } }], requests: { incoming: [], outgoing: [] } },
});
await firstOpen;
assert.equal(state.networkPanelView, 'messages');
assert.equal(state.friendOverview.friends.length, 0, 'stale navigation responses must not overwrite current state');

pendingPolls[1]({
  skipped: true,
  reason: 'already_running',
  workspaceId: 'workspace_personal',
  status: { connected: true },
  friends: { friends: [{ friend: { id: 'current-friend' } }], requests: { incoming: [], outgoing: [] } },
  inbox: [],
  delegations: [],
  collaboration: { groups: [], tasks: [] },
  chatGroups: { groups: [] },
});
await secondOpen;

assert.equal(state.networkPanelLoading, false);
assert.equal(state.friendOverview.friends[0].friend.id, 'current-friend');
assert.equal(threadRefreshCount, 1);
assert.equal(renderCount, 3, 'the current navigation should render once initially and once after data is ready');

state.networkMessageHomeOpen = true;
state.homeMode = 'department';
state.networkDelegationId = 'stale-delegation';
state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'stale-task-run';
state.activeTaskSourceContext = { task_workspace_id: 'stale-task-run' };
state.activeTaskReturnAnchorId = 'stale-task-card';
state.activeTaskReturnSurface = 'session';
state.activeTaskReturnScrollTop = 120;
state.taskWorkspaceReturnContext = { currentSessionId: 'source-session' };
const uBuddyOpen = controller.openUBuddyConversation();
assert.equal(state.networkMessageHomeOpen, false, 'uBuddy navigation must leave the message home before session creation settles');
assert.equal(state.homeMode, 'secretary');
assert.match(state.currentChatKey, /^ubuddy:opening:/);
assert.equal(state.uBuddyConversationOpening, true);
assert.equal(state.networkDelegationId, '', 'uBuddy navigation must leave a stale delegation workspace immediately');
assert.equal(state.activeTaskWorkspaceKind, '', 'uBuddy navigation must clear the stale task workspace kind');
assert.equal(state.activeTaskWorkspaceId, '', 'uBuddy navigation must clear the stale task workspace id');
state.chatDraft = '会话创建期间输入的内容';
state.attachments = [{ id: 'pending-attachment' }];
pendingSecretarySessions[0]({ id: 'ubuddy-session', departmentId: 'secretary_department', writeState: 'writable' });
await uBuddyOpen;
assert.equal(state.currentSessionId, 'ubuddy-session');
assert.equal(state.messages[0].id, 'ubuddy-latest');
assert.equal(state.messagePagination.hasMore, true);
assert.equal(state.uBuddyConversationOpening, false);
assert.equal(state.chatDraft, '会话创建期间输入的内容');
assert.equal(state.attachments[0].id, 'pending-attachment');

state.networkDelegationId = 'stale-visible-delegation';
state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'stale-visible-task';
state.taskWorkspaceReturnContext = { currentSessionId: 'stale-source-session' };
await controller.openUBuddyConversation();
assert.equal(state.networkDelegationId, '', 'reopening an already visible uBuddy must clear stale delegation state');
assert.equal(state.activeTaskWorkspaceKind, '', 'the already-visible uBuddy fast path must clear stale task state');
assert.equal(state.activeTaskWorkspaceId, '');
assert.equal(state.taskWorkspaceReturnContext, null);

state.currentSessionId = '';
state.currentChatKey = 'task-workspace:restore-on-failure';
state.homeMode = 'department';
state.networkDelegationId = 'restore-delegation';
state.activeTaskWorkspaceKind = 'task_run';
state.activeTaskWorkspaceId = 'restore-task-run';
state.activeTaskSourceContext = { task_workspace_id: 'restore-task-run' };
state.activeTaskReturnAnchorId = 'restore-task-card';
state.activeTaskReturnSurface = 'session';
state.activeTaskReturnScrollTop = 240;
state.taskWorkspaceReturnContext = { currentSessionId: 'restore-source-session' };
const failedUBuddyOpen = controller.openUBuddyConversation();
assert.equal(state.activeTaskWorkspaceId, '', 'the task workspace must be hidden while uBuddy is opening');
pendingSecretarySessions[1].reject(new Error('session open failed'));
await failedUBuddyOpen;
assert.equal(state.currentChatKey, 'task-workspace:restore-on-failure');
assert.equal(state.networkDelegationId, 'restore-delegation');
assert.equal(state.activeTaskWorkspaceKind, 'task_run');
assert.equal(state.activeTaskWorkspaceId, 'restore-task-run');
assert.deepEqual(state.activeTaskSourceContext, { task_workspace_id: 'restore-task-run' });
assert.equal(state.activeTaskReturnAnchorId, 'restore-task-card');
assert.equal(state.activeTaskReturnScrollTop, 240);
assert.deepEqual(state.taskWorkspaceReturnContext, { currentSessionId: 'restore-source-session' });

state.networkConversationPeerId = 'friend-before-ubuddy';
state.networkConversationMode = 'person';
state.networkConversationGroupId = '';
state.currentSessionId = '';
state.currentChatKey = 'social-peer:friend-before-ubuddy';
state.homeMode = 'department';
const staleUBuddyOpen = controller.openUBuddyConversation();
state.collaborationGroupId = 'work-group-selected-during-ubuddy-open';
state.currentChatKey = 'collaboration:work-group-selected-during-ubuddy-open';
state.homeMode = 'department';
pendingSecretarySessions[2]({ id: 'stale-ubuddy-session', departmentId: 'secretary_department', writeState: 'writable' });
await staleUBuddyOpen;
assert.equal(state.collaborationGroupId, 'work-group-selected-during-ubuddy-open');
assert.equal(state.currentChatKey, 'collaboration:work-group-selected-during-ubuddy-open');
assert.equal(state.currentSessionId, '', 'a delayed uBuddy session must not reclaim a work-group navigation');

state.collaborationGroupId = '';
state.networkConversationPeerId = 'friend-a';
state.networkConversationMode = 'person';
state.networkConversationGroupId = '';
state.currentChatKey = 'social-peer:friend-a';
state.homeMode = 'department';
conversationPanelVisible = true;
const staleContactOpen = controller.openNetworkConversation('friend-b', 'person');
assert.equal(pendingSocialConversations[0].peerId, 'friend-b');
state.networkConversationPeerId = '';
state.collaborationGroupId = 'work-group-selected-during-contact-prefetch';
state.currentChatKey = 'collaboration:work-group-selected-during-contact-prefetch';
pendingSocialConversations[0].resolve([{ id: 'stale-friend-b-message' }]);
await staleContactOpen;
assert.equal(state.collaborationGroupId, 'work-group-selected-during-contact-prefetch');
assert.equal(state.currentChatKey, 'collaboration:work-group-selected-during-contact-prefetch');
assert.equal(state.networkConversationPeerId, '', 'a delayed contact prefetch must not replace a newer work-group navigation');

conversationPanelVisible = false;
state.collaborationGroupId = '';
state.socialThreads = [{
  friend: { id: 'cached-friend' },
  messages: [{ id: 'cached-contact-message', content: '联系人启动预加载消息' }],
}];
const cachedContactOpen = controller.openNetworkConversation('cached-friend', 'person');
assert.equal(state.networkConversationMessages[0]?.id, 'cached-contact-message',
  'opening a contact must paint the startup thread cache before the fresh request settles');
const cachedContactRequest = pendingSocialConversations.find((item) => item.peerId === 'cached-friend');
cachedContactRequest.resolve([{ id: 'fresh-contact-message', content: '联系人最新消息' }]);
await cachedContactOpen;
assert.equal(state.networkConversationMessages[0]?.id, 'fresh-contact-message');

console.log('network navigation responsiveness smoke passed');
