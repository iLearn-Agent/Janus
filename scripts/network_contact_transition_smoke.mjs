import assert from 'node:assert/strict';

import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';

let resolveMessages;
const pendingMessages = new Promise((resolve) => { resolveMessages = resolve; });
let renderCount = 0;
let transitionCount = 0;
let focusCount = 0;
let scrollCount = 0;

const state = {
  currentUser: { id: 'self-user' },
  currentTab: 'chat',
  networkPanelOpen: true,
  networkPanelView: 'messages',
  networkMessageHomeOpen: false,
  networkConversationPeerId: 'friend-a',
  networkConversationMode: 'person',
  networkConversationGroupId: '',
  networkConversationDrafts: {},
  networkConversationMessages: [{ id: 'old-message', content: '旧联系人消息' }],
  followerWorkspaceOpen: true,
  networkDelegationId: '',
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  chatGroupId: '',
  chatGroupDetail: null,
  currentSessionId: '',
  messages: [],
  socialThreads: [],
  attachments: [],
  composerMentions: [],
  secretaryMentions: [],
  chatDraft: '旧草稿',
};

const controller = createNetworkWorkspaceController({
  api: {
    socialConversation: async ({ peerId }) => peerId === 'friend-b' ? pendingMessages : [],
    listAgentDelegations: async () => [],
    markSocialMessageRead: async () => null,
    ensureSecretarySession: async () => ({ id: 'secretary-session', departmentId: 'secretary_department' }),
    listMessages: async () => [],
    chatContextStatus: async () => null,
    friendsOverview: async () => state.friendOverview,
    listAgentDeliveryRuns: async () => [],
  },
  state,
  render: () => { renderCount += 1; },
  renderConversationTransition: async () => { transitionCount += 1; renderCount += 1; },
  notify: () => {},
  userErrorMessage: (error) => String(error?.message || error),
  preserveChatDraftFromInput: () => state.chatDraft,
  focusChatInputAtEnd: () => { focusCount += 1; },
  refreshSocialInbox: async () => {},
  refreshAgentDelegations: async () => {},
  refreshSocialThreads: async () => {},
  refreshCollaborationOverview: async () => {},
  socialTaskGroups: () => [],
  socialTaskGroupById: () => null,
  latestSocialTaskGroup: () => null,
  socialTaskGroupType: 'social_task_group',
  scrollMessagesToBottom: () => { scrollCount += 1; },
  readyAttachmentsForSend: async () => [],
  currentModelValue: () => '',
  currentReasoningValue: () => '',
  persistComposerDrafts: () => {},
  focusActiveComposerInput: () => {},
  materializeCollaborationFile: async () => null,
  isCurrentUserAdmin: () => false,
  windowRef: {},
  documentRef: {
    querySelector: (selector) => selector === '.chat-view.with-messages .conversation-panel' ? {} : null,
    getElementById: () => null,
  },
  noteDirectoryGroups: () => {},
  currentChatRun: () => null,
  syncCurrentChatRun: () => {},
  restoreActiveRunTransient: () => {},
  openTaskRunWorkspace: async () => {},
  openAgentSession: async () => {},
  closeFollowerWorkspace: () => { state.followerWorkspaceOpen = false; },
});

const switching = controller.openNetworkConversation('friend-b', 'person');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(state.networkConversationPeerId, 'friend-a', 'old conversation must remain mounted while the new conversation loads');
assert.equal(renderCount, 0, 'contact switching must not render an empty loading conversation');
assert.equal(transitionCount, 0);

resolveMessages([{ id: 'new-message', senderUserId: 'friend-b', recipientUserId: 'self-user', content: '新联系人消息', status: 'read', metadata: { type: 'direct_message' } }]);
await switching;

assert.equal(state.networkConversationPeerId, 'friend-b');
assert.equal(state.followerWorkspaceOpen, false, 'opening a direct contact conversation must leave Follower');
assert.deepEqual(state.networkConversationMessages.map((message) => message.id), ['new-message']);
assert.equal(transitionCount, 1, 'loaded contact conversations must use one directional transition');
assert.equal(renderCount, 1, 'the old conversation must be replaced only once');
assert.equal(focusCount, 1);
assert.equal(scrollCount, 1);

state.friendOverview = {
  friends: [],
  organizations: [{
    id: 'organization-a',
    members: [{ user: { id: 'organization-contact', displayName: '组织联系人' }, role: 'member' }],
  }],
};
state.sessions = [];
state.projects = [];
state.networkContactProfileOpen = true;
state.networkSelectedContactId = 'organization-contact';
state.networkSelectedContactOrganizationId = 'organization-a';
const openedUBuddy = await controller.openContactCollaborationInUBuddy('organization-contact');
assert.equal(openedUBuddy, true);
assert.equal(state.homeMode, 'secretary');
assert.equal(state.currentSessionId, 'secretary-session');
assert.equal(state.networkContactProfileOpen, false);
assert.equal(state.networkSelectedContactId, '');
assert.equal(state.networkSelectedContactOrganizationId, '');
assert.equal(state.chatDraft, '@组织联系人 ');
assert.equal(state.secretaryMentions.length, 1);
assert.equal(state.secretaryMentions[0].principalType, 'user');
assert.equal(state.secretaryMentions[0].userId, 'organization-contact');
assert.equal(state.secretaryMentions[0].displayText, '@组织联系人');
assert.deepEqual(state.composerMentions, state.secretaryMentions);

const unreadState = {
  ...state,
  currentTab: 'chat', networkPanelOpen: true, networkPanelView: 'messages', networkMessageHomeOpen: true,
  networkConversationPeerId: '', networkConversationMode: 'person', networkConversationGroupId: '',
  networkConversationMessages: [], socialThreads: [], currentSessionId: '', currentChatKey: '',
};
let markedUnreadCount = 0;
let unreadRenderCount = 0;
const unreadController = createNetworkWorkspaceController({
  api: {
    socialConversation: async () => [{ id: 'unread-message', senderUserId: 'friend-unread', recipientUserId: 'self-user', content: '未读内容', status: 'unread', metadata: { type: 'direct_message' } }],
    listAgentDelegations: async () => [], markSocialMessageRead: async () => { markedUnreadCount += 1; },
  },
  state: unreadState,
  render: () => { unreadRenderCount += 1; if (unreadRenderCount > 1) throw new Error('simulated render failure'); },
  notify: () => {}, userErrorMessage: (error) => String(error?.message || error),
  preserveChatDraftFromInput: () => '', restoreComposerDraft: () => {}, focusChatInputAtEnd: () => {},
  refreshSocialInbox: async () => {}, refreshAgentDelegations: async () => {}, refreshSocialThreads: async () => {}, refreshCollaborationOverview: async () => {},
  socialTaskGroups: () => [], socialTaskGroupById: () => null, latestSocialTaskGroup: () => null, socialTaskGroupType: 'social_task_group',
  scrollMessagesToBottom: () => {}, readyAttachmentsForSend: async () => [], currentModelValue: () => '', currentReasoningValue: () => '',
  persistComposerDrafts: () => {}, focusActiveComposerInput: () => {}, materializeCollaborationFile: async () => null, isCurrentUserAdmin: () => false,
  windowRef: {}, documentRef: { querySelector: () => null, getElementById: () => null }, noteDirectoryGroups: () => {}, currentChatRun: () => null,
  syncCurrentChatRun: () => {}, restoreActiveRunTransient: () => {}, restorePersistentDeliveryRuns: () => {}, openTaskRunWorkspace: async () => {}, openAgentSession: async () => {},
});
await unreadController.openNetworkConversation('friend-unread', 'person');
assert.equal(markedUnreadCount, 0, 'an unread message must not be acknowledged when the conversation render fails');
assert.equal(unreadRenderCount, 2, 'the failure must occur when the loaded message detail is rendered');

console.log('network contact transition smoke passed (direct contact switch and organization-contact uBuddy mention)');
