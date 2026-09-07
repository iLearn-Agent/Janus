import assert from 'node:assert/strict';

import { createSocialRuntimeApi } from '../src/main/modules/collaboration/application/createSocialRuntimeApi.js';

let localCreatePayload = null;
let relayCreateAttempts = 0;
let markedOutbox = null;
const group = { id: 'chat_local_1', title: '离线创建群聊' };
const api = createSocialRuntimeApi({
  auth: {
    requireUser: () => ({ id: 'alice' }),
    createChatGroup(payload) {
      localCreatePayload = payload;
      return { group };
    },
    chatGroup: () => ({ group, members: [], messages: [] }),
    chatGroupsOverview: () => ({ groups: [group] }),
    listChatGroupOutbox: () => [{
      id: 'outbox_1', operation_kind: 'create_group', aggregate_id: group.id,
      account_workspace_id: 'workspace_personal', payload: { title: group.title },
    }],
    markChatGroupOutbox(payload) { markedOutbox = payload; },
  },
  store: {
    activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
    contextDeviceId: () => 'offline-create-smoke',
  },
  socialRelay: {
    connected: () => true,
    async socialCapabilities() { throw new TypeError('fetch failed'); },
    async createChatGroup() {
      relayCreateAttempts += 1;
      throw new TypeError('fetch failed');
    },
  },
});

const detail = await api.createChatGroup({ title: group.title, memberIds: ['bob'] });
assert.equal(detail.group.id, group.id);
assert.deepEqual(await api.chatGroupsOverview(), { groups: [group], remoteEnabled: null });
assert.equal((await api.chatGroup({ groupId: group.id })).group.id, group.id);
assert.deepEqual(localCreatePayload, {
  title: group.title,
  memberIds: ['bob'],
  workspaceId: 'workspace_personal',
});
assert.equal(relayCreateAttempts, 1);
assert.equal(markedOutbox?.id, 'outbox_1');
assert.equal(markedOutbox?.status, 'failed');
assert.match(markedOutbox?.error || '', /fetch failed/);

const unsupportedApi = createSocialRuntimeApi({
  auth: {
    requireUser: () => ({ id: 'alice' }),
    createChatGroup() { throw new Error('local creation must not run'); },
  },
  store: {
    activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
    contextDeviceId: () => 'unsupported-create-smoke',
  },
  socialRelay: {
    connected: () => true,
    async socialCapabilities() { return { capabilities: [] }; },
  },
});
await assert.rejects(() => unsupportedApi.createChatGroup({ memberIds: ['bob'] }), (error) => (
  error?.code === 'chat_groups_server_update_required'
));

console.log('chat group transient offline creation smoke passed');
