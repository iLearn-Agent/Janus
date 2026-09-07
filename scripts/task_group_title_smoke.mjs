import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { state } from '../src/renderer/app/state.js';
import { renderChat } from '../src/renderer/app/views/chatView.js';
import { renderNetworkPanel } from '../src/renderer/app/views/networkView.js';
import {
  automaticTaskGroupTitleMetadata,
  buildTaskGroupTitle,
  compactTaskGroupTitle,
  summarizeTaskGroupObjective,
} from '../src/shared/taskGroupTitle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-task-group-title-'));
let db;

try {
  assert.equal(
    summarizeTaskGroupObjective('请帮我由张亦弛和刘思杰协作撰写一篇关于 Agent 自我演进（agent self-evolving）的文章'),
    '撰写一篇关于 Agent 自我演进的文章',
  );
  assert.equal(
    buildTaskGroupTitle({ objective: '由张亦弛和刘思杰协作撰写 Agent 自我演进文章', participants: ['张亦弛', '刘思杰'] }),
    '撰写 Agent 自我演进文章 · 张亦弛、刘思杰',
  );
  assert.equal(
    buildTaskGroupTitle({ objective: '整理发布计划', participants: ['张亦弛', '刘思杰', '王一', '李二'] }),
    '整理发布计划 · 张亦弛、刘思杰等4人',
  );
  assert.equal(compactTaskGroupTitle({
    title: '撰写 Agent 自我演进文章 · 张亦弛、刘思杰',
    metadata: { taskGroupTitle: automaticTaskGroupTitleMetadata('撰写 Agent 自我演进文章') },
  }), '撰写 Agent 自我演进文章');
  assert.equal(compactTaskGroupTitle({
    title: '人工命名的重点项目 · 不应被拆分',
    metadata: { taskGroupTitle: { mode: 'manual' } },
  }), '人工命名的重点项目 · 不应被拆分');

  const automaticGroup = {
    id: 'title-render-group',
    title: '整理环境治理方案 · 我、小周',
    status: 'active', memberCount: 2, unreadCount: 0, lastMessage: '正在执行',
    metadata: { taskGroupTitle: automaticTaskGroupTitleMetadata('整理环境治理方案') },
  };
  state.currentUser = { id: 'title-render-owner', displayName: '我' };
  state.networkPanelView = 'messages';
  state.networkMessageHomeOpen = true;
  state.socialThreads = [];
  state.socialInbox = [];
  state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
  state.chatGroupsOverview = { groups: [] };
  state.collaborationOverview = { groups: [automaticGroup], tasks: [] };
  const messagePanel = renderNetworkPanel();
  assert.match(messagePanel, /<strong>整理环境治理方案<\/strong><b class="im-conversation-badge is-task">工作群<\/b>/);
  assert.match(messagePanel, /data-conversation-tooltip="整理环境治理方案"/);
  assert.doesNotMatch(messagePanel, /<strong>整理环境治理方案 · 我、小周<\/strong>/);
  assert.doesNotMatch(messagePanel, /data-conversation-tooltip="整理环境治理方案 · 我、小周"/);

  state.networkMessageHomeOpen = false;
  state.collaborationGroupId = automaticGroup.id;
  state.collaborationGroupDetail = {
    group: automaticGroup,
    workspace: { id: automaticGroup.id, scope: 'collaboration_group', revision: 1 },
    members: [
      { userId: 'title-render-owner', role: 'owner', status: 'active', user: state.currentUser },
      { userId: 'title-render-peer', role: 'member', status: 'active', user: { id: 'title-render-peer', displayName: '小周' } },
    ],
    plannedParticipants: [], messages: [], tasks: [],
  };
  assert.match(renderChat(), /<strong>整理环境治理方案 · 我、小周<\/strong>/,
    'opening the task group must show the full content-and-members title');

  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);
  const owner = auth.currentUser();
  for (const [id, displayName] of [['title_bob', '刘思杰'], ['title_carol', '王一'], ['title_dave', '测试账号 09']]) {
    db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,email_verified)
      VALUES(?,?,?,?, 'member',1)`).run(id, `${id}@example.test`, displayName, id);
    db.prepare('INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES(?,?,?,\'accepted\')')
      .run(`friend_${id}`, owner.id, id);
  }

  const objective = '撰写 Agent 自我演进文章';
  const metadata = { taskGroupTitle: automaticTaskGroupTitleMetadata(objective) };
  const created = auth.createCollaborationGroup({
    title: buildTaskGroupTitle({ objective, participants: [owner, auth.getUser('title_bob')] }),
    clientRequestId: 'task-group-title-smoke',
    metadata,
    assignments: [{ recipientId: 'title_bob', title: objective, instruction: objective }],
  });
  const groupId = created.group.id;
  assert.equal(created.group.metadata.taskGroupTitle.mode, 'auto');
  assert.equal(created.group.title, `撰写 Agent 自我演进文章 · ${owner.displayName}、刘思杰`);

  const partialCreated = auth.createCollaborationGroup({
    title: objective,
    clientRequestId: 'task-group-planned-participants-smoke',
    plannedRecipientIds: ['title_bob', 'title_carol', 'title_dave'],
    metadata: {
      taskGroupTitle: automaticTaskGroupTitleMetadata(objective),
      plannedRecipientIds: ['title_bob', 'title_carol', 'title_dave'],
    },
    assignments: [
      { recipientId: 'title_bob', title: objective, instruction: '整理研究资料。' },
      { recipientId: 'title_carol', title: objective, instruction: '撰写研究结论。' },
    ],
  });
  assert.equal(partialCreated.members.length, 3, 'only the owner and two published recipients are active members');
  assert.equal(partialCreated.plannedParticipants.length, 3);
  assert.equal(partialCreated.plannedParticipants.find((item) => item.userId === 'title_dave')?.status, 'awaiting_presence');
  assert.match(partialCreated.group.title, /等4人$/, 'the automatic title must preserve every planned participant');

  const added = auth.updateCollaborationGroup({
    groupId,
    action: 'add_member',
    userId: 'title_carol',
    assignment: { title: '复核文章', instruction: '复核文章结构和事实。' },
  });
  assert.equal(added.group.title, `撰写 Agent 自我演进文章 · ${owner.displayName}、刘思杰、王一`);

  const completedCarolTask = added.tasks.find((task) => task.recipientUserId === 'title_carol');
  db.prepare(`UPDATE agent_delegations SET status='completed',metadata_json=? WHERE id=?`)
    .run(JSON.stringify({ completionMarker: 'preserve-me' }), completedCarolTask.id);

  const removed = auth.updateCollaborationGroup({ groupId, action: 'remove_member', userId: 'title_carol' });
  assert.equal(removed.group.title, `撰写 Agent 自我演进文章 · ${owner.displayName}、刘思杰`);
  const preservedCarolTask = removed.tasks.find((task) => task.id === completedCarolTask.id);
  assert.equal(preservedCarolTask.status, 'completed', 'removing a member must preserve completed task history');
  assert.equal(preservedCarolTask.metadata.completionMarker, 'preserve-me');
  const removalMessage = removed.messages.find((message) => message.metadata?.type === 'member_removed');
  assert.deepEqual(removalMessage.metadata.withdrawnDelegationIds, [], 'the removal event must report only tasks actually withdrawn');

  auth.updateCollaborationGroup({ groupId, action: 'rename', title: '人工命名的重点项目' });
  auth.updateCollaborationGroup({
    groupId,
    action: 'add_member',
    userId: 'title_carol',
    assignment: { title: '再次复核', instruction: '再次复核最终版本。' },
  });
  assert.equal(auth.collaborationGroup(groupId).group.title, '人工命名的重点项目');

  const chatCss = fs.readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
  assert.match(chatCss, /\.collaboration-header-actions[^}]*gap:\s*5px/s);
  assert.match(chatCss, /\.collaboration-icon-button,[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
  assert.match(chatCss, /\.collaboration-icon-button svg,[\s\S]*?width:\s*24px;[\s\S]*?height:\s*24px;/);
  assert.match(chatCss, /\.collaboration-icon-button > span\s*\{[^}]*font-size:\s*12px;/s);

  console.log('task group title smoke passed');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
