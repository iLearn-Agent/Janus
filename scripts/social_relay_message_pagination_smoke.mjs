import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-social-relay-pagination-'));
let runtime = null;

try {
  runtime = await createRuntime({ root, isDev: true });
  const current = runtime.auth.currentUser();
  const peerId = 'relay_pagination_peer';
  runtime.db.prepare('UPDATE auth_users SET remote_id=? WHERE id=?').run('remote-relay-pagination-current', current.id);
  runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,remote_id,email_verified)
    VALUES(?,?,?,?,1)`).run(peerId, 'relay-pagination-peer@example.test', 'Relay Pagination Peer', 'remote-relay-pagination-peer');
  runtime.store.ensureAccountWorkspaces({ user: runtime.auth.getUser(peerId) });

  const remoteCurrentId = 'remote-relay-pagination-current';
  const remotePeerId = 'remote-relay-pagination-peer';
  const messages = Array.from({ length: 503 }, (_, index) => {
    const createdAt = new Date(Date.UTC(2026, 7, 5, 0, 0, 0, index)).toISOString();
    return {
      id: `relay_pagination_message_${String(index).padStart(3, '0')}`,
      workspaceId: 'workspace_personal',
      senderUserId: remotePeerId,
      recipientUserId: remoteCurrentId,
      sender: { id: remotePeerId, email: 'relay-pagination-peer@example.test', displayName: 'Relay Pagination Peer' },
      recipient: { id: remoteCurrentId, email: current.email, displayName: current.displayName },
      kind: 'friend',
      content: `relay-pagination-content-${index}`,
      status: 'unread',
      metadata: { type: 'direct_message' },
      createdAt,
      updatedAt: createdAt,
    };
  });
  const firstCursor = messages[499].updatedAt;
  const finalCursor = messages.at(-1).updatedAt;
  const requestedCursors = [];
  const delegationTimestamp = '2026-08-05T01:00:00.000Z';
  const delegations = Array.from({ length: 205 }, (_, index) => ({
    id: `relay_pagination_delegation_${String(index).padStart(3, '0')}`,
    workspaceId: 'workspace_personal',
    requesterUserId: remotePeerId,
    recipientUserId: remoteCurrentId,
    requester: { id: remotePeerId, email: 'relay-pagination-peer@example.test', displayName: 'Relay Pagination Peer' },
    recipient: { id: remoteCurrentId, email: current.email, displayName: current.displayName },
    title: `Relay pagination delegation ${index}`,
    instruction: `Process relay pagination delegation ${index}`,
    status: 'assigned',
    metadata: {},
    createdAt: delegationTimestamp,
    updatedAt: delegationTimestamp,
  }));
  const requestedDelegationCursors = [];
  const relay = new SocialRelayService({
    db: runtime.db,
    auth: runtime.auth,
    client: {
      async messages(_state, payload = {}) {
        requestedCursors.push(String(payload.cursor || ''));
        if (!payload.cursor) return { items: messages.slice(0, 500), cursor: firstCursor };
        if (payload.cursor === firstCursor) return { items: messages.slice(500), cursor: finalCursor };
        return { items: [], cursor: payload.cursor };
      },
      async delegations(_state, payload = {}) {
        requestedDelegationCursors.push({ cursor: String(payload.cursor || ''), cursorId: String(payload.cursorId || '') });
        if (!payload.cursor) return {
          items: delegations.slice(0, 200), cursor: delegationTimestamp, cursorId: delegations[199].id,
        };
        if (payload.cursor === delegationTimestamp && payload.cursorId === delegations[199].id) return {
          items: delegations.slice(200), cursor: delegationTimestamp, cursorId: delegations.at(-1).id,
        };
        return { items: [], cursor: payload.cursor, cursorId: payload.cursorId };
      },
      async friends() { return { friends: [], requests: { incoming: [], outgoing: [] } }; },
      async collaborationOverview() { return { groups: [], tasks: [] }; },
      async collaborationGroup() {
        const error = new Error('remote collaboration group missing');
        error.status = 404;
        throw error;
      },
      async chatGroups() { return { groups: [], messages: [], members: [], capability: 'chat-groups-v2' }; },
      async heartbeat() { return { ok: true }; },
    },
  });
  runtime.db.prepare(`UPDATE cloud_auth_state SET server_url='https://relay-pagination.invalid',enabled=1,
    access_token='relay-pagination-token',refresh_token='relay-pagination-refresh',remote_user_id=?,
    last_social_message_cursor='',updated_at=datetime('now') WHERE id='default'`).run(remoteCurrentId);

  const firstPoll = await relay.poll({ workspaceId: 'workspace_personal' });
  assert.equal(firstPoll.messages, 500, 'the bounded first poll should import only the first server page');
  assert.equal(firstPoll.historyCatchUp, true);
  assert.equal(firstPoll.incomingMessages.length, 0, 'the first history page must not be emitted as newly delivered messages');
  assert.deepEqual(requestedCursors, ['']);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM social_messages').get().count, 500);
  assert.equal(firstPoll.delegations, 205, 'delegation polling must continue through a timestamp tie using the delegation id');
  assert.equal(firstPoll.delegationHistoryCatchUp, true, 'the initial delegation import must be identified as history catch-up');
  assert.deepEqual(firstPoll.delegationHistoryCatchUpWorkspaceIds, ['workspace_personal']);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM agent_delegations').get().count, 205);
  assert.deepEqual(requestedDelegationCursors, [
    { cursor: '', cursorId: '' },
    { cursor: delegationTimestamp, cursorId: delegations[199].id },
  ]);
  assert.equal(runtime.db.prepare("SELECT last_social_message_cursor cursor FROM cloud_auth_state WHERE id='default'").get().cursor, firstCursor);

  const secondPoll = await relay.poll({ workspaceId: 'workspace_personal' });
  assert.equal(secondPoll.messages, 3, 'the next poll should continue the pending history page');
  assert.equal(secondPoll.historyCatchUp, true);
  assert.equal(secondPoll.incomingMessages.length, 0, 'the final history page must remain notification-silent');
  assert.deepEqual(requestedCursors, ['', firstCursor]);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM social_messages').get().count, 503);
  assert.equal(secondPoll.delegations, 0);
  assert.equal(secondPoll.delegationHistoryCatchUp, false, 'a completed delegation baseline must not suppress later updates');
  assert.deepEqual(requestedDelegationCursors.at(-1), {
    cursor: delegationTimestamp, cursorId: delegations.at(-1).id,
  });
  assert.equal(runtime.db.prepare("SELECT last_social_message_cursor cursor FROM cloud_auth_state WHERE id='default'").get().cursor, finalCursor);

  const thirdPoll = await relay.poll({ workspaceId: 'workspace_personal' });
  assert.equal(thirdPoll.messages, 0, 'a later poll should have no delayed page');
  assert.equal(thirdPoll.historyCatchUp, false);
  assert.equal(runtime.db.prepare('SELECT COUNT(*) count FROM social_messages').get().count, 503);
  assert.deepEqual(requestedCursors, ['', firstCursor, finalCursor]);

  runtime.db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status)
    VALUES('relay_local_history_friendship',?,?, 'accepted')`).run(...[current.id, peerId].sort());
  const localHistory = runtime.auth.createCollaborationGroup({
    title: 'Local history group',
    workspaceId: 'workspace_personal',
    assignments: [{ recipientId: peerId, title: 'Historical task', instruction: 'Preserve this local-only group.' }],
  });
  const mergedOverview = await relay.collaborationOverview({ workspaceId: 'workspace_personal' });
  const localHistoryGroup = mergedOverview.groups.find((group) => group.id === localHistory.group.id);
  assert.equal(localHistoryGroup?.localHistoryOnly, true, 'cloud overview must preserve local-only historical groups');
  assert.equal(mergedOverview.tasks.length, 0, 'cloud-connected task overview must not merge stale local tasks');
  await assert.rejects(
    () => relay.collaborationGroup(localHistory.group.id, { workspaceId: 'workspace_personal' }),
    /remote collaboration group missing/,
    'local fallback must require an explicit local-history marker from the overview row',
  );
  const localHistoryDetail = await relay.collaborationGroup(localHistory.group.id, {
    workspaceId: 'workspace_personal',
    localHistoryOnly: true,
  });
  assert.equal(localHistoryDetail.localHistoryOnly, true);
  assert.equal(localHistoryDetail.workspace.readOnly, true, 'a local-only historical group must open read-only while cloud-connected');
  relay.client.collaborationGroup = async () => {
    const error = new Error('remote collaboration membership denied');
    error.status = 403;
    throw error;
  };
  await assert.rejects(
    () => relay.collaborationGroup(localHistory.group.id, { workspaceId: 'workspace_personal', localHistoryOnly: true }),
    /remote collaboration membership denied/,
    'authorization failures must never expose a local cached group',
  );

  process.stdout.write('Social relay message pagination smoke passed.\n');
} finally {
  try { await runtime?.close?.(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
