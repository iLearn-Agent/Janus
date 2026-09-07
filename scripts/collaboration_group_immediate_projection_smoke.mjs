import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-collaboration-projection-'));
const sentCodes = new Map();
const previousAuthUrl = process.env.JANUS_AUTH_URL;
let cloud = null;
let alice = null;
let bob = null;
let activePoll = null;
let releaseAgentExecution = null;
let releaseDelayedRequests = null;

try {
  cloud = createCloudServer({
    home: path.join(tempRoot, 'cloud'),
    token: 'collaboration-projection-cloud-token',
    syncToken: 'collaboration-projection-sync-token',
    emailCodeSecret: 'collaboration-projection-email-secret',
    mailer: {
      configured: true,
      async sendEmailCode({ email, purpose, code }) { sentCodes.set(`${email}:${purpose}`, code); },
    },
  });
  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  process.env.JANUS_AUTH_URL = `http://127.0.0.1:${address.port}`;
  alice = await createRuntime({ root: path.join(tempRoot, 'alice'), isDev: true });
  bob = await createRuntime({ root: path.join(tempRoot, 'bob'), isDev: true });
  await register(alice, 'alice.projection@example.com', 'Alice Projection', 'alice-password');
  await register(bob, 'bob.projection@example.com', 'Bob Projection', 'bob-password');

  const bobUser = (await alice.friendSearch({ query: 'bob.projection@example.com' }))[0];
  await alice.friendSendRequest({ userId: bobUser.id, message: 'projection test' });
  const incoming = (await bob.friendsOverview()).requests.incoming[0];
  await bob.friendAcceptRequest({ requestId: incoming.id });

  const aliceState = alice.db.prepare("SELECT access_token FROM cloud_auth_state WHERE id='default'").get();
  const response = await fetch(`${process.env.JANUS_AUTH_URL}/api/collaboration/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceState.access_token}` },
    body: JSON.stringify({
      workspaceId: 'workspace_personal',
      clientRequestId: 'collaboration-immediate-projection',
      title: 'Immediate projection group',
      assignments: [{
        recipientId: bobUser.id,
        title: 'Immediate projection task',
        instruction: 'Keep the Agent working while the recipient message list shows this group.',
      }],
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();

  let resolveProjection;
  const projectionReady = new Promise((resolve) => { resolveProjection = resolve; });
  let resolveAgentExecution;
  const agentExecution = new Promise((resolve) => { resolveAgentExecution = resolve; });
  releaseAgentExecution = resolveAgentExecution;
  let agentStarted = false;
  bob.startAgentDelegation = async () => {
    agentStarted = true;
    await agentExecution;
    return { ok: true };
  };

  activePoll = bob.pollSocialNetwork({
    autoProcess: true,
    onProjection(value) { resolveProjection(value); },
  });
  const projection = await Promise.race([
    projectionReady,
    new Promise((_, reject) => setTimeout(() => reject(new Error('collaboration projection timeout')), 5_000)),
  ]);
  assert.equal(projection.collaboration.groups.some((group) => group.id === created.group.id), true,
    'the first recipient projection must contain the new work group');
  assert.equal(bob.auth.collaborationOverview({ workspaceId: 'workspace_personal' }).groups
    .some((group) => group.id === created.group.id), true,
  'the first projection must already be persisted locally');
  await waitFor(() => agentStarted, 5_000, 'automatic Agent execution did not start');
  assert.equal(bob.auth.collaborationOverview({ workspaceId: 'workspace_personal' }).groups
    .some((group) => group.id === created.group.id), true,
  'the work group must remain visible while Agent execution is in progress');

  resolveAgentExecution();
  releaseAgentExecution = null;
  await activePoll;
  activePoll = null;

  let collaborationMode = 'failed';
  let repairCalls = 0;
  const repairGroupId = 'collab_group_projection_repair';
  const repairTask = {
    id: 'agent_delegate_projection_repair',
    workspaceId: 'workspace_personal',
    requesterUserId: alice.currentUser().id,
    recipientUserId: bob.currentUser().id,
    title: 'Repair missing group projection',
    instruction: 'Repair the group from the task groupId.',
    status: 'assigned',
    groupId: repairGroupId,
    metadata: { groupId: repairGroupId },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const relay = new SocialRelayService({
    db: bob.db,
    auth: bob.auth,
    client: {
      async messages(_state, payload = {}) { return { items: [], cursor: payload.cursor || '' }; },
      async delegations(_state, payload = {}) {
        return collaborationMode === 'repair'
          ? { items: [repairTask], cursor: repairTask.updatedAt, cursorId: repairTask.id }
          : { items: [], cursor: payload.cursor || '', cursorId: payload.cursorId || '' };
      },
      async friends() { return { friends: [], requests: { incoming: [], outgoing: [] } }; },
      async collaborationOverview() {
        if (collaborationMode === 'failed') throw new Error('temporary collaboration overview failure');
        return { groups: [], tasks: [repairTask] };
      },
      async collaborationGroup(_state, groupId) {
        repairCalls += 1;
        assert.equal(groupId, repairGroupId);
        return {
          group: {
            id: repairGroupId,
            workspaceId: 'workspace_personal',
            ownerUserId: alice.currentUser().id,
            title: 'Repaired projection group',
            status: 'active',
            memberCount: 2,
            unreadCount: 1,
            lastMessage: 'Recovered from delegation groupId.',
            createdAt: repairTask.createdAt,
            updatedAt: repairTask.updatedAt,
          },
          members: [{
            groupId: repairGroupId,
            userId: bob.currentUser().id,
            role: 'member',
            status: 'active',
            user: { id: bob.currentUser().id, email: bob.currentUser().email, displayName: bob.currentUser().displayName },
          }],
          tasks: [repairTask],
        };
      },
      async chatGroups() { return { groups: [], capability: 'chat-groups-v2' }; },
      async heartbeat() { return { ok: true }; },
    },
  });
  const stale = await relay.poll({ workspaceId: 'workspace_personal' });
  assert.equal(stale.collaborationSync.stale, true);
  assert.equal(stale.collaboration.groups.some((group) => group.id === created.group.id), true,
    'a failed overview must preserve the last valid cached group list');

  collaborationMode = 'repair';
  const repaired = await relay.poll({ workspaceId: 'workspace_personal' });
  assert.equal(repairCalls, 1, 'a missing delegation group must be fetched once by id');
  assert.equal(repaired.collaboration.groups.some((group) => group.id === repairGroupId), true,
    'the repaired group must enter the same poll projection');
  assert.equal(bob.auth.collaborationOverview({ workspaceId: 'workspace_personal' }).groups
    .some((group) => group.id === repairGroupId), true,
  'the repaired group must be persisted for later local reads');

  let releaseUnrelatedRequests;
  const unrelatedRequests = new Promise((resolve) => { releaseUnrelatedRequests = resolve; });
  releaseDelayedRequests = releaseUnrelatedRequests;
  relay.client.messages = async (_state, payload = {}) => {
    await unrelatedRequests;
    return { items: [], cursor: payload.cursor || '' };
  };
  relay.client.friends = async () => {
    await unrelatedRequests;
    return { friends: [], requests: { incoming: [], outgoing: [] } };
  };
  relay.client.collaborationOverview = async () => ({ groups: [created.group], tasks: [] });
  let resolveEarlyRelayProjection;
  const earlyRelayProjection = new Promise((resolve) => { resolveEarlyRelayProjection = resolve; });
  activePoll = relay.poll({
    workspaceId: 'workspace_personal',
    onCollaborationProjection(value) { resolveEarlyRelayProjection(value); },
  });
  const independentlyProjected = await Promise.race([
    earlyRelayProjection,
    new Promise((_, reject) => setTimeout(() => reject(new Error('overview projection waited for unrelated requests')), 1_000)),
  ]);
  assert.equal(independentlyProjected.collaboration.groups.some((group) => group.id === created.group.id), true,
    'collaboration overview must project before unrelated social requests finish');
  releaseUnrelatedRequests();
  releaseDelayedRequests = null;
  await activePoll;
  activePoll = null;
  console.log('collaboration group immediate projection smoke passed');
} finally {
  releaseAgentExecution?.();
  releaseDelayedRequests?.();
  await activePoll?.catch(() => null);
  await alice?.close?.();
  await bob?.close?.();
  if (cloud) await cloud.close();
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  await rm(tempRoot, { recursive: true, force: true });
}

async function register(runtime, email, displayName, password) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = sentCodes.get(`${email}:register`);
  assert.match(code, /^\d{6}$/);
  return runtime.authRegister({ email, displayName, password, code });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}
