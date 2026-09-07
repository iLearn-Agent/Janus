import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { migrateDatabase } from '../src/main/modules/persistence/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-general-family-consolidation-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('user','general-migration@example.com','General Migration')").run();
  db.prepare(`INSERT INTO agent_versions(id,agent_family_id,version_label) VALUES
    ('general_v1','general_agent','v1'),('legacy_general_v1','general_agent_1','v1')`).run();
  db.prepare(`INSERT INTO agent_families(
    id,department_id,name,status,routable,instance_kind,recruitable,default_for_new_user,quota_cost,current_version_id
  ) VALUES
    ('general_agent','general','通用 Agent','active',1,'employee',1,1,1,'general_v1'),
    ('general_agent_1','general','通用 Agent 1','active',1,'employee',1,0,1,'legacy_general_v1')`).run();
  db.prepare(`INSERT INTO user_agent_instances(
    id,user_id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,recruited_at,last_state_changed_at,
    family_instance_seq,display_name
  ) VALUES
    ('canonical','user','general_agent','general_v1','active','employee','active','2026-01-01','2026-01-01',1,'通用 Agent A'),
    ('legacy','user','general_agent_1','legacy_general_v1','active','employee','active','2026-01-02','2026-01-02',1,'通用 Agent 1 A')`).run();
  db.prepare(`INSERT INTO memory_documents(
    id,user_id,user_agent_instance_id,agent_family_id,scope,slot_no,display_name
  ) VALUES('legacy-memory','user','legacy','general_agent_1','general',0,'memory0.md')`).run();
  db.prepare("DELETE FROM schema_migrations WHERE id='general_agent_family_consolidation_v1'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_family_display_names_v1'").run();

  migrateDatabase(db);

  const migrated = db.prepare("SELECT agent_family_id,base_agent_version_id,family_instance_seq,display_name FROM user_agent_instances WHERE id='legacy'").get();
  assert.deepEqual({ ...migrated }, {
    agent_family_id: 'general_agent', base_agent_version_id: 'general_v1', family_instance_seq: 2, display_name: 'Generalist B',
  });
  assert.equal(db.prepare("SELECT agent_family_id FROM memory_documents WHERE id='legacy-memory'").get().agent_family_id, 'general_agent');
  assert.deepEqual({ ...db.prepare("SELECT status,routable,recruitable FROM agent_families WHERE id='general_agent_1'").get() }, {
    status: 'retired', routable: 0, recruitable: 0,
  });
  assert.ok(db.prepare("SELECT id FROM schema_migrations WHERE id='general_agent_family_consolidation_v1'").get());

  db.prepare(`INSERT INTO agent_families(
    id,department_id,name,status,routable,instance_kind,recruitable,default_for_new_user,quota_cost,current_version_id
  ) VALUES('general_agent_2','general','通用 Agent 2','active',1,'employee',1,0,1,'legacy_general_v1')
  ON CONFLICT(id) DO UPDATE SET status='active',routable=1,instance_kind='employee',recruitable=1,quota_cost=1`).run();
  db.prepare(`INSERT INTO user_agent_instances(
    id,user_id,agent_family_id,base_agent_version_id,status,instance_kind,employment_state,recruited_at,last_state_changed_at,
    family_instance_seq,display_name
  ) VALUES('legacy-reintroduced','user','general_agent_2','legacy_general_v1','active','employee','active','2026-01-03','2026-01-03',1,'Generalist A')`).run();
  db.prepare("DELETE FROM schema_migrations WHERE id='general_agent_catalog_repair_v2'").run();

  migrateDatabase(db);

  assert.deepEqual({ ...db.prepare(`SELECT agent_family_id,base_agent_version_id,family_instance_seq,display_name
    FROM user_agent_instances WHERE id='legacy-reintroduced'`).get() }, {
    agent_family_id: 'general_agent', base_agent_version_id: 'general_v1', family_instance_seq: 3, display_name: 'Generalist C',
  });
  assert.deepEqual({ ...db.prepare("SELECT status,routable,instance_kind,recruitable FROM agent_families WHERE id='general_agent_2'").get() }, {
    status: 'retired', routable: 0, instance_kind: 'unavailable', recruitable: 0,
  });
  assert.ok(db.prepare("SELECT id FROM schema_migrations WHERE id='general_agent_catalog_repair_v2'").get());
  const repairedSnapshot = db.prepare(`SELECT id,agent_family_id,family_instance_seq,display_name
    FROM user_agent_instances WHERE user_id='user' ORDER BY id`).all().map((row) => ({ ...row }));
  migrateDatabase(db);
  assert.deepEqual(db.prepare(`SELECT id,agent_family_id,family_instance_seq,display_name
    FROM user_agent_instances WHERE user_id='user' ORDER BY id`).all().map((row) => ({ ...row })), repairedSnapshot);
  console.log('general Agent family consolidation smoke passed');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
