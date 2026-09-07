import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { messageQuotePromptText, normalizeMessageQuote } from '../src/shared/contracts/messageQuote.js';
import { buildDesktopEditMenuTemplate } from '../src/main/desktopContextMenu.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';

const quote = normalizeMessageQuote({
  sourceMessageId: 'answer-1',
  sourceConversationId: 'session:session-1',
  conversationKind: 'agent',
  authorLabel: '研究 Agent',
  role: 'assistant',
  excerpt: '这是一段需要进入模型上下文的回答。',
});
assert.equal(quote.version, 'message_quote_v1');
assert.match(messageQuotePromptText(quote, '请继续说明'), /研究 Agent[\s\S]*需要进入模型上下文[\s\S]*请继续说明/);

Object.assign(state, {
  currentUser: { id: 'quote-user', displayName: 'Quote User' },
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  networkConversationPeerId: '',
  networkConversationMode: 'person',
  currentSessionId: 'session-1',
  currentChatKey: 'session:session-1',
  currentDepartmentId: 'general',
  homeMode: 'department',
  messages: [{
    id: 'message-2',
    role: 'user',
    content: '请继续说明',
    createdAt: new Date().toISOString(),
    metadata: { quote },
  }],
  messageQuote: quote,
  attachments: [],
  chatDraft: '',
  draggingFiles: false,
});

const markup = renderChat();
assert.match(markup, /class="message-quote"/);
assert.match(markup, /data-quoted-message-id="answer-1"/);
assert.match(markup, /class="composer-message-quote"/);
assert.match(markup, /data-message-quote-clear/);
assert.ok(markup.indexOf('class="message-body"') < markup.indexOf('class="message-quote"'));

Object.assign(state, {
  networkPanelOpen: true,
  networkConversationPeerId: 'friend-1',
  networkConversationMode: 'person',
  friendOverview: { friends: [{ friend: { id: 'friend-1', displayName: '联系人甲' } }], requests: { incoming: [], outgoing: [] } },
  networkConversationMessages: [
    {
      id: 'forward-1',
      senderUserId: 'quote-user',
      recipientUserId: 'friend-1',
      content: '需要转发的 Agent 回答',
      metadata: {
        type: 'direct_message',
        forwardedMessage: { version: 'message_forward_v1', authorLabel: '研究 Agent', excerpt: '需要转发的 Agent 回答' },
      },
    },
    {
      id: 'forward-favorite-1',
      senderUserId: 'quote-user',
      recipientUserId: 'friend-1',
      content: '\u200b',
      metadata: {
        type: 'direct_message',
        favoriteEmoji: true,
        attachments: [{ name: 'sticker.png', filename: 'sticker.png', kind: 'image', favorite_emoji: true, value: 'data:image/png;base64,AAAA', url: 'data:image/png;base64,AAAA' }],
        forwardedMessage: { version: 'message_forward_v1', authorLabel: '研究 Agent', excerpt: '表情' },
      },
    },
    {
      id: 'withdrawn-1',
      senderUserId: 'friend-1',
      recipientUserId: 'quote-user',
      content: '不应继续显示的原消息',
      metadata: { type: 'direct_message', withdrawn: true },
    },
    {
      id: 'withdrawn-own-1',
      senderUserId: 'quote-user',
      recipientUserId: 'friend-1',
      content: '可以重新编辑的撤回消息',
      metadata: { type: 'direct_message', withdrawn: true },
    },
    {
      id: 'post-withdraw-own-1',
      senderUserId: 'quote-user',
      recipientUserId: 'friend-1',
      content: '撤回后继续发送的消息',
      metadata: { type: 'direct_message' },
    },
  ],
  messageQuote: null,
});
const forwardedMarkup = renderChat();
assert.match(forwardedMarkup, /class="message-body forwarded-message"/);
assert.match(forwardedMarkup, /转发的消息/);
assert.match(forwardedMarkup, /来自 研究 Agent/);
assert.match(forwardedMarkup, /data-message-id="forward-favorite-1"[\s\S]*message-favorite-emoji-img/);
assert.match(forwardedMarkup, /对方撤回了一条消息/);
assert.match(forwardedMarkup, /class="withdrawn-direct-event"/);
assert.match(forwardedMarkup, /data-withdrawn-message-edit="withdrawn-own-1"/);
assert.match(forwardedMarkup, /重新编辑/);
assert.doesNotMatch(forwardedMarkup, /不应继续显示的原消息/);
const postWithdrawDirectMessageIndex = forwardedMarkup.indexOf('data-message-id="post-withdraw-own-1"');
const postWithdrawDirectMessage = forwardedMarkup.slice(forwardedMarkup.lastIndexOf('<article', postWithdrawDirectMessageIndex), forwardedMarkup.indexOf('</article>', postWithdrawDirectMessageIndex) + '</article>'.length);
assert.match(postWithdrawDirectMessage, /chat-message-avatar is-person is-self/);
assert.doesNotMatch(postWithdrawDirectMessage, /chat-message-avatar-spacer/);
assert.match(postWithdrawDirectMessage, /class="social-message-actor"/);

Object.assign(state, {
  networkConversationPeerId: '',
  chatGroupId: 'group-1',
  chatGroupsOverview: { groups: [{ id: 'group-1', title: '产品群', status: 'active', memberCount: 3 }] },
  chatGroupDetail: {
    group: { id: 'group-1', title: '产品群', status: 'active' },
    membership: { role: 'member' },
    members: [{ userId: 'quote-user', status: 'active', user: state.currentUser }],
    messages: [{
      id: 'group-forward-1',
      senderUserId: 'quote-user',
      kind: 'friend',
      content: '转发到群聊的内容',
      metadata: { forwardedMessage: { version: 'message_forward_v1', authorLabel: '研究 Agent', excerpt: '转发到群聊的内容' } },
    }],
  },
});
const groupForwardedMarkup = renderChat();
assert.match(groupForwardedMarkup, /natural-chat-group-view/);
assert.match(groupForwardedMarkup, /class="message-body forwarded-message"/);
assert.match(groupForwardedMarkup, /来自 研究 Agent/);

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
const messageSendSource = readFileSync(new URL('../src/renderer/app/features/chat/messageSendController.js', import.meta.url), 'utf8');
const networkSendSource = readFileSync(new URL('../src/renderer/app/features/network/messageController.js', import.meta.url), 'utf8');
const workspaceStyles = readFileSync(new URL('../src/renderer/app/core/workspace-ui.css', import.meta.url), 'utf8');
assert.match(rendererSource, /data-message-context-action="quote"/);
assert.match(rendererSource, /data-message-context-action="copy"/);
assert.match(rendererSource, /data-message-context-action="forward"/);
assert.doesNotMatch(rendererSource, /data-message-context-action="select"/);
assert.doesNotMatch(rendererSource, /data-message-context-action="paste"/);
assert.match(rendererSource, /message_forward_v1/);
assert.match(rendererSource, /sendSocialMessage/);
assert.match(rendererSource, /sendChatGroupMessage/);
assert.match(rendererSource, /data-message-forward-target="\$\{group \? 'group' : 'contact'\}"/);
assert.match(rendererSource, /data-message-forward-search/);
assert.match(rendererSource, /data-message-context-action="withdraw"/);
assert.match(rendererSource, /updateSocialMessage\(\{ messageId, action: 'withdraw' \}\)/);
assert.match(rendererSource, /data-withdrawn-message-edit/);
assert.match(rendererSource, /stripAttachmentResourceBlock\(message\.content/);
assert.match(rendererSource, /messageForwardAttachments\(message\)/);
assert.match(rendererSource, /favoriteEmoji \|\| .*favorite_emoji/);
assert.match(rendererSource, /metadata: forwardedMetadata/);
assert.match(rendererSource, /attachments: sourceAttachments/);
assert.match(rendererSource, /ageMs <= 2 \* 60 \* 1000/);
assert.match(rendererSource, /function pauseNoticeTimer/);
assert.match(rendererSource, /function resumeNoticeTimer/);
assert.match(rendererSource, /captureMessageScrollState\(\{ allowFollow: false, anchorMessageId: messageId \}\)/);
assert.match(rendererSource, /显示全文\|展开全文\|收起全文/);
assert.match(messageSendSource, /quotedMessage: outgoingQuote/);
assert.match(networkSendSource, /quote: outgoingQuote/);
assert.match(runtimeSource, /messageQuotePromptText\(normalizedQuote, storedMessage\)/);
assert.match(runtimeSource, /quote: normalizedQuote/);
assert.match(workspaceStyles, /\.message-quote[\s\S]*grid-template-columns: auto minmax\(0, 1fr\)/);
assert.match(workspaceStyles, /width: min\(320px, 100%\)/);
assert.match(workspaceStyles, /text-overflow: ellipsis/);
assert.match(workspaceStyles, /\.message\.user \.message-quote/);
assert.match(workspaceStyles, /\.message-forward-search/);
assert.match(workspaceStyles, /\.message-forward-contacts > section/);

const readOnlyContextMenu = buildDesktopEditMenuTemplate({
  isEditable: false,
  selectionText: '已选文字',
  editFlags: { canCopy: true, canSelectAll: true, canPaste: true },
});
assert.deepEqual(readOnlyContextMenu.map((item) => item.label || item.type), ['复制']);

const inputContextMenu = buildDesktopEditMenuTemplate({
  isEditable: true,
  selectionText: '',
  editFlags: { canPaste: true },
});
assert.ok(inputContextMenu.some((item) => item.role === 'paste'));
assert.ok(inputContextMenu.some((item) => item.role === 'selectAll'));

console.log('message quote UI smoke passed');
