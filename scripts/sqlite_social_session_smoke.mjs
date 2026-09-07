import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-sqlite-social-'));
const cloudHome = path.join(tempRoot, 'cloud');
const rootA = path.join(tempRoot, 'alice');
const rootB = path.join(tempRoot, 'bob');
const sentCodes = new Map();
const previousAuthUrl = process.env.JANUS_AUTH_URL;
let cloud;
let alice;
let bob;

try {
  cloud = createCloudServer({
    home: cloudHome,
    token: 'sqlite-social-cloud-token',
    syncToken: 'sqlite-social-sync-token',
    emailCodeSecret: 'sqlite-social-email-code-secret',
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
  await register(alice, 'alice.sqlite@example.com', 'Alice SQLite', 'alice-password');
  await register(bob, 'bob.sqlite@example.com', 'Bob SQLite', 'bob-password');

  const bobSearch = (await alice.friendSearch({ query: 'bob.sqlite@example.com' }))[0];
  assert.ok(bobSearch?.id);
  await assert.rejects(
    alice.socialSendMessage({ recipientId: bobSearch.id, content: 'must fail before friendship' }),
    /只能联系已添加的好友/,
  );

  const greeting = '你好，我是 Alice，负责本周报告，希望与你和 uBuddy 协作。';
  await alice.friendSendRequest({ userId: bobSearch.id, message: greeting });
  const incoming = (await bob.friendsOverview()).requests.incoming[0];
  assert.equal(incoming.message, greeting);
  assert.equal((await alice.friendsOverview()).friends.length, 0);
  await bob.friendAcceptRequest({ requestId: incoming.id });
  assert.equal((await alice.friendsOverview()).friends.length, 1);
  assert.equal((await bob.friendsOverview()).friends.length, 1);

  const remarkedBob = await alice.friendUpdateRemark({ userId: bobSearch.id, remark: '报告协作人 Bob' });
  assert.equal(remarkedBob.overview.friends[0].remark, '报告协作人 Bob');
  assert.equal((await bob.friendsOverview()).friends[0].remark, '', 'friend remarks must remain private to the owner');

  await alice.socialSendMessage({ recipientId: bobSearch.id, content: '好友聊天闭环消息', kind: 'friend' });
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.content === '好友聊天闭环消息'), true);

  bob.db.prepare("UPDATE cloud_auth_state SET access_token='' WHERE id='default'").run();
  assert.equal(bob.socialStatus().connected, true, 'a saved refresh token must keep the relay reconnectable');
  await alice.socialSendMessage({ recipientId: bobSearch.id, content: '刷新令牌自动恢复消息', kind: 'friend' });
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.content === '刷新令牌自动恢复消息'), true);

  const recallable = await alice.socialSendMessage({
    recipientId: bobSearch.id,
    content: '这条自然人私聊消息将被撤回',
    kind: 'friend',
    metadata: { type: 'direct_message' },
  });
  await alice.socialUpdateMessage({ messageId: recallable.message.id, action: 'withdraw' });
  await bob.pollSocialNetwork({ autoProcess: false });
  const withdrawnDirectMessage = bob.socialConversation({ peerId: alice.currentUser().id })
    .find((item) => item.id === recallable.message.id);
  assert.equal(withdrawnDirectMessage?.metadata?.withdrawn, true);
  assert.equal(withdrawnDirectMessage?.content, '这条自然人私聊消息将被撤回', 'withdrawal must preserve stored message content');
  await assert.rejects(
    bob.socialUpdateMessage({ messageId: recallable.message.id, action: 'withdraw' }),
    /消息不存在或无权修改/,
  );
  const agentDirect = await alice.socialSendMessage({
    recipientId: bobSearch.id,
    content: 'Agent 消息不可通过自然人撤回功能撤回',
    kind: 'agent',
    senderAgentId: 'secretary_agent',
    metadata: { type: 'direct_message' },
  });
  await assert.rejects(
    alice.socialUpdateMessage({ messageId: agentDirect.message.id, action: 'withdraw' }),
    /只能撤回自己发送的自然人私聊消息/,
  );
  const expiredDirect = await alice.socialSendMessage({
    recipientId: bobSearch.id,
    content: '这条自然人私聊消息已经超过撤回时间',
    kind: 'friend',
    metadata: { type: 'direct_message' },
  });
  cloud.db.prepare('UPDATE social_messages SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 3 * 60 * 1000).toISOString(), expiredDirect.message.id);
  await assert.rejects(
    alice.socialUpdateMessage({ messageId: expiredDirect.message.id, action: 'withdraw' }),
    /消息发送超过2分钟，无法撤回/,
  );

  const readonlyGroupId = 'sqlite-readonly-group';
  await alice.socialSendMessage({
    recipientId: bobSearch.id,
    kind: 'system',
    content: '创建只读测试群聊。',
    metadata: { type: 'social_task_group', action: 'created', taskGroupId: readonlyGroupId },
  });
  await alice.socialSendMessage({
    recipientId: bobSearch.id,
    kind: 'friend',
    content: '解散前应保留的历史消息。',
    metadata: { type: 'social_task_group_message', taskGroupId: readonlyGroupId },
  });
  await alice.socialSendMessage({
    recipientId: bobSearch.id,
    kind: 'system',
    content: '解散只读测试群聊。',
    metadata: { type: 'social_task_group', action: 'dissolved', taskGroupId: readonlyGroupId },
  });
  await assert.rejects(
    alice.socialSendMessage({
      recipientId: bobSearch.id,
      kind: 'friend',
      content: '解散后不应发送。',
      metadata: { type: 'social_task_group_message', taskGroupId: readonlyGroupId },
    }),
    /任务群已解散，只能查看历史记录/,
  );
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.content === '解散前应保留的历史消息。'), true);

  const delegated = await alice.createAgentDelegation({
    recipientId: bobSearch.id,
    title: 'uBuddy 交接测试',
    instruction: '请由你的 uBuddy 接收报告整理工作，并返回完成说明。',
    senderAgentId: 'secretary_agent',
    recipientAgentId: 'secretary_agent',
  });
  assert.equal(delegated.delegation.status, 'assigned');
  assert.equal(delegated.delegation.metadata.remotePermissionIntent, 'full-access');
  assert.equal(delegated.delegation.metadata.permissionOwner, 'recipient');
  await bob.pollSocialNetwork({ autoProcess: false });
  const incomingDelegation = bob.agentDelegations({ direction: 'incoming' }).find((item) => item.id === delegated.delegation.id);
  assert.equal(incomingDelegation.status, 'accepted');
  assert.equal(incomingDelegation.metadata.remotePermissionIntent, 'full-access');
  const recipientAccepted = await bob.respondAgentDelegation({
    delegationId: incomingDelegation.id, action: 'accept', sandboxPermission: 'auto-approve',
  });
  assert.equal(recipientAccepted.delegation.status, 'running');
  assert.equal(recipientAccepted.delegation.metadata.executionPermissionMode, 'auto-approve');
  assert.equal(recipientAccepted.delegation.metadata.executionPermissionOwner, 'recipient');
  assert.ok(recipientAccepted.delegation.metadata.executionPermissionDeviceId);
  const accepted = await bob.startAgentDelegation({ delegationId: incomingDelegation.id, execute: false });
  assert.equal(accepted.delegation.status, 'accepted');
  assert.equal(accepted.session.departmentId, 'agent_delegation');
  await alice.pollSocialNetwork({ autoProcess: false });
  assert.equal(alice.agentDelegations({ direction: 'outgoing' }).find((item) => item.id === incomingDelegation.id)?.status, 'accepted');

  const bobState = bob.db.prepare("SELECT access_token FROM cloud_auth_state WHERE id = 'default'").get();
  const completed = await fetch(`${process.env.JANUS_AUTH_URL}/api/delegations/${encodeURIComponent(incomingDelegation.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bobState.access_token}` },
    body: JSON.stringify({ status: 'completed', sessionId: accepted.session.id, result: 'uBuddy 已完成报告整理并交还结果。' }),
  });
  assert.equal(completed.status, 200);
  await alice.pollSocialNetwork({ autoProcess: false });
  assert.equal(alice.agentDelegations({ direction: 'outgoing' }).find((item) => item.id === incomingDelegation.id)?.status, 'completed');
  assert.equal(alice.socialConversation({ peerId: bob.currentUser().id }).some((item) => item.content.includes('uBuddy 已完成报告整理')), true);

  const aliceId = alice.currentUser().id;
  alice.close();
  alice = await createRuntime({ root: rootA, isDev: true });
  const restored = await alice.bootstrap();
  assert.equal(restored.currentUser?.id, aliceId);
  assert.equal(restored.authSession?.restored, true);
  assert.equal(restored.authSession?.expired, undefined);

  alice.db.prepare("UPDATE cloud_auth_state SET updated_at = ? WHERE id = 'default'").run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());
  alice.close();
  alice = await createRuntime({ root: rootA, isDev: true });
  const expired = await alice.bootstrap();
  assert.equal(expired.currentUser, null);
  assert.equal(expired.authSession?.expired, true);
  assert.equal(alice.db.prepare("SELECT access_token, refresh_token FROM cloud_auth_state WHERE id = 'default'").get().access_token, '');

  process.stdout.write('SQLite friends, chat, uBuddy delegation, and persistent session smoke passed.\n');
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
