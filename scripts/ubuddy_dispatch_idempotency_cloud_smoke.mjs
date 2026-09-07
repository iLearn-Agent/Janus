import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-dispatch-cloud-idempotency-'));
const cloudHome = path.join(tempRoot, 'cloud');
const rootA = path.join(tempRoot, 'alice');
const rootB = path.join(tempRoot, 'bob');
const sentCodes = new Map();
const previousAuthUrl = process.env.JANUS_AUTH_URL;
let cloud = null;
let alice = null;
let bob = null;

try {
  cloud = createCloudServer({
    home: cloudHome,
    token: 'ubuddy-dispatch-cloud-token',
    syncToken: 'ubuddy-dispatch-cloud-sync-token',
    emailCodeSecret: 'ubuddy-dispatch-cloud-email-code-secret',
    mailer: {
      configured: true,
      async sendEmailCode({ email, purpose, code }) {
        sentCodes.set(`${email}:${purpose}`, code);
      },
    },
  });
  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  process.env.JANUS_AUTH_URL = `http://127.0.0.1:${address.port}`;
  alice = await createRuntime({ root: rootA, isDev: true });
  bob = await createRuntime({ root: rootB, isDev: true });
  await register(alice, 'dispatch-cloud-alice@example.com', 'Dispatch Alice', 'alice-password');
  await register(bob, 'dispatch-cloud-bob@example.com', 'Dispatch Bob', 'bob-password');

  const bobSearch = (await alice.friendSearch({ query: 'dispatch-cloud-bob@example.com' }))[0];
  await alice.friendSendRequest({ userId: bobSearch.id, message: '验证派发恢复幂等。' });
  const incoming = (await bob.friendsOverview()).requests.incoming[0];
  await bob.friendAcceptRequest({ requestId: incoming.id });

  const authState = alice.db.prepare("SELECT access_token FROM cloud_auth_state WHERE id='default'").get();
  const capabilitiesResponse = await fetch(`${process.env.JANUS_AUTH_URL}/api/social/capabilities`, {
    headers: { authorization: `Bearer ${authState.access_token}` },
  });
  assert.equal(capabilitiesResponse.status, 200);
  const capabilities = await capabilitiesResponse.json();
  assert.equal(capabilities.capabilities.includes('delegation-create-idempotency-v1'), true);

  const firstMessage = await alice.socialSendMessage({
    recipientId: bobSearch.id,
    clientMessageId: 'embedded-cloud-message-idempotency-1',
    content: '恢复派发时消息只发送一次。',
    kind: 'agent',
  });
  const repeatedMessage = await alice.socialSendMessage({
    recipientId: bobSearch.id,
    clientMessageId: 'embedded-cloud-message-idempotency-1',
    content: '恢复派发时消息只发送一次。',
    kind: 'agent',
  });
  assert.equal(repeatedMessage.idempotent, true);
  assert.equal(repeatedMessage.message.id, firstMessage.message.id);
  await assert.rejects(alice.socialSendMessage({
    recipientId: bobSearch.id,
    clientMessageId: 'embedded-cloud-message-idempotency-1',
    content: '同一个消息键不能更换内容。',
    kind: 'agent',
  }), (error) => error?.code === 'social_message_idempotency_conflict');
  assert.equal(cloud.db.prepare("SELECT COUNT(*) AS count FROM social_messages WHERE id='embedded-cloud-message-idempotency-1'").get().count, 1);

  const delegationPayload = {
    recipientId: bobSearch.id,
    clientRequestId: 'embedded-cloud-delegation-idempotency-1',
    title: '恢复派发幂等委托',
    instruction: '恢复或重试时必须复用同一份委托。',
    senderAgentId: 'secretary_agent',
    recipientAgentId: 'secretary_agent',
  };
  const firstDelegation = await alice.createAgentDelegation(delegationPayload);
  const repeatedDelegation = await alice.createAgentDelegation(delegationPayload);
  assert.equal(repeatedDelegation.idempotent, true);
  assert.equal(repeatedDelegation.delegation.id, firstDelegation.delegation.id);
  await assert.rejects(alice.createAgentDelegation({
    ...delegationPayload,
    instruction: '同一个委托键不能更换任务内容。',
  }), (error) => error?.code === 'delegation_idempotency_conflict');
  assert.equal(cloud.db.prepare(`SELECT COUNT(*) AS count FROM agent_delegations
    WHERE requester_user_id=? AND client_request_id=?`).get(alice.currentUser().id, delegationPayload.clientRequestId).count, 1);

  console.log('uBuddy embedded-cloud dispatch idempotency smoke passed');
} finally {
  alice?.close();
  bob?.close();
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
