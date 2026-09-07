import assert from 'node:assert/strict';
import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { isImageSource } from '../src/renderer/app/utils/format.js';

assert.equal(isImageSource('data:image/png;base64,abc'), true);
assert.equal(isImageSource('https://example.test/sticker.png'), true);
assert.equal(isImageSource('/tmp/sticker.png'), true);
assert.equal(isImageSource('not-an-image-source'), false);

const original = { ...state };
try {
  Object.assign(state, {
    languageMode: 'zh-CN',
    currentUser: { id: 'u1', displayName: '我' },
    friendOverview: { friends: [{ friend: { id: 'u2', displayName: '好友' } }], organizations: [] },
    collaborationOverview: { groups: [] },
    networkPanelOpen: true,
    networkPanelView: 'messages',
    networkMessageHomeOpen: false,
    messageActivePane: 'conversation',
    networkConversationMode: 'person',
    networkConversationPeerId: 'u2',
    networkConversationMessages: [{
      id: 'favorite-message',
      senderUserId: 'u1', recipientUserId: 'u2', kind: 'friend', content: '',
      metadata: {
        type: 'direct_message', favoriteEmoji: true,
        attachments: [{ name: 'sticker.png', filename: 'sticker.png', kind: 'image', remote_file_id: 'social-file-1', sha256: 'sticker-sha' }],
      },
      createdAt: '2026-08-31T00:00:00.000Z',
    }],
    composerFavoriteEmojis: [],
    chatGroupId: '',
    chatGroupDetail: null,
    collaborationGroupId: '',
    messageReactionPicker: null,
  });
  assert.doesNotThrow(() => renderChat());
  const html = renderChat();
  assert.match(html, /direct-social-chat-view/);
  assert.match(html, /data-favorite-emoji-remote=/);
  assert.match(html, /message-favorite-emoji-placeholder/);
  assert.equal(state.networkConversationPeerId, 'u2');
  assert.equal(state.networkMessageHomeOpen, false);
  assert.equal(state.messageActivePane, 'conversation');
  console.log('favorite emoji cancel conversation smoke passed');
} finally {
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, original);
}
