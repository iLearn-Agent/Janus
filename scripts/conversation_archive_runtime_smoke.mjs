import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSocialRuntimeApi } from '../src/main/modules/collaboration/application/createSocialRuntimeApi.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-conversation-archive-runtime-'));
let runtime;

try {
  runtime = await createRuntime({ root: path.join(tempRoot, 'runtime'), isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const groupId = 'remote_only_collaboration_group';
  const remoteCalls = [];
  const onlineRelay = {
    connected: () => true,
    status: () => ({ deviceId: 'archive-smoke-device' }),
    async setConversationPreference(payload) {
      remoteCalls.push(payload);
      const result = {
        preference: {
          workspaceId: 'workspace_personal',
          conversationKind: 'collaboration_group',
          conversationId: groupId,
          archived: true,
          stateRevision: 1,
          lastCommandId: payload.commandId,
          sourceDeviceId: 'archive-smoke-device',
          createdAt: '2026-08-03T00:00:00.000Z',
          updatedAt: '2026-08-03T00:00:01.000Z',
        },
      };
      runtime.auth.importCloudConversationPreferences(result);
      return result;
    },
    async syncConversationPreferences() {
      return runtime.auth.conversationPreferencesOverview();
    },
  };
  const onlineApi = createSocialRuntimeApi({
    auth: runtime.auth,
    store: runtime.store,
    socialRelay: onlineRelay,
    runtimeRoot: runtime.root,
  });
  const remoteFirst = await onlineApi.setConversationArchived({
    conversationKind: 'collaboration_group',
    conversationId: groupId,
    archived: true,
    expectedRevision: 0,
    commandId: 'remote-first-archive',
  });
  assert.equal(remoteFirst.remoteFirst, true);
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0].conversationId, groupId);
  assert.equal(runtime.auth.conversationPreference({
    conversationKind: 'collaboration_group',
    conversationId: groupId,
  }).archived, true);
  assert.equal(runtime.db.prepare('SELECT 1 FROM collaboration_groups WHERE id=?').get(groupId), undefined,
    'remote-first archive must not invent a local group before a cloud membership snapshot arrives');

  const imported = runtime.auth.importCloudCollaborationOverview({
    groups: [{
      id: groupId,
      accountWorkspaceId: 'workspace_personal',
      ownerUserId: user.id,
      clientRequestId: 'remote-only-collaboration-request',
      title: '远端工作群',
      status: 'active',
      metadata: { source: 'archive-runtime-smoke' },
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:02.000Z',
      membership: {
        userId: user.id,
        role: 'owner',
        status: 'active',
        joinedAt: '2026-08-03T00:00:00.000Z',
      },
    }],
  });
  assert.deepEqual(imported, { importedGroups: 1, importedMemberships: 1 });
  assert.equal(runtime.db.prepare('SELECT title FROM collaboration_groups WHERE id=?').get(groupId).title, '远端工作群');
  assert.equal(runtime.db.prepare('SELECT status FROM collaboration_group_members WHERE group_id=? AND user_id=?')
    .get(groupId, user.id).status, 'active');

  const offlineRelay = {
    connected: () => false,
    status: () => ({ deviceId: 'archive-smoke-device' }),
  };
  const offlineApi = createSocialRuntimeApi({
    auth: runtime.auth,
    store: runtime.store,
    socialRelay: offlineRelay,
    runtimeRoot: runtime.root,
  });
  const offlineLocal = await offlineApi.setConversationArchived({
    conversationKind: 'collaboration_group',
    conversationId: groupId,
    archived: false,
    expectedRevision: 1,
    commandId: 'offline-local-restore',
  });
  assert.equal(offlineLocal.preference.archived, false);
  assert.equal(runtime.db.prepare("SELECT status FROM social_conversation_preference_outbox WHERE command_id='offline-local-restore'").get().status, 'pending');
  await assert.rejects(
    offlineApi.setConversationArchived({
      conversationKind: 'collaboration_group',
      conversationId: 'uncached_remote_group',
      archived: true,
      expectedRevision: 0,
      commandId: 'offline-missing-group',
    }),
    (error) => error?.code === 'conversation_preference_sync_required',
  );

  process.stdout.write('Conversation archive remote-first and cached offline runtime smoke passed.\n');
} finally {
  runtime?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
