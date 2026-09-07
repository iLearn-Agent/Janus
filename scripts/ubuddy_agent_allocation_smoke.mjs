import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../src/main/db.js';
import { repairDatabase } from '../src/main/databaseRecovery.js';
import { createRuntime } from '../src/main/runtime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-agent-allocation-'));
const upgradeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-agent-allocation-upgrade-'));
const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-agent-allocation-recovery-'));
let runtime;
const availabilityUpdates = [];

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for Agent availability update.');
}

function createWaitingTask(store, userId, instances, suffix, { slotCount = 1, bindingPolicy = 'family', priority = 50 } = {}) {
  const task = store.createTaskRun({
    title: `Allocation ${suffix}`,
    prompt: `Allocation prompt ${suffix}`,
    departmentId: 'general',
    leadAgentId: 'general_agent',
    ownerUserId: userId,
    metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: '', userId },
    deferAgentInstanceBinding: true,
  });
  const slots = [];
  for (let index = 0; index < slotCount; index += 1) {
    const node = store.createTaskNode({
      taskRunId: task.id,
      title: `Allocation node ${suffix} ${index + 1}`,
      objective: 'Prove atomic idle allocation.',
      departmentId: 'general',
      agentId: 'general_agent',
      status: 'waiting',
      outputFormat: 'markdown',
      deferAgentInstanceBinding: true,
    });
    slots.push({
      allocationKey: `general_agent:slot_${index + 1}`,
      agentFamilyId: 'general_agent',
      departmentId: 'general',
      preferredAgentInstanceId: instances[index]?.id || '',
      candidateInstanceIds: instances.map((item) => item.id),
      taskNodeIds: [node.id],
      leaderSlot: index === 0,
      bindingPolicy,
      priority,
    });
  }
  store.createUBuddyAgentWaitRequests({ taskRunId: task.id, slots });
  return store.getTaskRun(task.id);
}

function removeAllocationMigration(targetRoot) {
  const raw = new DatabaseSync(path.join(targetRoot, 'data', 'janus.db'));
  raw.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE IF EXISTS ubuddy_planning_jobs;
    DROP TABLE IF EXISTS ubuddy_agent_wait_requests;
    DROP TABLE IF EXISTS agent_work_reservations;
    DELETE FROM schema_migrations WHERE id IN ('ubuddy_agent_allocation_v1','ubuddy_coordination_contract_v2')`);
  raw.close();
}

try {
  runtime = await createRuntime({
    root,
    isDev: true,
    serverAuthoritativeSkills: true,
    onAgentAvailabilityChanged(payload) {
      availabilityUpdates.push(payload);
    },
  });
  const store = runtime.store;
  const user = runtime.currentUser();
  const generalA = store.activeEmployeeAgentsForUser({ userId: user.id }).find((item) => item.agentFamilyId === 'general_agent');
  const generalB = store.recruitUserAgent({
    userId: user.id,
    agentFamilyId: 'general_agent',
    commandId: 'ubuddy-agent-allocation:general-b',
  }).instance;
  const instances = [generalA, generalB];

  let releaseAvailabilityProbe;
  const availabilityProbeGate = new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    releaseAvailabilityProbe = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
  const availabilityProbe = runtime.scheduler.agentExecution.run({
    userId: user.id,
    agentInstanceId: generalA.id,
    workKind: 'availability_probe',
    workId: 'availability_probe_runtime_bridge',
    execute: async () => availabilityProbeGate,
  });
  await waitFor(() => availabilityUpdates.some((payload) => (
    payload.statuses?.[0]?.agentInstanceId === generalA.id
      && payload.statuses?.[0]?.workState === 'running'
  )));
  assert.ok(availabilityUpdates.some((payload) => payload.statuses?.[0]?.workState === 'queued'),
    'the renderer bridge must receive the queued Agent state directly from the execution coordinator');
  assert.equal(availabilityUpdates.some((payload) => Object.hasOwn(payload, 'work')), false,
    'the renderer bridge must not expose the raw queued-work payload');
  releaseAvailabilityProbe();
  await availabilityProbe;
  await waitFor(() => availabilityUpdates.some((payload) => (
    payload.statuses?.[0]?.agentInstanceId === generalA.id
      && payload.statuses?.[0]?.availability === 'idle'
  )));
  const completedAvailability = store.getAgentAvailability({ userId: user.id, agentInstanceId: generalA.id });
  assert.equal(completedAvailability.availability, 'idle');
  assert.ok(Date.parse(completedAvailability.updatedAt) >= Date.parse(availabilityUpdates
    .find((payload) => payload.statuses?.[0]?.agentInstanceId === generalA.id
      && payload.statuses?.[0]?.workState === 'running')?.statuses?.[0]?.updatedAt || ''),
  'idle availability must carry the completed work timestamp instead of an old employee profile timestamp');

  store.db.prepare(`INSERT INTO task_runs(id,owner_user_id,account_workspace_id,title,prompt,status,metadata_json)
    VALUES('status_terminal_history',?,'workspace_personal','Historical failure','Historical failure','failed','{}')`).run(user.id);
  store.db.prepare(`INSERT INTO task_nodes(id,task_run_id,title,objective,agent_id,status)
    VALUES('status_terminal_history_node','status_terminal_history','Historical node','Historical node','status_scope_probe','failed')`).run();
  store.db.prepare(`INSERT INTO task_runs(id,owner_user_id,account_workspace_id,title,prompt,status,metadata_json)
    VALUES('status_other_workspace',?,'workspace_other','Other workspace','Other workspace','running','{}')`).run(user.id);
  store.db.prepare(`INSERT INTO task_nodes(id,task_run_id,title,objective,agent_id,status)
    VALUES('status_other_workspace_node','status_other_workspace','Other node','Other node','status_scope_probe','running')`).run();
  const scopedHistoricalStatus = store.agentStatuses({ userId: user.id, workspaceId: 'workspace_personal' })
    .find((item) => item.agentId === 'status_scope_probe');
  assert.equal(scopedHistoricalStatus.status, 'idle',
    'terminal history and another Workspace must not make the current Workspace family status look active');
  assert.equal(scopedHistoricalStatus.failedCount, 1, 'historical terminal counts remain available for reporting');

  const busyA = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalA.id, workKind: 'ubuddy_agent_message', workId: 'allocation_busy_a', payload: {},
  });
  assert.equal(store.getAgentAvailability({ userId: user.id, agentInstanceId: generalA.id }).availability, 'working');
  assert.equal(store.getAgentAvailability({ userId: user.id, agentInstanceId: generalA.id }).workState, 'queued');

  const substitute = createWaitingTask(store, user.id, instances, 'substitute');
  const substituteMatch = store.matchWaitingUBuddyAgentRequests({ taskRunId: substitute.id });
  assert.deepEqual(substituteMatch.matchedTaskIds, [substitute.id]);
  assert.equal(substituteMatch.assignmentDiagnostics[0]?.valid, true);
  assert.equal(substituteMatch.assignmentDiagnostics[0]?.assignmentCount, 1);
  assert.equal(substituteMatch.assignmentDiagnostics[0]?.uniqueAgentInstanceCount, 1);
  const substitutedTask = store.getTaskRun(substitute.id);
  assert.equal(substitutedTask.nodes[0].agentInstanceId, generalB.id, 'idle same-family employee must replace the busy preference');
  assert.equal(store.getAgentAvailability({ userId: user.id, agentInstanceId: generalB.id }).workState, 'reserved');

  const unrelated = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalB.id, workKind: 'chat', workId: 'allocation_unrelated_chat', payload: {},
  });
  assert.equal(store.claimAgentWork({ id: unrelated.id, agentInstanceId: generalB.id }), null,
    'an unrelated queued chat must not steal an active task reservation');
  const reservedNodeWork = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalB.id, workKind: 'task_node', workId: substitutedTask.nodes[0].id,
    payload: { taskRunId: substitute.id },
  });
  assert.equal(store.claimAgentWork({ id: reservedNodeWork.id, agentInstanceId: generalB.id })?.status, 'running');
  store.finishAgentWork({ id: reservedNodeWork.id, status: 'completed' });
  store.updateTaskRunStatus(substitute.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: substitute.id, reason: 'smoke_complete' });
  assert.equal(store.claimAgentWork({ id: unrelated.id, agentInstanceId: generalB.id })?.status, 'running');
  store.finishAgentWork({ id: unrelated.id, status: 'completed' });

  const busyB = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalB.id, workKind: 'ubuddy_agent_message', workId: 'allocation_busy_b', payload: {},
  });
  const atomic = createWaitingTask(store, user.id, instances, 'atomic', { slotCount: 2 });
  const atomicBlocked = store.matchWaitingUBuddyAgentRequests({ taskRunId: atomic.id });
  assert.deepEqual(atomicBlocked.matchedTaskIds, []);
  assert.equal(store.listAgentWorkReservations({ taskRunId: atomic.id, statuses: ['active'] }).length, 0,
    'insufficient capacity must not create partial reservations');
  assert.ok(store.listUBuddyAgentWaitRequests({ taskRunId: atomic.id }).every((item) => item.status === 'waiting'));
  store.finishAgentWork({ id: busyA.id, status: 'completed' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests({ taskRunId: atomic.id }).matchedTaskIds, [],
    'one idle employee is still insufficient for a two-slot batch');
  store.finishAgentWork({ id: busyB.id, status: 'completed' });
  const atomicMatched = store.matchWaitingUBuddyAgentRequests({ taskRunId: atomic.id });
  assert.deepEqual(atomicMatched.matchedTaskIds, [atomic.id]);
  assert.equal(atomicMatched.assignmentDiagnostics[0]?.valid, true);
  assert.equal(atomicMatched.assignmentDiagnostics[0]?.assignmentCount, 2);
  assert.equal(atomicMatched.assignmentDiagnostics[0]?.uniqueAgentInstanceCount, 2);
  assert.equal(store.listAgentWorkReservations({ taskRunId: atomic.id, statuses: ['active'] }).length, 2);
  const atomicReservation = store.listAgentWorkReservations({ taskRunId: atomic.id, statuses: ['active'] })[0];
  assert.throws(() => store.db.prepare(`INSERT INTO agent_work_reservations(
    id,account_workspace_id,owner_user_id,task_run_id,agent_instance_id,agent_family_id,status,metadata_json
  ) SELECT ?,account_workspace_id,owner_user_id,task_run_id,agent_instance_id,agent_family_id,status,metadata_json
    FROM agent_work_reservations WHERE id=?`).run('duplicate-agent-assignment', atomicReservation.id), /UNIQUE constraint failed/,
  'the database must reject a second assignment record for the same task and Agent instance');
  assert.equal(store.diagnoseTaskAgentAssignments({ taskRunId: atomic.id }).valid, true);
  const atomicParticipantIds = store.getTaskRun(atomic.id).metadata.participantAgentInstanceIds;
  store.updateTaskRunMetadata(atomic.id, { participantAgentInstanceIds: [atomicParticipantIds[0], ...atomicParticipantIds] });
  const duplicateParticipantDiagnostic = store.diagnoseTaskAgentAssignments({ taskRunId: atomic.id });
  assert.equal(duplicateParticipantDiagnostic.valid, false);
  assert.ok(duplicateParticipantDiagnostic.diagnostics.some((item) => item.code === 'task_agent_participant_duplicate'));
  store.updateTaskRunMetadata(atomic.id, { participantAgentInstanceIds: [...new Set(atomicParticipantIds)] });
  assert.equal(store.diagnoseTaskAgentAssignments({ taskRunId: atomic.id }).valid, true);
  store.updateTaskRunStatus(atomic.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: atomic.id, reason: 'smoke_complete' });

  const fifoBusyA = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalA.id, workKind: 'ubuddy_agent_message', workId: 'allocation_fifo_busy_a', payload: {},
  });
  const fifoBusyB = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalB.id, workKind: 'ubuddy_agent_message', workId: 'allocation_fifo_busy_b', payload: {},
  });
  const first = createWaitingTask(store, user.id, instances, 'fifo_first');
  const second = createWaitingTask(store, user.id, instances, 'fifo_second');
  store.finishAgentWork({ id: fifoBusyA.id, status: 'completed' });
  const fifoFirstMatch = store.matchWaitingUBuddyAgentRequests();
  assert.deepEqual(fifoFirstMatch.matchedTaskIds, [first.id]);
  assert.equal(store.listUBuddyAgentWaitRequests({ taskRunId: second.id })[0].status, 'waiting');
  store.updateTaskRunStatus(first.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: first.id, reason: 'fifo_release' });
  const fifoSecondMatch = store.matchWaitingUBuddyAgentRequests();
  assert.deepEqual(fifoSecondMatch.matchedTaskIds, [second.id]);
  store.finishAgentWork({ id: fifoBusyB.id, status: 'completed' });
  store.updateTaskRunStatus(second.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: second.id, reason: 'smoke_complete' });

  const exactBusy = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalA.id, workKind: 'ubuddy_agent_message', workId: 'allocation_exact_busy', payload: {},
  });
  const exact = createWaitingTask(store, user.id, instances, 'exact_instance', { bindingPolicy: 'exact' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests({ taskRunId: exact.id }).matchedTaskIds, [],
    'an exact instance requirement must wait instead of substituting a same-family employee');
  assert.equal(store.listAgentWorkReservations({ taskRunId: exact.id, statuses: ['active'] }).length, 0);
  store.finishAgentWork({ id: exactBusy.id, status: 'completed' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests({ taskRunId: exact.id }).matchedTaskIds, [exact.id]);
  assert.equal(store.getTaskRun(exact.id).nodes[0].agentInstanceId, generalA.id);
  store.updateTaskRunStatus(exact.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: exact.id, reason: 'exact_complete' });

  const priorityBusyA = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalA.id, workKind: 'ubuddy_agent_message', workId: 'allocation_priority_busy_a', payload: {},
  });
  const priorityBusyB = store.enqueueAgentWork({
    userId: user.id, agentInstanceId: generalB.id, workKind: 'ubuddy_agent_message', workId: 'allocation_priority_busy_b', payload: {},
  });
  const lowPriority = createWaitingTask(store, user.id, instances, 'priority_low', { priority: 80 });
  const highPriority = createWaitingTask(store, user.id, instances, 'priority_high', { priority: 10 });
  store.finishAgentWork({ id: priorityBusyA.id, status: 'completed' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests().matchedTaskIds, [highPriority.id],
    'waiting tasks must be selected by priority before creation time');
  store.updateTaskRunStatus(highPriority.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: highPriority.id, reason: 'priority_complete' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests().matchedTaskIds, [lowPriority.id]);
  store.finishAgentWork({ id: priorityBusyB.id, status: 'completed' });
  store.updateTaskRunStatus(lowPriority.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: lowPriority.id, reason: 'priority_complete' });

  const leased = createWaitingTask(store, user.id, instances, 'lease_recovery');
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests({ taskRunId: leased.id }).matchedTaskIds, [leased.id]);
  const leasedReservation = store.listAgentWorkReservations({ taskRunId: leased.id, statuses: ['active'] })[0];
  store.db.prepare("UPDATE agent_work_reservations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(leasedReservation.id);
  assert.equal(store.getAgentAvailability({ userId: user.id, agentInstanceId: leasedReservation.agentInstanceId }).availability, 'working',
    'an expired active reservation must remain busy until allocation recovery releases it');
  const waitsBehindExpiredLease = createWaitingTask(store, user.id, [generalA], 'waits_behind_expired_lease', { bindingPolicy: 'exact' });
  const expiredLeaseContention = store.matchWaitingUBuddyAgentRequests({ taskRunId: waitsBehindExpiredLease.id });
  assert.deepEqual(expiredLeaseContention.matchedTaskIds, [], 'an expired active reservation must queue competing work instead of violating the unique index');
  assert.deepEqual(expiredLeaseContention.waitingTaskIds, [waitsBehindExpiredLease.id]);
  assert.equal(store.listUBuddyAgentWaitRequests({ taskRunId: waitsBehindExpiredLease.id })[0].status, 'waiting');
  const recoveredLease = store.recoverUBuddyAgentAllocations();
  assert.equal(recoveredLease.expiredReservationCount, 1);
  const reacquired = store.listAgentWorkReservations({ taskRunId: leased.id, statuses: ['active'] });
  assert.equal(reacquired.length, 1, 'expired reservations must be atomically reacquired or remain waiting as a whole task');
  assert.ok(Date.parse(reacquired[0].leaseExpiresAt) > Date.now());
  store.updateTaskRunStatus(leased.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: leased.id, reason: 'lease_complete' });
  assert.deepEqual(store.matchWaitingUBuddyAgentRequests({ taskRunId: waitsBehindExpiredLease.id }).matchedTaskIds, [waitsBehindExpiredLease.id],
    'queued work must acquire the exact Agent after the prior reservation is released');
  store.updateTaskRunStatus(waitsBehindExpiredLease.id, 'completed');
  store.releaseTaskAgentReservations({ taskRunId: waitsBehindExpiredLease.id, reason: 'lease_waiter_complete' });

  assert.ok(store.listTaskEvents(atomic.id).some((event) => event.eventType === 'ubuddy_agents_waiting'));
  assert.ok(store.listTaskEvents(atomic.id).some((event) => event.eventType === 'ubuddy_agents_allocated'));
  assert.equal(String(store.db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  await runtime.close();
  runtime = null;

  let db = openDatabase(upgradeRoot, { appVersion: '0.2.20' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('allocation_upgrade_user','allocation-upgrade@example.com','Allocation Upgrade')").run();
  db.prepare(`INSERT INTO task_runs(id,owner_user_id,account_workspace_id,title,prompt,department_id,status,metadata_json)
    VALUES('allocation_upgrade_task','allocation_upgrade_user','workspace_personal','Preserve task','Preserve prompt','general','waiting','{}')`).run();
  db.prepare(`INSERT INTO sessions(id,conversation_id,user_id,title,department_id,agent_id,interaction_mode)
    VALUES('allocation_upgrade_session','allocation_upgrade_session','allocation_upgrade_user','Legacy plan','general','general_agent','plan')`).run();
  db.prepare(`INSERT INTO messages(id,conversation_id,session_id,role,content,metadata_json)
    VALUES('allocation_upgrade_message','allocation_upgrade_session','allocation_upgrade_session','assistant','Preserve message','{"dispatchDraftId":"legacy-dispatch"}')`).run();
  db.close();
  removeAllocationMigration(upgradeRoot);
  db = openDatabase(upgradeRoot, { appVersion: '0.2.21' });
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_work_reservations'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_agent_wait_requests'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ubuddy_planning_jobs'").get());
  assert.equal(db.prepare("SELECT title FROM task_runs WHERE id='allocation_upgrade_task'").get().title, 'Preserve task');
  assert.equal(db.prepare("SELECT interaction_mode FROM sessions WHERE id='allocation_upgrade_session'").get().interaction_mode, '');
  const migratedDispatchMetadata = JSON.parse(db.prepare("SELECT metadata_json FROM messages WHERE id='allocation_upgrade_message'").get().metadata_json);
  assert.equal(migratedDispatchMetadata.dispatchCommandId, 'legacy-dispatch');
  assert.equal(Object.hasOwn(migratedDispatchMetadata, 'dispatchDraftId'), false);
  db.close();
  db = openDatabase(upgradeRoot, { appVersion: '0.2.21' });
  assert.deepEqual(db.maintenance.pendingMigrationIds, []);
  assert.equal(String(db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();

  db = openDatabase(recoveryRoot, { appVersion: '0.2.20' });
  db.prepare("INSERT INTO auth_users(id,email,display_name) VALUES('allocation_recovery_user','allocation-recovery@example.com','Allocation Recovery')").run();
  db.prepare(`INSERT INTO task_runs(id,owner_user_id,account_workspace_id,title,prompt,department_id,status,metadata_json)
    VALUES('allocation_recovery_task','allocation_recovery_user','workspace_personal','Recovery task','Recovery prompt','general','waiting','{}')`).run();
  db.close();
  removeAllocationMigration(recoveryRoot);
  const repaired = repairDatabase(recoveryRoot, { appVersion: '0.2.21' });
  assert.equal(repaired.status, 'repaired');
  db = openDatabase(recoveryRoot, { appVersion: '0.2.21' });
  assert.equal(db.prepare("SELECT title FROM task_runs WHERE id='allocation_recovery_task'").get().title, 'Recovery task');
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='ubuddy_agent_allocation_v1'").get());
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id='ubuddy_coordination_contract_v2'").get());
  assert.equal(String(db.prepare('PRAGMA integrity_check').get().integrity_check), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();

  console.log('uBuddy Agent allocation smoke passed.');
} finally {
  await runtime?.close?.();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(upgradeRoot, { recursive: true, force: true });
  fs.rmSync(recoveryRoot, { recursive: true, force: true });
}
