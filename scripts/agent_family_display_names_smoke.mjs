import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { migrateDatabase } from '../src/main/modules/persistence/index.js';
import { agentInstanceSequenceLabel, canonicalAgentFamilyName, canonicalAgentInstanceDisplayName } from '../src/shared/agentInstanceNaming.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-agent-family-display-names-'));
let db;
try {
  db = openDatabase(root, { skipMigrationBackup: true });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('naming-user','naming@example.com','Naming User')").run();
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('compaction-user','compact@example.com','Compaction User')").run();
  db.prepare(`INSERT INTO agent_families(
    id,department_id,name,status,routable,instance_kind,recruitable,default_for_new_user,quota_cost
  ) VALUES
    ('general_agent','general','通用 Agent','active',1,'employee',1,1,1),
    ('general_agent_4','general','General Agent 4','active',1,'employee',1,0,1),
    ('ppt','ppt_department','PPT Agent','active',1,'employee',1,0,1)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run();
  db.prepare(`INSERT INTO user_agent_instances(
    id,user_id,agent_family_id,status,instance_kind,employment_state,recruited_at,last_state_changed_at,
    family_instance_seq,display_name,note
  ) VALUES
    ('general-a','naming-user','general_agent','active','employee','active','2026-01-01','2026-01-01',1,'通用 Agent A',''),
    ('general-b','naming-user','general_agent','active','employee','active','2026-01-02','2026-01-02',2,'General Agent B',''),
    ('general-custom','naming-user','general_agent','active','employee','active','2026-01-03','2026-01-03',3,'Research Lead','custom'),
    ('general-extra-default','naming-user','general_agent_4','active','employee','active','2026-01-03T01:00:00Z','2026-01-03T01:00:00Z',1,'General Agent 4 A',''),
    ('general-extra-custom','naming-user','general_agent_4','active','employee','active','2026-01-03T02:00:00Z','2026-01-03T02:00:00Z',2,'General Agent CEO','custom'),
    ('ppt-a','naming-user','ppt','active','employee','active','2026-01-04','2026-01-04',1,'PPT Agent A',''),
    ('ppt-custom','naming-user','ppt','active','employee','active','2026-01-05','2026-01-05',2,'Deck Specialist','custom'),
    ('compact-a','compaction-user','general_agent','active','employee','active','2026-02-01','2026-02-01',0,'Generalist A',''),
    ('compact-b','compaction-user','general_agent','active','employee','active','2026-02-02','2026-02-02',0,'Generalist A',''),
    ('compact-c','compaction-user','general_agent','active','employee','active','2026-02-03','2026-02-03',0,'Generalist A',''),
    ('compact-custom','compaction-user','general_agent','active','employee','active','2026-02-04','2026-02-04',0,'Operations Lead','custom')`).run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,department_id,agent_id,agent_instance_id)
    VALUES('naming-session','naming-user','Historical naming conversation','general','general_agent','general-a')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id,department_id)
    VALUES('naming-message','naming-session','assistant','历史正文仍然提到通用 Agent A。','general_agent','general-a','general')`).run();
  db.prepare(`INSERT INTO memory_documents(id,user_id,user_agent_instance_id,agent_family_id,scope,slot_no,display_name)
    VALUES('naming-memory','naming-user','general-a','general_agent','general',0,'memory0.md')`).run();
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_family_display_names_v1'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_family_name_alignment_v2'").run();
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_instance_sequence_compaction_v3'").run();

  const messageBefore = { ...db.prepare("SELECT id,role,content,created_at FROM messages WHERE id='naming-message'").get() };
  const memoryBefore = { ...db.prepare("SELECT id,user_agent_instance_id,agent_family_id,display_name FROM memory_documents WHERE id='naming-memory'").get() };
  migrateDatabase(db);

  assert.deepEqual(db.prepare("SELECT id,name FROM agent_families WHERE id IN ('general_agent','general_agent_4','ppt') ORDER BY id").all().map((row) => ({ ...row })), [
    { id: 'general_agent', name: 'Generalist' },
    { id: 'general_agent_4', name: 'Generalist' },
    { id: 'ppt', name: 'PPT Designer' },
  ]);
  assert.deepEqual(db.prepare(`SELECT id,display_name,note FROM user_agent_instances
    WHERE user_id='naming-user' ORDER BY created_at,id`).all().map((row) => ({ ...row })), [
    { id: 'general-a', display_name: 'Generalist A', note: '' },
    { id: 'general-b', display_name: 'Generalist B', note: '' },
    { id: 'general-custom', display_name: 'Research Lead', note: 'custom' },
    { id: 'general-extra-custom', display_name: 'General Agent CEO', note: 'custom' },
    { id: 'general-extra-default', display_name: 'Generalist A', note: '' },
    { id: 'ppt-a', display_name: 'PPT Designer A', note: '' },
    { id: 'ppt-custom', display_name: 'Deck Specialist', note: 'custom' },
  ]);
  assert.deepEqual({ ...db.prepare("SELECT id,role,content,created_at FROM messages WHERE id='naming-message'").get() }, messageBefore);
  assert.deepEqual({ ...db.prepare("SELECT id,user_agent_instance_id,agent_family_id,display_name FROM memory_documents WHERE id='naming-memory'").get() }, memoryBefore);
  assert.ok(db.prepare("SELECT id FROM schema_migrations WHERE id='agent_family_display_names_v1'").get());
  assert.ok(db.prepare("SELECT id FROM schema_migrations WHERE id='agent_family_name_alignment_v2'").get());
  assert.ok(db.prepare("SELECT id FROM schema_migrations WHERE id='agent_instance_sequence_compaction_v3'").get());
  assert.deepEqual(db.prepare(`SELECT id,family_instance_seq,display_name,note FROM user_agent_instances
    WHERE user_id='compaction-user' ORDER BY family_instance_seq,id`).all().map((row) => ({ ...row })), [
    { id: 'compact-a', family_instance_seq: 1, display_name: 'Generalist A', note: '' },
    { id: 'compact-b', family_instance_seq: 2, display_name: 'Generalist B', note: '' },
    { id: 'compact-c', family_instance_seq: 3, display_name: 'Generalist C', note: '' },
    { id: 'compact-custom', family_instance_seq: 4, display_name: 'Operations Lead', note: 'custom' },
  ]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const snapshot = db.prepare(`SELECT id,agent_family_id,family_instance_seq,display_name,note,updated_at
    FROM user_agent_instances WHERE user_id IN ('naming-user','compaction-user') ORDER BY user_id,id`).all().map((row) => ({ ...row }));
  migrateDatabase(db);
  assert.deepEqual(db.prepare(`SELECT id,agent_family_id,family_instance_seq,display_name,note,updated_at
    FROM user_agent_instances WHERE user_id IN ('naming-user','compaction-user') ORDER BY user_id,id`).all().map((row) => ({ ...row })), snapshot);

  assert.equal(agentInstanceSequenceLabel(27), 'AA');
  assert.equal(canonicalAgentFamilyName('future_general_family', '通用 Agent 12'), 'Generalist');
  assert.equal(canonicalAgentFamilyName('future_presentation_family', 'PPTAgent'), 'PPT Designer');
  assert.equal(canonicalAgentInstanceDisplayName({
    agentFamilyId: 'ppt', familyName: 'PPT Designer', displayName: 'PPT Agent B', sequence: 2,
  }), 'PPT Designer B');
  assert.equal(canonicalAgentInstanceDisplayName({
    agentFamilyId: 'general_agent', familyName: 'Generalist', displayName: 'General Agent CEO', sequence: 3,
  }), 'General Agent CEO');
  assert.equal(canonicalAgentInstanceDisplayName({
    agentFamilyId: 'general_agent', familyName: 'Generalist', displayName: 'Research Lead', sequence: 3,
  }), 'Research Lead');

  console.log('Agent family display names smoke passed.');
} finally {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
