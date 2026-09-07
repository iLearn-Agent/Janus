import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { translateUiText } from '../src/renderer/app/i18n.js';

const snapshot = { ...state };

function resetState() {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, snapshot, {
    languageMode: 'zh-CN',
    currentUser: { id: 'u1', displayName: '我' },
    friendOverview: { friends: [{ friend: { id: 'u2', displayName: '好友' } }], organizations: [] },
    collaborationOverview: { groups: [] },
    networkPanelOpen: true,
    networkConversationMode: 'person',
    networkConversationPeerId: 'u2',
    networkConversationMessages: [],
    chatGroupId: '',
    chatGroupDetail: null,
    messageReactionPicker: null,
  });
}

resetState();
state.networkConversationMessages = [{
  id: 'm1',
  senderUserId: 'u2',
  recipientUserId: 'u1',
  kind: 'friend',
  content: 'hello',
  metadata: { type: 'direct_message', reactions: [{ emoji: '👍', userId: 'u1', displayName: '我' }] },
  createdAt: '2026-08-20T00:00:00.000Z',
}];
let html = renderChat();
assert.match(html, /data-message-reaction-picker="m1"/);
assert.match(html, /data-message-reaction-toggle="m1"/);
assert.match(html, /message-reaction-action/);
assert.match(html, /aria-label="添加表情回应"/);

resetState();
state.networkConversationMessages = [{
  id: 'agent-direct',
  senderUserId: 'u2',
  senderAgentId: 'secretary_agent',
  recipientUserId: 'u1',
  kind: 'agent',
  content: 'agent',
  metadata: { type: 'agent_delegation' },
  createdAt: '2026-08-20T00:00:00.000Z',
}];
html = renderChat();
assert.doesNotMatch(html, /data-message-reaction-picker="agent-direct"/);

resetState();
state.networkPanelOpen = false;
state.chatGroupId = 'g1';
state.chatGroupDetail = {
  group: { id: 'g1', title: '群聊', status: 'active', memberCount: 2 },
  members: [{ userId: 'u1', status: 'active' }, { userId: 'u2', status: 'active' }],
  messages: [{
    id: 'gm1',
    groupId: 'g1',
    senderUserId: 'u2',
    kind: 'friend',
    content: 'group hello',
    metadata: { reactions: [{ emoji: '❤️', userId: 'u1', displayName: '我' }] },
    sender: { id: 'u2', displayName: '好友' },
    createdAt: '2026-08-20T00:00:00.000Z',
  }],
};
html = renderChat();
assert.match(html, /data-message-reaction-picker="gm1"/);
assert.match(html, /data-message-reaction-toggle="gm1"/);

state.chatGroupDetail.members = [
  { userId: 'u1', status: 'active', user: { id: 'u1', displayName: '我' } },
  { userId: 'u2', status: 'active', user: { id: 'u2', displayName: '甲' } },
  { userId: 'u3', status: 'active', user: { id: 'u3', displayName: '乙' } },
  { userId: 'u4', status: 'active', user: { id: 'u4', displayName: '丙' } },
  { userId: 'u5', status: 'active', user: { id: 'u5', displayName: '丁' } },
];
state.chatGroupDetail.messages[0].metadata.reactions = [
  { emoji: '❤️', userId: 'u2', displayName: '旧甲' },
  { emoji: '❤️', userId: 'u3', displayName: '旧乙' },
  { emoji: '❤️', userId: 'u4', displayName: '旧丙' },
  { emoji: '❤️', userId: 'u5', displayName: '旧丁' },
];
html = renderChat();
assert.match(html, /甲 乙 丙/);
assert.match(html, />\+1<\/span>/);
assert.doesNotMatch(html, /旧甲/);

resetState();
state.chatGroupId = 'g1';
state.chatGroupDetail = {
  group: { id: 'g1', title: '群聊', status: 'active', memberCount: 2 },
  members: [{ userId: 'u1', status: 'active' }, { userId: 'u2', status: 'active' }],
  messages: [{
    id: 'agent-group',
    groupId: 'g1',
    senderUserId: 'u2',
    senderAgentId: 'secretary_agent',
    kind: 'agent',
    content: 'agent',
    metadata: {},
    sender: { id: 'u2', displayName: '好友' },
    createdAt: '2026-08-20T00:00:00.000Z',
  }],
};
html = renderChat();
assert.doesNotMatch(html, /data-message-reaction-picker="agent-group"/);

resetState();
const stickerDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
state.composerFavoriteEmojis = [{
  id: 'favorite-sticker', kind: 'image', value: stickerDataUrl, url: stickerDataUrl,
  name: 'sticker.png', filename: 'sticker.png', sha256: 'sticker-sha',
}];
state.networkConversationMessages = [{
  id: 'favorite-message', senderUserId: 'u1', recipientUserId: 'u2', kind: 'friend', content: '\u200b',
  metadata: {
    type: 'direct_message', favoriteEmoji: true,
    attachments: [{ name: 'sticker.png', filename: 'sticker.png', kind: 'image', value: stickerDataUrl, url: stickerDataUrl }],
  },
  createdAt: '2026-08-20T00:00:00.000Z',
}];
html = renderChat();
assert.match(html, /message-favorite-emoji-image[^>]*><img class="message-favorite-emoji-img"/);
assert.match(html, /message-favorite-emoji-img[^>]*decoding="sync"/);
assert.doesNotMatch(html, /emoji-asset-message/);

const chatCssSource = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(chatCssSource, /message-favorite-emoji-image > img\.message-favorite-emoji-img[\s\S]*?width: 96px !important;[\s\S]*?height: 96px !important;/);

const rendererAppSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const iconsSource = readFileSync(new URL('../src/renderer/app/ui/icons.js', import.meta.url), 'utf8');
assert.match(rendererAppSource, /translateUiText\('添加表情'/);
assert.match(rendererAppSource, /iconSvg\('thumbUp'\)/);
assert.match(rendererAppSource, /messageSupportsReactions,/);
assert.match(rendererAppSource, /closeMessageReactionPicker\(\);\s*state\.messageContextMenu = null;\s*render\(\);/);
assert.match(iconsSource, /thumbUp:/);
assert.match(chatCssSource, /\.social-group-message\.assistant \.message-footer \{ justify-self: start; justify-content: flex-start; \}/);
assert.match(chatCssSource, /\.social-group-message\.user \.message-footer \{ justify-self: end; justify-content: flex-end; \}/);
assert.match(chatCssSource, /\.message-reaction-picker\.is-complete \.message-reaction-grid button \{[\s\S]*?display: grid;[\s\S]*?place-items: center;[\s\S]*?padding: 0;/);
assert.match(chatCssSource, /\.message-bubble:has\(> \.message-reaction-row\.has-reactions\)/);
assert.doesNotMatch(chatCssSource, /\.social-group-message:not\(\.is-agent-message\):not\(\.is-favorite-emoji-message\) \.message-bubble \{\s*display: inline-block;[\s\S]{0,180}background:/);
assert.match(chatCssSource, /\.shell\.theme-dark \.message-reaction-picker/);
assert.match(rendererAppSource, /data-message-reaction-picker="\$\{escapeAttr\(menu\.messageId \|\| ''\)\}"/);
assert.ok(rendererAppSource.includes('state.messageContextMenu = null;\n    render();'));

resetState();
state.languageMode = 'en';
state.networkConversationMessages = [{
  id: 'm-en', senderUserId: 'u2', recipientUserId: 'u1', kind: 'friend', content: 'hello',
  metadata: { type: 'direct_message', reactions: [{ emoji: '👍', userId: 'u1', displayName: 'Me' }] },
  createdAt: '2026-08-20T00:00:00.000Z',
}];
html = renderChat();
assert.match(html, /aria-label="Add reaction"/);
assert.equal(translateUiText('表情回应', 'en'), 'Reactions');
assert.equal(translateUiText('选择一个表情', 'en'), 'Choose a reaction');
assert.equal(translateUiText('常用表情', 'en'), 'Frequently used');
assert.equal(translateUiText('笑脸与人物', 'en'), 'Smileys & People');
assert.doesNotMatch(html, /添加表情回应/);

console.log('message reactions renderer smoke passed');
