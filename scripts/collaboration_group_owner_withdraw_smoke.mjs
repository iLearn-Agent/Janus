import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-group-owner-withdraw-'));
let runtime;

try {
  runtime = await createRuntime({ root, isDev: true });
  const owner = runtime.currentUser();
  for (const [id, name] of [['owner-withdraw-requester', '任务发起成员'], ['owner-withdraw-recipient', '任务接收成员']]) {
    runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,email_verified)
      VALUES(?,?,?,?, 'member',1)`).run(id, `${id}@example.test`, name, id);
    const [userA, userB] = [owner.id, id].sort();
    runtime.db.prepare("INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES(?,?,?,'accepted')")
      .run(`friend-${id}`, userA, userB);
  }
  const created = runtime.auth.createCollaborationGroup({
    title: '群主终止成员任务验证',
    clientRequestId: 'group-owner-withdraw-smoke',
    assignments: [
      { recipientId: 'owner-withdraw-requester', title: '成员自己的任务', instruction: '保持该成员在群内。' },
      { recipientId: 'owner-withdraw-recipient', title: '需要群主终止的任务', instruction: '由另一成员发起并交给该成员。' },
    ],
  });
  const delegation = created.tasks.find((task) => task.recipientUserId === 'owner-withdraw-recipient');
  runtime.db.prepare("UPDATE agent_delegations SET requester_user_id=?,status='running' WHERE id=?")
    .run('owner-withdraw-requester', delegation.id);

  const result = await runtime.collaborationTaskAction({
    delegationId: delegation.id,
    action: 'withdraw',
    expectedStatus: 'running',
  });
  assert.equal(result.delegation.status, 'withdrawn');
  const revision = runtime.db.prepare("SELECT author_user_id,action FROM agent_delegation_revisions WHERE delegation_id=? ORDER BY revision_no DESC LIMIT 1").get(delegation.id);
  assert.equal(revision.author_user_id, owner.id);
  assert.equal(revision.action, 'withdraw');
  assert.ok(runtime.auth.collaborationGroup(created.group.id).messages.some((message) => (
    message.metadata?.action === 'withdraw' && message.metadata?.delegationId === delegation.id
  )));
  runtime.auth.sendCollaborationMessage({
    groupId: created.group.id,
    content: '这条解散前的群聊历史必须保留。',
  });
  runtime.auth.updateCollaborationGroup({ groupId: created.group.id, action: 'close' });
  const closedOverview = runtime.auth.collaborationOverview();
  assert.ok(closedOverview.groups.some((group) => group.id === created.group.id && group.status === 'closed'));
  const closedDetail = runtime.auth.collaborationGroup(created.group.id);
  assert.ok(closedDetail.messages.some((message) => message.content === '这条解散前的群聊历史必须保留。'));
  assert.ok(closedDetail.messages.some((message) => message.metadata?.type === 'group_closed'));
  assert.throws(() => runtime.auth.sendCollaborationMessage({
    groupId: created.group.id,
    content: '解散后不应发送。',
  }), /已解散/);
  console.log('collaboration group owner withdraw smoke passed');
} finally {
  await runtime?.close?.();
  fs.rmSync(root, { recursive: true, force: true });
}
