import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-friend-remark-'));
const previousAuthUrl = process.env.JANUS_AUTH_URL;
process.env.JANUS_AUTH_URL = '';
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true });
  const alice = runtime.authRegister({ email: 'alice.remark@example.com', password: 'alice-password', displayName: 'Alice' });
  const bob = runtime.authRegister({ email: 'bob.remark@example.com', password: 'bob-password', displayName: 'Bob' });

  runtime.friendSendRequest({ userId: alice.id, message: 'remark check' });
  runtime.authLogin({ identifier: 'alice.remark@example.com', password: 'alice-password' });
  const incoming = runtime.friendsOverview().requests.incoming[0];
  runtime.friendAcceptRequest({ requestId: incoming.id });

  const remarked = runtime.friendUpdateRemark({ userId: bob.id, remark: '项目协作人 Bob' });
  assert.equal(remarked.overview.friends[0].remark, '项目协作人 Bob');
  assert.equal(remarked.overview.friends[0].friend.remark, '项目协作人 Bob');

  const created = await runtime.dispatchCollaborationCommand({
    content: '创建任务：@Bob 负责验证群名修改权限。',
    sourcePeerId: bob.id,
    sourceConversationId: `direct:${alice.id}:${bob.id}`,
    sourceMessageId: 'remark-group-command',
    mentions: [{ principalType: 'user', userId: bob.id, displayText: '@Bob', mentionId: 'remark_group_bob', source: 'picker' }],
  });
  assert.equal(created.dispatched, true);
  const renamed = await runtime.updateCollaborationGroup({ groupId: created.group.id, action: 'rename', title: '群主修改后的名称' });
  assert.equal(renamed.group.title, '群主修改后的名称');

  const charlie = runtime.authRegister({ email: 'charlie.labels@example.com', password: 'charlie-password', displayName: 'Charlie' });
  runtime.authLogin({ identifier: 'alice.remark@example.com', password: 'alice-password' });
  const organization = runtime.organizationCreate({
    name: '联系人标签测试组织', organizationNumber: 'CONTACT-LABELS-2026', verificationCode: 'contact-label-code',
  }).organization;
  runtime.authLogin({ identifier: 'charlie.labels@example.com', password: 'charlie-password' });
  runtime.organizationJoin({ organizationNumber: organization.organizationNumber, verificationCode: 'contact-label-code' });
  const organizationDisplay = await runtime.organizationAction({
    organizationId: organization.id, action: 'set_display_name', displayName: '组织里的 Charlie',
  });
  const charlieMembership = organizationDisplay.overview.organizations.find((item) => item.id === organization.id)
    ?.members.find((item) => item.user.id === charlie.id);
  assert.equal(charlieMembership?.displayNameOverride, '组织里的 Charlie');
  assert.equal(charlieMembership?.user.displayName, '组织里的 Charlie');

  await runtime.switchAccountWorkspace({ workspaceId: `workspace_org_${organization.id}` });
  const naturalGroup = await runtime.createChatGroup({
    title: '组织联系人群', memberIds: [alice.id], clientRequestId: 'contact-label-natural-group',
  });
  const naturalNamed = await runtime.updateChatGroup({
    groupId: naturalGroup.group.id, action: 'set_display_name', displayName: '群里的 Charlie', clientRequestId: 'charlie-group-name',
  });
  assert.equal(naturalNamed.members.find((item) => item.userId === charlie.id)?.displayNameOverride, '群里的 Charlie');

  runtime.authLogin({ identifier: 'alice.remark@example.com', password: 'alice-password' });
  await runtime.switchAccountWorkspace({ workspaceId: `workspace_org_${organization.id}` });
  const organizationRemark = runtime.friendUpdateRemark({ userId: charlie.id, remark: '组织项目联系人' });
  const visibleCharlie = organizationRemark.overview.organizations.find((item) => item.id === organization.id)
    ?.members.find((item) => item.user.id === charlie.id)?.user;
  assert.equal(visibleCharlie?.remark, '组织项目联系人', 'organization-only contacts must support private remarks');
  assert.equal(visibleCharlie?.displayName, '组织里的 Charlie', 'private remarks must not overwrite the public organization display name');

  runtime.authLogin({ identifier: 'bob.remark@example.com', password: 'bob-password' });
  assert.equal(runtime.friendsOverview().friends[0].remark, '', 'the other user must not inherit Alice’s private remark');
  const workGroupNamed = await runtime.updateCollaborationGroup({
    groupId: created.group.id, action: 'set_display_name', displayName: '工作群里的 Bob',
  });
  assert.equal(workGroupNamed.members.find((item) => item.userId === bob.id)?.displayNameOverride, '工作群里的 Bob');
  assert.throws(
    () => runtime.updateCollaborationGroup({ groupId: created.group.id, action: 'rename', title: '成员尝试修改' }),
    /只有任务群发起人/,
  );

  console.log('friend remark and group rename checks passed.');
} finally {
  runtime?.close?.();
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  await rm(root, { recursive: true, force: true });
}
