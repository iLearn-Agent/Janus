import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { DataType, newDb } from 'pg-mem';

import { readConfig } from '../src/config.mjs';
import { migrate } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';

const config = {
  jwtSecret: 'test-jwt-secret-that-is-long-enough-for-hmac',
  emailCodeSecret: 'test-email-code-secret-that-is-long-enough',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  emailCodeTtlMinutes: 10,
};

test('Provider Key distribution model is optional', () => {
  assert.equal(readConfig({}, { requireJwt: false }).providerKeyDistributionModel, '');
  assert.equal(readConfig({ JANUS_PROVIDER_KEY_DISTRIBUTION_MODEL: 'gpt-explicit' }, { requireJwt: false }).providerKeyDistributionModel, 'gpt-explicit');
});

test('cloud auth and friends API contract', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => ctx.close());

  let alice;
  let bob;
  let carol;

  await t.test('邮箱验证码注册成功', async () => {
    const health = await ctx.api('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    const codeResponse = await ctx.api('/api/auth/email-code', {
      method: 'POST',
      body: { email: 'Alice@Example.com', purpose: 'register' },
    });
    assert.equal(codeResponse.status, 200);
    assert.equal(Object.hasOwn(codeResponse.body, 'code'), false);
    assert.equal(Object.hasOwn(codeResponse.body, 'devCode'), false);
    const response = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: {
        email: 'Alice@Example.com',
        code: ctx.lastCode('alice@example.com', 'register').code,
        password: 'strong-password',
        displayName: 'Alice',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.provider, 'cloud');
    assert.ok(response.body.accessToken);
    assert.ok(response.body.refreshToken);
    assert.equal(response.body.user.emailVerified, true);
    assert.equal(response.body.user.email_verified, true);
    assert.equal(response.body.user.displayName, 'Alice');
    assert.equal(response.body.user.display_name, 'Alice');
    alice = response.body;

    const stored = await ctx.one('SELECT password_hash FROM users WHERE id = $1', [alice.user.id]);
    assert.ok(stored.password_hash.startsWith('pbkdf2$'));
    assert.equal(stored.password_hash.includes('strong-password'), false);
    const token = await ctx.one('SELECT token_hash FROM refresh_tokens WHERE user_id = $1', [alice.user.id]);
    assert.notEqual(token.token_hash, alice.refreshToken);
  });

  await t.test('邮箱格式和不可达收件人返回不同错误', async () => {
    const invalid = await ctx.api('/api/auth/email-code', {
      method: 'POST', body: { email: 'not-an-email', purpose: 'register' },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, 'invalid_email');

    const unreachable = await ctx.api('/api/auth/email-code', {
      method: 'POST', body: { email: 'missing-mailbox@example.com', purpose: 'register' },
    });
    assert.equal(unreachable.status, 422);
    assert.equal(unreachable.body.error.code, 'email_address_unreachable');
    assert.match(unreachable.body.error.message, /不存在|无法接收/);
  });

  await t.test('重复点击只签发并发送一个当前验证码', async () => {
    const email = 'burst-register@example.com';
    const sentBefore = ctx.sentCodes.length;
    const responses = await Promise.all(Array.from({ length: 5 }, () => ctx.api('/api/auth/email-code', {
      method: 'POST',
      body: { email, purpose: 'register' },
    })));
    assert.equal(responses.every((item) => item.status === 200), true);
    assert.equal(ctx.sentCodes.length - sentBefore, 1);
    assert.equal(responses.filter((item) => item.body.reused === false).length, 1);
    assert.equal(responses.filter((item) => item.body.reused === true).length, 4);
    const active = await ctx.pool.query(
      'SELECT id FROM email_verifications WHERE email = $1 AND purpose = $2 AND consumed = false',
      [email, 'register'],
    );
    assert.equal(active.rowCount, 1);
    const repeated = await ctx.api('/api/auth/email-code', {
      method: 'POST',
      body: { email, purpose: 'register' },
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.reused, true);
    assert.equal(ctx.sentCodes.length - sentBefore, 1);
    const registration = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { email, code: ctx.lastCode(email, 'register').code, password: 'burst-password', displayName: 'Burst User' },
    });
    assert.equal(registration.status, 200);
  });

  await t.test('已验证账号可以提交 Provider Key 机构申请且短时间内去重', async () => {
    const first = await ctx.api('/api/provider-key-applications', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { organization: 'Alice Research Lab', usage: '本地代码 Agent 内测。' },
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.application.accountEmail, 'alice@example.com');
    assert.equal(first.body.application.status, 'pending');
    assert.equal(first.body.reused, false);
    assert.equal(ctx.providerKeyApplications.length, 1);
    assert.equal(ctx.providerKeyApplications[0].recipient, 'provider-access@example.com');
    assert.equal(ctx.providerKeyApplications[0].user.id, alice.user.id);

    const repeated = await ctx.api('/api/provider-key-applications', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { organization: 'Alice Research Lab', usage: '重复点击不应重复投递。' },
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.reused, true);
    assert.equal(ctx.providerKeyApplications.length, 1);

    const applicationId = first.body.application.id;
    await ctx.pool.query("UPDATE users SET role='admin' WHERE id=$1", [alice.user.id]);
    const review = await ctx.api('/api/provider-key-applications', { headers: authHeaders(alice.accessToken) });
    assert.equal(review.status, 200);
    assert.equal(review.body.distributionReady, true);
    assert.equal(review.body.review.some((item) => item.id === applicationId && item.status === 'pending'), true);
    assert.equal(JSON.stringify(review.body).includes('shared-provider-key-fixture'), false);

    const approved = await ctx.api(`/api/provider-key-applications/${applicationId}/decision`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'approve', note: '机构信息已核验。' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.application.status, 'approved');
    assert.equal(ctx.providerKeyDecisions.length, 1);

    const claimed = await ctx.api(`/api/provider-key-applications/${applicationId}/claim`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.credential.baseUrl, 'https://provider.fixture.example/v1');
    assert.equal(claimed.body.credential.apiKey, 'shared-provider-key-fixture');
    const confirmed = await ctx.api(`/api/provider-key-applications/${applicationId}/claim-confirm`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.application.status, 'claimed');
    const claimAgain = await ctx.api(`/api/provider-key-applications/${applicationId}/claim`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
    });
    assert.equal(claimAgain.status, 409);
    await ctx.pool.query("UPDATE users SET role='member' WHERE id=$1", [alice.user.id]);
  });

  await t.test('重复邮箱失败', async () => {
    const response = await ctx.api('/api/auth/register', {
      method: 'POST',
      body: { email: 'ALICE@example.com', password: 'another-password', displayName: 'Duplicate Alice' },
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'email_already_registered');
    assert.equal(typeof response.body.error.message, 'string');
    assert.deepEqual(response.body.error.details, {});
  });

  await t.test('登录成功/失败和 session refresh/logout', async () => {
    const failed = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'alice@example.com', password: 'wrong-password' },
    });
    assert.equal(failed.status, 401);
    assert.equal(failed.body.error.code, 'unauthorized');

    const login = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'alice@example.com', password: 'strong-password' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, alice.user.id);

    const me = await ctx.api('/api/auth/me', {
      headers: authHeaders(login.body.accessToken),
    });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'alice@example.com');

    const originalUsername = login.body.user.username;
    const emptyUsernameUpdate = await ctx.api('/api/auth/profile', {
      method: 'PATCH',
      headers: authHeaders(login.body.accessToken),
      body: { username: '   ' },
    });
    assert.equal(emptyUsernameUpdate.status, 200);
    assert.equal(emptyUsernameUpdate.body.user.username, originalUsername,
      'blank profile synchronization must preserve the established username');
    const storedAfterEmptyUsername = await ctx.one('SELECT username FROM users WHERE id = $1', [alice.user.id]);
    assert.equal(storedAfterEmptyUsername.username, originalUsername);

    const preservedUsernameLogin = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: originalUsername, password: 'strong-password' },
    });
    assert.equal(preservedUsernameLogin.status, 200);
    assert.equal(preservedUsernameLogin.body.user.id, alice.user.id);

    const refresh = await ctx.api('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(refresh.status, 200);
    assert.notEqual(refresh.body.refreshToken, login.body.refreshToken);

    const reused = await ctx.api('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: login.body.refreshToken },
    });
    assert.equal(reused.status, 401);

    const logout = await ctx.api('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken: refresh.body.refreshToken },
    });
    assert.equal(logout.status, 200);
    assert.equal(logout.body.ok, true);
  });

  await t.test('注册邮箱不支持通过资料接口绕过验证修改', async () => {
    const updated = await ctx.api('/api/auth/profile', {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { email: 'alice2@example.com', displayName: 'Alice Zhang', username: 'alice_zhang' },
    });
    assert.equal(updated.status, 400);
    assert.equal(updated.body.error.code, 'email_change_not_supported');
  });

  await t.test('邮箱重置密码', async () => {
    const missing = await ctx.api('/api/auth/email-code', {
      method: 'POST',
      body: { email: 'missing@example.com', purpose: 'password_reset' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'email_not_found');

    await ctx.api('/api/auth/email-code', {
      method: 'POST',
      body: { email: 'alice@example.com', purpose: 'password_reset' },
    });
    const reset = await ctx.api('/api/auth/password-reset', {
      method: 'POST',
      body: {
        email: 'alice@example.com',
        code: ctx.lastCode('alice@example.com', 'password_reset').code,
        newPassword: 'new-strong-password',
      },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ok, true);
    assert.equal(reset.body.userId, alice.user.id);

    const oldPassword = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'alice@example.com', password: 'strong-password' },
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'alice@example.com', password: 'new-strong-password' },
    });
    assert.equal(newPassword.status, 200);
    alice = newPassword.body;
  });

  await t.test('登录后修改密码需要邮箱验证码', async () => {
    const sent = await ctx.api('/api/auth/email-code', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { email: 'alice@example.com', purpose: 'password_change' },
    });
    assert.equal(sent.status, 200);
    const changed = await ctx.api('/api/auth/password', {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: {
        currentPassword: 'new-strong-password',
        newPassword: 'changed-strong-password',
        code: ctx.lastCode('alice@example.com', 'password_change').code,
      },
    });
    assert.equal(changed.status, 200);
    const login = await ctx.api('/api/auth/login', {
      method: 'POST',
      body: { identifier: 'alice@example.com', password: 'changed-strong-password' },
    });
    assert.equal(login.status, 200);
    alice = login.body;
  });

  await t.test('会话标题同步和重命名', async () => {
    const created = await ctx.api('/api/sessions/session_test_1', {
      method: 'PUT',
      headers: authHeaders(alice.accessToken),
      body: {
        title: '初始聊天',
        departmentId: 'general',
        agentId: '',
        status: 'active',
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.session.id, 'session_test_1');
    assert.equal(created.body.session.title, '初始聊天');
    assert.equal(created.body.session.departmentId, 'general');
    assert.equal(created.body.session.pinned, false);

    const emptyTitle = await ctx.api('/api/sessions/session_test_1', {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { title: '' },
    });
    assert.equal(emptyTitle.status, 400);
    assert.equal(emptyTitle.body.error.code, 'invalid_session_title');

    const renamed = await ctx.api('/api/sessions/session_test_1', {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { title: '远程重命名', pinned: true },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.session.title, '远程重命名');
    assert.equal(renamed.body.session.pinned, true);

    const list = await ctx.api('/api/sessions', {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].id, 'session_test_1');
    assert.equal(list.body.items[0].title, '远程重命名');

    const deleted = await ctx.api('/api/sessions/session_test_1', {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { deleted: true },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.session.status, 'deleted');

    const afterDelete = await ctx.api('/api/sessions', {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(afterDelete.body.items.some((item) => item.id === 'session_test_1'), false);
  });

  await t.test('准备好友测试用户并搜索用户', async () => {
    bob = await ctx.registerUser('bob@example.com', 'Bob');
    carol = await ctx.registerUser('carol@example.com', 'Carol');

    const search = await ctx.api('/api/friends/search?q=bob&limit=20', {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(search.status, 200);
    assert.equal(search.body.items.length, 1);
    assert.equal(search.body.items[0].id, bob.user.id);
    assert.equal(search.body.items[0].friendshipStatus, 'none');
    assert.equal(search.body.items[0].displayName, 'Bob');
  });

  await t.test('发送好友申请', async () => {
    const send = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: bob.user.id, message: 'Hi' },
    });
    assert.equal(send.status, 200);
    assert.equal(send.body.ok, true);
    assert.ok(send.body.requestId);
    assert.equal(send.body.overview.requests.outgoing.length, 1);

    const duplicate = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: bob.user.id, message: 'Again' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'friend_request_already_pending');

    const self = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: alice.user.id },
    });
    assert.equal(self.status, 400);
  });

  await t.test('接受好友申请', async () => {
    const bobOverview = await ctx.api('/api/friends', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(bobOverview.body.requests.incoming[0].user.id, alice.user.id,
      'friend request payloads must expose the other user ID instead of the request ID');
    const requestId = bobOverview.body.requests.incoming[0].id;
    const accept = await ctx.api(`/api/friends/requests/${requestId}/accept`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.overview.friends.length, 1);
    assert.equal(accept.body.overview.friends[0].friend.id, alice.user.id);

    const bobRemark = await ctx.api(`/api/friends/${alice.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { remark: '项目负责人 Alice' },
    });
    assert.equal(bobRemark.status, 200);
    assert.equal(bobRemark.body.overview.friends[0].remark, '项目负责人 Alice');
    assert.equal(bobRemark.body.overview.friends[0].friend.remark, '项目负责人 Alice');
    const aliceOverview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
    assert.equal(aliceOverview.body.friends[0].remark, '', 'the other side must not inherit a private friend remark');

    const alreadyFriends = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: bob.user.id },
    });
    assert.equal(alreadyFriends.status, 409);
    assert.equal(alreadyFriends.body.error.code, 'friendship_already_exists');
  });

  await t.test('自定义头像完整保存并向好友双向同步', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
    const avatarOne = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(3_072, 1)]).toString('base64')}`;
    const avatarTwo = `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(3_200, 2)]).toString('base64')}`;
    assert.ok(avatarOne.length > 2_048);
    const updated = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { avatarUrl: avatarOne },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.avatarUrl, avatarOne);
    let aliceOverview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
    assert.equal(aliceOverview.body.friends[0].friend.avatarUrl, avatarOne);
    assert.ok(aliceOverview.body.friends[0].friend.updatedAt);

    const replaced = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { avatarUrl: avatarTwo },
    });
    assert.equal(replaced.status, 200);
    aliceOverview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
    assert.equal(aliceOverview.body.friends[0].friend.avatarUrl, avatarTwo);

    const truncatedWebp = Buffer.alloc(20);
    truncatedWebp.write('RIFF', 0, 'ascii');
    truncatedWebp.writeUInt32LE(12_000, 4);
    truncatedWebp.write('WEBP', 8, 'ascii');
    const rejected = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { avatarUrl: `data:image/webp;base64,${truncatedWebp.toString('base64')}` },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error.code, 'profile_avatar_invalid');

    const localOnly = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { avatarUrl: 'file:///private/avatar.png' },
    });
    assert.equal(localOnly.status, 400);
    assert.equal(localOnly.body.error.code, 'profile_avatar_invalid');

    await ctx.pool.query("UPDATE users SET avatar_url='file:///legacy/avatar.png' WHERE id=$1", [bob.user.id]);
    const legacyPreserved = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { displayName: 'Bob Legacy Avatar' },
    });
    assert.equal(legacyPreserved.status, 200);
    assert.equal(legacyPreserved.body.user.avatarUrl, 'file:///legacy/avatar.png');
    const restoredPortableAvatar = await ctx.api('/api/auth/profile', {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { displayName: 'Bob', avatarUrl: avatarTwo },
    });
    assert.equal(restoredPortableAvatar.status, 200);
  });

  await t.test('组织上下文中的私聊与附件对消息双方账号级可见', async () => {
    const workspaceId = 'workspace_org_account_social_direct_contract';
    await ctx.pool.query(`INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status)
      VALUES($1,'organization',$2,$3,'Account social direct contract','active')`,
    [workspaceId, 'organization_account_social_direct_contract', alice.user.id]);
    await ctx.pool.query(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,display_name)
      VALUES($1,$2,'owner','active','Alice')`, [workspaceId, alice.user.id]);

    const fileBytes = Buffer.from('organization direct attachment\n', 'utf8');
    const fileId = 'organization_direct_attachment_contract';
    const uploaded = await ctx.raw(`/api/social/files/${fileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(alice.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-workspace-id': workspaceId,
        'x-janus-recipient-id': bob.user.id,
        'x-janus-filename': encodeURIComponent('organization-direct.md'),
        'x-janus-content-type': 'text/markdown',
        'x-janus-file-sha256': crypto.createHash('sha256').update(fileBytes).digest('hex'),
      },
      body: fileBytes,
    });
    assert.equal(uploaded.status, 201);
    const attachment = JSON.parse(uploaded.body.toString('utf8')).attachment;
    const sent = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        workspaceId,
        recipientId: bob.user.id,
        content: '组织上下文中的账号级私聊附件',
        socialCapability: 'account-social-direct-v1',
        metadata: { type: 'direct_message', attachments: [attachment] },
      },
    });
    assert.equal(sent.status, 201);

    const legacyList = await ctx.api('/api/social/messages?workspaceId=workspace_personal', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(legacyList.body.items.some((item) => item.id === sent.body.message.id), false,
      'legacy workspace-scoped clients must keep their previous behavior');
    const accountGlobalList = await ctx.api('/api/social/messages?workspaceId=workspace_personal&capability=account-social-direct-v1', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(accountGlobalList.body.items.some((item) => item.id === sent.body.message.id), true);

    const legacyDownload = await ctx.raw(`/api/social/files/${fileId}?workspaceId=workspace_personal`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(legacyDownload.status, 404);
    const accountGlobalDownload = await ctx.raw(`/api/social/files/${fileId}?workspaceId=workspace_personal&capability=account-social-direct-v1`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(accountGlobalDownload.status, 200);
    assert.deepEqual(accountGlobalDownload.body, fileBytes);

    const markedRead = await ctx.api(`/api/social/messages/${sent.body.message.id}/read`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { workspaceId: 'workspace_personal', socialCapability: 'account-social-direct-v1' },
    });
    assert.equal(markedRead.status, 200);
    assert.equal(markedRead.body.message.status, 'read');
  });

  await t.test('大文件分片续传、消息绑定、权限与 Range 下载', async () => {
    const fileBytes = Buffer.alloc(60 * 1024 * 1024 + 123, 0x5a);
    fileBytes.write('JANUS-LARGE-FILE', 0, 'utf8');
    const fileId = 'large_direct_message_contract';
    const sha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
    const created = await ctx.api('/api/file-uploads', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        fileId, scopeKind: 'social', scopeId: bob.user.id, workspaceId: 'workspace_personal',
        filename: 'large-package.zip', contentType: 'application/zip', size: fileBytes.length, sha256,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.chunkSize, 16 * 1024 * 1024);
    const uploadId = created.body.uploadId;
    const firstChunk = fileBytes.subarray(0, created.body.chunkSize);
    const firstSha = crypto.createHash('sha256').update(firstChunk).digest('hex');
    const rejected = await ctx.raw(`/api/file-uploads/${uploadId}/chunks/0`, {
      method: 'PUT', headers: { ...authHeaders(alice.accessToken), 'content-type': 'application/octet-stream', 'x-janus-chunk-sha256': '0'.repeat(64) }, body: firstChunk,
    });
    assert.equal(rejected.status, 400);
    const first = await ctx.raw(`/api/file-uploads/${uploadId}/chunks/0`, {
      method: 'PUT', headers: { ...authHeaders(alice.accessToken), 'content-type': 'application/octet-stream', 'x-janus-chunk-sha256': firstSha }, body: firstChunk,
    });
    assert.equal(first.status, 201);
    const repeated = await ctx.raw(`/api/file-uploads/${uploadId}/chunks/0`, {
      method: 'PUT', headers: { ...authHeaders(alice.accessToken), 'content-type': 'application/octet-stream', 'x-janus-chunk-sha256': firstSha }, body: firstChunk,
    });
    assert.equal(repeated.status, 200);
    const resumed = await ctx.api(`/api/file-uploads/${uploadId}`, { headers: authHeaders(alice.accessToken) });
    assert.deepEqual(resumed.body.uploadedChunks, [0]);
    for (let index = 1; index < created.body.chunkCount; index += 1) {
      const chunk = fileBytes.subarray(index * created.body.chunkSize, Math.min(fileBytes.length, (index + 1) * created.body.chunkSize));
      const response = await ctx.raw(`/api/file-uploads/${uploadId}/chunks/${index}`, {
        method: 'PUT',
        headers: { ...authHeaders(alice.accessToken), 'content-type': 'application/octet-stream', 'x-janus-chunk-sha256': crypto.createHash('sha256').update(chunk).digest('hex') },
        body: chunk,
      });
      assert.equal(response.status, 201);
    }
    const completed = await ctx.api(`/api/file-uploads/${uploadId}/complete`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: {},
    });
    assert.equal(completed.status, 201);
    assert.equal(completed.body.attachment.remote_file_id, fileId);
    assert.equal(completed.body.attachment.resumable, true);
    const message = await ctx.api('/api/social/messages', {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: { recipientId: bob.user.id, content: '大文件附件', metadata: { attachments: [completed.body.attachment] } },
    });
    assert.equal(message.status, 201);
    const range = await ctx.raw(`/api/social/files/${fileId}`, {
      headers: { ...authHeaders(bob.accessToken), range: 'bytes=7-31' },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 7-31/${fileBytes.length}`);
    assert.deepEqual(range.body, fileBytes.subarray(7, 32));
    const outsider = await ctx.raw(`/api/social/files/${fileId}`, { headers: authHeaders(carol.accessToken) });
    assert.equal(outsider.status, 403);
  });

  await t.test('自然人群聊的幂等、成员与只读闭环', async () => {
    const capabilities = await ctx.api('/api/social/capabilities', { headers: authHeaders(alice.accessToken) });
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.capabilities.includes('chat-groups-v2'), true);
    assert.equal(capabilities.body.capabilities.includes('chat-group-message-withdraw-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('chat-group-files-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('conversation-inbox-archive-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('delegation-realtime-sse-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('direct-delegation-files-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('delegation-execution-lease-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('delegation-create-idempotency-v1'), true);
    assert.equal(capabilities.body.capabilities.includes('agent-work-detail-projection-v1'), true);
    assert.equal(capabilities.body.chatGroups.audienceScope, 'account_social');
    assert.equal(capabilities.body.chatGroups.messageWithdraw, true);
    const request = {
      groupId: 'chat_group_contract_1',
      clientRequestId: 'chat-group-request-1',
      title: '产品讨论组',
      memberIds: [bob.user.id],
      historyVisibility: 'from_join',
    };
    const created = await ctx.api('/api/chat-groups', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: request,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.group.id, request.groupId);
    assert.equal(created.body.group.scopeType, 'external');
    assert.equal(created.body.members.length, 2);

    const missingArchiveCapability = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: true, commandId: 'chat-group-archive-missing-capability', expectedRevision: 0,
      },
    });
    assert.equal(missingArchiveCapability.status, 426);
    const outsiderArchive = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(carol.accessToken), body: {
        socialCapability: 'conversation-inbox-archive-v1',
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: true, commandId: 'chat-group-archive-outsider', expectedRevision: 0,
      },
    });
    assert.equal(outsiderArchive.status, 404);

    const archived = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: {
        socialCapability: 'conversation-inbox-archive-v1',
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: true, commandId: 'chat-group-archive-1', expectedRevision: 0,
      },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.preference.archived, true);
    const archiveRevisionConflict = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        socialCapability: 'conversation-inbox-archive-v1',
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: false, commandId: 'chat-group-archive-stale', expectedRevision: 0,
      },
    });
    assert.equal(archiveRevisionConflict.status, 409);
    assert.equal(archiveRevisionConflict.body.error.code, 'conversation_preference_conflict');

    const repeated = await ctx.api('/api/chat-groups', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: request,
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.idempotent, true);

    const conflict = await ctx.api('/api/chat-groups', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { ...request, title: '冲突群名' },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'chat_group_idempotency_conflict');

    const groupDisplayName = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { action: 'set_display_name', displayName: '群里的 Bob', clientRequestId: 'chat-display-name-1' },
    });
    assert.equal(groupDisplayName.status, 200);
    assert.equal(groupDisplayName.body.members.find((member) => member.userId === bob.user.id).displayNameOverride, '群里的 Bob');

    const sent = await ctx.api(`/api/chat-groups/${request.groupId}/messages`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { clientMessageId: 'chat_group_message_1', content: '大家好', sourceEventId: 'chat-source-1' },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.messages.some((message) => message.content === '大家好'), true);
    assert.equal(sent.body.messages.find((message) => message.content === '大家好').sender.displayName, '群里的 Bob');
    const autoReopened = await ctx.api('/api/social/conversation-preferences?capability=conversation-inbox-archive-v1', {
      headers: authHeaders(bob.accessToken),
    });
    const autoReopenedPreference = autoReopened.body.preferences.find((item) => item.conversationId === request.groupId);
    assert.equal(autoReopenedPreference.archived, false);
    assert.equal(autoReopenedPreference.autoReopened, true);

    const repeatedMessage = await ctx.api(`/api/chat-groups/${request.groupId}/messages`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { clientMessageId: 'chat_group_message_1', content: '大家好', sourceEventId: 'chat-source-1' },
    });
    assert.equal(repeatedMessage.status, 200);
    assert.equal(repeatedMessage.body.idempotent, true);

    const chatFileBytes = Buffer.from('print("hello from group")\n', 'utf8');
    const chatFileId = 'chat_group_file_contract_1';
    const chatFileUpload = await ctx.raw(`/api/chat-groups/${request.groupId}/message-files/${chatFileId}?capability=chat-groups-v2`, {
      method: 'PUT',
      headers: {
        ...authHeaders(bob.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent('hello.py'),
        'x-janus-content-type': 'text/x-python',
        'x-janus-file-sha256': crypto.createHash('sha256').update(chatFileBytes).digest('hex'),
      },
      body: chatFileBytes,
    });
    assert.equal(chatFileUpload.status, 201);
    const chatFileAttachment = JSON.parse(chatFileUpload.body.toString('utf8')).attachment;
    assert.equal(chatFileAttachment.remote_file_kind, 'chat_group');
    assert.equal(chatFileAttachment.group_id, request.groupId);
    const fileMessage = await ctx.api(`/api/chat-groups/${request.groupId}/messages`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { clientMessageId: 'chat_group_message_file_1', content: '分享了附件。', metadata: { attachments: [chatFileAttachment] } },
    });
    assert.equal(fileMessage.status, 201);
    assert.equal(fileMessage.body.messages.at(-1).metadata.attachments[0].remote_file_id, chatFileId);
    const memberChatFileDownload = await ctx.raw(`/api/chat-groups/${request.groupId}/message-files/${chatFileId}?capability=chat-groups-v2`, {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(memberChatFileDownload.status, 200);
    assert.deepEqual(memberChatFileDownload.body, chatFileBytes);
    const outsiderChatFileDownload = await ctx.raw(`/api/chat-groups/${request.groupId}/message-files/${chatFileId}?capability=chat-groups-v2`, {
      headers: authHeaders(carol.accessToken),
    });
    assert.equal(outsiderChatFileDownload.status, 404);

    const forbiddenWithdraw = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(alice.accessToken),
      body: { action: 'withdraw_message', messageId: 'chat_group_message_1', clientRequestId: 'chat-withdraw-forbidden-1' },
    });
    assert.equal(forbiddenWithdraw.status, 403);
    assert.equal(forbiddenWithdraw.body.error.code, 'chat_group_message_withdraw_forbidden');

    const withdrawn = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { action: 'withdraw_message', messageId: 'chat_group_message_1', clientRequestId: 'chat-withdraw-1' },
    });
    assert.equal(withdrawn.status, 200);
    const withdrawnMessage = withdrawn.body.messages.find((message) => message.id === 'chat_group_message_1');
    assert.equal(withdrawnMessage.metadata.withdrawn, true);
    assert.equal(withdrawnMessage.content, '大家好');
    const withdrawnRetry = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { action: 'withdraw_message', messageId: 'chat_group_message_1', clientRequestId: 'chat-withdraw-1' },
    });
    assert.equal(withdrawnRetry.status, 200);
    assert.equal(withdrawnRetry.body.idempotent, true);
    const withdrawnOverview = await ctx.api('/api/chat-groups', { headers: authHeaders(bob.accessToken) });
    assert.equal(withdrawnOverview.body.groups.find((group) => group.id === request.groupId).lastMessage, '群里的 Bob：分享了附件。');

    const expiredMessage = await ctx.api(`/api/chat-groups/${request.groupId}/messages`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { clientMessageId: 'chat_group_message_expired', content: '过期群聊消息' },
    });
    assert.equal(expiredMessage.status, 201);
    await ctx.pool.query('UPDATE chat_group_messages SET created_at=$1 WHERE id=$2', [
      new Date(Date.now() - 3 * 60 * 1000), 'chat_group_message_expired',
    ]);
    const expiredWithdraw = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { action: 'withdraw_message', messageId: 'chat_group_message_expired', clientRequestId: 'chat-withdraw-expired-1' },
    });
    assert.equal(expiredWithdraw.status, 409);
    assert.equal(expiredWithdraw.body.error.code, 'chat_group_message_withdraw_expired');

    const renamed = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(alice.accessToken),
      body: { action: 'rename', title: '产品与设计', clientRequestId: 'chat-rename-1' },
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.group.title, '产品与设计');

    const reArchived = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: {
        socialCapability: 'conversation-inbox-archive-v1',
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: true, commandId: 'chat-group-archive-2', expectedRevision: 1,
      },
    });
    assert.equal(reArchived.status, 200);
    const repeatedArchive = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        socialCapability: 'conversation-inbox-archive-v1',
        conversationKind: 'chat_group', conversationId: request.groupId,
        archived: true, commandId: 'chat-group-archive-2', expectedRevision: 1,
      },
    });
    assert.equal(repeatedArchive.status, 200);
    assert.equal(repeatedArchive.body.preference.archived, true);

    const dissolved = await ctx.api(`/api/chat-groups/${request.groupId}`, {
      method: 'PATCH', headers: authHeaders(alice.accessToken),
      body: { action: 'dissolve', clientRequestId: 'chat-dissolve-1' },
    });
    assert.equal(dissolved.status, 200);
    assert.equal(dissolved.body.group.status, 'dissolved');
    const archivedAfterDissolve = await ctx.api('/api/social/conversation-preferences?capability=conversation-inbox-archive-v1', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(archivedAfterDissolve.body.preferences.find((item) => item.conversationId === request.groupId).archived, true);
    const blocked = await ctx.api(`/api/chat-groups/${request.groupId}/messages`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: { content: '不应发送' },
    });
    assert.equal(blocked.status, 409);
  });

  await t.test('真实任务群、结果版本和发起人关闭闭环', async () => {
    const created = await ctx.api('/api/collaboration/groups', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        title: '季度汇报任务群',
        clientRequestId: 'collaboration-request-1',
        assignments: [{ recipientId: bob.user.id, title: '制作汇报', instruction: '制作一份季度汇报 PPT。' }],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.members.length, 2);
    assert.equal(created.body.tasks.length, 1);
    assert.equal(created.body.tasks[0].status, 'assigned');
    const groupId = created.body.group.id;
    const delegationId = created.body.tasks[0].id;
    assert.equal(created.body.workspace.id, groupId);
    assert.equal(created.body.workspace.scope, 'collaboration_group');
    const bobCollaborationOverview = await ctx.api('/api/collaboration', { headers: authHeaders(bob.accessToken) });
    assert.equal(bobCollaborationOverview.status, 200);
    const bobOverviewGroup = bobCollaborationOverview.body.groups.find((item) => item.id === groupId);
    assert.equal(bobOverviewGroup.clientRequestId, 'collaboration-request-1');
    assert.equal(bobOverviewGroup.membership.userId, bob.user.id);
    assert.equal(bobOverviewGroup.membership.role, 'member');
    assert.equal(bobOverviewGroup.membership.status, 'active');
    const workGroupDisplayName = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken),
      body: { action: 'set_display_name', displayName: '工作群里的 Bob' },
    });
    assert.equal(workGroupDisplayName.status, 200);
    assert.equal(workGroupDisplayName.body.members.find((member) => member.userId === bob.user.id).displayNameOverride, '工作群里的 Bob');
    assert.equal(workGroupDisplayName.body.members.find((member) => member.userId === bob.user.id).user.displayName, '工作群里的 Bob');
    const archivedWorkGroup = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        socialCapability: 'conversation-inbox-archive-v1', conversationKind: 'collaboration_group',
        conversationId: groupId, archived: true, commandId: 'work-group-archive-1', expectedRevision: 0,
      },
    });
    assert.equal(archivedWorkGroup.status, 200);
    assert.equal(archivedWorkGroup.body.preference.archived, true);
    const restoredWorkGroup = await ctx.api('/api/social/conversation-preferences', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        socialCapability: 'conversation-inbox-archive-v1', conversationKind: 'collaboration_group',
        conversationId: groupId, archived: false, commandId: 'work-group-archive-2', expectedRevision: 1,
      },
    });
    assert.equal(restoredWorkGroup.status, 200);
    assert.equal(restoredWorkGroup.body.preference.archived, false);

    const initialWorkspace = await ctx.api(`/api/collaboration/groups/${groupId}/workspace`, { headers: authHeaders(bob.accessToken) });
    assert.equal(initialWorkspace.status, 200);
    assert.equal(initialWorkspace.body.workspace.id, groupId);
    const workspaceFileId = 'group_workspace_contract_report';
    const workspaceRelativePath = 'deliverables/contract-report.md';
    const workspaceFileBytes = Buffer.from('GROUP_SHARED_WORKSPACE_OK\n', 'utf8');
    const workspaceUpload = await ctx.raw(`/api/collaboration/groups/${groupId}/workspace/files/${workspaceFileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(bob.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-relative-path': encodeURIComponent(workspaceRelativePath),
        'x-janus-filename': encodeURIComponent('contract-report.md'),
        'x-janus-content-type': 'text/markdown',
        'x-janus-file-sha256': crypto.createHash('sha256').update(workspaceFileBytes).digest('hex'),
        'x-janus-base-revision': '0',
      },
      body: workspaceFileBytes,
    });
    assert.equal(workspaceUpload.status, 201);
    const aliceWorkspace = await ctx.api(`/api/collaboration/groups/${groupId}/workspace`, { headers: authHeaders(alice.accessToken) });
    assert.equal(aliceWorkspace.body.workspace.id, initialWorkspace.body.workspace.id);
    assert.equal(aliceWorkspace.body.files.some((file) => file.id === workspaceFileId && file.relativePath === workspaceRelativePath), true);
    const sharedWorkspaceDownload = await ctx.raw(`/api/collaboration/groups/${groupId}/workspace/files/${workspaceFileId}`, {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(sharedWorkspaceDownload.status, 200);
    assert.deepEqual(sharedWorkspaceDownload.body, workspaceFileBytes);
    const outsiderWorkspace = await ctx.api(`/api/collaboration/groups/${groupId}/workspace`, { headers: authHeaders(carol.accessToken) });
    assert.equal(outsiderWorkspace.status, 404);

    const groupMessageFileBytes = Buffer.from('GROUP_MESSAGE_ATTACHMENT_OK\n', 'utf8');
    const groupMessageFileId = 'group_message_attachment_contract';
    const groupMessageFileUpload = await ctx.raw(`/api/collaboration/groups/${groupId}/message-files/${groupMessageFileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(alice.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent('群消息附件.md'),
        'x-janus-content-type': 'text/markdown',
        'x-janus-file-sha256': crypto.createHash('sha256').update(groupMessageFileBytes).digest('hex'),
      },
      body: groupMessageFileBytes,
    });
    assert.equal(groupMessageFileUpload.status, 201);
    const groupMessageAttachment = JSON.parse(groupMessageFileUpload.body.toString('utf8')).attachment;
    assert.equal(groupMessageAttachment.remote_file_kind, 'collaboration_group');
    assert.equal(groupMessageAttachment.group_id, groupId);
    const groupMessage = await ctx.api(`/api/collaboration/groups/${groupId}/messages`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        content: '请查看群附件。',
        metadata: {
          privateTaskWorkspace: true,
          taskWorkspaceRoot: '/home/alice/private/task-workspace',
          workspaceRoot: '/home/alice/private/project',
          sourceSecretarySessionId: 'private-secretary-session',
          nested: { localPath: '/home/alice/private/nested.md', safeLabel: '公开标签' },
          attachments: [{ ...groupMessageAttachment, path: '/home/alice/private/group-message.md' }],
        },
      },
    });
    assert.equal(groupMessage.status, 201);
    const persistedGroupMetadata = groupMessage.body.messages.at(-1).metadata;
    const persistedGroupAttachment = persistedGroupMetadata.attachments[0];
    assert.equal(persistedGroupAttachment.remote_file_id, groupMessageFileId);
    assert.equal(Object.hasOwn(persistedGroupAttachment, 'path'), false);
    assert.equal(Object.hasOwn(persistedGroupMetadata, 'privateTaskWorkspace'), false);
    assert.equal(Object.hasOwn(persistedGroupMetadata, 'taskWorkspaceRoot'), false);
    assert.equal(Object.hasOwn(persistedGroupMetadata, 'workspaceRoot'), false);
    assert.equal(Object.hasOwn(persistedGroupMetadata, 'sourceSecretarySessionId'), false);
    assert.deepEqual(persistedGroupMetadata.nested, { safeLabel: '公开标签' });
    const memberGroupMessageDownload = await ctx.raw(`/api/collaboration/groups/${groupId}/message-files/${groupMessageFileId}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(memberGroupMessageDownload.status, 200);
    assert.deepEqual(memberGroupMessageDownload.body, groupMessageFileBytes);
    const outsiderGroupMessageDownload = await ctx.raw(`/api/collaboration/groups/${groupId}/message-files/${groupMessageFileId}`, {
      headers: authHeaders(carol.accessToken),
    });
    assert.equal(outsiderGroupMessageDownload.status, 404);

    const forbiddenGroupRename = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { action: 'rename', title: '成员不能修改的群名' },
    });
    assert.equal(forbiddenGroupRename.status, 403);
    assert.equal(forbiddenGroupRename.body.error.code, 'collaboration_owner_required');
    const ownerGroupRename = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'rename', title: '季度汇报协作群' },
    });
    assert.equal(ownerGroupRename.status, 200);
    assert.equal(ownerGroupRename.body.group.title, '季度汇报协作群');

    const duplicate = await ctx.api('/api/collaboration/groups', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { title: '重复请求', clientRequestId: 'collaboration-request-1', assignments: [{ recipientId: bob.user.id, instruction: '不应重复创建' }] },
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.group.id, groupId);
    assert.equal(duplicate.body.idempotent, true);

    const concurrentRequestId = 'collaboration-request-concurrent-1';
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => ctx.api('/api/collaboration/groups', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        title: '并发幂等任务群',
        clientRequestId: concurrentRequestId,
        assignments: [{ recipientId: bob.user.id, title: '并发任务', instruction: '只应创建一份并发任务。' }],
      },
    })));
    assert.equal(concurrent.every((response) => [200, 201].includes(response.status)), true);
    const concurrentGroupIds = new Set(concurrent.map((response) => response.body.group?.id).filter(Boolean));
    assert.equal(concurrentGroupIds.size, 1);
    const concurrentGroupId = [...concurrentGroupIds][0];
    assert.equal(Number((await ctx.pool.query(`SELECT count(*) AS count FROM collaboration_groups
      WHERE owner_user_id=$1 AND client_request_id=$2`, [alice.user.id, concurrentRequestId])).rows[0].count), 1);
    assert.equal(Number((await ctx.pool.query('SELECT count(*) AS count FROM agent_delegations WHERE group_id=$1',
      [concurrentGroupId])).rows[0].count), 1);

    const missingAssignment = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'add_member', userId: bob.user.id },
    });
    assert.equal(missingAssignment.status, 400);
    assert.equal(missingAssignment.body.error.code, 'collaboration_assignment_required');

    const bobOverview = await ctx.api('/api/collaboration', { headers: authHeaders(bob.accessToken) });
    assert.equal(bobOverview.status, 200);
    assert.equal(bobOverview.body.groups.some((item) => item.id === groupId), true);

    const prematureSubmit = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { action: 'submit', content: '季度汇报初稿已完成。\n\n### 执行记录\nProcess timed out after 120000ms: /usr/bin/codex\n本地文件：/home/bob/private/report.pptx' },
    });
    assert.equal(prematureSubmit.status, 409);
    assert.equal(prematureSubmit.body.error.code, 'delegation_transition_invalid');

    const working = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { action: 'working' },
    });
    assert.equal(working.status, 200);
    assert.equal(working.body.delegation.status, 'working');

    const fileBytes = Buffer.from('JANUS_CROSS_USER_TASK_FILE_OK\n', 'utf8');
    const fileId = 'collab_file_contract_report';
    const uploadedFile = await ctx.raw(`/api/collaboration/tasks/${delegationId}/files/${fileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(bob.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-filename': encodeURIComponent('季度汇报结果.md'),
        'x-janus-content-type': 'text/markdown',
      },
      body: fileBytes,
    });
    assert.equal(uploadedFile.status, 201);
    const uploadedAttachment = JSON.parse(uploadedFile.body.toString('utf8')).attachment;
    assert.equal(uploadedAttachment.remote_file_id, fileId);
    assert.equal(uploadedAttachment.filename, '季度汇报结果.md');

    const outsiderDownload = await ctx.raw(`/api/collaboration/files/${fileId}`, {
      headers: authHeaders(carol.accessToken),
    });
    assert.equal(outsiderDownload.status, 403);

    const submitted = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: {
        action: 'submit',
        content: '季度汇报初稿已完成。\n\n### 执行记录\nProcess timed out after 120000ms: /usr/bin/codex\n本地文件：/home/bob/private/report.pptx',
        metadata: {
          attachments: [{
            ...uploadedAttachment,
            path: '/home/bob/private/季度汇报结果.md',
            source_path: '/home/bob/private/季度汇报结果.md',
          }],
        },
      },
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.delegation.status, 'submitted');
    const publicSubmission = submitted.body.messages.find((item) => item.metadata?.delegationId === delegationId && item.metadata?.action === 'submit');
    assert.ok(publicSubmission);
    assert.match(publicSubmission.content, /季度汇报初稿已完成/);
    assert.doesNotMatch(publicSubmission.content, /执行记录|Process timed out|\/usr\/bin\/codex|\/home\/bob/);
    assert.equal(publicSubmission.metadata.attachments[0].remote_file_id, fileId);
    assert.equal(Object.hasOwn(publicSubmission.metadata.attachments[0], 'path'), false);
    assert.equal(Object.hasOwn(publicSubmission.metadata.attachments[0], 'source_path'), false);

    const requesterDownload = await ctx.raw(`/api/collaboration/files/${fileId}`, {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(requesterDownload.status, 200);
    assert.deepEqual(requesterDownload.body, fileBytes);
    assert.equal(requesterDownload.headers.get('x-janus-file-sha256'), uploadedAttachment.sha256);

    const revision = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'request_revision', content: '请补充同比数据和风险页。', expectedStatus: 'submitted' },
    });
    assert.equal(revision.status, 200);
    assert.equal(revision.body.delegation.status, 'revision_requested');

    const staleSubmit = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { action: 'submit', content: '迟到的旧版提交不应覆盖修改请求。', expectedStatus: 'draft_ready' },
    });
    assert.equal(staleSubmit.status, 409);
    assert.equal(staleSubmit.body.error.code, 'delegation_status_conflict');
    const afterStaleSubmit = await ctx.api('/api/collaboration', { headers: authHeaders(alice.accessToken) });
    assert.equal(afterStaleSubmit.body.tasks.find((item) => item.id === delegationId).status, 'revision_requested');

    const forbiddenClose = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { action: 'close' },
    });
    assert.equal(forbiddenClose.status, 403);

    const closed = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'close' },
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.group.status, 'closed');
    assert.equal(closed.body.tasks[0].status, 'closed');

    const closedGroupDownload = await ctx.raw(`/api/collaboration/files/${fileId}`, {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(closedGroupDownload.status, 200);
    assert.deepEqual(closedGroupDownload.body, fileBytes);

    const renameClosed = await ctx.api(`/api/collaboration/groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'rename', title: '不应生效' },
    });
    assert.equal(renameClosed.status, 409);
    assert.equal(renameClosed.body.error.code, 'collaboration_group_closed');
  });

  await t.test('委托双方私有 uBuddy workspace 云端持久且严格隔离', async () => {
    const idempotentPayload = {
      recipientId: bob.user.id,
      clientRequestId: 'delegation-create-idempotency-1',
      title: '幂等委托测试',
      instruction: '同一个创建命令只能生成一份委托。',
    };
    const idempotentCreated = await ctx.api('/api/delegations', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: idempotentPayload,
    });
    assert.equal(idempotentCreated.status, 201);
    const idempotentRepeated = await ctx.api('/api/delegations', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: idempotentPayload,
    });
    assert.equal(idempotentRepeated.status, 200);
    assert.equal(idempotentRepeated.body.idempotent, true);
    assert.equal(idempotentRepeated.body.delegation.id, idempotentCreated.body.delegation.id);
    const idempotentConflict = await ctx.api('/api/delegations', {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: { ...idempotentPayload, instruction: '同一个幂等键不能改成另一项任务。' },
    });
    assert.equal(idempotentConflict.status, 409);
    assert.equal(idempotentConflict.body.error.code, 'delegation_idempotency_conflict');
    assert.equal(Number((await ctx.pool.query(`SELECT count(*) AS count FROM agent_delegations
      WHERE requester_user_id=$1 AND client_request_id=$2`, [alice.user.id, idempotentPayload.clientRequestId])).rows[0].count), 1);

    const concurrentRequestId = 'delegation-create-idempotency-concurrent-1';
    const concurrentDelegations = await Promise.all(Array.from({ length: 4 }, () => ctx.api('/api/delegations', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: {
        recipientId: bob.user.id,
        clientRequestId: concurrentRequestId,
        title: '并发委托测试',
        instruction: '并发恢复也只能创建一份委托。',
      },
    })));
    assert.equal(concurrentDelegations.every((response) => [200, 201].includes(response.status)), true);
    assert.equal(new Set(concurrentDelegations.map((response) => response.body.delegation?.id).filter(Boolean)).size, 1);
    assert.equal(Number((await ctx.pool.query(`SELECT count(*) AS count FROM agent_delegations
      WHERE requester_user_id=$1 AND client_request_id=$2`, [alice.user.id, concurrentRequestId])).rows[0].count), 1);

    const created = await ctx.api('/api/delegations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { recipientId: bob.user.id, title: '隔离测试', instruction: '先整理一份私有草稿。' },
    });
    assert.equal(created.status, 201);
    const delegationId = created.body.delegation.id;
    const realtimeEvents = await ctx.one(`SELECT COUNT(*)::int AS count FROM social_realtime_events
      WHERE aggregate_id=$1 AND event_type='delegation.assigned'`, [delegationId]);
    assert.equal(Number(realtimeEvents.count), 2);

    const firstClaim = await ctx.api(`/api/delegations/${delegationId}/execution-claim`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-a', leaseSeconds: 90 },
    });
    assert.equal(firstClaim.status, 200);
    assert.equal(firstClaim.body.lease.executionEpoch, 1);
    const conflictingClaim = await ctx.api(`/api/delegations/${delegationId}/execution-claim`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-b', leaseSeconds: 90 },
    });
    assert.equal(conflictingClaim.status, 409);
    assert.equal(conflictingClaim.body.error.code, 'delegation_execution_claimed');
    const renewed = await ctx.api(`/api/delegations/${delegationId}/execution-lease/renew`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-a', leaseToken: firstClaim.body.lease.leaseToken },
    });
    assert.equal(renewed.status, 200);
    const released = await ctx.api(`/api/delegations/${delegationId}/execution-lease/release`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-a', leaseToken: firstClaim.body.lease.leaseToken, reason: 'test_handoff' },
    });
    assert.equal(released.status, 200);
    const takeover = await ctx.api(`/api/delegations/${delegationId}/execution-claim`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-b', leaseSeconds: 90 },
    });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.body.lease.executionEpoch, 2);
    await ctx.api(`/api/delegations/${delegationId}/execution-lease/release`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'bob-device-b', leaseToken: takeover.body.lease.leaseToken, reason: 'test_complete' },
    });

    const planningRecovery = await ctx.api('/api/delegations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { recipientId: bob.user.id, title: '规划恢复熔断测试', instruction: '验证规划阶段不会无限重新认领。' },
    });
    assert.equal(planningRecovery.status, 201);
    const planningRecoveryId = planningRecovery.body.delegation.id;
    await ctx.api(`/api/delegations/${planningRecoveryId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { status: 'running' },
    });
    for (let epoch = 1; epoch <= 3; epoch += 1) {
      const claim = await ctx.api(`/api/delegations/${planningRecoveryId}/execution-claim`, {
        method: 'POST', headers: authHeaders(bob.accessToken),
        body: { socialCapability: 'delegation-execution-lease-v1', deviceId: `planning-device-${epoch}`, leaseSeconds: 90 },
      });
      assert.equal(claim.status, 200);
      assert.equal(claim.body.lease.executionEpoch, epoch);
      await ctx.api(`/api/delegations/${planningRecoveryId}/execution-lease/release`, {
        method: 'POST', headers: authHeaders(bob.accessToken),
        body: { socialCapability: 'delegation-execution-lease-v1', deviceId: `planning-device-${epoch}`, leaseToken: claim.body.lease.leaseToken, reason: 'simulated_planning_crash' },
      });
    }
    const exhaustedPlanningClaim = await ctx.api(`/api/delegations/${planningRecoveryId}/execution-claim`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { socialCapability: 'delegation-execution-lease-v1', deviceId: 'planning-device-4', leaseSeconds: 90 },
    });
    assert.equal(exhaustedPlanningClaim.status, 409);
    assert.equal(exhaustedPlanningClaim.body.error.code, 'delegation_planning_recovery_exhausted');
    assert.equal(exhaustedPlanningClaim.body.error.details.executionEpoch, 4);
    const exhaustedPlanningRow = await ctx.one('SELECT status,last_error,metadata_json FROM agent_delegations WHERE id=$1', [planningRecoveryId]);
    assert.equal(exhaustedPlanningRow.status, 'failed');
    assert.match(exhaustedPlanningRow.last_error, /停止自动重试/);
    assert.equal(exhaustedPlanningRow.metadata_json.failureCode, 'ubuddy_planning_recovery_exhausted');
    assert.equal(exhaustedPlanningRow.metadata_json.executionProgress.terminal, true);

    const requesterWorkspace = await ctx.api(`/api/delegations/${delegationId}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { status: 'assigned', sessionId: 'same-local-session', metadata: { preliminaryResult: 'Alice 私有草稿' } },
    });
    assert.equal(requesterWorkspace.status, 200);
    assert.equal(requesterWorkspace.body.delegation.sessionId, 'same-local-session');
    assert.equal(requesterWorkspace.body.delegation.metadata.preliminaryResult, 'Alice 私有草稿');

    const recipientWorkspace = await ctx.api(`/api/delegations/${delegationId}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { status: 'assigned', sessionId: 'same-local-session', metadata: { preliminaryResult: 'Bob 私有初稿' } },
    });
    assert.equal(recipientWorkspace.status, 200);
    assert.equal(recipientWorkspace.body.delegation.sessionId, 'same-local-session');
    assert.equal(recipientWorkspace.body.delegation.metadata.preliminaryResult, 'Bob 私有初稿');

    await ctx.api(`/api/delegations/${delegationId}/workspace/messages`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { clientMessageId: 'alice-private-msg', sessionId: 'same-local-session', role: 'user', content: 'Alice 只给自己的 uBuddy 看' },
    });
    await ctx.api(`/api/delegations/${delegationId}/workspace/messages`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { clientMessageId: 'bob-private-msg', sessionId: 'same-local-session', role: 'assistant', content: 'Bob 的 uBuddy 私有初稿' },
    });
    const alicePrivate = await ctx.api(`/api/delegations/${delegationId}/workspace`, { headers: authHeaders(alice.accessToken) });
    const bobPrivate = await ctx.api(`/api/delegations/${delegationId}/workspace`, { headers: authHeaders(bob.accessToken) });
    assert.deepEqual(alicePrivate.body.items.map((item) => item.id), ['alice-private-msg']);
    assert.deepEqual(bobPrivate.body.items.map((item) => item.id), ['bob-private-msg']);

    const aliceOutgoing = await ctx.api('/api/delegations?direction=outgoing', { headers: authHeaders(alice.accessToken) });
    const bobIncoming = await ctx.api('/api/delegations?direction=incoming', { headers: authHeaders(bob.accessToken) });
    const aliceView = aliceOutgoing.body.items.find((item) => item.id === delegationId);
    const bobView = bobIncoming.body.items.find((item) => item.id === delegationId);
    assert.equal(aliceView.metadata.preliminaryResult, 'Alice 私有草稿');
    assert.equal(bobView.metadata.preliminaryResult, 'Bob 私有初稿');

    const requesterBypass = await ctx.api(`/api/delegations/${delegationId}`, {
      method: 'PATCH', headers: authHeaders(alice.accessToken), body: { status: 'completed' },
    });
    assert.equal(requesterBypass.status, 403);
    const recipientBypass = await ctx.api(`/api/delegations/${delegationId}`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { status: 'result_accepted' },
    });
    assert.equal(recipientBypass.status, 409);

    const published = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'publish', expectedStatus: 'assigned', content: '只发布这一版确认后的要求。' },
    });
    assert.equal(published.status, 200);
    const updated = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'update_requirements', expectedStatus: 'assigned', content: '更新：增加流程图。' },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.delegation.instruction, '更新：增加流程图。');
    const bobAfterUpdate = await ctx.api(`/api/delegations/${delegationId}/workspace`, { headers: authHeaders(bob.accessToken) });
    const aliceAfterUpdate = await ctx.api(`/api/delegations/${delegationId}/workspace`, { headers: authHeaders(alice.accessToken) });
    assert.equal(bobAfterUpdate.body.items.some((item) => item.content === '更新：增加流程图。' && item.metadata.action === 'update_requirements'), true);
    assert.equal(aliceAfterUpdate.body.items.some((item) => item.content === '更新：增加流程图。'), false);

    const directWorking = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: { action: 'working', expectedStatus: 'assigned' },
    });
    assert.equal(directWorking.status, 200);
    const directLargeFilePlan = {
      fileId: 'direct_delegation_large_upload_contract', scopeKind: 'collaboration_task', scopeId: delegationId,
      workspaceId: 'workspace_personal', filename: 'direct-large.zip', contentType: 'application/zip',
      size: 60 * 1024 * 1024 + 1, sha256: 'a'.repeat(64),
    };
    const directLargeWithoutCapability = await ctx.api('/api/file-uploads', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: directLargeFilePlan,
    });
    assert.equal(directLargeWithoutCapability.status, 426);
    assert.equal(directLargeWithoutCapability.body.error.code, 'direct_delegation_files_capability_required');
    const directLargeUpload = await ctx.api('/api/file-uploads', {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { ...directLargeFilePlan, socialCapability: 'direct-delegation-files-v1' },
    });
    assert.equal(directLargeUpload.status, 201);
    const directLargeUploadRow = await ctx.one('SELECT group_id,delegation_id FROM large_file_upload_sessions WHERE id=$1', [directLargeUpload.body.uploadId]);
    assert.equal(directLargeUploadRow.group_id, null);
    assert.equal(directLargeUploadRow.delegation_id, delegationId);
    await ctx.pool.query('DELETE FROM large_file_upload_sessions WHERE id=$1', [directLargeUpload.body.uploadId]);
    const directTaskFileBytes = Buffer.from('DIRECT_DELEGATION_DELIVERABLE_OK\n', 'utf8');
    const directTaskFileId = 'direct_delegation_deliverable_contract';
    const directTaskFileUpload = await ctx.raw(`/api/collaboration/tasks/${delegationId}/files/${directTaskFileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(bob.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-social-capability': 'direct-delegation-files-v1',
        'x-janus-filename': encodeURIComponent('直接委托交付.md'),
        'x-janus-content-type': 'text/markdown',
        'x-janus-file-sha256': crypto.createHash('sha256').update(directTaskFileBytes).digest('hex'),
      },
      body: directTaskFileBytes,
    });
    assert.equal(directTaskFileUpload.status, 201);
    const directTaskAttachment = JSON.parse(directTaskFileUpload.body.toString('utf8')).attachment;
    assert.equal(directTaskAttachment.remote_file_kind, 'collaboration_task');
    assert.equal(directTaskAttachment.group_id, '');
    const invalidDirectSubmit = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        action: 'submit', content: '不应接受不属于当前委托的附件。',
        metadata: { attachments: [{ remote_file_id: 'unknown_direct_delegation_file', remote_file_kind: 'collaboration_task' }] },
      },
    });
    assert.equal(invalidDirectSubmit.status, 400);
    assert.equal(invalidDirectSubmit.body.error.code, 'collaboration_file_scope_invalid');
    const directOutsiderDownload = await ctx.raw(`/api/collaboration/files/${directTaskFileId}`, { headers: authHeaders(carol.accessToken) });
    assert.equal(directOutsiderDownload.status, 403);
    const directSubmitted = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: {
        action: 'submit', expectedStatus: 'working', content: '直接委托文件已经完成。',
        metadata: { attachments: [{ ...directTaskAttachment, path: '/home/bob/private/direct.md' }] },
      },
    });
    assert.equal(directSubmitted.status, 200);
    assert.equal(directSubmitted.body.delegation.status, 'submitted');
    assert.equal(directSubmitted.body.delegation.metadata.attachments[0].remote_file_kind, 'collaboration_task');
    assert.equal(Object.hasOwn(directSubmitted.body.delegation.metadata.attachments[0], 'path'), false);
    for (const accessToken of [alice.accessToken, bob.accessToken]) {
      const downloaded = await ctx.raw(`/api/collaboration/files/${directTaskFileId}`, { headers: authHeaders(accessToken) });
      assert.equal(downloaded.status, 200);
      assert.deepEqual(downloaded.body, directTaskFileBytes);
    }
    const concurrentAcceptances = await Promise.all([1, 2].map(() => ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'accept_result', expectedStatus: 'submitted' },
    })));
    assert.equal(concurrentAcceptances.every((response) => response.status === 200), true, JSON.stringify(concurrentAcceptances));
    assert.equal(concurrentAcceptances.every((response) => response.body.delegation.status === 'result_accepted'), true);
    assert.equal(concurrentAcceptances.some((response) => response.body.idempotent === true), true);
    assert.equal(Number((await ctx.pool.query("SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id=$1 AND action='accept_result'", [delegationId])).rows[0].count), 1);
    assert.equal(Number((await ctx.pool.query("SELECT COUNT(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id=$1 AND metadata_json->>'type'='result_accepted'", [delegationId])).rows[0].count), 1);
    assert.equal(Number((await ctx.pool.query("SELECT COUNT(*) AS count FROM social_realtime_events WHERE aggregate_id=$1 AND event_type='delegation.accept_result'", [delegationId])).rows[0].count), 2);
    const staleAcceptanceRetry = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'accept_result', expectedStatus: 'submitted' },
    });
    assert.equal(staleAcceptanceRetry.status, 200);
    assert.equal(staleAcceptanceRetry.body.idempotent, true);
    const unauthorizedAcceptedRetry = await ctx.api(`/api/collaboration/tasks/${delegationId}/action`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: { action: 'accept_result' },
    });
    assert.equal(unauthorizedAcceptedRetry.status, 403, 'idempotency must not bypass requester authorization');
  });

  await t.test('秘书消息、在线心跳和跨用户任务委托闭环', async () => {
    const heartbeat = await ctx.api('/api/presence/heartbeat', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { deviceId: 'bob-mac', platform: 'darwin', arch: 'arm64', hostname: 'bob-device' },
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.ok, true);

    const directFileBytes = Buffer.from('DIRECT_MESSAGE_ATTACHMENT_OK\n', 'utf8');
    const directFileId = 'direct_message_attachment_contract';
    const directFileUpload = await ctx.raw(`/api/social/files/${directFileId}`, {
      method: 'PUT',
      headers: {
        ...authHeaders(alice.accessToken),
        'content-type': 'application/octet-stream',
        'x-janus-recipient-id': bob.user.id,
        'x-janus-filename': encodeURIComponent('私聊附件.md'),
        'x-janus-content-type': 'text/markdown',
        'x-janus-file-sha256': crypto.createHash('sha256').update(directFileBytes).digest('hex'),
      },
      body: directFileBytes,
    });
    assert.equal(directFileUpload.status, 201);
    const directAttachment = JSON.parse(directFileUpload.body.toString('utf8')).attachment;
    const directMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        clientMessageId: 'direct-message-idempotency-1',
        recipientId: bob.user.id,
        content: '请查看私聊附件。',
        metadata: { type: 'direct_message', attachments: [{ ...directAttachment, path: '/home/alice/private/direct.md' }] },
      },
    });
    assert.equal(directMessage.status, 201);
    assert.equal(directMessage.body.message.metadata.attachments[0].remote_file_id, directFileId);
    assert.equal(Object.hasOwn(directMessage.body.message.metadata.attachments[0], 'path'), false);
    const repeatedDirectMessage = await ctx.api('/api/social/messages', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: {
        clientMessageId: 'direct-message-idempotency-1',
        recipientId: bob.user.id,
        content: '请查看私聊附件。',
        metadata: { type: 'direct_message', attachments: [{ ...directAttachment, path: '/home/alice/private/direct.md' }] },
      },
    });
    assert.equal(repeatedDirectMessage.status, 200);
    assert.equal(repeatedDirectMessage.body.idempotent, true);
    assert.equal(repeatedDirectMessage.body.message.id, directMessage.body.message.id);
    const conflictingDirectMessage = await ctx.api('/api/social/messages', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: {
        clientMessageId: 'direct-message-idempotency-1', recipientId: bob.user.id,
        content: '同一消息 ID 不能替换为不同内容。',
      },
    });
    assert.equal(conflictingDirectMessage.status, 409);
    assert.equal(conflictingDirectMessage.body.error.code, 'social_message_idempotency_conflict');
    assert.equal(Number((await ctx.pool.query("SELECT count(*) AS count FROM social_messages WHERE id='direct-message-idempotency-1'")).rows[0].count), 1);
    const directRecipientDownload = await ctx.raw(`/api/social/files/${directFileId}`, { headers: authHeaders(bob.accessToken) });
    assert.equal(directRecipientDownload.status, 200);
    assert.deepEqual(directRecipientDownload.body, directFileBytes);
    const directOutsiderDownload = await ctx.raw(`/api/social/files/${directFileId}`, { headers: authHeaders(carol.accessToken) });
    assert.equal(directOutsiderDownload.status, 403);

    const message = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        senderAgentId: 'secretary_agent',
        recipientAgentId: 'secretary_agent',
        kind: 'agent',
        content: '请确认你是否可以参与。',
      },
    });
    assert.equal(message.status, 201);
    assert.equal(message.body.message.senderAgentId, 'secretary_agent');

    const bobMessages = await ctx.api('/api/social/messages', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(bobMessages.status, 200);
    assert.equal(bobMessages.body.items.some((item) => item.content.includes('参与')), true);

    const read = await ctx.api(`/api/social/messages/${message.body.message.id}/read`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.message.status, 'read');

    const taskGroupId = 'task-group-auth-check';
    const createdGroup = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'system',
        content: '创建了四方任务群聊。',
        metadata: { type: 'social_task_group', action: 'created', taskGroupId },
      },
    });
    assert.equal(createdGroup.status, 201);
    assert.equal(createdGroup.body.message.metadata.initiatorUserId, alice.user.id);
    const forbiddenRename = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: {
        recipientId: alice.user.id,
        kind: 'system',
        content: '尝试修改任务群聊名称。',
        metadata: { type: 'social_task_group', action: 'renamed', taskGroupId, groupTitle: '不应生效的名称' },
      },
    });
    assert.equal(forbiddenRename.status, 403);
    assert.equal(forbiddenRename.body.error.code, 'task_group_rename_forbidden');
    const renamedGroup = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'system',
        content: '修改任务群聊名称。',
        metadata: { type: 'social_task_group', action: 'renamed', taskGroupId, groupTitle: '实验协作群' },
      },
    });
    assert.equal(renamedGroup.status, 201);
    assert.equal(renamedGroup.body.message.metadata.groupTitle, '实验协作群');
    const historicalGroupMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'friend',
        content: '这条解散前的群聊消息应保留。',
        metadata: { type: 'social_task_group_message', taskGroupId },
      },
    });
    assert.equal(historicalGroupMessage.status, 201);
    const forbiddenDissolve = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: {
        recipientId: alice.user.id,
        kind: 'system',
        content: '尝试解散任务群聊。',
        metadata: { type: 'social_task_group', action: 'dissolved', taskGroupId },
      },
    });
    assert.equal(forbiddenDissolve.status, 403);
    assert.equal(forbiddenDissolve.body.error.code, 'task_group_dissolve_forbidden');
    const dissolvedGroup = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'system',
        content: '任务结束，解散四方任务群聊。',
        metadata: { type: 'social_task_group', action: 'dissolved', taskGroupId },
      },
    });
    assert.equal(dissolvedGroup.status, 201);
    const messageAfterDissolve = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'friend',
        content: '解散后不应发送。',
        metadata: { type: 'social_task_group_message', taskGroupId },
      },
    });
    assert.equal(messageAfterDissolve.status, 409);
    assert.equal(messageAfterDissolve.body.error.code, 'task_group_closed');
    const dissolvedHistory = await ctx.api(`/api/social/messages?peerId=${encodeURIComponent(bob.user.id)}`, {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(dissolvedHistory.status, 200);
    assert.equal(dissolvedHistory.body.items.some((item) => item.id === createdGroup.body.message.id), true);
    assert.equal(dissolvedHistory.body.items.some((item) => item.id === historicalGroupMessage.body.message.id), true);
    assert.equal(dissolvedHistory.body.items.some((item) => item.id === dissolvedGroup.body.message.id), true);

    const recallableDirectMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'friend',
        content: '这条自然人私聊消息将被撤回',
        metadata: { type: 'direct_message' },
      },
    });
    assert.equal(recallableDirectMessage.status, 201);
    const recalledDirectMessage = await ctx.api(`/api/social/messages/${recallableDirectMessage.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'withdraw' },
    });
    assert.equal(recalledDirectMessage.status, 200);
    assert.equal(recalledDirectMessage.body.message.metadata.withdrawn, true);
    assert.equal(recalledDirectMessage.body.message.content, '这条自然人私聊消息将被撤回');
    const recallByRecipient = await ctx.api(`/api/social/messages/${recallableDirectMessage.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { action: 'withdraw' },
    });
    assert.equal(recallByRecipient.status, 404);

    const nonRecallableAgentMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'agent',
        senderAgentId: 'secretary_agent',
        content: 'Agent 消息不可通过自然人撤回功能撤回',
        metadata: { type: 'direct_message' },
      },
    });
    assert.equal(nonRecallableAgentMessage.status, 201);
    const rejectedAgentRecall = await ctx.api(`/api/social/messages/${nonRecallableAgentMessage.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'withdraw' },
    });
    assert.equal(rejectedAgentRecall.status, 403);
    assert.equal(rejectedAgentRecall.body.error.code, 'message_update_forbidden');

    const expiredDirectMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        kind: 'friend',
        content: '这条自然人私聊消息已经超过撤回时间',
        metadata: { type: 'direct_message' },
      },
    });
    assert.equal(expiredDirectMessage.status, 201);
    await ctx.pool.query("UPDATE social_messages SET created_at = now() - interval '3 minutes' WHERE id = $1", [expiredDirectMessage.body.message.id]);
    const rejectedExpiredRecall = await ctx.api(`/api/social/messages/${expiredDirectMessage.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'withdraw' },
    });
    assert.equal(rejectedExpiredRecall.status, 409);
    assert.equal(rejectedExpiredRecall.body.error.code, 'message_withdraw_expired');

    const delegation = await ctx.api('/api/delegations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        title: '整理实验数据',
        instruction: '请整理实验数据并给出三点结论。',
        senderAgentId: 'secretary_agent',
        recipientAgentId: 'secretary_agent',
        metadata: { attachments: [{ name: '实验数据.xlsx', file_url: '/files/experiment.xlsx' }] },
      },
    });
    assert.equal(delegation.status, 201);
    assert.equal(delegation.body.delegation.status, 'assigned');
    assert.equal(delegation.body.message.metadata.attachments[0].name, '实验数据.xlsx');

    const comment = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        recipientId: bob.user.id,
        content: '请补充数据来源。',
        kind: 'agent',
        senderAgentId: 'secretary_agent',
        recipientAgentId: 'secretary_agent',
        metadata: { type: 'agent_delegation_comment', delegationId: delegation.body.delegation.id, processedByOwnUBuddy: true },
      },
    });
    assert.equal(comment.status, 201);
    const editedComment = await ctx.api(`/api/social/messages/${comment.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'edit', content: '请补充数据来源和统计口径。', metadata: { originalInput: '补充来源和口径' } },
    });
    assert.equal(editedComment.status, 200);
    assert.equal(editedComment.body.message.metadata.edited, true);
    assert.equal(editedComment.body.message.content, '请补充数据来源和统计口径。');
    const withdrawnComment = await ctx.api(`/api/social/messages/${comment.body.message.id}`, {
      method: 'PATCH',
      headers: authHeaders(alice.accessToken),
      body: { action: 'withdraw' },
    });
    assert.equal(withdrawnComment.status, 200);
    assert.equal(withdrawnComment.body.message.metadata.withdrawn, true);

    const incoming = await ctx.api('/api/delegations?direction=incoming', {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(incoming.status, 200);
    assert.equal(incoming.body.items.some((item) => item.id === delegation.body.delegation.id), true);

    const completed = await ctx.api(`/api/delegations/${delegation.body.delegation.id}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: {
        status: 'completed',
        sessionId: 'session-result',
        result: '已整理完成，共得到三点结论。',
        metadata: {
          attachments: [{ name: '三点结论.docx', file_url: '/files/result.docx' }],
          agentWorkStatusProjection: {
            version: 'agent_work_status_projection_v1', scopeKind: 'delegation', scopeId: delegation.body.delegation.id,
            updatedAt: '2026-08-04T10:00:00.000Z', actors: [{
              version: 'agent_work_status_projection_v1', projectionId: 'public-agent-a', actorKind: 'local_agent',
              actorLabel: '报告 Agent', ownerUserId: bob.user.id, agentId: 'report_agent', agentInstanceId: 'private-instance-a',
              delegationId: delegation.body.delegation.id, status: 'running', currentStage: 'executing',
              currentAction: '正在读取 /home/bob/private/report.md，token=secret-value',
              progress: { completed: 1, total: 2, percent: 99 }, visibility: 'owner_private',
              updatedAt: '2026-08-04T10:00:00.000Z',
            }],
          },
        },
      },
    });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.delegation.status, 'completed');
    assert.equal(completed.body.message.recipientUserId, alice.user.id);
    assert.equal(completed.body.message.metadata.attachments[0].name, '三点结论.docx');
    const publicWorkStatus = completed.body.delegation.metadata.agentWorkStatusProjection.actors[0];
    assert.equal(publicWorkStatus.visibility, 'participant_public');
    assert.equal(publicWorkStatus.ownerUserId, '');
    assert.equal(publicWorkStatus.agentInstanceId, '');
    assert.equal(publicWorkStatus.progress.percent, 50);
    assert.doesNotMatch(publicWorkStatus.currentAction, /\/home\/bob|secret-value/);
  });

  await t.test('拒绝/取消好友申请', async () => {
    const first = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: carol.user.id, message: 'One' },
    });
    assert.equal(first.status, 200);
    const carolOverview = await ctx.api('/api/friends', {
      headers: authHeaders(carol.accessToken),
    });
    const incomingId = carolOverview.body.requests.incoming[0].id;
    const reject = await ctx.api(`/api/friends/requests/${incomingId}/reject`, {
      method: 'POST',
      headers: authHeaders(carol.accessToken),
    });
    assert.equal(reject.status, 200);
    assert.equal(reject.body.overview.requests.incoming.length, 0);

    const second = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: carol.user.id, message: 'Two' },
    });
    assert.equal(second.status, 200);
    const cancel = await ctx.api(`/api/friends/requests/${second.body.requestId}/cancel`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.overview.requests.outgoing.length, 0);
  });

  await t.test('删除好友', async () => {
    const remove = await ctx.api(`/api/friends/${bob.user.id}`, {
      method: 'DELETE',
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(remove.status, 200);
    assert.equal(remove.body.overview.friends.length, 0);
  });

  await t.test('反向 pending 自动接受', async () => {
    const fromBob = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { userId: alice.user.id },
    });
    assert.equal(fromBob.status, 200);
    const autoAccept = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: bob.user.id },
    });
    assert.equal(autoAccept.status, 200);
    assert.equal(autoAccept.body.overview.friends.length, 1);
    await ctx.api(`/api/friends/${bob.user.id}`, {
      method: 'DELETE',
      headers: authHeaders(alice.accessToken),
    });
  });

  await t.test('组织号和邀请码支持创建、修改及加入组织', async () => {
    const created = await ctx.api('/api/organizations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { name: 'Cloud Test Organization', organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'cloud-code' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.organization.role, 'owner');
    assert.equal(created.body.organization.memberCount, 1);
    assert.equal(Object.hasOwn(created.body.organization, 'verificationCode'), false);
    const validatedInvitationCode = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'validate_invitation_code', verificationCode: 'cloud-code' },
    });
    assert.equal(validatedInvitationCode.status, 200);
    assert.equal(validatedInvitationCode.body.invitationCodeValid, true);
    const rejectedInvitationCode = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'validate_invitation_code', verificationCode: 'wrong-code' },
    });
    assert.equal(rejectedInvitationCode.status, 403);
    assert.equal(rejectedInvitationCode.body.error.code, 'organization_verification_code_invalid');

    const defaultNumber = await ctx.api('/api/organizations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { name: 'Default Number Organization', verificationCode: 'default-code' },
    });
    const nextDefaultNumber = await ctx.api('/api/organizations', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { name: 'Next Default Number Organization', verificationCode: 'default-code-two' },
    });
    assert.equal(defaultNumber.status, 201);
    assert.equal(nextDefaultNumber.status, 201);
    assert.equal(defaultNumber.body.organization.organizationNumber, 'ORG-0001');
    assert.equal(nextDefaultNumber.body.organization.organizationNumber, 'ORG-0002');

    const duplicate = await ctx.api('/api/organizations', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { name: 'Duplicate Organization', organizationNumber: 'cloud-org-2026', verificationCode: 'another-code' },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'organization_number_exists');

    const invalidSecret = await ctx.api('/api/organizations/join', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'wrong-code' },
    });
    assert.equal(invalidSecret.status, 403);
    assert.equal(invalidSecret.body.error.code, 'organization_verification_code_invalid');

    const joined = await ctx.api('/api/organizations/join', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { organizationNumber: 'cloud-org-2026', verificationCode: 'cloud-code' },
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.organization.memberCount, 2);
    assert.ok(joined.body.organization.members.some((item) => item.user.id === alice.user.id && item.role === 'owner'));
    assert.ok(joined.body.organization.members.some((item) => item.user.id === bob.user.id && item.role === 'member'));
    assert.equal(joined.body.overview.friends.some((item) => item.friend.id === alice.user.id), false, 'organization membership must not create a personal friendship');

    const organizationRemark = await ctx.api(`/api/friends/${alice.user.id}`, {
      method: 'PATCH',
      headers: authHeaders(bob.accessToken),
      body: { remark: '组织联系人 Alice' },
    });
    assert.equal(organizationRemark.status, 404);

    const contactRemark = await ctx.api(`/api/contacts/${alice.user.id}/remark`, {
      method: 'PATCH', headers: authHeaders(bob.accessToken), body: { remark: '组织联系人 Alice' },
    });
    assert.equal(contactRemark.status, 200);
    const remarkedAlice = contactRemark.body.overview.organizations.find((item) => item.id === created.body.organization.id)
      .members.find((item) => item.user.id === alice.user.id).user;
    assert.equal(remarkedAlice.remark, '组织联系人 Alice');

    const organizationDisplayName = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { action: 'set_display_name', displayName: '组织里的 Bob' },
    });
    assert.equal(organizationDisplayName.status, 200);
    const renamedBob = organizationDisplayName.body.overview.organizations.find((item) => item.id === created.body.organization.id)
      .members.find((item) => item.user.id === bob.user.id);
    assert.equal(renamedBob.displayNameOverride, '组织里的 Bob');
    assert.equal(renamedBob.user.displayName, '组织里的 Bob');

    const organizationWorkspaceId = `workspace_org_${created.body.organization.id}`;
    const organizationMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { workspaceId: organizationWorkspaceId, recipientId: alice.user.id, content: '组织联系人可以直接发送消息。' },
    });
    assert.equal(organizationMessage.status, 201);
    assert.equal(organizationMessage.body.message.workspaceId, organizationWorkspaceId);

    const personalMessages = await ctx.api(`/api/social/messages?peerId=${encodeURIComponent(alice.user.id)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(personalMessages.body.items.some((item) => item.content === '组织联系人可以直接发送消息。'), false);
    const organizationMessages = await ctx.api(`/api/social/messages?workspaceId=${encodeURIComponent(organizationWorkspaceId)}&peerId=${encodeURIComponent(alice.user.id)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(organizationMessages.body.items.some((item) => item.content === '组织联系人可以直接发送消息。'), true);

    const dave = await ctx.registerUser('dave@example.com', 'Dave');
    const daveRequest = await ctx.api('/api/friends/requests', {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { userId: dave.user.id, message: '外部联系人' },
    });
    assert.equal(daveRequest.status, 200);
    const daveOverview = await ctx.api('/api/friends', { headers: authHeaders(dave.accessToken) });
    const daveAccepted = await ctx.api(`/api/friends/requests/${daveOverview.body.requests.incoming[0].id}/accept`, {
      method: 'POST', headers: authHeaders(dave.accessToken),
    });
    assert.equal(daveAccepted.status, 200);
    const mixedContactGroup = await ctx.api('/api/chat-groups', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        workspaceId: organizationWorkspaceId,
        socialCapability: 'chat-groups-v2',
        groupId: 'chat_group_mixed_cloud_v2',
        clientRequestId: 'chat-group-mixed-cloud-v2-request',
        title: '组织内外联合讨论',
        memberIds: [bob.user.id, dave.user.id],
      },
    });
    assert.equal(mixedContactGroup.status, 201);
    assert.equal(mixedContactGroup.body.group.audienceScope, 'account_social');
    assert.equal(mixedContactGroup.body.members.length, 3);
    const accountGlobalGroups = await ctx.api('/api/chat-groups?capability=chat-groups-v2', { headers: authHeaders(alice.accessToken) });
    assert.equal(accountGlobalGroups.status, 200);
    assert.equal(accountGlobalGroups.body.groups.some((item) => item.id === 'chat_group_mixed_cloud_v2'), true);
    const legacyPersonalGroups = await ctx.api('/api/chat-groups', { headers: authHeaders(alice.accessToken) });
    assert.equal(legacyPersonalGroups.body.groups.some((item) => item.id === 'chat_group_mixed_cloud_v2'), false,
      'v1 clients must retain workspace-scoped overview behavior');

    const outsiderMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(carol.accessToken),
      body: { workspaceId: organizationWorkspaceId, recipientId: alice.user.id, content: '不应发送成功。' },
    });
    assert.equal(outsiderMessage.status, 403);

    const organizationSessionId = 'organization_workspace_session';
    const organizationSession = await ctx.api(`/api/sessions/${organizationSessionId}`, {
      method: 'PUT',
      headers: authHeaders(bob.accessToken),
      body: { workspaceId: organizationWorkspaceId, title: '组织空间会话', departmentId: '', agentId: 'secretary_agent' },
    });
    assert.equal(organizationSession.status, 200);
    assert.equal(organizationSession.body.session.workspaceId, organizationWorkspaceId);
    const personalSessions = await ctx.api('/api/sessions', { headers: authHeaders(bob.accessToken) });
    assert.equal(personalSessions.body.items.some((item) => item.id === organizationSessionId), false);
    const organizationSessions = await ctx.api(`/api/sessions?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(organizationSessions.body.items.some((item) => item.id === organizationSessionId), true);

    const personalDelegationRejected = await ctx.api('/api/delegations', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { recipientId: alice.user.id, title: '不应跨空间', instruction: '个人空间中双方不是好友。' },
    });
    assert.equal(personalDelegationRejected.status, 403);

    const organizationDelegation = await ctx.api('/api/delegations', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: {
        workspaceId: organizationWorkspaceId,
        recipientId: alice.user.id,
        title: '组织空间委托',
        instruction: '仅在当前组织 Workspace 中可见。',
      },
    });
    assert.equal(organizationDelegation.status, 201);
    assert.equal(organizationDelegation.body.delegation.workspaceId, organizationWorkspaceId);
    const organizationDelegationId = organizationDelegation.body.delegation.id;

    const personalDelegations = await ctx.api('/api/delegations?direction=all', { headers: authHeaders(bob.accessToken) });
    assert.equal(personalDelegations.body.items.some((item) => item.id === organizationDelegationId), false);
    const organizationDelegations = await ctx.api(`/api/delegations?workspaceId=${encodeURIComponent(organizationWorkspaceId)}&direction=all`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(organizationDelegations.status, 200);
    assert.equal(organizationDelegations.body.items.some((item) => item.id === organizationDelegationId), true);

    const organizationGroup = await ctx.api('/api/collaboration/groups', {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: {
        workspaceId: organizationWorkspaceId,
        title: '组织空间任务群',
        clientRequestId: 'organization-workspace-group-contract',
        assignments: [{ recipientId: alice.user.id, title: '组织任务', instruction: '验证组织任务群隔离。' }],
      },
    });
    assert.equal(organizationGroup.status, 201);
    assert.equal(organizationGroup.body.group.workspaceId, organizationWorkspaceId);
    const organizationGroupId = organizationGroup.body.group.id;
    const personalCollaboration = await ctx.api('/api/collaboration', { headers: authHeaders(bob.accessToken) });
    assert.equal(personalCollaboration.body.groups.some((item) => item.id === organizationGroupId), false);
    const organizationCollaboration = await ctx.api(`/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(organizationCollaboration.status, 200);
    assert.equal(organizationCollaboration.body.groups.some((item) => item.id === organizationGroupId), true);
    const outsiderCollaboration = await ctx.api(`/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, {
      headers: authHeaders(carol.accessToken),
    });
    assert.equal(outsiderCollaboration.status, 403);

    const overview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
    assert.equal(overview.status, 200);
    const joinedOrganization = overview.body.organizations.find((item) => item.organizationNumber === 'CLOUD-ORG-2026');
    assert.equal(joinedOrganization.memberCount, 2);
    assert.equal(overview.body.friends.some((item) => item.friend.id === bob.user.id), false);

    const wrongPassword = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'promote_admin', targetUserId: bob.user.id, verificationCode: 'cloud-code', accountPassword: 'wrong-password' },
    });
    assert.equal(wrongPassword.status, 403);
    assert.equal(wrongPassword.body.error.code, 'account_password_invalid');
    const promoted = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: {
        action: 'promote_admin', targetUserId: bob.user.id,
        verificationCode: 'cloud-code', accountPassword: 'changed-strong-password',
        rememberSecondaryVerification: true,
      },
    });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.secondaryVerificationRemembered, true);
    assert.match(promoted.body.secondaryVerificationGrant, /^[^.]+\.[^.]+\.[^.]+$/);
    assert.equal(promoted.body.overview.organizations.find((item) => item.id === created.body.organization.id).members.find((item) => item.user.id === bob.user.id).role, 'admin');
    const revoked = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'revoke_admin', targetUserId: bob.user.id, secondaryVerificationGrant: promoted.body.secondaryVerificationGrant },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.secondaryVerificationRemembered, true);
    assert.equal(revoked.body.overview.organizations.find((item) => item.id === created.body.organization.id).members.find((item) => item.user.id === bob.user.id).role, 'member');
    const promotedAgain = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'promote_admin', targetUserId: bob.user.id, secondaryVerificationGrant: promoted.body.secondaryVerificationGrant },
    });
    assert.equal(promotedAgain.status, 200);

    const selfMessage = await ctx.api('/api/social/messages', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { recipientId: alice.user.id, content: '云端文件传输记录', metadata: { type: 'direct_message' } },
    });
    assert.equal(selfMessage.status, 201);
    assert.equal(selfMessage.body.message.status, 'read');
    const selfHistory = await ctx.api(`/api/social/messages?peerId=${encodeURIComponent(alice.user.id)}`, { headers: authHeaders(alice.accessToken) });
    assert.equal(selfHistory.body.items.filter((item) => item.content === '云端文件传输记录').length, 1);

    const requestedExit = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(bob.accessToken),
      body: { action: 'request_exit' },
    });
    assert.equal(requestedExit.status, 200);
    const ownerOverview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
    const request = ownerOverview.body.organizationExitRequests.find((item) => item.id === requestedExit.body.requestId);
    assert.equal(request.canResolve, true);
    const resolvedExit = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { action: 'resolve_exit', requestId: request.id, decision: 'approve', verificationCode: 'cloud-code', accountPassword: 'changed-strong-password' },
    });
    assert.equal(resolvedExit.status, 200);
    const bobOverview = await ctx.api('/api/friends', { headers: authHeaders(bob.accessToken) });
    assert.equal(bobOverview.body.organizations.some((item) => item.id === created.body.organization.id), false);
    const approvedExitNotice = bobOverview.body.organizationNotices.find((item) => item.type === 'exit_approved');
    assert.ok(approvedExitNotice);
    const acknowledgedExitNotice = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { action: 'acknowledge_notice', noticeId: approvedExitNotice.id },
    });
    assert.equal(acknowledgedExitNotice.status, 200);
    assert.equal(acknowledgedExitNotice.body.overview.organizationNotices.find((item) => item.id === approvedExitNotice.id)?.read, true);
    const delegationAfterExit = await ctx.api(`/api/delegations/${organizationDelegationId}/workspace?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(delegationAfterExit.status, 403);
    const collaborationAfterExit = await ctx.api(`/api/collaboration/groups/${organizationGroupId}?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, {
      headers: authHeaders(bob.accessToken),
    });
    assert.equal(collaborationAfterExit.status, 403);

    await ctx.api('/api/organizations/join', {
      method: 'POST', headers: authHeaders(bob.accessToken), body: { organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'cloud-code' },
    });
    const invalidRetainAdmin = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'transfer_owner', targetUserId: bob.user.id, retainAdmin: 'false', verificationCode: 'cloud-code', accountPassword: 'changed-strong-password' },
    });
    assert.equal(invalidRetainAdmin.status, 400);
    assert.equal(invalidRetainAdmin.body.error.code, 'organization_retain_admin_invalid');
    const transfer = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'transfer_owner', targetUserId: bob.user.id, verificationCode: 'cloud-code', accountPassword: 'changed-strong-password' },
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.body.retainedAdmin, true);
    assert.equal(transfer.body.previousOwnerRole, 'admin');
    assert.equal(transfer.body.overview.organizations.find((item) => item.id === created.body.organization.id).role, 'admin');
    const bobAsOwner = await ctx.api('/api/friends', { headers: authHeaders(bob.accessToken) });
    assert.equal(bobAsOwner.body.organizations.find((item) => item.id === created.body.organization.id).role, 'owner');
    assert.ok(bobAsOwner.body.organizationNotices.some((item) => item.type === 'owner_transferred'));
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2`, [organizationWorkspaceId, alice.user.id]), { role: 'admin', status: 'active' });
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_memberships_v8
      WHERE account_id=$1 AND user_id=$2`, [`account_org_${created.body.organization.id}`, alice.user.id]), { role: 'admin', status: 'active' });
    const transferBack = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(bob.accessToken), body: { action: 'transfer_owner', targetUserId: alice.user.id, retainAdmin: false, verificationCode: 'cloud-code', accountPassword: 'bob-password' },
    });
    assert.equal(transferBack.status, 200);
    assert.equal(transferBack.body.retainedAdmin, false);
    assert.equal(transferBack.body.previousOwnerRole, 'member');
    assert.equal(transferBack.body.overview.organizations.find((item) => item.id === created.body.organization.id).role, 'member');
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2`, [organizationWorkspaceId, bob.user.id]), { role: 'member', status: 'active' });
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_memberships_v8
      WHERE account_id=$1 AND user_id=$2`, [`account_org_${created.body.organization.id}`, bob.user.id]), { role: 'member', status: 'active' });
    const ownerRows = await ctx.one(`SELECT count(*)::int AS count FROM contact_organization_members
      WHERE organization_id=$1 AND role='owner'`, [created.body.organization.id]);
    assert.equal(Number(ownerRows.count), 1);
    const nonOwnerUpdate = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(bob.accessToken),
      body: { action: 'update_invitation_code', verificationCode: 'cloud-code', newInvitationCode: 'cloud-code-v2', accountPassword: 'bob-password' },
    });
    assert.equal(nonOwnerUpdate.status, 403);
    assert.equal(nonOwnerUpdate.body.error.code, 'organization_owner_required');
    const invitationCodeUpdate = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: { action: 'update_invitation_code', verificationCode: 'cloud-code', newInvitationCode: 'cloud-code-v2', accountPassword: 'changed-strong-password' },
    });
    assert.equal(invitationCodeUpdate.status, 200);
    assert.equal(invitationCodeUpdate.body.invitationCodeUpdated, true);
    const resetInvitationEmail = await ctx.api('/api/auth/email-code', {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: { email: 'alice@example.com', purpose: 'organization_invitation_reset' },
    });
    assert.equal(resetInvitationEmail.status, 200);
    const invitationCodeReset = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: {
        action: 'reset_invitation_code',
        emailCode: ctx.lastCode('alice@example.com', 'organization_invitation_reset').code,
        newInvitationCode: 'cloud-code-v3',
      },
    });
    assert.equal(invitationCodeReset.status, 200);
    assert.equal(invitationCodeReset.body.invitationCodeReset, true);
    const oldInvitationCode = await ctx.api('/api/organizations/join', {
      method: 'POST', headers: authHeaders(carol.accessToken),
      body: { organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'cloud-code' },
    });
    assert.equal(oldInvitationCode.status, 403);
    assert.equal(oldInvitationCode.body.error.code, 'organization_verification_code_invalid');
    const supersededInvitationCode = await ctx.api('/api/organizations/join', {
      method: 'POST', headers: authHeaders(carol.accessToken),
      body: { organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'cloud-code-v2' },
    });
    assert.equal(supersededInvitationCode.status, 403);
    const newInvitationCode = await ctx.api('/api/organizations/join', {
      method: 'POST', headers: authHeaders(carol.accessToken),
      body: { organizationNumber: 'CLOUD-ORG-2026', verificationCode: 'cloud-code-v3' },
    });
    assert.equal(newInvitationCode.status, 200);
    const removedMember = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken),
      body: { action: 'remove_member', targetUserId: carol.user.id, verificationCode: 'cloud-code-v3', accountPassword: 'changed-strong-password' },
    });
    assert.equal(removedMember.status, 200);
    assert.equal(removedMember.body.overview.organizations.find((item) => item.id === created.body.organization.id).members.some((item) => item.user.id === carol.user.id), false);
    const removedMemberOverview = await ctx.api('/api/friends', { headers: authHeaders(carol.accessToken) });
    assert.equal(removedMemberOverview.body.organizations.some((item) => item.id === created.body.organization.id), false);
    assert.ok(removedMemberOverview.body.organizationNotices.some((item) => item.type === 'member_removed'));
    const dissolved = await ctx.api(`/api/organizations/${defaultNumber.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'owner_exit', mode: 'dissolve', verificationCode: 'default-code', accountPassword: 'changed-strong-password' },
    });
    assert.equal(dissolved.status, 200);
    assert.equal(dissolved.body.dissolved, true);
    const ownerExit = await ctx.api(`/api/organizations/${created.body.organization.id}/actions`, {
      method: 'POST', headers: authHeaders(alice.accessToken), body: { action: 'owner_exit', mode: 'auto', retainAdmin: true, verificationCode: 'cloud-code-v3', accountPassword: 'changed-strong-password' },
    });
    assert.equal(ownerExit.status, 200);
    assert.equal(ownerExit.body.exited, true);
    assert.equal(ownerExit.body.retainedAdmin, false);
    assert.equal((await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) })).body.organizations.some((item) => item.id === created.body.organization.id), false);
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_workspace_memberships
      WHERE workspace_id=$1 AND user_id=$2`, [organizationWorkspaceId, alice.user.id]), { role: 'member', status: 'left' });
    assert.deepEqual(await ctx.one(`SELECT role,status FROM account_memberships_v8
      WHERE account_id=$1 AND user_id=$2`, [`account_org_${created.body.organization.id}`, alice.user.id]), { role: 'member', status: 'left' });
  });

  await t.test('拉黑后不能搜索和申请', async () => {
    const block = await ctx.api('/api/friends/block', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: carol.user.id },
    });
    assert.equal(block.status, 200);
    assert.equal(block.body.ok, true);

    const search = await ctx.api('/api/friends/search?q=carol&limit=20', {
      headers: authHeaders(alice.accessToken),
    });
    assert.equal(search.status, 200);
    assert.deepEqual(search.body.items, []);

    const send = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(alice.accessToken),
      body: { userId: carol.user.id },
    });
    assert.equal(send.status, 403);
    assert.equal(send.body.error.code, 'blocked_user');

    const reverseSend = await ctx.api('/api/friends/requests', {
      method: 'POST',
      headers: authHeaders(carol.accessToken),
      body: { userId: alice.user.id },
    });
    assert.equal(reverseSend.status, 403);
    assert.equal(reverseSend.body.error.code, 'blocked_user');
  });
});

test('public uBuddy capability profiles enforce capability, access, history, and idempotency', async (t) => {
  const ctx = await createTestContext();
  t.after(async () => ctx.close());
  const alice = await ctx.registerUser('profile-alice@example.com', 'ProfileAlice');
  const bob = await ctx.registerUser('profile-bob@example.com', 'ProfileBob');
  const profile = capabilityProfile(alice.user.id, 1, '擅长研究、报告与任务协调。');
  const missingCapability = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken), body: { commandId: 'profile-command-1', profile },
  });
  assert.equal(missingCapability.status, 426);
  const published = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-1', socialCapability: 'ubuddy-capability-profile-v1', profile },
  });
  assert.equal(published.status, 200);
  assert.equal(published.body.item.profile.ownerUserId, alice.user.id);
  const replay = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-1', socialCapability: 'ubuddy-capability-profile-v1', profile },
  });
  assert.deepEqual(replay.body, published.body);
  const hidden = await ctx.api('/api/social/ubuddy-profiles/query', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { socialCapability: 'ubuddy-capability-profile-v1', userIds: [alice.user.id] },
  });
  assert.deepEqual(hidden.body.profiles, []);
  assert.deepEqual(hidden.body.unavailableUserIds, [alice.user.id]);
  const organizationProfile = { ...profile, visibility: 'organization' };
  const organizationPublish = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-org', socialCapability: 'ubuddy-capability-profile-v1',
      expectedStateRevision: published.body.stateRevision, profile: { ...organizationProfile, profileRevision: 2 } },
  });
  assert.equal(organizationPublish.status, 200);
  const organization = await ctx.api('/api/organizations', {
    method: 'POST', headers: authHeaders(alice.accessToken),
    body: { name: 'Profile Organization', organizationNumber: 'PROFILE-ORG-2026', verificationCode: 'profile-code' },
  });
  await ctx.api('/api/organizations/join', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { organizationNumber: 'PROFILE-ORG-2026', verificationCode: 'profile-code' },
  });
  const organizationVisible = await ctx.api('/api/social/ubuddy-profiles/query', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { socialCapability: 'ubuddy-capability-profile-v1', userIds: [alice.user.id] },
  });
  assert.equal(organizationVisible.body.profiles[0].accessScope, 'organization');
  await ctx.api(`/api/organizations/${organization.body.organization.id}/actions`, {
    method: 'POST', headers: authHeaders(alice.accessToken),
    body: { action: 'remove_member', targetUserId: bob.user.id, verificationCode: 'profile-code', accountPassword: 'profilealice-password' },
  });
  const removedOrganizationAccess = await ctx.api('/api/social/ubuddy-profiles/query', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { socialCapability: 'ubuddy-capability-profile-v1', userIds: [alice.user.id] },
  });
  assert.deepEqual(removedOrganizationAccess.body.profiles, []);
  const request = await ctx.api('/api/friends/requests', {
    method: 'POST', headers: authHeaders(bob.accessToken), body: { userId: alice.user.id },
  });
  const overview = await ctx.api('/api/friends', { headers: authHeaders(alice.accessToken) });
  const incoming = overview.body.requests.incoming.find((item) => item.id === request.body.requestId);
  await ctx.api(`/api/friends/requests/${incoming.id}/accept`, { method: 'POST', headers: authHeaders(alice.accessToken) });
  const visible = await ctx.api('/api/social/ubuddy-profiles/query', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { socialCapability: 'ubuddy-capability-profile-v1', userIds: [alice.user.id] },
  });
  assert.equal(visible.body.profiles[0].accessScope, 'friends');
  assert.equal(visible.body.profiles[0].profile.evidenceSummary, '仅包含公开能力概述');
  const revisionConflict = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-conflict', socialCapability: 'ubuddy-capability-profile-v1',
      profile: capabilityProfile(alice.user.id, 2, '同一版本的不同内容。') },
  });
  assert.equal(revisionConflict.status, 409);
  assert.equal(revisionConflict.body.error.code, 'ubuddy_profile_revision_conflict');
  const second = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-2', socialCapability: 'ubuddy-capability-profile-v1',
      expectedStateRevision: organizationPublish.body.stateRevision, profile: capabilityProfile(alice.user.id, 3, '新增数据分析与代码交付能力。') },
  });
  assert.equal(second.status, 200);
  const revisions = await ctx.pool.query(`SELECT publication_state,count(*)::int AS count
    FROM social_ubuddy_capability_profiles WHERE owner_user_id=$1 GROUP BY publication_state`, [alice.user.id]);
  assert.deepEqual(Object.fromEntries(revisions.rows.map((row) => [row.publication_state, Number(row.count)])), { active: 1, archived: 2 });
  await ctx.api('/api/friends/block', {
    method: 'POST', headers: authHeaders(bob.accessToken), body: { userId: alice.user.id },
  });
  const blocked = await ctx.api('/api/social/ubuddy-profiles/query', {
    method: 'POST', headers: authHeaders(bob.accessToken),
    body: { socialCapability: 'ubuddy-capability-profile-v1', userIds: [alice.user.id] },
  });
  assert.deepEqual(blocked.body, { profiles: [], unavailableUserIds: [alice.user.id] });
  const unpublished = await ctx.api('/api/social/ubuddy-profile/unpublish', {
    method: 'POST', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-unpublish', socialCapability: 'ubuddy-capability-profile-v1',
      expectedStateRevision: second.body.stateRevision },
  });
  assert.equal(unpublished.status, 200);
  assert.equal(unpublished.body.stateRevision, second.body.stateRevision + 1);
  const republished = await ctx.api('/api/social/ubuddy-profile', {
    method: 'PUT', headers: authHeaders(alice.accessToken),
    body: { commandId: 'profile-command-3', socialCapability: 'ubuddy-capability-profile-v1',
      expectedStateRevision: unpublished.body.stateRevision,
      profile: capabilityProfile(alice.user.id, 4, '撤回后发布的新版本。') },
  });
  assert.equal(republished.status, 200);
  assert.equal(republished.body.stateRevision, unpublished.body.stateRevision + 1);
});

async function createTestContext() {
  const db = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  db.public.registerFunction({ name: 'decode', args: [DataType.text, DataType.text], returns: DataType.bytea,
    implementation: (value, format) => Buffer.from(String(value || ''), String(format || 'base64')) });
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const sentCodes = [];
  const providerKeyApplications = [];
  const providerKeyDecisions = [];
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-large-files-'));
  await migrate(pool);
  const app = createApp({
    pool,
    config: {
      ...config,
      providerKeyApplicationEmail: 'provider-access@example.com',
      providerKeyDistributionBaseUrl: 'https://provider.fixture.example/v1',
      providerKeyDistributionKey: 'shared-provider-key-fixture',
      providerKeyDistributionModel: 'gpt-5.6-sol',
      env: { ...process.env, JANUS_FILE_STORAGE_ROOT: storageRoot },
    },
    mailer: {
      async sendEmailCode(payload) {
        if (payload.email === 'missing-mailbox@example.com') {
          const error = new Error('550 5.1.1 User unknown');
          error.responseCode = 550;
          throw error;
        }
        sentCodes.push(payload);
      },
      async sendProviderKeyApplication(payload) {
        providerKeyApplications.push(payload);
      },
      async sendProviderKeyDecision(payload) {
        providerKeyDecisions.push(payload);
      },
    },
  });
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    sentCodes,
    providerKeyApplications,
    providerKeyDecisions,
    lastCode(email, purpose) {
      const found = sentCodes.filter((item) => item.email === email && item.purpose === purpose).at(-1);
      assert.ok(found, `expected code for ${purpose}:${email}`);
      return found;
    },
    async api(path, options = {}) {
      const headers = {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      };
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const body = await response.json();
      return { status: response.status, body };
    },
    async raw(path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
      });
      return {
        status: response.status,
        headers: response.headers,
        body: Buffer.from(await response.arrayBuffer()),
      };
    },
    async one(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows[0] || null;
    },
    async registerUser(email, displayName) {
      const codeResponse = await this.api('/api/auth/email-code', {
        method: 'POST',
        body: { email, purpose: 'register' },
      });
      assert.equal(codeResponse.status, 200);
      const response = await this.api('/api/auth/register', {
        method: 'POST',
        body: {
          email,
          code: this.lastCode(email, 'register').code,
          password: `${displayName.toLowerCase()}-password`,
          displayName,
        },
      });
      assert.equal(response.status, 200);
      return response.body;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      fs.rmSync(storageRoot, { recursive: true, force: true });
    },
  };
}

function authHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

function capabilityProfile(ownerUserId, profileRevision, introduction) {
  return {
    version: 'ubuddy_capability_profile_v1', ownerUserId, uBuddyAgentInstanceId: 'ubuddy-profile-agent',
    profileRevision, introduction, supportedTaskTypes: ['research', 'coordination'],
    deliverableTypes: ['report', 'document'], capabilityTags: ['研究', '协作'], preferredTasks: ['结构化任务'],
    unsupportedTasks: ['需要线下签字的任务'], collaborationModes: ['direct'], privacyConstraints: ['不公开私聊内容'],
    evidenceSummary: '仅包含公开能力概述', sourceEffectiveSkillHash: 'skill-hash-profile', visibility: 'friends',
    publicationState: 'active', generatedAt: '2026-08-03T00:00:00.000Z', approvedAt: '2026-08-03T00:01:00.000Z',
  };
}
