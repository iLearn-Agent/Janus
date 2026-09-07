import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { inspectDatabaseRecoveryStatus, repairDatabase } from '../src/main/databaseRecovery.js';
import { Store } from '../src/main/store.js';
import { AuthService } from '../src/main/auth.js';
import { dbPath } from '../src/main/paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-account-workspace-migration-'));
let db;
try {
  db = openDatabase(root, { appVersion: '0.2.16', skipMigrationBackup: true });
  new AuthService(db);
  const store = new Store(db, { root });
  const userId = 'local_admin';
  store.ensureAccountWorkspaces({ user: { id: userId } });
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('migration_agent','Migration Agent','active',1,'employee',1)").run();
  db.prepare("INSERT INTO agent_versions(id,agent_family_id,content_hash,status) VALUES('migration_agent_v1','migration_agent','migration-agent-v1','active')").run();
  db.prepare("UPDATE agent_families SET current_version_id='migration_agent_v1' WHERE id='migration_agent'").run();
  db.prepare(`INSERT INTO user_agent_instances(id,user_id,agent_family_id,base_agent_version_id,status,employment_state)
    VALUES('migration_agent_instance',?,'migration_agent','migration_agent_v1','active','active')`).run(userId);
  const session = store.createSession({ userId, title: 'Legacy Workspace Session', agentId: 'migration_agent', agentInstanceId: 'migration_agent_instance' });
  const memory = store.createAndActivateGeneralMemory({ agentInstanceId: 'migration_agent_instance', content: 'legacy memory survives' });
  db.close();
  db = null;

  const legacy = new DatabaseSync(dbPath(root));
  const dependentTriggerSql = legacy.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (
      'trg_work_memory_publication_outbox_policy_insert','trg_work_memory_publication_outbox_policy_update',
      'trg_messages_agent_identity_insert','trg_messages_agent_identity_update'
    ) ORDER BY name`).all();
  assert.equal(dependentTriggerSql.length, 4, 'the historical fixture must retain cross-table Memory/Context triggers');
  legacy.exec(`PRAGMA foreign_keys=OFF;
    DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_context_spaces_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_device_context_state_identity_update;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_insert;
    DROP TRIGGER IF EXISTS trg_agent_context_state_identity_update;`);
  rebuildWithLegacyConstraint(legacy, 'memory_documents',
    /UNIQUE\s*\(account_workspace_id\s*,\s*user_agent_instance_id/i,
    'UNIQUE(user_agent_instance_id');
  rebuildWithLegacyConstraint(legacy, 'agent_context_spaces',
    /UNIQUE\s*\(account_workspace_id\s*,\s*user_agent_instance_id/i,
    'UNIQUE(user_agent_instance_id');
  rebuildWithLegacyConstraint(legacy, 'agent_context_state',
    /PRIMARY KEY\s*\(user_id\s*,\s*account_workspace_id\s*,\s*user_agent_instance_id\)/i,
    'PRIMARY KEY(user_id,user_agent_instance_id)');
  rebuildWithLegacyConstraint(legacy, 'agent_device_context_state',
    /PRIMARY KEY\s*\(device_id\s*,\s*account_workspace_id\s*,\s*user_agent_instance_id\)/i,
    'PRIMARY KEY(device_id,user_agent_instance_id)');
  rebuildWithLegacyConstraint(legacy, 'account_workspace_memberships', /,'guest'/i, '');
  rebuildWithLegacyConstraint(legacy, 'account_workspace_memberships', /,'removed'/i, '');
  for (const trigger of dependentTriggerSql) legacy.exec(trigger.sql);
  legacy.exec(`DROP INDEX IF EXISTS idx_one_active_general_memory;
    CREATE UNIQUE INDEX idx_one_active_general_memory ON memory_documents(user_id,user_agent_instance_id)
      WHERE scope='general' AND lifecycle_state='active';
    DELETE FROM schema_migrations WHERE id='account_workspace_membership_domain_v2';
    DELETE FROM schema_migrations WHERE id='account_workspace_context_isolation_v2';
    PRAGMA foreign_keys=ON;`);
  legacy.close();

  const inspection = inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.16' });
  assert.equal(inspection.status, 'repairable');
  const repair = repairDatabase(root, { appVersion: '0.2.16' });
  assert.equal(repair.status, 'repaired');
  db = openDatabase(root, { appVersion: '0.2.16', skipMigrationBackup: true });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations WHERE id='account_workspace_context_isolation_v2'").get().count, 1);
  assert.equal(db.prepare('SELECT account_workspace_id FROM sessions WHERE id=?').get(session.id).account_workspace_id, 'workspace_personal');
  assert.equal(db.prepare('SELECT account_workspace_id FROM memory_documents WHERE id=?').get(memory.id).account_workspace_id, 'workspace_personal');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_documents'").get().sql,
    /UNIQUE\s*\(account_workspace_id\s*,\s*user_agent_instance_id/i);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_context_state'").get().sql,
    /PRIMARY KEY\s*\(user_id\s*,\s*account_workspace_id\s*,\s*user_agent_instance_id\)/i);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_workspace_memberships'").get().sql,
    /role IN \('owner','admin','member','guest'\)/i);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='account_workspace_memberships'").get().sql,
    /status IN \('active','suspended','left','removed'\)/i);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_one_active_general_memory'").get().sql,
    /account_workspace_id\s*,\s*user_id\s*,\s*user_agent_instance_id/i);
  for (const triggerName of dependentTriggerSql.map((trigger) => trigger.name)) {
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName);
    assert.ok(trigger?.sql, `trigger ${triggerName} must be restored after Workspace table reconstruction`);
    assert.doesNotMatch(trigger.sql, /_account_workspace_v1\b/i);
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  db = null;

  const damaged = new DatabaseSync(dbPath(root));
  damaged.exec(`DROP TRIGGER IF EXISTS trg_work_memory_publication_outbox_policy_insert;
    CREATE TRIGGER trg_work_memory_publication_outbox_policy_insert BEFORE INSERT ON work_memory_publication_outbox BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM memory_document_versions mdv
        JOIN memory_documents_account_workspace_v1 md ON md.id=mdv.memory_document_id
        WHERE mdv.id=NEW.memory_document_version_id
      ) THEN RAISE(ABORT,'dangling Workspace migration fixture') END;
    END;
    DELETE FROM schema_migrations WHERE id='account_workspace_context_isolation_v2';`);
  damaged.close();
  assert.equal(inspectDatabaseRecoveryStatus(root, { appVersion: '0.2.16' }).status, 'repairable');
  assert.equal(repairDatabase(root, { appVersion: '0.2.16' }).status, 'repaired');
  db = openDatabase(root, { appVersion: '0.2.16', skipMigrationBackup: true });
  const repairedTriggerSql = db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='trg_work_memory_publication_outbox_policy_insert'`).get()?.sql || '';
  assert.match(repairedTriggerSql, /JOIN memory_documents md/i);
  assert.doesNotMatch(repairedTriggerSql, /memory_documents_account_workspace_v1/i);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  console.log(JSON.stringify({ ok: true, preservedSessionId: session.id, preservedMemoryId: memory.id }, null, 2));
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function rebuildWithLegacyConstraint(db, tableName, pattern, replacement) {
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE ?").all(`%${tableName}%`)) {
    db.exec(`DROP TRIGGER IF EXISTS "${String(trigger.name).replaceAll('"', '""')}"`);
  }
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tableName)?.sql || '');
  const legacySql = sql.replace(pattern, replacement);
  assert.notEqual(legacySql, sql, `failed to create legacy constraint for ${tableName}`);
  const legacyName = `${tableName}_workspace_smoke_legacy`;
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
  const columnSql = columns.map((column) => `"${column}"`).join(',');
  db.exec(`ALTER TABLE "${tableName}" RENAME TO "${legacyName}";
    ${legacySql};
    INSERT INTO "${tableName}"(${columnSql}) SELECT ${columnSql} FROM "${legacyName}";
    DROP TABLE "${legacyName}";`);
}
