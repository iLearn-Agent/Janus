import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createPickerMentionEntity, normalizeMentionEntities } from '../src/shared/contracts/mentions.js';
import { state } from '../src/renderer/app/state.js';
import { messageReceiptPopoverLayout } from '../src/renderer/app/utils/messageReceiptLayout.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

const below = messageReceiptPopoverLayout({
  anchor: { top: 18, bottom: 34, right: 310 }, popoverWidth: 280, popoverHeight: 240,
  viewportWidth: 360, viewportHeight: 640,
});
assert.equal(below.placement, 'below');
assert.equal(below.top, 42);
assert.ok(below.left >= 8 && below.left + 280 <= 352);

const above = messageReceiptPopoverLayout({
  anchor: { top: 590, bottom: 606, right: 350 }, popoverWidth: 320, popoverHeight: 260,
  viewportWidth: 360, viewportHeight: 640,
});
assert.equal(above.placement, 'above');
assert.ok(above.top >= 8 && above.top + 260 <= 590);
assert.ok(above.left >= 8 && above.left + 320 <= 352);

const everyone = createPickerMentionEntity({ principalType: 'group_audience', audience: 'human_members', displayText: '@所有人', mentionId: 'everyone' });
const buddies = createPickerMentionEntity({ principalType: 'group_audience', audience: 'member_ubuddies', displayText: '@群内uBuddy', mentionId: 'buddies' });
assert.deepEqual(normalizeMentionEntities([everyone, buddies], { content: '@所有人 @群内uBuddy', requirePicker: true })
  .map((item) => item.audience), ['human_members', 'member_ubuddies']);

const receiptCss = await readFile(new URL('../src/renderer/styles/network.css', import.meta.url), 'utf8');
const chatCss = await readFile(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
const workspaceCss = await readFile(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
const attachmentCss = await readFile(new URL('../src/renderer/styles/attachments-preview.css', import.meta.url), 'utf8');
assert.match(receiptCss, /\.message-bubble-receipt-anchor\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%/s,
  'the receipt anchor must shrink to the real bubble instead of spanning the message shell');
assert.match(receiptCss, /\.message\.user \.message-bubble-receipt-anchor > \.message-receipt-trigger\s*\{[^}]*right:\s*-20px[^}]*bottom:\s*0[^}]*left:\s*auto[^}]*z-index:\s*2[^}]*transform:\s*none/s,
  'the smaller receipt progress must sit just outside the lower-right edge with its bottom aligned to the bubble');
assert.match(chatCss, /\.is-favorite-emoji-message \.message-receipt-trigger\s*\{[^}]*right:\s*-20px[^}]*bottom:\s*0/s,
  'favorite emoji receipts must also sit outside the lower-right edge');
assert.match(receiptCss, /\.message\.user \.message-bubble-receipt-anchor\s*\{[^}]*margin-bottom:\s*0/s,
  'the lower-left receipt progress must not add spacing between consecutive bubbles');
assert.match(workspaceCss, /\.message\.has-consecutive-next \.message-footer\s*\{[^}]*top:\s*50%[^}]*bottom:\s*auto[^}]*transform:\s*translate\(6px, -50%\)/s,
  'earlier consecutive messages must place their actions vertically beside the bubble');
assert.match(workspaceCss, /\.message\.user\.has-consecutive-next \.message-footer\s*\{[^}]*transform:\s*translate\(50px, -50%\)/s,
  'outgoing consecutive messages must place actions beyond the avatar slot');
assert.match(workspaceCss, /\.message\.has-consecutive-next \.message-actions\s*\{[^}]*flex-direction:\s*column[^}]*gap:\s*2px/s,
  'earlier consecutive message actions must form a compact vertical stack');
assert.match(workspaceCss, /\.message\.has-consecutive-next \.message-action-btn\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/s,
  'side-mounted consecutive message actions must remain compact');
assert.match(attachmentCss, /\.message-attachment-card\s*\{[^}]*color:\s*#1f2937[^}]*background:\s*#fff/s,
  'light message attachment cards must use dark text on their white surface');
assert.match(attachmentCss, /\.artifact-card\s*\{[^}]*color:\s*#1f2937[^}]*background:\s*#ffffff/s,
  'light artifact cards must use dark text on their white surface');
const chatView = await readFile(new URL('../src/renderer/app/views/chatView.js', import.meta.url), 'utf8');
assert.match(chatView, /function renderMessageBubbleReceiptAnchor/);
assert.match(chatView, /class="message-bubble-receipt-anchor"/);
assert.doesNotMatch(chatView, /message-receipt-trigger[^`]*<small>/,
  'the receipt progress must not show a numeric unread label beside the circle');
assert.match(chatView, /className: 'network-user-avatar message-receipt-avatar'/,
  'receipt details must reuse the same avatar component styling as the contacts directory');
assert.match(receiptCss, /\.message-receipt-trigger\.is-complete > span\s*\{[^}]*border:\s*2px solid var\(--ui-success/s,
  'fully read receipts must use a green circular border');
assert.match(receiptCss, /\.message-receipt-trigger\.is-complete > span::after\s*\{[^}]*content:\s*'✓'[^}]*color:\s*var\(--ui-success/s,
  'fully read receipts must show a green check');

const currentAvatar = 'https://avatars.example.test/alice-current.png';
const contactAvatar = 'https://avatars.example.test/bob-current.png';
state.currentUser = { id: 'alice', displayName: 'Alice', avatarUrl: currentAvatar };
state.friendOverview = { friends: [{ friend: { id: 'bob', displayName: 'Bob', avatarUrl: contactAvatar } }], organizations: [] };
state.chatGroupId = 'receipt-layout-group';
state.chatGroupDetail = {
  group: { id: 'receipt-layout-group', title: 'Receipt layout', status: 'dissolved', memberCount: 2 },
  membership: { userId: 'alice', status: 'active' },
  members: [],
  messages: [
    { id: 'incoming', senderUserId: 'bob', kind: 'friend', content: 'Incoming', sender: { id: 'bob', displayName: 'Bob' },
      receiptSummary: { total: 1, read: 1 }, receiptDetails: [{ userId: 'alice', read: true, user: state.currentUser }] },
    { id: 'outgoing', senderUserId: 'alice', kind: 'friend', content: 'Outgoing', sender: state.currentUser,
      receiptSummary: { total: 1, read: 1 },
      receiptDetails: [{ userId: 'bob', read: true, readAt: '2026-08-29T00:00:00.000Z', user: { id: 'bob', displayName: 'Bob', avatarUrl: 'https://stale.example.test/bob.png' } }] },
  ],
};
state.messageReceiptPopover = null;
const receiptChat = renderChat();
assert.match(receiptChat, /data-message-receipt="outgoing"/);
assert.doesNotMatch(receiptChat, /data-message-receipt="incoming"/,
  'only the sender may see the read progress for their own message');
const renderedReceiptButton = receiptChat.match(/<button class="message-receipt-trigger"[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
assert.doesNotMatch(renderedReceiptButton, /<small>/,
  'the read progress button must contain only the circle');
assert.match(receiptChat, /message-receipt-trigger[^>]*is-complete/,
  'fully read messages must render the completed receipt state');

state.messageReceiptPopover = { messageId: 'outgoing', details: state.chatGroupDetail.messages[1].receiptDetails, left: 20, top: 30 };
const receiptDetails = renderChat();
assert.match(receiptDetails, /network-user-avatar message-receipt-avatar has-custom-avatar/);
assert.match(receiptDetails, /avatars\.example\.test\/bob-current\.png/,
  'receipt details must use the latest avatar from contacts');
assert.doesNotMatch(receiptDetails, /stale\.example\.test/);
const networkView = await readFile(new URL('../src/renderer/app/views/networkView.js', import.meta.url), 'utf8');
assert.doesNotMatch(networkView, /data-chat-group-remove-from-list|从我的群组删除/,
  'dissolved chat groups must be archived rather than removed');
assert.match(networkView, /data-conversation-archive="chat-group:/);
assert.match(networkView, /completedConversationTimes\?\.\[key\]/,
  'completed conversations must retain a completion-time baseline');
assert.match(networkView, /Number\(entry\.time \|\| 0\) > completionTime/,
  'new activity after completion must return the conversation to the message list');
assert.match(networkView, /hasUnreadActivity/,
  'a newly unread conversation must immediately escape the completed filter');
const rendererApp = await readFile(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
assert.match(rendererApp, /setInterval\(refreshActiveSocialReceipts, 1500\)/,
  'visible direct and group chats must refresh receipt state without requiring navigation or another message');
assert.match(rendererApp, /await window\.janus\.chatGroup\(\{ groupId \}\)/,
  'active group chats must fetch authoritative receipt details');
assert.match(rendererApp, /await window\.janus\.socialConversation\(\{ peerId, limit: 500 \}\)/,
  'active direct chats must refresh local receipt projections');
const settingsView = await readFile(new URL('../src/renderer/app/views/settingsView.js', import.meta.url), 'utf8');
assert.match(settingsView, /renderArchivedGroupConversation/);
assert.match(settingsView, /data-conversation-archive=/);

console.log('Message receipt adaptive layout smoke passed.');
