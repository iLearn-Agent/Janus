import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { DATABASE_MIGRATION_IDS, databaseMigrationIdsForVersion, inspectDatabaseHealth } from '../src/main/modules/persistence/index.js';

const APPLICABLE_MIGRATION_IDS = databaseMigrationIdsForVersion('0.2.14');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-maintenance-'));
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-recovery-'));
const namedConstraintRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-named-constraint-'));
const duplicatePrimaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-duplicate-primary-'));
const workspaceUpgradeDuplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-workspace-upgrade-duplicate-'));
const projectedWorkspaceCollisionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-projected-workspace-collision-'));
const workspaceContextMismatchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-workspace-context-mismatch-'));
const aliasStartupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-alias-startup-'));
const aliasRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-alias-recovery-'));
const aliasCollisionStartupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-alias-collision-startup-'));
const aliasCollisionRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-alias-collision-recovery-'));
const branchRecoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-database-branch-recovery-'));

function prepareCrossFamilyAliasDatabase(targetRoot) {
  const prepared = openDatabase(targetRoot, { appVersion: '0.2.16' });
  prepared.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('alias_user','alias@example.com','Alias')").run();
  prepared.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('alias_old_family','Alias Old','active',1,'employee',1)").run();
  prepared.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('alias_new_family','Alias New','active',1,'employee',1)").run();
  prepared.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_old_instance','alias_user','alias_old_family','active')").run();
  prepared.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_new_instance','alias_user','alias_new_family','active')").run();
  prepared.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('alias_session','alias_user','Alias session','alias_old_family','alias_old_instance','primary','writable','active')`).run();
  prepared.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('alias_message','alias_session','user','preserve aliased history','alias_old_family','alias_old_instance')`).run();
  prepared.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
    VALUES('alias_old_instance','alias_new_instance','alias_user','cross_family_canonicalization')`).run();
  prepared.prepare("DELETE FROM user_agent_instances WHERE id='alias_old_instance'").run();
  assert.ok(prepared.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='trg_sessions_agent_identity_update'").get());
  prepared.close();
}

function prepareAliasPrimaryCollisionDatabase(targetRoot) {
  const prepared = openDatabase(targetRoot, { appVersion: '0.2.16' });
  prepared.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('alias_collision_user','alias-collision@example.com','Alias Collision')").run();
  prepared.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('alias_collision_family','Alias Collision','active',1,'employee',1)").run();
  prepared.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_collision_old','alias_collision_user','alias_collision_family','active')").run();
  prepared.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('alias_collision_new','alias_collision_user','alias_collision_family','active')").run();
  prepared.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('alias_collision_old_session','alias_collision_user','Alias old','alias_collision_family','alias_collision_old','primary','writable','active','2026-01-01T00:00:00.000Z')`).run();
  prepared.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('alias_collision_new_session','alias_collision_user','Alias new','alias_collision_family','alias_collision_new','primary','writable','active','2026-02-01T00:00:00.000Z')`).run();
  prepared.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('alias_collision_old_message','alias_collision_old_session','user','preserve alias old history','alias_collision_family','alias_collision_old')`).run();
  prepared.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('alias_collision_new_message','alias_collision_new_session','user','preserve alias new history','alias_collision_family','alias_collision_new')`).run();
  prepared.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
    VALUES('alias_collision_old','alias_collision_new','alias_collision_user','primary_session_collision')`).run();
  prepared.prepare("DELETE FROM schema_migrations WHERE id='ubuddy_rollout_flags_v1'").run();
  prepared.close();
}

try {
  let db = openDatabase(root, { appVersion: '0.2.14' });
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((row) => row.id));
  assert.deepEqual(APPLICABLE_MIGRATION_IDS.filter((id) => !applied.has(id)), []);
  assert.deepEqual([...applied].filter((id) => !DATABASE_MIGRATION_IDS.includes(id)), []);
  assert.equal(db.prepare("SELECT last_health_status FROM database_meta WHERE id='default'").get().last_health_status, 'healthy');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM database_maintenance_runs').get().count, APPLICABLE_MIGRATION_IDS.length);

  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('maintenance_user','maintenance@example.com','Maintenance')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('maintenance_a','A','active',1,'employee',1)").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('maintenance_b','B','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('instance_a','maintenance_user','maintenance_a','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('instance_b','maintenance_user','maintenance_b','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('session_a','maintenance_user','A','maintenance_a','instance_a','primary','writable','active')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('session_b','maintenance_user','B','maintenance_b','instance_b','history','read_only','deleted')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('mixed_message','session_a','user','preserve-me','maintenance_a','instance_a')`).run();
  db.close();

  const raw = new DatabaseSync(path.join(root, 'data', 'janus.db'));
  for (const trigger of raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%sessions%'").all()) {
    raw.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  }
  raw.prepare("UPDATE messages SET agent_id='maintenance_b',agent_instance_id='instance_b' WHERE id='mixed_message'").run();
  const sessionSql = String(raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql);
  const columns = raw.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  raw.exec('ALTER TABLE sessions RENAME TO sessions_current_v1');
  raw.exec(sessionSql.replace(/\)\s*$/, ', UNIQUE(user_id,agent_instance_id))'));
  raw.exec(`INSERT INTO sessions(${columns.join(',')}) SELECT ${columns.join(',')} FROM sessions_current_v1`);
  raw.exec('DROP TABLE sessions_current_v1');
  raw.prepare("DELETE FROM schema_migrations WHERE id='sessions_canonical_primary_uniqueness_v1'").run();
  raw.close();

  db = openDatabase(root, { appVersion: '0.2.14' });
  assert.doesNotMatch(String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql), /UNIQUE\s*\(\s*user_id\s*,\s*agent_instance_id\s*\)/i);
  assert.deepEqual({ ...db.prepare("SELECT session_id,agent_id,agent_instance_id,content FROM messages WHERE id='mixed_message'").get() }, {
    session_id: 'session_b', agent_id: 'maintenance_b', agent_instance_id: 'instance_b', content: 'preserve-me',
  });
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id='session_b'").get().status, 'active');
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  assert.ok(db.migrationBackup?.backupPath);
  assert.equal(JSON.parse(fs.readFileSync(`${db.migrationBackup.backupPath}.json`, 'utf8')).pinned, true);
  db.close();

  db = openDatabase(root, { appVersion: '0.2.14' });
  assert.deepEqual(db.maintenance.pendingMigrationIds, []);
  assert.equal(db.migrationBackup, null);
  db.prepare("UPDATE database_meta SET min_writer_version='9.0.0' WHERE id='default'").run();
  db.close();
  assert.throws(() => openDatabase(root, { appVersion: '0.2.14' }), (error) => error.code === 'DB_DOWNGRADE_BLOCKED');
  const incompatibleInspection = inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.14' });
  assert.equal(incompatibleInspection.status, 'incompatible');
  assert.equal(incompatibleInspection.repairable, false);
  assert.deepEqual(incompatibleInspection.compatibility, {
    code: 'DB_DOWNGRADE_BLOCKED', currentAppVersion: '0.2.14', minimumWriterVersion: '9.0.0',
  });
  assert.throws(() => repairDatabase(root, { appVersion: '0.2.14' }),
    (error) => error.code === 'DB_DOWNGRADE_BLOCKED' && error.phase === 'preflight');

  db = openDatabase(recoveryRoot, { appVersion: '0.2.14' });
  db.prepare("DELETE FROM schema_migrations WHERE id='database_core_consistency_repair_v1'").run();
  db.close();
  assert.equal(inspectDatabaseRecoveryStatus(recoveryRoot, { appVersion: '0.2.14' }).status, 'repairable');
  const repaired = repairDatabase(recoveryRoot, { appVersion: '0.2.14' });
  assert.equal(repaired.status, 'repaired');
  assert.equal(inspectDatabaseRecoveryStatus(recoveryRoot, { appVersion: '0.2.14' }).status, 'healthy');

  db = openDatabase(namedConstraintRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('named_user','named@example.com','Named')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('named_family','Named','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('named_canonical','named_user','named_family','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('named_alias','named_user','named_family','active')").run();
  db.prepare("INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason) VALUES('named_alias','named_canonical','named_user','historical_alias')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('named_primary','named_user','Primary','named_family','named_canonical','primary','writable','active')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('named_legacy','named_user','Legacy','named_family','named_alias','primary','writable','active')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('named_message','named_legacy','user','preserve named constraint history','named_family','named_alias')`).run();
  db.close();
  const namedRaw = new DatabaseSync(path.join(namedConstraintRoot, 'data', 'janus.db'));
  namedRaw.exec('PRAGMA foreign_keys=OFF');
  for (const trigger of namedRaw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%sessions%'").all()) {
    namedRaw.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  }
  namedRaw.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  const namedSessionSql = String(namedRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql);
  const namedColumns = namedRaw.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name);
  namedRaw.exec('ALTER TABLE sessions RENAME TO sessions_named_unique_v1');
  namedRaw.exec(namedSessionSql.replace(/\)\s*$/, ', CONSTRAINT sessions_agent_instance_id_sessions_user_id UNIQUE ("agent_instance_id", "user_id"))'));
  namedRaw.exec(`INSERT INTO sessions(${namedColumns.join(',')}) SELECT ${namedColumns.join(',')} FROM sessions_named_unique_v1`);
  namedRaw.exec('DROP TABLE sessions_named_unique_v1');
  namedRaw.close();
  const namedInspection = inspectDatabaseRecoveryStatus(namedConstraintRoot, { appVersion: '0.2.15' });
  assert.equal(namedInspection.status, 'repairable');
  assert.ok(namedInspection.structureIssues.some((issue) => issue.code === 'legacy_session_table_unique'));
  const namedProgress = [];
  const namedRepair = repairDatabase(namedConstraintRoot, { appVersion: '0.2.15', onProgress: (progress) => namedProgress.push(progress) });
  assert.equal(namedRepair.status, 'repaired');
  assert.equal(namedRepair.data.messages, 1);
  assert.deepEqual(namedProgress.map((progress) => progress.stage), ['inspect', 'backup', 'copy', 'migrate', 'validate', 'checkpoint', 'replace', 'complete']);
  assert.deepEqual(namedProgress.map((progress) => progress.percent), [5, 15, 30, 50, 72, 84, 94, 100]);
  const namedRepairedRaw = new DatabaseSync(path.join(namedConstraintRoot, 'data', 'janus.db'), { readOnly: true });
  assert.doesNotMatch(String(namedRepairedRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql), /UNIQUE\s*\(/i);
  const namedRowsAfterRepair = namedRepairedRaw.prepare("SELECT id,agent_instance_id,conversation_role,write_state,status FROM sessions WHERE user_id='named_user' ORDER BY id").all();
  const namedAliasesAfterRepair = namedRepairedRaw.prepare("SELECT alias_instance_id,canonical_instance_id,user_id FROM user_agent_instance_aliases WHERE user_id='named_user'").all();
  assert.equal(namedRepairedRaw.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='named_user' AND agent_instance_id='named_alias'").get().count, 0,
    JSON.stringify({ namedRowsAfterRepair, namedAliasesAfterRepair }));
  assert.equal(namedRepairedRaw.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='named_user' AND agent_instance_id='named_canonical' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'").get().count, 1);
  namedRepairedRaw.close();
  db = openDatabase(namedConstraintRoot, { appVersion: '0.2.15' });
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=?').get('named_user').count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM messages WHERE id=? AND content=?').get('named_message', 'preserve named constraint history').count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='named_user' AND agent_instance_id='named_canonical' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'").get().count, 1);
  assert.doesNotMatch(String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql), /UNIQUE\s*\(/i);
  db.close();

  db = openDatabase(duplicatePrimaryRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('duplicate_user','duplicate@example.com','Duplicate')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('duplicate_family','Duplicate','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('duplicate_instance','duplicate_user','duplicate_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('duplicate_one','duplicate_user','One','duplicate_family','duplicate_instance','primary','writable','active')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('duplicate_message_one','duplicate_one','user','first duplicate history','duplicate_family','duplicate_instance')`).run();
  db.close();
  const duplicateRaw = new DatabaseSync(path.join(duplicatePrimaryRoot, 'data', 'janus.db'));
  duplicateRaw.exec('DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  for (const trigger of duplicateRaw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%sessions%'").all()) {
    duplicateRaw.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  }
  duplicateRaw.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('duplicate_two','duplicate_user','Two','duplicate_family','duplicate_instance','primary','writable','active')`).run();
  duplicateRaw.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('duplicate_message_two','duplicate_two','user','second duplicate history','duplicate_family','duplicate_instance')`).run();
  duplicateRaw.close();
  const duplicateInspection = inspectDatabaseRecoveryStatus(duplicatePrimaryRoot, { appVersion: '0.2.15' });
  assert.equal(duplicateInspection.status, 'repairable');
  assert.ok(duplicateInspection.health.blocking.some((check) => check.ruleId === 'duplicate_primary_agent_session'));
  const duplicateRepair = repairDatabase(duplicatePrimaryRoot, { appVersion: '0.2.15' });
  assert.equal(duplicateRepair.status, 'repaired');
  assert.equal(duplicateRepair.data.sessions, 2);
  assert.equal(duplicateRepair.data.messages, 2);
  db = openDatabase(duplicatePrimaryRoot, { appVersion: '0.2.15' });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='duplicate_user' AND agent_instance_id='duplicate_instance'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='duplicate_user' AND agent_instance_id='duplicate_instance' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('duplicate_message_one','duplicate_message_two')").get().count, 2);
  db.close();

  db = openDatabase(workspaceUpgradeDuplicateRoot, { appVersion: '0.2.15' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('workspace_upgrade_user','workspace-upgrade@example.com','Workspace Upgrade')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('workspace_upgrade_family','Workspace Upgrade','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('workspace_upgrade_instance','workspace_upgrade_user','workspace_upgrade_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('workspace_upgrade_one','workspace_upgrade_user','Earlier','workspace_upgrade_family','workspace_upgrade_instance','primary','writable','active','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('workspace_upgrade_message_one','workspace_upgrade_one','user','preserve earlier workspace history','workspace_upgrade_family','workspace_upgrade_instance')`).run();
  db.close();
  const workspaceUpgradeRaw = new DatabaseSync(path.join(workspaceUpgradeDuplicateRoot, 'data', 'janus.db'));
  workspaceUpgradeRaw.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; DROP INDEX IF EXISTS idx_sessions_one_primary_agent');
  for (const trigger of workspaceUpgradeRaw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%sessions%'").all()) {
    workspaceUpgradeRaw.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  }
  for (const object of workspaceUpgradeRaw.prepare("SELECT type,name FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND name NOT LIKE 'sqlite_autoindex_%'").all()) {
    const quoted = `"${String(object.name).replaceAll('"', '""')}"`;
    workspaceUpgradeRaw.exec(`DROP ${String(object.type).toUpperCase()} IF EXISTS ${quoted}`);
  }
  const workspaceSessionSql = String(workspaceUpgradeRaw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql);
  const workspaceLegacySql = workspaceSessionSql.replace(/\s*account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',\s*/i, '\n  ');
  const workspaceLegacyColumns = workspaceUpgradeRaw.prepare('PRAGMA table_info(sessions)').all()
    .map((row) => row.name).filter((name) => name !== 'account_workspace_id');
  workspaceUpgradeRaw.exec('ALTER TABLE sessions RENAME TO sessions_before_account_workspace_v1');
  workspaceUpgradeRaw.exec(workspaceLegacySql);
  workspaceUpgradeRaw.exec(`INSERT INTO sessions(${workspaceLegacyColumns.join(',')}) SELECT ${workspaceLegacyColumns.join(',')} FROM sessions_before_account_workspace_v1`);
  workspaceUpgradeRaw.exec('DROP TABLE sessions_before_account_workspace_v1');
  workspaceUpgradeRaw.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('workspace_upgrade_two','workspace_upgrade_user','Later','workspace_upgrade_family','workspace_upgrade_instance','primary','writable','active','2026-02-01T00:00:00.000Z')`).run();
  workspaceUpgradeRaw.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('workspace_upgrade_message_two','workspace_upgrade_two','user','preserve later workspace history','workspace_upgrade_family','workspace_upgrade_instance')`).run();
  workspaceUpgradeRaw.close();
  const workspaceUpgradeInspection = inspectDatabaseRecoveryStatus(workspaceUpgradeDuplicateRoot, { appVersion: '0.2.16' });
  assert.equal(workspaceUpgradeInspection.status, 'repairable');
  assert.ok(workspaceUpgradeInspection.structureIssues.some((issue) => issue.table === 'sessions' && issue.column === 'account_workspace_id'));
  const workspaceUpgradeRepair = repairDatabase(workspaceUpgradeDuplicateRoot, { appVersion: '0.2.16' });
  assert.equal(workspaceUpgradeRepair.status, 'repaired');
  db = openDatabase(workspaceUpgradeDuplicateRoot, { appVersion: '0.2.16' });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='workspace_upgrade_user' AND agent_instance_id='workspace_upgrade_instance'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='workspace_upgrade_user' AND account_workspace_id='workspace_personal' AND agent_instance_id='workspace_upgrade_instance' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='workspace_upgrade_user' AND conversation_role='history' AND write_state='read_only' AND superseded_by_session_id!=''").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('workspace_upgrade_message_one','workspace_upgrade_message_two')").get().count, 2);
  db.close();

  db = openDatabase(projectedWorkspaceCollisionRoot, { appVersion: '0.2.17' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('projected_workspace_user','projected-workspace@example.com','Projected Workspace')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('projected_workspace_family','Projected Workspace','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('projected_workspace_instance','projected_workspace_user','projected_workspace_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,account_workspace_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('projected_workspace_blank','projected_workspace_user','','Blank workspace','projected_workspace_family','projected_workspace_instance','primary','writable','active','2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,account_workspace_id,title,agent_id,agent_instance_id,conversation_role,write_state,status,updated_at)
    VALUES('projected_workspace_personal','projected_workspace_user','workspace_personal','Personal workspace','projected_workspace_family','projected_workspace_instance','primary','writable','active','2026-02-01T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO messages(id,account_workspace_id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('projected_workspace_blank_message','','projected_workspace_blank','user','preserve blank workspace history','projected_workspace_family','projected_workspace_instance')`).run();
  db.prepare(`INSERT INTO messages(id,account_workspace_id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('projected_workspace_personal_message','workspace_personal','projected_workspace_personal','assistant','preserve personal workspace history','projected_workspace_family','projected_workspace_instance')`).run();
  db.close();
  db = openDatabase(projectedWorkspaceCollisionRoot, { appVersion: '0.2.18' });
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM sessions WHERE user_id='projected_workspace_user'
    AND account_workspace_id='workspace_personal' AND agent_instance_id='projected_workspace_instance'`).get().count, 2);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM sessions WHERE user_id='projected_workspace_user'
    AND account_workspace_id='workspace_personal' AND agent_instance_id='projected_workspace_instance'
    AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`).get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('projected_workspace_blank_message','projected_workspace_personal_message')").get().count, 2);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  db = openDatabase(workspaceContextMismatchRoot, { appVersion: '0.2.17' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('workspace_context_user','workspace-context@example.com','Workspace Context')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('workspace_context_family','Workspace Context','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('workspace_context_instance','workspace_context_user','workspace_context_family','active')").run();
  db.prepare(`INSERT INTO account_workspaces(id,workspace_kind,name,status)
    VALUES('workspace_context_secondary','personal','Secondary workspace','active')`).run();
  db.prepare(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status)
    VALUES('workspace_context_secondary','workspace_context_user','owner','active')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,account_workspace_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('workspace_context_session','workspace_context_user','workspace_personal','Context session','workspace_context_family','workspace_context_instance','primary','writable','active')`).run();
  db.prepare(`INSERT INTO messages(id,account_workspace_id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('workspace_context_message','workspace_personal','workspace_context_session','user','preserve workspace context history','workspace_context_family','workspace_context_instance')`).run();
  db.prepare(`INSERT INTO memory_documents(id,user_id,account_workspace_id,user_agent_instance_id,agent_family_id,scope,display_name,lifecycle_state)
    VALUES('workspace_context_memory','workspace_context_user','workspace_context_secondary','workspace_context_instance','workspace_context_family','general','memory0','active')`).run();
  db.close();

  db = openDatabase(workspaceContextMismatchRoot, { appVersion: '0.2.17' });
  assert.deepEqual({ ...db.prepare("SELECT account_workspace_id,memory_document_id FROM agent_context_spaces WHERE id='ctx_memory_workspace_context_memory'").get() }, {
    account_workspace_id: 'workspace_context_secondary', memory_document_id: 'workspace_context_memory',
  });
  assert.deepEqual({ ...db.prepare(`SELECT active_context_space_id,active_memory_document_id FROM agent_context_state
    WHERE user_id='workspace_context_user' AND account_workspace_id='workspace_context_secondary' AND user_agent_instance_id='workspace_context_instance'`).get() }, {
    active_context_space_id: 'ctx_memory_workspace_context_memory', active_memory_document_id: 'workspace_context_memory',
  });
  db.close();

  const workspaceContextRaw = new DatabaseSync(path.join(workspaceContextMismatchRoot, 'data', 'janus.db'));
  workspaceContextRaw.exec('DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update');
  workspaceContextRaw.prepare("UPDATE agent_context_spaces SET account_workspace_id='workspace_personal' WHERE id='ctx_memory_workspace_context_memory'").run();
  workspaceContextRaw.prepare("UPDATE messages SET context_space_id='ctx_memory_workspace_context_memory',memory_id='workspace_context_memory' WHERE id='workspace_context_message'").run();
  workspaceContextRaw.prepare("UPDATE memory_documents SET context_space_id='ctx_memory_workspace_context_memory' WHERE id='workspace_context_memory'").run();
  workspaceContextRaw.close();
  const workspaceContextInspection = inspectDatabaseRecoveryStatus(workspaceContextMismatchRoot, { appVersion: '0.2.17' });
  assert.equal(workspaceContextInspection.status, 'repairable');
  assert.ok(workspaceContextInspection.health.blocking.some((check) => check.ruleId === 'context_memory_workspace_mismatch'));
  assert.ok(workspaceContextInspection.health.blocking.some((check) => check.ruleId === 'account_context_space_workspace_mismatch'));
  assert.ok(workspaceContextInspection.health.blocking.some((check) => check.ruleId === 'device_context_space_workspace_mismatch'));
  assert.ok(workspaceContextInspection.health.blocking.some((check) => check.ruleId === 'memory_context_workspace_mismatch'));
  assert.ok(workspaceContextInspection.health.blocking.some((check) => check.ruleId === 'message_memory_workspace_mismatch'));
  const workspaceContextRepair = repairDatabase(workspaceContextMismatchRoot, { appVersion: '0.2.17' });
  assert.equal(workspaceContextRepair.status, 'repaired');
  db = openDatabase(workspaceContextMismatchRoot, { appVersion: '0.2.17' });
  assert.deepEqual({ ...db.prepare("SELECT account_workspace_id,memory_document_id FROM agent_context_spaces WHERE id='ctx_memory_workspace_context_memory'").get() }, {
    account_workspace_id: 'workspace_context_secondary', memory_document_id: 'workspace_context_memory',
  });
  assert.deepEqual({ ...db.prepare("SELECT context_space_id,memory_id FROM messages WHERE id='workspace_context_message'").get() }, {
    context_space_id: '', memory_id: '',
  });
  assert.equal(db.prepare("SELECT context_space_id FROM memory_documents WHERE id='workspace_context_memory'").get().context_space_id,
    'ctx_memory_workspace_context_memory');
  assert.deepEqual({ ...db.prepare(`SELECT active_context_space_id,active_memory_document_id FROM agent_context_state
    WHERE user_id='workspace_context_user' AND account_workspace_id='workspace_context_secondary' AND user_agent_instance_id='workspace_context_instance'`).get() }, {
    active_context_space_id: 'ctx_memory_workspace_context_memory', active_memory_document_id: 'workspace_context_memory',
  });
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  prepareCrossFamilyAliasDatabase(aliasStartupRoot);
  db = openDatabase(aliasStartupRoot, { appVersion: '0.2.17' });
  assert.deepEqual({ ...db.prepare("SELECT agent_id,agent_instance_id FROM sessions WHERE id='alias_session'").get() }, {
    agent_id: 'alias_new_family', agent_instance_id: 'alias_new_instance',
  });
  assert.deepEqual({ ...db.prepare("SELECT content,agent_id,agent_instance_id FROM messages WHERE id='alias_message'").get() }, {
    content: 'preserve aliased history', agent_id: 'alias_new_family', agent_instance_id: 'alias_new_instance',
  });
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  prepareCrossFamilyAliasDatabase(aliasRecoveryRoot);
  const aliasRecoveryInspection = inspectDatabaseRecoveryStatus(aliasRecoveryRoot, { appVersion: '0.2.17' });
  assert.equal(aliasRecoveryInspection.status, 'repairable');
  assert.ok(aliasRecoveryInspection.health.blocking.some((check) => check.ruleId === 'session_agent_identity_mismatch'));
  const aliasRecovery = repairDatabase(aliasRecoveryRoot, { appVersion: '0.2.17' });
  assert.equal(aliasRecovery.status, 'repaired');
  assert.equal(aliasRecovery.data.sessions, 1);
  assert.equal(aliasRecovery.data.messages, 1);
  db = openDatabase(aliasRecoveryRoot, { appVersion: '0.2.17' });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id='alias_message' AND content='preserve aliased history'").get().count, 1);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  prepareAliasPrimaryCollisionDatabase(aliasCollisionStartupRoot);
  db = openDatabase(aliasCollisionStartupRoot, { appVersion: '0.2.17' });
  assert.deepEqual(db.prepare(`SELECT id,agent_instance_id,conversation_role,write_state,superseded_by_session_id FROM sessions
    WHERE user_id='alias_collision_user' ORDER BY id`).all().map((row) => ({ ...row })), [{
    id: 'alias_collision_new_session', agent_instance_id: 'alias_collision_new', conversation_role: 'primary',
    write_state: 'writable', superseded_by_session_id: '',
  }, {
    id: 'alias_collision_old_session', agent_instance_id: 'alias_collision_new', conversation_role: 'history',
    write_state: 'read_only', superseded_by_session_id: 'alias_collision_new_session',
  }]);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('alias_collision_old_message','alias_collision_new_message')").get().count, 2);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_sessions_one_primary_agent'").get());
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  prepareAliasPrimaryCollisionDatabase(aliasCollisionRecoveryRoot);
  const aliasCollisionInspection = inspectDatabaseRecoveryStatus(aliasCollisionRecoveryRoot, { appVersion: '0.2.17' });
  assert.equal(aliasCollisionInspection.status, 'repairable');
  assert.ok(aliasCollisionInspection.health.blocking.some((check) => check.ruleId === 'projected_primary_agent_identity_collision'));
  assert.equal(repairDatabase(aliasCollisionRecoveryRoot, { appVersion: '0.2.17' }).status, 'repaired');
  db = openDatabase(aliasCollisionRecoveryRoot, { appVersion: '0.2.17' });
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM sessions WHERE user_id='alias_collision_user'
    AND agent_instance_id='alias_collision_new' AND conversation_role='primary' AND write_state='writable' AND status!='deleted'`).get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id IN ('alias_collision_old_message','alias_collision_new_message')").get().count, 2);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  db = openDatabase(branchRecoveryRoot, { appVersion: '1.0.0' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('branch_user','branch@example.com','Branch Recovery')").run();
  for (const suffix of ['one', 'two']) {
    db.prepare(`INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable)
      VALUES(?,?,'active',1,'employee',1)`).run(`branch_family_${suffix}`, `Branch ${suffix}`);
    db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,status)
      VALUES(?,'branch_user',?,'active')`).run(`branch_instance_${suffix}`, `branch_family_${suffix}`);
    db.prepare(`INSERT INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status
    ) VALUES(?,'workspace_personal','direct','branch_user',?,?,?,'active')`).run(
      `branch_current_conversation_${suffix}`, `Current ${suffix}`, `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO conversations(
      id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,status
    ) VALUES(?,'workspace_personal','direct','branch_user',?,?,?,'active')`).run(
      `branch_stale_conversation_${suffix}`, `Stale ${suffix}`, `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO sessions(
      id,conversation_id,user_id,account_workspace_id,title,agent_id,agent_instance_id,conversation_role,write_state,status
    ) VALUES(?,?,'branch_user','workspace_personal',?,?,?,'primary','writable','active')`).run(
      `branch_current_session_${suffix}`, `branch_current_conversation_${suffix}`, `Current ${suffix}`,
      `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO sessions(
      id,conversation_id,user_id,account_workspace_id,title,agent_id,agent_instance_id,conversation_role,write_state,status
    ) VALUES(?,?,'branch_user','workspace_personal',?,?,?,'history','read_only','active')`).run(
      `branch_stale_session_${suffix}`, `branch_stale_conversation_${suffix}`, `Stale ${suffix}`,
      `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO messages(
      id,account_workspace_id,session_id,conversation_id,role,content,agent_id,agent_instance_id
    ) VALUES(?,'workspace_personal',?,?, 'user',?,?,?)`).run(
      `branch_current_message_${suffix}`, `branch_current_session_${suffix}`, `branch_current_conversation_${suffix}`,
      `preserve current ${suffix}`, `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO messages(
      id,account_workspace_id,session_id,conversation_id,role,content,agent_id,agent_instance_id
    ) VALUES(?,'workspace_personal',?,?, 'assistant',?,?,?)`).run(
      `branch_stale_message_${suffix}`, `branch_stale_session_${suffix}`, `branch_stale_conversation_${suffix}`,
      `preserve stale ${suffix}`, `branch_family_${suffix}`, `branch_instance_${suffix}`,
    );
    db.prepare(`INSERT INTO agent_conversation_branch_state(
      user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,
      thread_generation,rebuild_required,last_injected_timeline_sequence
    ) VALUES('branch_user','workspace_personal',?,?,?,7,0,5)`).run(
      `branch_instance_${suffix}`, `branch_stale_conversation_${suffix}`, `branch_stale_session_${suffix}`,
    );
  }
  db.close();
  const branchInspection = inspectDatabaseRecoveryStatus(branchRecoveryRoot, { appVersion: '1.0.0' });
  assert.equal(branchInspection.status, 'repairable');
  assert.equal(branchInspection.health.blocking.find((check) => check.ruleId === 'agent_conversation_branch_invalid')?.count, 2);
  const branchRepair = repairDatabase(branchRecoveryRoot, { appVersion: '1.0.0' });
  assert.equal(branchRepair.status, 'repaired');
  assert.equal(branchRepair.data.sessions, 4);
  assert.equal(branchRepair.data.messages, 4);
  db = openDatabase(branchRecoveryRoot, { appVersion: '1.0.0' });
  const repairedBranches = db.prepare(`SELECT agent_instance_id,conversation_id,primary_session_id,
    thread_generation,rebuild_required,last_injected_timeline_sequence
    FROM agent_conversation_branch_state WHERE user_id='branch_user' ORDER BY agent_instance_id`).all().map((row) => ({ ...row }));
  assert.deepEqual(repairedBranches, ['one', 'two'].map((suffix) => ({
    agent_instance_id: `branch_instance_${suffix}`,
    conversation_id: `branch_current_conversation_${suffix}`,
    primary_session_id: `branch_current_session_${suffix}`,
    thread_generation: 8,
    rebuild_required: 1,
    last_injected_timeline_sequence: 5,
  })));
  assert.equal(db.prepare("SELECT COUNT(*) count FROM sessions WHERE user_id='branch_user'").get().count, 4);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM messages WHERE id LIKE 'branch_%_message_%'").get().count, 4);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.prepare("DELETE FROM schema_migrations WHERE id='database_core_consistency_repair_v1'").run();
  db.close();
  db = openDatabase(branchRecoveryRoot, { appVersion: '1.0.0' });
  assert.deepEqual(db.prepare(`SELECT agent_instance_id,conversation_id,primary_session_id,
    thread_generation,rebuild_required,last_injected_timeline_sequence
    FROM agent_conversation_branch_state WHERE user_id='branch_user' ORDER BY agent_instance_id`).all().map((row) => ({ ...row })), repairedBranches);
  assert.equal(inspectDatabaseHealth(db).blocking.length, 0);
  db.close();

  process.stdout.write('Database maintenance framework smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
  fs.rmSync(namedConstraintRoot, { recursive: true, force: true });
  fs.rmSync(duplicatePrimaryRoot, { recursive: true, force: true });
  fs.rmSync(workspaceUpgradeDuplicateRoot, { recursive: true, force: true });
  fs.rmSync(projectedWorkspaceCollisionRoot, { recursive: true, force: true });
  fs.rmSync(workspaceContextMismatchRoot, { recursive: true, force: true });
  fs.rmSync(aliasStartupRoot, { recursive: true, force: true });
  fs.rmSync(aliasRecoveryRoot, { recursive: true, force: true });
  fs.rmSync(aliasCollisionStartupRoot, { recursive: true, force: true });
  fs.rmSync(aliasCollisionRecoveryRoot, { recursive: true, force: true });
  fs.rmSync(branchRecoveryRoot, { recursive: true, force: true });
}
