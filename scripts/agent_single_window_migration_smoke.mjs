import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { dbPath } from '../src/main/paths.js';
import { inspectDatabaseHealth } from '../src/main/modules/persistence/index.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-migration-'));
const workloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-workload-'));
const workloadRepairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-workload-repair-'));
const unsafeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-cycle-'));
const transitiveCycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-transitive-cycle-'));
const crossFamilyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-cross-family-cycle-'));
const safeCycleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-single-window-safe-cycle-'));
const aliasContextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-alias-context-'));
const aliasContextCollisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-alias-context-collision-'));
const aliasContextMismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-alias-context-mismatch-'));

try {
  const before = prepareMergeFixture(root);
  let db = openDatabase(root, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    const sessions = db.prepare(`SELECT id,conversation_id,conversation_role,write_state,superseded_by_session_id,codex_thread_id
      FROM sessions WHERE id IN ('single_window_primary','single_window_loser') ORDER BY id`).all();
    assert.deepEqual(sessions.map((row) => ({ ...row })), [
      {
        id: 'single_window_loser', conversation_id: 'single_window_primary', conversation_role: 'history',
        write_state: 'read_only', superseded_by_session_id: 'single_window_primary', codex_thread_id: '',
      },
      {
        id: 'single_window_primary', conversation_id: 'single_window_primary', conversation_role: 'primary',
        write_state: 'writable', superseded_by_session_id: '', codex_thread_id: '',
      },
    ]);
    assert.deepEqual(db.prepare(`SELECT id,conversation_id,session_id,role,content,created_at FROM messages
      WHERE id IN ('single_window_message_primary','single_window_message_loser') ORDER BY id`).all().map((row) => ({ ...row })), [
      {
        id: 'single_window_message_loser', conversation_id: 'single_window_primary', session_id: 'single_window_loser',
        role: 'assistant', content: 'LOSER_HISTORY_PRESERVED', created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'single_window_message_primary', conversation_id: 'single_window_primary', session_id: 'single_window_primary',
        role: 'user', content: 'PRIMARY_HISTORY_PRESERVED', created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    assert.equal(db.prepare("SELECT conversation_id FROM conversation_aliases WHERE alias_id='single_window_loser'").get().conversation_id, 'single_window_primary');
    assert.equal(db.prepare("SELECT status FROM conversations WHERE id='single_window_loser'").get().status, 'deleted');
    assert.equal(db.prepare("SELECT conversation_id FROM message_attachments WHERE message_id='single_window_message_loser'").get().conversation_id, 'single_window_primary');
    assert.equal(db.prepare("SELECT conversation_id FROM model_executions WHERE id='single_window_execution'").get().conversation_id, 'single_window_primary');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_conversation_thread_lineage WHERE conversation_id='single_window_primary'").get().count), 2);
    const branch = db.prepare(`SELECT * FROM agent_conversation_branch_state
      WHERE user_id='single_window_user' AND account_workspace_id='workspace_personal' AND agent_instance_id='single_window_instance'`).get();
    assert.equal(branch.primary_session_id, 'single_window_primary');
    assert.equal(branch.conversation_id, 'single_window_primary');
    assert.equal(Number(branch.rebuild_required), 1);
    assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM agent_conversation_timeline_refs
      WHERE user_id='single_window_user' AND agent_instance_id='single_window_instance'`).get().count), 2);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
    assert.deepEqual(coreInventory(db), before);
  } finally {
    db.close();
  }

  db = openDatabase(root, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assert.deepEqual(coreInventory(db), before, 'a second open must preserve the exact core inventory');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='agent_single_window_continuity_v1'").get().count), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").get().count), 1);
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_conversation_thread_lineage WHERE conversation_id='single_window_primary'").get().count), 2);
  } finally {
    db.close();
  }

  const workloadBefore = prepareWorkloadPrimaryCollision(workloadRoot);
  db = openDatabase(workloadRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertWorkloadPrimaryCollisionRepaired(db, workloadBefore);
  } finally {
    db.close();
  }
  db = openDatabase(workloadRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertWorkloadPrimaryCollisionRepaired(db, workloadBefore);
  } finally {
    db.close();
  }

  const workloadRepairBefore = prepareWorkloadPrimaryCollision(workloadRepairRoot);
  const repairInspection = inspectDatabaseRecoveryStatus(workloadRepairRoot, { appVersion: '0.2.24' });
  assert.equal(repairInspection.repairable, true);
  assert.ok(repairInspection.pendingMigrationIds.includes('agent_single_window_continuity_v1'));
  assert.equal(repairDatabase(workloadRepairRoot, { appVersion: '0.2.24' }).status, 'repaired');
  db = openDatabase(workloadRepairRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertWorkloadPrimaryCollisionRepaired(db, workloadRepairBefore);
  } finally {
    db.close();
  }

  prepareUnsafeAliasCycle(unsafeRoot);
  const cycleInspection = inspectDatabaseRecoveryStatus(unsafeRoot, { appVersion: '0.2.24' });
  assert.ok(cycleInspection.health.violationCount > 0, 'recovery inspection must surface alias cycles while migrations are pending');
  db = openDatabase(unsafeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assert.equal(db.prepare("SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id='cycle_instance_b'").get().canonical_instance_id, 'cycle_instance_a');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='cycle_instance_a'").get().count), 0);
    assert.deepEqual({ ...db.prepare("SELECT status,employment_state,sync_enabled FROM user_agent_instances WHERE id='cycle_instance_b'").get() },
      { status: 'inactive', employment_state: 'inactive', sync_enabled: 0 });
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instances WHERE id IN ('cycle_instance_a','cycle_instance_b')").get().count), 2,
      'canonicalization must retain the loser Agent row as inactive history');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_identity_migration_quarantine WHERE source_id='cycle_instance_b' AND reason='agent_alias_cycle_canonicalized'").get().count), 1);
    assert.deepEqual({ ...db.prepare("SELECT lifecycle_state,sync_enabled,current_version_id FROM memory_documents WHERE id='cycle_memory_b'").get() },
      { lifecycle_state: 'archived', sync_enabled: 0, current_version_id: '' });
    assert.equal(db.prepare("SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id='cycle_memory_b'").get().canonical_document_id, 'cycle_memory_a');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE id IN ('cycle_memory_a','cycle_memory_b')").get().count), 2);
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_document_versions WHERE id IN ('cycle_memory_version_a','cycle_memory_version_b') AND memory_document_id='cycle_memory_a'").get().count), 2);
    assert.equal(db.prepare("SELECT current_version_id FROM memory_documents WHERE id='cycle_memory_a'").get().current_version_id, 'cycle_memory_version_b');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").get().count), 3);
    assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  } finally {
    db.close();
  }
  db = openDatabase(unsafeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_identity_migration_quarantine WHERE source_id='cycle_instance_b' AND reason='agent_alias_cycle_canonicalized'").get().count), 1);
    assert.equal(db.prepare("SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id='cycle_instance_b'").get().canonical_instance_id, 'cycle_instance_a');
  } finally { db.close(); }

  const transitiveCycleBefore = prepareTransitiveAliasCycle(transitiveCycleRoot);
  const transitiveInspection = inspectDatabaseRecoveryStatus(transitiveCycleRoot, { appVersion: '0.2.24' });
  assert.equal(transitiveInspection.repairable, true);
  assert.ok(transitiveInspection.health.checks.some((check) => check.ruleId === 'agent_alias_cycle' && check.count > 0));
  assert.equal(repairDatabase(transitiveCycleRoot, { appVersion: '0.2.24' }).status, 'repaired');
  db = openDatabase(transitiveCycleRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertTransitiveAliasCycleRepaired(db, transitiveCycleBefore);
  } finally {
    db.close();
  }
  db = openDatabase(transitiveCycleRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertTransitiveAliasCycleRepaired(db, transitiveCycleBefore);
  } finally {
    db.close();
  }

  prepareCrossFamilyAliasCycle(crossFamilyRoot);
  const crossFamilyInspection = inspectDatabaseRecoveryStatus(crossFamilyRoot, { appVersion: '0.2.24' });
  assert.equal(crossFamilyInspection.status, 'manual');
  assert.equal(crossFamilyInspection.repairable, false);
  assert.ok(crossFamilyInspection.health.checks.some((check) => check.ruleId === 'agent_alias_boundary_cycle' && check.count > 0));
  assert.throws(() => openDatabase(crossFamilyRoot, { appVersion: '0.2.24', skipMigrationBackup: true }),
    /crosses user or Agent family boundaries|Shadow database migration preflight failed/);
  const raw = new DatabaseSync(dbPath(crossFamilyRoot));
  try {
    assert.equal(Number(raw.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").get().count), 0,
      'a rejected cross-family cycle must leave the active database unmigrated');
    assert.equal(Number(raw.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id IN ('cross_cycle_a','cross_cycle_b')").get().count), 2);
  } finally { raw.close(); }

  prepareSafeAliasCycle(safeCycleRoot);
  db = openDatabase(safeCycleRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assert.equal(db.prepare("SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id='safe_cycle_alias'").get().canonical_instance_id, 'safe_cycle_instance');
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='safe_cycle_instance'").get().count), 0);
    assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  } finally {
    db.close();
  }

  const aliasContextBefore = prepareAliasContextFixture(aliasContextRoot, { collision: false });
  const aliasContextInspection = inspectDatabaseRecoveryStatus(aliasContextRoot, { appVersion: '0.2.24' });
  assert.equal(aliasContextInspection.repairable, true);
  assert.ok(aliasContextInspection.pendingMigrationIds.includes('agent_alias_context_reference_repair_v3'));
  assert.equal(repairDatabase(aliasContextRoot, { appVersion: '0.2.24' }).status, 'repaired');
  db = openDatabase(aliasContextRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertAliasContextFixtureRepaired(db, aliasContextBefore, { collision: false });
  } finally {
    db.close();
  }
  db = openDatabase(aliasContextRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertAliasContextFixtureRepaired(db, aliasContextBefore, { collision: false });
  } finally {
    db.close();
  }

  const aliasCollisionBefore = prepareAliasContextFixture(aliasContextCollisionRoot, { collision: true });
  db = openDatabase(aliasContextCollisionRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertAliasContextFixtureRepaired(db, aliasCollisionBefore, { collision: true });
  } finally {
    db.close();
  }
  db = openDatabase(aliasContextCollisionRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    assertAliasContextFixtureRepaired(db, aliasCollisionBefore, { collision: true });
  } finally {
    db.close();
  }

  const mismatchBefore = prepareAliasContextMismatchFixture(aliasContextMismatchRoot);
  assert.throws(() => openDatabase(aliasContextMismatchRoot, { appVersion: '0.2.24', skipMigrationBackup: true }),
    /message_context_agent_mismatch|Shadow database migration preflight failed/);
  const mismatchRaw = new DatabaseSync(dbPath(aliasContextMismatchRoot));
  try {
    assert.deepEqual(aliasContextMismatchFingerprint(mismatchRaw), mismatchBefore,
      'failed shadow preflight must leave the active message and Context unchanged');
    assert.equal(Number(mismatchRaw.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").get().count), 0);
  } finally {
    mismatchRaw.close();
  }

  process.stdout.write('Agent single-window migration preservation smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(workloadRoot, { recursive: true, force: true });
  fs.rmSync(workloadRepairRoot, { recursive: true, force: true });
  fs.rmSync(unsafeRoot, { recursive: true, force: true });
  fs.rmSync(transitiveCycleRoot, { recursive: true, force: true });
  fs.rmSync(crossFamilyRoot, { recursive: true, force: true });
  fs.rmSync(safeCycleRoot, { recursive: true, force: true });
  fs.rmSync(aliasContextRoot, { recursive: true, force: true });
  fs.rmSync(aliasContextCollisionRoot, { recursive: true, force: true });
  fs.rmSync(aliasContextMismatchRoot, { recursive: true, force: true });
}

function prepareWorkloadPrimaryCollision(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    const store = new Store(db, { root: runtimeRoot });
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('workload_user','workload@example.test','Workload')").run();
    store.ensureAccountWorkspaces({ user: { id: 'workload_user', displayName: 'Workload' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('workload_family','Workload Agent','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('workload_instance','workload_user','workload_family','active')").run();
    db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('workload_task_session','workload_task_conversation','workload_user','workspace_personal','Task workspace',
      'agent_delegation','workload_family','workload_instance','primary','writable','active',
      '2026-03-01T00:00:00.000Z','2026-03-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('workload_direct_session','workload_direct_conversation','workload_user','workspace_personal','Direct Agent chat',
      'secretary_department','workload_family','workload_instance','standard','writable','active',
      '2026-04-01T00:00:00.000Z','2026-04-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('workload_task_conversation','workspace_personal','task_workspace','workload_user','Task workspace','workload_family',
      'workload_instance','active','2026-03-01T00:00:00.000Z','2026-03-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('workload_direct_conversation','workspace_personal','direct','workload_user','Direct Agent chat','workload_family',
      'workload_instance','active','2026-04-01T00:00:00.000Z','2026-04-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO task_workspaces(id,account_workspace_id,delegation_id,owner_user_id,conversation_id,status,created_at,updated_at)
      VALUES('workload_task_workspace','workspace_personal','workload_delegation','workload_user','workload_task_conversation','active',
      '2026-03-01T00:00:00.000Z','2026-03-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,task_workspace_id,role,content,agent_id,agent_instance_id,created_at,updated_at)
      VALUES('workload_task_message','workspace_personal','workload_task_conversation','workload_task_session','workload_task_workspace',
      'assistant','TASK_WORKSPACE_HISTORY_PRESERVED','workload_family','workload_instance','2026-03-01T01:00:00.000Z','2026-03-01T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,role,content,agent_id,agent_instance_id,created_at,updated_at)
      VALUES('workload_direct_message','workspace_personal','workload_direct_conversation','workload_direct_session','user',
      'DIRECT_CHAT_HISTORY_PRESERVED','workload_family','workload_instance','2026-04-01T01:00:00.000Z','2026-04-01T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO message_attachments(id,account_workspace_id,conversation_id,message_id,task_workspace_id,relation_type,name,created_at,updated_at)
      VALUES('workload_task_attachment','workspace_personal','workload_task_conversation','workload_task_message','workload_task_workspace',
      'attachment','task-preserved.txt','2026-03-01T01:00:00.000Z','2026-03-01T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO model_executions(id,user_id,account_workspace_id,conversation_id,agent_id,agent_instance_id,status,started_at,updated_at)
      VALUES('workload_task_execution','workload_user','workspace_personal','workload_task_conversation','workload_family',
      'workload_instance','completed','2026-03-01T01:00:00.000Z','2026-03-01T01:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id,primary_session_id)
      VALUES('workload_user','workspace_personal','workload_instance','workload_task_session')
      ON CONFLICT(user_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET primary_session_id=excluded.primary_session_id`).run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_alias_context_reference_repair_v3')").run();
    db.exec(`CREATE UNIQUE INDEX idx_sessions_one_primary_agent ON sessions(user_id,account_workspace_id,agent_instance_id)
      WHERE agent_instance_id!='' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`);
    return workloadInventory(db);
  } finally {
    db.close();
  }
}

function assertWorkloadPrimaryCollisionRepaired(db, before) {
  assert.deepEqual(db.prepare(`SELECT id,conversation_role,write_state,status FROM sessions
    WHERE id IN ('workload_task_session','workload_direct_session') ORDER BY id`).all().map((row) => ({ ...row })), [
    { id: 'workload_direct_session', conversation_role: 'primary', write_state: 'writable', status: 'active' },
    { id: 'workload_task_session', conversation_role: 'task_workspace', write_state: 'writable', status: 'active' },
  ]);
  assert.equal(db.prepare(`SELECT primary_session_id FROM agent_context_state
    WHERE user_id='workload_user' AND account_workspace_id='workspace_personal' AND user_agent_instance_id='workload_instance'`).get().primary_session_id,
  'workload_direct_session');
  assert.equal(db.prepare("SELECT status FROM task_workspaces WHERE id='workload_task_workspace'").get().status, 'active');
  assert.deepEqual(workloadInventory(db), before);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
}

function workloadInventory(db) {
  return {
    sessions: Number(db.prepare("SELECT COUNT(*) count FROM sessions WHERE id IN ('workload_task_session','workload_direct_session')").get().count),
    messages: db.prepare(`SELECT id,role,content,created_at FROM messages
      WHERE id IN ('workload_task_message','workload_direct_message') ORDER BY id`).all().map((row) => ({ ...row })),
    attachments: Number(db.prepare("SELECT COUNT(*) count FROM message_attachments WHERE id='workload_task_attachment'").get().count),
    executions: Number(db.prepare("SELECT COUNT(*) count FROM model_executions WHERE id='workload_task_execution'").get().count),
    taskWorkspaces: Number(db.prepare("SELECT COUNT(*) count FROM task_workspaces WHERE id='workload_task_workspace'").get().count),
  };
}

function prepareMergeFixture(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    const store = new Store(db, { root: runtimeRoot });
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('single_window_user','single-window@example.test','Single Window')").run();
    store.ensureAccountWorkspaces({ user: { id: 'single_window_user', displayName: 'Single Window' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('single_window_family','Single Window Agent','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('single_window_instance','single_window_user','single_window_family','active')").run();
    db.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      codex_thread_id,conversation_role,write_state,status,created_at,updated_at)
      VALUES('single_window_primary','single_window_primary','single_window_user','workspace_personal','Primary','general',
      'single_window_family','single_window_instance','thread_primary','primary','writable','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      codex_thread_id,conversation_role,write_state,status,created_at,updated_at)
      VALUES('single_window_loser','single_window_loser','single_window_user','workspace_personal','Loser','general',
      'single_window_family','single_window_instance','thread_loser','primary','writable','active','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    for (const id of ['single_window_primary', 'single_window_loser']) {
      db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'active',?,?)`).run(
        id, 'workspace_personal', 'direct', 'single_window_user', id, 'single_window_family', 'single_window_instance',
        id.endsWith('primary') ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z',
        id.endsWith('primary') ? '2026-01-01T00:00:00.000Z' : '2026-02-01T00:00:00.000Z',
      );
    }
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,role,content,agent_id,agent_instance_id,created_at,updated_at)
      VALUES('single_window_message_primary','workspace_personal','single_window_primary','single_window_primary','user',
      'PRIMARY_HISTORY_PRESERVED','single_window_family','single_window_instance','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,role,content,agent_id,agent_instance_id,created_at,updated_at)
      VALUES('single_window_message_loser','workspace_personal','single_window_loser','single_window_loser','assistant',
      'LOSER_HISTORY_PRESERVED','single_window_family','single_window_instance','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO message_attachments(id,account_workspace_id,conversation_id,message_id,relation_type,name,created_at,updated_at)
      VALUES('single_window_attachment','workspace_personal','single_window_loser','single_window_message_loser','attachment','preserved.txt',
      '2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO model_executions(id,user_id,account_workspace_id,conversation_id,agent_id,agent_instance_id,status,started_at,updated_at)
      VALUES('single_window_execution','single_window_user','workspace_personal','single_window_loser','single_window_family',
      'single_window_instance','completed','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id,primary_session_id)
      VALUES('single_window_user','workspace_personal','single_window_instance','single_window_primary')
      ON CONFLICT(user_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET primary_session_id=excluded.primary_session_id`).run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_alias_context_reference_repair_v3')").run();
    return coreInventory(db);
  } finally {
    db.close();
  }
}

function prepareUnsafeAliasCycle(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('cycle_user','cycle@example.test','Cycle')").run();
    new Store(db, { root: runtimeRoot }).ensureAccountWorkspaces({ user: { id: 'cycle_user', displayName: 'Cycle' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('cycle_family','Cycle','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision) VALUES('cycle_instance_a','cycle_user','cycle_family','active','local_confirmed',2)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision) VALUES('cycle_instance_b','cycle_user','cycle_family','active','cloud_confirmed',1)").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('cycle_instance_a','cycle_instance_b','cycle_user','fixture')").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('cycle_instance_b','cycle_instance_a','cycle_user','fixture')").run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,current_version_id,content_hash,updated_at)
      VALUES('cycle_memory_a','cycle_user','workspace_personal','cycle_instance_a','cycle_family','cycle_memory_version_a','hash_a','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,current_version_id,content_hash,updated_at)
      VALUES('cycle_memory_b','cycle_user','workspace_personal','cycle_instance_b','cycle_family','cycle_memory_version_b','hash_b','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('cycle_memory_version_a','cycle_memory_a',1,'MEMORY_A','hash_a','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('cycle_memory_version_b','cycle_memory_b',1,'MEMORY_B','hash_b','2026-02-01T00:00:00.000Z')`).run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").run();
  } finally {
    db.close();
  }
}

function prepareTransitiveAliasCycle(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('transitive_cycle_user','transitive-cycle@example.test','Transitive Cycle')").run();
    new Store(db, { root: runtimeRoot }).ensureAccountWorkspaces({
      user: { id: 'transitive_cycle_user', displayName: 'Transitive Cycle' },
    });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('transitive_cycle_family','Transitive Cycle','active',1,'employee',1)").run();
    db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision,created_at)
      VALUES('transitive_cycle_a','transitive_cycle_user','transitive_cycle_family','active','cloud_confirmed',5,'2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision,created_at)
      VALUES('transitive_cycle_b','transitive_cycle_user','transitive_cycle_family','active','local_confirmed',2,'2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision,created_at)
      VALUES('transitive_cycle_c','transitive_cycle_user','transitive_cycle_family','active','local_confirmed',1,'2026-03-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status,authority_state,state_revision,created_at)
      VALUES('transitive_cycle_d','transitive_cycle_user','transitive_cycle_family','active','local_confirmed',0,'2026-04-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES('transitive_cycle_a','transitive_cycle_b','transitive_cycle_user','fixture')`).run();
    db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES('transitive_cycle_b','transitive_cycle_c','transitive_cycle_user','fixture')`).run();
    db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES('transitive_cycle_c','transitive_cycle_d','transitive_cycle_user','fixture')`).run();
    db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES('transitive_cycle_d','transitive_cycle_a','transitive_cycle_user','fixture')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('transitive_cycle_session','transitive_cycle_conversation','transitive_cycle_user','workspace_personal','Cycle history',
      'transitive_cycle_family','transitive_cycle_c','primary','writable','active','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('transitive_cycle_conversation','workspace_personal','direct','transitive_cycle_user','Cycle history',
      'transitive_cycle_family','transitive_cycle_c','active','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,current_version_id,
      content_hash,created_at,updated_at) VALUES('transitive_cycle_memory_a','transitive_cycle_user','workspace_personal',
      'transitive_cycle_a','transitive_cycle_family','transitive_cycle_version_a','hash_a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,current_version_id,
      content_hash,created_at,updated_at) VALUES('transitive_cycle_memory_b','transitive_cycle_user','workspace_personal',
      'transitive_cycle_c','transitive_cycle_family','transitive_cycle_version_b','hash_b','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('transitive_cycle_version_a','transitive_cycle_memory_a',1,'TRANSITIVE_A','hash_a','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('transitive_cycle_version_b','transitive_cycle_memory_b',1,'TRANSITIVE_B','hash_b','2026-02-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,
      created_at,updated_at) VALUES('transitive_cycle_context_a','transitive_cycle_user','workspace_personal','transitive_cycle_a',
      'general_memory','transitive_cycle_memory_a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,
      created_at,updated_at) VALUES('transitive_cycle_context_b','transitive_cycle_user','workspace_personal','transitive_cycle_c',
      'general_memory','transitive_cycle_memory_b','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')`).run();
    db.prepare("UPDATE memory_documents SET context_space_id='transitive_cycle_context_a' WHERE id='transitive_cycle_memory_a'").run();
    db.prepare("UPDATE memory_documents SET context_space_id='transitive_cycle_context_b' WHERE id='transitive_cycle_memory_b'").run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,memory_id,role,content,agent_id,
      agent_instance_id,context_space_id,created_at,updated_at) VALUES('transitive_cycle_message','workspace_personal',
      'transitive_cycle_conversation','transitive_cycle_session','transitive_cycle_memory_b','assistant','TRANSITIVE_MESSAGE_PRESERVED',
      'transitive_cycle_family','transitive_cycle_c','transitive_cycle_context_b','2026-04-02T00:00:00.000Z','2026-04-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id,primary_session_id,
      active_context_space_id,active_memory_document_id) VALUES('transitive_cycle_user','workspace_personal','transitive_cycle_c',
      'transitive_cycle_session','transitive_cycle_context_b','transitive_cycle_memory_b')`).run();
    db.prepare(`INSERT INTO agent_device_context_state(device_id,user_id,account_workspace_id,user_agent_instance_id)
      VALUES('transitive_cycle_device','transitive_cycle_user','workspace_personal','transitive_cycle_a')`).run();
    db.prepare(`INSERT INTO agent_device_context_state(device_id,user_id,account_workspace_id,user_agent_instance_id,primary_session_id,
      active_context_space_id,active_memory_document_id) VALUES('transitive_cycle_device','transitive_cycle_user','workspace_personal',
      'transitive_cycle_c','transitive_cycle_session','transitive_cycle_context_b','transitive_cycle_memory_b')`).run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").run();
    return {
      messages: db.prepare(`SELECT id,role,content,created_at FROM messages WHERE id='transitive_cycle_message'`).all().map((row) => ({ ...row })),
      documentCount: Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='transitive_cycle_user'").get().count),
      versionCount: Number(db.prepare("SELECT COUNT(*) count FROM memory_document_versions WHERE id IN ('transitive_cycle_version_a','transitive_cycle_version_b')").get().count),
    };
  } finally {
    db.close();
  }
}

function assertTransitiveAliasCycleRepaired(db, before) {
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM user_agent_instance_aliases WHERE alias_instance_id='transitive_cycle_a'").get().count), 0);
  assert.deepEqual(db.prepare(`SELECT alias_instance_id,canonical_instance_id FROM user_agent_instance_aliases
    WHERE alias_instance_id IN ('transitive_cycle_b','transitive_cycle_c','transitive_cycle_d') ORDER BY alias_instance_id`).all().map((row) => ({ ...row })), [
    { alias_instance_id: 'transitive_cycle_b', canonical_instance_id: 'transitive_cycle_a' },
    { alias_instance_id: 'transitive_cycle_c', canonical_instance_id: 'transitive_cycle_a' },
    { alias_instance_id: 'transitive_cycle_d', canonical_instance_id: 'transitive_cycle_a' },
  ]);
  assert.deepEqual({ ...db.prepare(`SELECT user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
    FROM agent_device_context_state WHERE device_id='transitive_cycle_device' AND account_workspace_id='workspace_personal'`).get() }, {
    user_agent_instance_id: 'transitive_cycle_a', primary_session_id: 'transitive_cycle_session',
    active_context_space_id: 'transitive_cycle_context_a', active_memory_document_id: 'transitive_cycle_memory_a',
  });
  assert.deepEqual({ ...db.prepare(`SELECT agent_instance_id,context_space_id,memory_id,role,content,created_at
    FROM messages WHERE id='transitive_cycle_message'`).get() }, {
    agent_instance_id: 'transitive_cycle_a', context_space_id: 'transitive_cycle_context_a',
    memory_id: 'transitive_cycle_memory_a', role: 'assistant', content: 'TRANSITIVE_MESSAGE_PRESERVED',
    created_at: '2026-04-02T00:00:00.000Z',
  });
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='transitive_cycle_user'").get().count), before.documentCount);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_document_versions WHERE memory_document_id='transitive_cycle_memory_a'").get().count), before.versionCount);
  assert.deepEqual(db.prepare(`SELECT status,employment_state,sync_enabled FROM user_agent_instances
    WHERE id IN ('transitive_cycle_b','transitive_cycle_c','transitive_cycle_d') ORDER BY id`).all().map((row) => ({ ...row })), [
    { status: 'inactive', employment_state: 'inactive', sync_enabled: 0 },
    { status: 'inactive', employment_state: 'inactive', sync_enabled: 0 },
    { status: 'inactive', employment_state: 'inactive', sync_enabled: 0 },
  ]);
  assert.deepEqual(db.prepare(`SELECT id,role,content,created_at FROM messages WHERE id='transitive_cycle_message'`).all().map((row) => ({ ...row })), before.messages);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
}

function prepareCrossFamilyAliasCycle(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('cross_cycle_user','cross-cycle@example.test','Cross Cycle')").run();
    new Store(db, { root: runtimeRoot }).ensureAccountWorkspaces({ user: { id: 'cross_cycle_user', displayName: 'Cross Cycle' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('cross_family_a','Cross A','active',1,'employee',1)").run();
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('cross_family_b','Cross B','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('cross_cycle_a','cross_cycle_user','cross_family_a','active')").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('cross_cycle_b','cross_cycle_user','cross_family_b','active')").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('cross_cycle_a','cross_cycle_b','cross_cycle_user','fixture')").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('cross_cycle_b','cross_cycle_a','cross_cycle_user','fixture')").run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").run();
  } finally { db.close(); }
}

function prepareSafeAliasCycle(runtimeRoot) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('safe_cycle_user','safe-cycle@example.test','Safe Cycle')").run();
    new Store(db, { root: runtimeRoot }).ensureAccountWorkspaces({ user: { id: 'safe_cycle_user', displayName: 'Safe Cycle' } });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('safe_cycle_family','Safe Cycle','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('safe_cycle_instance','safe_cycle_user','safe_cycle_family','active')").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('safe_cycle_instance','safe_cycle_alias','safe_cycle_user','fixture')").run();
    db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('safe_cycle_alias','safe_cycle_instance','safe_cycle_user','fixture')").run();
    db.prepare("DELETE FROM schema_migrations WHERE id IN ('agent_single_window_continuity_v1','agent_instance_alias_cycle_repair_v2','agent_alias_context_reference_repair_v3')").run();
  } finally {
    db.close();
  }
}

function prepareAliasContextFixture(runtimeRoot, { collision = false } = {}) {
  const db = openDatabase(runtimeRoot, { appVersion: '0.2.24', skipMigrationBackup: true });
  try {
    db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('alias_context_user','alias-context@example.test','Alias Context')").run();
    new Store(db, { root: runtimeRoot }).ensureAccountWorkspaces({
      user: { id: 'alias_context_user', displayName: 'Alias Context' },
    });
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('alias_context_family','Alias Context','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_context_canonical','alias_context_user','alias_context_family','active')").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_context_legacy','alias_context_user','alias_context_family','active')").run();
    db.prepare(`INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status,created_at,updated_at)
      VALUES('alias_context_conversation','workspace_personal','direct','alias_context_user','Alias Context History',
      'alias_context_family','alias_context_legacy','active','2026-05-01T00:00:00.000Z','2026-05-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,
      conversation_role,write_state,status,created_at,updated_at)
      VALUES('alias_context_session','alias_context_conversation','alias_context_user','workspace_personal','Alias Context History','general',
      'alias_context_family','alias_context_legacy','primary','writable','active','2026-05-01T00:00:00.000Z','2026-05-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,
      current_version_id,content_hash,created_at,updated_at)
      VALUES('alias_context_memory_legacy','alias_context_user','workspace_personal','alias_context_legacy','alias_context_family',
      'alias_context_memory_version_legacy','legacy_hash','2026-05-01T00:00:00.000Z','2026-05-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at)
      VALUES('alias_context_memory_version_legacy','alias_context_memory_legacy',1,'LEGACY_MEMORY_PRESERVED','legacy_hash',
      '2026-05-01T00:00:00.000Z')`).run();
    if (collision) {
      db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,
        current_version_id,content_hash,created_at,updated_at)
        VALUES('alias_context_memory_canonical','alias_context_user','workspace_personal','alias_context_canonical','alias_context_family',
        'alias_context_memory_version_canonical','canonical_hash','2026-04-01T00:00:00.000Z','2026-04-02T00:00:00.000Z')`).run();
      db.prepare(`INSERT INTO memory_document_versions(id,memory_document_id,version_no,content,content_hash,created_at) VALUES
        ('alias_context_memory_version_canonical','alias_context_memory_canonical',1,'CANONICAL_MEMORY_PRESERVED','canonical_hash',
          '2026-04-01T00:00:00.000Z'),
        ('alias_context_memory_version_local_only','alias_context_memory_canonical',-1,'LOCAL_ONLY_MEMORY_PRESERVED','local_only_hash',
          '2026-04-02T00:00:00.000Z')`).run();
    }
    db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,
      created_at,updated_at) VALUES('alias_context_space_legacy','alias_context_user','workspace_personal','alias_context_legacy',
      'general_memory','alias_context_memory_legacy','2026-05-01T00:00:00.000Z','2026-05-02T00:00:00.000Z')`).run();
    if (collision) {
      db.prepare(`INSERT INTO agent_context_spaces(id,user_id,account_workspace_id,user_agent_instance_id,context_kind,memory_document_id,
        created_at,updated_at) VALUES('alias_context_space_canonical','alias_context_user','workspace_personal','alias_context_canonical',
        'general_memory','alias_context_memory_canonical','2026-04-01T00:00:00.000Z','2026-04-02T00:00:00.000Z')`).run();
    }
    db.prepare("UPDATE memory_documents SET context_space_id='alias_context_space_legacy' WHERE id='alias_context_memory_legacy'").run();
    if (collision) db.prepare("UPDATE memory_documents SET context_space_id='alias_context_space_canonical' WHERE id='alias_context_memory_canonical'").run();
    db.prepare(`INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,memory_id,role,content,agent_id,
      agent_instance_id,context_space_id,created_at,updated_at)
      VALUES('alias_context_message','workspace_personal','alias_context_conversation','alias_context_session','alias_context_memory_legacy',
      'assistant','ALIAS_CONTEXT_MESSAGE_PRESERVED','alias_context_family','alias_context_legacy','alias_context_space_legacy',
      '2026-05-03T00:00:00.000Z','2026-05-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO message_attachments(id,account_workspace_id,conversation_id,message_id,relation_type,name,created_at,updated_at)
      VALUES('alias_context_attachment','workspace_personal','alias_context_conversation','alias_context_message','attachment',
      'alias-context-preserved.txt','2026-05-03T00:00:00.000Z','2026-05-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO model_executions(id,user_id,account_workspace_id,conversation_id,agent_id,agent_instance_id,status,started_at,updated_at)
      VALUES('alias_context_execution','alias_context_user','workspace_personal','alias_context_conversation','alias_context_family',
      'alias_context_legacy','completed','2026-05-03T00:00:00.000Z','2026-05-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO agent_context_state(user_id,account_workspace_id,user_agent_instance_id,primary_session_id,
      active_context_space_id,active_memory_document_id)
      VALUES('alias_context_user','workspace_personal','alias_context_legacy','alias_context_session','alias_context_space_legacy',
      'alias_context_memory_legacy')`).run();
    db.prepare(`INSERT INTO chat_context_states(id,owner_user_id,session_id,context_space_id,state_revision,updated_at)
      VALUES('alias_context_chat_state','alias_context_user','alias_context_session','alias_context_space_legacy',3,
      '2026-05-03T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
      VALUES('alias_context_legacy','alias_context_canonical','alias_context_user','legacy_fixture')`).run();
    db.prepare("DELETE FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").run();
    return aliasContextFingerprint(db);
  } finally {
    db.close();
  }
}

function assertAliasContextFixtureRepaired(db, before, { collision = false } = {}) {
  const expectedContextId = collision ? 'alias_context_space_canonical' : 'alias_context_space_legacy';
  const expectedMemoryId = collision ? 'alias_context_memory_canonical' : 'alias_context_memory_legacy';
  assert.deepEqual(db.prepare(`SELECT id,agent_id,agent_instance_id FROM sessions WHERE id='alias_context_session'`).all().map((row) => ({ ...row })), [
    { id: 'alias_context_session', agent_id: 'alias_context_family', agent_instance_id: 'alias_context_canonical' },
  ]);
  assert.deepEqual({ ...db.prepare(`SELECT id,role,content,created_at,agent_id,agent_instance_id,context_space_id,memory_id
    FROM messages WHERE id='alias_context_message'`).get() }, {
    id: 'alias_context_message', role: 'assistant', content: 'ALIAS_CONTEXT_MESSAGE_PRESERVED',
    created_at: '2026-05-03T00:00:00.000Z', agent_id: 'alias_context_family',
    agent_instance_id: 'alias_context_canonical', context_space_id: expectedContextId, memory_id: expectedMemoryId,
  });
  assert.deepEqual({ ...db.prepare(`SELECT user_agent_instance_id,memory_document_id FROM agent_context_spaces WHERE id=?`).get(expectedContextId) }, {
    user_agent_instance_id: 'alias_context_canonical', memory_document_id: expectedMemoryId,
  });
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM messages WHERE id='alias_context_message' AND context_space_id='' ").get().count), 0);
  assert.deepEqual({ ...db.prepare(`SELECT user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id
    FROM agent_context_state WHERE user_id='alias_context_user' AND account_workspace_id='workspace_personal'
      AND user_agent_instance_id='alias_context_canonical'`).get() }, {
    user_agent_instance_id: 'alias_context_canonical', primary_session_id: 'alias_context_session',
    active_context_space_id: expectedContextId, active_memory_document_id: expectedMemoryId,
  });
  assert.equal(db.prepare("SELECT context_space_id FROM chat_context_states WHERE id='alias_context_chat_state'").get().context_space_id, expectedContextId);
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM message_attachments WHERE id='alias_context_attachment'").get().count), 1);
  assert.equal(db.prepare("SELECT agent_instance_id FROM model_executions WHERE id='alias_context_execution'").get().agent_instance_id,
    'alias_context_canonical');
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='alias_context_user'").get().count), before.documentCount);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM memory_document_versions WHERE id IN
    ('alias_context_memory_version_legacy','alias_context_memory_version_canonical','alias_context_memory_version_local_only')`).get().count), before.versionCount);
  if (collision) {
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_context_spaces WHERE id='alias_context_space_legacy'").get().count), 0);
    assert.equal(db.prepare("SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id='alias_context_memory_legacy'").get().canonical_document_id,
      'alias_context_memory_canonical');
    assert.equal(Number(db.prepare(`SELECT COUNT(*) count FROM memory_document_versions
      WHERE memory_document_id='alias_context_memory_canonical'`).get().count), before.versionCount);
    assert.deepEqual(db.prepare(`SELECT id,version_no,content FROM memory_document_versions
      WHERE memory_document_id='alias_context_memory_canonical' ORDER BY version_no`).all().map((row) => ({ ...row })), [
      { id: 'alias_context_memory_version_canonical', version_no: 1, content: 'CANONICAL_MEMORY_PRESERVED' },
      { id: 'alias_context_memory_version_local_only', version_no: 2, content: 'LOCAL_ONLY_MEMORY_PRESERVED' },
      { id: 'alias_context_memory_version_legacy', version_no: 3, content: 'LEGACY_MEMORY_PRESERVED' },
    ]);
  } else {
    assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM agent_context_spaces WHERE id='alias_context_space_legacy'").get().count), 1);
    assert.equal(db.prepare("SELECT user_agent_instance_id FROM memory_documents WHERE id='alias_context_memory_legacy'").get().user_agent_instance_id,
      'alias_context_canonical');
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").get().count), 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  assert.deepEqual(aliasContextFingerprint(db).message, before.message);
}

function prepareAliasContextMismatchFixture(runtimeRoot) {
  prepareAliasContextFixture(runtimeRoot, { collision: false });
  const db = new DatabaseSync(dbPath(runtimeRoot));
  try {
    db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('alias_context_unrelated_family','Unrelated','active',1,'employee',1)").run();
    db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_context_unrelated','alias_context_user','alias_context_unrelated_family','active')").run();
    db.exec('DROP TRIGGER IF EXISTS trg_messages_agent_identity_update');
    db.prepare(`UPDATE messages SET agent_id='alias_context_unrelated_family',agent_instance_id='alias_context_unrelated'
      WHERE id='alias_context_message'`).run();
    return aliasContextMismatchFingerprint(db);
  } finally {
    db.close();
  }
}

function aliasContextFingerprint(db) {
  return {
    message: db.prepare(`SELECT id,role,content,created_at FROM messages WHERE id='alias_context_message'`).all().map((row) => ({ ...row })),
    documentCount: Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='alias_context_user'").get().count),
    versionCount: Number(db.prepare(`SELECT COUNT(*) count FROM memory_document_versions WHERE id IN
      ('alias_context_memory_version_legacy','alias_context_memory_version_canonical','alias_context_memory_version_local_only')`).get().count),
  };
}

function aliasContextMismatchFingerprint(db) {
  return {
    message: db.prepare(`SELECT id,role,content,created_at,agent_id,agent_instance_id,context_space_id
      FROM messages WHERE id='alias_context_message'`).all().map((row) => ({ ...row })),
    context: db.prepare(`SELECT id,user_id,account_workspace_id,user_agent_instance_id,memory_document_id
      FROM agent_context_spaces WHERE id='alias_context_space_legacy'`).all().map((row) => ({ ...row })),
    documents: db.prepare(`SELECT id,user_agent_instance_id,current_version_id,lifecycle_state
      FROM memory_documents WHERE user_id='alias_context_user' ORDER BY id`).all().map((row) => ({ ...row })),
    versions: db.prepare(`SELECT id,memory_document_id,version_no,content,created_at
      FROM memory_document_versions WHERE id='alias_context_memory_version_legacy'`).all().map((row) => ({ ...row })),
  };
}

function coreInventory(db) {
  return {
    sessions: Number(db.prepare("SELECT COUNT(*) count FROM sessions WHERE id IN ('single_window_primary','single_window_loser')").get().count),
    messages: db.prepare(`SELECT id,role,content,created_at FROM messages
      WHERE id IN ('single_window_message_primary','single_window_message_loser') ORDER BY id`).all().map((row) => ({ ...row })),
    attachments: Number(db.prepare("SELECT COUNT(*) count FROM message_attachments WHERE id='single_window_attachment'").get().count),
    executions: Number(db.prepare("SELECT COUNT(*) count FROM model_executions WHERE id='single_window_execution'").get().count),
    memories: Number(db.prepare("SELECT COUNT(*) count FROM memory_documents WHERE user_id='single_window_user'").get().count),
    tasks: Number(db.prepare("SELECT COUNT(*) count FROM task_runs WHERE owner_user_id='single_window_user'").get().count),
    files: Number(db.prepare("SELECT COUNT(*) count FROM cloud_file_refs WHERE user_id='single_window_user'").get().count),
  };
}
