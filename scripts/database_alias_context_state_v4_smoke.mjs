import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { inspectDatabaseHealth } from '../src/main/modules/persistence/index.js';
import { Store } from '../src/main/store.js';

const startupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-alias-context-v4-startup-'));
const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-alias-context-v4-repair-'));

try {
  const startupBefore = prepareNineNodeHistoricalFixture(startupRoot);
  const startupInspection = inspectDatabaseRecoveryStatus(startupRoot, { appVersion: '0.2.24' });
  assert.equal(startupInspection.repairable, true);
  assert.equal(startupInspection.structureIssues.filter((issue) => issue.code === 'missing_table').length, 3);
  assert.ok(startupInspection.health.checks.some((check) => check.ruleId === 'agent_alias_cycle' && check.count === 9));
  assert.ok(startupInspection.health.checks.some((check) => check.ruleId === 'message_context_agent_mismatch'),
    'health inspection must continue after missing optional single-window tables');

  let db = openDatabase(startupRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try { assertNineNodeFixtureRepaired(db, startupBefore); } finally { db.close(); }
  db = openDatabase(startupRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try { assertNineNodeFixtureRepaired(db, startupBefore); } finally { db.close(); }

  const repairBefore = prepareNineNodeHistoricalFixture(repairRoot);
  const repairInspection = inspectDatabaseRecoveryStatus(repairRoot, { appVersion: '0.2.24' });
  assert.equal(repairInspection.repairable, true);
  const repaired = repairDatabase(repairRoot, { appVersion: '0.2.24' });
  assert.equal(repaired.status, 'repaired');
  db = openDatabase(repairRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try { assertNineNodeFixtureRepaired(db, repairBefore); } finally { db.close(); }

  process.stdout.write('Database Alias/Context State v4 smoke passed.\n');
} finally {
  fs.rmSync(startupRoot, { recursive: true, force: true });
  fs.rmSync(repairRoot, { recursive: true, force: true });
}

function prepareNineNodeHistoricalFixture(root) {
  const db = openDatabase(root, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    const store = new Store(db, { root });
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('v4_user','v4@example.test','V4 User')").run();
    store.ensureAccountWorkspaces({ user: { id: 'v4_user', displayName: 'V4 User' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('v4_family','V4 Agent','active',1,'employee',1)").run();
    const insertInstance = db.prepare(`INSERT INTO user_agent_instances(
      id,user_id,agent_family_id,status,employment_state,authority_state,state_revision,created_at,updated_at
    ) VALUES(?,'v4_user','v4_family','active','active',?,?,?,?)`);
    const ids = 'abcdefghi'.split('').map((letter) => `v4_instance_${letter}`);
    ids.forEach((id, index) => insertInstance.run(
      id,
      index === 0 ? 'cloud_confirmed' : 'local_confirmed',
      index === 0 ? 20 : 10 - index,
      `2026-0${Math.min(index + 1, 9)}-01T00:00:00.000Z`,
      `2026-0${Math.min(index + 1, 9)}-02T00:00:00.000Z`,
    ));
    db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('v4_primary_conversation','workspace_personal','direct','v4_user','V4 primary','v4_family','v4_instance_c','active',
      '2026-07-01T00:00:00.000Z','2026-07-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('v4_history_conversation','workspace_personal','direct','v4_user','V4 history','v4_family','v4_instance_c','active',
      '2026-06-01T00:00:00.000Z','2026-06-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('v4_primary_session','v4_primary_conversation','v4_user','workspace_personal','V4 primary','general','v4_family',
      'v4_instance_c','primary','writable','active','2026-07-01T00:00:00.000Z','2026-07-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('v4_history_session','v4_history_conversation','v4_user','workspace_personal','V4 history','general','v4_family',
      'v4_instance_c','primary','writable','active','2026-06-01T00:00:00.000Z','2026-06-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,
      current_version_id,content_hash,created_at,updated_at)
      VALUES('v4_memory_a','v4_user','workspace_personal','v4_instance_a','v4_family','v4_memory_version_a','hash_a',
      '2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,
      current_version_id,content_hash,created_at,updated_at)
      VALUES('v4_memory_c','v4_user','workspace_personal','v4_instance_c','v4_family','v4_memory_version_c','hash_c',
      '2026-03-01T00:00:00.000Z','2026-03-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('v4_memory_version_a','v4_memory_a',1,'V4_MEMORY_A','hash_a','2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('v4_memory_version_c','v4_memory_c',1,'V4_MEMORY_C','hash_c','2026-03-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,created_at,updated_at)
      VALUES('v4_context_a','v4_user','workspace_personal','v4_instance_a','general_memory','v4_memory_a',
      '2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,created_at,updated_at)
      VALUES('v4_context_c','v4_user','workspace_personal','v4_instance_c','general_memory','v4_memory_c',
      '2026-03-02T00:00:00.000Z','2026-03-02T00:00:00.000Z')`).run();
    db.prepare("UPDATE memory_documents SET context_space_id='v4_context_a' WHERE id='v4_memory_a'").run();
    db.prepare("UPDATE memory_documents SET context_space_id='v4_context_c' WHERE id='v4_memory_c'").run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,memory_id,role,content,agent_id,
      agent_instance_id,context_space_id,created_at,updated_at)
      VALUES('v4_message','workspace_personal','v4_history_conversation','v4_history_session','v4_memory_c','assistant',
      'V4_MESSAGE_PRESERVED','v4_family','v4_instance_c','v4_context_c','2026-07-04T00:00:00.000Z','2026-07-04T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id)
      VALUES('v4_user','workspace_personal','v4_instance_a')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id,primary_session_id,
      active_context_space_id,active_memory_document_id)
      VALUES('v4_user','workspace_personal','v4_instance_c','v4_primary_session','v4_context_c','v4_memory_c')`).run();
    db.prepare(`INSERT INTO agent_device_context_state(device_id,user_id,account_workspace_id,user_agent_instance_id)
      VALUES('v4_device','v4_user','workspace_personal','v4_instance_a')`).run();
    db.prepare(`INSERT INTO agent_device_context_state(device_id,user_id,account_workspace_id,user_agent_instance_id,
      primary_session_id,active_context_space_id,active_memory_document_id)
      VALUES('v4_device','v4_user','workspace_personal','v4_instance_c','v4_primary_session','v4_context_c','v4_memory_c')`).run();
    db.prepare(`INSERT INTO agent_delegations(id,account_workspace_id,requester_user_id,recipient_user_id,sender_agent_id,
      recipient_agent_id,title,instruction,status,session_id,metadata_json,created_at,updated_at,started_at,completed_at)
      VALUES('v4_delegation','workspace_personal','v4_user','v4_user','secretary_agent','v4_family','V4 delegated task',
      'Preserve delegation history','completed','v4_history_session',
      '{"publicTag":"preserve","intakeSummary":{"summary":"private"},"workspaceRepairedAt":"2026-07-05T00:00:00.000Z"}','2026-06-01T00:00:00.000Z',
      '2026-07-05T00:00:00.000Z','2026-06-01T00:01:00.000Z','2026-07-05T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_delegation_workspaces(delegation_id,user_id,session_id,metadata_json,created_at,updated_at)
      VALUES('v4_delegation','v4_user','v4_history_session','{"existingPrivate":"preserve","workspaceRepairedAt":"2026-07-04T00:00:00.000Z"}',
      '2026-06-01T00:00:00.000Z','2026-07-05T00:00:00.000Z')`).run();
    const insertAlias = db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES(?,?,'v4_user','nine_node_historical_fixture')`);
    ids.forEach((id, index) => insertAlias.run(id, ids[(index + 1) % ids.length]));

    const before = {
      message: { ...db.prepare("SELECT id,role,content,created_at FROM messages WHERE id='v4_message'").get() },
      sessions: Number(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='v4_user'").get().count),
      memories: Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='v4_user'").get().count),
      versions: Number(db.prepare("SELECT COUNT(*) count FROM memory_document_versions WHERE id LIKE 'v4_memory_version_%'").get().count),
      delegations: Number(db.prepare("SELECT COUNT(*) count FROM agent_delegations WHERE id='v4_delegation'").get().count),
    };
    db.exec(`DROP TABLE agent_conversation_timeline_refs;
      DROP TABLE agent_conversation_thread_lineage;
      DROP TABLE agent_conversation_branch_state;`);
    db.prepare(`DELETE FROM schema_migrations WHERE id IN (
      'workspace_context_conversation_continuity_v1','social_contact_labels_v1','ubuddy_capability_profile_social_v1','agent_alias_context_state_repair_v4',
      'agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3',
      'ubuddy_profile_history_v1','profile_update_outbox_v1'
    )`).run();
    return before;
  } finally {
    db.close();
  }
}

function assertNineNodeFixtureRepaired(db, before) {
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='agent_alias_context_state_repair_v4'").get().count), 1);
  for (const table of ['agent_conversation_branch_state', 'agent_conversation_thread_lineage', 'agent_conversation_timeline_refs']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='v4_instance_a'").get().count), 0);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM user_agent_instance_aliases
    WHERE alias_instance_id IN ('v4_instance_b','v4_instance_c','v4_instance_d','v4_instance_e','v4_instance_f','v4_instance_g','v4_instance_h','v4_instance_i')
      AND canonical_instance_id='v4_instance_a'`).get().count), 8);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM user_agent_instances
    WHERE id IN ('v4_instance_b','v4_instance_c','v4_instance_d','v4_instance_e','v4_instance_f','v4_instance_g','v4_instance_h','v4_instance_i')
      AND status='inactive' AND employment_state='inactive' AND sync_enabled=0`).get().count), 8);
  assert.deepEqual({ ...db.prepare(`SELECT user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
    FROM agent_context_state WHERE user_id='v4_user' AND account_workspace_id='workspace_personal'`).get() }, {
    user_agent_instance_id: 'v4_instance_a', primary_session_id: 'v4_primary_session',
    active_context_space_id: 'v4_context_a', active_memory_document_id: 'v4_memory_a',
  });
  assert.deepEqual({ ...db.prepare(`SELECT user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
    FROM agent_device_context_state WHERE device_id='v4_device' AND account_workspace_id='workspace_personal'`).get() }, {
    user_agent_instance_id: 'v4_instance_a', primary_session_id: 'v4_primary_session',
    active_context_space_id: 'v4_context_a', active_memory_document_id: 'v4_memory_a',
  });
  assert.deepEqual({ ...db.prepare("SELECT id,role,content,created_at FROM messages WHERE id='v4_message'").get() }, before.message);
  assert.deepEqual({ ...db.prepare("SELECT session_id,conversation_id,agent_instance_id,context_space_id,memory_id FROM messages WHERE id='v4_message'").get() }, {
    session_id: 'v4_primary_session', conversation_id: 'v4_primary_conversation', agent_instance_id: 'v4_instance_a',
    context_space_id: 'v4_context_a', memory_id: 'v4_memory_a',
  });
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='v4_user'").get().count), before.sessions);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='v4_user'").get().count), before.memories);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_document_versions WHERE memory_document_id='v4_memory_a'").get().count), before.versions);
  assert.deepEqual({ ...db.prepare("SELECT conversation_role,write_state,superseded_by_session_id FROM sessions WHERE id='v4_history_session'").get() }, {
    conversation_role: 'history', write_state: 'read_only', superseded_by_session_id: 'v4_primary_session',
  });
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_delegations WHERE id='v4_delegation'").get().count), before.delegations);
  assert.deepEqual({ ...db.prepare("SELECT session_id,metadata_json FROM agent_delegations WHERE id='v4_delegation'").get() }, {
    session_id: 'v4_primary_session',
    metadata_json: '{"publicTag":"preserve","workspaceRepairedAt":"2026-07-05T00:00:00.000Z"}',
  });
  const workspace = db.prepare(`SELECT session_id,metadata_json FROM agent_delegation_workspaces
    WHERE delegation_id='v4_delegation' AND user_id='v4_user'`).get();
  assert.equal(workspace.session_id, 'v4_primary_session');
  assert.deepEqual(JSON.parse(workspace.metadata_json), {
    intakeSummary: { summary: 'private' }, existingPrivate: 'preserve',
    workspaceRepairedAt: '2026-07-04T00:00:00.000Z',
  });
}
