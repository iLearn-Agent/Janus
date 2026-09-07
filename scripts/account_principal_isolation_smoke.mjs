import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AuthService } from '../src/main/auth.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-account-principal-isolation-'));
const databasePath = path.join(root, 'data', 'janus.db');
let db;

try {
  db = openDatabase(root, { skipMigrationBackup: true });
  let auth = new AuthService(db);
  let store = new Store(db, { root });
  const owner = auth.requireUser();

  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,password_hash,email_verified,auth_provider)
    VALUES('isolation_principal','principal@isolation.test','第二登录用户','isolation_principal','password-hash',1,'local')`).run();
  db.prepare(`INSERT INTO auth_users(id,email,display_name,username,password_hash,email_verified,auth_provider)
    VALUES('isolation_contact','contact@isolation.test','仅联系人','isolation_contact','',1,'cloud')`).run();
  auth.setActiveUser('isolation_principal');
  auth.setActiveUser(owner.id);
  db.prepare(`INSERT INTO friendships(id,user_a_id,user_b_id,status)
    VALUES('isolation_friendship',?,?,'accepted')`).run('isolation_contact', owner.id);

  db.prepare(`INSERT INTO contact_organizations(
      id,organization_number,name,verification_code_salt,verification_code_hash,owner_user_id
    ) VALUES('isolation_org','ISOLATION-ORG','隔离验收组织','salt','hash',?)`).run(owner.id);
  db.prepare(`INSERT INTO contact_organization_members(organization_id,user_id,role)
    VALUES('isolation_org',?,'owner'),('isolation_org','isolation_contact','member')`).run(owner.id);
  store.ensureAccountWorkspaces({ user: owner });
  const organizationWorkspaceId = 'workspace_org_isolation_org';

  db.prepare(`INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable)
    VALUES('isolation_agent','隔离 Agent','active',1,'employee',1)`).run();
  db.prepare(`INSERT INTO agent_versions(id,agent_family_id,content_hash,status)
    VALUES('isolation_agent_v1','isolation_agent','isolation-agent-v1','active')`).run();
  db.prepare(`INSERT INTO user_agent_instances(
      id,user_id,agent_family_id,base_agent_version_id,status,employment_state,display_name
    ) VALUES('isolation_agent_instance',?,'isolation_agent','isolation_agent_v1','active','active','隔离 Agent')`).run(owner.id);

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });
  const personalSession = store.createSession({
    userId: owner.id, title: '个人 Agent 会话', agentId: 'isolation_agent', agentInstanceId: 'isolation_agent_instance',
  });
  const personalAgentMessage = store.addMessage({
    sessionId: personalSession.id, role: 'user', content: 'PERSONAL_AGENT_SECURITY_DOMAIN',
    agentId: 'isolation_agent', agentInstanceId: 'isolation_agent_instance', departmentId: 'general',
  });
  const personalDirect = auth.socialSendMessage({
    recipientId: 'isolation_contact', content: 'PERSONAL_DIRECT_SECURITY_DOMAIN', workspaceId: 'workspace_personal',
  });
  const personalGroup = auth.createChatGroup({
    groupId: 'isolation_personal_group', clientRequestId: 'isolation-personal-group-create', title: '个人群聊',
    memberIds: ['isolation_contact'], workspaceId: 'workspace_personal',
  });
  auth.sendChatGroupMessage({
    groupId: personalGroup.group.id, clientMessageId: 'isolation_personal_group_message',
    content: 'PERSONAL_GROUP_SECURITY_DOMAIN', workspaceId: 'workspace_personal',
  });

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: organizationWorkspaceId });
  const organizationSession = store.createSession({
    userId: owner.id, title: '组织 Agent 会话', agentId: 'isolation_agent', agentInstanceId: 'isolation_agent_instance',
  });
  const organizationAgentMessage = store.addMessage({
    sessionId: organizationSession.id, role: 'assistant', content: 'ORGANIZATION_AGENT_SECURITY_DOMAIN',
    agentId: 'isolation_agent', agentInstanceId: 'isolation_agent_instance', departmentId: 'general',
  });
  const organizationDirect = auth.socialSendMessage({
    recipientId: 'isolation_contact', content: 'ORGANIZATION_DIRECT_SECURITY_DOMAIN', workspaceId: organizationWorkspaceId,
  });
  const organizationGroup = auth.createChatGroup({
    groupId: 'isolation_organization_group', clientRequestId: 'isolation-organization-group-create', title: '组织群聊',
    memberIds: ['isolation_contact'], workspaceId: organizationWorkspaceId,
  });
  auth.sendChatGroupMessage({
    groupId: organizationGroup.group.id, clientMessageId: 'isolation_organization_group_message',
    content: 'ORGANIZATION_GROUP_SECURITY_DOMAIN', workspaceId: organizationWorkspaceId,
  });

  const before = preservationSnapshot(db);
  assert.equal(before.socialMessages.length, 2);
  assert.equal(before.agentMessages.length, 2);
  assert.equal(before.groupMessages.length, 2);
  db.close();
  db = null;

  downgradeToAccountPrincipalV25Fixture(databasePath);

  db = openDatabase(root);
  auth = new AuthService(db);
  store = new Store(db, { root });
  const afterMigration = preservationSnapshot(db);
  assert.deepEqual(afterMigration, before, 'the 0.2.25 -> 0.2.26 migration must preserve exact message fingerprints');
  assert.ok(db.migrationBackup?.backupPath, 'a historical upgrade must create and pin a migration backup');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='account_principal_isolation_v1'").get().count, 1);

  assert.deepEqual(db.prepare(`SELECT id,account_kind,status FROM accounts
    WHERE id IN ('account_personal_local_admin','account_personal_isolation_principal') ORDER BY id`).all().map((row) => ({ ...row })), [
    { id: 'account_personal_isolation_principal', account_kind: 'personal', status: 'active' },
    { id: 'account_personal_local_admin', account_kind: 'personal', status: 'active' },
  ]);
  assert.equal(db.prepare("SELECT status FROM accounts WHERE id='account_personal_isolation_contact'").get().status, 'external',
    'a contact projection must not become an authenticatable principal');
  assert.equal(db.prepare("SELECT COUNT(*) count FROM auth_principals WHERE user_id='isolation_contact'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM auth_principals WHERE user_id IN ('local_admin','isolation_principal')").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM accounts WHERE id='account_org_isolation_org' AND account_kind='organization'").get().count, 1);

  const directDomains = db.prepare(`SELECT message.content,message.conversation_id,conversation.conversation_kind,
      conversation.anchor_account_id
    FROM social_messages message JOIN social_direct_conversations conversation ON conversation.id=message.conversation_id
    WHERE message.id IN (?,?) ORDER BY message.content`).all(personalDirect.message.id, organizationDirect.message.id);
  assert.equal(new Set(directDomains.map((row) => row.conversation_id)).size, 2,
    'the same peer must have different personal and organization direct-conversation security domains');
  assert.deepEqual(directDomains.map((row) => row.conversation_kind).sort(), ['organization_direct', 'personal_direct']);
  assert.equal(directDomains.find((row) => row.conversation_kind === 'organization_direct').anchor_account_id, 'account_org_isolation_org');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM conversation_account_bindings
    WHERE conversation_id=? AND account_id='account_org_isolation_org' AND binding_role='anchor' AND access_status='active'`).get(
    organizationDirect.message.conversationId,
  ).count, 1);

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: 'workspace_personal' });
  assert.deepEqual(auth.socialConversation({ peerId: 'isolation_contact' }).map((message) => message.content), ['PERSONAL_DIRECT_SECURITY_DOMAIN']);
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === personalGroup.group.id), true);
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === organizationGroup.group.id), false);
  let timeline = store.listAgentConversationTimeline({ userId: owner.id, agentInstanceId: 'isolation_agent_instance' });
  assert.equal(timeline.windowId, 'account:workspace_personal:agent:isolation_agent_instance');
  assert.equal(timeline.items.some((item) => item.content === personalAgentMessage.content), true);
  assert.equal(timeline.items.some((item) => item.content === organizationAgentMessage.content), false);

  store.switchAccountWorkspace({ userId: owner.id, workspaceId: organizationWorkspaceId });
  assert.deepEqual(auth.socialConversation({ peerId: 'isolation_contact' }).map((message) => message.content), ['ORGANIZATION_DIRECT_SECURITY_DOMAIN']);
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === organizationGroup.group.id), true);
  assert.equal(auth.chatGroupsOverview().groups.some((group) => group.id === personalGroup.group.id), false);
  timeline = store.listAgentConversationTimeline({ userId: owner.id, agentInstanceId: 'isolation_agent_instance' });
  assert.equal(timeline.windowId, `account:${organizationWorkspaceId}:agent:isolation_agent_instance`);
  assert.equal(timeline.items.some((item) => item.content === organizationAgentMessage.content), true);
  assert.equal(timeline.items.some((item) => item.content === personalAgentMessage.content), false);

  assert.equal(db.prepare(`SELECT COUNT(*) count FROM account_agent_instances
    WHERE agent_instance_id='isolation_agent_instance' AND account_id IN ('account_personal_local_admin','account_org_isolation_org')`).get().count, 2);
  assert.throws(() => db.prepare(`INSERT INTO social_messages(
      id,account_workspace_id,conversation_id,sender_user_id,recipient_user_id,content
    ) VALUES('isolation_missing_domain','workspace_personal','','local_admin','isolation_contact','must fail')`).run(),
  /social message security domain is required/);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const projectionBeforeSecondOpen = accountProjectionSnapshot(db);
  db.close();
  db = openDatabase(root, { skipMigrationBackup: true });
  assert.deepEqual(preservationSnapshot(db), before, 'a second open must preserve exact content and timestamps');
  assert.deepEqual(accountProjectionSnapshot(db), projectionBeforeSecondOpen, 'a second open must not duplicate or rewrite Account projections');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  console.log(JSON.stringify({
    ok: true,
    historicalBaseline: '0.2.25',
    migration: 'account_principal_isolation_v1',
    exactMessageFingerprintPreserved: true,
    secondOpenIdempotent: true,
    personalAndOrganizationDirectDomainsDistinct: true,
    groupIsolationEnforced: true,
    agentTimelineIsolationEnforced: true,
    securityDomainTriggerEnforced: true,
    authenticatablePrincipalsSeparatedFromContacts: true,
  }, null, 2));
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function preservationSnapshot(database) {
  const agentMessages = database.prepare(`SELECT id,session_id,conversation_id,account_workspace_id,role,content,created_at
    FROM messages WHERE content IN ('PERSONAL_AGENT_SECURITY_DOMAIN','ORGANIZATION_AGENT_SECURITY_DOMAIN') ORDER BY id`).all();
  const socialMessages = database.prepare(`SELECT id,account_workspace_id,sender_user_id,recipient_user_id,kind,title,content,status,
      delivery_status,remote_id,metadata_json,created_at,updated_at,read_at
    FROM social_messages WHERE content IN ('PERSONAL_DIRECT_SECURITY_DOMAIN','ORGANIZATION_DIRECT_SECURITY_DOMAIN') ORDER BY id`).all();
  const groupMessages = database.prepare(`SELECT id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,
      metadata_json,source_event_id,created_at,updated_at
    FROM chat_group_messages WHERE id IN ('isolation_personal_group_message','isolation_organization_group_message') ORDER BY id`).all();
  return {
    agentMessages,
    socialMessages,
    groupMessages,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify({ agentMessages, socialMessages, groupMessages })).digest('hex'),
  };
}

function accountProjectionSnapshot(database) {
  return {
    accounts: database.prepare('SELECT * FROM accounts ORDER BY id').all(),
    principals: database.prepare('SELECT * FROM auth_principals ORDER BY id').all(),
    memberships: database.prepare('SELECT * FROM account_memberships ORDER BY account_id,user_id').all(),
    workspaces: database.prepare('SELECT * FROM account_workspace_bindings ORDER BY account_id,workspace_id,user_id_scope').all(),
    conversations: database.prepare('SELECT * FROM conversation_account_bindings ORDER BY conversation_id,account_id').all(),
    directConversations: database.prepare('SELECT * FROM social_direct_conversations ORDER BY id').all(),
    agents: database.prepare('SELECT * FROM account_agent_instances ORDER BY account_id,agent_instance_id').all(),
  };
}

function downgradeToAccountPrincipalV25Fixture(filePath) {
  const legacy = new DatabaseSync(filePath);
  try {
    legacy.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER IF EXISTS trg_social_messages_security_domain_insert;
      DROP TRIGGER IF EXISTS trg_social_messages_security_domain_update;
      DROP INDEX IF EXISTS idx_social_messages_conversation;
      ALTER TABLE social_messages RENAME TO social_messages_account_v26;
      CREATE TABLE social_messages (
        id TEXT PRIMARY KEY,
        account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',
        sender_user_id TEXT NOT NULL DEFAULT '',
        recipient_user_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL DEFAULT '',
        recipient_agent_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'friend',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unread',
        delivery_status TEXT NOT NULL DEFAULT 'local',
        remote_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        read_at TEXT
      );
      INSERT INTO social_messages(
        id,account_workspace_id,sender_user_id,recipient_user_id,sender_agent_id,recipient_agent_id,kind,title,content,status,
        delivery_status,remote_id,metadata_json,created_at,updated_at,read_at
      ) SELECT id,account_workspace_id,sender_user_id,recipient_user_id,sender_agent_id,recipient_agent_id,kind,title,content,status,
        delivery_status,remote_id,metadata_json,created_at,updated_at,read_at FROM social_messages_account_v26;
      DROP TABLE social_messages_account_v26;
      CREATE INDEX idx_social_messages_recipient ON social_messages(recipient_user_id,status,created_at);
      CREATE INDEX idx_social_messages_sender ON social_messages(sender_user_id,created_at);
      CREATE INDEX idx_social_messages_account_workspace ON social_messages(account_workspace_id,recipient_user_id,status,created_at);
      DROP TABLE conversation_account_bindings;
      DROP TABLE social_direct_conversations;
      DROP TABLE account_agent_instances;
      DROP TABLE account_workspace_bindings;
      DROP TABLE account_memberships;
      DROP TABLE auth_principals;
      DROP TABLE accounts;
      DELETE FROM schema_migrations WHERE id='account_principal_isolation_v1';`);
    assert.equal(legacy.prepare("SELECT COUNT(*) count FROM pragma_table_info('social_messages') WHERE name='conversation_id'").get().count, 0);
    assert.equal(legacy.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='account_principal_isolation_v1'").get().count, 0);
  } finally {
    legacy.close();
  }
}
