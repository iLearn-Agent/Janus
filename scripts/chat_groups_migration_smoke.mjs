import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../src/main/auth.js';
import { repairDatabase } from '../src/main/databaseRecovery.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const currentAppVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-chat-groups-migration-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  const auth = new AuthService(db);
  const store = new Store(db, { root });
  const alice = auth.requireUser();
  store.ensureAccountWorkspaces({ user: alice });
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,password_hash,email_verified,auth_provider,remote_id)
    VALUES('chat_bob','bob@example.test','Bob','bob','member','',1,'local_mock','')`).run();
  db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES('chat_friendship','chat_bob',?,'accepted')`).run(alice.id);

  const created = auth.createChatGroup({
    groupId: 'chat_group_local_1',
    clientRequestId: 'chat-group-local-request-1',
    title: '本地讨论组',
    memberIds: ['chat_bob'],
  });
  assert.equal(created.group.id, 'chat_group_local_1');
  assert.equal(created.members.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chat_group_outbox').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM conversations WHERE id='chat_group_conversation:chat_group_local_1'").get().count, 1);
  db.exec('ALTER TABLE chat_group_members DROP COLUMN remark');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('chat_group_members') WHERE name='remark'").get().count, 0);
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === created.group.id), true,
    'opening the group list must repair a pre-remark database before reading membership remarks');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pragma_table_info('chat_group_members') WHERE name='remark'").get().count, 1);

  const repeated = auth.createChatGroup({
    groupId: 'chat_group_local_1',
    clientRequestId: 'chat-group-local-request-1',
    title: '本地讨论组',
    memberIds: ['chat_bob'],
  });
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.group.id, 'chat_group_local_1');
  assert.throws(() => auth.createChatGroup({
    groupId: 'chat_group_local_1',
    clientRequestId: 'chat-group-local-request-1',
    title: '不同群名',
    memberIds: ['chat_bob'],
  }), /幂等键已被不同请求占用/);
  assert.equal(db.prepare('SELECT title FROM chat_groups WHERE id=?').get(created.group.id).title, '本地讨论组');

  const sent = auth.sendChatGroupMessage({ groupId: created.group.id, clientMessageId: 'chat_local_message_1', content: '你好 Bob' });
  assert.equal(sent.messages.some((message) => message.id === 'chat_local_message_1'), true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chat_group_outbox').get().count, 2);
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='chat_local_message_1'").get().content, '你好 Bob');
  assert.throws(() => auth.sendChatGroupMessage({
    groupId: created.group.id,
    clientMessageId: 'chat_local_message_1',
    sourceEventId: 'different-source-event',
    content: '你好 Bob',
  }), /消息幂等 ID 已被不同内容占用/);
  assert.equal(db.prepare("SELECT source_event_id FROM chat_group_messages WHERE id='chat_local_message_1'").get().source_event_id, '');
  const sentOverview = auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id);
  assert.match(sentOverview.lastMessage, /^Admin：你好 Bob$/);
  assert.equal(sentOverview.lastMessageContent, '你好 Bob');
  assert.equal(sentOverview.lastMessageSenderUserId, alice.id);
  assert.equal(sentOverview.lastMessageSenderName, 'Admin');

  const withdrawn = auth.updateChatGroup({
    groupId: created.group.id,
    action: 'withdraw_message',
    messageId: 'chat_local_message_1',
    clientRequestId: 'withdraw-message-once',
  });
  const withdrawnMessage = withdrawn.messages.find((message) => message.id === 'chat_local_message_1');
  assert.equal(withdrawnMessage.metadata.withdrawn, true);
  assert.equal(withdrawnMessage.content, '你好 Bob', 'withdrawal must preserve the original group-message content');
  const withdrawnOverview = auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id);
  assert.equal(withdrawnOverview.lastMessage, 'Admin：消息已撤回');
  assert.equal(withdrawnOverview.lastMessageContent, '消息已撤回');
  assert.equal(withdrawnOverview.lastMessageSenderUserId, alice.id);
  assert.equal(JSON.parse(db.prepare("SELECT metadata_json FROM messages WHERE id='chat_local_message_1'").get().metadata_json).withdrawn, true,
    'the normalized message projection must preserve withdrawal metadata');
  const repeatedWithdraw = auth.updateChatGroup({
    groupId: created.group.id,
    action: 'withdraw_message',
    messageId: 'chat_local_message_1',
    clientRequestId: 'withdraw-message-once',
  });
  assert.equal(repeatedWithdraw.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chat_group_outbox').get().count, 3);
  auth.setActiveUser('chat_bob');
  assert.throws(() => auth.updateChatGroup({
    groupId: created.group.id,
    action: 'withdraw_message',
    messageId: 'chat_local_message_1',
    clientRequestId: 'withdraw-message-not-owner',
  }), /只能撤回自己发送的自然人群聊消息/);
  auth.setActiveUser(alice.id);

  auth.sendChatGroupMessage({ groupId: created.group.id, clientMessageId: 'chat_local_message_expired', content: '过期群聊消息' });
  db.prepare("UPDATE chat_group_messages SET created_at='2026-01-01T00:00:00.000Z' WHERE id='chat_local_message_expired'").run();
  assert.throws(() => auth.updateChatGroup({
    groupId: created.group.id,
    action: 'withdraw_message',
    messageId: 'chat_local_message_expired',
    clientRequestId: 'withdraw-message-expired',
  }), /消息发送超过2分钟/);

  const renamed = auth.updateChatGroup({ groupId: created.group.id, action: 'rename', title: '稳定讨论组', clientRequestId: 'rename-once' });
  assert.equal(renamed.group.title, '稳定讨论组');
  const repeatedRename = auth.updateChatGroup({ groupId: created.group.id, action: 'rename', title: '稳定讨论组', clientRequestId: 'rename-once' });
  assert.equal(repeatedRename.idempotent, true);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chat_group_outbox').get().count, 5);
  assert.throws(() => auth.updateChatGroup({ groupId: created.group.id, action: 'rename', title: '不应写入', clientRequestId: 'rename-once' }), /幂等键已被不同请求占用/);
  assert.equal(db.prepare('SELECT title FROM chat_groups WHERE id=?').get(created.group.id).title, '稳定讨论组');

  const remarked = auth.updateChatGroup({ groupId: created.group.id, action: 'set_remark', remark: '项目评审群', clientRequestId: 'remark-once' });
  assert.equal(remarked.membership.remark, '项目评审群');
  assert.equal(db.prepare('SELECT remark FROM chat_group_members WHERE group_id=? AND user_id=?').get(created.group.id, alice.id).remark, '项目评审群');
  const repeatedRemark = auth.updateChatGroup({ groupId: created.group.id, action: 'set_remark', remark: '项目评审群', clientRequestId: 'remark-once' });
  assert.equal(repeatedRemark.idempotent, true);

  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,password_hash,email_verified,auth_provider,remote_id)
    VALUES('chat_carol','carol@example.test','Carol','carol','member','',1,'local_mock','')`).run();
  db.prepare(`INSERT INTO account_workspaces(id,workspace_kind,organization_id,owner_user_id,name,status)
    VALUES('workspace_org_chat_test','organization','chat_test_org',?,'分布式系统实验室','active')`).run(alice.id);
  db.prepare(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status)
    VALUES('workspace_org_chat_test',?,'owner','active'),('workspace_org_chat_test','chat_carol','member','active')`).run(alice.id);
  store.switchAccountWorkspace({ userId: alice.id, workspaceId: 'workspace_org_chat_test', deviceId: 'local' });
  store.setStartupAccountWorkspace({ userId: alice.id, workspaceId: 'workspace_org_chat_test', deviceId: 'local' });
  const mixed = auth.createChatGroup({
    groupId: 'chat_group_mixed_1',
    clientRequestId: 'chat-group-mixed-request-1',
    title: '跨边界联系人群聊',
    memberIds: ['chat_bob', 'chat_carol'],
    workspaceId: 'workspace_org_chat_test',
  });
  assert.equal(mixed.members.length, 3);
  assert.equal(mixed.group.scopeType, 'external');
  assert.equal(mixed.group.audienceScope, 'account_social');
  auth.socialSendMessage({ recipientId: 'chat_bob', content: '组织中发起的联系人私聊', workspaceId: 'workspace_org_chat_test' });
  const organizationDirectConversationId = auth.ensureSocialDirectConversation({
    senderUserId: 'chat_bob', recipientUserId: alice.id, workspaceId: 'workspace_org_chat_test',
  });
  db.prepare(`INSERT INTO social_messages(id,account_workspace_id,conversation_id,sender_user_id,recipient_user_id,content)
    VALUES('chat_org_incoming','workspace_org_chat_test',?,'chat_bob',?,'组织中的回复')`).run(organizationDirectConversationId, alice.id);
  store.switchAccountWorkspace({ userId: alice.id, workspaceId: 'workspace_personal', deviceId: 'local' });
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === mixed.group.id), false,
    'organization chat groups must remain isolated from the personal account');
  assert.equal(auth.socialConversation({ peerId: 'chat_bob', workspaceId: 'workspace_personal' }).length, 0,
    'legacy scoped direct-message reads must retain their Workspace boundary');
  assert.equal(auth.socialConversation({ peerId: 'chat_bob', accountGlobal: true }).length, 0,
    'legacy account-global flags must not bypass the active account boundary');
  assert.equal(auth.socialInbox({ accountGlobal: true }).some((message) => message.id === 'chat_org_incoming'), false,
    'the personal inbox must not include organization messages');
  auth.socialMarkRead({ messageId: 'chat_org_incoming', accountGlobal: true });
  assert.equal(db.prepare("SELECT status FROM social_messages WHERE id='chat_org_incoming'").get().status, 'unread',
    'a personal-account read command must not mutate an organization message');
  store.switchAccountWorkspace({ userId: alice.id, workspaceId: 'workspace_org_chat_test', deviceId: 'local' });
  auth.socialMarkRead({ messageId: 'chat_org_incoming', workspaceId: 'workspace_org_chat_test' });
  assert.equal(db.prepare("SELECT status FROM social_messages WHERE id='chat_org_incoming'").get().status, 'read');
  store.switchAccountWorkspace({ userId: alice.id, workspaceId: 'workspace_personal', deviceId: 'local' });
  assert.equal(store.startupAccountWorkspace({ userId: alice.id, deviceId: 'local' }).id, 'workspace_org_chat_test');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM chat_group_outbox').get().count, 7);
  const archivedConversation = auth.setConversationArchived({
    conversationKind: 'chat_group', conversationId: created.group.id, archived: true,
    commandId: 'conversation-archive-local-1', expectedRevision: 0, sourceDeviceId: 'local',
  });
  assert.equal(archivedConversation.preference.archived, true);
  assert.equal(auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id).archived, true);
  db.prepare('UPDATE chat_groups SET updated_at=? WHERE id=?').run(new Date(Date.now() + 1_000).toISOString(), created.group.id);
  assert.equal(auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id).archived, false,
    'a newer active-group message timestamp must automatically return the group to Messages');
  const reArchivedConversation = auth.setConversationArchived({
    conversationKind: 'chat_group', conversationId: created.group.id, archived: true,
    commandId: 'conversation-archive-local-2', expectedRevision: 1, sourceDeviceId: 'local',
  });
  assert.equal(reArchivedConversation.preference.stateRevision, 2);
  db.prepare("UPDATE chat_groups SET status='dissolved',updated_at=? WHERE id=?").run(new Date(Date.now() + 2_000).toISOString(), created.group.id);
  assert.equal(auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id).archived, true,
    'a dissolved group must stay archived until the user restores it');
  db.prepare("UPDATE social_conversation_preferences SET removed_at='2026-08-16T00:00:00.000Z' WHERE conversation_id=?")
    .run(created.group.id);
  const legacyRemovedGroup = auth.chatGroupsOverview().groups.find((group) => group.id === created.group.id);
  assert.equal(Boolean(legacyRemovedGroup), true, 'legacy removed groups must remain available as archived conversations');
  assert.equal(legacyRemovedGroup.archived, true);
  assert.equal(legacyRemovedGroup.removed, false);
  assert.equal(auth.conversationPreference({ conversationKind: 'chat_group', conversationId: created.group.id }).removedAt, '');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM social_conversation_preference_outbox').get().count, 2);
  db.prepare("UPDATE chat_group_members SET display_name_override='群内 Alice' WHERE group_id=? AND user_id=?").run(created.group.id, alice.id);
  db.prepare(`INSERT INTO social_contact_remarks(owner_user_id,target_user_id,remark)
    VALUES(?,?,?) ON CONFLICT(owner_user_id,target_user_id) DO UPDATE SET remark=excluded.remark`).run(alice.id, 'chat_bob', '项目联系人 Bob');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_contact_labels_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT display_name_override FROM chat_group_members WHERE group_id=? AND user_id=?").get(created.group.id, alice.id).display_name_override, '群内 Alice');
  assert.equal(db.prepare('SELECT remark FROM social_contact_remarks WHERE owner_user_id=? AND target_user_id=?').get(alice.id, 'chat_bob').remark, '项目联系人 Bob');
  assert.equal(db.prepare('SELECT remark FROM chat_group_members WHERE group_id=? AND user_id=?').get(created.group.id, alice.id).remark, '项目评审群');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  db.close();
  db = openDatabase(root, { skipMigrationBackup: true });
  const reopenedAuth = new AuthService(db);
  const reopened = reopenedAuth.chatGroup(created.group.id);
  assert.equal(reopened.messages.some((message) => message.id === 'chat_local_message_1'), true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_chat_groups_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_directory_v2'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_conversation_archive_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_contact_labels_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT display_name_override FROM chat_group_members WHERE group_id=? AND user_id=?").get(created.group.id, alice.id).display_name_override, '群内 Alice');
  assert.equal(db.prepare('SELECT remark FROM social_contact_remarks WHERE owner_user_id=? AND target_user_id=?').get(alice.id, 'chat_bob').remark, '项目联系人 Bob');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const preserved = {
    group: db.prepare('SELECT title,audience_scope,metadata_json,created_at FROM chat_groups WHERE id=?').get(created.group.id),
    members: db.prepare('SELECT user_id,role,status,joined_at FROM chat_group_members WHERE group_id=? ORDER BY user_id').all(created.group.id),
    message: db.prepare('SELECT content,metadata_json,created_at FROM chat_group_messages WHERE id=?').get('chat_local_message_1'),
    outbox: db.prepare('SELECT idempotency_key,payload_hash,payload_json,status,created_at FROM chat_group_outbox ORDER BY id').all(),
    startupPreference: db.prepare('SELECT * FROM account_workspace_startup_preferences WHERE user_id=? AND device_id=?').get(alice.id, 'local'),
    conversationPreference: db.prepare('SELECT * FROM social_conversation_preferences WHERE conversation_id=?').get(created.group.id),
    conversationPreferenceOutbox: db.prepare('SELECT * FROM social_conversation_preference_outbox ORDER BY id').all(),
    contactRemark: db.prepare('SELECT * FROM social_contact_remarks WHERE owner_user_id=? AND target_user_id=?').get(alice.id, 'chat_bob'),
    memberDisplayName: db.prepare('SELECT display_name_override FROM chat_group_members WHERE group_id=? AND user_id=?').get(created.group.id, alice.id),
  };
  db.prepare("DELETE FROM schema_migrations WHERE id='social_directory_v2'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='social_conversation_archive_v1'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='social_contact_labels_v1'").run();
  db.close();
  db = null;

  const repaired = repairDatabase(root, { appVersion: currentAppVersion });
  assert.equal(repaired.status, 'repaired');
  db = new DatabaseSync(path.join(root, 'data', 'janus.db'), { readOnly: true });
  assert.deepEqual(db.prepare('SELECT title,audience_scope,metadata_json,created_at FROM chat_groups WHERE id=?').get(created.group.id), preserved.group);
  assert.deepEqual(db.prepare('SELECT user_id,role,status,joined_at FROM chat_group_members WHERE group_id=? ORDER BY user_id').all(created.group.id), preserved.members);
  assert.deepEqual(db.prepare('SELECT content,metadata_json,created_at FROM chat_group_messages WHERE id=?').get('chat_local_message_1'), preserved.message);
  assert.deepEqual(db.prepare('SELECT idempotency_key,payload_hash,payload_json,status,created_at FROM chat_group_outbox ORDER BY id').all(), preserved.outbox);
  assert.deepEqual(db.prepare('SELECT * FROM account_workspace_startup_preferences WHERE user_id=? AND device_id=?').get(alice.id, 'local'), preserved.startupPreference);
  assert.deepEqual(db.prepare('SELECT * FROM social_conversation_preferences WHERE conversation_id=?').get(created.group.id), preserved.conversationPreference);
  assert.deepEqual(db.prepare('SELECT * FROM social_conversation_preference_outbox ORDER BY id').all(), preserved.conversationPreferenceOutbox);
  assert.deepEqual(db.prepare('SELECT * FROM social_contact_remarks WHERE owner_user_id=? AND target_user_id=?').get(alice.id, 'chat_bob'), preserved.contactRemark);
  assert.deepEqual(db.prepare('SELECT display_name_override FROM chat_group_members WHERE group_id=? AND user_id=?').get(created.group.id, alice.id), preserved.memberDisplayName);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_chat_groups_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_directory_v2'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_conversation_archive_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='social_contact_labels_v1'").get().count, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  console.log(JSON.stringify({ ok: true, groupId: created.group.id, outboxRows: 7, groupMessageWithdrawalPreserved: true, mixedAudiencePreserved: true,
    accountGlobalDirectMessagesVisible: false, accountIsolationEnforced: true, startupWorkspacePreserved: true, repairCopyPreserved: true,
    conversationArchivePreserved: true, activeGroupAutoReopened: true, endedGroupStayedArchived: true,
    idempotencyConflictsAreSideEffectFree: true }, null, 2));
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
