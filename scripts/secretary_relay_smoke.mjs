import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DataType, newDb } from 'pg-mem';

import { migrate } from '../cloud/src/db.mjs';
import { createApp } from '../cloud/src/server.mjs';
import { createRuntime } from '../src/main/runtime.js';

const memoryDb = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
memoryDb.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea,
  implementation: (value, format) => Buffer.from(String(value || ''), String(format || 'base64')) });
const { Pool } = memoryDb.adapters.createPg();
const pool = new Pool();
const codes = new Map();
let server = null;
let alice = null;
let bob = null;
let rootA = '';
let rootB = '';
const previousAuthUrl = process.env.JANUS_AUTH_URL;
const previousUBuddyProcessingMode = process.env.JANUS_UBUDDY_PROCESSING_MODE;

try {
  process.env.JANUS_UBUDDY_PROCESSING_MODE = 'fallback';
  await migrate(pool);
  const app = createApp({
    pool,
    config: {
      jwtSecret: 'secretary-smoke-jwt-secret-that-is-long-enough',
      emailCodeSecret: 'secretary-smoke-code-secret-that-is-long-enough',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      emailCodeTtlMinutes: 10,
      env: { JANUS_EVOLUTION_ALLOW_PLAINTEXT_TEST_ONLY: '1' },
    },
    mailer: {
      async sendEmailCode({ email, code, purpose }) {
        codes.set(`${email}:${purpose}`, code);
      },
    },
  });
  server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  process.env.JANUS_AUTH_URL = `http://127.0.0.1:${server.address().port}`;

  rootA = await mkdtemp(path.join(os.tmpdir(), 'janus-secretary-alice-'));
  rootB = await mkdtemp(path.join(os.tmpdir(), 'janus-secretary-bob-'));
  alice = await createRuntime({ root: rootA, isDev: true });
  bob = await createRuntime({ root: rootB, isDev: true });

  await register(alice, 'alice-secretary@example.com', 'Alice Secretary', 'alice-password');
  await register(bob, 'bob-secretary@example.com', 'Bob Secretary', 'bob-password');
  assert.equal(alice.db.prepare("SELECT user_id FROM cloud_sync_state WHERE id = 'default'").get().user_id, alice.currentUser().id);
  assert.equal(bob.db.prepare("SELECT user_id FROM cloud_sync_state WHERE id = 'default'").get().user_id, bob.currentUser().id);

  const bobResult = (await alice.friendSearch({ query: 'bob-secretary@example.com' }))[0];
  assert.ok(bobResult?.id);
  await alice.friendSendRequest({ userId: bobResult.id, message: 'secretary relay smoke' });
  const incoming = (await bob.friendsOverview()).requests.incoming[0];
  assert.ok(incoming?.id);
  await bob.friendAcceptRequest({ requestId: incoming.id });
  await alice.friendsOverview();

  await alice.socialSendMessage({
    recipientId: bobResult.id,
    senderAgentId: 'secretary_agent',
    recipientAgentId: 'secretary_agent',
    kind: 'agent',
    content: 'secretary relay message',
  });
  await bob.pollSocialNetwork({ autoProcess: false });
  assert.equal(
    bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.content === 'secretary relay message'),
    true,
  );

  const directAttachmentBytes = Buffer.from('DIRECT_RUNTIME_ATTACHMENT_OK\n', 'utf8');
  const directLocalAttachment = alice.uploadFile({
    filename: 'direct-runtime-attachment.md',
    contentType: 'text/markdown',
    dataBase64: directAttachmentBytes.toString('base64'),
  });
  const directAttachmentMessage = await alice.socialSendMessage({
    recipientId: bobResult.id,
    kind: 'friend',
    content: 'direct runtime attachment',
    metadata: { type: 'direct_message', attachments: [directLocalAttachment] },
  });
  const sentDirectAttachment = directAttachmentMessage.message.metadata.attachments[0];
  assert.ok(sentDirectAttachment.remote_file_id);
  assert.equal(sentDirectAttachment.remote_file_kind, 'social');
  assert.equal(Object.hasOwn(sentDirectAttachment, 'path'), false);
  await bob.pollSocialNetwork({ autoProcess: false });
  const receivedDirectAttachment = bob.socialConversation({ peerId: alice.currentUser().id })
    .find((item) => item.id === directAttachmentMessage.message.id)?.metadata?.attachments?.[0];
  assert.equal(receivedDirectAttachment?.remote_file_id, sentDirectAttachment.remote_file_id);
  const downloadedDirectAttachment = await bob.collaborationDownloadFile({
    fileId: receivedDirectAttachment.remote_file_id,
    filename: receivedDirectAttachment.filename,
    sha256: receivedDirectAttachment.sha256,
    remoteFileKind: receivedDirectAttachment.remote_file_kind,
  });
  assert.deepEqual(await readFile(downloadedDirectAttachment.path), directAttachmentBytes);

  const legacyDelegationPrimary = alice.store.createSession({
    title: 'Legacy delegation primary',
    departmentId: 'agent_delegation',
    agentId: 'secretary_agent',
    userId: alice.currentUser().id,
  });
  assert.equal(legacyDelegationPrimary.conversationRole, 'primary');
  const secretaryContextSession = alice.ensureSecretarySession();
  alice.store.addMessage({
    sessionId: secretaryContextSession.id,
    role: 'user',
    content: '旧任务：制作一份与当前委托无关的环境治理 PPT。',
    agentId: 'secretary_agent',
    departmentId: 'secretary_department',
    metadata: { secretaryControl: true },
  });
  alice.store.addMessage({
    sessionId: secretaryContextSession.id,
    role: 'user',
    content: '先记录：本次只验证秘书转发链路。',
    agentId: 'secretary_agent',
    departmentId: 'secretary_department',
    metadata: { secretaryControl: true, contextCollection: true },
  });
  const secretaryDispatch = await alice.secretaryChat({
    message: '@Bob 请创建任务群，让 Bob Secretary complete the cross-client secretary relay smoke test.',
    mentions: [{ principalType: 'user', userId: bobResult.id, displayText: '@Bob', mentionId: 'mention_bob_dispatch', source: 'picker' }],
  });
  assert.equal(secretaryDispatch.session.departmentId, 'secretary_department');
  assert.notEqual(secretaryDispatch.session.id, legacyDelegationPrimary.id, 'uBuddy must not reuse an agent_delegation primary session');
  assert.equal(secretaryDispatch.uBuddyMode, 'dispatched');
  assert.equal(secretaryDispatch.dispatchType, 'task_group');
  const staleOtherUserSecretarySession = alice.store.createSession({
    title: 'Stale other-user uBuddy session',
    departmentId: 'secretary_department',
    agentId: 'secretary_agent',
    userId: 'local_admin',
  });
  assert.equal(
    alice.ensureSecretarySession({ sessionId: staleOtherUserSecretarySession.id }).id,
    secretaryDispatch.session.id,
    'a stale cross-account uBuddy session ID must resolve to the current user session',
  );
  const publishedDispatch = secretaryDispatch.group;
  const publishedTask = publishedDispatch.tasks.find((task) => task.recipientUserId === bobResult.id);
  assert.ok(publishedDispatch.group?.id);
  assert.ok(publishedTask);
  const aliceCollaboration = await alice.collaborationOverview();
  assert.equal(aliceCollaboration.groups.some((group) => group.id === publishedDispatch.group.id), true);
  assert.equal(aliceCollaboration.tasks.some((task) => task.id === publishedTask.id && task.requesterUserId === alice.currentUser().id), true);
  const groupAttachmentBytes = Buffer.from('GROUP_RUNTIME_ATTACHMENT_OK\n', 'utf8');
  const groupLocalAttachment = alice.uploadFile({
    filename: 'group-runtime-attachment.md',
    contentType: 'text/markdown',
    dataBase64: groupAttachmentBytes.toString('base64'),
  });
  const groupAttachmentResult = await alice.sendCollaborationMessage({
    groupId: publishedDispatch.group.id,
    content: 'group runtime attachment',
    kind: 'friend',
    metadata: { attachments: [groupLocalAttachment] },
  });
  const sentGroupAttachment = groupAttachmentResult.messages.at(-1).metadata.attachments[0];
  assert.ok(sentGroupAttachment.remote_file_id);
  assert.equal(sentGroupAttachment.remote_file_kind, 'collaboration_group');
  assert.equal(sentGroupAttachment.group_id, publishedDispatch.group.id);
  assert.equal(Object.hasOwn(sentGroupAttachment, 'path'), false);
  const bobGroupDetail = await bob.collaborationGroup({ groupId: publishedDispatch.group.id });
  const receivedGroupAttachment = bobGroupDetail.messages
    .find((item) => item.content === 'group runtime attachment')?.metadata?.attachments?.[0];
  assert.equal(receivedGroupAttachment?.remote_file_id, sentGroupAttachment.remote_file_id);
  const downloadedGroupAttachment = await bob.collaborationDownloadFile({
    fileId: receivedGroupAttachment.remote_file_id,
    filename: receivedGroupAttachment.filename,
    sha256: receivedGroupAttachment.sha256,
    remoteFileKind: receivedGroupAttachment.remote_file_kind,
    groupId: receivedGroupAttachment.group_id,
  });
  assert.deepEqual(await readFile(downloadedGroupAttachment.path), groupAttachmentBytes);
  await bob.pollSocialNetwork({ autoProcess: false });
  const receivedDelegation = bob.agentDelegations({ direction: 'incoming' }).find((item) => item.id === publishedTask.id);
  assert.equal(receivedDelegation?.status, 'accepted');
  assert.equal(receivedDelegation?.metadata?.intakeStatus, 'completed');
  const aliceTaskMemory = await alice.delegationTaskMemory({ delegationId: publishedTask.id });
  assert.equal(aliceTaskMemory.coordinator?.scope, 'task');
  assert.equal(aliceTaskMemory.coordinator?.delegationId, publishedTask.id);
  assert.match(aliceTaskMemory.coordinator?.displayName || '', /\.md$/);
  const bobTaskMemory = await bob.delegationTaskMemory({ delegationId: receivedDelegation.id });
  assert.equal(bobTaskMemory.coordinator?.scope, 'task');
  assert.equal(bobTaskMemory.coordinator?.delegationId, receivedDelegation.id);
  assert.match(bobTaskMemory.coordinator?.content || '', /ubuddy_intake|Task Updates/);
  const delegationComment = await alice.socialSendMessage({
    recipientId: bobResult.id,
    senderAgentId: 'secretary_agent',
    recipientAgentId: 'secretary_agent',
    kind: 'agent',
    content: '补充要求：请附上测试结论。',
    metadata: { type: 'agent_delegation_comment', delegationId: receivedDelegation.id, processedByOwnUBuddy: true },
  });
  await alice.socialUpdateMessage({
    messageId: delegationComment.message.id,
    action: 'edit',
    content: '补充要求：请附上测试结论和依据。',
    metadata: { originalInput: '补充测试结论和依据' },
  });
  await bob.pollSocialNetwork({ autoProcess: false });
  const revisedDelegation = bob.agentDelegations({ direction: 'incoming' }).find((item) => item.id === receivedDelegation.id);
  assert.equal(Number(revisedDelegation?.metadata?.intakeRevision || 0), 2);
  assert.equal(String(revisedDelegation?.metadata?.intakeSummary || '').includes('测试结论和依据'), true);
  assert.equal(bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.content.includes('测试结论和依据') && item.metadata?.edited), true);
  await alice.socialUpdateMessage({ messageId: delegationComment.message.id, action: 'withdraw' });
  await bob.pollSocialNetwork({ autoProcess: false });
  const withdrawnDelegation = bob.agentDelegations({ direction: 'incoming' }).find((item) => item.id === receivedDelegation.id);
  assert.equal(Number(withdrawnDelegation?.metadata?.intakeRevision || 0), 3);
  assert.equal(String(withdrawnDelegation?.metadata?.intakeSummary || '').includes('测试结论和依据'), false);
  assert.equal(bob.socialConversation({ peerId: alice.currentUser().id }).some((item) => item.id === delegationComment.message.id && item.metadata?.withdrawn), true);

  const directDelegation = await alice.createAgentDelegation({
    recipientId: bobResult.id,
    title: 'Historical uBuddy feedback routing',
    instruction: 'Return a short result so the requester can verify feedback routing.',
    metadata: { sourceSecretarySessionId: secretaryDispatch.session.id },
  });
  assert.equal(directDelegation.delegation?.metadata?.sourceSecretarySessionId, secretaryDispatch.session.id);
  assert.equal(
    alice.agentDelegations({ direction: 'outgoing' }).find((item) => item.id === directDelegation.delegation.id)?.metadata?.sourceSecretarySessionId,
    secretaryDispatch.session.id,
    'requester-private uBuddy session metadata must survive cloud delegation creation',
  );
  await bob.pollSocialNetwork({ autoProcess: false });
  const receivedDirectDelegation = bob.agentDelegations({ direction: 'incoming' })
    .find((item) => item.id === directDelegation.delegation.id);
  assert.equal(receivedDirectDelegation?.status, 'accepted');
  const directDelegationNotice = bob.ensureExternalDelegationNotice({ delegation: receivedDirectDelegation });
  assert.ok(directDelegationNotice?.message?.id);
  await bob.respondAgentDelegation({ delegationId: receivedDirectDelegation.id, action: 'accept' });
  const directDelegationFileBytes = Buffer.from('DIRECT_DELEGATION_RUNTIME_DELIVERY_OK\n', 'utf8');
  const directDelegationLocalFile = bob.uploadFile({
    filename: 'direct-delegation-runtime-delivery.md',
    contentType: 'text/markdown',
    dataBase64: directDelegationFileBytes.toString('base64'),
  });
  const directDelegationSubmission = await bob.respondAgentDelegation({
    delegationId: receivedDirectDelegation.id,
    action: 'submit',
    message: 'Historical feedback routing completed.',
    attachments: [directDelegationLocalFile],
  });
  const submittedDirectAttachment = directDelegationSubmission?.delegation?.metadata?.attachments?.[0];
  assert.ok(submittedDirectAttachment?.remote_file_id);
  assert.equal(submittedDirectAttachment.remote_file_kind, 'collaboration_task');
  const submittedDirectNotice = bob.store.listMessages(directDelegationNotice.session.id)
    .find((message) => message.id === directDelegationNotice.message.id);
  assert.equal(
    submittedDirectNotice?.metadata?.externalDelegationSubmittedSnapshot?.attachments?.[0]?.remote_file_id,
    submittedDirectAttachment.remote_file_id,
  );
  const downloadedDirectDelegationFile = await alice.collaborationDownloadFile({
    fileId: submittedDirectAttachment.remote_file_id,
    filename: submittedDirectAttachment.filename,
    sha256: submittedDirectAttachment.sha256,
    remoteFileKind: submittedDirectAttachment.remote_file_kind,
  });
  assert.deepEqual(await readFile(downloadedDirectDelegationFile.path), directDelegationFileBytes);
  alice.db.prepare(`UPDATE sessions
    SET conversation_role='history',write_state='read_only',superseded_by_session_id='',updated_at=datetime('now')
    WHERE id=?`).run(secretaryDispatch.session.id);
  assert.equal(alice.store.getSession(secretaryDispatch.session.id)?.readOnly, true);

  const repairedDelegation = await waitForSecretaryFeedbackRepair(
    alice,
    directDelegation.delegation.id,
    secretaryDispatch.session.id,
  );
  const repairedSecretarySessionId = repairedDelegation?.metadata?.sourceSecretarySessionId || '';
  const repairedSecretarySession = alice.store.getSession(repairedSecretarySessionId);
  assert.ok(repairedSecretarySessionId);
  assert.notEqual(repairedSecretarySessionId, secretaryDispatch.session.id);
  assert.equal(repairedSecretarySession?.departmentId, 'secretary_department');
  assert.equal(repairedSecretarySession?.readOnly, false);
  assert.notEqual(repairedSecretarySession?.writeState, 'read_only');
  const feedbackMessages = () => alice.store.listMessages(repairedSecretarySessionId).filter((message) => (
    message.metadata?.delegationFeedbackId === directDelegation.delegation.id
    && message.metadata?.delegationStatus === 'submitted'
  ));
  assert.equal(feedbackMessages().length, 1, 'submitted feedback must move to the current writable uBuddy session');
  assert.equal(alice.store.listMessages(secretaryDispatch.session.id).some((message) => (
    message.metadata?.delegationFeedbackId === directDelegation.delegation.id
  )), false, 'historical uBuddy sessions must remain unchanged');
  await alice.pollSocialNetwork({ autoProcess: false });
  assert.equal(feedbackMessages().length, 1, 'repeated social polls must not duplicate repaired feedback');

  const aliceRemoteId = alice.currentUser().id;
  alice.db.prepare("UPDATE cloud_auth_state SET access_token = 'expired-access-token'").run();
  await pool.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [aliceRemoteId]);
  await assert.rejects(() => alice.collaborationOverview(), /登录状态已失效，请重新登录后再发布任务/);
  assert.equal(alice.currentUser(), null, 'expired cloud session should return the app to login state');

  console.log('secretary relay smoke passed');
} finally {
  alice?.close();
  bob?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
  if (rootA) await rm(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (rootB) await rm(rootB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  if (previousUBuddyProcessingMode === undefined) delete process.env.JANUS_UBUDDY_PROCESSING_MODE;
  else process.env.JANUS_UBUDDY_PROCESSING_MODE = previousUBuddyProcessingMode;
}

async function register(runtime, email, displayName, password) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = codes.get(`${email.toLowerCase()}:register`);
  assert.match(code, /^\d{6}$/);
  return runtime.authRegister({ email, displayName, password, code });
}

async function waitForSecretaryFeedbackRepair(runtime, delegationId, historicalSessionId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    await runtime.pollSocialNetwork({ autoProcess: false });
    latest = runtime.agentDelegations({ direction: 'outgoing' }).find((item) => item.id === delegationId) || latest;
    const sessionId = latest?.metadata?.sourceSecretarySessionId || '';
    const session = sessionId ? runtime.store.getSession(sessionId) : null;
    if (sessionId && sessionId !== historicalSessionId && session && !session.readOnly && session.writeState !== 'read_only') return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return latest;
}
