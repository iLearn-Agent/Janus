import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listMigrationBackups } from '../src/main/databaseBackup.js';
import { openDatabase } from '../src/main/db.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-shadow-preflight-'));
try {
  let db = openDatabase(root, { appVersion: '0.2.24', skipMigrationBackup: true });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('shadow_user','shadow@example.com','Shadow')").run();
  db.prepare("INSERT INTO agent_families(id,name,status,routable,instance_kind,recruitable) VALUES('shadow_family','Shadow','active',1,'employee',1)").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('shadow_alias','shadow_user','shadow_family','active')").run();
  db.prepare("INSERT INTO user_agent_instances(id,user_id,agent_family_id,status) VALUES('shadow_canonical','shadow_user','shadow_family','active')").run();
  db.prepare(`INSERT INTO sessions(id,user_id,title,agent_id,agent_instance_id,conversation_role,write_state,status)
    VALUES('shadow_session','shadow_user','Shadow','shadow_family','shadow_alias','primary','writable','active')`).run();
  db.prepare(`INSERT INTO messages(id,session_id,role,content,agent_id,agent_instance_id)
    VALUES('shadow_message','shadow_session','user','must remain untouched','shadow_family','shadow_alias')`).run();
  db.prepare(`INSERT INTO user_agent_instance_aliases(alias_instance_id,canonical_instance_id,user_id,reason)
    VALUES('shadow_alias','shadow_canonical','shadow_user','shadow_failure_probe')`).run();
  db.prepare("DELETE FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").run();
  db.exec(`CREATE TRIGGER force_shadow_migration_failure BEFORE UPDATE OF agent_instance_id ON sessions
    BEGIN SELECT RAISE(ABORT,'forced shadow migration failure'); END`);
  db.close();

  assert.throws(() => openDatabase(root, { appVersion: '0.2.24' }),
    (error) => error.phase === 'shadow_preflight' && /forced shadow migration failure/.test(error.message));
  assert.equal(listMigrationBackups(root).length, 0, 'a failed shadow preflight must stop before creating or replacing migration artifacts');

  db = new DatabaseSync(path.join(root, 'data', 'janus.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT agent_instance_id FROM sessions WHERE id='shadow_session'").get().agent_instance_id, 'shadow_alias');
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='shadow_message'").get().content, 'must remain untouched');
  assert.equal(db.prepare("SELECT 1 FROM schema_migrations WHERE id='agent_alias_context_reference_repair_v3'").get(), undefined);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
  process.stdout.write('Database shadow preflight smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
