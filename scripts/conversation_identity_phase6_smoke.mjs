import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { Store } from '../src/main/store.js';
import { AuthService } from '../src/main/auth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-conversation-phase6-'));
const currentAppVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
let db = openDatabase(root, { skipMigrationBackup: true });

try {
  let store = new Store(db, { root });
  const primary = store.createSession({ title: 'Stable conversation', departmentId: 'general', userId: 'local_admin' });
  db.exec('DROP TRIGGER trg_agent_context_spaces_identity_insert; DROP TRIGGER trg_agent_context_spaces_identity_update');
  db.exec(`INSERT INTO agent_context_spaces(id,user_id,user_agent_instance_id,context_kind,memory_document_id)
    VALUES('phase6_ctx_a','local_admin','phase6_probe_agent','general_memory','phase6_memory_a'),
      ('phase6_ctx_b','local_admin','phase6_probe_agent','general_memory','phase6_memory_b')`);
  const attachment = { id: 'phase6_file', name: 'phase6-note.txt', contentType: 'text/plain', sizeBytes: 12 };
  const first = store.addMessage({
    sessionId: primary.id, contextSpaceId: 'phase6_ctx_a', role: 'user', content: 'BEFORE_WORKSPACE',
    departmentId: 'general', metadata: { attachments: [attachment] },
  });
  const selected = store.updateSession(primary.id, { projectId: 'phase6_project', workspaceRoot: '/tmp/phase6-project' });
  assert.equal(selected.id, primary.id);
  assert.equal(selected.conversationId, primary.conversationId);
  store.addMessage({ sessionId: primary.id, contextSpaceId: 'phase6_ctx_a', role: 'assistant', content: 'IN_WORKSPACE', departmentId: 'general' });
  const detached = store.updateSession(primary.id, { projectId: '', workspaceRoot: '' });
  assert.equal(detached.id, primary.id);
  assert.equal(detached.conversationId, primary.conversationId);
  store.addMessage({ sessionId: primary.id, contextSpaceId: 'phase6_ctx_b', role: 'user', content: 'MEMORY_B_ONLY', departmentId: 'general' });
  assert.deepEqual(store.listMessages(primary.id, { contextSpaceId: 'phase6_ctx_a', includeAllContexts: false }).map((item) => item.content),
    ['BEFORE_WORKSPACE', 'IN_WORKSPACE']);
  assert.deepEqual(store.listMessages(primary.id, { contextSpaceId: 'phase6_ctx_b', includeAllContexts: false }).map((item) => item.content),
    ['MEMORY_B_ONLY']);
  assert.equal(store.listMessageAttachments(first.id)[0].name, attachment.name);

  const split = store.createSession({ title: 'Legacy split', departmentId: 'general', userId: 'local_admin', reusePrimary: false });
  const splitMessage = store.addMessage({
    sessionId: split.id, contextSpaceId: 'phase6_ctx_a', role: 'assistant', content: 'LEGACY_SPLIT_MESSAGE',
    departmentId: 'general', metadata: { attachments: [attachment] },
  });
  db.prepare("UPDATE sessions SET conversation_id='',superseded_by_session_id=?,conversation_role='history',write_state='read_only' WHERE id=?")
    .run(primary.id, split.id);
  db.prepare("UPDATE messages SET conversation_id='',memory_id='' WHERE id=?").run(splitMessage.id);

  const taskWorkspace = store.ensureTaskWorkspaceConversation({
    delegationId: 'phase6_delegation', ownerUserId: 'local_admin', sessionId: primary.id,
    taskRunId: 'phase6_task', workspaceRoot: '/tmp/phase6-task', workspaceEpoch: 'epoch-1',
  });
  assert.equal(taskWorkspace.conversationId, primary.conversationId);
  db.prepare(`INSERT INTO agent_delegation_workspaces(
    delegation_id,user_id,session_id,metadata_json
  ) VALUES('phase6_delegation_collision','local_admin',?,?)`).run(
    primary.id, JSON.stringify({ workspaceEpoch: 'epoch-collision' }),
  );

  db.prepare(`INSERT INTO collaboration_groups(id,account_workspace_id,owner_user_id,title,status)
    VALUES('phase6_group','workspace_personal','local_admin','Phase 6 group','active')`).run();
  db.prepare(`INSERT INTO collaboration_group_messages(
    id,account_workspace_id,group_id,sender_user_id,kind,content,metadata_json
  ) VALUES('phase6_group_message','workspace_personal','phase6_group','local_admin','friend','GROUP_SHARED_MESSAGE','{}')`).run();
  db.prepare(`INSERT INTO collaboration_group_members(group_id,user_id,role,status)
    VALUES('phase6_group','local_admin','owner','active')`).run();

  db.exec(`DROP INDEX IF EXISTS idx_conversations_group;
    DROP INDEX IF EXISTS idx_conversations_task_workspace;
    DROP INDEX IF EXISTS idx_messages_conversation_source_event;
    DROP INDEX IF EXISTS idx_account_workspaces_organization;`);
  db.prepare("UPDATE conversations SET group_id='phase6_shared_group' WHERE id=?").run(primary.conversationId);
  db.prepare(`INSERT INTO conversations(
    id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,task_workspace_id,status
  ) VALUES('phase6_task_conversation_duplicate','workspace_personal','task_workspace','local_admin',
    'Duplicate task conversation','phase6_shared_group',?,'active')`).run(taskWorkspace.id);
  db.exec(`INSERT INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,status
    ) VALUES
      ('phase6_group_duplicate_a','workspace_personal','group','local_admin','Legacy group A','phase6_group','active'),
      ('phase6_group_duplicate_b','workspace_personal','group','local_admin','Legacy group B','phase6_group','active');
    INSERT INTO messages(
      id,account_workspace_id,conversation_id,session_id,source_event_id,role,content,created_at,updated_at
    ) VALUES
      ('phase6_duplicate_event_a','workspace_personal','phase6_group_duplicate_a','','phase6_same_event','user',
        'PRESERVED_DUPLICATE_EVENT_A','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
      ('phase6_duplicate_event_b','workspace_personal','phase6_group_duplicate_b','','phase6_same_event','user',
        'PRESERVED_DUPLICATE_EVENT_B','2026-01-01T00:00:01.000Z','2026-01-01T00:00:01.000Z');
    INSERT INTO account_workspaces(
      id,workspace_kind,organization_id,owner_user_id,name,status
    ) VALUES
      ('workspace_org_phase6_duplicate','organization','phase6_duplicate_org','local_admin','Canonical duplicate org','active'),
      ('workspace_org_phase6_duplicate_legacy','organization','phase6_duplicate_org','local_admin','Legacy duplicate org','active');`);

  db.prepare("DELETE FROM schema_migrations WHERE id IN ('conversation_identity_phase6_v1','unified_message_store_phase6_v1','workspace_split_recovery_phase6_v1')").run();
  db.close();
  assert.equal(inspectDatabaseRecoveryStatus(root, { appVersion: currentAppVersion }).status, 'repairable');
  assert.equal(repairDatabase(root, { appVersion: currentAppVersion }).status, 'repaired');
  db = openDatabase(root, { appVersion: currentAppVersion, skipMigrationBackup: true });
  store = new Store(db, { root });

  const migratedSplit = store.getMessage(splitMessage.id);
  assert.equal(migratedSplit.conversationId, primary.conversationId);
  assert.equal(migratedSplit.memoryId, '');
  assert.equal(migratedSplit.contextSpaceId, '');
  assert.deepEqual(migratedSplit.metadata.databaseRecovery, {
    orphanedMemoryId: 'phase6_memory_a',
    reason: 'missing_memory_document',
    migration: 'memory_context_pointer_repair_v1',
  });
  assert.equal(store.getSession(split.id).conversationId, primary.conversationId);
  assert.equal(store.getConversation(split.id).id, primary.conversationId);
  assert.ok(store.listMessages(primary.id, { includeAllContexts: true })
    .some((item) => item.content === 'LEGACY_SPLIT_MESSAGE'));
  assert.equal(store.listMessageAttachments(splitMessage.id)[0].name, attachment.name);
  db.prepare("UPDATE messages SET metadata_json='{}' WHERE id=?").run(splitMessage.id);
  assert.equal(store.getMessage(splitMessage.id).metadata.attachments[0].name, attachment.name,
    'the relational attachment binding must recover visibility when legacy metadata is absent');
  assert.equal(store.getTaskWorkspaceForDelegation({ delegationId: 'phase6_delegation', ownerUserId: 'local_admin' }).conversationId,
    primary.conversationId);
  const recoveredCollisionWorkspace = store.getTaskWorkspaceForDelegation({
    delegationId: 'phase6_delegation_collision', ownerUserId: 'local_admin',
  });
  assert.ok(recoveredCollisionWorkspace);
  assert.notEqual(recoveredCollisionWorkspace.conversationId, primary.conversationId,
    'separate delegation Workspaces must not collide on the canonical Agent conversation');
  const recoveredCollisionBinding = db.prepare(`SELECT session_id FROM agent_delegation_workspaces
    WHERE delegation_id='phase6_delegation_collision' AND user_id='local_admin'`).get();
  assert.notEqual(recoveredCollisionBinding.session_id, primary.id);
  assert.equal(store.getSession(recoveredCollisionBinding.session_id).conversationId, recoveredCollisionWorkspace.conversationId);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM conversations
    WHERE conversation_kind='group' AND group_id='phase6_group'`).get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM conversations WHERE task_workspace_id=?').get(taskWorkspace.id).count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM messages
    WHERE content IN ('PRESERVED_DUPLICATE_EVENT_A','PRESERVED_DUPLICATE_EVENT_B')`).get().count, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM messages
    WHERE conversation_id='group_conversation:phase6_group' AND source_event_id='phase6_same_event'`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM account_workspaces
    WHERE organization_id='phase6_duplicate_org'`).get().count, 1);
  assert.equal(db.prepare(`SELECT status FROM account_workspaces
    WHERE id='workspace_org_phase6_duplicate_legacy'`).get().status, 'deleted');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_conversations_group'").get().sql,
    /conversation_kind\s*=\s*'group'/i);
  const workspaceUniqueAudits = [
    ['organization Workspace identity', `SELECT id FROM account_workspaces WHERE organization_id!=''
      GROUP BY organization_id HAVING COUNT(*)>1`],
    ['primary Agent conversation', `SELECT user_id FROM sessions WHERE agent_instance_id!='' AND conversation_role='primary'
      AND write_state='writable' AND status!='deleted' GROUP BY user_id,account_workspace_id,agent_instance_id HAVING COUNT(*)>1`],
    ['active general Memory', `SELECT user_id FROM memory_documents WHERE scope='general' AND lifecycle_state='active'
      GROUP BY account_workspace_id,user_id,user_agent_instance_id HAVING COUNT(*)>1`],
    ['message source event', `SELECT conversation_id FROM messages WHERE source_event_id!=''
      GROUP BY conversation_id,source_event_id HAVING COUNT(*)>1`],
    ['group conversation', `SELECT group_id FROM conversations WHERE conversation_kind='group' AND group_id!=''
      GROUP BY group_id HAVING COUNT(*)>1`],
    ['task Workspace conversation identity', `SELECT task_workspace_id FROM conversations WHERE task_workspace_id!=''
      GROUP BY task_workspace_id HAVING COUNT(*)>1`],
    ['delegation owner Workspace', `SELECT delegation_id FROM task_workspaces
      GROUP BY delegation_id,owner_user_id HAVING COUNT(*)>1`],
    ['task Workspace conversation binding', `SELECT conversation_id FROM task_workspaces
      GROUP BY conversation_id HAVING COUNT(*)>1`],
  ];
  for (const [label, sql] of workspaceUniqueAudits) {
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM (${sql})`).get().count, 0, `${label} must be collision-free after repair`);
  }
  assert.equal(db.prepare("SELECT conversation_kind FROM conversations WHERE id='group_conversation:phase6_group'").get().conversation_kind, 'group');
  assert.equal(db.prepare("SELECT conversation_id FROM messages WHERE id='phase6_group_message'").get().conversation_id,
    'group_conversation:phase6_group');
  db.prepare(`INSERT INTO collaboration_group_messages(
    id,account_workspace_id,group_id,sender_user_id,kind,content,metadata_json
  ) VALUES('phase6_group_runtime_message','workspace_personal','phase6_group','local_admin','friend','GROUP_RUNTIME_MESSAGE','{}')`).run();
  const auth = new AuthService(db);
  const group = auth.collaborationGroup('phase6_group');
  assert.ok(group.messages.some((item) => item.content === 'GROUP_RUNTIME_MESSAGE'));
  assert.equal(db.prepare("SELECT conversation_id FROM messages WHERE id='phase6_group_runtime_message'").get().conversation_id,
    'group_conversation:phase6_group');
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');

  process.stdout.write('Conversation identity phase 6 smoke passed.\n');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
