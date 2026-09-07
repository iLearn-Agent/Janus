import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

const PLANNING_JOB_STATUSES = Object.freeze(['pending', 'claimed', 'retry_wait', 'completed', 'failed', 'cancelled']);

export function installUBuddyPlanningStoreMethods(prototype) {
  Object.assign(prototype, {
    createUBuddyPlanningJob({ taskRunId = '', sourceSessionId = '', payload = {}, maxAttempts = 3 } = {}) {
      const task = get(this.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]);
      if (!task) throw planningError('ubuddy_planning_task_missing', `Task run not found: ${taskRunId}`);
      const existing = this.getUBuddyPlanningJob({ taskRunId });
      if (existing) return existing;
      const now = nowIso();
      run(this.db, `INSERT INTO ubuddy_planning_jobs(
        id,task_run_id,account_workspace_id,owner_user_id,source_session_id,status,idempotency_key,payload_json,
        max_attempts,created_at,updated_at
      ) VALUES(?,?,?,?,?,'pending',?,?,?, ?,?)`, [
        newId('ubuddy_plan'), taskRunId, task.account_workspace_id || 'workspace_personal', task.owner_user_id || '',
        sourceSessionId || safeJsonParse(task.metadata_json, {}).sourceSecretarySessionId || '',
        `ubuddy-planning:${taskRunId}`, JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
        Math.max(1, Math.min(10, Number(maxAttempts || 3))), now, now,
      ]);
      this.recordTaskEvent?.({
        taskRunId, eventType: 'ubuddy_planning_queued', actorId: 'secretary_agent',
        summary: 'uBuddy workflow planning was queued as a persistent background job.',
        payload: { state: 'planning', idempotencyKey: `ubuddy-planning:${taskRunId}` },
      });
      return this.getUBuddyPlanningJob({ taskRunId });
    },

    getUBuddyPlanningJob({ id = '', taskRunId = '' } = {}) {
      if (!id && !taskRunId) return null;
      return normalizePlanningJob(get(this.db, `SELECT * FROM ubuddy_planning_jobs WHERE ${id ? 'id=?' : 'task_run_id=?'}`, [id || taskRunId]));
    },

    listUBuddyPlanningJobs({ statuses = [], limit = 100 } = {}) {
      const clean = [...new Set((Array.isArray(statuses) ? statuses : []).filter((status) => PLANNING_JOB_STATUSES.includes(status)))];
      const where = clean.length ? `WHERE status IN (${clean.map(() => '?').join(',')})` : '';
      return all(this.db, `SELECT * FROM ubuddy_planning_jobs ${where}
        ORDER BY created_at ASC,id ASC LIMIT ?`, [...clean, Math.max(1, Math.min(500, Number(limit || 100)))])
        .map(normalizePlanningJob);
    },

    claimNextUBuddyPlanningJob({ workerId = '', leaseMs = 60_000 } = {}) {
      if (!workerId) throw planningError('ubuddy_planning_worker_missing', 'Planning worker identity is required.');
      return withImmediateTransaction(this, () => {
        const now = nowIso();
        const candidate = get(this.db, `SELECT id FROM ubuddy_planning_jobs
          WHERE (status='pending' OR (status='retry_wait' AND (next_attempt_at='' OR next_attempt_at<=?))
            OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?))
          ORDER BY created_at ASC,id ASC LIMIT 1`, [now, now]);
        if (!candidate) return null;
        const leaseExpiresAt = new Date(Date.now() + Math.max(5_000, Number(leaseMs || 60_000))).toISOString();
        const claimed = run(this.db, `UPDATE ubuddy_planning_jobs SET status='claimed',claimed_by=?,claimed_at=?,lease_expires_at=?,
          attempt_count=attempt_count+1,next_attempt_at='',updated_at=? WHERE id=? AND
          (status='pending' OR status='retry_wait' OR (status='claimed' AND lease_expires_at<=?))`, [
          workerId, now, leaseExpiresAt, now, candidate.id, now,
        ]);
        return Number(claimed?.changes || 0) ? this.getUBuddyPlanningJob({ id: candidate.id }) : null;
      });
    },

    completeUBuddyPlanningJob({ id = '', result = {} } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_planning_jobs SET status='completed',result_json=?,claimed_by='',claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error='',completed_at=?,updated_at=? WHERE id=? AND status='claimed'`, [JSON.stringify(result || {}), now, now, id]);
      return this.getUBuddyPlanningJob({ id });
    },

    failUBuddyPlanningJob({ id = '', error = '', retryable = false, retryDelayMs = 0 } = {}) {
      const current = this.getUBuddyPlanningJob({ id });
      if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) return current;
      const terminal = !retryable || current.attemptCount >= current.maxAttempts;
      const now = nowIso();
      const nextAttemptAt = terminal ? '' : new Date(Date.now() + Math.max(0, Number(retryDelayMs || 0))).toISOString();
      run(this.db, `UPDATE ubuddy_planning_jobs SET status=?,claimed_by='',claimed_at='',lease_expires_at='',next_attempt_at=?,
        last_error=?,updated_at=? WHERE id=?`, [terminal ? 'failed' : 'retry_wait', nextAttemptAt, String(error || '').slice(0, 4000), now, id]);
      return this.getUBuddyPlanningJob({ id });
    },

    cancelUBuddyPlanningJob({ taskRunId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_planning_jobs SET status='cancelled',claimed_by='',claimed_at='',lease_expires_at='',
        cancelled_at=?,updated_at=? WHERE task_run_id=? AND status NOT IN ('completed','failed','cancelled')`, [now, now, taskRunId]);
      return this.getUBuddyPlanningJob({ taskRunId });
    },

    recoverUBuddyPlanningJobs() {
      const now = nowIso();
      const result = run(this.db, `UPDATE ubuddy_planning_jobs SET status='retry_wait',claimed_by='',claimed_at='',lease_expires_at='',
        next_attempt_at=?,last_error=CASE WHEN last_error='' THEN 'Planning worker lease expired during restart recovery.' ELSE last_error END,
        updated_at=? WHERE status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?`, [now, now, now]);
      return { recoveredCount: Number(result?.changes || 0), pending: this.listUBuddyPlanningJobs({ statuses: ['pending', 'retry_wait'] }) };
    },
  });
}

function normalizePlanningJob(row) {
  if (!row) return null;
  return {
    id: row.id, taskRunId: row.task_run_id, accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '', sourceSessionId: row.source_session_id || '', status: row.status,
    idempotencyKey: row.idempotency_key, payload: safeJsonParse(row.payload_json, {}), result: safeJsonParse(row.result_json, {}),
    attemptCount: Number(row.attempt_count || 0), maxAttempts: Number(row.max_attempts || 3), claimedBy: row.claimed_by || '',
    claimedAt: row.claimed_at || '', leaseExpiresAt: row.lease_expires_at || '', nextAttemptAt: row.next_attempt_at || '',
    lastError: row.last_error || '', createdAt: row.created_at || '', updatedAt: row.updated_at || '',
    completedAt: row.completed_at || '', cancelledAt: row.cancelled_at || '',
  };
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

function planningError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export { PLANNING_JOB_STATUSES };
