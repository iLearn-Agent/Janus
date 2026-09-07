import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-presence-dispatch-'));

try {
  let db = openDatabase(root, { appVersion: '1.0.0' });
  let store = new Store(db, { root });
  const command = {
    version: 3,
    id: 'presence-dispatch-1',
    dispatchType: 'task_group',
    assignments: [
      { assignmentId: 'assignment-a', recipientId: 'recipient-a', instruction: 'Complete A.' },
      { assignmentId: 'assignment-b', recipientId: 'recipient-b', instruction: 'Complete B.' },
    ],
  };

  store.reserveUBuddyDispatchCommand({
    command,
    ownerUserId: 'owner-1',
    accountWorkspaceId: 'workspace_personal',
    sourceSessionId: 'session-1',
  });
  store.initializePendingDispatchAssignments({ commandId: command.id, assignments: command.assignments });
  store.initializePendingDispatchAssignments({ commandId: command.id, assignments: command.assignments });
  assert.equal(store.pendingDispatchAssignments(command.id).length, 2, 'repeated initialization must stay idempotent');

  let ledger = store.claimUBuddyDispatchCommand({ commandId: command.id });
  assert.equal(ledger.attemptCount, 1);
  store.deferUBuddyDispatchCommand({ commandId: command.id, reason: 'awaiting_recipient_presence', retryDelayMs: 1_000 });
  db.prepare("UPDATE ubuddy_dispatch_commands SET next_attempt_at='' WHERE command_id=?").run(command.id);
  ledger = store.claimUBuddyDispatchCommand({ commandId: command.id });
  assert.equal(ledger.attemptCount, 1, 'presence polling must not consume failure attempts');

  store.updatePendingDispatchAssignment({
    commandId: command.id,
    assignmentId: 'assignment-a',
    status: 'published',
    delegationId: 'delegation-a',
    groupId: 'group-1',
  });
  store.checkpointUBuddyDispatchCommand({ commandId: command.id, patch: { groupId: 'group-1' } });
  store.deferUBuddyDispatchCommand({ commandId: command.id, reason: 'awaiting_recipient_presence', retryDelayMs: 1_000 });
  db.close();

  db = openDatabase(root, { appVersion: '1.0.0' });
  store = new Store(db, { root });
  ledger = store.getUBuddyDispatchCommand(command.id);
  assert.equal(ledger.result.groupId, 'group-1', 'restart recovery must preserve the progressive group id');
  assert.deepEqual(store.pendingDispatchAssignments(command.id).map((item) => item.status), ['published', 'awaiting_presence']);

  store.cancelPendingDispatchAssignments({ commandId: command.id });
  ledger = store.cancelUBuddyDispatchCommand({ commandId: command.id, reason: 'cancelled_by_owner' });
  assert.equal(ledger.status, 'cancelled');
  assert.deepEqual(store.pendingDispatchAssignments(command.id).map((item) => item.status), ['published', 'cancelled'],
    'cancellation must leave already-published assignments intact');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();

  const raw = new DatabaseSync(path.join(root, 'data', 'janus.db'));
  raw.exec(`DROP TABLE ubuddy_pending_dispatch_assignments;
    DELETE FROM schema_migrations WHERE id='ubuddy_presence_gated_dispatch_v1';`);
  raw.close();
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='ubuddy_pending_dispatch_assignments'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM schema_migrations WHERE id='ubuddy_presence_gated_dispatch_v1'").get().count, 1);
  assert.equal(db.prepare("SELECT status FROM ubuddy_dispatch_commands WHERE command_id=?").get(command.id).status, 'cancelled',
    'the additive historical upgrade must preserve the existing dispatch command');
  db.close();
  db = openDatabase(root, { appVersion: '1.0.0' });
  assert.equal(db.maintenance.pendingMigrationIds.length, 0, 'a second open must be idempotent');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();

  console.log('uBuddy presence-gated dispatch smoke passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
