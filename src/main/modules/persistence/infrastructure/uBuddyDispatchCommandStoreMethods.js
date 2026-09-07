import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { nowIso, safeJsonParse } from '../../../utils.js';

const RECOVERABLE_STATUSES = Object.freeze(['selection_saved', 'dispatching', 'retry_wait']);

export function installUBuddyDispatchCommandStoreMethods(prototype) {
  Object.assign(prototype, {
    reserveUBuddyDispatchCommand({ command = {}, accountWorkspaceId = '', ownerUserId = '', sourceSessionId = '', sourceMessageId = '', maxAttempts = 5 } = {}) {
      const commandId = String(command?.id || '').trim();
      if (!commandId || !ownerUserId) throw dispatchError('ubuddy_dispatch_command_invalid', 'Dispatch command id and owner are required.');
      const commandJson = JSON.stringify(command);
      const payloadHash = sha256(commandJson);
      const existing = this.getUBuddyDispatchCommand(commandId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw dispatchError('ubuddy_dispatch_idempotency_conflict', '派发命令 ID 已被不同请求占用。');
        return { command: existing, idempotent: true };
      }
      const now = nowIso();
      run(this.db, `INSERT INTO ubuddy_dispatch_commands(
        command_id,account_workspace_id,owner_user_id,source_session_id,source_message_id,command_version,
        status,payload_hash,command_json,max_attempts,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'selection_saved',?,?,?, ?,?)`, [
        commandId, String(accountWorkspaceId || 'workspace_personal'), ownerUserId, sourceSessionId, sourceMessageId,
        Math.max(3, Number(command.version || 3)), payloadHash, commandJson,
        Math.max(1, Math.min(10, Number(maxAttempts || 5))), now, now,
      ]);
      return { command: this.getUBuddyDispatchCommand(commandId), idempotent: false };
    },

    getUBuddyDispatchCommand(commandId = '') {
      return normalizeDispatchCommand(get(this.db, 'SELECT * FROM ubuddy_dispatch_commands WHERE command_id=?', [String(commandId || '')]));
    },

    replaceUBuddyDispatchCommand({ commandId = '', command = {} } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current) throw dispatchError('ubuddy_dispatch_command_missing', 'Dispatch command was not found.');
      if (!['selection_saved', 'dispatching', 'retry_wait'].includes(current.status)) {
        throw dispatchError('ubuddy_dispatch_command_not_replaceable', 'Dispatch command can no longer be updated.');
      }
      if (String(command?.id || '') !== String(commandId || '')) {
        throw dispatchError('ubuddy_dispatch_command_invalid', 'Replacement dispatch command identity does not match.');
      }
      const commandJson = JSON.stringify(command);
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET command_version=?,payload_hash=?,command_json=?,updated_at=?
        WHERE command_id=? AND status IN ('selection_saved','dispatching','retry_wait')`, [
        Math.max(3, Number(command.version || 3)), sha256(commandJson), commandJson, now, commandId,
      ]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    claimUBuddyDispatchCommand({ commandId = '', leaseMs = 120_000 } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current || ['published', 'clarification', 'failed', 'cancelled'].includes(current.status)) return current;
      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + Math.max(5_000, Number(leaseMs || 120_000))).toISOString();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='dispatching',
        attempt_count=attempt_count+CASE WHEN last_error='awaiting_recipient_presence' THEN 0 ELSE 1 END,
        claimed_at=?,lease_expires_at=?,next_attempt_at='',last_error='',updated_at=? WHERE command_id=?
        AND (status IN ('selection_saved','retry_wait') OR (status='dispatching' AND lease_expires_at<=?))`, [
        now, leaseExpiresAt, now, commandId, now,
      ]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    completeUBuddyDispatchCommand({ commandId = '', result = {} } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='published',result_json=?,claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error='',completed_at=?,updated_at=? WHERE command_id=?`, [JSON.stringify(result || {}), now, now, commandId]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    checkpointUBuddyDispatchCommand({ commandId = '', patch = {} } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current) throw dispatchError('ubuddy_dispatch_command_missing', 'Dispatch command was not found.');
      if (!['selection_saved', 'dispatching', 'retry_wait'].includes(current.status)) return current;
      const now = nowIso();
      const result = { ...(current.result || {}), ...(patch && typeof patch === 'object' ? patch : {}) };
      run(this.db, `UPDATE ubuddy_dispatch_commands SET result_json=?,updated_at=?
        WHERE command_id=? AND status IN ('selection_saved','dispatching','retry_wait')`, [JSON.stringify(result), now, commandId]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    clarifyUBuddyDispatchCommand({ commandId = '', result = {} } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='clarification',result_json=?,claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error='',completed_at=?,updated_at=? WHERE command_id=?`, [JSON.stringify(result || {}), now, now, commandId]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    reopenUBuddyDispatchCommand({ commandId = '', result = {} } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current || current.status !== 'clarification'
        || !['high_risk_confirmation_required', 'automatic_collaboration_plan_requires_confirmation']
          .includes(String(current.result?.reasonCode || ''))) return current;
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='selection_saved',result_json=?,claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error='',completed_at='',updated_at=? WHERE command_id=? AND status='clarification'`, [
        JSON.stringify(result || {}), now, commandId,
      ]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    failUBuddyDispatchCommand({ commandId = '', error = '', retryable = true, retryDelayMs = 0 } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current || ['published', 'clarification', 'failed', 'cancelled'].includes(current.status)) return current;
      const terminal = !retryable || current.attemptCount >= current.maxAttempts;
      const now = nowIso();
      const nextAttemptAt = terminal ? '' : new Date(Date.now() + Math.max(0, Number(retryDelayMs || 0))).toISOString();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status=?,claimed_at='',lease_expires_at='',next_attempt_at=?,
        last_error=?,updated_at=? WHERE command_id=?`, [terminal ? 'failed' : 'retry_wait', nextAttemptAt, String(error || '').slice(0, 4000), now, commandId]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    deferUBuddyDispatchCommand({ commandId = '', reason = 'awaiting_presence', retryDelayMs = 15_000 } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current || ['published', 'clarification', 'failed', 'cancelled'].includes(current.status)) return current;
      const now = nowIso();
      const nextAttemptAt = new Date(Date.now() + Math.max(1_000, Number(retryDelayMs || 15_000))).toISOString();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='retry_wait',claimed_at='',lease_expires_at='',
        next_attempt_at=?,last_error=?,updated_at=? WHERE command_id=?`, [
        nextAttemptAt, String(reason || 'awaiting_presence').slice(0, 4000), now, commandId,
      ]);
      return this.getUBuddyDispatchCommand(commandId);
    },

    recoverUBuddyDispatchCommands() {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='retry_wait',claimed_at='',lease_expires_at='',next_attempt_at=?,
        last_error=CASE WHEN last_error='' THEN 'Dispatch lease expired during restart recovery.' ELSE last_error END,updated_at=?
        WHERE status='dispatching' AND lease_expires_at<>'' AND lease_expires_at<=?`, [now, now, now]);
      return all(this.db, `SELECT * FROM ubuddy_dispatch_commands WHERE status IN (${RECOVERABLE_STATUSES.map(() => '?').join(',')})
        AND (next_attempt_at='' OR next_attempt_at<=?) ORDER BY created_at,command_id`, [...RECOVERABLE_STATUSES, now]).map(normalizeDispatchCommand);
    },

    initializePendingDispatchAssignments({ commandId = '', assignments = [] } = {}) {
      const now = nowIso();
      for (const [index, assignment] of (Array.isArray(assignments) ? assignments : []).entries()) {
        const recipientUserId = String(assignment?.recipientId || assignment?.userId || '').trim();
        if (!commandId || !recipientUserId) continue;
        const assignmentId = String(assignment?.assignmentId || assignment?.metadata?.assignmentId || `assignment_${index + 1}`).trim();
        run(this.db, `INSERT INTO ubuddy_pending_dispatch_assignments(
          command_id,assignment_id,recipient_user_id,status,created_at,updated_at
        ) VALUES(?,?,?,'awaiting_presence',?,?) ON CONFLICT(command_id,assignment_id) DO NOTHING`, [
          commandId, assignmentId, recipientUserId, now, now,
        ]);
      }
      return this.pendingDispatchAssignments(commandId);
    },

    pendingDispatchAssignments(commandId = '') {
      return all(this.db, `SELECT * FROM ubuddy_pending_dispatch_assignments WHERE command_id=?
        ORDER BY created_at,assignment_id`, [String(commandId || '')]).map(normalizePendingAssignment);
    },

    updatePendingDispatchAssignment({ commandId = '', assignmentId = '', status = '', delegationId, groupId, lastSeenAt, error } = {}) {
      const current = get(this.db, `SELECT * FROM ubuddy_pending_dispatch_assignments
        WHERE command_id=? AND assignment_id=?`, [commandId, assignmentId]);
      if (!current) return null;
      const nextStatus = ['awaiting_presence', 'publishing', 'published', 'cancelled', 'failed'].includes(String(status || ''))
        ? String(status) : current.status;
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_pending_dispatch_assignments SET status=?,delegation_id=?,group_id=?,last_seen_at=?,
        published_at=?,last_error=?,updated_at=? WHERE command_id=? AND assignment_id=?`, [
        nextStatus,
        delegationId === undefined ? current.delegation_id : String(delegationId || ''),
        groupId === undefined ? current.group_id : String(groupId || ''),
        lastSeenAt === undefined ? current.last_seen_at : String(lastSeenAt || ''),
        nextStatus === 'published' ? (current.published_at || now) : current.published_at,
        error === undefined ? current.last_error : String(error || '').slice(0, 4000),
        now, commandId, assignmentId,
      ]);
      return normalizePendingAssignment(get(this.db, `SELECT * FROM ubuddy_pending_dispatch_assignments
        WHERE command_id=? AND assignment_id=?`, [commandId, assignmentId]));
    },

    listPendingPresenceDispatchCommands({ ownerUserId = '' } = {}) {
      return all(this.db, `SELECT DISTINCT command.command_id FROM ubuddy_dispatch_commands command
        JOIN ubuddy_pending_dispatch_assignments assignment ON assignment.command_id=command.command_id
        WHERE assignment.status IN ('awaiting_presence','publishing') AND (?='' OR command.owner_user_id=?)
        ORDER BY command.created_at,command.command_id`, [ownerUserId, ownerUserId])
        .map((row) => this.getUBuddyDispatchCommand(row.command_id)).filter(Boolean);
    },

    expeditePendingPresenceDispatchCommands({ ownerUserId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_dispatch_commands AS command
        SET next_attempt_at='',updated_at=?
        WHERE command.status='retry_wait' AND command.last_error='awaiting_recipient_presence'
          AND (?='' OR command.owner_user_id=?)
          AND EXISTS (
            SELECT 1 FROM ubuddy_pending_dispatch_assignments assignment
            WHERE assignment.command_id=command.command_id
              AND assignment.status IN ('awaiting_presence','publishing')
          )`, [now, ownerUserId, ownerUserId]);
      return this.listPendingPresenceDispatchCommands({ ownerUserId });
    },

    cancelPendingDispatchAssignments({ commandId = '', assignmentId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_pending_dispatch_assignments SET status='cancelled',updated_at=?
        WHERE command_id=? AND status IN ('awaiting_presence','publishing')${assignmentId ? ' AND assignment_id=?' : ''}`, [
        now, commandId, ...(assignmentId ? [assignmentId] : []),
      ]);
      return this.pendingDispatchAssignments(commandId);
    },

    cancelUBuddyDispatchCommand({ commandId = '', reason = 'cancelled_by_owner' } = {}) {
      const current = this.getUBuddyDispatchCommand(commandId);
      if (!current || ['published', 'clarification', 'failed', 'cancelled'].includes(current.status)) return current;
      const now = nowIso();
      const result = { ...(current.result || {}), cancelledPendingDispatch: true, cancellationReason: String(reason || '') };
      run(this.db, `UPDATE ubuddy_dispatch_commands SET status='cancelled',result_json=?,claimed_at='',lease_expires_at='',
        next_attempt_at='',last_error=?,completed_at=?,updated_at=? WHERE command_id=?`, [
        JSON.stringify(result), String(reason || '').slice(0, 4000), now, now, commandId,
      ]);
      return this.getUBuddyDispatchCommand(commandId);
    },
  });
}

function normalizePendingAssignment(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    assignmentId: row.assignment_id,
    recipientUserId: row.recipient_user_id,
    status: row.status,
    delegationId: row.delegation_id || '',
    groupId: row.group_id || '',
    lastSeenAt: row.last_seen_at || '',
    publishedAt: row.published_at || '',
    lastError: row.last_error || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function normalizeDispatchCommand(row) {
  if (!row) return null;
  return {
    commandId: row.command_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    sourceSessionId: row.source_session_id || '',
    sourceMessageId: row.source_message_id || '',
    commandVersion: Number(row.command_version || 3),
    status: row.status || 'selection_saved',
    payloadHash: row.payload_hash || '',
    command: safeJsonParse(row.command_json, {}),
    result: safeJsonParse(row.result_json, {}),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 5),
    claimedAt: row.claimed_at || '',
    leaseExpiresAt: row.lease_expires_at || '',
    nextAttemptAt: row.next_attempt_at || '',
    lastError: row.last_error || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    completedAt: row.completed_at || '',
  };
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function dispatchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export { RECOVERABLE_STATUSES as UBUDDY_DISPATCH_RECOVERABLE_STATUSES };
