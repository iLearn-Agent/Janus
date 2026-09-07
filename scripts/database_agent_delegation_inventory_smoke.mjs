import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  assertDatabaseInventoryPreserved,
  collectDatabaseInventory,
} from '../src/main/modules/persistence/infrastructure/databaseInventory.js';

const db = new DatabaseSync(':memory:');

try {
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,account_workspace_id TEXT NOT NULL,
    agent_instance_id TEXT NOT NULL,conversation_id TEXT NOT NULL,department_id TEXT NOT NULL,
    conversation_role TEXT NOT NULL,write_state TEXT NOT NULL,superseded_by_session_id TEXT NOT NULL,status TEXT NOT NULL
  );
  CREATE TABLE agent_delegations (
    id TEXT PRIMARY KEY,account_workspace_id TEXT NOT NULL,requester_user_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,sender_agent_id TEXT NOT NULL,recipient_agent_id TEXT NOT NULL,
    title TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,session_id TEXT NOT NULL,
    task_run_id TEXT NOT NULL,group_id TEXT NOT NULL,metadata_json TEXT NOT NULL,last_error TEXT NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT NOT NULL,completed_at TEXT NOT NULL
  );
  CREATE TABLE agent_delegation_workspaces (
    delegation_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,PRIMARY KEY(delegation_id,user_id)
  );
  INSERT INTO sessions VALUES(
    'history_session','recipient_user','workspace_personal','recipient_agent','history_conversation',
    'agent_delegation','primary','writable','','active'
  );
  INSERT INTO sessions VALUES(
    'primary_session','recipient_user','workspace_personal','recipient_agent','primary_conversation',
    'agent_delegation','primary','writable','','active'
  );
  INSERT INTO agent_delegations VALUES(
    'delegation_1','workspace_personal','requester_user','recipient_user','sender_agent','recipient_agent',
    'Delegated task','Keep the task history','completed','history_session','','',
    '{"publicTag":"preserve","intakeSummary":{"summary":"private"}}','',
    '2026-08-01T00:00:00.000Z','2026-08-02T00:00:00.000Z','2026-08-01T00:01:00.000Z','2026-08-02T00:00:00.000Z'
  );
  INSERT INTO agent_delegation_workspaces VALUES(
    'delegation_1','recipient_user','history_session','{"existingPrivate":"preserve"}'
  );`);

  const before = collectDatabaseInventory(db, { includeContentFingerprints: true });

  db.exec(`UPDATE sessions SET conversation_role='history',write_state='read_only',
      superseded_by_session_id='primary_session' WHERE id='history_session';
    UPDATE agent_delegations SET session_id='primary_session',metadata_json='{"publicTag":"preserve"}'
      WHERE id='delegation_1';
    UPDATE agent_delegation_workspaces SET session_id='primary_session',
      metadata_json='{"intakeSummary":{"summary":"private"},"existingPrivate":"preserve"}'
      WHERE delegation_id='delegation_1' AND user_id='recipient_user';`);

  const after = collectDatabaseInventory(db, { includeContentFingerprints: true });
  assert.equal(assertDatabaseInventoryPreserved(before, after), true,
    'a proven history-to-primary Session rebind and private metadata move must preserve the delegation semantically');

  db.prepare(`UPDATE agent_delegation_workspaces SET metadata_json='{"existingPrivate":"preserve"}'
    WHERE delegation_id='delegation_1' AND user_id='recipient_user'`).run();
  const missingPrivate = collectDatabaseInventory(db, { includeContentFingerprints: true });
  assert.throws(() => assertDatabaseInventoryPreserved(before, missingPrivate), /missing private agent delegation metadata: intakeSummary/);

  db.prepare(`UPDATE agent_delegation_workspaces SET metadata_json=
    '{"intakeSummary":{"summary":"private"},"existingPrivate":"preserve"}'
    WHERE delegation_id='delegation_1' AND user_id='recipient_user'`).run();
  db.prepare("UPDATE agent_delegations SET metadata_json='{}' WHERE id='delegation_1'").run();
  const missingPublic = collectDatabaseInventory(db, { includeContentFingerprints: true });
  assert.throws(() => assertDatabaseInventoryPreserved(before, missingPublic), /changed public agent delegation metadata: publicTag/);

  db.prepare("UPDATE agent_delegations SET metadata_json='{\"publicTag\":\"preserve\"}' WHERE id='delegation_1'").run();
  db.prepare("UPDATE sessions SET superseded_by_session_id='' WHERE id='history_session'").run();
  db.prepare("UPDATE sessions SET department_id='general' WHERE id='primary_session'").run();
  const unprovenRebind = collectDatabaseInventory(db, { includeContentFingerprints: true });
  assert.throws(() => assertDatabaseInventoryPreserved(before, unprovenRebind), /unproven agent delegation session rebind/);

  process.stdout.write('Database Agent delegation inventory smoke passed.\n');
} finally {
  db.close();
}
