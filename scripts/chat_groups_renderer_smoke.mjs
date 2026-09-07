import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderSocialEditModal } from '../src/renderer/app/components/overlays.js';
import { renderChatGroupInviteDialog } from '../src/renderer/app/components/chatGroupDialogs.js';
import { createComposerDraftController } from '../src/renderer/app/features/chat/composerDraftController.js';
import { createNetworkMessageController } from '../src/renderer/app/features/network/messageController.js';
import { updateChatGroupMemberSelection } from '../src/renderer/app/utils/chatGroupMemberSelection.js';
import { socialMentionTriggerRemoved } from '../src/renderer/app/utils/mentionPicker.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderContactsWorkspace, renderGroupProfileDialog, renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import { renderSidebar, renderTopbar } from '../src/renderer/app/views/navigationView.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';

const aliceAvatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';
const bobAvatar = 'https://avatars.example.test/bob.png';
state.currentUser = { id: 'alice', displayName: 'Alice', username: 'alice', avatarUrl: aliceAvatar, avatar_url: aliceAvatar };
state.activeAccountWorkspace = { id: 'workspace_personal', kind: 'personal', name: '个人' };
state.accountWorkspaces = [state.activeAccountWorkspace];
state.networkPanelOpen = true;
state.networkPanelView = 'messages';
state.networkMessageHomeOpen = true;
state.chatAvatarProfile = null;
state.socialStatus = { connected: false };
state.friendOverview = {
  friends: [{ friend: { id: 'bob', displayName: 'Bob', username: 'bob', avatarUrl: bobAvatar } }],
  requests: { incoming: [], outgoing: [] },
  organizations: [],
};
state.socialThreads = [];
state.chatGroupsOverview = {
  capability: 'chat-groups-v2',
  groups: [{ id: 'chat_1', title: '产品讨论组', status: 'active', memberCount: 2, unreadCount: 1, lastMessage: 'Bob：明天评审',
    lastMessageContent: '明天评审', lastMessageSenderUserId: 'bob', lastMessageSenderName: 'Bob', updatedAt: '2026-08-01T10:00:00.000Z' }],
};
state.collaborationOverview = {
  groups: [{ id: 'work_1', title: 'uBuddy 发布项目', status: 'active', memberCount: 2, unreadCount: 0, lastMessage: '正在执行', updatedAt: '2026-08-01T09:00:00.000Z' }],
  tasks: [],
};

const panel = renderNetworkPanel();
assert.match(panel, /data-chat-group="chat_1"/);
assert.match(panel, /im-conversation-preview-prefix"[^>]*>Bob · <\/span><span[^>]*>明天评审<\/span>/);
assert.match(panel, />工作群</);
assert.match(panel, /natural-group-avatar">产</);
assert.doesNotMatch(panel, /data-chat-group-create-open/);
assert.doesNotMatch(panel, /is-create-group/);
assert.doesNotMatch(panel, />任务群</);

state.chatGroupsOverview.groups[0] = {
  ...state.chatGroupsOverview.groups[0],
  lastMessage: 'Alice：收到',
  lastMessageContent: '收到',
  lastMessageSenderUserId: 'alice',
  lastMessageSenderName: 'Alice',
};
const selfGroupPreviewPanel = renderNetworkPanel();
assert.match(selfGroupPreviewPanel, /class="network-message-preview"><span[^>]*>收到<\/span><\/span>/);
assert.doesNotMatch(selfGroupPreviewPanel, /im-conversation-preview-prefix">Alice/);
state.chatGroupsOverview.groups[0] = {
  ...state.chatGroupsOverview.groups[0],
  lastMessage: 'Bob：明天评审',
  lastMessageContent: '明天评审',
  lastMessageSenderUserId: 'bob',
  lastMessageSenderName: 'Bob',
};

state.networkMessageHomeOpen = false;
state.chatGroupId = 'chat_1';
state.chatGroupDetail = {
  group: state.chatGroupsOverview.groups[0],
  membership: { groupId: 'chat_1', userId: 'alice', role: 'owner', status: 'active' },
  members: [
    { groupId: 'chat_1', userId: 'alice', role: 'owner', status: 'active', user: state.currentUser },
    { groupId: 'chat_1', userId: 'bob', role: 'member', status: 'active', user: { id: 'bob', displayName: 'Bob', avatarUrl: bobAvatar } },
  ],
  messages: [
    { id: 'msg_1', groupId: 'chat_1', senderUserId: 'bob', kind: 'friend', content: '明天评审', sender: { id: 'bob', displayName: 'Bob', avatarUrl: bobAvatar }, createdAt: '2026-08-01T10:00:00.000Z' },
    { id: 'msg_2', groupId: 'chat_1', senderUserId: 'alice', kind: 'friend', content: '收到', sender: state.currentUser,
      receiptSummary: { total: 1, read: 0, unread: 1 },
      receiptDetails: [{ userId: 'bob', read: false, readAt: '', user: { id: 'bob', displayName: 'Bob', avatarUrl: bobAvatar } }],
      createdAt: '2026-08-01T10:01:00.000Z' },
    { id: 'msg_file', groupId: 'chat_1', senderUserId: 'bob', kind: 'friend', content: '分享了附件。', sender: { id: 'bob', displayName: 'Bob' },
      metadata: { attachments: [{ id: 'file_1', name: 'analysis.py', filename: 'analysis.py', kind: 'code', size: 128 }] }, createdAt: '2026-08-01T10:01:30.000Z' },
    { id: 'msg_3', groupId: 'chat_1', senderUserId: 'alice', kind: 'friend', content: '不应显示的撤回正文', sender: state.currentUser,
      metadata: { withdrawn: true, withdrawnAt: '2026-08-01T10:02:30.000Z' }, createdAt: '2026-08-01T10:02:00.000Z' },
    { id: 'msg_4', groupId: 'chat_1', senderUserId: 'alice', kind: 'friend', content: '撤回后的新消息', sender: state.currentUser,
      createdAt: '2026-08-01T10:03:00.000Z' },
    { id: 'msg_ubuddy_request', groupId: 'chat_1', senderUserId: 'bob', kind: 'friend', content: '@我的uBuddy 请整理验收清单', sender: { id: 'bob', displayName: 'Bob' },
      metadata: { mentions: [{ principalType: 'ubuddy', ownerUserId: 'alice', displayText: '@我的uBuddy', mentionId: 'mention_ubuddy_1', source: 'picker' }] },
      createdAt: '2026-08-01T10:03:30.000Z' },
    { id: 'msg_peer_ubuddy', groupId: 'chat_1', senderUserId: 'bob', senderAgentId: 'secretary_agent', kind: 'agent',
      content: 'Bob 的 uBuddy 已同步最新进展。', sender: { id: 'bob', displayName: 'Bob', avatarUrl: bobAvatar },
      createdAt: '2026-08-01T10:03:45.000Z' },
    { id: 'msg_multi_task', groupId: 'chat_1', senderUserId: 'alice', senderAgentId: 'secretary_agent', kind: 'agent',
      content: 'uBuddy 已完成多人分工并创建关联任务群，共派发 2 项任务：Bob、Carol。', sender: state.currentUser,
      metadata: { type: 'ubuddy_multi_task_status', status: 'dispatched', collaborationGroupId: 'work_multi_1', assignmentCount: 2, participantLabels: ['Bob', 'Carol'] },
      createdAt: '2026-08-01T10:04:00.000Z' },
    { id: 'msg_multi_confirm', groupId: 'chat_1', senderUserId: 'alice', senderAgentId: 'secretary_agent', kind: 'agent',
      content: '这项多人任务包含高风险操作，尚未派发。', sender: state.currentUser,
      metadata: { type: 'ubuddy_multi_task_status', status: 'confirmation_required', ownerUserId: 'alice', confirmationCommandId: 'risk-command-1' },
      createdAt: '2026-08-01T10:05:00.000Z' },
    { id: 'msg_multi_waiting', groupId: 'chat_1', senderUserId: 'alice', senderAgentId: 'secretary_agent', kind: 'agent',
      content: '已派发 2/3 项分工；测试账号 09 当前离线。', sender: state.currentUser,
      metadata: { type: 'ubuddy_multi_task_status', status: 'awaiting_presence', ownerUserId: 'alice',
        dispatchCommandId: 'partial-dispatch-1', assignmentCount: 3, publishedRecipientCount: 2,
        pendingRecipientCount: 1, pendingRecipientLabels: ['测试账号 09'] },
      createdAt: '2026-08-01T10:05:30.000Z' },
  ],
};
state.socialMentionMenuOpen = true;
const chat = renderChat();
assert.equal(renderTopbar(), '', 'group chat must not reserve a second close-button toolbar above the group header');
assert.match(chat, /产品讨论组/);
assert.match(chat, /2 位成员/);
assert.match(chat, /class="social-group-detail-button"/);
assert.match(chat, /data-chat-group-detail-open="chat_1"/);
assert.doesNotMatch(chat, /data-chat-group-members-toggle/);
assert.doesNotMatch(chat, /class="social-group-settings"/);
assert.match(chat, /明天评审/);
assert.equal((chat.match(/data-message-home-back/g) || []).length, 1);
assert.match(chat, /id="chat-form"/);
assert.match(chat, /@我的uBuddy/);
assert.match(chat, /data-social-mention-audience="human_members"/);
assert.match(chat, /data-social-mention-audience="member_ubuddies"/);
assert.match(chat, /data-message-receipt="msg_2"/);
assert.match(chat, /--receipt-segments:1/);
state.messageReceiptPopover = { messageId: 'msg_2', details: state.chatGroupDetail.messages[1].receiptDetails, left: 20, top: 30 };
const receiptPopover = renderChat();
assert.match(receiptPopover, /class="message-receipt-popover"/);
assert.match(receiptPopover, /<strong>1<\/strong><span>未读<\/span>/);
state.messageReceiptPopover = null;
assert.match(chat, /class="message assistant[^>]*data-message-id="msg_1"/);
assert.match(chat, /class="message user[^>]*data-message-id="msg_2"/);
assert.match(chat, /class="message assistant[^>]*is-human-message[^>]*is-ubuddy-group-human[^>]*data-message-id="msg_1"/);
assert.match(chat, /class="message assistant[^>]*is-ubuddy-work-request[^>]*data-message-id="msg_ubuddy_request"/);
assert.match(chat, /<mark class="social-mention-token">@我的uBuddy<\/mark> 请整理验收清单/);
assert.match(chat, /你撤回了一条群聊消息/);
assert.match(chat, /data-withdrawn-message-edit="msg_3"/);
assert.doesNotMatch(chat, /不应显示的撤回正文/);
const postWithdrawGroupMessageIndex = chat.indexOf('data-message-id="msg_4"');
const postWithdrawGroupMessage = chat.slice(chat.lastIndexOf('<article', postWithdrawGroupMessageIndex), chat.indexOf('</article>', postWithdrawGroupMessageIndex) + '</article>'.length);
assert.match(postWithdrawGroupMessage, /chat-message-avatar is-person is-self/);
assert.doesNotMatch(postWithdrawGroupMessage, /chat-message-avatar-spacer/);
assert.match(postWithdrawGroupMessage, /class="social-message-actor"/);
assert.match(chat, /analysis\.py/);
assert.match(chat, /message-attachment-card/);
assert.equal((chat.match(/data-user-avatar-image/g) || []).length >= 2, true);
assert.equal(chat.includes(`src="${aliceAvatar}"`), true);
assert.equal(chat.includes(`src="${bobAvatar}"`), true);
const peerGroupUBuddyIndex = chat.indexOf('data-message-id="msg_peer_ubuddy"');
const peerGroupUBuddyMessage = chat.slice(chat.lastIndexOf('<article', peerGroupUBuddyIndex), chat.indexOf('</article>', peerGroupUBuddyIndex) + '</article>'.length);
assert.match(peerGroupUBuddyMessage, /data-ubuddy-owner-user="bob"/,
  'ordinary multi-person chats should identify the account that owns a peer uBuddy');
assert.match(peerGroupUBuddyMessage, /class="ubuddy-owner-avatar has-custom-avatar"[^]*src="https:\/\/avatars\.example\.test\/bob\.png"/,
  'the composite badge must reuse the same current user object and avatar URL as the group participant');
assert.match(chat, /data-chat-avatar-profile="bob"/);
assert.match(chat, /data-chat-avatar-profile-context="group"/);
assert.match(chat, /aria-haspopup="dialog"/);
assert.match(chat, /aria-expanded="false"/);
assert.doesNotMatch(chat, /data-chat-avatar-profile="alice"/);
assert.match(chat, /uBuddy 多人协作/);
assert.match(chat, /多人任务已派发/);
assert.match(chat, /data-collaboration-group="work_multi_1"/);
assert.match(chat, /Bob、Carol · 2 项分工/);
assert.match(chat, /多人任务需要确认/);
assert.match(chat, /data-confirm-multi-task="risk-command-1"/);
assert.match(chat, /测试账号 09 当前离线/);
assert.match(chat, /data-cancel-pending-dispatch="partial-dispatch-1"[^>]*>取消未上线成员补派<\/button>/);
const multiTaskCardIndex = chat.indexOf('data-message-id="msg_multi_task"');
const multiTaskCard = chat.slice(chat.lastIndexOf('<article', multiTaskCardIndex), chat.indexOf('</article>', multiTaskCardIndex) + '</article>'.length);
assert.doesNotMatch(multiTaskCard, /is-human-message|is-ubuddy-group-human|is-ubuddy-work-request/);

state.chatAvatarProfile = { userId: 'bob', context: 'group', left: 80, top: 96 };
const groupProfilePopover = renderChat();
assert.match(groupProfilePopover, /class="chat-avatar-profile-popover"/);
assert.match(groupProfilePopover, /id="chat-avatar-profile-popover"/);
assert.match(groupProfilePopover, /aria-expanded="true"/);
assert.match(groupProfilePopover, /style="left:80px;top:96px"/);
assert.match(groupProfilePopover, /data-chat-avatar-profile-message="bob"/);
assert.match(groupProfilePopover, />发起私聊</);

state.chatGroupId = '';
state.chatGroupDetail = null;
state.networkConversationPeerId = 'bob';
state.networkConversationMode = 'person';
state.networkConversationMessages = [{
  id: 'direct_bob_message', senderUserId: 'bob', recipientUserId: 'alice', content: '私聊消息',
  sender: { id: 'bob', displayName: 'Bob', username: 'bob', avatarUrl: bobAvatar }, createdAt: '2026-08-01T10:05:00.000Z',
}];
state.chatAvatarProfile = { userId: 'bob', context: 'direct', left: 80, top: 96 };
const directProfilePopover = renderChat();
assert.match(directProfilePopover, /data-chat-avatar-profile="bob"/);
assert.match(directProfilePopover, /data-chat-avatar-profile-context="direct"/);
assert.match(directProfilePopover, /class="chat-avatar-profile-popover"/);
assert.doesNotMatch(directProfilePopover, /data-chat-avatar-profile-message=/);

state.chatAvatarProfile = null;
state.networkConversationMessages = [{
  id: 'direct_own_ubuddy_result', senderUserId: 'alice', recipientUserId: 'bob',
  senderAgentId: 'secretary_agent', kind: 'agent', content: '任务结果已完成。',
  metadata: {
    type: 'agent_delegation', action: 'submit', delegationId: 'direct_delegation_1',
    attachments: [{
      remote_file_id: 'direct-delivery-file', remote_file_kind: 'collaboration_task',
      filename: '交付报告.docx', content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 2048, sha256: 'direct-delivery-sha256',
    }],
  },
  createdAt: '2026-08-01T10:06:00.000Z',
}];
state.languageMode = 'zh-CN';
const ownUBuddyDirectMessage = renderChat();
assert.match(ownUBuddyDirectMessage, /direct-social-message has-chat-avatar[^>]*is-agent-message/);
assert.match(ownUBuddyDirectMessage, /message assistant social-group-message direct-social-message/);
assert.match(ownUBuddyDirectMessage, /chat-message-avatar is-agent[^>]*is-ubuddy/);
assert.match(ownUBuddyDirectMessage, />我的 uBuddy</);
assert.match(ownUBuddyDirectMessage, /任务结果已完成/);
assert.match(ownUBuddyDirectMessage, /交付报告\.docx/);
assert.match(ownUBuddyDirectMessage, /direct-delivery-file/);
assert.match(ownUBuddyDirectMessage, /data-task-card-action="open_result"/);
assert.match(ownUBuddyDirectMessage, /data-task-workspace-kind="delegation"/);
assert.match(ownUBuddyDirectMessage, /data-task-workspace-id="direct_delegation_1"/);
assert.match(ownUBuddyDirectMessage, />查看交付</);
assert.doesNotMatch(ownUBuddyDirectMessage, /data-network-delegation="direct_delegation_1"/);
assert.doesNotMatch(ownUBuddyDirectMessage, /仅自己可见/);
assert.doesNotMatch(ownUBuddyDirectMessage, /ubuddy-owner-avatar|has-owner-avatar/,
  'my own uBuddy should keep the clean primary avatar without a redundant account badge');

state.languageMode = 'en';
const ownUBuddyEnglishDelivery = renderChat();
assert.match(ownUBuddyEnglishDelivery, />View Delivery</);
state.languageMode = 'zh-CN';

const ownUBuddyDirectRecord = state.networkConversationMessages[0];
state.networkConversationMessages = [{
  id: 'direct_peer_ubuddy_result', senderUserId: 'bob', recipientUserId: 'alice',
  senderAgentId: 'secretary_agent', kind: 'agent', content: '对方任务结果已完成。',
  createdAt: '2026-08-01T10:06:30.000Z',
}];
const peerUBuddyDirectMessage = renderChat();
assert.match(peerUBuddyDirectMessage, /chat-message-avatar is-agent[^>]*is-ubuddy[^>]*has-owner-avatar/);
assert.match(peerUBuddyDirectMessage, /data-ubuddy-owner-user="bob"/);
assert.match(peerUBuddyDirectMessage, /class="ubuddy-owner-avatar has-custom-avatar"/);
assert.match(peerUBuddyDirectMessage, new RegExp(`src="${bobAvatar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
assert.match(peerUBuddyDirectMessage, /title="Bob的账号头像"/);
assert.match(peerUBuddyDirectMessage, />Bob 的 uBuddy</);

state.networkConversationMessages = [{ ...ownUBuddyDirectRecord, content: '| 交付项 | 状态 |\n| --- | --- |\n| 中文文档 | 已完成 |' }];
const ownUBuddyTableDelivery = renderChat();
assert.match(ownUBuddyTableDelivery, /class="message-table-scroll"/);
assert.match(ownUBuddyTableDelivery, /class="message-markdown-table" data-column-count="2"/);
assert.match(ownUBuddyTableDelivery, /<colgroup><col \/><col \/><\/colgroup>/);
assert.match(ownUBuddyTableDelivery, /<td data-column-label="交付项"><span class="message-table-cell-content">中文文档<\/span><\/td>/);
assert.match(ownUBuddyTableDelivery, /<th>交付项<\/th><th>状态<\/th>/);

state.agentDelegations = [{
  id: 'direct_delegation_assigned', title: '撰写技术调研',
  metadata: { assignedAgentIds: ['general_agent'] },
}];
state.languageMode = 'zh-CN';
state.org = { ...(state.org || {}), agents: [{ id: 'general_agent', name: 'Generalist' }] };
state.networkConversationMessages = [{
  id: 'direct_ubuddy_assignment', senderUserId: 'alice', recipientUserId: 'bob',
  senderAgentId: 'secretary_agent', kind: 'agent',
  content: '任务目标：撰写技术调研\n交付物：Word 文档；Markdown 文档\n验收标准：结构完整；关键事实有来源\n约束：中文撰写\n隐私范围：direct_delegation\n风险等级：low',
  metadata: { type: 'agent_delegation', action: 'assigned', delegationId: 'direct_delegation_assigned' },
  createdAt: '2026-08-01T10:07:00.000Z',
}];
const assignedUBuddyDirectMessage = renderChat();
assert.match(assignedUBuddyDirectMessage, /class="message-body direct-delegation-summary"/);
assert.match(assignedUBuddyDirectMessage, /<ul><li><strong>任务目标：<\/strong>撰写技术调研<\/li>/);
assert.match(assignedUBuddyDirectMessage, /<li><strong>交付物：<\/strong><strong>Word<\/strong> 文档；<strong>Markdown<\/strong> 文档<\/li>/);
assert.match(assignedUBuddyDirectMessage, /<li><strong>验收标准：<\/strong>结构完整；关键事实有来源<\/li>/);
assert.match(assignedUBuddyDirectMessage, /<li><strong>执行 Agent：<\/strong>Generalist<\/li>/);
assert.doesNotMatch(assignedUBuddyDirectMessage, /<dl>|<dt>|message-markdown-table/);
assert.match(assignedUBuddyDirectMessage, /data-network-delegation="direct_delegation_assigned"/);
assert.match(assignedUBuddyDirectMessage, /前往任务工作区/);
assert.doesNotMatch(assignedUBuddyDirectMessage, /隐私范围|风险等级/);

state.languageMode = 'en';
const assignedUBuddyEnglishMessage = renderChat();
assert.match(assignedUBuddyEnglishMessage, /<ul><li><strong>Objective: <\/strong>撰写技术调研<\/li>/);
assert.match(assignedUBuddyEnglishMessage, /<li><strong>Deliverables: <\/strong><strong>Word<\/strong> 文档; <strong>Markdown<\/strong> 文档<\/li>/);
assert.match(assignedUBuddyEnglishMessage, /<li><strong>Acceptance criteria: <\/strong>结构完整; 关键事实有来源<\/li>/);
assert.match(assignedUBuddyEnglishMessage, /<li><strong>Execution Agent: <\/strong>Generalist<\/li>/);
state.languageMode = 'zh-CN';

state.networkMessageHomeOpen = true;
state.socialThreads = [{
  friend: { id: 'bob', displayName: 'Bob' },
  messages: state.networkConversationMessages,
}];
const delegationConversationList = renderNetworkPanel();
assert.match(delegationConversationList, /data-network-peer="bob"/);
assert.match(delegationConversationList, /撰写技术调研/);

state.networkConversationPeerId = '';
state.networkConversationMessages = [];
state.chatGroupId = 'chat_1';
state.chatGroupDetail = {
  group: state.chatGroupsOverview.groups[0],
  membership: { groupId: 'chat_1', userId: 'alice', role: 'owner', status: 'active' },
  members: [
    { groupId: 'chat_1', userId: 'alice', role: 'owner', status: 'active', user: state.currentUser },
    { groupId: 'chat_1', userId: 'bob', role: 'member', status: 'active', user: { id: 'bob', displayName: 'Bob', avatarUrl: bobAvatar } },
  ],
  messages: [],
};
state.chatAvatarProfile = null;

state.networkGroupProfileOpen = true;
state.networkSelectedGroupKind = 'contact';
state.networkSelectedGroupId = 'chat_1';
state.groupDirectoryProfileDetail = state.chatGroupDetail;
const activeGroupProfile = renderGroupProfileDialog();
assert.match(activeGroupProfile, /group-profile-drawer/);
assert.match(activeGroupProfile, /当前群聊/);
assert.match(activeGroupProfile, /disabled/);
assert.match(activeGroupProfile, /data-chat-group-invite-open/);
assert.match(activeGroupProfile, /data-chat-group-rename/);
assert.match(activeGroupProfile, /data-chat-group-dissolve/);
assert.match(activeGroupProfile, /data-group-display-name="chat_1"/);
assert.equal((activeGroupProfile.match(/data-user-avatar-image/g) || []).length, 2);
assert.doesNotMatch(activeGroupProfile, /data-group-profile-message="chat_1"/);
assert.doesNotMatch(activeGroupProfile, /group-profile-archive-button/);
assert.doesNotMatch(activeGroupProfile, /data-conversation-archive="chat-group:chat_1"/);

state.groupDirectoryProfileDetail = {
  ...state.chatGroupDetail,
  group: { ...state.chatGroupDetail.group, status: 'dissolved', archived: false },
};
const endedGroupProfile = renderGroupProfileDialog();
assert.match(endedGroupProfile, /group-profile-archive-button/);
assert.match(endedGroupProfile, /data-conversation-archive="chat-group:chat_1"/);
assert.doesNotMatch(endedGroupProfile, /<span>归档群聊<\/span>/);
state.groupDirectoryProfileDetail = state.chatGroupDetail;
state.networkGroupProfileOpen = false;

state.socialEditDialog = {
  type: 'chat-group-rename',
  targetId: 'chat_1',
  subtitle: '保存后会同步更新消息列表、聊天标题和群聊详情',
  draft: '产品讨论组',
  error: '群聊名称不能为空。',
};
const renameDialog = renderSocialEditModal();
assert.match(renameDialog, /id="social-edit-input"[^>]*required/);
assert.match(renameDialog, /群聊名称不能为空/);
assert.match(renameDialog, />取消</);
assert.match(renameDialog, />保存</);
state.socialEditDialog = null;

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererSource, /action: 'withdraw_message'/);
assert.match(rendererSource, /state\.chatGroupDetail\?\.messages/);
assert.match(rendererSource, /type: 'chat-group-rename'/);
assert.match(rendererSource, /updateChatGroupById\(id, 'rename', \{ title \}\)/);
assert.match(rendererSource, /action: 'set_display_name', displayName/);
assert.match(rendererSource, /data-group-display-name/);
assert.match(rendererSource, /data-organization-display-name/);
assert.match(rendererSource, /data-organization-name-form/);
assert.match(rendererSource, /data-organization-name-dblclick/);
assert.match(rendererSource, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
assert.match(rendererSource, /\$\{state\.networkGroupProfileOpen \? renderGroupProfileDialog\(\) : ''\}[\s\S]*?\$\{renderChatGroupInviteDialog\(\)\}/);
assert.match(rendererSource, /socialMentionTriggerRemoved\(previousDraft, state\.chatDraft\)[\s\S]*?closeComposerMentionPicker/);
assert.equal(socialMentionTriggerRemoved('@', ''), true);
assert.equal(socialMentionTriggerRemoved('请联系 @Bob', '请联系 Bob'), true);
assert.equal(socialMentionTriggerRemoved('', '普通消息'), false);
assert.equal(socialMentionTriggerRemoved('@', '@B'), false);
assert.match(rendererSource, /data-chat-avatar-profile-message/);
assert.match(rendererSource, /openNetworkConversation\(peerId, 'person'\)/);
assert.match(rendererSource, /event\.key !== 'Escape'/);
assert.match(rendererSource, /closeChatAvatarProfile\(\)/);
assert.match(rendererSource, /preventScroll: true/);
assert.match(rendererSource, /chatGroupCreateSelectAll\.indeterminate/);
assert.match(rendererSource, /shiftKey: event\.shiftKey/);
assert.match(rendererSource, /class="main \$\{topbarMarkup \? 'has-topbar' : 'without-topbar'\}"/);
const mentionOutsideCloseSource = rendererSource.match(/function closeComposerMentionPickerOnOutsideClick[\s\S]*?\n}/)?.[0] || '';
assert.match(mentionOutsideCloseSource, /composerMentionPickerOpen\(\)/);
assert.match(mentionOutsideCloseSource, /closest\?\.\('\.social-mention-picker'\)/);
assert.match(mentionOutsideCloseSource, /closeComposerMentionPicker\(\)/);
const networkCss = readFileSync(new URL('../src/renderer/styles/network.css', import.meta.url), 'utf8');
assert.match(networkCss, /\.contacts-list-pane\.contacts-groups-pane\s*\{\s*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/);
assert.match(networkCss, /\.contacts-groups-head > button\s*\{[\s\S]*?width:\s*auto/);
assert.match(networkCss, /\.shell > \.group-profile-scrim\s*\{[\s\S]*?justify-content:\s*flex-end/);
assert.match(networkCss, /\.friend-search-dialog-scrim,[\s\S]*?\.contact-profile-scrim\s*\{[\s\S]*?z-index:\s*60/);
assert.match(networkCss, /\.chat-group-invite-overlay\s*\{[\s\S]*?z-index:\s*420/);
assert.match(networkCss, /\.chat-group-create-selection-bar\s*\{[\s\S]*?flex-wrap:\s*nowrap/);
assert.match(networkCss, /\.group-profile-settings > div > button\.group-profile-archive-button\s*\{[\s\S]*?width:\s*42px/);
const chatCss = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(chatCss, /\.direct-delegation-summary\s*\{[\s\S]*?padding:\s*14px 18px !important;[\s\S]*?font-size:\s*13px !important;[\s\S]*?line-height:\s*1\.65 !important;/);
assert.match(chatCss, /\.direct-delegation-summary ul\s*\{[\s\S]*?gap:\s*9px;[\s\S]*?padding-left:\s*17px;/);
assert.match(chatCss, /\.social-mention-menu\s*\{[^}]*max-height:\s*min\(420px, 58vh\);[^}]*overflow-y:\s*auto;/s);
const baseCss = readFileSync(new URL('../src/renderer/styles/base.css', import.meta.url), 'utf8');
assert.match(baseCss, /\.window-titlebar\s*\{[\s\S]*?-webkit-app-region:\s*no-drag/);
assert.match(baseCss, /\.window-drag-handle\s*\{[\s\S]*?-webkit-app-region:\s*drag/);
const workspaceCss = readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(workspaceCss, /\.main\.without-topbar\s*\{\s*grid-template-rows:\s*minmax\(0, 1fr\)/);
assert.match(workspaceCss, /\.chat-view\.with-messages \.social-group-actions > \.social-group-detail-button\s*\{[\s\S]*?color:\s*var\(--ui-muted\);[\s\S]*?background:\s*transparent/);
assert.match(workspaceCss, /\.social-group-detail-button:focus-visible\s*\{[\s\S]*?color:\s*var\(--ui-accent-strong\);[\s\S]*?background:\s*var\(--ui-surface-hover\)/);

state.activeAccountWorkspace = { id: 'workspace_org_acme', kind: 'organization', organizationId: 'org_acme', name: '分布式系统实验室' };
state.startupAccountWorkspace = state.activeAccountWorkspace;
state.accountWorkspaces = [
  { id: 'workspace_personal', kind: 'personal', name: '个人' },
  state.activeAccountWorkspace,
];
state.friendOverview = {
  friends: [{ friend: { id: 'friend_only', displayName: '个人好友' } }, { friend: { id: 'coworker_only', displayName: '组织同事' } }],
  organizations: [{ id: 'org_acme', name: '分布式系统实验室', organizationNumber: 'dist-systems-lab', role: 'owner', members: [
    { user: state.currentUser, role: 'owner' },
    { user: { id: 'coworker_only', displayName: '组织同事' }, role: 'member' },
  ] }],
};
state.chatGroupId = '';
state.chatGroupDetail = null;
state.networkMessageHomeOpen = true;
state.networkPanelView = 'friends';
state.friendDirectoryCategory = 'groups';
state.friendDirectoryView = 'contacts';
state.contactGroupDirectoryTab = 'contact';
state.chatGroupCreateOpen = true;
const directoryPanel = renderNetworkPanel();
assert.match(directoryPanel, />组织内联系人</);
assert.match(directoryPanel, />外部联系人</);
assert.match(directoryPanel, />新的联系人</);
assert.match(directoryPanel, />星标联系人</);
assert.match(directoryPanel, />我的群组</);
assert.match(directoryPanel, /分布式系统实验室/);
assert.match(directoryPanel, /当前组织 · 默认组织/);
assert.doesNotMatch(directoryPanel, />个人</);
assert.doesNotMatch(directoryPanel, />我的组织</);

state.friendSearchQuery = '组织同事';
const internalSearchPanel = renderNetworkPanel();
assert.match(internalSearchPanel, /data-directory-search-category="internal"/);
assert.match(internalSearchPanel, /组织内联系人/);
assert.match(internalSearchPanel, /组织同事/);
state.friendSearchQuery = '个人好友';
const externalSearchPanel = renderNetworkPanel();
assert.match(externalSearchPanel, /data-directory-search-category="external"/);
assert.match(externalSearchPanel, /外部联系人/);
state.friendSearchQuery = '产品讨论';
const contactGroupSearchPanel = renderNetworkPanel();
assert.match(contactGroupSearchPanel, /data-directory-search-category="contact-groups"/);
assert.match(contactGroupSearchPanel, /联系人群聊/);
state.friendSearchQuery = 'uBuddy 发布';
const workGroupSearchPanel = renderNetworkPanel();
assert.match(workGroupSearchPanel, /data-directory-search-category="work-groups"/);
assert.match(workGroupSearchPanel, /工作群组/);
state.friendSearchQuery = '';

const organizationWorkspace = renderContactsWorkspace();
assert.match(organizationWorkspace, />联系人群聊</);
assert.match(organizationWorkspace, />工作群组</);
assert.match(organizationWorkspace, /data-chat-group-create-open/);
assert.match(organizationWorkspace, /data-chat-group-create-overlay/);
assert.match(organizationWorkspace, /class="chat-group-create-close"/);
assert.match(organizationWorkspace, /class="chat-group-create-members" data-preserve-scroll data-scroll-key="chat-group-create-members"/);
assert.match(organizationWorkspace, /data-chat-group-create-select-all/);
assert.match(organizationWorkspace, /data-chat-group-create-selected-count>已选 0 \/ 2/);
assert.match(organizationWorkspace, /value="coworker_only"/);
assert.match(organizationWorkspace, /value="friend_only"/);
assert.match(organizationWorkspace, /组织内联系人/);
assert.match(organizationWorkspace, /外部联系人/);

const orderedMemberIds = ['one', 'two', 'three', 'four', 'five'];
assert.deepEqual(updateChatGroupMemberSelection({
  memberIds: orderedMemberIds, selectedIds: ['two'], anchorId: 'two', currentId: 'four', checked: true, shiftKey: true,
}), ['two', 'three', 'four']);
assert.deepEqual(updateChatGroupMemberSelection({
  memberIds: orderedMemberIds, selectedIds: orderedMemberIds, anchorId: 'four', currentId: 'two', checked: false, shiftKey: true,
}), ['one', 'five']);

state.chatGroupCreateOpen = false;
state.networkGroupProfileOpen = true;
state.networkSelectedGroupKind = 'contact';
state.networkSelectedGroupId = 'chat_1';
state.groupDirectoryProfileDetail = {
  group: state.chatGroupsOverview.groups[0],
  membership: { userId: 'alice', role: 'owner', status: 'active' },
  members: [
    { userId: 'alice', role: 'owner', status: 'active', user: state.currentUser },
    { userId: 'bob', role: 'member', status: 'active', user: { id: 'bob', displayName: 'Bob' } },
  ],
};
state.groupDirectoryPreferences = { starred: { 'contact:chat_1': true }, remarks: { 'contact:chat_1': '评审群' } };
const contactGroupProfile = `${renderContactsWorkspace()}${renderGroupProfileDialog()}`;
assert.match(contactGroupProfile, /data-contact-group-profile="chat_1"/);
assert.match(contactGroupProfile, /group-profile-drawer/);
assert.match(contactGroupProfile, /评审群/);
assert.match(contactGroupProfile, /data-group-profile-message="chat_1"/);
assert.match(contactGroupProfile, /data-group-star-toggle="chat_1"/);
assert.match(contactGroupProfile, /data-group-remark="chat_1"/);
assert.match(contactGroupProfile, /data-group-display-name="chat_1"/);
assert.match(contactGroupProfile, /data-chat-group-invite-open/);
assert.doesNotMatch(contactGroupProfile, /data-chat-group="chat_1"/);

const sentGroupPayloads = [];
const controllerState = {
  chatGroupId: 'chat_1',
  chatGroupDetail: { group: { id: 'chat_1', status: 'active' }, messages: [] },
  chatGroupDetailCache: {},
  chatDraft: '',
  attachments: [{ id: 'pending_file', status: 'done', uploaded: { id: 'local_file' } }],
  messageQuote: null,
  networkConversationBusy: false,
  composerMentions: [],
  currentUser: { id: 'alice' },
  networkConversationDrafts: { 'chat-group:chat_1': '' },
};
const sentAttachment = { id: 'remote_file', remote_file_id: 'remote_file', remote_file_kind: 'chat_group', group_id: 'chat_1', name: 'report.docx' };
const controller = createNetworkMessageController({
  api: {
    async sendChatGroupMessage(payload) {
      sentGroupPayloads.push(payload);
      return { group: { id: 'chat_1', status: 'active' }, messages: [{ id: payload.clientMessageId, content: payload.content, metadata: payload.metadata }] };
    },
    async chatGroupsOverview() { return { groups: [] }; },
  },
  documentRef: { getElementById: () => ({ value: '' }) },
  state: controllerState,
  render() {},
  notify(message) { throw new Error(message); },
  readyAttachmentsForSend: async () => [sentAttachment],
  currentModelValue: () => 'gpt-5',
  currentReasoningValue: () => 'medium',
  selectedSocialTaskGroup: () => null,
  networkConversationDraftKey: () => 'chat-group:chat_1',
  persistComposerDrafts() {},
  refreshSocialThreads: async () => {},
  scrollMessagesToBottom() {},
  focusChatInputAtEnd() {},
  userErrorMessage: (error) => error?.message || String(error),
  refreshCollaborationOverview: async () => {},
});
await controller.sendChatGroupMessage();
assert.equal(sentGroupPayloads.length, 1);
assert.equal(sentGroupPayloads[0].content, '分享了附件。');
assert.deepEqual(sentGroupPayloads[0].metadata.attachments, [sentAttachment]);
assert.deepEqual(controllerState.attachments, []);

const multiContent = '@Bob的uBuddy 做一份数学复习文档 @Carol的uBuddy 做一份物理复习文档';
const multiDispatchPayloads = [];
let multiBusyDuringDispatch = true;
let multiDraftDuringDispatch = 'not-cleared';
const multiControllerState = {
  ...controllerState,
  chatDraft: multiContent,
  attachments: [],
  composerMentions: [
    { principalType: 'ubuddy', ownerUserId: 'bob', displayText: '@Bob的uBuddy', mentionId: 'multi-bob', source: 'picker' },
    { principalType: 'ubuddy', ownerUserId: 'carol', displayText: '@Carol的uBuddy', mentionId: 'multi-carol', source: 'picker' },
  ],
  networkConversationBusy: false,
};
const multiController = createNetworkMessageController({
  api: {
    async sendChatGroupMessage(payload) {
      sentGroupPayloads.push(payload);
      return { group: { id: 'chat_1', status: 'active', workspaceId: 'workspace_personal' }, messages: [{ id: payload.clientMessageId, content: payload.content, metadata: payload.metadata }] };
    },
    async dispatchCollaborationCommand(payload) {
      multiDispatchPayloads.push(payload);
      multiBusyDuringDispatch = multiControllerState.networkConversationBusy;
      multiDraftDuringDispatch = multiControllerState.chatDraft;
      return { dispatched: false, queued: true, commandId: 'queued-multi-1' };
    },
    async chatGroup() { return { group: { id: 'chat_1', status: 'active' }, messages: [] }; },
    async chatGroupsOverview() { return { groups: [] }; },
  },
  documentRef: { getElementById: () => ({ value: multiContent }) },
  state: multiControllerState,
  render() {},
  notify() {},
  readyAttachmentsForSend: async () => [],
  currentModelValue: () => 'gpt-5',
  currentReasoningValue: () => 'medium',
  selectedSocialTaskGroup: () => null,
  networkConversationDraftKey: () => 'chat-group:chat_1',
  persistComposerDrafts() {},
  refreshSocialThreads: async () => {},
  scrollMessagesToBottom() {},
  focusChatInputAtEnd() {},
  userErrorMessage: (error) => error?.message || String(error),
  refreshCollaborationOverview: async () => {},
});
await multiController.sendChatGroupMessage();
const multiSent = sentGroupPayloads.at(-1);
assert.equal(multiSent.metadata.uBuddyMultiMention.classification, 'multi_task');
assert.deepEqual(multiSent.metadata.uBuddyMultiMention.targetUserIds, ['bob', 'carol']);
assert.equal(multiDispatchPayloads.length, 1);
assert.equal(multiDispatchPayloads[0].sourceType, 'natural_chat_group');
assert.equal(multiDispatchPayloads[0].participantPolicy, 'all_mentioned');
assert.equal(multiDispatchPayloads[0].autoExecutionPolicy, 'low_medium_risk');
assert.equal(multiBusyDuringDispatch, false, 'composer busy state must clear before background task planning starts');
assert.equal(multiDraftDuringDispatch, '', 'the sent group message must clear from the composer before planning starts');

const persistedFailureNotices = [];
const persistedFailureState = {
  ...multiControllerState,
  chatDraft: multiContent,
  composerMentions: [
    { principalType: 'ubuddy', ownerUserId: 'bob', displayText: '@Bob的uBuddy', mentionId: 'failure-bob', source: 'picker' },
    { principalType: 'ubuddy', ownerUserId: 'carol', displayText: '@Carol的uBuddy', mentionId: 'failure-carol', source: 'picker' },
  ],
  networkConversationBusy: false,
};
const persistedFailureController = createNetworkMessageController({
  api: {
    async sendChatGroupMessage(payload) {
      return { group: { id: 'chat_1', status: 'active', workspaceId: 'workspace_personal' }, messages: [{ id: payload.clientMessageId, content: payload.content, metadata: payload.metadata }] };
    },
    async dispatchCollaborationCommand() { throw new Error('planner unavailable'); },
    async chatGroupsOverview() { return { groups: [] }; },
  },
  documentRef: { getElementById: () => ({ value: multiContent }) },
  state: persistedFailureState,
  render() {},
  notify(message) { persistedFailureNotices.push(message); },
  readyAttachmentsForSend: async () => [],
  currentModelValue: () => 'gpt-5',
  currentReasoningValue: () => 'medium',
  selectedSocialTaskGroup: () => null,
  networkConversationDraftKey: () => 'chat-group:chat_1',
  persistComposerDrafts() {},
  refreshSocialThreads: async () => {},
  scrollMessagesToBottom() {},
  focusChatInputAtEnd() {},
  userErrorMessage: (error) => error?.message || String(error),
  refreshCollaborationOverview: async () => {},
});
await persistedFailureController.sendChatGroupMessage();
assert.ok(persistedFailureNotices.some((message) => message.startsWith('群消息已发送，但 uBuddy 启动多人任务失败：')));
assert.ok(persistedFailureNotices.every((message) => !message.startsWith('群消息发送失败：')));

const directDispatchContent = '@我的uBuddy 请 Bob 整理本周项目进展。';
const directDispatchState = {
  ...controllerState,
  currentUser: state.currentUser,
  activeAccountWorkspace: state.activeAccountWorkspace,
  friendOverview: state.friendOverview,
  networkConversationPeerId: 'bob',
  networkConversationMode: 'person',
  networkConversationGroupId: '',
  networkConversationMessages: [],
  networkConversationDrafts: {},
  chatDraft: directDispatchContent,
  attachments: [],
  composerMentions: [{
    principalType: 'ubuddy', ownerUserId: 'alice', displayText: '@我的uBuddy',
    mentionId: 'direct-own-ubuddy', source: 'picker',
  }],
  collaborationOverview: { groups: [], tasks: [] },
  agentDelegations: [],
  networkConversationBusy: false,
};
let directOverviewRefreshes = 0;
let directDirectoryProjection = null;
const directDispatchController = createNetworkMessageController({
  api: {
    async dispatchCollaborationCommand() {
      return {
        dispatched: true,
        group: {
          id: 'direct-work-group', title: '本周项目进展', status: 'active',
          metadata: { source_conversation_id: 'direct:alice:bob' },
        },
        tasks: [{ id: 'direct-work-task', groupId: 'direct-work-group', status: 'assigned', metadata: {} }],
      };
    },
    async socialConversation() { return []; },
  },
  documentRef: { getElementById: () => ({ value: directDispatchContent }) },
  state: directDispatchState,
  render() {}, notify() {}, readyAttachmentsForSend: async () => [],
  currentModelValue: () => 'gpt-5', currentReasoningValue: () => 'medium', selectedSocialTaskGroup: () => null,
  networkConversationDraftKey: () => 'direct:alice:bob', persistComposerDrafts() {}, refreshSocialThreads: async () => {},
  scrollMessagesToBottom() {}, focusChatInputAtEnd() {}, userErrorMessage: (error) => error?.message || String(error),
  refreshCollaborationOverview: async () => { directOverviewRefreshes += 1; },
  noteDirectoryGroups: (overview) => { directDirectoryProjection = overview; },
});
await directDispatchController.sendDirectSocialMessage();
assert.equal(directOverviewRefreshes, 0, 'direct dispatch should not wait for a collaboration overview round trip');
assert.equal(directDispatchState.collaborationOverview.groups[0]?.id, 'direct-work-group');
assert.equal(directDispatchState.collaborationOverview.tasks[0]?.id, 'direct-work-task');
assert.equal(directDispatchState.agentDelegations[0]?.id, 'direct-work-task');
assert.equal(directDirectoryProjection?.groups?.[0]?.id, 'direct-work-group');

function createDraftRaceHarness({ initialText = '待发送旧草稿', sendSocialMessage }) {
  const input = { value: initialText };
  const harnessState = {
    currentUser: { id: 'alice', displayName: 'Alice' },
    friendOverview: { friends: [{ friend: { id: 'bob', displayName: 'Bob' } }] },
    networkConversationPeerId: 'bob',
    networkConversationMode: 'person',
    networkConversationGroupId: '',
    networkConversationMessages: [],
    networkConversationDrafts: { 'bob:person': initialText },
    networkConversationBusy: false,
    chatDraft: initialText,
    attachments: [],
    composerMentions: [],
    secretaryMentions: [],
    composerFileReferences: [],
    composerMemoryReferences: [],
    messageQuote: null,
    composerTaskReference: null,
    uBuddyParticipantSelectionPolicy: 'all_mentioned',
    composerDraftsBySurface: {},
  };
  const draftController = createComposerDraftController({
    state: harnessState,
    readInputValue: () => input.value,
    persist() {},
  });
  const surfaceKey = 'social-direct:bob';
  const controller = createNetworkMessageController({
    api: {
      sendSocialMessage,
      async socialConversation() { return []; },
    },
    documentRef: { getElementById: () => input },
    state: harnessState,
    render() {}, notify() {}, readyAttachmentsForSend: async () => [],
    currentModelValue: () => 'gpt-5', currentReasoningValue: () => 'medium', selectedSocialTaskGroup: () => null,
    networkConversationDraftKey: () => 'bob:person', persistComposerDrafts() {},
    composerSurfaceKey: () => surfaceKey,
    captureComposerDraft: (key, options) => draftController.capture(key, options),
    clearComposerDraft: (key, options) => draftController.clear(key, options),
    restoreComposerDraft: (key, options) => draftController.restore(key, options),
    getComposerDraftSnapshot: (key) => draftController.snapshot(key),
    putComposerDraftSnapshot: (key, snapshot) => draftController.put(key, snapshot),
    hasComposerDraft: (key) => draftController.has(key),
    refreshSocialThreads: async () => {}, scrollMessagesToBottom() {}, focusChatInputAtEnd() {},
    userErrorMessage: (error) => error?.message || String(error), refreshCollaborationOverview: async () => {},
  });
  return { controller, draftController, input, state: harnessState, surfaceKey };
}

let markRaceSendStarted;
let releaseRaceSend;
const raceSendStarted = new Promise((resolve) => { markRaceSendStarted = resolve; });
const raceSendGate = new Promise((resolve) => { releaseRaceSend = resolve; });
const successRace = createDraftRaceHarness({
  sendSocialMessage: async () => {
    markRaceSendStarted();
    await raceSendGate;
  },
});
successRace.draftController.put('chat-group:other-group', { draft: { text: '普通群草稿' } });
successRace.draftController.put('collaboration:other-work', { draft: { text: '任务群草稿' } });
const successRaceSend = successRace.controller.sendDirectSocialMessage();
await raceSendStarted;
successRace.input.value = '发送期间的新草稿';
successRace.state.chatDraft = successRace.input.value;
successRace.draftController.capture(successRace.surfaceKey);
releaseRaceSend();
await successRaceSend;
assert.equal(successRace.state.chatDraft, '发送期间的新草稿', 'successful completion must not clear a newer direct-chat draft');
assert.equal(successRace.draftController.snapshot(successRace.surfaceKey)?.draft?.text, '发送期间的新草稿');
assert.equal(successRace.draftController.snapshot('chat-group:other-group')?.draft?.text, '普通群草稿');
assert.equal(successRace.draftController.snapshot('collaboration:other-work')?.draft?.text, '任务群草稿');

const failedRestore = createDraftRaceHarness({
  initialText: '发送失败应恢复',
  sendSocialMessage: async () => { throw new Error('offline'); },
});
await failedRestore.controller.sendDirectSocialMessage();
assert.equal(failedRestore.state.chatDraft, '发送失败应恢复', 'a failed send must restore the submitted draft when no newer draft exists');
assert.equal(failedRestore.input.value, '发送失败应恢复');

let markFailedRaceStarted;
let rejectFailedRace;
const failedRaceStarted = new Promise((resolve) => { markFailedRaceStarted = resolve; });
const failedRaceGate = new Promise((resolve, reject) => { rejectFailedRace = reject; });
const failedWithNewerDraft = createDraftRaceHarness({
  initialText: '失败前的旧草稿',
  sendSocialMessage: async () => {
    markFailedRaceStarted();
    await failedRaceGate;
  },
});
const failedRaceSend = failedWithNewerDraft.controller.sendDirectSocialMessage();
await failedRaceStarted;
failedWithNewerDraft.input.value = '失败期间的新草稿';
failedWithNewerDraft.state.chatDraft = failedWithNewerDraft.input.value;
failedWithNewerDraft.draftController.capture(failedWithNewerDraft.surfaceKey);
rejectFailedRace(new Error('offline'));
await failedRaceSend;
assert.equal(failedWithNewerDraft.state.chatDraft, '失败期间的新草稿', 'failure must not overwrite a newer direct-chat draft');
assert.equal(failedWithNewerDraft.draftController.snapshot(failedWithNewerDraft.surfaceKey)?.draft?.text, '失败期间的新草稿');
const savedDirectRenderState = {
  networkPanelOpen: state.networkPanelOpen,
  friendOverview: state.friendOverview,
  networkMessageHomeOpen: state.networkMessageHomeOpen,
  chatGroupId: state.chatGroupId,
  chatGroupDetail: state.chatGroupDetail,
  collaborationGroupId: state.collaborationGroupId,
  networkConversationPeerId: state.networkConversationPeerId,
  networkConversationMode: state.networkConversationMode,
  networkConversationMessages: state.networkConversationMessages,
  collaborationOverview: state.collaborationOverview,
};
state.networkPanelOpen = true;
state.friendOverview = {
  ...(state.friendOverview || {}),
  friends: [{ friend: { id: 'bob', displayName: 'Bob', username: 'bob', avatarUrl: bobAvatar } }],
};
state.networkMessageHomeOpen = false;
state.chatGroupId = '';
state.chatGroupDetail = null;
state.collaborationGroupId = '';
state.networkConversationPeerId = 'bob';
state.networkConversationMode = 'person';
state.networkConversationMessages = [];
state.collaborationOverview = directDispatchState.collaborationOverview;
const directReceiptChat = renderChat();
assert.match(directReceiptChat, /任务已派发：本周项目进展/);
assert.match(directReceiptChat, /data-collaboration-group="direct-work-group"/);
assert.match(directReceiptChat, />打开工作群</);
Object.assign(state, savedDirectRenderState);

let releaseFirstPlanning;
let releaseSecondPersistence;
let markFirstPlanningStarted;
let markSecondPersistenceStarted;
const firstPlanningStarted = new Promise((resolve) => { markFirstPlanningStarted = resolve; });
const secondPersistenceStarted = new Promise((resolve) => { markSecondPersistenceStarted = resolve; });
const firstPlanning = new Promise((resolve) => { releaseFirstPlanning = resolve; });
const secondPersistence = new Promise((resolve) => { releaseSecondPersistence = resolve; });
const overlapInput = { value: multiContent };
let overlapSendCount = 0;
let overlapDispatchCount = 0;
const overlapState = {
  ...multiControllerState,
  chatDraft: multiContent,
  composerMentions: [
    { principalType: 'ubuddy', ownerUserId: 'bob', displayText: '@Bob的uBuddy', mentionId: 'overlap-bob-1', source: 'picker' },
    { principalType: 'ubuddy', ownerUserId: 'carol', displayText: '@Carol的uBuddy', mentionId: 'overlap-carol-1', source: 'picker' },
  ],
  networkConversationBusy: false,
};
const overlapController = createNetworkMessageController({
  api: {
    async sendChatGroupMessage(payload) {
      overlapSendCount += 1;
      if (overlapSendCount === 2) {
        markSecondPersistenceStarted();
        await secondPersistence;
      }
      return { group: { id: 'chat_1', status: 'active', workspaceId: 'workspace_personal' }, messages: [{ id: payload.clientMessageId, content: payload.content, metadata: payload.metadata }] };
    },
    async dispatchCollaborationCommand() {
      overlapDispatchCount += 1;
      if (overlapDispatchCount === 1) {
        markFirstPlanningStarted();
        return firstPlanning;
      }
      return { dispatched: false, queued: true };
    },
    async chatGroupsOverview() { return { groups: [] }; },
  },
  documentRef: { getElementById: () => overlapInput },
  state: overlapState,
  render() {}, notify() {}, readyAttachmentsForSend: async () => [],
  currentModelValue: () => 'gpt-5', currentReasoningValue: () => 'medium', selectedSocialTaskGroup: () => null,
  networkConversationDraftKey: () => 'chat-group:chat_1', persistComposerDrafts() {}, refreshSocialThreads: async () => {},
  scrollMessagesToBottom() {}, focusChatInputAtEnd() {}, userErrorMessage: (error) => error?.message || String(error),
  refreshCollaborationOverview: async () => {},
});
const firstOverlapSend = overlapController.sendChatGroupMessage();
await firstPlanningStarted;
assert.equal(overlapState.networkConversationBusy, false);
overlapInput.value = `${multiContent} 第二条`;
overlapState.chatDraft = overlapInput.value;
overlapState.composerMentions = [
  { principalType: 'ubuddy', ownerUserId: 'bob', displayText: '@Bob的uBuddy', mentionId: 'overlap-bob-2', source: 'picker' },
  { principalType: 'ubuddy', ownerUserId: 'carol', displayText: '@Carol的uBuddy', mentionId: 'overlap-carol-2', source: 'picker' },
];
const secondOverlapSend = overlapController.sendChatGroupMessage();
await secondPersistenceStarted;
assert.equal(overlapState.networkConversationBusy, true);
releaseFirstPlanning({ dispatched: false, queued: true });
await firstOverlapSend;
assert.equal(overlapState.networkConversationBusy, true, 'completion of the older planning request must not unlock a newer send');
releaseSecondPersistence();
await secondOverlapSend;
assert.equal(overlapState.networkConversationBusy, false);
state.chatGroupInviteOpen = true;
state.chatGroupInviteGroupDetail = state.groupDirectoryProfileDetail;
state.chatGroupInviteUserId = 'coworker_only';
const inviteDialog = renderChatGroupInviteDialog();
assert.match(inviteDialog, /data-chat-group-invite-form/);
assert.match(inviteDialog, /value="coworker_only"/);
assert.match(inviteDialog, /邀请加入/);
state.chatGroupInviteOpen = false;
state.chatGroupInviteGroupDetail = null;
state.chatGroupInviteUserId = '';
state.networkGroupProfileOpen = false;
state.networkSelectedGroupId = '';
state.networkSelectedGroupKind = '';
state.groupDirectoryProfileDetail = null;
state.friendDirectoryCategory = 'internal';
state.networkSelectedContactId = 'coworker_only';
state.networkContactProfileOpen = false;
const internalWorkspace = renderContactsWorkspace();
assert.match(internalWorkspace, /组织同事/);
assert.doesNotMatch(internalWorkspace, /contacts-organization-switch|data-organization-switch=|切换联系人所属组织/);
assert.doesNotMatch(internalWorkspace, /个人好友/);
assert.doesNotMatch(internalWorkspace, /im-contact-row active[^>]*data-contact-profile="coworker_only"/);
state.networkSelectedContactId = '';
state.friendDirectoryCategory = 'external';
const externalWorkspace = renderContactsWorkspace();
assert.match(externalWorkspace, /个人好友/);
assert.doesNotMatch(externalWorkspace, /组织同事/);

state.friendDirectoryCategory = 'organizations';
state.contactsSelectedOrganizationId = 'org_acme';
const organizationManagement = renderContactsWorkspace();
assert.match(organizationManagement, /当前组织/);
assert.match(organizationManagement, /组织信息/);
assert.match(organizationManagement, /组织偏好/);
assert.match(organizationManagement, /修改邀请码/);
assert.match(organizationManagement, /data-organization-share-generate="org_acme"/);
assert.match(organizationManagement, /data-organization-set-default="workspace_org_acme"/);
assert.doesNotMatch(organizationManagement, /data-organization-switch=/);
assert.match(organizationManagement, /data-organization-name-edit="org_acme"/);
assert.match(organizationManagement, /data-organization-name-dblclick="org_acme"/);
state.organizationNameEditId = 'org_acme';
state.organizationNameEditDraft = '分布式系统实验室';
const organizationNameEdit = renderContactsWorkspace();
assert.match(organizationNameEdit, /data-organization-name-form="org_acme"/);
assert.match(organizationNameEdit, /data-organization-name-input/);
state.organizationNameEditId = '';
state.organizationNameEditDraft = '';

state.friendDirectoryCategory = 'internal';
state.networkSelectedContactId = 'alice';
state.networkSelectedContactOrganizationId = 'org_acme';
state.networkContactProfileOpen = true;
const selfOrganizationProfile = renderContactsWorkspace();
assert.match(selfOrganizationProfile, /data-organization-display-name="org_acme"/);
state.networkContactProfileOpen = false;
state.networkSelectedContactId = '';
state.networkSelectedContactOrganizationId = '';

state.friendDirectoryCategory = 'groups';
state.contactGroupDirectoryTab = 'work';
state.networkGroupProfileOpen = true;
state.networkSelectedGroupKind = 'work';
state.networkSelectedGroupId = 'work_1';
state.groupDirectoryProfileDetail = {
  group: state.collaborationOverview.groups[0],
  members: [{ userId: 'alice', role: 'owner', status: 'active', user: state.currentUser }],
};
const workGroupProfile = `${renderContactsWorkspace()}${renderGroupProfileDialog()}`;
assert.match(workGroupProfile, /前往 uBuddy/);
assert.match(workGroupProfile, /data-group-profile-message="work_1"/);
state.networkGroupProfileOpen = false;
state.networkSelectedGroupId = '';
state.groupDirectoryProfileDetail = null;
state.networkSelectedGroupKind = 'work';
const closedWorkGroupProfile = renderContactsWorkspace();
assert.doesNotMatch(closedWorkGroupProfile, /im-group-directory-row[^>]*active[^>]*data-contact-group-profile="work_1"/);
state.networkSelectedGroupKind = '';

const savedChatGroups = state.chatGroupsOverview;
const savedWorkGroups = state.collaborationOverview;
state.contactGroupDirectoryTab = 'contact';
state.chatGroupsOverview = { groups: [] };
let emptyGroups = renderContactsWorkspace();
assert.match(emptyGroups, /暂无联系人群聊/);
assert.match(emptyGroups, /去创建群聊/);
state.contactGroupDirectoryTab = 'work';
state.collaborationOverview = { groups: [], tasks: [] };
emptyGroups = renderContactsWorkspace();
assert.match(emptyGroups, /暂无工作群组/);
assert.match(emptyGroups, /用uBuddy开始协作/);
state.chatGroupsOverview = savedChatGroups;
state.collaborationOverview = savedWorkGroups;

state.currentSettingsSection = 'account';
const accountSettings = renderSettings();
assert.match(accountSettings, /默认组织/);
assert.match(accountSettings, /id="startup-workspace-form"/);
assert.match(accountSettings, /value="workspace_org_acme" selected/);
assert.doesNotMatch(accountSettings, /value="workspace_personal"/);

const healthyCurrentUser = state.currentUser;
state.currentUser = { id: 'user_ec435', displayName: 'user_ec435', display_name: 'user_ec435', username: 'alice', email: 'alice@example.com' };
const sidebarWithInternalKey = renderSidebar();
assert.match(sidebarWithInternalKey, /class="avatar account-avatar"[^>]*title="alice"/);
assert.doesNotMatch(sidebarWithInternalKey, /class="account-copy"/);
assert.doesNotMatch(sidebarWithInternalKey, />user_ec435</);
state.currentUser = healthyCurrentUser;

console.log('chat groups renderer smoke passed');
