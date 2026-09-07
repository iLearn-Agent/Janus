import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/main/db.js';
import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-message-session-agent-consistency-'));
let runtime = await createRuntime({ root, isDev: true, serverAuthoritativeSkills: true });

try {
  const user = runtime.currentUser();
  const agentA = runtime.store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'ppt',
    commandId: 'message-consistency:recruit-a',
  }).instance;
  const agentB = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'general_agent',
      commandId: 'message-consistency:recruit-b',
    }).instance;
  const sessionA = runtime.store.createSession({
    title: 'Agent A primary', userId: user.id, departmentId: 'ppt_department', agentId: 'ppt', agentInstanceId: agentA.id,
  });
  const sessionB = runtime.store.createSession({
    title: 'Agent B primary', userId: user.id, departmentId: 'general', agentId: 'general_agent', agentInstanceId: agentB.id,
  });
  const directMismatch = runtime.store.addMessage({
    sessionId: sessionB.id, role: 'user', content: 'DIRECT_NONEMPTY_MISMATCH',
    agentId: 'general_agent', agentInstanceId: agentB.id, departmentId: 'general',
  });
  const aliasMismatch = runtime.store.addMessage({
    sessionId: sessionB.id, role: 'assistant', content: 'ALIASED_NONEMPTY_MISMATCH',
    agentId: 'general_agent', agentInstanceId: agentB.id, departmentId: 'general',
  });
  const emptyIdentity = runtime.store.addMessage({
    sessionId: sessionA.id, role: 'user', content: 'EMPTY_LEGACY_IDENTITY',
    agentId: 'ppt', agentInstanceId: agentA.id, departmentId: 'ppt_department',
  });
  runtime.store.db.exec(`DROP TRIGGER trg_messages_agent_identity_insert;
    DROP TRIGGER trg_messages_agent_identity_update`);
  runtime.store.db.prepare(`INSERT INTO user_agent_instance_aliases
    (alias_instance_id,canonical_instance_id,user_id,reason) VALUES (?,?,?,?)`)
    .run('legacy-agent-b-alias', agentB.id, user.id, 'message-consistency-repair-smoke');
  runtime.store.db.prepare('UPDATE messages SET session_id=? WHERE id=?').run(sessionA.id, directMismatch.id);
  runtime.store.db.prepare("UPDATE messages SET session_id=?,agent_instance_id='legacy-agent-b-alias' WHERE id=?")
    .run(sessionA.id, aliasMismatch.id);
  runtime.store.db.prepare("UPDATE messages SET agent_id='',agent_instance_id='',department_id='' WHERE id=?").run(emptyIdentity.id);
  runtime.store.db.prepare("UPDATE sessions SET status='deleted',conversation_role='history',write_state='read_only' WHERE id=?")
    .run(sessionB.id);
  runtime.store.db.exec("CREATE UNIQUE INDEX legacy_sessions_user_agent_unique ON sessions(user_id,agent_instance_id) WHERE agent_instance_id!=''");
  runtime.store.db.prepare(`DELETE FROM schema_migrations WHERE id IN (
    'message_session_agent_consistency_repair_v2',
    'legacy_message_session_agent_backfill_v1'
  )`).run();
  runtime.close();
  runtime = null;

  const migrated = openDatabase(root);
  try {
    assert.equal(migrated.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    for (const messageId of [directMismatch.id, aliasMismatch.id]) {
      const message = migrated.prepare(`SELECT session_id,agent_id,agent_instance_id,department_id
        FROM messages WHERE id=?`).get(messageId);
      assert.deepEqual({ ...message }, {
        session_id: sessionB.id,
        agent_id: 'general_agent',
        agent_instance_id: agentB.id,
        department_id: 'general',
      });
    }
    const repairedEmpty = migrated.prepare(`SELECT session_id,agent_id,agent_instance_id,department_id
      FROM messages WHERE id=?`).get(emptyIdentity.id);
    assert.deepEqual({ ...repairedEmpty }, {
      session_id: sessionA.id,
      agent_id: 'ppt',
      agent_instance_id: agentA.id,
      department_id: 'ppt_department',
    });
    assert.ok(migrated.prepare("SELECT 1 FROM schema_migrations WHERE id='message_session_agent_consistency_repair_v2'").get());
    assert.equal(migrated.prepare('SELECT status FROM sessions WHERE id=?').get(sessionB.id).status, 'active');
    assert.ok(migrated.migrationBackup?.backupPath, 'startup repair must create a pre-migration database backup');
  } finally {
    migrated.close();
  }

  process.stdout.write('Message/session Agent consistency repair smoke passed.\n');
} finally {
  runtime?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
