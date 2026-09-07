import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { repairDatabase } from '../src/main/databaseRecovery.js';
import { createUBuddyCoordinationService } from '../src/main/modules/orchestration/index.js';
import { Store } from '../src/main/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-sleep-wake-'));
const upgradeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-sleep-wake-upgrade-'));
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-sleep-wake-recovery-'));

function seedOwnerTask(db, suffix, { status = 'running' } = {}) {
  const userId = `wake_user_${suffix}`;
  const sessionId = `wake_session_${suffix}`;
  const taskRunId = `wake_task_${suffix}`;
  db.prepare('INSERT INTO auth_users(id,email,display_name) VALUES(?,?,?)').run(
    userId, `${suffix}@example.com`, `Wake ${suffix}`,
  );
  db.prepare(`INSERT INTO sessions(id,user_id,account_workspace_id,title,department_id,agent_id,status)
    VALUES(?,?,'workspace_personal',?,'secretary_department','secretary_agent','active')`).run(
    sessionId, userId, `uBuddy ${suffix}`,
  );
  db.prepare(`INSERT INTO task_runs(id,owner_user_id,account_workspace_id,title,prompt,department_id,status,metadata_json)
    VALUES(?,?,'workspace_personal',?,?,'general',?,'{}')`).run(
    taskRunId, userId, `Task ${suffix}`, `Prompt ${suffix}`, status,
  );
  return { userId, sessionId, taskRunId };
}

function removeSleepWakeMigration(targetRoot) {
  const raw = new DatabaseSync(path.join(targetRoot, 'data', 'janus.db'));
  raw.exec('PRAGMA foreign_keys=OFF');
  raw.exec(`DROP TABLE IF EXISTS ubuddy_wake_outbox;
    DROP TABLE IF EXISTS ubuddy_coordination_states;
    DELETE FROM schema_migrations WHERE id='ubuddy_sleep_wake_coordination_v1'`);
  raw.close();
}

function downgradeRecoveryWakeConstraint(targetRoot) {
  const raw = new DatabaseSync(path.join(targetRoot, 'data', 'janus.db'));
  raw.exec(`PRAGMA foreign_keys=OFF;
    ALTER TABLE ubuddy_wake_outbox RENAME TO ubuddy_wake_outbox_newer;
    CREATE TABLE ubuddy_wake_outbox (
      id TEXT PRIMARY KEY,task_run_id TEXT NOT NULL,coordination_generation INTEGER NOT NULL CHECK(coordination_generation>=0),
      idempotency_key TEXT NOT NULL UNIQUE,account_workspace_id TEXT NOT NULL DEFAULT 'workspace_personal',owner_user_id TEXT NOT NULL DEFAULT '',
      source_session_id TEXT NOT NULL DEFAULT '',leader_agent_id TEXT NOT NULL DEFAULT '',leader_agent_instance_id TEXT NOT NULL DEFAULT '',
      reason_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payload_json TEXT NOT NULL DEFAULT '{}',source_task_event_id TEXT NOT NULL DEFAULT '',
      claimed_by TEXT NOT NULL DEFAULT '',claimed_at TEXT NOT NULL DEFAULT '',lease_expires_at TEXT NOT NULL DEFAULT '',
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),next_attempt_at TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',
      delivery_message_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT '',delivered_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
      CHECK(reason_code IN ('completion','recovery_exhausted','user_action_required','cancelled','planning_failed')),
      CHECK(status IN ('pending','claimed','failed_retryable','delivered','failed_terminal','cancelled'))
    );
    INSERT INTO ubuddy_wake_outbox SELECT * FROM ubuddy_wake_outbox_newer WHERE reason_code!='recovery_required';
    DROP TABLE ubuddy_wake_outbox_newer;
    CREATE INDEX idx_ubuddy_wake_due ON ubuddy_wake_outbox(status,next_attempt_at,lease_expires_at,created_at);
    CREATE UNIQUE INDEX idx_ubuddy_wake_task_generation_unique ON ubuddy_wake_outbox(task_run_id,coordination_generation);
    CREATE INDEX idx_ubuddy_wake_task ON ubuddy_wake_outbox(task_run_id,coordination_generation,status);
    DELETE FROM schema_migrations WHERE id='ubuddy_failure_recovery_v1';
    PRAGMA foreign_keys=ON;`);
  raw.close();
}

try {
  let db = openDatabase(root, { appVersion: '0.2.18' });
  const store = new Store(db, { root });
  const service = createUBuddyCoordinationService({ store, workerId: 'wake_smoke_worker', leaseMs: 1_000 });
  const primary = seedOwnerTask(db, 'primary');
  const messageCountBefore = Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count || 0);

  assert.equal(service.start({ taskRunId: primary.taskRunId, sourceSessionId: primary.sessionId }).state, 'planning');
  assert.throws(() => service.start({ taskRunId: primary.taskRunId, sourceSessionId: 'different_session' }),
    (error) => error.code === 'ubuddy_coordination_identity_conflict');
  assert.equal(service.waitForAgents({ taskRunId: primary.taskRunId, reason: 'No matching employee is idle.' }).state, 'waiting_for_agents');
  const sleeping = service.sleep({
    taskRunId: primary.taskRunId,
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_primary',
    sleepReason: 'Leader owns execution.',
  });
  assert.equal(sleeping.state, 'sleeping');
  assert.equal(sleeping.generation, 1);
  const secondary = seedOwnerTask(db, 'secondary');
  service.start({ taskRunId: secondary.taskRunId, sourceSessionId: secondary.sessionId });
  service.sleep({
    taskRunId: secondary.taskRunId,
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_secondary',
    sleepReason: 'A second task remains independently active.',
  });
  assert.equal(service.state(primary.taskRunId).state, 'sleeping');
  assert.equal(service.state(secondary.taskRunId).state, 'sleeping');
  assert.throws(() => service.requestWake({
    taskRunId: primary.taskRunId,
    reasonCode: 'completion',
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'wrong_instance',
  }), (error) => error.code === 'ubuddy_wake_leader_mismatch');

  const wake = service.requestWake({
    taskRunId: primary.taskRunId,
    reasonCode: 'completion',
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_primary',
    sourceTaskEventId: 'leader_final_event',
    payload: {
      resultState: 'accepted',
      reportSummary: `Completed with password=not-a-real-secret under ${process.env.HOME || '/home/example'}/private and /var/private/example.txt.`,
      failureReport: {
        failureNodeId: 'final_node', failureNode: 'Final delivery', failureAgentId: 'general_agent',
        errorCode: 'network_transient', errorType: 'network_connection', summary: 'Network retry exhausted.',
        cause: 'socket hang up', retryable: true, retriesExhausted: true, attemptedRetry: true,
        attemptCount: 3, maxAttempts: 3, attemptedActions: ['Automatic retry 2/3', 'Automatic retry 3/3'],
        suggestedNextStep: 'Check the network and retry.',
      },
      deliverableRef: { taskRunId: primary.taskRunId, taskNodeId: 'final_node', artifactIds: ['artifact_one'] },
      content: 'must not be persisted',
    },
  });
  assert.equal(wake.status, 'pending');
  assert.equal(wake.payload.content, undefined);
  assert.equal(wake.payload.failureReport.failureNode, 'Final delivery');
  assert.equal(wake.payload.failureReport.retriesExhausted, true);
  assert.deepEqual(wake.payload.failureReport.attemptedActions, ['Automatic retry 2/3', 'Automatic retry 3/3']);
  assert.doesNotMatch(wake.payload.reportSummary, /not-a-real-secret/);
  assert.doesNotMatch(wake.payload.reportSummary, /\/var\/private/);
  if (process.env.HOME) assert.doesNotMatch(wake.payload.reportSummary, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(service.requestWake({
    taskRunId: primary.taskRunId,
    reasonCode: 'completion',
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_primary',
  }).id, wake.id);
  assert.throws(() => service.requestWake({ taskRunId: primary.taskRunId, reasonCode: 'cancelled' }),
    (error) => error.code === 'ubuddy_wake_reason_conflict');

  const baseTime = Date.now() + 60_000;
  const firstClaim = service.claimPendingWakes({ now: baseTime });
  assert.equal(firstClaim.length, 1);
  assert.equal(service.state(primary.taskRunId).state, 'delivering');
  const retryable = service.failWakeDelivery({ wakeEventId: wake.id, error: 'socket hang up', retryAt: new Date(baseTime + 1_000).toISOString() });
  assert.equal(retryable.status, 'failed_retryable');
  assert.equal(service.state(primary.taskRunId).state, 'awakened');
  assert.equal(service.claimPendingWakes({ now: baseTime + 500 }).length, 0);
  assert.equal(service.claimPendingWakes({ now: baseTime + 1_500 }).length, 1);
  assert.equal(service.acknowledgeWake({ wakeEventId: wake.id, deliveryMessageId: 'wake_message_primary' }).status, 'delivered');
  assert.equal(service.state(primary.taskRunId).state, 'completed');
  assert.equal(service.state(secondary.taskRunId).state, 'sleeping', 'waking one task must not change another task');
  const completedRevision = service.state(primary.taskRunId).stateRevision;
  service.acknowledgeWake({ wakeEventId: wake.id, deliveryMessageId: 'wake_message_primary' });
  assert.equal(service.state(primary.taskRunId).stateRevision, completedRevision);
  const secondaryWake = service.requestWake({
    taskRunId: secondary.taskRunId,
    reasonCode: 'cancelled',
    leaderAgentId: 'general_agent',
    leaderAgentInstanceId: 'general_instance_secondary',
  });
  service.claimPendingWakes({ now: baseTime + 1_600 });
  service.acknowledgeWake({ wakeEventId: secondaryWake.id, deliveryMessageId: 'wake_message_secondary' });
  assert.equal(service.state(secondary.taskRunId).state, 'cancelled');

  const contract = seedOwnerTask(db, 'contract');
  service.start({ taskRunId: contract.taskRunId, sourceSessionId: contract.sessionId });
  service.markUBuddySleeping(contract.taskRunId, {
    agentId: 'general_agent', agentInstanceId: 'general_instance_contract', reason: 'Contract alias validation.',
  });
  const contractWake = service.requestUBuddyWake(contract.taskRunId, 'cancelled', { reportSummary: 'Cancelled by owner.' });
  assert.equal(service.consumePendingUBuddyWake(contract.taskRunId, { now: baseTime + 1_750 })?.id, contractWake.id);
  assert.equal(service.acknowledgeUBuddyWake(contractWake.id, 'wake_message_contract').status, 'delivered');
  assert.equal(service.state(contract.taskRunId).state, 'cancelled');
  assert.ok(service.recoverUBuddyCoordination({ now: baseTime + 1_800 }));

  const userAction = seedOwnerTask(db, 'user_action');
  service.start({ taskRunId: userAction.taskRunId, sourceSessionId: userAction.sessionId });
  service.sleep({ taskRunId: userAction.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_action' });
  const actionWake = service.requestWake({
    taskRunId: userAction.taskRunId, reasonCode: 'user_action_required',
    leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_action',
  });
  service.claimPendingWakes({ now: baseTime + 2_000 });
  service.acknowledgeWake({ wakeEventId: actionWake.id, deliveryMessageId: 'wake_message_action' });
  assert.equal(service.state(userAction.taskRunId).state, 'awakened');
  assert.equal(service.sleep({
    taskRunId: userAction.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_action',
  }).generation, 2);

  const recoveryRequired = seedOwnerTask(db, 'recovery_required');
  service.start({ taskRunId: recoveryRequired.taskRunId, sourceSessionId: recoveryRequired.sessionId });
  service.sleep({ taskRunId: recoveryRequired.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_recovery' });
  const recoveryWake = service.requestWake({
    taskRunId: recoveryRequired.taskRunId, reasonCode: 'recovery_required',
    leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_recovery',
  });
  service.claimPendingWakes({ now: baseTime + 2_500 });
  service.acknowledgeWake({ wakeEventId: recoveryWake.id, deliveryMessageId: 'wake_message_recovery' });
  assert.equal(service.state(recoveryRequired.taskRunId).state, 'awakened');
  assert.equal(service.sleep({
    taskRunId: recoveryRequired.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_recovery',
  }).generation, 2);

  const expired = seedOwnerTask(db, 'expired');
  service.start({ taskRunId: expired.taskRunId, sourceSessionId: expired.sessionId });
  service.sleep({ taskRunId: expired.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_expired' });
  const expiredWake = service.requestWake({ taskRunId: expired.taskRunId, reasonCode: 'cancelled' });
  service.claimPendingWakes({ now: baseTime + 3_000 });
  const recoveredExpired = service.recover({ force: true, now: baseTime + 5_000 });
  assert.equal(recoveredExpired.expiredClaimCount, 1);
  assert.equal(service.wake(expiredWake.id).status, 'failed_retryable');
  assert.equal(service.state(expired.taskRunId).state, 'awakened');

  const terminal = seedOwnerTask(db, 'terminal');
  service.start({ taskRunId: terminal.taskRunId, sourceSessionId: terminal.sessionId });
  service.sleep({ taskRunId: terminal.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_terminal' });
  store.updateTaskRunStatus(terminal.taskRunId, 'failed', 'Execution recovery exhausted.');
  const recoveredTerminal = service.recover({ force: true, now: baseTime + 6_000 });
  assert.equal(recoveredTerminal.createdWakeCount, 1);
  const terminalWake = store.getUBuddyWakeForGeneration({ taskRunId: terminal.taskRunId, generation: 1 });
  assert.equal(terminalWake.reasonCode, 'recovery_required');
  service.claimPendingWakes({ now: baseTime + 7_000 });
  service.acknowledgeWake({ wakeEventId: terminalWake.id, deliveryMessageId: 'wake_message_terminal' });
  assert.equal(service.state(terminal.taskRunId).state, 'awakened');
  assert.equal(service.sleep({
    taskRunId: terminal.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_terminal',
  }).generation, 2);

  const exhausted = seedOwnerTask(db, 'recovery_exhausted');
  db.prepare("UPDATE task_runs SET metadata_json=? WHERE id=?").run(
    JSON.stringify({ backgroundRecovery: { attemptCount: 2, maxAttempts: 2 } }), exhausted.taskRunId,
  );
  service.start({ taskRunId: exhausted.taskRunId, sourceSessionId: exhausted.sessionId });
  service.sleep({ taskRunId: exhausted.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_exhausted' });
  store.updateTaskRunStatus(exhausted.taskRunId, 'failed', 'Bounded recovery exhausted.');
  service.recover({ force: true, now: baseTime + 7_500 });
  const exhaustedWake = store.getUBuddyWakeForGeneration({ taskRunId: exhausted.taskRunId, generation: 1 });
  assert.equal(exhaustedWake.reasonCode, 'recovery_exhausted');
  service.claimPendingWakes({ now: baseTime + 8_000 });
  service.acknowledgeWake({ wakeEventId: exhaustedWake.id, deliveryMessageId: 'wake_message_exhausted' });
  assert.equal(service.state(exhausted.taskRunId).state, 'failed');

  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count || 0), messageCountBefore,
    'D-stage coordination must not create chat messages');
  assert.ok(store.listTaskEvents(primary.taskRunId).some((event) => event.eventType === 'ubuddy_sleeping'));
  assert.ok(store.listTaskEvents(primary.taskRunId).some((event) => event.eventType === 'ubuddy_wake_delivered'));
  db.close();

  db = openDatabase(upgradeRoot, { appVersion: '0.2.27' });
  const upgrade = seedOwnerTask(db, 'upgrade');
  db.prepare(`INSERT INTO messages(id,session_id,account_workspace_id,role,content,agent_id,department_id)
    VALUES('wake_upgrade_message',?,'workspace_personal','user','preserve wake upgrade message','secretary_agent','secretary_department')`).run(upgrade.sessionId);
  const upgradeStore = new Store(db, { root: upgradeRoot });
  upgradeStore.startUBuddyCoordination({ taskRunId: upgrade.taskRunId, sourceSessionId: upgrade.sessionId });
  upgradeStore.markUBuddySleeping({
    taskRunId: upgrade.taskRunId, leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_upgrade',
  });
  const preservedWake = upgradeStore.requestUBuddyWake({
    taskRunId: upgrade.taskRunId, reasonCode: 'user_action_required',
    leaderAgentId: 'general_agent', leaderAgentInstanceId: 'general_instance_upgrade',
    payload: { reportSummary: 'Preserve this wake exactly.' },
  });
  db.close();
  downgradeRecoveryWakeConstraint(upgradeRoot);
  const legacyUpgradeDb = new DatabaseSync(path.join(upgradeRoot, 'data', 'janus.db'));
  const wakeBeforeRecoveryMigration = legacyUpgradeDb.prepare('SELECT * FROM ubuddy_wake_outbox WHERE id=?').get(preservedWake.id);
  const coordinationBeforeRecoveryMigration = legacyUpgradeDb.prepare('SELECT * FROM ubuddy_coordination_states WHERE task_run_id=?').get(upgrade.taskRunId);
  legacyUpgradeDb.close();
  db = openDatabase(upgradeRoot, { appVersion: '0.2.27' });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_coordination_states'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_wake_outbox'").get());
  assert.match(String(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ubuddy_wake_outbox'").get().sql), /recovery_required/);
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='wake_upgrade_message'").get().content, 'preserve wake upgrade message');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM task_runs WHERE id=?').get(upgrade.taskRunId).count, 1);
  assert.deepEqual(db.prepare('SELECT * FROM ubuddy_wake_outbox WHERE id=?').get(preservedWake.id), wakeBeforeRecoveryMigration,
    'the reason-code constraint expansion must preserve every existing wake field exactly');
  assert.deepEqual(db.prepare('SELECT * FROM ubuddy_coordination_states WHERE task_run_id=?').get(upgrade.taskRunId),
    coordinationBeforeRecoveryMigration, 'the wake-table rebuild must not rewrite coordination state');
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='ubuddy_failure_recovery_v1'").get());
  db.close();
  db = openDatabase(upgradeRoot, { appVersion: '0.2.27' });
  assert.deepEqual(db.maintenance.pendingMigrationIds, []);
  assert.equal(String(db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();

  db = openDatabase(recoveryRoot, { appVersion: '0.2.18' });
  const recovery = seedOwnerTask(db, 'recovery');
  db.prepare(`INSERT INTO messages(id,session_id,account_workspace_id,role,content,agent_id,department_id)
    VALUES('wake_recovery_message',?,'workspace_personal','user','preserve wake recovery message','secretary_agent','secretary_department')`).run(recovery.sessionId);
  db.close();
  removeSleepWakeMigration(recoveryRoot);
  const repaired = repairDatabase(recoveryRoot, { appVersion: '0.2.18' });
  assert.equal(repaired.status, 'repaired');
  db = openDatabase(recoveryRoot, { appVersion: '0.2.18' });
  assert.equal(db.prepare("SELECT content FROM messages WHERE id='wake_recovery_message'").get().content, 'preserve wake recovery message');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM task_runs WHERE id=?').get(recovery.taskRunId).count, 1);
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='ubuddy_sleep_wake_coordination_v1'").get());
  db.close();

  process.stdout.write('uBuddy sleep/wake coordination smoke passed.\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(upgradeRoot, { recursive: true, force: true });
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
}
