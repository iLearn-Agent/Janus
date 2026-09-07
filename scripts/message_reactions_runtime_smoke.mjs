import assert from 'node:assert/strict';

import { createSocialRuntimeApi } from '../src/main/modules/collaboration/application/createSocialRuntimeApi.js';
import { MESSAGE_REACTION_EMOJIS, messageReactionGroups, toggleMessageReaction } from '../src/shared/messageReactions.js';

const base = { type: 'direct_message', reactions: [] };
const added = toggleMessageReaction(base, { emoji: MESSAGE_REACTION_EMOJIS[0], userId: 'u1', displayName: 'A', reactedAt: '2026-08-20T00:00:00.000Z' });
assert.equal(messageReactionGroups(added, 'u1')[0].count, 1);
const removed = toggleMessageReaction(added, { emoji: MESSAGE_REACTION_EMOJIS[0], userId: 'u1', displayName: 'A', reactedAt: '2026-08-20T00:00:01.000Z' });
assert.equal(messageReactionGroups(removed, 'u1').length, 0);
assert.throws(() => toggleMessageReaction(base, { emoji: 'not-an-emoji', userId: 'u1' }));

let remoteToggle = null;
const localMessage = {
  id: 'm-local',
  remoteId: 'm-remote',
  workspaceId: 'workspace_personal',
  accountWorkspaceId: 'workspace_personal',
};
const api = createSocialRuntimeApi({
  auth: {
    requireUser: () => ({ id: 'u1' }),
    socialMessageById: (messageId, options = {}) => {
      assert.equal(messageId, 'm-local');
      assert.equal(options.accountGlobal, true);
      return localMessage;
    },
    socialToggleMessageReaction: (payload = {}) => {
      assert.equal(payload.messageId, 'm-local');
      assert.equal(payload.workspaceId, 'workspace_personal');
      return { ok: true, message: { ...localMessage, metadata: { reactions: [{ emoji: payload.emoji, userId: 'u1' }] } } };
    },
    socialInbox: () => [],
    socialConversation: () => [],
  },
  store: { activeAccountWorkspace: () => ({ id: 'workspace_personal' }), contextDeviceId: () => 'local' },
  socialRelay: {
    connected: () => true,
    toggleMessageReaction: async (messageId, payload = {}) => {
      remoteToggle = { messageId, payload };
      return { ok: true, message: { ...localMessage, id: 'm-local', remoteId: messageId } };
    },
  },
});
await api.socialToggleMessageReaction({ messageId: 'm-local', emoji: '👍' });
assert.equal(remoteToggle.messageId, 'm-remote');
assert.equal(remoteToggle.payload.messageId, 'm-remote');
assert.equal(remoteToggle.payload.workspaceId, 'workspace_personal');

const fallbackApi = createSocialRuntimeApi({
  auth: {
    requireUser: () => ({ id: 'u1' }),
    socialMessageById: () => ({ ...localMessage, remoteId: 'missing-remote' }),
    socialToggleMessageReaction: () => ({ ok: true, message: localMessage }),
    socialInbox: () => [],
    socialConversation: () => [],
  },
  store: { activeAccountWorkspace: () => ({ id: 'workspace_personal' }), contextDeviceId: () => 'local' },
  socialRelay: {
    connected: () => true,
    toggleMessageReaction: async () => {
      const error = new Error('消息不存在或无权回应。');
      error.status = 404;
      throw error;
    },
  },
});
assert.equal((await fallbackApi.socialToggleMessageReaction({ messageId: 'm-local', emoji: '❤️' })).message.id, 'm-local');

console.log('message reactions runtime smoke passed');
