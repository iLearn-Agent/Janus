import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse, sha256Text } from '../../../utils.js';
import {
  DEFAULT_MAX_QUALITY_REVISIONS,
  normalizeDeliveryReviewPolicy,
  transitionDeliveryReview,
} from '../../../../shared/contracts/uBuddyDeliveryReview.js';

const REVIEW_JOB_STATUSES = new Set(['pending', 'claimed', 'retry_wait', 'completed', 'action_required', 'cancelled']);

export function installTaskDeliveryReviewStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureTaskDeliveryReview({ taskRunId = '', revisionLimit = DEFAULT_MAX_QUALITY_REVISIONS } = {}) {
      if (!taskRunId) throw reviewStoreError('delivery_review_task_required', 'Delivery review requires a task run id.');
      return withImmediateTransaction(this, () => {
        const existing = this.getTaskDeliveryReview(taskRunId);
        if (existing) return existing;
        const task = get(this.db, 'SELECT * FROM task_runs WHERE id=?', [taskRunId]);
        if (!task) throw reviewStoreError('delivery_review_task_missing', `Task run not found: ${taskRunId}`);
        const now = nowIso();
        run(this.db, `INSERT INTO task_delivery_reviews(
          task_run_id,account_workspace_id,owner_user_id,state,quality_revision_limit,created_at,updated_at
        ) VALUES(?,?,?,'submitted',?,?,?)`, [
          taskRunId, task.account_workspace_id || 'workspace_personal', task.owner_user_id || '',
          boundedLimit(revisionLimit), now, now,
        ]);
        return this.getTaskDeliveryReview(taskRunId);
      });
    },

    getTaskDeliveryReview(taskRunId = '') {
      return normalizeReviewRow(get(this.db, 'SELECT * FROM task_delivery_reviews WHERE task_run_id=?', [taskRunId]));
    },

    listTaskDeliveryReviews({ states = [], limit = 100 } = {}) {
      const requested = [...new Set((Array.isArray(states) ? states : []).map(String).filter(Boolean))];
      const where = requested.length ? `WHERE state IN (${requested.map(() => '?').join(',')})` : '';
      return all(this.db, `SELECT * FROM task_delivery_reviews ${where} ORDER BY updated_at ASC LIMIT ?`, [
        ...requested, boundedRows(limit),
      ]).map(normalizeReviewRow);
    },

    recordTaskDeliverySubmission({
      taskRunId = '', taskNodeId = '', resultVersionId = '', submissionKey = '', bodySnapshot = '',
      evidence = {}, artifactManifest = [], revisionLimit = DEFAULT_MAX_QUALITY_REVISIONS,
    } = {}) {
      if (!taskRunId || !submissionKey) throw reviewStoreError('delivery_submission_identity_required', 'Delivery submission identity is incomplete.');
      return withImmediateTransaction(this, () => {
        this.ensureTaskDeliveryReview({ taskRunId, revisionLimit });
        const normalizedInput = {
          taskRunId,
          taskNodeId: String(taskNodeId || ''),
          resultVersionId: String(resultVersionId || ''),
          bodySnapshot: String(bodySnapshot || '').slice(0, 400_000),
          evidence: evidence || {},
          artifactManifest: Array.isArray(artifactManifest) ? artifactManifest : [],
        };
        const existing = normalizeSubmissionRow(get(this.db, 'SELECT * FROM task_delivery_submissions WHERE submission_key=?', [submissionKey]));
        if (existing) {
          if (submissionFingerprint(existing) !== submissionFingerprint(normalizedInput)) {
            throw reviewStoreError('delivery_submission_payload_conflict', 'Delivery submission key was replayed with different content.');
          }
          return existing;
        }
        const submissionNo = Number(get(this.db, `SELECT COALESCE(MAX(submission_no),0)+1 AS next
          FROM task_delivery_submissions WHERE task_run_id=?`, [taskRunId])?.next || 1);
        const id = newId('delivery_submission');
        run(this.db, `INSERT INTO task_delivery_submissions(
          id,task_run_id,task_node_id,result_version_id,submission_key,submission_no,body_snapshot,evidence_json,artifact_manifest_json
        ) VALUES(?,?,?,?,?,?,?,?,?)`, [
          id, taskRunId, normalizedInput.taskNodeId, normalizedInput.resultVersionId, submissionKey, submissionNo,
          normalizedInput.bodySnapshot, JSON.stringify(normalizedInput.evidence), JSON.stringify(normalizedInput.artifactManifest),
        ]);
        run(this.db, `UPDATE task_delivery_reviews SET latest_submission_id=?,updated_at=? WHERE task_run_id=?`, [id, nowIso(), taskRunId]);
        return this.getTaskDeliverySubmission(id);
      });
    },

    getTaskDeliverySubmission(id = '') {
      return normalizeSubmissionRow(get(this.db, 'SELECT * FROM task_delivery_submissions WHERE id=?', [id]));
    },

    listTaskDeliverySubmissions(taskRunId = '') {
      return all(this.db, `SELECT * FROM task_delivery_submissions WHERE task_run_id=? ORDER BY submission_no ASC`, [taskRunId])
        .map(normalizeSubmissionRow);
    },

    transitionTaskDeliveryReview({ taskRunId = '', submissionId = '', eventId = '', eventType = '', payload = {} } = {}) {
      if (!taskRunId || !eventId || !eventType) throw reviewStoreError('delivery_review_event_identity_required', 'Delivery review event identity is incomplete.');
      return withImmediateTransaction(this, () => {
        const current = this.ensureTaskDeliveryReview({ taskRunId });
        const payloadJson = JSON.stringify(payload || {});
        const payloadHash = reviewEventFingerprint({ taskRunId, submissionId, eventType, payload: payload || {} });
        const existing = get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId]);
        if (existing) {
          if (existing.task_run_id !== taskRunId || existing.submission_id !== String(submissionId || '')
            || existing.event_type !== eventType || existing.payload_hash !== payloadHash) {
            throw reviewStoreError('delivery_review_event_payload_conflict', `Review event ${eventId} was replayed with different content.`);
          }
          return { changed: false, duplicate: true, action: 'duplicate', review: this.getTaskDeliveryReview(taskRunId), event: normalizeReviewEventRow(existing) };
        }
        const transition = transitionDeliveryReview(current, { id: eventId, type: eventType, ...payload });
        if (!transition.changed) return { ...transition, event: null };
        const now = nowIso();
        run(this.db, `INSERT INTO task_delivery_review_events(
          event_id,task_run_id,submission_id,event_type,from_state,to_state,payload_hash,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`, [
          eventId, taskRunId, String(submissionId || ''), eventType, current.state, transition.review.state,
          payloadHash, payloadJson, now,
        ]);
        const terminalAt = ['accepted', 'revision_exhausted', 'failed'].includes(transition.review.state) ? now : '';
        const latestFeedback = {
          ...reviewFeedback(transition.review),
          summary: String(payload?.summary || '').slice(0, 2000),
          confidence: Math.max(0, Math.min(1, Number(payload?.confidence || 0))),
          evidence: Array.isArray(payload?.evidence) ? payload.evidence.slice(0, 48) : [],
          correctable: payload?.correctable === true,
          requiresUserAction: payload?.requiresUserAction === true,
          acceptanceSource: String(payload?.acceptanceSource || '').slice(0, 120),
          qualityWarning: payload?.qualityWarning === true,
          selectedSubmissionId: String(payload?.selectedSubmissionId || submissionId || '').slice(0, 200),
          selectedSubmissionNo: Math.max(0, Number(payload?.selectedSubmissionNo || 0)),
          occurredAt: String(payload?.occurredAt || now),
        };
        run(this.db, `UPDATE task_delivery_reviews SET state=?,quality_revision_count=?,quality_revision_limit=?,
          execution_attempt_count=?,latest_feedback_json=?,last_review_event_id=?,updated_at=?,terminal_at=? WHERE task_run_id=?`, [
          transition.review.state, transition.review.qualityRevisionCount, transition.review.maxQualityRevisions,
          transition.review.executionAttemptCount, JSON.stringify(latestFeedback), eventId, now, terminalAt, taskRunId,
        ]);
        return {
          ...transition,
          review: this.getTaskDeliveryReview(taskRunId),
          event: normalizeReviewEventRow(get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId])),
        };
      });
    },

    recordTaskDeliveryReviewExecutionFailure({ taskRunId = '', submissionId = '', eventId = '', error = '' } = {}) {
      if (!taskRunId || !eventId) throw reviewStoreError('delivery_review_execution_event_required', 'Review execution failure requires an event id.');
      return withImmediateTransaction(this, () => {
        const current = this.ensureTaskDeliveryReview({ taskRunId });
        const payload = { error: String(error || '').slice(0, 2000) };
        const payloadJson = JSON.stringify(payload);
        const payloadHash = reviewEventFingerprint({ taskRunId, submissionId, eventType: 'execution_failed', payload });
        const existing = get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId]);
        if (existing) {
          if (existing.task_run_id !== taskRunId || existing.submission_id !== String(submissionId || '')
            || existing.event_type !== 'execution_failed' || existing.payload_hash !== payloadHash) {
            throw reviewStoreError('delivery_review_event_payload_conflict', `Review event ${eventId} was replayed with different content.`);
          }
          return { duplicate: true, review: this.getTaskDeliveryReview(taskRunId) };
        }
        const now = nowIso();
        run(this.db, `INSERT INTO task_delivery_review_events(
          event_id,task_run_id,submission_id,event_type,from_state,to_state,payload_hash,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`, [
          eventId, taskRunId, String(submissionId || ''), 'execution_failed', current.state, current.state,
          payloadHash, payloadJson, now,
        ]);
        run(this.db, `UPDATE task_delivery_reviews SET execution_attempt_count=execution_attempt_count+1,
          last_review_event_id=?,updated_at=? WHERE task_run_id=?`, [eventId, now, taskRunId]);
        return { duplicate: false, review: this.getTaskDeliveryReview(taskRunId) };
      });
    },

    listTaskDeliveryReviewEvents(taskRunId = '') {
      return all(this.db, `SELECT * FROM task_delivery_review_events WHERE task_run_id=? ORDER BY created_at,event_id`, [taskRunId])
        .map(normalizeReviewEventRow);
    },

    recordOwnerDeliveryRevisionRequest({
      taskRunId = '', submissionId = '', eventId = '', summary = '', occurredAt = '', actorId = '',
    } = {}) {
      if (!taskRunId || !submissionId || !eventId) {
        throw reviewStoreError('delivery_revision_identity_required', 'Delivery revision history requires task, submission, and event ids.');
      }
      return withImmediateTransaction(this, () => {
        const submission = this.getTaskDeliverySubmission(submissionId);
        if (!submission || submission.taskRunId !== taskRunId) {
          throw reviewStoreError('delivery_revision_submission_invalid', 'The selected delivery version does not belong to this task.');
        }
        const current = this.ensureTaskDeliveryReview({ taskRunId });
        const payload = {
          summary: String(summary || '').slice(0, 2000),
          actorId: String(actorId || '').slice(0, 200),
          selectedSubmissionId: submission.id,
          selectedSubmissionNo: submission.submissionNo,
          occurredAt: String(occurredAt || nowIso()),
        };
        const payloadJson = JSON.stringify(payload);
        const eventType = 'owner_revision_requested';
        const payloadHash = reviewEventFingerprint({ taskRunId, submissionId, eventType, payload });
        const existing = get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId]);
        if (existing) {
          if (existing.task_run_id !== taskRunId || existing.submission_id !== submissionId
            || existing.event_type !== eventType || existing.payload_hash !== payloadHash) {
            throw reviewStoreError('delivery_review_event_payload_conflict', `Review event ${eventId} was replayed with different content.`);
          }
          return { duplicate: true, event: normalizeReviewEventRow(existing) };
        }
        run(this.db, `INSERT INTO task_delivery_review_events(
          event_id,task_run_id,submission_id,event_type,from_state,to_state,payload_hash,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`, [
          eventId, taskRunId, submissionId, eventType, current.state, current.state,
          payloadHash, payloadJson, payload.occurredAt,
        ]);
        return {
          duplicate: false,
          event: normalizeReviewEventRow(get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId])),
        };
      });
    },

    settleTaskDeliveryReviewAcceptance({
      taskRunId = '', submissionId = '', eventId = '', eventType = 'owner_accepted', payload = {},
    } = {}) {
      if (!taskRunId || !submissionId || !eventId) {
        throw reviewStoreError('delivery_acceptance_identity_required', 'Delivery acceptance requires task, submission, and event ids.');
      }
      return withImmediateTransaction(this, () => {
        const submission = this.getTaskDeliverySubmission(submissionId);
        if (!submission || submission.taskRunId !== taskRunId) {
          throw reviewStoreError('delivery_acceptance_submission_invalid', 'The selected delivery version does not belong to this task.');
        }
        const existingEvent = get(this.db, 'SELECT * FROM task_delivery_review_events WHERE event_id=?', [eventId]);
        if (existingEvent) {
          if (existingEvent.task_run_id !== taskRunId || existingEvent.submission_id !== submissionId
            || existingEvent.event_type !== eventType) {
            throw reviewStoreError('delivery_review_event_payload_conflict', `Review event ${eventId} was replayed for a different acceptance.`);
          }
          return {
            changed: false,
            duplicate: true,
            action: eventType,
            submission,
            review: this.getTaskDeliveryReview(taskRunId),
          };
        }
        const current = this.ensureTaskDeliveryReview({ taskRunId });
        const transition = this.transitionTaskDeliveryReview({
          taskRunId,
          submissionId,
          eventId,
          eventType,
          payload: {
            failureCodes: current.failureCodes || [],
            failedChecks: current.failedChecks || [],
            requiredChanges: current.requiredChanges || [],
            preservedRequirements: current.preservedRequirements || [],
            ...payload,
            selectedSubmissionId: submission.id,
            selectedSubmissionNo: submission.submissionNo,
          },
        });
        if (!transition.duplicate && !['owner_accepted', 'revision_limit_delivered'].includes(transition.action)) {
          throw reviewStoreError('delivery_acceptance_transition_invalid', `Delivery acceptance cannot continue from ${current.state}.`);
        }
        const now = nowIso();
        run(this.db, `UPDATE task_delivery_reviews SET latest_submission_id=?,updated_at=? WHERE task_run_id=?`, [
          submission.id, now, taskRunId,
        ]);
        run(this.db, `UPDATE task_delivery_review_jobs SET status='cancelled',claimed_by='',claimed_at='',lease_expires_at='',
          next_attempt_at='',last_error='superseded by delivery acceptance',updated_at=?,completed_at=?
          WHERE task_run_id=? AND status IN ('pending','claimed','retry_wait','action_required')`, [now, now, taskRunId]);
        return {
          changed: transition.changed,
          duplicate: transition.duplicate,
          action: transition.action,
          submission: this.getTaskDeliverySubmission(submission.id),
          review: this.getTaskDeliveryReview(taskRunId),
        };
      });
    },

    enqueueTaskDeliveryReviewJob({ taskRunId = '', submissionId = '', payload = {}, maxAttempts = 3 } = {}) {
      if (!taskRunId || !submissionId) throw reviewStoreError('delivery_review_job_identity_required', 'Delivery review job identity is incomplete.');
      return withImmediateTransaction(this, () => {
        const idempotencyKey = `delivery-review:${taskRunId}:${submissionId}`;
        const existing = normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE idempotency_key=?', [idempotencyKey]));
        const normalizedPayload = payload || {};
        const normalizedMaxAttempts = Math.max(1, Math.min(10, Number(maxAttempts || 3)));
        if (existing) {
          if (existing.taskRunId !== taskRunId || existing.submissionId !== submissionId
            || stableJson(existing.payload) !== stableJson(normalizedPayload)
            || existing.maxAttempts !== normalizedMaxAttempts) {
            throw reviewStoreError('delivery_review_job_payload_conflict', 'Delivery review job identity was replayed with different content.');
          }
          return existing;
        }
        const id = newId('delivery_review_job');
        run(this.db, `INSERT INTO task_delivery_review_jobs(
          id,task_run_id,submission_id,idempotency_key,status,payload_json,max_attempts
        ) VALUES(?,?,?,?,'pending',?,?)`, [
          id, taskRunId, submissionId, idempotencyKey, JSON.stringify(normalizedPayload), normalizedMaxAttempts,
        ]);
        return normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE id=?', [id]));
      });
    },

    claimPendingTaskDeliveryReviewJobs({ workerId = '', leaseMs = 180_000, limit = 5, now = Date.now() } = {}) {
      const nowText = isoAt(now);
      const claimed = [];
      return withImmediateTransaction(this, () => {
        run(this.db, `UPDATE task_delivery_review_jobs SET status='retry_wait',claimed_by='',claimed_at='',lease_expires_at='',
          next_attempt_at='',last_error='review lease expired',updated_at=?
          WHERE status='claimed' AND lease_expires_at!='' AND lease_expires_at<=?`, [nowText, nowText]);
        const due = all(this.db, `SELECT id FROM task_delivery_review_jobs
          WHERE status IN ('pending','retry_wait') AND (next_attempt_at='' OR next_attempt_at<=?)
          ORDER BY created_at,id LIMIT ?`, [nowText, boundedRows(limit)]);
        for (const row of due) {
          const leaseExpiresAt = isoAt(timestampMs(now) + Math.max(30_000, Number(leaseMs || 180_000)));
          const result = run(this.db, `UPDATE task_delivery_review_jobs SET status='claimed',claimed_by=?,claimed_at=?,
            lease_expires_at=?,attempt_count=attempt_count+1,next_attempt_at='',last_error='',updated_at=?
            WHERE id=? AND status IN ('pending','retry_wait')`, [workerId || 'delivery-review-worker', nowText, leaseExpiresAt, nowText, row.id]);
          if (Number(result?.changes || 0)) claimed.push(normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE id=?', [row.id])));
        }
        return claimed;
      });
    },

    completeTaskDeliveryReviewJob({ jobId = '', status = 'completed', error = '' } = {}) {
      if (!REVIEW_JOB_STATUSES.has(status) || !['completed', 'action_required', 'cancelled'].includes(status)) {
        throw reviewStoreError('delivery_review_job_status_invalid', `Invalid terminal review job status: ${status}`);
      }
      const now = nowIso();
      run(this.db, `UPDATE task_delivery_review_jobs SET status=?,claimed_by='',claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error=?,updated_at=?,completed_at=? WHERE id=?`, [
        status, String(error || '').slice(0, 2000), now, now, jobId,
      ]);
      return normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE id=?', [jobId]));
    },

    failTaskDeliveryReviewJob({ jobId = '', error = '' } = {}) {
      return withImmediateTransaction(this, () => {
        const current = normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE id=?', [jobId]));
        if (!current || ['completed', 'action_required', 'cancelled'].includes(current.status)) return current;
        const exhausted = current.attemptCount >= current.maxAttempts;
        const status = exhausted ? 'action_required' : 'retry_wait';
        const now = nowIso();
        const nextAttemptAt = exhausted ? '' : isoAt(Date.now() + reviewRetryDelayMs(current.attemptCount));
        run(this.db, `UPDATE task_delivery_review_jobs SET status=?,claimed_by='',claimed_at='',lease_expires_at='',
          next_attempt_at=?,last_error=?,updated_at=?,completed_at=? WHERE id=?`, [
          status, nextAttemptAt, String(error || '').slice(0, 2000), now, exhausted ? now : '', jobId,
        ]);
        return normalizeReviewJobRow(get(this.db, 'SELECT * FROM task_delivery_review_jobs WHERE id=?', [jobId]));
      });
    },

    listTaskDeliveryReviewJobs({ taskRunId = '', statuses = [], limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (taskRunId) { where.push('task_run_id=?'); params.push(taskRunId); }
      const requested = [...new Set((Array.isArray(statuses) ? statuses : []).map(String).filter((item) => REVIEW_JOB_STATUSES.has(item)))];
      if (requested.length) { where.push(`status IN (${requested.map(() => '?').join(',')})`); params.push(...requested); }
      params.push(boundedRows(limit));
      return all(this.db, `SELECT * FROM task_delivery_review_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at,id LIMIT ?`, params).map(normalizeReviewJobRow);
    },

    markUBuddyDeliveryReviewAwakened({ taskRunId = '', submissionId = '' } = {}) {
      return withImmediateTransaction(this, () => {
        const current = this.getUBuddyCoordinationState?.(taskRunId);
        if (!current || current.state === 'awakened') return current;
        if (!['planning', 'waiting_for_agents', 'sleeping'].includes(current.state)) return current;
        const now = nowIso();
        run(this.db, `UPDATE ubuddy_coordination_states SET state='awakened',awakened_at=?,delivering_at='',terminal_at='',
          state_revision=state_revision+1,updated_at=? WHERE task_run_id=?`, [now, now, taskRunId]);
        this.recordTaskEvent?.({
          taskRunId,
          eventType: 'ubuddy_awakened_for_delivery_review',
          actorId: 'task_leader',
          summary: 'The task leader submitted a delivery and awakened uBuddy for model review.',
          payload: { submissionId },
        });
        return this.getUBuddyCoordinationState?.(taskRunId) || null;
      });
    },
  });
}

function normalizeReviewRow(row) {
  if (!row) return null;
  const feedback = safeJsonParse(row.latest_feedback_json, {});
  return {
    ...normalizeDeliveryReviewPolicy({
    version: row.policy_version,
    state: row.state,
    maxQualityRevisions: Number(row.quality_revision_limit || DEFAULT_MAX_QUALITY_REVISIONS),
    qualityRevisionCount: Number(row.quality_revision_count || 0),
    executionAttemptCount: Number(row.execution_attempt_count || 0),
    lastReviewEventId: row.last_review_event_id || '',
    failureCodes: feedback.failureCodes || [],
    failedChecks: feedback.failedChecks || [],
    requiredChanges: feedback.requiredChanges || [],
    preservedRequirements: feedback.preservedRequirements || [],
    revisionNumber: Number(feedback.revisionNumber ?? row.quality_revision_count ?? 0),
    updatedAt: row.updated_at || '',
    }),
    taskRunId: row.task_run_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    latestSubmissionId: row.latest_submission_id || '',
    latestFeedback: feedback,
    acceptanceSource: String(feedback.acceptanceSource || ''),
    qualityWarning: feedback.qualityWarning === true,
    selectedSubmissionId: String(feedback.selectedSubmissionId || row.latest_submission_id || ''),
    selectedSubmissionNo: Math.max(0, Number(feedback.selectedSubmissionNo || 0)),
    createdAt: row.created_at || '',
    terminalAt: row.terminal_at || '',
  };
}

function normalizeSubmissionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    taskNodeId: row.task_node_id || '',
    resultVersionId: row.result_version_id || '',
    submissionKey: row.submission_key,
    submissionNo: Number(row.submission_no || 0),
    bodySnapshot: row.body_snapshot || '',
    evidence: safeJsonParse(row.evidence_json, {}),
    artifactManifest: safeJsonParse(row.artifact_manifest_json, []),
    createdAt: row.created_at || '',
  };
}

function normalizeReviewEventRow(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    taskRunId: row.task_run_id,
    submissionId: row.submission_id || '',
    eventType: row.event_type,
    fromState: row.from_state || '',
    toState: row.to_state || '',
    payloadHash: row.payload_hash || '',
    payload: safeJsonParse(row.payload_json, {}),
    createdAt: row.created_at || '',
  };
}

function normalizeReviewJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    submissionId: row.submission_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    payload: safeJsonParse(row.payload_json, {}),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    claimedBy: row.claimed_by || '',
    claimedAt: row.claimed_at || '',
    leaseExpiresAt: row.lease_expires_at || '',
    nextAttemptAt: row.next_attempt_at || '',
    lastError: row.last_error || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    completedAt: row.completed_at || '',
  };
}

function reviewFeedback(review = {}) {
  return {
    failureCodes: review.failureCodes || [],
    failedChecks: review.failedChecks || [],
    requiredChanges: review.requiredChanges || [],
    preservedRequirements: review.preservedRequirements || [],
    revisionNumber: Number(review.qualityRevisionCount || review.revisionNumber || 0),
    revisionLimit: Number(review.maxQualityRevisions || review.revisionLimit || DEFAULT_MAX_QUALITY_REVISIONS),
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

function boundedLimit(value) {
  return Math.max(1, Math.min(20, Number(value || DEFAULT_MAX_QUALITY_REVISIONS)));
}

function boundedRows(value) {
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

function reviewRetryDelayMs(attemptCount) {
  return Math.min(5 * 60_000, 2_000 * (2 ** Math.min(7, Math.max(0, Number(attemptCount || 1) - 1))));
}

function submissionFingerprint(value = {}) {
  return sha256Text(stableJson({
    taskRunId: String(value.taskRunId || ''),
    taskNodeId: String(value.taskNodeId || ''),
    resultVersionId: String(value.resultVersionId || ''),
    bodySnapshot: String(value.bodySnapshot || ''),
    evidence: value.evidence || {},
    artifactManifest: Array.isArray(value.artifactManifest) ? value.artifactManifest : [],
  }));
}

function reviewEventFingerprint({ taskRunId = '', submissionId = '', eventType = '', payload = {} } = {}) {
  const stablePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
  delete stablePayload.occurredAt;
  delete stablePayload.occurred_at;
  return sha256Text(stableJson({
    taskRunId: String(taskRunId || ''),
    submissionId: String(submissionId || ''),
    eventType: String(eventType || ''),
    payload: stablePayload,
  }));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function reviewStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
