import { strict as assert } from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { createSocialRuntimeApi } from '../src/main/modules/collaboration/application/createSocialRuntimeApi.js';
import { SocialRelayService } from '../src/main/socialRelay.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-auth-friends-'));
let runtime;
let passed = false;

const log = (message) => {
  console.log(`[ok] ${message}`);
};

const expectThrow = (fn, pattern, label) => {
  assert.throws(fn, pattern, label);
  log(label);
};

const countRows = (sql, params = []) => Number(runtime.db.prepare(sql).get(...params)?.count || 0);

const login = (identifier, password = '') => runtime.authLogin({ identifier, password });

const registerUser = ({ email, password, displayName }) => {
  const session = runtime.authRegister({
    email,
    password,
    displayName,
  });
  assert.equal(session.user.email, email.toLowerCase());
  assert.equal(session.user.emailVerified, true);
  assert.equal(runtime.currentUser().id, session.user.id);
  return session.user;
};

try {
  runtime = await createRuntime({ root, isDev: true });
  assert.ok(existsSync(path.join(root, 'data', 'janus.db')));
  log(`created isolated runtime at ${root}`);

  const boot = await runtime.bootstrap();
  assert.equal(boot.currentUser.id, 'local_admin');
  assert.equal(boot.currentUser.role, 'admin');
  assert.equal(boot.currentUser.emailVerified, true);
  assert.ok(boot.adminUsers.some((user) => user.id === 'local_admin'));
  log('default local admin is available and bootstraps admin-only data');

  expectThrow(() => login('local_admin', ''), /不支持直接登录/, 'blank local_admin direct login is disabled');
  assert.equal(runtime.authUpdatePassword({ currentPassword: '', newPassword: 'local-admin-test1' }).ok, true);
  const adminById = login('local_admin', 'local-admin-test1');
  assert.equal(adminById.user.email, 'admin@janus.local');
  const adminByEmail = login('admin@janus.local', 'local-admin-test1');
  assert.equal(adminByEmail.user.id, 'local_admin');
  log('admin login requires an explicitly configured password');

  expectThrow(() => runtime.authLogin({ identifier: '', password: '' }), /请输入账号、手机号或邮箱/, 'login rejects empty identifier');
  expectThrow(() => login('missing@example.com', 'whatever'), /账号不存在/, 'login rejects unknown email');
  expectThrow(() => login('local_admin', 'bad-password'), /密码不正确/, 'login rejects wrong password');
  expectThrow(() => runtime.authSendEmailCode({ email: 'not-an-email', purpose: 'register' }), /有效邮箱/, 'email-code rejects invalid email');

  expectThrow(
    () => runtime.authRegister({
      email: 'short-password@test.local',
      password: 'short',
      displayName: 'Short Password',
    }),
    /至少需要 8 位/,
    'registration rejects short password',
  );

  const alice = registerUser({ email: 'alice@test.local', password: 'alice12345', displayName: 'Alice Test' });
  assert.equal(alice.role, 'member');
  assert.equal(alice.authProvider, 'local_mock');
  log('member registration does not require a verification code and logs in');

  expectThrow(
    () => runtime.authRegister({ email: 'ALICE@test.local', password: 'another-password1', displayName: 'Duplicate Alice' }),
    /已被注册/,
    'registration rejects duplicate email case-insensitively',
  );
  expectThrow(() => runtime.adminListUsers(), /管理员权限/, 'member cannot list users');
  assert.equal(typeof runtime.codexConfig().hasApiKey, 'boolean');
  assert.ok(runtime.codexConfigFiles().configToml.includes('model_provider'));

  expectThrow(
    () => runtime.authUpdatePassword({ currentPassword: 'wrong', newPassword: 'alice23456' }),
    /当前密码不正确/,
    'password change rejects wrong current password',
  );
  assert.equal(runtime.authUpdatePassword({ currentPassword: 'alice12345', newPassword: 'alice23456' }).ok, true);
  runtime.authLogout();
  expectThrow(() => login('alice@test.local', 'alice12345'), /密码不正确/, 'old password stops working after password change');
  login('alice@test.local', 'alice23456');
  log('password change updates login credentials');

  const changedProfile = runtime.authUpdateProfile({
    displayName: 'Alice Verified',
    email: 'alice.verified@test.local',
    username: 'alice_verified',
    avatarUrl: 'https://example.invalid/alice.png',
  });
  assert.equal(changedProfile.email, 'alice.verified@test.local');
  assert.equal(changedProfile.username, 'alice_verified');
  assert.equal(changedProfile.emailVerified, false);
  runtime.authLogout();
  expectThrow(() => login('alice.verified@test.local', 'alice23456'), /邮箱尚未验证/, 'login rejects unverified changed email');
  runtime.auth.setActiveUser(alice.id);
  expectThrow(
    () => runtime.authVerifyEmail({ email: 'other@test.local', code: '000000', purpose: 'email_verify' }),
    /只能验证当前账号邮箱/,
    'email verification rejects a different email',
  );
  const verifyCode = runtime.authSendEmailCode({ email: 'alice.verified@test.local', purpose: 'email_verify' });
  expectThrow(
    () => runtime.authVerifyEmail({ email: 'alice.verified@test.local', code: '000000', purpose: 'email_verify' }),
    /验证码不正确/,
    'email verification rejects wrong code',
  );
  const verifiedAlice = runtime.authVerifyEmail({
    email: 'alice.verified@test.local',
    code: verifyCode.devCode,
    purpose: 'email_verify',
  });
  assert.equal(verifiedAlice.emailVerified, true);
  runtime.authLogout();
  login('alice.verified@test.local', 'alice23456');
  log('profile email change requires and accepts email verification');

  expectThrow(() => runtime.authSendEmailCode({ email: 'nobody@test.local', purpose: 'password_reset' }), /账号不存在/, 'password reset code rejects unknown account');
  const resetCode = runtime.authSendEmailCode({ email: 'alice.verified@test.local', purpose: 'password_reset' });
  expectThrow(
    () => runtime.authResetPasswordByEmail({ email: 'alice.verified@test.local', code: '000000', newPassword: 'alice34567' }),
    /验证码不正确/,
    'password reset rejects wrong code',
  );
  expectThrow(
    () => runtime.authResetPasswordByEmail({ email: 'alice.verified@test.local', code: resetCode.devCode, newPassword: 'short' }),
    /至少需要 8 位/,
    'password reset rejects short new password',
  );
  assert.equal(runtime.authResetPasswordByEmail({ email: 'alice.verified@test.local', code: resetCode.devCode, newPassword: 'alice34567' }).ok, true);
  expectThrow(() => login('alice.verified@test.local', 'alice23456'), /密码不正确/, 'password reset invalidates previous password');
  login('alice.verified@test.local', 'alice34567');
  log('password reset by email updates credentials');

  login('local_admin', 'local-admin-test1');
  const bob = registerUser({ email: 'bob@test.local', password: 'bob12345', displayName: 'Bob Test' });
  const carol = registerUser({ email: 'carol@test.local', password: 'carol12345', displayName: 'Carol Test' });
  const dave = registerUser({ email: 'dave@test.local', password: 'dave12345', displayName: 'Dave Test' });
  log('additional member fixtures registered');

  login('bob@test.local', 'bob12345');
  expectThrow(
    () => runtime.authUpdateProfile({ displayName: 'Bob Duplicate Email', email: 'alice.verified@test.local', username: 'bob_duplicate_email' }),
    /邮箱已被其他账号使用/,
    'profile update rejects duplicate email',
  );
  expectThrow(
    () => runtime.authUpdateProfile({ displayName: 'Bob Duplicate Username', email: 'bob@test.local', username: 'alice_verified' }),
    /用户名已被其他账号使用/,
    'profile update rejects duplicate username',
  );

  login('alice.verified@test.local', 'alice34567');
  assert.deepEqual(runtime.friendSearch({ query: '' }), []);
  assert.ok(!runtime.friendSearch({ query: 'alice.verified@test.local' }).some((user) => user.id === alice.id));
  assert.ok(runtime.friendSearch({ query: 'bob@test.local' }).some((user) => user.id === bob.id));
  assert.ok(runtime.friendSearch({ query: bob.username }).some((user) => user.id === bob.id));
  assert.ok(runtime.friendSearch({ query: bob.id }).some((user) => user.id === bob.id));
  log('friend search matches email, username, and user ID while hiding self');

  expectThrow(() => runtime.friendSendRequest({ userId: alice.id }), /请选择有效用户/, 'friend request rejects self');
  expectThrow(() => runtime.friendSendRequest({ userId: 'missing_user' }), /用户不存在/, 'friend request rejects unknown user');
  const aliceToBob = runtime.friendSendRequest({ userId: bob.id, message: 'hello bob' });
  assert.equal(aliceToBob.ok, true);
  assert.equal(aliceToBob.overview.requests.outgoing.length, 1);
  assert.equal(runtime.friendSearch({ query: 'bob@test.local' })[0].friendshipStatus, 'outgoing_pending');
  expectThrow(() => runtime.friendSendRequest({ userId: bob.id }), /好友申请已发送/, 'duplicate friend request is rejected');
  log('outgoing friend request creates pending state');

  login('bob@test.local', 'bob12345');
  const bobIncoming = runtime.friendsOverview().requests.incoming;
  assert.equal(bobIncoming.length, 1);
  assert.equal(bobIncoming[0].requesterId, alice.id);
  const bobSearchAlice = runtime.friendSearch({ query: 'alice.verified@test.local' })[0];
  assert.equal(bobSearchAlice.friendshipStatus, 'incoming_pending');
  assert.equal(bobSearchAlice.requestId, bobIncoming[0].id);
  const acceptedBob = runtime.friendAcceptRequest({ requestId: bobIncoming[0].id });
  assert.equal(acceptedBob.overview.friends.length, 1);
  assert.equal(acceptedBob.overview.friends[0].friend.id, alice.id);
  expectThrow(() => runtime.friendSendRequest({ userId: alice.id }), /已经是好友/, 'friend request rejects existing friendship');
  log('incoming friend request can be accepted and becomes friendship');

  assert.equal(runtime.friendRemove({ userId: alice.id }).ok, true);
  assert.equal(runtime.friendsOverview().friends.length, 0);
  login('alice.verified@test.local', 'alice34567');
  assert.equal(runtime.friendsOverview().friends.length, 0);
  log('friend removal clears friendship for both sides');

  login('carol@test.local', 'carol12345');
  const carolToAlice = runtime.friendSendRequest({ userId: alice.id });
  assert.equal(carolToAlice.ok, true);
  login('alice.verified@test.local', 'alice34567');
  const incomingCarol = runtime.friendsOverview().requests.incoming.find((item) => item.requesterId === carol.id);
  assert.ok(incomingCarol);
  assert.equal(runtime.friendRejectRequest({ requestId: incomingCarol.id }).ok, true);
  assert.equal(runtime.friendsOverview().requests.incoming.length, 0);
  login('carol@test.local', 'carol12345');
  assert.equal(runtime.friendsOverview().requests.outgoing.length, 0);
  log('friend request can be rejected by recipient');

  const carolRetry = runtime.friendSendRequest({ userId: alice.id });
  assert.equal(carolRetry.ok, true);
  assert.equal(runtime.friendCancelRequest({ requestId: carolRetry.requestId }).ok, true);
  assert.equal(runtime.friendsOverview().requests.outgoing.length, 0);
  login('alice.verified@test.local', 'alice34567');
  assert.equal(runtime.friendsOverview().requests.incoming.length, 0);
  log('friend request can be cancelled by requester');

  const aliceToCarol = runtime.friendSendRequest({ userId: carol.id });
  assert.equal(aliceToCarol.ok, true);
  login('carol@test.local', 'carol12345');
  const reverseAutoAccept = runtime.friendSendRequest({ userId: alice.id });
  assert.equal(reverseAutoAccept.ok, true);
  assert.ok(reverseAutoAccept.overview.friends.some((item) => item.friend.id === alice.id));
  log('reverse pending request auto-accepts into friendship');

  login('bob@test.local', 'bob12345');
  const bobToAlice = runtime.friendSendRequest({ userId: alice.id, message: 'please add me again' });
  assert.equal(bobToAlice.ok, true);
  login('alice.verified@test.local', 'alice34567');
  assert.ok(runtime.friendsOverview().requests.incoming.some((item) => item.requesterId === bob.id));
  assert.equal(runtime.friendBlock({ userId: bob.id }).ok, true);
  assert.equal(runtime.friendsOverview().requests.incoming.length, 0);
  assert.equal(runtime.friendSearch({ query: 'bob@test.local' }).length, 0);
  login('bob@test.local', 'bob12345');
  assert.equal(runtime.friendSearch({ query: 'alice.verified@test.local' }).length, 0);
  expectThrow(() => runtime.friendSendRequest({ userId: alice.id }), /无法向该用户发送好友申请/, 'blocked user cannot send friend request');
  assert.equal(countRows('SELECT COUNT(*) AS count FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [alice.id, bob.id]), 1);
  log('blocking removes requests, hides search results, and prevents new requests');

  login('carol@test.local', 'carol12345');
  const createdOrganization = runtime.organizationCreate({
    name: 'Auth Smoke Organization',
    organizationNumber: 'AUTH-SMOKE-2026',
    verificationCode: 'organization-code',
  });
  assert.equal(createdOrganization.organization.role, 'owner');
  assert.equal(createdOrganization.organization.memberCount, 1);
  const renamedOrganization = runtime.organizationAction({
    action: 'rename', organizationId: createdOrganization.organization.id, name: 'Renamed Auth Smoke Organization',
  });
  assert.equal(renamedOrganization.overview.organizations.find((item) => item.id === createdOrganization.organization.id).name, 'Renamed Auth Smoke Organization');
  const defaultNumberOrganization = runtime.organizationCreate({
    name: 'Default Number Organization',
    verificationCode: 'default-code',
  });
  const nextDefaultNumberOrganization = runtime.organizationCreate({
    name: 'Next Default Number Organization',
    verificationCode: 'default-code-two',
  });
  assert.equal(runtime.organizationAction({
    action: 'validate_invitation_code',
    organizationId: createdOrganization.organization.id,
    verificationCode: 'organization-code',
  }).invitationCodeValid, true);
  expectThrow(
    () => runtime.organizationAction({
      action: 'validate_invitation_code',
      organizationId: createdOrganization.organization.id,
      verificationCode: 'wrong-code',
    }),
    /邀请码不正确/,
    'organization share-link generation validates the current invitation code',
  );
  assert.equal(defaultNumberOrganization.organization.organizationNumber, 'ORG-0001');
  assert.equal(nextDefaultNumberOrganization.organization.organizationNumber, 'ORG-0002');
  expectThrow(
    () => runtime.organizationCreate({ name: 'Duplicate Organization', organizationNumber: 'auth-smoke-2026', verificationCode: 'another-code' }),
    /组织号已被使用/,
    'organization number is unique case-insensitively',
  );
  login('alice.verified@test.local', 'alice34567');
  expectThrow(
    () => runtime.organizationJoin({ organizationNumber: 'AUTH-SMOKE-2026', verificationCode: 'wrong-code' }),
    /邀请码不正确/,
    'organization join rejects an invalid invitation code',
  );
  const joinedOrganization = runtime.organizationJoin({ organizationNumber: 'auth-smoke-2026', verificationCode: 'organization-code' });
  assert.equal(joinedOrganization.organization.memberCount, 2);
  assert.ok(joinedOrganization.organization.members.some((item) => item.user.id === carol.id && item.role === 'owner'));
  assert.ok(joinedOrganization.organization.members.some((item) => item.user.id === alice.id && item.role === 'member'));
  expectThrow(
    () => runtime.organizationAction({ action: 'rename', organizationId: createdOrganization.organization.id, name: 'Member Rename Rejected' }),
    /只有组织创建者可以修改组织名称/,
    'organization members cannot rename the organization',
  );
  assert.ok(joinedOrganization.overview.friends.some((item) => item.friend.id === carol.id));
  const organizationRemark = runtime.friendUpdateRemark({ userId: carol.id, remark: '组织里的 Carol' });
  assert.equal(organizationRemark.remark, '组织里的 Carol');
  const organizationMessage = runtime.socialSendMessage({ recipientId: carol.id, content: '组织联系人消息测试' });
  assert.equal(organizationMessage.message.recipientUserId, carol.id);
  login('carol@test.local', 'carol12345');
  assert.ok(runtime.friendsOverview().friends.some((item) => item.friend.id === alice.id));
  log('organization creation and invitation-code joining expose the member directory');

  expectThrow(
    () => runtime.organizationAction({ action: 'promote_admin', organizationId: createdOrganization.organization.id, targetUserId: alice.id, verificationCode: 'organization-code', accountPassword: 'wrong-password' }),
    /账号密码不正确/,
    'organization sensitive actions reject the wrong account password',
  );
  const promotedOrganizationAdmin = runtime.organizationAction({ action: 'promote_admin', organizationId: createdOrganization.organization.id, targetUserId: alice.id, verificationCode: 'organization-code', accountPassword: 'carol12345' });
  assert.equal(promotedOrganizationAdmin.overview.organizations.find((item) => item.id === createdOrganization.organization.id).members.find((item) => item.user.id === alice.id).role, 'admin');
  login('alice.verified@test.local', 'alice34567');
  expectThrow(
    () => runtime.organizationAction({ action: 'remove_member', organizationId: createdOrganization.organization.id, targetUserId: carol.id, verificationCode: 'organization-code', accountPassword: 'alice34567' }),
    /不能移除同级管理员或组织创建者/,
    'organization admins cannot remove the owner',
  );
  const selfMessage = runtime.socialSendMessage({ recipientId: alice.id, content: '我的文件传输记录', metadata: { type: 'direct_message' } });
  assert.equal(selfMessage.message.senderUserId, alice.id);
  assert.equal(selfMessage.message.recipientUserId, alice.id);
  assert.equal(selfMessage.message.status, 'read');
  assert.equal(runtime.socialConversation({ peerId: alice.id }).filter((item) => item.content === '我的文件传输记录').length, 1);
  log('self messaging stores one read message without generating a mirrored reply');

  runtime.auth.bindRemoteIdentity({ localUserId: alice.id, remoteId: 'cloud-self-alice' });
  const connectedSelfMessages = [];
  let connectedRelaySendCount = 0;
  const connectedRelayMessages = [];
  const connectedSocialApi = createSocialRuntimeApi({
    auth: {
      requireUser: () => runtime.currentUser(),
      friendsOverview: () => runtime.friendsOverview(),
      socialSendMessage(payload) {
        connectedSelfMessages.push(payload);
        return { ok: true, message: { senderUserId: alice.id, recipientUserId: payload.recipientId }, inbox: [] };
      },
      socialInbox: () => [],
      socialConversation: () => [],
    },
    socialRelay: {
      connected: () => true,
      status: () => ({ remoteUserId: 'cloud-self-alice' }),
      localUserId: (userId) => userId === 'cloud-self-alice' ? alice.id : userId,
      async sendMessage(payload) {
        connectedRelaySendCount += 1;
        connectedRelayMessages.push(payload);
        return { ok: true, message: { senderUserId: 'cloud-self-alice', recipientUserId: payload.recipientId } };
      },
    },
    store: {
      activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
      contextDeviceId: () => 'auth-friends-smoke-device',
    },
    runtimeRoot: root,
  });
  const connectedSelfMessage = await connectedSocialApi.socialSendMessage({
    recipientId: 'cloud-self-alice',
    content: '联网状态下仍应走本地自聊',
    senderAgentId: 'must_be_removed',
    metadata: { type: 'agent_delegation', attachments: [{ id: 'local-attachment', name: 'local.txt' }] },
  });
  assert.equal(connectedSelfMessage.message.recipientUserId, alice.id);
  assert.equal(connectedRelaySendCount, 0);
  assert.equal(connectedSelfMessages.length, 1);
  assert.equal(connectedSelfMessages[0].recipientId, alice.id);
  assert.equal(connectedSelfMessages[0].kind, 'friend');
  assert.equal(connectedSelfMessages[0].senderAgentId, '');
  assert.equal(connectedSelfMessages[0].metadata.type, 'direct_message');
  assert.equal(connectedSelfMessages[0].metadata.attachments[0].id, 'local-attachment');
  const connectedLocalIdSelfMessage = await connectedSocialApi.socialSendMessage({
    recipientId: alice.id,
    content: '界面使用本地账号 ID 的联网自聊',
    metadata: { type: 'direct_message' },
  });
  assert.equal(connectedLocalIdSelfMessage.message.recipientUserId, alice.id);
  assert.equal(connectedRelaySendCount, 0);
  assert.equal(connectedSelfMessages.length, 2);
  assert.equal(connectedSelfMessages[1].recipientId, alice.id);
  const connectedFriendMessage = await connectedSocialApi.socialSendMessage({
    recipientId: 'cloud-friend-bob',
    content: '普通好友仍走云端发送',
    metadata: { type: 'direct_message' },
  });
  assert.equal(connectedFriendMessage.message.recipientUserId, 'cloud-friend-bob');
  assert.equal(connectedRelaySendCount, 1);
  assert.equal(connectedRelayMessages[0].recipientId, 'cloud-friend-bob');
  log('connected self messaging bypasses cloud friendship checks and remote attachment uploads');

  const cachedFriendOverview = { friends: [{ friend: { id: 'cached-friend' } }], requests: { incoming: [], outgoing: [] } };
  let localFriendOverviewReads = 0;
  const transientFailureSocialApi = createSocialRuntimeApi({
    auth: {
      requireUser: () => runtime.currentUser(),
      friendsOverview: ({ workspaceId }) => {
        assert.equal(workspaceId, 'workspace_personal');
        localFriendOverviewReads += 1;
        return cachedFriendOverview;
      },
    },
    store: {
      activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
      contextDeviceId: () => 'auth-friends-smoke-device',
    },
    socialRelay: {
      connected: () => true,
      async friendsOverview() {
        throw new TypeError('fetch failed');
      },
    },
  });
  assert.equal(await transientFailureSocialApi.friendsOverview(), cachedFriendOverview);
  assert.equal(localFriendOverviewReads, 1);
  log('transient cloud friend refresh failures fall back to the workspace-local overview');

  const businessFailureSocialApi = createSocialRuntimeApi({
    auth: {
      requireUser: () => runtime.currentUser(),
      friendsOverview: () => cachedFriendOverview,
    },
    store: {
      activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
      contextDeviceId: () => 'auth-friends-smoke-device',
    },
    socialRelay: {
      connected: () => true,
      async friendsOverview() {
        throw new Error('好友数据权限校验失败');
      },
    },
  });
  await assert.rejects(() => businessFailureSocialApi.friendsOverview(), /好友数据权限校验失败/);
  log('non-network friend refresh failures remain visible instead of being hidden by the fallback');

  let legacyValidationWorkspaceRefreshes = 0;
  const legacyInvitationValidationApi = createSocialRuntimeApi({
    auth: { requireUser: () => runtime.currentUser() },
    store: {
      activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
      contextDeviceId: () => 'auth-friends-smoke-device',
      ensureAccountWorkspaces: () => { legacyValidationWorkspaceRefreshes += 1; },
    },
    socialRelay: {
      connected: () => true,
      async organizationAction() {
        throw Object.assign(new Error('接口不存在。'), { code: 'not_found', status: 404 });
      },
    },
  });
  const deferredInvitationValidation = await legacyInvitationValidationApi.organizationAction({
    action: 'validate_invitation_code',
    organizationId: 'legacy-cloud-organization',
    verificationCode: 'legacy-cloud-code',
  });
  assert.equal(deferredInvitationValidation.invitationCodeValidation, 'deferred');
  assert.equal(deferredInvitationValidation.validationUnavailable, true);
  assert.equal(legacyValidationWorkspaceRefreshes, 1);
  log('legacy cloud servers without invitation validation no longer block local share-link generation');

  const invalidInvitationValidationApi = createSocialRuntimeApi({
    auth: { requireUser: () => runtime.currentUser() },
    store: {
      activeAccountWorkspace: () => ({ id: 'workspace_personal', kind: 'personal' }),
      contextDeviceId: () => 'auth-friends-smoke-device',
      ensureAccountWorkspaces: () => {},
    },
    socialRelay: {
      connected: () => true,
      async organizationAction() {
        throw Object.assign(new Error('组织邀请码不正确。'), { code: 'organization_verification_code_invalid', status: 403 });
      },
    },
  });
  await assert.rejects(() => invalidInvitationValidationApi.organizationAction({
    action: 'validate_invitation_code',
    organizationId: 'legacy-cloud-organization',
    verificationCode: 'wrong-code',
  }), /组织邀请码不正确/);
  log('an explicit invalid invitation code still blocks share-link generation');

  const relay = new SocialRelayService({
    db: runtime.db,
    auth: runtime.auth,
    client: {
      async sendMessage(_state, payload) {
        assert.equal(payload.recipientId, 'cloud-self-alice');
        return {
          ok: true,
          message: {
            id: 'cloud-self-message',
            senderUserId: 'cloud-self-alice',
            recipientUserId: 'cloud-self-alice',
            kind: 'friend', content: '云端身份映射后的自聊消息', status: 'read',
          },
        };
      },
    },
  });
  await relay.sendMessage({ recipientId: alice.id, content: '云端身份映射后的自聊消息', metadata: { type: 'direct_message' } });
  const importedSelfMessage = runtime.socialConversation({ peerId: alice.id }).find((item) => item.id === 'cloud-self-message');
  assert.equal(importedSelfMessage?.senderUserId, alice.id);
  assert.equal(importedSelfMessage?.recipientUserId, alice.id);
  log('cloud self messaging maps local and remote account IDs without requiring a friendship');

  login('dave@test.local', 'dave12345');
  runtime.organizationJoin({ organizationNumber: 'AUTH-SMOKE-2026', verificationCode: 'organization-code' });
  const exitRequest = runtime.organizationAction({ action: 'request_exit', organizationId: createdOrganization.organization.id });
  assert.equal(exitRequest.status, 'pending');
  login('alice.verified@test.local', 'alice34567');
  const pendingExit = runtime.friendsOverview().organizationExitRequests.find((item) => item.id === exitRequest.requestId);
  assert.equal(pendingExit.canResolve, true);
  runtime.organizationAction({ action: 'resolve_exit', organizationId: createdOrganization.organization.id, requestId: exitRequest.requestId, decision: 'approve', verificationCode: 'organization-code', accountPassword: 'alice34567' });
  login('dave@test.local', 'dave12345');
  assert.ok(!runtime.friendsOverview().organizations.some((item) => item.id === createdOrganization.organization.id));
  assert.ok(runtime.friendsOverview().organizationNotices.some((item) => item.type === 'exit_approved'));
  log('member exit requests reach admins and are completed by the first authorized reviewer');

  login('carol@test.local', 'carol12345');
  runtime.organizationAction({ action: 'revoke_admin', organizationId: createdOrganization.organization.id, targetUserId: alice.id, verificationCode: 'organization-code', accountPassword: 'carol12345' });
  expectThrow(
    () => runtime.organizationAction({
      action: 'transfer_owner', organizationId: createdOrganization.organization.id, targetUserId: alice.id,
      retainAdmin: 'false', verificationCode: 'organization-code', accountPassword: 'carol12345',
    }),
    /管理员保留选项无效/,
    'organization owner transfer rejects a non-boolean retain-admin option',
  );
  const retainedAdminTransfer = runtime.organizationAction({ action: 'transfer_owner', organizationId: createdOrganization.organization.id, targetUserId: alice.id, verificationCode: 'organization-code', accountPassword: 'carol12345' });
  assert.equal(retainedAdminTransfer.retainedAdmin, true);
  assert.equal(retainedAdminTransfer.previousOwnerRole, 'admin');
  assert.equal(retainedAdminTransfer.overview.organizations.find((item) => item.id === createdOrganization.organization.id).members.find((item) => item.user.id === carol.id).role, 'admin');
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_workspace_memberships
    WHERE workspace_id=? AND user_id=?`).get(`workspace_org_${createdOrganization.organization.id}`, carol.id) }, { role: 'admin', status: 'active' });
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_memberships
    WHERE account_id=? AND user_id=?`).get(`account_org_${createdOrganization.organization.id}`, carol.id) }, { role: 'admin', status: 'active' });
  login('alice.verified@test.local', 'alice34567');
  assert.equal(runtime.friendsOverview().organizations.find((item) => item.id === createdOrganization.organization.id).role, 'owner');
  assert.ok(runtime.friendsOverview().organizationNotices.some((item) => item.type === 'owner_transferred'));
  const memberTransfer = runtime.organizationAction({ action: 'transfer_owner', organizationId: createdOrganization.organization.id, targetUserId: carol.id, retainAdmin: false, verificationCode: 'organization-code', accountPassword: 'alice34567' });
  assert.equal(memberTransfer.retainedAdmin, false);
  assert.equal(memberTransfer.previousOwnerRole, 'member');
  const transferredOrganization = memberTransfer.overview.organizations.find((item) => item.id === createdOrganization.organization.id);
  assert.equal(transferredOrganization.role, 'member');
  assert.equal(transferredOrganization.ownerUserId, carol.id);
  assert.equal(transferredOrganization.members.filter((item) => item.role === 'owner').length, 1);
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_workspace_memberships
    WHERE workspace_id=? AND user_id=?`).get(`workspace_org_${createdOrganization.organization.id}`, alice.id) }, { role: 'member', status: 'active' });
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_memberships
    WHERE account_id=? AND user_id=?`).get(`account_org_${createdOrganization.organization.id}`, alice.id) }, { role: 'member', status: 'active' });
  expectThrow(
    () => runtime.organizationAction({ action: 'update_invitation_code', organizationId: createdOrganization.organization.id, verificationCode: 'organization-code', newInvitationCode: 'organization-code-v2', accountPassword: 'alice34567' }),
    /只有组织创建者可以修改邀请码/,
    'organization members cannot update the invitation code',
  );
  const nonOwnerResetCode = runtime.authSendEmailCode({
    email: 'alice.verified@test.local', purpose: 'organization_invitation_reset', method: 'email',
  });
  expectThrow(
    () => runtime.organizationAction({
      action: 'reset_invitation_code', organizationId: createdOrganization.organization.id,
      emailCode: nonOwnerResetCode.devCode, newInvitationCode: 'member-cannot-reset',
    }),
    /只有组织创建者可以修改邀请码/,
    'organization members cannot reset the invitation code by verifying their own email',
  );
  login('carol@test.local', 'carol12345');
  const invitationCodeUpdate = runtime.organizationAction({
    action: 'update_invitation_code', organizationId: createdOrganization.organization.id,
    verificationCode: 'organization-code', newInvitationCode: 'organization-code-v2', accountPassword: 'carol12345',
  });
  assert.equal(invitationCodeUpdate.invitationCodeUpdated, true);
  const invitationResetCode = runtime.authSendEmailCode({
    email: 'carol@test.local', purpose: 'organization_invitation_reset', method: 'email',
  });
  const invitationCodeReset = runtime.organizationAction({
    action: 'reset_invitation_code', organizationId: createdOrganization.organization.id,
    emailCode: invitationResetCode.devCode, newInvitationCode: 'organization-code-v3',
  });
  assert.equal(invitationCodeReset.invitationCodeUpdated, true);
  assert.equal(invitationCodeReset.invitationCodeReset, true);
  expectThrow(
    () => runtime.organizationAction({
      action: 'reset_invitation_code', organizationId: createdOrganization.organization.id,
      emailCode: invitationResetCode.devCode, newInvitationCode: 'organization-code-v4',
    }),
    /请先获取验证码/,
    'organization invitation reset email codes are single-use',
  );
  login('dave@test.local', 'dave12345');
  expectThrow(
    () => runtime.organizationJoin({ organizationNumber: 'AUTH-SMOKE-2026', verificationCode: 'organization-code' }),
    /邀请码不正确/,
    'old invitation code stops working immediately',
  );
  expectThrow(
    () => runtime.organizationJoin({ organizationNumber: 'AUTH-SMOKE-2026', verificationCode: 'organization-code-v2' }),
    /邀请码不正确/,
    'email reset invalidates the previously updated invitation code',
  );
  assert.equal(runtime.organizationJoin({ organizationNumber: 'AUTH-SMOKE-2026', verificationCode: 'organization-code-v3' }).organization.id, createdOrganization.organization.id);
  login('carol@test.local', 'carol12345');
  const dissolved = runtime.organizationAction({ action: 'owner_exit', organizationId: defaultNumberOrganization.organization.id, mode: 'dissolve', verificationCode: 'default-code', accountPassword: 'carol12345' });
  assert.equal(dissolved.dissolved, true);
  assert.ok(!runtime.friendsOverview().organizations.some((item) => item.id === defaultNumberOrganization.organization.id));
  const ownerExit = await runtime.organizationAction({
    action: 'owner_exit', organizationId: createdOrganization.organization.id, mode: 'auto', retainAdmin: true,
    verificationCode: 'organization-code-v3', accountPassword: 'carol12345',
  });
  assert.equal(ownerExit.exited, true);
  assert.equal(ownerExit.retainedAdmin, false);
  assert.ok(!runtime.friendsOverview().organizations.some((item) => item.id === createdOrganization.organization.id));
  assert.equal(runtime.db.prepare(`SELECT COUNT(*) AS count FROM contact_organization_members
    WHERE organization_id=? AND user_id=?`).get(createdOrganization.organization.id, carol.id).count, 0);
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_workspace_memberships
    WHERE workspace_id=? AND user_id=?`).get(`workspace_org_${createdOrganization.organization.id}`, carol.id) }, { role: 'member', status: 'left' });
  assert.deepEqual({ ...runtime.db.prepare(`SELECT role,status FROM account_memberships
    WHERE account_id=? AND user_id=?`).get(`account_org_${createdOrganization.organization.id}`, carol.id) }, { role: 'member', status: 'left' });
  log('owner transfer choices, role projections, exit isolation, and owner-only dissolution are persisted');

  login('local_admin', 'local-admin-test1');
  const users = runtime.adminListUsers();
  assert.ok(users.some((user) => user.id === alice.id));
  expectThrow(() => runtime.adminUpdateUserRole({ userId: 'local_admin', role: 'member' }), /最后一名管理员/, 'cannot demote the last admin');
  const promotedAlice = runtime.adminUpdateUserRole({ userId: alice.id, role: 'admin' });
  assert.equal(promotedAlice.role, 'admin');
  const demotedAlice = runtime.adminUpdateUserRole({ userId: alice.id, role: 'member' });
  assert.equal(demotedAlice.role, 'member');
  const resetAlice = runtime.adminResetUserPassword({ userId: alice.id });
  assert.equal(resetAlice.password, 'opl12345');
  expectThrow(() => runtime.adminResetUserPassword({ userId: 'local_admin' }), /当前登录账号/, 'admin cannot reset current login password through admin action');
  expectThrow(() => runtime.adminDeleteUser({ userId: 'local_admin' }), /当前登录账号/, 'admin cannot delete current login account');
  assert.equal(runtime.adminDeleteUser({ userId: dave.id }).deleted_user_id, dave.id);
  expectThrow(() => login('dave@test.local', 'dave12345'), /账号不存在/, 'deleted user cannot log in');
  log('admin role, reset, and delete guards work');

  const remainingUserCount = countRows('SELECT COUNT(*) AS count FROM auth_users');
  assert.equal(remainingUserCount, 4);
  assert.equal(countRows("SELECT COUNT(*) AS count FROM friend_requests WHERE status = 'pending'"), 0);
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(runtime.db.prepare('PRAGMA foreign_key_check').all(), []);
  log('database ends with expected users, no pending friend requests, and valid integrity/foreign keys');

  passed = true;
  console.log('\nAuth/friends full smoke passed.');
} finally {
  if (runtime) runtime.close();
  if (passed && !process.env.JANUS_AUTH_SMOKE_KEEP) {
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`Auth/friends smoke workspace kept at: ${root}`);
  }
}
