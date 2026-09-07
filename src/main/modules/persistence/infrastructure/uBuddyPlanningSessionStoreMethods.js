import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import { UBUDDY_PLANNING_STATUSES } from '../../../../shared/contracts/uBuddyPlanningSession.js';

const ACTIVE_STATUSES = new Set(['planning', 'awaiting_clarification', 'awaiting_confirmation', 'ready_to_dispatch', 'retryable_failure']);

export function installUBuddyPlanningSessionStoreMethods(prototype) {
  Object.assign(prototype, {
    createUBuddyPlanningSession({
      id = '', ownerUserId = '', accountWorkspaceId = '', sourceSessionId = '', sourceMessageId = '',
      codexThreadId = '', threadEpoch = 1, revision = 1, modelConfig = {}, plan = {}, status = 'planning', engineVersion = 'continuous_v1',
    } = {}) {
      if (!ownerUserId || !accountWorkspaceId || !sourceSessionId) {
        throw planningSessionError('ubuddy_planning_scope_incomplete', 'Planning session owner, Workspace, and source session are required.');
      }
      const planningSessionId = id || newId('ubuddy_planning_session');
      const existing = this.getUBuddyPlanningSession({ id: planningSessionId });
      if (existing) return existing;
      const now = nowIso();
      run(this.db, `INSERT INTO ubuddy_planning_sessions(
        id,owner_user_id,account_workspace_id,source_session_id,source_message_id,codex_thread_id,thread_epoch,
        revision,status,engine_version,model_config_json,plan_json,dispatch_json,last_error_json,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?,?)`, [
        planningSessionId, ownerUserId, accountWorkspaceId, sourceSessionId, sourceMessageId, codexThreadId,
        Math.max(1, Number(threadEpoch || 1)), Math.max(1, Number(revision || 1)), normalizeStatus(status), engineVersion,
        JSON.stringify(objectValue(modelConfig)), JSON.stringify(objectValue(plan)), '{}', now, now,
      ]);
      return this.getUBuddyPlanningSession({ id: planningSessionId });
    },

    getUBuddyPlanningSession({ id = '', ownerUserId = '', sourceSessionId = '', statuses = [] } = {}) {
      if (id) return normalizeRow(get(this.db, 'SELECT * FROM ubuddy_planning_sessions WHERE id=?', [id]));
      if (!ownerUserId || !sourceSessionId) return null;
      const accepted = normalizedStatuses(statuses);
      const where = accepted.length ? ` AND status IN (${accepted.map(() => '?').join(',')})` : '';
      return normalizeRow(get(this.db, `SELECT * FROM ubuddy_planning_sessions
        WHERE owner_user_id=? AND source_session_id=?${where} ORDER BY updated_at DESC,id DESC LIMIT 1`, [ownerUserId, sourceSessionId, ...accepted]));
    },

    findActiveUBuddyPlanningSession({ ownerUserId = '', sourceSessionId = '' } = {}) {
      return this.getUBuddyPlanningSession({ ownerUserId, sourceSessionId, statuses: [...ACTIVE_STATUSES] });
    },

    listUBuddyPlanningSessions({ ownerUserId = '', sourceSessionId = '', statuses = [], limit = 100 } = {}) {
      const clauses = [];
      const params = [];
      if (ownerUserId) { clauses.push('owner_user_id=?'); params.push(ownerUserId); }
      if (sourceSessionId) { clauses.push('source_session_id=?'); params.push(sourceSessionId); }
      const accepted = normalizedStatuses(statuses);
      if (accepted.length) { clauses.push(`status IN (${accepted.map(() => '?').join(',')})`); params.push(...accepted); }
      return all(this.db, `SELECT * FROM ubuddy_planning_sessions ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY updated_at DESC,id DESC LIMIT ?`, [...params, Math.max(1, Math.min(500, Number(limit || 100)))])
        .map(normalizeRow);
    },

    updateUBuddyPlanningSession({
      id = '', baseRevision = 0, status = '', plan = null, dispatch = null, codexThreadId = undefined,
      threadEpoch = 0, lastError = null, sourceMessageId = undefined,
    } = {}) {
      const current = this.getUBuddyPlanningSession({ id });
      if (!current) throw planningSessionError('ubuddy_planning_session_missing', `Planning session not found: ${id}`);
      if (Number(baseRevision) !== current.revision) {
        throw planningSessionError('ubuddy_planning_revision_conflict', `Expected planning revision ${baseRevision}; current revision is ${current.revision}.`);
      }
      const nextStatus = status ? normalizeStatus(status) : current.status;
      const nextRevision = current.revision + 1;
      const updated = run(this.db, `UPDATE ubuddy_planning_sessions SET
        source_message_id=?,codex_thread_id=?,thread_epoch=?,revision=?,status=?,plan_json=?,dispatch_json=?,last_error_json=?,updated_at=?
        WHERE id=? AND revision=?`, [
        sourceMessageId === undefined ? current.sourceMessageId : String(sourceMessageId || ''),
        codexThreadId === undefined ? current.codexThreadId : String(codexThreadId || ''),
        Math.max(1, Number(threadEpoch || current.threadEpoch || 1)), nextRevision, nextStatus,
        JSON.stringify(plan === null ? current.plan : objectValue(plan)),
        JSON.stringify(dispatch === null ? current.dispatch : objectValue(dispatch)),
        JSON.stringify(lastError === null ? current.lastError : objectValue(lastError)), nowIso(), id, current.revision,
      ]);
      if (!Number(updated?.changes || 0)) throw planningSessionError('ubuddy_planning_revision_conflict', 'Planning session changed concurrently.');
      return this.getUBuddyPlanningSession({ id });
    },

    recordUBuddyPlanningSessionEvent({
      planningSessionId = '', idempotencyKey = '', eventType = '', baseRevision = 0, resultRevision = 0, payload = {},
    } = {}) {
      if (!planningSessionId || !idempotencyKey || !eventType) {
        throw planningSessionError('ubuddy_planning_event_incomplete', 'Planning event identity is incomplete.');
      }
      const existing = this.getUBuddyPlanningSessionEvent({ planningSessionId, idempotencyKey });
      if (existing) return existing;
      const now = nowIso();
      try {
        run(this.db, `INSERT INTO ubuddy_planning_session_events(
          id,planning_session_id,idempotency_key,event_type,base_revision,result_revision,payload_json,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`, [newId('ubuddy_planning_event'), planningSessionId, idempotencyKey, eventType,
          Math.max(0, Number(baseRevision || 0)), Math.max(0, Number(resultRevision || 0)), JSON.stringify(objectValue(payload)), now]);
      } catch (error) {
        const duplicate = this.getUBuddyPlanningSessionEvent({ planningSessionId, idempotencyKey });
        if (duplicate) return duplicate;
        throw error;
      }
      return this.getUBuddyPlanningSessionEvent({ planningSessionId, idempotencyKey });
    },

    getUBuddyPlanningSessionEvent({ planningSessionId = '', idempotencyKey = '' } = {}) {
      if (!planningSessionId || !idempotencyKey) return null;
      return normalizeEvent(get(this.db, `SELECT * FROM ubuddy_planning_session_events
        WHERE planning_session_id=? AND idempotency_key=?`, [planningSessionId, idempotencyKey]));
    },
  });
}

function normalizeRow(row) {
  if (!row) return null;
  return {
    id: row.id, ownerUserId: row.owner_user_id, accountWorkspaceId: row.account_workspace_id,
    sourceSessionId: row.source_session_id, sourceMessageId: row.source_message_id,
    codexThreadId: row.codex_thread_id, threadEpoch: Number(row.thread_epoch || 1), revision: Number(row.revision || 1),
    status: row.status, engineVersion: row.engine_version, modelConfig: safeJsonParse(row.model_config_json, {}),
    plan: safeJsonParse(row.plan_json, {}), dispatch: safeJsonParse(row.dispatch_json, {}),
    lastError: safeJsonParse(row.last_error_json, {}), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeEvent(row) {
  if (!row) return null;
  return { id: row.id, planningSessionId: row.planning_session_id, idempotencyKey: row.idempotency_key,
    eventType: row.event_type, baseRevision: Number(row.base_revision || 0), resultRevision: Number(row.result_revision || 0),
    payload: safeJsonParse(row.payload_json, {}), createdAt: row.created_at };
}

function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (!UBUDDY_PLANNING_STATUSES.includes(status)) throw planningSessionError('ubuddy_planning_status_invalid', `Unsupported planning status: ${status}`);
  return status;
}
function normalizedStatuses(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter((item) => UBUDDY_PLANNING_STATUSES.includes(item)))]; }
function planningSessionError(code, message) { const error = new Error(message); error.code = code; return error; }
