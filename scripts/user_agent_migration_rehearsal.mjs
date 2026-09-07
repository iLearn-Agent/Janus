import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { inspectDatabaseBackup } from '../src/main/databaseBackup.js';
import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-identity-migration-rehearsal-'));
try {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const legacy = new DatabaseSync(path.join(root, 'data', 'janus.db'));
  legacy.exec(`
    CREATE TABLE auth_users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', avatar_url TEXT NOT NULL DEFAULT '',
      auth_provider TEXT NOT NULL DEFAULT 'local_mock',
      email_verified INTEGER NOT NULL DEFAULT 1, phone_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member', password_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO auth_users (id, email, display_name) VALUES ('local_admin', 'admin@janus.local', 'Admin');

    CREATE TABLE agent_families (
      id TEXT PRIMARY KEY,
      department_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'agent',
      status TEXT NOT NULL DEFAULT 'active',
      routable INTEGER NOT NULL DEFAULT 0,
      current_version_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE user_agent_instances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_family_id TEXT NOT NULL,
      base_agent_version_id TEXT NOT NULL DEFAULT '',
      active_personal_skill_version_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      personal_evolution_consent INTEGER NOT NULL DEFAULT 0,
      cluster_contribution_consent INTEGER NOT NULL DEFAULT 0,
      personal_skill_auto_activate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(user_id, agent_family_id)
    );
    INSERT INTO agent_families (id, department_id, name, role, status, routable)
      VALUES ('secretary_agent', 'secretary_department', 'uBuddy', 'agent', 'active', 1);
    INSERT INTO agent_families (id, department_id, name, role, status, routable)
      VALUES ('legacy_hr', 'legacy_department', 'Legacy HR', 'hr', 'active', 0);
  `);
  for (let index = 1; index <= 12; index += 1) {
    legacy.prepare(`INSERT INTO agent_families (id, department_id, name, role, status, routable)
      VALUES (?, 'legacy_department', ?, 'agent', 'active', 1)`).run(`legacy_employee_${index}`, `Legacy Employee ${index}`);
    if (index <= 11) {
      legacy.prepare(`INSERT INTO user_agent_instances (
        id, user_id, agent_family_id, status, created_at, updated_at
      ) VALUES (?, 'local_admin', ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run(
        `legacy_instance_${index}`,
        `legacy_employee_${index}`,
      );
    }
  }
  legacy.prepare(`INSERT INTO user_agent_instances (
    id, user_id, agent_family_id, status, created_at, updated_at
  ) VALUES ('legacy_secretary_instance', 'local_admin', 'secretary_agent', 'active', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`).run();
  legacy.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL DEFAULT 'local_admin',title TEXT NOT NULL DEFAULT 'Untitled',
    department_id TEXT NOT NULL DEFAULT '',agent_id TEXT NOT NULL DEFAULT '',agent_instance_id TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT '',workspace_root TEXT NOT NULL DEFAULT '',interaction_mode TEXT NOT NULL DEFAULT '',
    memory_use_enabled INTEGER NOT NULL DEFAULT 1,memory_generate_enabled INTEGER NOT NULL DEFAULT 0,
    goal_objective TEXT NOT NULL DEFAULT '',goal_status TEXT NOT NULL DEFAULT '',goal_tokens_used INTEGER NOT NULL DEFAULT 0,
    goal_token_budget INTEGER NOT NULL DEFAULT 0,goal_time_used_seconds INTEGER NOT NULL DEFAULT 0,codex_thread_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',
    pinned_at TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO sessions(id,user_id,title,department_id,agent_id,agent_instance_id,created_at,updated_at)
    VALUES('legacy_employee_session_old','local_admin','Old employee chat','legacy_department','legacy_employee_1','legacy_instance_1','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z');
  INSERT INTO sessions(id,user_id,title,department_id,agent_id,agent_instance_id,created_at,updated_at)
    VALUES('legacy_employee_session_new','local_admin','Latest employee chat','legacy_department','legacy_employee_1','legacy_instance_1','2026-01-03T00:00:00.000Z','2026-01-04T00:00:00.000Z');`);
  legacy.close();
  const migrated = openDatabase(root);
  assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const authUserColumns = migrated.prepare('PRAGMA table_info(auth_users)').all().map((row) => row.name);
  assert.ok(authUserColumns.includes('remote_id'), 'legacy auth_users must gain remote_id before schema indexes are created');
  assert.equal(migrated.prepare("SELECT remote_id FROM auth_users WHERE id = 'local_admin'").get().remote_id, '');
  assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_auth_users_remote_id_unique'").get());
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_agent_instances'").get());
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'personal_evolution_proposals'").get());
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_agent_recruitment_events'").get());
  assert.ok(migrated.prepare("SELECT id FROM schema_migrations WHERE id = 'employee_recruitment_phase_a_v1'").get());
  const familyColumns = migrated.prepare('PRAGMA table_info(agent_families)').all().map((row) => row.name);
  const instanceColumns = migrated.prepare('PRAGMA table_info(user_agent_instances)').all().map((row) => row.name);
  for (const column of ['instance_kind', 'recruitable', 'default_for_new_user', 'quota_cost', 'classification_version']) {
    assert.ok(familyColumns.includes(column), `missing migrated Agent family column: ${column}`);
  }
  for (const column of ['instance_kind', 'employment_state', 'quota_exempt', 'recruited_at', 'deactivated_at', 'last_state_changed_at', 'state_revision', 'recruitment_source', 'policy_version', 'pending_target_state', 'authority_state', 'last_employee_command_id', 'family_instance_seq', 'display_name', 'note']) {
    assert.ok(instanceColumns.includes(column), `missing migrated user Agent instance column: ${column}`);
  }
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='employee_command_outbox'").get());
  assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_identity_migration_quarantine'").get());
  assert.ok(migrated.prepare("SELECT id FROM schema_migrations WHERE id='primary_context_memory_v1'").get());
  assert.deepEqual({ ...migrated.prepare("SELECT conversation_role,write_state,superseded_by_session_id FROM sessions WHERE id='legacy_employee_session_new'").get() }, {
    conversation_role: 'primary', write_state: 'writable', superseded_by_session_id: '',
  });
  assert.deepEqual({ ...migrated.prepare("SELECT conversation_role,write_state,superseded_by_session_id FROM sessions WHERE id='legacy_employee_session_old'").get() }, {
    conversation_role: 'history', write_state: 'read_only', superseded_by_session_id: 'legacy_employee_session_new',
  });
  assert.deepEqual(
    { ...migrated.prepare("SELECT instance_kind, recruitable, quota_cost FROM agent_families WHERE id = 'secretary_agent'").get() },
    { instance_kind: 'system', recruitable: 0, quota_cost: 0 },
  );
  assert.deepEqual(
    { ...migrated.prepare("SELECT instance_kind, recruitable, quota_cost FROM agent_families WHERE id = 'legacy_hr'").get() },
    { instance_kind: 'governance', recruitable: 0, quota_cost: 0 },
  );
  const preservedLegacyInstance = migrated.prepare("SELECT * FROM user_agent_instances WHERE id = 'legacy_instance_1'").get();
  assert.equal(preservedLegacyInstance.instance_kind, 'employee');
  assert.equal(preservedLegacyInstance.employment_state, 'active');
  assert.equal(preservedLegacyInstance.quota_exempt, 0);
  assert.equal(preservedLegacyInstance.recruited_at, '2026-01-01T00:00:00.000Z');
  assert.equal(preservedLegacyInstance.last_state_changed_at, '2026-01-02T00:00:00.000Z');
  assert.equal(preservedLegacyInstance.recruitment_source, 'migration');
  assert.equal(preservedLegacyInstance.authority_state, 'migration_grandfathered');
  assert.equal(preservedLegacyInstance.personal_evolution_consent, 1);
  assert.equal(preservedLegacyInstance.cluster_contribution_consent, 1);
  assert.equal(preservedLegacyInstance.family_instance_seq, 1);
  assert.match(preservedLegacyInstance.display_name, / A$/);
  assert.doesNotThrow(() => migrated.prepare(`INSERT INTO user_agent_instances (
    id,user_id,agent_family_id,status,instance_kind,employment_state,quota_exempt,authority_state,family_instance_seq,display_name
  ) VALUES ('legacy_instance_1_b','local_admin','legacy_employee_1','active','employee','active',0,'migration_grandfathered',2,'Legacy Employee B')`).run(),
  'migration must remove the old user/family singleton constraint');
  migrated.prepare("DELETE FROM user_agent_instances WHERE id='legacy_instance_1_b'").run();
  assert.equal(migrated.prepare("SELECT instance_kind, quota_exempt FROM user_agent_instances WHERE id = 'legacy_secretary_instance'").get().instance_kind, 'system');
  const store = new Store(migrated);
  migrated.prepare(`INSERT INTO sessions (id,user_id,title,department_id,agent_id,status)
    VALUES ('unresolved_legacy_session','local_admin','Unresolved legacy','missing_department','missing_agent','archived')`).run();
  const backfill = store.backfillAgentInstanceReferences({ creationPolicy: 'existing_only' });
  assert.ok(backfill.quarantineCount >= 1);
  assert.ok(migrated.prepare(`SELECT id FROM agent_identity_migration_quarantine
    WHERE source_table='sessions' AND source_id='unresolved_legacy_session'`).get());
  assert.deepEqual(store.getEmployeeQuota({ userId: 'local_admin' }), {
    used: 11,
    limit: 10,
    remaining: 0,
    grandfatheredOverLimit: true,
    policyState: 'grandfathered_over_limit',
    policyVersion: 'employee_recruitment_phase_a_v1',
  });
  assert.doesNotThrow(() => migrated.prepare("UPDATE user_agent_instances SET employment_state = 'active' WHERE id = 'legacy_instance_1'").run(), 'grandfathered rows must remain updateable when they do not add quota usage');
  assert.throws(() => migrated.prepare(`INSERT INTO user_agent_instances (
    id, user_id, agent_family_id, status, instance_kind, employment_state, quota_exempt
  ) VALUES ('legacy_instance_12', 'local_admin', 'legacy_employee_12', 'active', 'employee', 'active', 0)`).run(), /employee quota exceeded/);
  assert.ok(migrated.migrationBackup?.backupPath);
  assert.equal(inspectDatabaseBackup(migrated.migrationBackup.backupPath).integrity, 'ok');
  process.stdout.write(`${JSON.stringify({ status: 'passed', root, backup: migrated.migrationBackup.backupPath }, null, 2)}\n`);
  migrated.close();
} finally {
  if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
}
