import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import { redactDiagnosticText } from '../../../../shared/logging/redaction.js';

export const UBUDDY_COORDINATION_STATES = Object.freeze([
  'planning', 'waiting_for_agents', 'sleeping', 'awakened', 'delivering', 'completed', 'failed', 'cancelled',
]);
export const UBUDDY_WAKE_REASONS = Object.freeze([
  'completion', 'recovery_required', 'recovery_exhausted', 'user_action_required', 'cancelled', 'planning_failed',
]);
export const UBUDDY_WAKE_STATUSES = Object.freeze([
  'pending', 'claimed', 'failed_retryable', 'delivered', 'failed_terminal', 'cancelled',
]);

const ACTIVE_WAKE_SOURCE_STATES = new Set(['planning', 'waiting_for_agents', 'sleeping', 'awakened', 'delivering']);
const LEADER_WAKE_REASONS = new Set(['completion', 'recovery_required', 'recovery_exhausted']);
const TERMINAL_COORDINATION_STATES = new Set(['completed', 'failed', 'cancelled']);

export function installUBuddyCoordinationStoreMethods(prototype) {
  Object.assign(prototype, {
    startUBuddyCoordination({
      taskRunId = '', sourceSessionId = '', leaderAgentId = '', leaderAgentInstanceId = '',
    } = {}) {
      if (!taskRunId || !sourceSessionId) throw coordinationError('ubuddy_coordination_identity_incomplete', 'uBuddy coordination requires task and source session identities.');
      return withImmediateTransaction(this, () => {
        const existing = this.getUBuddyCoordinationState(taskRunId);
        if (existing) {
          if (existing.sourceSessionId !== sourceSessionId) {
            throw coordinationError('ubuddy_coordination_identity_conflict', 'uBuddy coordination already belongs to a different source session.');
          }
          if ((leaderAgentId && existing.leaderAgentId && leaderAgentId !== existing.leaderAgentId)
            || (leaderAgentInstanceId && existing.leaderAgentInstanceId && leaderAgentInstanceId !== existing.leaderAgentInstanceId)) {
            throw coordinationError('ubuddy_coordination_leader_conflict', 'uBuddy coordination already has a different task leader identity.');
          }
          return existing;
        }
        const task = taskRow(this, taskRunId);
        if (!task) throw coordinationError('ubuddy_coordination_task_missing', `Task run not found: ${taskRunId}`);
        assertSourceSession(this, task, sourceSessionId);
        const now = nowIso();
        run(this.db, `INSERT INTO ubuddy_coordination_states(
          task_run_id,account_workspace_id,owner_user_id,source_session_id,leader_agent_id,leader_agent_instance_id,
          state,generation,state_revision,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,'planning',0,0,?,?)`, [
          taskRunId, task.account_workspace_id || 'workspace_personal', task.owner_user_id || '', sourceSessionId,
          String(leaderAgentId || ''), String(leaderAgentInstanceId || ''), now, now,
        ]);
        recordCoordinationEvent(this, {
          taskRunId, eventType: 'ubuddy_coordination_started', actorId: 'secretary_agent',
          summary: 'uBuddy coordination state initialized.',
          payload: { sourceSessionId, state: 'planning', generation: 0 },
        });
        return this.getUBuddyCoordinationState(taskRunId);
      });
    },

    getUBuddyCoordinationState(taskRunId = '') {
      return normalizeCoordinationState(get(this.db, 'SELECT * FROM ubuddy_coordination_states WHERE task_run_id=?', [taskRunId]));
    },

    listUBuddyCoordinationStates({ states = [], limit = 100 } = {}) {
      const cleanStates = cleanEnumArray(states, UBUDDY_COORDINATION_STATES);
      if (Array.isArray(states) && states.length && !cleanStates.length) return [];
      const where = cleanStates.length ? `WHERE state IN (${cleanStates.map(() => '?').join(',')})` : '';
      return all(this.db, `SELECT * FROM ubuddy_coordination_states ${where} ORDER BY updated_at ASC LIMIT ?`, [
        ...cleanStates, boundedLimit(limit),
      ]).map(normalizeCoordinationState);
    },

    markUBuddyWaitingForAgents({ taskRunId = '', reason = '' } = {}) {
      return withImmediateTransaction(this, () => {
        const current = requireCoordination(this, taskRunId);
        if (current.state === 'waiting_for_agents') return current;
        assertCoordinationTransition(current.state, ['planning', 'awakened'], 'waiting_for_agents');
        const now = nowIso();
        run(this.db, `UPDATE ubuddy_coordination_states SET state='waiting_for_agents',sleep_reason=?,waiting_at=?,
          sleeping_at='',awakened_at='',delivering_at='',terminal_at='',current_wake_event_id='',
          state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [
          safeText(reason, 1200), now, now, taskRunId,
        ]);
        recordCoordinationEvent(this, {
          taskRunId, eventType: 'ubuddy_waiting_for_agents', actorId: 'secretary_agent',
          summary: safeText(reason || 'uBuddy is waiting for an eligible Agent to become idle.', 600),
          payload: { state: 'waiting_for_agents', generation: current.generation },
        });
        return this.getUBuddyCoordinationState(taskRunId);
      });
    },

    markUBuddySleeping({
      taskRunId = '', leaderAgentId = '', leaderAgentInstanceId = '', sleepReason = '',
    } = {}) {
      if (!leaderAgentId || !leaderAgentInstanceId) {
        throw coordinationError('ubuddy_coordination_leader_required', 'uBuddy cannot sleep before a task leader instance is assigned.');
      }
      return withImmediateTransaction(this, () => {
        const current = requireCoordination(this, taskRunId);
        if (current.state === 'sleeping'
          && current.leaderAgentId === leaderAgentId
          && current.leaderAgentInstanceId === leaderAgentInstanceId) return current;
        assertCoordinationTransition(current.state, ['planning', 'waiting_for_agents', 'awakened', 'failed'], 'sleeping');
        const now = nowIso();
        const generation = current.generation + 1;
        run(this.db, `UPDATE ubuddy_coordination_states SET state='sleeping',generation=?,leader_agent_id=?,
          leader_agent_instance_id=?,sleep_reason=?,current_wake_event_id='',waiting_at='',sleeping_at=?,awakened_at='',
          delivering_at='',terminal_at='',state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [
          generation, leaderAgentId, leaderAgentInstanceId, safeText(sleepReason, 1200), now, now, taskRunId,
        ]);
        recordCoordinationEvent(this, {
          taskRunId, eventType: 'ubuddy_sleeping', actorId: 'secretary_agent',
          summary: `uBuddy is sleeping while ${leaderAgentId} leads the assigned task.`,
          payload: { state: 'sleeping', generation, leaderAgentId, leaderAgentInstanceId },
        });
        return this.getUBuddyCoordinationState(taskRunId);
      });
    },

    markUBuddyContinuationStarted({ taskRunId = '', successorTaskRunId = '' } = {}) {
      if (!taskRunId || !successorTaskRunId) {
        throw coordinationError('ubuddy_continuation_identity_incomplete', 'Task continuation requires predecessor and successor task ids.');
      }
      return withImmediateTransaction(this, () => {
        const current = requireCoordination(this, taskRunId);
        if (current.state === 'cancelled' && !current.currentWakeEventId) return current;
        const now = nowIso();
        if (current.currentWakeEventId) {
          run(this.db, `UPDATE ubuddy_wake_outbox SET status='cancelled',claimed_by='',claimed_at='',lease_expires_at='',
            next_attempt_at='',last_error='',updated_at=? WHERE id=? AND status IN ('pending','claimed','failed_retryable')`, [
            now, current.currentWakeEventId,
          ]);
        }
        run(this.db, `UPDATE ubuddy_coordination_states SET state='cancelled',current_wake_event_id='',delivering_at='',
          terminal_at=?,state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [now, now, taskRunId]);
        recordCoordinationEvent(this, {
          taskRunId,
          eventType: 'ubuddy_task_continued',
          actorId: 'secretary_agent',
          summary: `User requirements continued in successor task ${successorTaskRunId}.`,
          payload: { successorTaskRunId },
        });
        return this.getUBuddyCoordinationState(taskRunId);
      });
    },

    markUBuddyDeliveryAccepted({ taskRunId = '', reason = '' } = {}) {
      return withImmediateTransaction(this, () => {
        const current = requireCoordination(this, taskRunId);
        const now = nowIso();
        if (current.currentWakeEventId) {
          run(this.db, `UPDATE ubuddy_wake_outbox SET status='cancelled',claimed_by='',claimed_at='',lease_expires_at='',
            next_attempt_at='',last_error='superseded by accepted delivery',updated_at=?
            WHERE id=? AND status IN ('pending','claimed','failed_retryable')`, [now, current.currentWakeEventId]);
        }
        const generation = current.generation + 1;
        run(this.db, `UPDATE ubuddy_coordination_states SET state='sleeping',generation=?,sleep_reason=?,
          current_wake_event_id='',waiting_at='',sleeping_at=?,awakened_at='',delivering_at='',terminal_at='',
          state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [
          generation, safeText(reason || 'A saved delivery version was accepted.', 1200), now, now, taskRunId,
        ]);
        recordCoordinationEvent(this, {
          taskRunId,
          eventType: 'ubuddy_delivery_acceptance_coordinated',
          actorId: 'secretary_agent',
          summary: safeText(reason || 'A saved delivery version was accepted.', 600),
          payload: { generation, previousState: current.state },
        });
        return this.getUBuddyCoordinationState(taskRunId);
      });
    },

    requestUBuddyWake({
      taskRunId = '', reasonCode = '', leaderAgentId = '', leaderAgentInstanceId = '',
      sourceTaskEventId = '', payload = {}, actorId = '',
    } = {}) {
      if (!UBUDDY_WAKE_REASONS.includes(String(reasonCode || ''))) {
        throw coordinationError('ubuddy_wake_reason_invalid', `Invalid uBuddy wake reason: ${reasonCode || 'missing'}`);
      }
      return withImmediateTransaction(this, () => {
        const current = requireCoordination(this, taskRunId);
        const existing = this.getUBuddyWakeForGeneration({ taskRunId, generation: current.generation });
        if (existing) {
          if (existing.reasonCode !== reasonCode) {
            throw coordinationError('ubuddy_wake_reason_conflict', `Wake generation ${current.generation} already uses reason ${existing.reasonCode}.`);
          }
          return existing;
        }
        if (!ACTIVE_WAKE_SOURCE_STATES.has(current.state)) {
          throw coordinationError('ubuddy_wake_state_invalid', `Cannot request a wake while coordination state is ${current.state}.`);
        }
        if (LEADER_WAKE_REASONS.has(reasonCode)) {
          assertLeaderIdentity(current, leaderAgentId, leaderAgentInstanceId);
        }
        const now = nowIso();
        const id = newId('ubuddy_wake');
        const idempotencyKey = `ubuddy-wake:${taskRunId}:${current.generation}`;
        const safePayload = sanitizeWakePayload(payload, {
          taskRunId, reasonCode, leaderAgentId: leaderAgentId || current.leaderAgentId,
          leaderAgentInstanceId: leaderAgentInstanceId || current.leaderAgentInstanceId, sourceTaskEventId,
        });
        run(this.db, `INSERT INTO ubuddy_wake_outbox(
          id,task_run_id,coordination_generation,idempotency_key,account_workspace_id,owner_user_id,source_session_id,
          leader_agent_id,leader_agent_instance_id,reason_code,status,payload_json,source_task_event_id,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`, [
          id, taskRunId, current.generation, idempotencyKey, current.accountWorkspaceId, current.ownerUserId,
          current.sourceSessionId, leaderAgentId || current.leaderAgentId, leaderAgentInstanceId || current.leaderAgentInstanceId,
          reasonCode, JSON.stringify(safePayload), String(sourceTaskEventId || ''), now, now,
        ]);
        run(this.db, `UPDATE ubuddy_coordination_states SET state='awakened',current_wake_event_id=?,awakened_at=?,
          delivering_at='',terminal_at='',state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [id, now, now, taskRunId]);
        recordCoordinationEvent(this, {
          taskRunId, eventType: 'leader_wake_requested',
          actorId: actorId || leaderAgentId || current.leaderAgentId || 'task_scheduler',
          summary: wakeReasonSummary(reasonCode),
          payload: { wakeEventId: id, reasonCode, generation: current.generation, sourceTaskEventId: String(sourceTaskEventId || '') },
        });
        return this.getUBuddyWakeEvent(id);
      });
    },

    getUBuddyWakeEvent(id = '') {
      return normalizeWakeEvent(get(this.db, 'SELECT * FROM ubuddy_wake_outbox WHERE id=?', [id]));
    },

    getUBuddyWakeForGeneration({ taskRunId = '', generation = 0 } = {}) {
      return normalizeWakeEvent(get(this.db, `SELECT * FROM ubuddy_wake_outbox
        WHERE task_run_id=? AND coordination_generation=?`, [taskRunId, Math.max(0, Number(generation || 0))]));
    },

    listUBuddyWakeEvents({ statuses = [], taskRunId = '', limit = 100 } = {}) {
      const cleanStatuses = cleanEnumArray(statuses, UBUDDY_WAKE_STATUSES);
      if (Array.isArray(statuses) && statuses.length && !cleanStatuses.length) return [];
      const where = [];
      const params = [];
      if (taskRunId) { where.push('task_run_id=?'); params.push(taskRunId); }
      if (cleanStatuses.length) {
        where.push(`status IN (${cleanStatuses.map(() => '?').join(',')})`);
        params.push(...cleanStatuses);
      }
      params.push(boundedLimit(limit));
      return all(this.db, `SELECT * FROM ubuddy_wake_outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at ASC LIMIT ?`, params).map(normalizeWakeEvent);
    },

    claimPendingUBuddyWakes({
      limit = 20, taskRunId = '', workerId = `ubuddy_runtime_${process.pid}`, leaseMs = 60_000, now = Date.now(),
    } = {}) {
      const nowText = isoAt(now);
      const leaseExpiresAt = isoAt(timestampMs(now) + Math.max(1_000, Number(leaseMs || 60_000)));
      return withImmediateTransaction(this, () => {
        const candidates = all(this.db, `SELECT * FROM ubuddy_wake_outbox WHERE (?='' OR task_run_id=?) AND (
          ((status IN ('pending','failed_retryable')) AND (next_attempt_at='' OR next_attempt_at<=?))
          OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?))
          ORDER BY created_at ASC LIMIT ?`, [taskRunId, taskRunId, nowText, nowText, boundedLimit(limit)]);
        const claimed = [];
        for (const row of candidates) {
          const result = run(this.db, `UPDATE ubuddy_wake_outbox SET status='claimed',claimed_by=?,claimed_at=?,
            lease_expires_at=?,attempt_count=attempt_count+1,next_attempt_at='',last_error='',updated_at=? WHERE id=? AND (
              ((status IN ('pending','failed_retryable')) AND (next_attempt_at='' OR next_attempt_at<=?))
              OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?)
            )`, [workerId, nowText, leaseExpiresAt, nowText, row.id, nowText, nowText]);
          if (!Number(result?.changes || 0)) continue;
          run(this.db, `UPDATE ubuddy_coordination_states SET state='delivering',delivering_at=?,
            state_revision=state_revision+1,updated_at=? WHERE task_run_id=? AND current_wake_event_id=?
            AND state IN ('awakened','delivering')`, [nowText, nowText, row.task_run_id, row.id]);
          const wake = this.getUBuddyWakeEvent(row.id);
          recordCoordinationEvent(this, {
            taskRunId: wake.taskRunId, eventType: 'ubuddy_wake_claimed', actorId: workerId,
            summary: 'A persisted uBuddy wake was claimed for delivery.',
            payload: { wakeEventId: wake.id, generation: wake.coordinationGeneration, attemptCount: wake.attemptCount },
          });
          claimed.push(wake);
        }
        return claimed;
      });
    },

    consumePendingUBuddyWake(taskRunId = '', options = {}) {
      if (!taskRunId) throw coordinationError('ubuddy_wake_task_required', 'Consuming a pending uBuddy wake requires a task run id.');
      return this.claimPendingUBuddyWakes({ ...options, taskRunId, limit: 1 })[0] || null;
    },

    acknowledgeUBuddyWake({ wakeEventId = '', deliveryMessageId = '' } = {}) {
      if (!deliveryMessageId) throw coordinationError('ubuddy_wake_delivery_message_required', 'Wake acknowledgement requires the delivered uBuddy message id.');
      return withImmediateTransaction(this, () => {
        const wake = requireWake(this, wakeEventId);
        if (wake.status === 'delivered') {
          reconcileDeliveredWake(this, wake);
          return this.getUBuddyWakeEvent(wakeEventId);
        }
        if (wake.status !== 'claimed') {
          throw coordinationError('ubuddy_wake_not_claimed', `Wake event ${wakeEventId} must be claimed before acknowledgement.`);
        }
        const now = nowIso();
        run(this.db, `UPDATE ubuddy_wake_outbox SET status='delivered',delivery_message_id=?,delivered_at=?,
          claimed_by='',claimed_at='',lease_expires_at='',next_attempt_at='',last_error='',updated_at=? WHERE id=?`, [
          String(deliveryMessageId || ''), now, now, wakeEventId,
        ]);
        reconcileDeliveredWake(this, { ...wake, deliveryMessageId: String(deliveryMessageId || ''), deliveredAt: now });
        recordCoordinationEvent(this, {
          taskRunId: wake.taskRunId, eventType: 'ubuddy_wake_delivered', actorId: 'ubuddy_runtime',
          summary: 'The persisted uBuddy wake was delivered.',
          payload: { wakeEventId, reasonCode: wake.reasonCode, generation: wake.coordinationGeneration,
            deliveryMessageId: String(deliveryMessageId || '') },
        });
        return this.getUBuddyWakeEvent(wakeEventId);
      });
    },

    failUBuddyWakeDelivery({ wakeEventId = '', error = '', permanent = false, retryAt = '' } = {}) {
      return withImmediateTransaction(this, () => {
        const wake = requireWake(this, wakeEventId);
        if (wake.status === 'delivered' || wake.status === 'failed_terminal') return wake;
        if (!['claimed', 'pending', 'failed_retryable'].includes(wake.status)) {
          throw coordinationError('ubuddy_wake_failure_state_invalid', `Wake event ${wakeEventId} cannot fail from status ${wake.status}.`);
        }
        const now = nowIso();
        const nextAttemptAt = permanent ? '' : String(retryAt || isoAt(Date.now() + wakeRetryDelayMs(Math.max(1, wake.attemptCount))));
        const nextStatus = permanent ? 'failed_terminal' : 'failed_retryable';
        const safeError = safeText(error || 'uBuddy wake delivery failed.', 2000);
        run(this.db, `UPDATE ubuddy_wake_outbox SET status=?,claimed_by='',claimed_at='',lease_expires_at='',
          next_attempt_at=?,last_error=?,updated_at=? WHERE id=?`, [nextStatus, nextAttemptAt, safeError, now, wakeEventId]);
        run(this.db, `UPDATE ubuddy_coordination_states SET state='awakened',delivering_at='',awakened_at=CASE
          WHEN awakened_at='' THEN ? ELSE awakened_at END,state_revision=state_revision+1,updated_at=?
          WHERE task_run_id=? AND current_wake_event_id=? AND state='delivering'`, [now, now, wake.taskRunId, wakeEventId]);
        recordCoordinationEvent(this, {
          taskRunId: wake.taskRunId, eventType: permanent ? 'ubuddy_wake_delivery_terminal_failure' : 'ubuddy_wake_delivery_retry_scheduled',
          actorId: 'ubuddy_runtime', summary: safeError,
          payload: { wakeEventId, reasonCode: wake.reasonCode, generation: wake.coordinationGeneration,
            permanent: Boolean(permanent), nextAttemptAt },
        });
        return this.getUBuddyWakeEvent(wakeEventId);
      });
    },

    recoverUBuddyCoordination({ now = Date.now(), limit = 200 } = {}) {
      const nowText = isoAt(now);
      const expiredClaims = all(this.db, `SELECT id,task_run_id FROM ubuddy_wake_outbox WHERE status='claimed'
        AND lease_expires_at<>'' AND lease_expires_at<=? ORDER BY updated_at ASC LIMIT ?`, [nowText, boundedLimit(limit)]);
      for (const item of expiredClaims) {
        run(this.db, `UPDATE ubuddy_wake_outbox SET status='failed_retryable',claimed_by='',claimed_at='',lease_expires_at='',
          next_attempt_at='',last_error='wake delivery lease expired',updated_at=? WHERE id=? AND status='claimed'`, [nowText, item.id]);
        run(this.db, `UPDATE ubuddy_coordination_states SET state='awakened',delivering_at='',state_revision=state_revision+1,
          updated_at=? WHERE task_run_id=? AND current_wake_event_id=? AND state='delivering'`, [nowText, item.task_run_id, item.id]);
      }

      const delivered = all(this.db, `SELECT outbox.* FROM ubuddy_wake_outbox outbox
        JOIN ubuddy_coordination_states coordination ON coordination.task_run_id=outbox.task_run_id
        WHERE outbox.status='delivered' AND coordination.current_wake_event_id=outbox.id
        ORDER BY outbox.updated_at ASC LIMIT ?`, [boundedLimit(limit)]).map(normalizeWakeEvent);
      let reconciledDeliveredCount = 0;
      for (const wake of delivered) {
        if (reconcileDeliveredWake(this, wake)) reconciledDeliveredCount += 1;
      }

      const terminalTasks = all(this.db, `SELECT coordination.task_run_id,coordination.generation,coordination.state,
          coordination.leader_agent_id,coordination.leader_agent_instance_id,task.status task_status,task.summary task_summary,
          task.metadata_json task_metadata_json
        FROM ubuddy_coordination_states coordination JOIN task_runs task ON task.id=coordination.task_run_id
        LEFT JOIN ubuddy_wake_outbox outbox ON outbox.task_run_id=coordination.task_run_id
          AND outbox.coordination_generation=coordination.generation
        WHERE task.status IN ('completed','failed','cancelled')
          AND coordination.state NOT IN ('completed','failed','cancelled') AND outbox.id IS NULL
        ORDER BY task.updated_at ASC LIMIT ?`, [boundedLimit(limit)]);
      let createdWakeCount = 0;
      for (const item of terminalTasks) {
        const hasLeader = Boolean(item.leader_agent_id && item.leader_agent_instance_id);
        const taskMetadata = safeJsonParse(item.task_metadata_json, {});
        const recovery = taskMetadata.backgroundRecovery || {};
        const recoveryAttemptCount = Math.max(0, Number(recovery.attemptCount || 0));
        const recoveryMaxAttempts = Math.max(1, Number(recovery.maxAttempts || process.env.JANUS_UBUDDY_RECOVERY_MAX_ATTEMPTS || 2));
        const failureReport = taskMetadata.failureReport || taskMetadata.publicFailure || null;
        const reasonCode = item.task_status === 'cancelled' ? 'cancelled'
          : !hasLeader ? 'planning_failed'
            : item.task_status === 'completed' ? 'completion'
              : recoveryAttemptCount < recoveryMaxAttempts ? 'recovery_required' : 'recovery_exhausted';
        this.requestUBuddyWake({
          taskRunId: item.task_run_id,
          reasonCode,
          leaderAgentId: item.leader_agent_id || '',
          leaderAgentInstanceId: item.leader_agent_instance_id || '',
          actorId: item.leader_agent_id || 'task_recovery',
          payload: { taskStatus: item.task_status, reportSummary: item.task_summary || '', failureReport },
        });
        createdWakeCount += 1;
      }
      return {
        expiredClaimCount: expiredClaims.length,
        reconciledDeliveredCount,
        createdWakeCount,
        pending: this.listUBuddyWakeEvents({ statuses: ['pending', 'failed_retryable'], limit }),
      };
    },
  });
}

function withImmediateTransaction(store, operation) {
  const ownsTransaction = !store.db.isTransaction;
  if (ownsTransaction) store.db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (ownsTransaction) store.db.exec('COMMIT');
    return result;
  } catch (error) {
    if (ownsTransaction) store.db.exec('ROLLBACK');
    throw error;
  }
}

function taskRow(store, taskRunId) {
  return get(store.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]);
}

function assertSourceSession(store, task, sourceSessionId) {
  const session = get(store.db, `SELECT id,user_id,account_workspace_id,department_id,agent_id,status FROM sessions WHERE id=?`, [sourceSessionId]);
  if (!session || session.status === 'deleted') {
    throw coordinationError('ubuddy_coordination_source_session_missing', `Source uBuddy session not found: ${sourceSessionId}`);
  }
  if (String(session.user_id || '') !== String(task.owner_user_id || '')
    || String(session.account_workspace_id || 'workspace_personal') !== String(task.account_workspace_id || 'workspace_personal')) {
    throw coordinationError('ubuddy_coordination_source_session_mismatch', 'Source uBuddy session does not belong to the task owner and Workspace.');
  }
  if (session.department_id !== 'secretary_department' || session.agent_id !== 'secretary_agent') {
    throw coordinationError('ubuddy_coordination_source_session_not_ubuddy', 'Source session is not the owner\'s uBuddy conversation.');
  }
}

function requireCoordination(store, taskRunId) {
  const current = store.getUBuddyCoordinationState(taskRunId);
  if (!current) throw coordinationError('ubuddy_coordination_missing', `uBuddy coordination state not found: ${taskRunId}`);
  return current;
}

function requireWake(store, wakeEventId) {
  const wake = store.getUBuddyWakeEvent(wakeEventId);
  if (!wake) throw coordinationError('ubuddy_wake_missing', `uBuddy wake event not found: ${wakeEventId}`);
  return wake;
}

function assertCoordinationTransition(current, allowed, target) {
  if (allowed.includes(current)) return;
  throw coordinationError('ubuddy_coordination_transition_invalid', `Cannot transition uBuddy coordination from ${current} to ${target}.`);
}

function assertLeaderIdentity(current, leaderAgentId, leaderAgentInstanceId) {
  if (leaderAgentId && leaderAgentInstanceId
    && leaderAgentId === current.leaderAgentId
    && leaderAgentInstanceId === current.leaderAgentInstanceId) return;
  throw coordinationError('ubuddy_wake_leader_mismatch', 'Only the assigned task leader instance may request this uBuddy wake.');
}

function reconcileDeliveredWake(store, wake) {
  const state = coordinationStateAfterDelivery(wake.reasonCode);
  const current = store.getUBuddyCoordinationState(wake.taskRunId);
  if (!current || current.currentWakeEventId !== wake.id || current.state === state) return false;
  const now = wake.deliveredAt || nowIso();
  run(store.db, `UPDATE ubuddy_coordination_states SET state=?,delivering_at='',terminal_at=?,
    state_revision=state_revision+1,updated_at=? WHERE task_run_id=? AND current_wake_event_id=?`, [
    state, TERMINAL_COORDINATION_STATES.has(state) ? now : '', now, wake.taskRunId, wake.id,
  ]);
  return true;
}

function coordinationStateAfterDelivery(reasonCode) {
  if (reasonCode === 'completion') return 'completed';
  if (reasonCode === 'cancelled') return 'cancelled';
  if (reasonCode === 'user_action_required' || reasonCode === 'recovery_required') return 'awakened';
  return 'failed';
}

function sanitizeWakePayload(payload = {}, context = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const result = {
    taskRunId: String(context.taskRunId || ''),
    reasonCode: String(context.reasonCode || ''),
    leaderAgentId: String(context.leaderAgentId || ''),
    leaderAgentInstanceId: String(context.leaderAgentInstanceId || ''),
    sourceTaskEventId: String(context.sourceTaskEventId || ''),
  };
  for (const key of ['resultState', 'failureCode', 'taskStatus']) {
    if (Object.hasOwn(source, key)) result[key] = safeText(source[key], 160);
  }
  if (Object.hasOwn(source, 'reportSummary')) result.reportSummary = safeText(source.reportSummary, 4000);
  const failureReport = source.failureReport && typeof source.failureReport === 'object' && !Array.isArray(source.failureReport)
    ? source.failureReport : null;
  if (failureReport) {
    result.failureReport = {};
    for (const key of [
      'failureNodeId', 'failureNode', 'failureAgentId', 'failureAgentInstanceId',
      'leaderAgentId', 'leaderAgentInstanceId', 'errorCode', 'errorType', 'summary', 'cause', 'suggestedNextStep',
    ]) {
      if (Object.hasOwn(failureReport, key)) result.failureReport[key] = safeText(failureReport[key], key === 'cause' ? 2000 : 800);
    }
    for (const key of ['retryable', 'retriesExhausted', 'userActionRequired', 'attemptedRetry']) {
      if (Object.hasOwn(failureReport, key)) result.failureReport[key] = Boolean(failureReport[key]);
    }
    for (const key of ['attemptCount', 'maxAttempts']) {
      if (Object.hasOwn(failureReport, key)) result.failureReport[key] = Math.max(0, Number(failureReport[key] || 0));
    }
    if (Array.isArray(failureReport.attemptedActions)) {
      result.failureReport.attemptedActions = failureReport.attemptedActions
        .map((item) => safeText(item, 800)).filter(Boolean).slice(0, 12);
    }
  }
  const reference = source.deliverableRef && typeof source.deliverableRef === 'object' && !Array.isArray(source.deliverableRef)
    ? source.deliverableRef : null;
  if (reference) {
    result.deliverableRef = {};
    for (const key of ['taskRunId', 'taskNodeId', 'messageId']) {
      if (Object.hasOwn(reference, key)) result.deliverableRef[key] = safeText(reference[key], 200);
    }
    if (Array.isArray(reference.artifactIds)) {
      result.deliverableRef.artifactIds = reference.artifactIds.map((item) => safeText(item, 200)).filter(Boolean).slice(0, 50);
    }
  }
  return result;
}

function normalizeCoordinationState(row) {
  if (!row) return null;
  return {
    taskRunId: row.task_run_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    sourceSessionId: row.source_session_id || '',
    leaderAgentId: row.leader_agent_id || '',
    leaderAgentInstanceId: row.leader_agent_instance_id || '',
    state: row.state || 'planning',
    generation: Math.max(0, Number(row.generation || 0)),
    currentWakeEventId: row.current_wake_event_id || '',
    sleepReason: row.sleep_reason || '',
    stateRevision: Math.max(0, Number(row.state_revision || 0)),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    waitingAt: row.waiting_at || '',
    sleepingAt: row.sleeping_at || '',
    awakenedAt: row.awakened_at || '',
    deliveringAt: row.delivering_at || '',
    terminalAt: row.terminal_at || '',
  };
}

function normalizeWakeEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    coordinationGeneration: Math.max(0, Number(row.coordination_generation || 0)),
    idempotencyKey: row.idempotency_key || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    sourceSessionId: row.source_session_id || '',
    leaderAgentId: row.leader_agent_id || '',
    leaderAgentInstanceId: row.leader_agent_instance_id || '',
    reasonCode: row.reason_code || '',
    status: row.status || 'pending',
    payload: safeJsonParse(row.payload_json, {}),
    sourceTaskEventId: row.source_task_event_id || '',
    claimedBy: row.claimed_by || '',
    claimedAt: row.claimed_at || '',
    leaseExpiresAt: row.lease_expires_at || '',
    attemptCount: Math.max(0, Number(row.attempt_count || 0)),
    nextAttemptAt: row.next_attempt_at || '',
    lastError: row.last_error || '',
    deliveryMessageId: row.delivery_message_id || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    deliveredAt: row.delivered_at || '',
  };
}

function recordCoordinationEvent(store, event) {
  return typeof store.recordTaskEvent === 'function' ? store.recordTaskEvent(event) : null;
}

function cleanEnumArray(values, allowed) {
  const allowedSet = new Set(allowed);
  return [...new Set((Array.isArray(values) ? values : []).map(String).filter((item) => allowedSet.has(item)))];
}

function boundedLimit(value) {
  return Math.max(1, Math.min(500, Number(value || 100)));
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isoAt(value) {
  return new Date(timestampMs(value)).toISOString();
}

function wakeRetryDelayMs(attemptCount) {
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.min(8, Math.max(0, Number(attemptCount || 1) - 1))));
}

function wakeReasonSummary(reasonCode) {
  return ({
    completion: 'The task leader requested uBuddy wake for final delivery.',
    recovery_required: 'The task leader requested uBuddy wake for bounded automatic recovery.',
    recovery_exhausted: 'The task leader requested uBuddy wake after recovery was exhausted.',
    user_action_required: 'The task leader requested uBuddy wake because owner action is required.',
    cancelled: 'The task was cancelled and requested uBuddy wake.',
    planning_failed: 'Background task planning failed and requested uBuddy wake.',
  })[reasonCode] || 'A persisted uBuddy wake was requested.';
}

function safeText(value, maxLength) {
  return redactLocalPaths(redactDiagnosticText(String(value || ''), { maxLength }));
}

function redactLocalPaths(value) {
  return String(value || '')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[LOCAL_PATH]')
    .replace(/(?<!:)\/(?:[^/\s]+\/)+[^/\s]*/g, '[LOCAL_PATH]');
}

function coordinationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
