import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { migrateDatabase } from '../src/main/modules/persistence/index.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-employee-profile-uniqueness-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  db.exec('DROP INDEX IF EXISTS idx_user_agent_instances_unique_family_seq');
  db.prepare("DELETE FROM schema_migrations WHERE id='employee_instance_profile_uniqueness_v1'").run();
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('profile_user','profile@example.test','Profile User')").run();
  db.prepare(`INSERT INTO agent_families(
    id,department_id,name,status,routable,instance_kind,recruitable,current_version_id
  ) VALUES('profile_family','general','Profile Family','active',1,'employee',1,'profile_v1')`).run();
  db.prepare("INSERT INTO agent_versions(id,agent_family_id,version_label) VALUES('profile_v1','profile_family','v1')").run();
  const insert = db.prepare(`INSERT INTO user_agent_instances(
    id,user_id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,
    family_instance_seq,display_name,created_at,updated_at
  ) VALUES(?,?, 'profile_family','profile_v1','active','employee','active',4,?,?,?)`);
  insert.run('profile_d', 'profile_user', 'Profile Family D', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  insert.run('profile_e', 'profile_user', 'Profile Family D', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  insert.run('profile_alias', 'profile_user', 'Profile Family D', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z');
  insert.run('profile_custom', 'profile_user', 'My Specialist', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
  db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
    VALUES('profile_alias','profile_d','profile_user','profile_test_alias')`).run();

  const inventoryBefore = {
    instances: db.prepare("SELECT COUNT(*) AS count FROM user_agent_instances WHERE user_id='profile_user'").get().count,
    aliases: db.prepare("SELECT COUNT(*) AS count FROM user_agent_instance_aliases WHERE user_id='profile_user'").get().count,
  };
  migrateDatabase(db);

  const profiles = db.prepare(`SELECT id,family_instance_seq,display_name FROM user_agent_instances
    WHERE user_id='profile_user' ORDER BY created_at,id`).all().map((row) => ({ ...row }));
  assert.deepEqual(profiles, [
    { id: 'profile_d', family_instance_seq: 4, display_name: 'Profile Family D' },
    { id: 'profile_e', family_instance_seq: 5, display_name: 'Profile Family E' },
    { id: 'profile_alias', family_instance_seq: 6, display_name: 'Profile Family F' },
    { id: 'profile_custom', family_instance_seq: 7, display_name: 'My Specialist' },
  ]);
  assert.deepEqual({
    instances: db.prepare("SELECT COUNT(*) AS count FROM user_agent_instances WHERE user_id='profile_user'").get().count,
    aliases: db.prepare("SELECT COUNT(*) AS count FROM user_agent_instance_aliases WHERE user_id='profile_user'").get().count,
  }, inventoryBefore);
  const roster = new Store(db, { root }).listEmployeeRoster({ userId: 'profile_user', includeInactive: true });
  assert.equal(roster.some((item) => item.id === 'profile_alias'), false);
  assert.deepEqual(roster.map((item) => item.id).sort(), ['profile_custom', 'profile_d', 'profile_e']);

  migrateDatabase(db);
  assert.deepEqual(db.prepare(`SELECT id,family_instance_seq,display_name FROM user_agent_instances
    WHERE user_id='profile_user' ORDER BY created_at,id`).all().map((row) => ({ ...row })), profiles);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_user_agent_instances_unique_family_seq'").get());
  console.log('employee instance profile uniqueness smoke passed');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
