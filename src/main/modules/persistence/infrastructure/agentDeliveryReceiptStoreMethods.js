import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

export function installAgentDeliveryReceiptStoreMethods(prototype) {
  Object.assign(prototype, {
    createAgentDeliveryReceipt({
      userId = '', sourceSessionId = '', targetSessionId = '', targetAgentInstanceId = '',
      requestMessageId = '', workId = '', status = 'queued', metadata = {},
      workspaceId = '',
    } = {}) {
      if (!userId || !sourceSessionId || !targetSessionId || !targetAgentInstanceId || !workId) {
        throw new Error('Agent delivery receipt identity is incomplete.');
      }
      const existing = this.getAgentDeliveryReceiptByWorkId(workId);
      if (existing) return existing;
      const id = newId('delivery');
      const now = nowIso();
      const sourceSession = this.getSession?.(sourceSessionId);
      const targetSession = this.getSession?.(targetSessionId);
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({
        userId, workspaceId: workspaceId || sourceSession?.workspaceId || sourceSession?.accountWorkspaceId,
      }) || 'workspace_personal';
      if (!sourceSession || !targetSession || sourceSession.accountWorkspaceId !== resolvedWorkspaceId
        || targetSession.accountWorkspaceId !== resolvedWorkspaceId) throw new Error('Agent delivery workspace mismatch.');
      run(this.db, `INSERT INTO agent_delivery_receipts (
        id,account_workspace_id,user_id,source_session_id,target_session_id,target_agent_instance_id,request_message_id,
        target_message_id,source_notification_message_id,work_id,delivery_status,read_status,metadata_json,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'','',?,?,'read',?,?,?)`, [
        id, resolvedWorkspaceId, userId, sourceSessionId, targetSessionId, targetAgentInstanceId, requestMessageId,
        workId, normalizeDeliveryStatus(status), JSON.stringify(metadata || {}), now, now,
      ]);
      return this.getAgentDeliveryReceipt(id);
    },

    getAgentDeliveryReceipt(id = '') {
      return normalizeAgentDeliveryReceipt(get(this.db, 'SELECT * FROM agent_delivery_receipts WHERE id=?', [id]));
    },

    getAgentDeliveryReceiptByWorkId(workId = '') {
      return normalizeAgentDeliveryReceipt(get(this.db, 'SELECT * FROM agent_delivery_receipts WHERE work_id=?', [workId]));
    },

    completeAgentDeliveryReceipt({
      workId = '', targetMessageId = '', sourceNotificationMessageId = '', status = 'completed', metadata = {},
    } = {}) {
      const current = this.getAgentDeliveryReceiptByWorkId(workId);
      if (!current) return null;
      const now = nowIso();
      run(this.db, `UPDATE agent_delivery_receipts SET target_message_id=?,source_notification_message_id=?,
        delivery_status=?,read_status='unread',metadata_json=?,delivered_at=?,updated_at=? WHERE work_id=?`, [
        targetMessageId || current.targetMessageId, sourceNotificationMessageId || current.sourceNotificationMessageId,
        normalizeDeliveryStatus(status), JSON.stringify({ ...(current.metadata || {}), ...(metadata || {}) }),
        current.deliveredAt || now, now, workId,
      ]);
      return this.getAgentDeliveryReceiptByWorkId(workId);
    },

    recordAgentDeliveryEvent({ workId = '', event = {}, status = 'running', metadata = {} } = {}) {
      const current = this.getAgentDeliveryReceiptByWorkId(workId);
      if (!current) return null;
      const now = nowIso();
      const sequenceNo = Number(get(this.db, 'SELECT COALESCE(MAX(sequence_no),0)+1 AS next FROM agent_delivery_events WHERE work_id=?', [workId])?.next || 1);
      const normalized = normalizeDeliveryEvent(event, sequenceNo, now);
      run(this.db, `INSERT INTO agent_delivery_events(id,work_id,sequence_no,kind,stage,message,payload_json,created_at)
        VALUES(?,?,?,?,?,?,?,?)`, [
        newId('delivery_event'), workId, sequenceNo, normalized.kind, normalized.stage,
        normalized.message, JSON.stringify(normalized.payload), normalized.createdAt,
      ]);
      const nextStatus = normalizeDeliveryStatus(status || current.deliveryStatus);
      const nextMetadata = {
        ...(current.metadata || {}),
        ...(metadata || {}),
        startedAt: current.metadata?.startedAt || normalized.createdAt,
        lastProgressAt: normalized.createdAt,
        lastSequence: sequenceNo,
        lastKind: normalized.kind,
        lastStage: normalized.stage,
        lastMessage: normalized.message,
      };
      run(this.db, `UPDATE agent_delivery_receipts SET delivery_status=?,metadata_json=?,updated_at=? WHERE work_id=?`, [
        nextStatus, JSON.stringify(nextMetadata), now, workId,
      ]);
      return {
        receipt: this.getAgentDeliveryReceiptByWorkId(workId),
        event: normalized,
      };
    },

    listAgentDeliveryEvents({ workId = '', limit = 200 } = {}) {
      if (!workId) return [];
      return all(this.db, `SELECT * FROM agent_delivery_events WHERE work_id=? ORDER BY sequence_no ASC LIMIT ?`, [
        workId, Math.max(1, Math.min(500, Number(limit || 200))),
      ]).map(normalizeDeliveryEventRow);
    },

    listAgentDeliveryRuns({ userId = '', sessionId = '', statuses = [], limit = 100, workspaceId = '', allWorkspaces = false } = {}) {
      const where = ['1=1'];
      const params = [];
      if (userId) { where.push('user_id=?'); params.push(userId); }
      if (userId && !allWorkspaces) { where.push('account_workspace_id=?'); params.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal'); }
      if (sessionId) { where.push('(source_session_id=? OR target_session_id=?)'); params.push(sessionId, sessionId); }
      const requestedStatuses = Array.isArray(statuses) ? statuses : [];
      const normalizedStatuses = [...new Set(requestedStatuses.map((status) => String(status || '')).filter(isDeliveryStatus))];
      if (requestedStatuses.length && !normalizedStatuses.length) return [];
      if (normalizedStatuses.length) {
        where.push(`delivery_status IN (${normalizedStatuses.map(() => '?').join(',')})`);
        params.push(...normalizedStatuses);
      }
      params.push(Math.max(1, Math.min(200, Number(limit || 100))));
      return all(this.db, `SELECT * FROM agent_delivery_receipts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, params)
        .map(normalizeAgentDeliveryReceipt)
        .map((receipt) => ({ ...receipt, events: this.listAgentDeliveryEvents({ workId: receipt.workId, limit: 200 }) }));
    },

    listAgentDeliveryReceipts({ userId = '', targetSessionId = '', readStatus = '', limit = 100, workspaceId = '', allWorkspaces = false } = {}) {
      const where = ['1=1'];
      const params = [];
      if (userId) { where.push('user_id=?'); params.push(userId); }
      if (userId && !allWorkspaces) { where.push('account_workspace_id=?'); params.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal'); }
      if (targetSessionId) { where.push('target_session_id=?'); params.push(targetSessionId); }
      if (readStatus) { where.push('read_status=?'); params.push(readStatus); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM agent_delivery_receipts WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC LIMIT ?`, params).map(normalizeAgentDeliveryReceipt);
    },

    markAgentDeliveriesRead({ userId = '', targetSessionId = '' } = {}) {
      if (!userId || !targetSessionId) return 0;
      const now = nowIso();
      const result = run(this.db, `UPDATE agent_delivery_receipts SET read_status='read',read_at=?,updated_at=?
        WHERE user_id=? AND target_session_id=? AND read_status='unread'`, [now, now, userId, targetSessionId]);
      return Number(result?.changes || 0);
    },

    unreadAgentDeliveryCounts({ userId = '', workspaceId = '' } = {}) {
      if (!userId) return {};
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal';
      return Object.fromEntries(all(this.db, `SELECT target_session_id,COUNT(*) AS unread_count
        FROM agent_delivery_receipts WHERE user_id=? AND account_workspace_id=? AND read_status='unread'
        AND delivery_status IN ('completed','failed') GROUP BY target_session_id`, [userId, resolvedWorkspaceId])
        .map((row) => [row.target_session_id, Number(row.unread_count || 0)]));
    },
  });
}

function normalizeDeliveryStatus(value = '') {
  return isDeliveryStatus(value) ? String(value) : 'queued';
}

function isDeliveryStatus(value = '') {
  return ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(value || ''));
}

function normalizeDeliveryEvent(event = {}, sequenceNo = 0, createdAt = '') {
  const kind = String(event.kind || event.type || 'progress');
  const stage = String(event.stage || (kind === 'start' ? 'queued' : 'working'));
  const message = String(event.message || event.content || event.detail || '').slice(0, 4000);
  return {
    sequenceNo: Number(sequenceNo || 0),
    kind,
    stage,
    message,
    payload: sanitizeDeliveryEventPayload(event),
    createdAt: createdAt || nowIso(),
  };
}

function normalizeDeliveryEventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workId: row.work_id,
    sequenceNo: Number(row.sequence_no || 0),
    kind: row.kind || 'progress',
    stage: row.stage || 'working',
    message: row.message || '',
    payload: safeJsonParse(row.payload_json, {}),
    createdAt: row.created_at || '',
  };
}

function sanitizeDeliveryEventPayload(event = {}) {
  const allowed = {};
  for (const key of ['activityId', 'activityType', 'status', 'title', 'detail', 'append', 'planStep', 'taskProgress', 'activeNodes', 'pptProgress', 'agentQueue', 'targetKind', 'agentId', 'departmentId', 'runId']) {
    if (Object.hasOwn(event, key)) allowed[key] = event[key];
  }
  return allowed;
}

function normalizeAgentDeliveryReceipt(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    sourceSessionId: row.source_session_id,
    targetSessionId: row.target_session_id,
    targetAgentInstanceId: row.target_agent_instance_id,
    requestMessageId: row.request_message_id || '',
    targetMessageId: row.target_message_id || '',
    sourceNotificationMessageId: row.source_notification_message_id || '',
    workId: row.work_id,
    deliveryStatus: row.delivery_status,
    readStatus: row.read_status,
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    deliveredAt: row.delivered_at || '',
    readAt: row.read_at || '',
  };
}
