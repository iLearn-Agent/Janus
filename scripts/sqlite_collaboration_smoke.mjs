import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer, openCloudDatabase } from '../src/cloud/server.js';

verifyLegacyWorkspaceMigration();
verifyLegacyCollaborationFileMigration();

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-sqlite-collaboration-'));
const cloud = createCloudServer({ home, token: 'smoke-admin-token', syncToken: 'smoke-sync-token' });
let baseUrl = '';

try {
  seedUser('alice', 'Alice', 'alice-token');
  seedUser('bob', 'Bob', 'bob-token');
  seedUser('carol', 'Carol', 'carol-token');
  seedUser('dave', 'Dave', 'dave-token');
  seedFriendship('alice', 'bob');
  seedFriendship('alice', 'carol');

  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://${address.host}:${address.port}`;

  const empty = await api('alice-token', 'GET', '/api/collaboration');
  assert.deepEqual(empty, { groups: [], tasks: [] });

  const directCreated = await api('alice-token', 'POST', '/api/delegations', {
    recipientId: 'bob', title: '一对一文件交付验证', instruction: '生成一份可以下载的交付文件。',
  }, 201);
  const directDelegationId = directCreated.delegation.id;
  await api('bob-token', 'POST', `/api/collaboration/tasks/${directDelegationId}/action`, {
    action: 'working', expectedStatus: 'assigned',
  });
  const directFileBytes = Buffer.from('SQLITE_DIRECT_DELEGATION_FILE_OK\n', 'utf8');
  const directFileId = 'sqlite_direct_delegation_file';
  const directFileUpload = await rawApi('bob-token', 'PUT', `/api/collaboration/tasks/${directDelegationId}/files/${directFileId}`, directFileBytes, 201, {
    'content-type': 'application/octet-stream',
    'x-janus-social-capability': 'direct-delegation-files-v1',
    'x-janus-filename': encodeURIComponent('直接交付.md'),
    'x-janus-content-type': 'text/markdown',
    'x-janus-file-sha256': crypto.createHash('sha256').update(directFileBytes).digest('hex'),
  });
  const directAttachment = JSON.parse(directFileUpload.body.toString('utf8')).attachment;
  assert.equal(directAttachment.remote_file_kind, 'collaboration_task');
  assert.equal(directAttachment.group_id, '');
  await api('bob-token', 'POST', `/api/collaboration/tasks/${directDelegationId}/action`, {
    action: 'submit', content: '无效附件不能推进状态。',
    metadata: { attachments: [{ remote_file_id: 'not_the_direct_file', remote_file_kind: 'collaboration_task' }] },
  }, 400);
  assert.equal((await api('bob-token', 'GET', '/api/collaboration')).tasks.find((task) => task.id === directDelegationId).status, 'working');
  await rawApi('dave-token', 'GET', `/api/collaboration/files/${directFileId}`, undefined, 403);
  const directSubmitted = await api('bob-token', 'POST', `/api/collaboration/tasks/${directDelegationId}/action`, {
    action: 'submit', expectedStatus: 'working', content: '一对一任务文件已完成。',
    metadata: { attachments: [{ ...directAttachment, path: '/home/bob/private/direct.md' }] },
  });
  assert.equal(directSubmitted.delegation.status, 'submitted');
  assert.equal(directSubmitted.delegation.metadata.attachments[0].remote_file_kind, 'collaboration_task');
  assert.equal(Object.hasOwn(directSubmitted.delegation.metadata.attachments[0], 'path'), false);
  assert.deepEqual((await rawApi('alice-token', 'GET', `/api/collaboration/files/${directFileId}`)).body, directFileBytes);
  assert.deepEqual((await rawApi('bob-token', 'GET', `/api/collaboration/files/${directFileId}`)).body, directFileBytes);

  const request = {
    title: '多人 uBuddy 协作验证',
    clientRequestId: 'sqlite-collaboration-smoke-v1',
    metadata: {
      source: 'smoke',
      taskSummary: {
        version: 1,
        objective: '形成多人协作的完整工作复盘',
        deliverables: ['复盘报告'],
        acceptanceCriteria: ['覆盖工作、风险和下一步'],
        constraints: ['公开信息范围内协作'],
        deadline: '2026-08-20',
      },
    },
    assignments: [
      {
        recipientId: 'bob',
        title: '汇报近期工作',
        instruction: '汇报近期工作、风险和下一步，并制作流程图。',
        metadata: { preliminaryResult: 'Bob 私有初稿', intakeSummary: 'Bob 私有整理结果' },
      },
      {
        recipientId: 'carol',
        title: '复核工作流程',
        instruction: '复核流程图并列出改进建议。',
      },
    ],
  };
  const created = await api('alice-token', 'POST', '/api/collaboration/groups', request, 201);
  assert.equal(created.group.status, 'active');
  assert.equal(created.group.memberCount, 3);
  assert.equal(created.tasks.length, 2);
  assert.equal(created.tasks.some((task) => task.metadata.preliminaryResult), false, 'requester must not receive recipient private draft');
  const groupId = created.group.id;
  const bobTask = created.tasks.find((task) => task.recipientUserId === 'bob');
  assert.ok(groupId);
  assert.ok(bobTask?.id);
  assert.equal(created.workspace.id, groupId);
  assert.equal(created.workspace.scope, 'collaboration_group');

  const initialSharedWorkspace = await api('bob-token', 'GET', `/api/collaboration/groups/${groupId}/workspace`);
  assert.equal(initialSharedWorkspace.workspace.id, groupId);
  assert.equal(initialSharedWorkspace.workspace.revision, 0);
  const sharedFileId = 'group_workspace_shared_report';
  const sharedFilePath = 'deliverables/shared-report.md';
  const sharedFileV1 = Buffer.from('# Shared report\n\nVersion 1\n', 'utf8');
  const uploadedSharedFileV1 = await rawApi('bob-token', 'PUT', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`, sharedFileV1, 201, {
    'content-type': 'application/octet-stream',
    'x-janus-relative-path': encodeURIComponent(sharedFilePath),
    'x-janus-filename': encodeURIComponent('shared-report.md'),
    'x-janus-content-type': 'text/markdown',
    'x-janus-file-sha256': crypto.createHash('sha256').update(sharedFileV1).digest('hex'),
    'x-janus-base-revision': '0',
  });
  const sharedFileRecordV1 = JSON.parse(uploadedSharedFileV1.body.toString('utf8')).file;
  assert.equal(sharedFileRecordV1.relativePath, sharedFilePath);
  const aliceSharedWorkspace = await api('alice-token', 'GET', `/api/collaboration/groups/${groupId}/workspace`);
  assert.equal(aliceSharedWorkspace.workspace.id, initialSharedWorkspace.workspace.id, 'all members must resolve the same logical workspace');
  assert.equal(aliceSharedWorkspace.files.some((file) => file.id === sharedFileId && file.relativePath === sharedFilePath), true);
  assert.deepEqual((await rawApi('alice-token', 'GET', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`)).body, sharedFileV1);
  await rawApi('alice-token', 'PUT', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`, Buffer.from('stale'), 409, {
    'content-type': 'application/octet-stream',
    'x-janus-relative-path': encodeURIComponent(sharedFilePath),
    'x-janus-filename': encodeURIComponent('shared-report.md'),
    'x-janus-base-revision': '0',
  });
  const sharedFileV2 = Buffer.from('# Shared report\n\nVersion 2 by Alice\n', 'utf8');
  await rawApi('alice-token', 'PUT', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`, sharedFileV2, 200, {
    'content-type': 'application/octet-stream',
    'x-janus-relative-path': encodeURIComponent(sharedFilePath),
    'x-janus-filename': encodeURIComponent('shared-report.md'),
    'x-janus-content-type': 'text/markdown',
    'x-janus-file-sha256': crypto.createHash('sha256').update(sharedFileV2).digest('hex'),
    'x-janus-base-revision': String(sharedFileRecordV1.revision),
  });
  assert.deepEqual((await rawApi('bob-token', 'GET', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`)).body, sharedFileV2);

  await api('bob-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'rename', title: '成员不能修改' }, 403);
  const renamedGroup = await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'rename', title: '多人协作新群名' });
  assert.equal(renamedGroup.group.title, '多人协作新群名');

  const idempotent = await api('alice-token', 'POST', '/api/collaboration/groups', request);
  assert.equal(idempotent.idempotent, true);
  assert.equal(idempotent.group.id, groupId);
  assert.equal(cloud.db.prepare('SELECT COUNT(*) AS count FROM collaboration_groups').get().count, 1);

  await api('alice-token', 'POST', '/api/collaboration/groups', {
    title: '不应创建',
    clientRequestId: 'non-friend-rejected',
    assignments: [{ recipientId: 'dave', instruction: '不应发布给非好友' }],
  }, 403);

  const bobOverview = await api('bob-token', 'GET', '/api/collaboration');
  assert.equal(bobOverview.groups.some((group) => group.id === groupId), true);
  const bobPrivateTask = bobOverview.tasks.find((task) => task.id === bobTask.id);
  assert.equal(bobPrivateTask.metadata.preliminaryResult, 'Bob 私有初稿');
  assert.equal(bobPrivateTask.metadata.intakeSummary, 'Bob 私有整理结果');
  const carolDetail = await api('carol-token', 'GET', `/api/collaboration/groups/${groupId}`);
  assert.equal(carolDetail.tasks.find((task) => task.id === bobTask.id).metadata.preliminaryResult, undefined, 'other members must not receive recipient private draft');

  const aliceWorkspace = await api('alice-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  const bobWorkspace = await api('bob-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  assert.equal(Object.values(aliceWorkspace.workspace.metadata || {}).every((value) => !value), true,
    'requester workspace must start without inherited source context or recipient-private content');
  assert.equal(bobWorkspace.workspace.metadata.preliminaryResult, 'Bob 私有初稿');
  await api('carol-token', 'GET', `/api/delegations/${bobTask.id}/workspace`, undefined, 404);
  await api('alice-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, {
    clientMessageId: 'alice-private-draft',
    role: 'user',
    content: '这是 Alice 与自己 uBuddy 的私有要求草稿。',
    metadata: { localOnly: true },
  }, 201);
  await api('bob-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, {
    clientMessageId: 'bob-private-draft',
    role: 'assistant',
    content: '这是 Bob 与自己 uBuddy 的私有初步产物。',
  }, 201);
  await api('alice-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, {
    clientMessageId: 'alice-private-draft',
    role: 'user',
    content: '幂等重试不应重复写入。',
  }, 201);
  const aliceWorkspaceAfter = await api('alice-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  const bobWorkspaceAfter = await api('bob-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  assert.equal(aliceWorkspaceAfter.items.filter((item) => item.id === 'alice-private-draft').length, 1);
  assert.equal(aliceWorkspaceAfter.items.some((item) => item.content === '这是 Alice 与自己 uBuddy 的私有要求草稿。'), true);
  assert.equal(bobWorkspaceAfter.items.some((item) => item.content.includes('Alice')), false, 'recipient must not see requester private workspace');
  assert.equal(bobWorkspaceAfter.items.some((item) => item.content.includes('Bob')), true);
  await api('alice-token', 'PATCH', `/api/delegations/${bobTask.id}`, {
    sessionId: 'alice-private-session',
    metadata: { preliminaryResult: 'Alice 私有整理稿' },
  });
  await api('alice-token', 'PATCH', `/api/delegations/${bobTask.id}`, { metadata: { latestResult: '越权公共结果' } }, 403);
  const requesterPrivate = await api('alice-token', 'GET', '/api/collaboration');
  assert.equal(requesterPrivate.tasks.find((task) => task.id === bobTask.id).sessionId, 'alice-private-session');
  assert.equal(requesterPrivate.tasks.find((task) => task.id === bobTask.id).metadata.preliminaryResult, 'Alice 私有整理稿');
  assert.equal((await api('bob-token', 'GET', '/api/collaboration')).tasks.find((task) => task.id === bobTask.id).metadata.preliminaryResult, 'Bob 私有初稿');

  const published = await api('alice-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'publish',
    expectedStatus: 'assigned',
    content: '正式要求：汇报近期工作、风险和下一步，并制作流程图。',
  });
  assert.equal(published.delegation.status, 'assigned');
  assert.equal(published.delegation.instruction.startsWith('正式要求：'), true);
  const recipientAfterPublish = await api('bob-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  assert.equal(recipientAfterPublish.items.some((item) => item.metadata.type === 'requirements_update' && item.metadata.action === 'publish'), true);

  await api('bob-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, { action: 'working', expectedStatus: 'assigned' });
  await api('bob-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, { action: 'working', expectedStatus: 'assigned' }, 409);
  const resultFileBytes = Buffer.from('SQLITE_COLLABORATION_FILE_OK\n', 'utf8');
  const resultFileId = 'collab_file_sqlite_smoke';
  const uploadedResultFile = await rawApi('bob-token', 'PUT', `/api/collaboration/tasks/${bobTask.id}/files/${resultFileId}`, resultFileBytes, 201, {
    'content-type': 'application/octet-stream',
    'x-janus-filename': encodeURIComponent('汇报结果.md'),
    'x-janus-content-type': 'text/markdown',
  });
  const uploadedResultAttachment = JSON.parse(uploadedResultFile.body.toString('utf8')).attachment;
  assert.equal(uploadedResultAttachment.remote_file_id, resultFileId);
  await api('bob-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'submit',
    content: '第一版工作汇报与流程图',
    metadata: { attachments: [{ ...uploadedResultAttachment, path: '/home/bob/private/汇报结果.md', source_path: '/home/bob/private/汇报结果.md', file_url: 'file:///home/bob/private/汇报结果.md' }] },
  });
  const submittedForAlice = await api('alice-token', 'GET', `/api/collaboration/groups/${groupId}`);
  const publicSubmittedTask = submittedForAlice.tasks.find((task) => task.id === bobTask.id);
  assert.equal(publicSubmittedTask.status, 'submitted');
  assert.equal(publicSubmittedTask.metadata.latestResult, '第一版工作汇报与流程图');
  assert.equal(publicSubmittedTask.metadata.preliminaryResult, 'Alice 私有整理稿');
  assert.equal(JSON.stringify(publicSubmittedTask.metadata).includes('/home/bob'), false, 'public task metadata must not expose private workspace paths');
  assert.equal(Object.hasOwn(publicSubmittedTask.metadata.attachments[0], 'path'), false);
  assert.equal(publicSubmittedTask.metadata.attachments[0].remote_file_id, resultFileId);
  const downloadedResultFile = await rawApi('alice-token', 'GET', `/api/collaboration/files/${resultFileId}`);
  assert.deepEqual(downloadedResultFile.body, resultFileBytes);
  assert.deepEqual((await rawApi('carol-token', 'GET', `/api/collaboration/files/${resultFileId}`)).body, resultFileBytes);

  await api('bob-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, { action: 'request_revision', content: '越权修改' }, 403);
  await api('alice-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'request_revision',
    content: '请把流程图拆成“收集—分析—汇报”三步。',
  });
  const revisionForBob = await api('bob-token', 'GET', '/api/collaboration');
  assert.equal(revisionForBob.tasks.find((task) => task.id === bobTask.id).status, 'revision_requested');
  assert.equal(revisionForBob.tasks.find((task) => task.id === bobTask.id).metadata.latestRevisionRequest, '请把流程图拆成“收集—分析—汇报”三步。');
  await api('alice-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'update_requirements',
    content: '新增要求：流程图还要标注负责人和完成时限。',
  });
  const recipientAfterUpdate = await api('bob-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  assert.equal(recipientAfterUpdate.items.some((item) => item.metadata.action === 'update_requirements'), true);
  await api('bob-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'submit',
    content: '第二版工作汇报：流程图已拆成三步。',
  });
  await api('alice-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, { action: 'accept_result' });
  const acceptedSideEffects = {
    revisions: cloud.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id = ? AND action = 'accept_result'").get(bobTask.id).count,
    groupMessages: cloud.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND json_extract(metadata_json,'$.delegationId') = ? AND json_extract(metadata_json,'$.action') = 'accept_result'").get(groupId, bobTask.id).count,
    privateIngress: cloud.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id = ? AND json_extract(metadata_json,'$.type') = 'result_accepted'").get(bobTask.id).count,
  };
  const acceptedRetry = await api('alice-token', 'POST', `/api/collaboration/tasks/${bobTask.id}/action`, {
    action: 'accept_result', expectedStatus: 'submitted',
  });
  assert.equal(acceptedRetry.idempotent, true, 'accept_result retry must succeed even with the pre-accept expected status');
  assert.equal(acceptedRetry.delegation.status, 'result_accepted');
  assert.deepEqual({
    revisions: cloud.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id = ? AND action = 'accept_result'").get(bobTask.id).count,
    groupMessages: cloud.db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ? AND json_extract(metadata_json,'$.delegationId') = ? AND json_extract(metadata_json,'$.action') = 'accept_result'").get(groupId, bobTask.id).count,
    privateIngress: cloud.db.prepare("SELECT COUNT(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id = ? AND json_extract(metadata_json,'$.type') = 'result_accepted'").get(bobTask.id).count,
  }, acceptedSideEffects, 'an idempotent acceptance retry must not create duplicate history or notifications');
  await api('alice-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, { content: '验收后群聊未解散，发布方仍可继续和自己的 uBuddy 沟通。' }, 201);
  await api('bob-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, { content: '验收后群聊未解散，接收方仍可继续和自己的 uBuddy 沟通。' }, 201);
  const revisionCount = cloud.db.prepare('SELECT COUNT(*) AS count FROM agent_delegation_revisions WHERE delegation_id = ?').get(bobTask.id).count;
  assert.equal(revisionCount, 7);

  const crossMemberRoute = await api('bob-token', 'POST', `/api/collaboration/groups/${groupId}/messages`, {
    content: 'Carol，请把复核重点增加数据完整性检查。',
    metadata: { mentions: [{ principalType: 'ubuddy', ownerUserId: 'carol', displayText: 'Carol', mentionId: 'mention_carol_group', source: 'picker' }] },
  }, 201);
  const carolTask = created.tasks.find((task) => task.recipientUserId === 'carol');
  assert.deepEqual(crossMemberRoute.routing.routed, [{ delegationId: carolTask.id, targetUserId: 'carol' }]);
  const carolWorkspaceRouted = await api('carol-token', 'GET', `/api/delegations/${carolTask.id}/workspace`);
  assert.equal(carolWorkspaceRouted.items.some((item) => item.metadata.type === 'group_message_ingress' && item.content.includes('数据完整性')), true);

  const broadcastRoute = await api('alice-token', 'POST', `/api/collaboration/groups/${groupId}/messages`, { clientMessageId: 'broadcast-adjustment-1', content: '请同步调整本周交付格式。' }, 201);
  assert.equal(broadcastRoute.needsRoutingConfirmation, false);
  assert.equal(broadcastRoute.routing.candidates.length, 2);
  assert.deepEqual(broadcastRoute.routing.routed, [
    { delegationId: bobTask.id, targetUserId: 'bob' },
    { delegationId: bobTask.id, targetUserId: 'alice' },
    { delegationId: carolTask.id, targetUserId: 'carol' },
    { delegationId: carolTask.id, targetUserId: 'alice' },
  ]);
  const sourceMessage = broadcastRoute.messages.find((message) => message.id === 'broadcast-adjustment-1');
  const groupMessageCountBeforeRetry = cloud.db.prepare('SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ?').get(groupId).count;
  await api('alice-token', 'POST', `/api/collaboration/groups/${groupId}/messages`, { clientMessageId: 'broadcast-adjustment-1', content: '请同步调整本周交付格式。' }, 201);
  assert.equal(cloud.db.prepare('SELECT COUNT(*) AS count FROM collaboration_group_messages WHERE group_id = ?').get(groupId).count, groupMessageCountBeforeRetry, 'broadcast retry must not create another group message');
  assert.equal(cloud.db.prepare('SELECT COUNT(*) AS count FROM agent_delegation_workspace_messages WHERE delegation_id = ? AND user_id = ? AND source_group_message_id = ?').get(bobTask.id, 'bob', sourceMessage.id).count, 1, 'broadcast ingress must be idempotent');

  await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'add_member', userId: 'dave' }, 403);
  seedFriendship('alice', 'dave');
  await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'add_member', userId: 'dave' }, 400);
  const afterAdd = await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, {
    action: 'add_member',
    userId: 'dave',
    assignment: {
      title: '补充风险清单',
      instruction: '整理风险清单并给出缓解措施。',
      metadata: { preliminaryResult: 'Dave 私有风险初稿' },
    },
  });
  const daveTask = afterAdd.tasks.find((task) => task.recipientUserId === 'dave');
  assert.ok(daveTask?.id, 'add_member must atomically create a delegation');
  assert.deepEqual(daveTask.metadata.taskSummary, request.metadata.taskSummary,
    'a manually added member must inherit the group shared objective snapshot');
  assert.equal(afterAdd.members.some((member) => member.userId === 'dave' && member.status === 'active'), true);
  const daveOverview = await api('dave-token', 'GET', '/api/collaboration');
  assert.equal(daveOverview.tasks.find((task) => task.id === daveTask.id).metadata.preliminaryResult, 'Dave 私有风险初稿');
  const daveSharedWorkspace = await api('dave-token', 'GET', `/api/collaboration/groups/${groupId}/workspace`);
  assert.equal(daveSharedWorkspace.workspace.id, groupId, 'adding a member must grant the existing workspace instead of creating another workspace');
  assert.equal(daveSharedWorkspace.files.some((file) => file.id === sharedFileId), true, 'new members must receive the existing workspace manifest');

  const replacementGroup = await api('alice-token', 'POST', '/api/collaboration/groups', {
    title: '任务替代撤回验证',
    clientRequestId: 'replacement-withdraw-smoke-v1',
    assignments: [{ recipientId: 'bob', title: '待替代旧任务', instruction: '这项任务将在新任务发布后撤回。' }],
  }, 201);
  const replacementOldTask = replacementGroup.tasks.find((task) => task.recipientUserId === 'bob');
  await api('bob-token', 'POST', `/api/collaboration/tasks/${replacementOldTask.id}/action`, { action: 'withdraw' }, 403);
  const replacementWithdrawn = await api('alice-token', 'POST', `/api/collaboration/tasks/${replacementOldTask.id}/action`, {
    action: 'withdraw', expectedStatus: 'assigned', content: '已由新的电路PPT任务替代。',
  });
  assert.equal(replacementWithdrawn.delegation.status, 'withdrawn');
  assert.equal(replacementWithdrawn.members.some((member) => member.userId === 'bob' && member.status === 'active'), true, 'withdrawing one task must not remove its recipient from the group');
  const replacementWithdrawRetry = await api('alice-token', 'POST', `/api/collaboration/tasks/${replacementOldTask.id}/action`, {
    action: 'withdraw', expectedStatus: 'assigned',
  });
  assert.equal(replacementWithdrawRetry.idempotent, true, 'withdraw retry must be idempotent even with the pre-withdraw expected status');
  const withdrawnWorkspace = await api('bob-token', 'GET', `/api/delegations/${replacementOldTask.id}/workspace`);
  assert.equal(withdrawnWorkspace.items.some((item) => item.metadata.type === 'task_withdrawn'), true);

  await api('bob-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'close' }, 403);
  const beforeRemoval = await api('carol-token', 'GET', `/api/collaboration/groups/${groupId}`);
  await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'remove_member', userId: 'carol' });
  await api('carol-token', 'GET', `/api/collaboration/groups/${groupId}/workspace`, undefined, 404);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const futureText = 'Carol 被移除后不能看到这条消息';
  await api('alice-token', 'POST', `/api/collaboration/groups/${groupId}/messages`, { content: futureText }, 201);
  const removedOverview = await api('carol-token', 'GET', '/api/collaboration');
  assert.equal(removedOverview.groups.some((group) => group.id === groupId), false, 'removed member must not see active group in overview');
  const removedDetail = await api('carol-token', 'GET', `/api/collaboration/groups/${groupId}`);
  assert.equal(removedDetail.messages.some((message) => message.content === futureText), false);
  assert.ok(removedDetail.messages.length >= beforeRemoval.messages.length);
  await rawApi('carol-token', 'GET', `/api/collaboration/files/${resultFileId}`, undefined, 403);

  const closed = await api('alice-token', 'PATCH', `/api/collaboration/groups/${groupId}`, { action: 'close' });
  assert.equal(closed.group.status, 'closed');
  assert.equal(closed.tasks.every((task) => task.status === 'closed'), true);
  assert.equal(closed.members.filter((member) => member.status === 'closed').length, 3, 'active members must be archived on close');
  const closedSharedWorkspace = await api('bob-token', 'GET', `/api/collaboration/groups/${groupId}/workspace`);
  assert.equal(closedSharedWorkspace.workspace.readOnly, true);
  await rawApi('bob-token', 'PUT', `/api/collaboration/groups/${groupId}/workspace/files/${sharedFileId}`, Buffer.from('closed'), 409, {
    'content-type': 'application/octet-stream',
    'x-janus-relative-path': encodeURIComponent(sharedFilePath),
    'x-janus-filename': encodeURIComponent('shared-report.md'),
    'x-janus-base-revision': '0',
  });
  await api('alice-token', 'POST', `/api/collaboration/groups/${groupId}/messages`, { content: '不应发送' }, 409);
  await api('bob-token', 'POST', `/api/delegations/${bobTask.id}/workspace/messages`, { content: '关闭后不应继续修改' }, 409);
  const closedWorkspace = await api('bob-token', 'GET', `/api/delegations/${bobTask.id}/workspace`);
  assert.ok(closedWorkspace.items.length >= 3, 'closed participant retains private workspace history');
  await api('carol-token', 'GET', `/api/delegations/${carolTask.id}/workspace`, undefined, 404);
  const removedHistory = await api('carol-token', 'GET', '/api/collaboration');
  const removedHistoryGroup = removedHistory.groups.find((group) => group.id === groupId);
  assert.ok(removedHistoryGroup, 'closed group must remain available as history');
  assert.notEqual(removedHistoryGroup.lastMessage, futureText, 'removed member overview must not leak later messages');
  const removedClosedDetail = await api('carol-token', 'GET', `/api/collaboration/groups/${groupId}`);
  assert.equal(removedClosedDetail.messages.some((message) => message.content === futureText), false);
  assert.equal(removedClosedDetail.messages.some((message) => message.metadata.type === 'group_closed'), false);

  cloud.db.prepare(`INSERT INTO contact_organizations(
    id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
  ) VALUES('sqlite_workspace_org','SQLITE-WORKSPACE','SQLite Workspace','salt','hash','alice')`).run();
  cloud.db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('sqlite_workspace_org','alice','owner'),('sqlite_workspace_org','bob','member')`).run();
  const organizationWorkspaceId = 'workspace_org_sqlite_workspace_org';
  const organizationGroup = await api('alice-token', 'POST', '/api/collaboration/groups', {
    workspaceId: organizationWorkspaceId,
    title: '组织 Workspace 协作验证',
    clientRequestId: request.clientRequestId,
    assignments: [{ recipientId: 'bob', instruction: '仅在组织 Workspace 中执行。' }],
  }, 201);
  assert.equal(organizationGroup.group.workspaceId, organizationWorkspaceId);
  assert.notEqual(organizationGroup.group.id, groupId, 'the same request id must be independent across Workspaces');
  const personalAfterOrganization = await api('alice-token', 'GET', '/api/collaboration');
  assert.equal(personalAfterOrganization.groups.some((item) => item.id === organizationGroup.group.id), false);
  const organizationOverview = await api('alice-token', 'GET', `/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`);
  assert.equal(organizationOverview.groups.some((item) => item.id === organizationGroup.group.id), true);
  await api('dave-token', 'GET', `/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, undefined, 403);
  cloud.db.prepare("DELETE FROM contact_organization_members WHERE organization_id='sqlite_workspace_org' AND user_id='bob'").run();
  await api('bob-token', 'GET', `/api/collaboration?workspaceId=${encodeURIComponent(organizationWorkspaceId)}`, undefined, 403);

  assert.equal(cloud.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ ok: true, groupId, taskId: bobTask.id, revisions: revisionCount, checks: ['multiplayer', 'workspace-acl', 'private-metadata', 'idempotency', 'publish', 'requirements-update', 'status-conflict', 'cross-user-file-download', 'removed-member-file-cutoff', 'add-member-assignment', 'revision', 'removal-boundary', 'closed-history', 'readonly', 'account-workspace-isolation'] }));
} finally {
  await cloud.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}

function seedUser(id, displayName, token) {
  cloud.db.prepare(
    `INSERT INTO users (id, email, display_name, username, password_hash)
     VALUES (?, ?, ?, ?, 'smoke-password-hash')`,
  ).run(id, `${id}@example.test`, displayName, id);
  cloud.db.prepare('INSERT INTO auth_access_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), id, new Date(Date.now() + 60 * 60 * 1000).toISOString());
}

function seedFriendship(left, right) {
  const [userA, userB] = [left, right].sort();
  cloud.db.prepare('INSERT INTO friendships (id, user_a_id, user_b_id, status) VALUES (?, ?, ?, \'accepted\')')
    .run(`friendship_${userA}_${userB}`, userA, userB);
}

function verifyLegacyWorkspaceMigration() {
  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-sqlite-workspace-migration-'));
  let db = openCloudDatabase(legacyHome);
  try {
    db.prepare(
      `INSERT INTO users (id, email, display_name, username, password_hash)
       VALUES ('legacy_alice', 'legacy-alice@example.test', 'Legacy Alice', 'legacy_alice', 'hash'),
              ('legacy_bob', 'legacy-bob@example.test', 'Legacy Bob', 'legacy_bob', 'hash')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_delegations
         (id, requester_user_id, recipient_user_id, session_id, metadata_json)
       VALUES ('legacy_task', 'legacy_alice', 'legacy_bob', 'legacy_session', ?)`,
    ).run(JSON.stringify({ source: 'legacy-public', preliminaryResult: 'legacy-private-draft' }));
    db.prepare("DELETE FROM sync_migrations WHERE id = 'delegation_private_workspaces_v1'").run();
    db.prepare("DELETE FROM agent_delegation_workspaces WHERE delegation_id = 'legacy_task'").run();
    db.close();
    db = openCloudDatabase(legacyHome);
    const workspace = db.prepare("SELECT * FROM agent_delegation_workspaces WHERE delegation_id = 'legacy_task' AND user_id = 'legacy_bob'").get();
    const delegation = db.prepare("SELECT metadata_json FROM agent_delegations WHERE id = 'legacy_task'").get();
    assert.equal(workspace.session_id, 'legacy_session');
    assert.equal(JSON.parse(workspace.metadata_json).preliminaryResult, 'legacy-private-draft');
    assert.equal(JSON.parse(delegation.metadata_json).preliminaryResult, undefined);
  } finally {
    db.close();
    fs.rmSync(legacyHome, { recursive: true, force: true });
  }
}

function verifyLegacyCollaborationFileMigration() {
  const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-sqlite-direct-file-migration-'));
  let db = openCloudDatabase(legacyHome);
  const bytes = Buffer.from('LEGACY_COLLABORATION_FILE_BYTES\n', 'utf8');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    db.prepare(
      `INSERT INTO users (id, email, display_name, username, password_hash)
       VALUES ('legacy_file_alice', 'legacy-file-alice@example.test', 'Legacy File Alice', 'legacy_file_alice', 'hash'),
              ('legacy_file_bob', 'legacy-file-bob@example.test', 'Legacy File Bob', 'legacy_file_bob', 'hash')`,
    ).run();
    db.prepare("INSERT INTO collaboration_groups(id,owner_user_id,title) VALUES('legacy_file_group','legacy_file_alice','Legacy file group')").run();
    db.prepare(`INSERT INTO agent_delegations(id,requester_user_id,recipient_user_id,group_id,title,instruction)
      VALUES('legacy_file_task','legacy_file_alice','legacy_file_bob','legacy_file_group','Legacy file task','Preserve bytes')`).run();
    db.prepare(`INSERT INTO collaboration_files(id,delegation_id,group_id,owner_user_id,filename,content_type,size_bytes,sha256,data)
      VALUES('legacy_file','legacy_file_task','legacy_file_group','legacy_file_bob','legacy.md','text/markdown',?,?,?)`)
      .run(bytes.length, sha256, bytes);
    db.exec(`
      PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_cloud_collaboration_files_group;
      DROP INDEX IF EXISTS idx_cloud_collaboration_files_delegation;
      CREATE TABLE collaboration_files_legacy_contract (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES collaboration_groups(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename TEXT NOT NULL DEFAULT 'file',content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        size_bytes INTEGER NOT NULL DEFAULT 0,sha256 TEXT NOT NULL DEFAULT '',data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(delegation_id,owner_user_id,sha256)
      );
      INSERT INTO collaboration_files_legacy_contract
        SELECT * FROM collaboration_files;
      DROP TABLE collaboration_files;
      ALTER TABLE collaboration_files_legacy_contract RENAME TO collaboration_files;
      CREATE INDEX idx_cloud_collaboration_files_group ON collaboration_files(group_id,created_at);
      CREATE INDEX idx_cloud_collaboration_files_delegation ON collaboration_files(delegation_id,created_at);
      DELETE FROM sync_migrations WHERE id='collaboration_files_direct_delegation_v2';
      COMMIT;
      PRAGMA foreign_keys=ON;
    `);
    db.close();
    db = openCloudDatabase(legacyHome);
    const migratedColumn = db.prepare('PRAGMA table_info(collaboration_files)').all().find((column) => column.name === 'group_id');
    const migratedFile = db.prepare("SELECT * FROM collaboration_files WHERE id='legacy_file'").get();
    assert.equal(Number(migratedColumn.notnull || 0), 0);
    assert.equal(migratedFile.group_id, 'legacy_file_group');
    assert.equal(migratedFile.sha256, sha256);
    assert.deepEqual(Buffer.from(migratedFile.data), bytes);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_migrations WHERE id='collaboration_files_direct_delegation_v2'").get().count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
    db = openCloudDatabase(legacyHome);
    assert.deepEqual(Buffer.from(db.prepare("SELECT data FROM collaboration_files WHERE id='legacy_file'").get().data), bytes);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    db.close();
    fs.rmSync(legacyHome, { recursive: true, force: true });
  }
}

async function api(token, method, pathname, body, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}

async function rawApi(token, method, pathname, body, expectedStatus = 200, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
  });
  const responseBody = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${responseBody.toString('utf8')}`);
  return { status: response.status, headers: response.headers, body: responseBody };
}
