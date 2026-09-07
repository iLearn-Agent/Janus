import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

export function installAgentWorkQueueStoreMethods(prototype) {
  Object.assign(prototype, {
    enqueueAgentWork({ userId = '', agentInstanceId = '', workKind = '', workId = '', payload = {}, workspaceId = '' } = {}) {
      if (!userId || !agentInstanceId || !workKind || !workId) throw new Error('Agent work queue identity is incomplete.');
      const existing = get(this.db, 'SELECT * FROM agent_work_queue WHERE work_kind = ? AND work_id = ?', [workKind, workId]);
      if (existing && !['completed', 'failed', 'cancelled'].includes(existing.status)) return normalizeAgentWork(existing);
      if (existing) run(this.db, 'DELETE FROM agent_work_queue WHERE id = ?', [existing.id]);
      const id = newId('agentwork');
      const now = nowIso();
      const resolvedWorkspaceId = resolveQueuedWorkWorkspace(this, { userId, workKind, workId, payload, workspaceId });
      run(this.db, `INSERT INTO agent_work_queue (
        id, account_workspace_id, user_id, agent_instance_id, work_kind, work_id, status, payload_json, enqueued_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, [
        id, resolvedWorkspaceId, userId, agentInstanceId, workKind, workId,
        JSON.stringify({ ...(payload || {}), accountWorkspaceId: resolvedWorkspaceId }), now, now,
      ]);
      return this.getAgentWork(id);
    },

    getAgentWork(id = '') {
      return normalizeAgentWork(get(this.db, 'SELECT * FROM agent_work_queue WHERE id = ?', [id]));
    },

    findAgentWork({ workKind = '', workId = '' } = {}) {
      return normalizeAgentWork(get(this.db, 'SELECT * FROM agent_work_queue WHERE work_kind = ? AND work_id = ?', [workKind, workId]));
    },

    listAgentWorkQueue({ userId = '', agentInstanceId = '', statuses = [], limit = 100, workspaceId = '', allWorkspaces = false } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (userId) { where.push('user_id = ?'); params.push(userId); }
      if (userId && !allWorkspaces) {
        where.push('account_workspace_id = ?');
        params.push(this.resolveAccountWorkspaceId?.({ userId, workspaceId }) || 'workspace_personal');
      }
      if (agentInstanceId) { where.push('agent_instance_id = ?'); params.push(agentInstanceId); }
      const cleanStatuses = (Array.isArray(statuses) ? statuses : []).filter(Boolean);
      if (cleanStatuses.length) {
        where.push(`status IN (${cleanStatuses.map(() => '?').join(',')})`);
        params.push(...cleanStatuses);
      }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM agent_work_queue WHERE ${where.join(' AND ')}
        ORDER BY sequence_no ASC LIMIT ?`, params).map(normalizeAgentWork);
    },

    claimAgentWork({ id = '', agentInstanceId = '' } = {}) {
      const work = this.getAgentWork(id);
      if (!work || work.status !== 'queued' || (agentInstanceId && work.agentInstanceId !== agentInstanceId)) return null;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const running = get(this.db, "SELECT id FROM agent_work_queue WHERE agent_instance_id = ? AND status = 'running'", [work.agentInstanceId]);
        const reservation = get(this.db, `SELECT task_run_id FROM agent_work_reservations
          WHERE agent_instance_id=? AND status='active' LIMIT 1`, [work.agentInstanceId]);
        const reservedTaskRunId = String(reservation?.task_run_id || '');
        const next = reservedTaskRunId
          ? get(this.db, `SELECT id FROM agent_work_queue WHERE agent_instance_id=? AND status='queued'
              AND work_kind='task_node' AND json_extract(payload_json,'$.taskRunId')=?
              ORDER BY sequence_no ASC LIMIT 1`, [work.agentInstanceId, reservedTaskRunId])
          : get(this.db, "SELECT id FROM agent_work_queue WHERE agent_instance_id = ? AND status = 'queued' ORDER BY sequence_no ASC LIMIT 1", [work.agentInstanceId]);
        if (running || next?.id !== work.id) {
          this.db.exec('COMMIT');
          return null;
        }
        const now = nowIso();
        const updated = run(this.db, `UPDATE agent_work_queue SET status = 'running', started_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'`, [now, now, work.id]);
        this.db.exec('COMMIT');
        return Number(updated?.changes || 0) === 1 ? this.getAgentWork(work.id) : null;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    },

    finishAgentWork({ id = '', status = 'completed', errorText = '' } = {}) {
      if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error(`Invalid Agent work terminal status: ${status}`);
      const now = nowIso();
      run(this.db, `UPDATE agent_work_queue SET status = ?, error_text = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [
        status, String(errorText || ''), now, now, id,
      ]);
      return this.getAgentWork(id);
    },

    interruptAgentWork({ id = '', reason = 'runtime_shutdown_resume' } = {}) {
      const work = this.getAgentWork(id);
      if (!work || !['queued', 'running'].includes(work.status)) return work || null;
      const now = nowIso();
      run(this.db, `UPDATE agent_work_queue SET status='queued', started_at='', completed_at='', error_text=?, updated_at=?
        WHERE id=? AND status IN ('queued','running')`, [String(reason || 'runtime_shutdown_resume'), now, id]);
      return this.getAgentWork(id);
    },

    cancelAgentWork({ id = '', reason = 'cancelled_by_user' } = {}) {
      const work = this.getAgentWork(id);
      if (!work || work.status !== 'queued') return work;
      return this.finishAgentWork({ id, status: 'cancelled', errorText: reason });
    },

    cancelQueuedAgentWork({ agentInstanceId = '', reason = 'employee_deactivated' } = {}) {
      if (!agentInstanceId) return 0;
      const now = nowIso();
      const result = run(this.db, `UPDATE agent_work_queue SET status = 'cancelled', error_text = ?, completed_at = ?, updated_at = ?
        WHERE agent_instance_id = ? AND status = 'queued'`, [reason, now, now, agentInstanceId]);
      return Number(result?.changes || 0);
    },

    recoverAgentWorkQueue() {
      const now = nowIso();
      const cancelledChats = run(this.db, `UPDATE agent_work_queue SET status = 'cancelled', error_text = 'runtime_restarted',
        completed_at = ?, updated_at = ? WHERE work_kind = 'chat' AND status IN ('queued','running')`, [now, now]);
      const requeuedDurable = run(this.db, `UPDATE agent_work_queue SET status = 'queued', started_at = '', completed_at = '',
        error_text = CASE WHEN status = 'running' THEN 'runtime_restarted_resume' ELSE error_text END, updated_at = ?
        WHERE work_kind IN ('task_node','ubuddy_agent_message','ubuddy_workspace_message','ubuddy_task_supplement') AND status IN ('queued','running')`, [now]);
      return {
        cancelledChats: Number(cancelledChats?.changes || 0),
        requeuedTasks: Number(requeuedDurable?.changes || 0),
        requeuedDurable: Number(requeuedDurable?.changes || 0),
      };
    },
  });
}

function normalizeAgentWork(row) {
  if (!row) return null;
  return {
    id: row.id,
    sequenceNo: Number(row.sequence_no || 0),
    userId: row.user_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    agentInstanceId: row.agent_instance_id,
    workKind: row.work_kind,
    workId: row.work_id,
    status: row.status,
    payload: safeJsonParse(row.payload_json, {}),
    errorText: row.error_text || '',
    enqueuedAt: row.enqueued_at || '',
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
    updatedAt: row.updated_at || '',
  };
}

function resolveQueuedWorkWorkspace(store, { userId, workKind, workId, payload, workspaceId }) {
  const explicit = workspaceId || payload?.accountWorkspaceId || payload?.workspaceId;
  if (explicit) return store.resolveAccountWorkspaceId?.({ userId, workspaceId: explicit }) || 'workspace_personal';
  if (workKind === 'task_node') {
    const task = get(store.db, `SELECT task.account_workspace_id FROM task_nodes node
      JOIN task_runs task ON task.id=node.task_run_id WHERE node.id=?`, [workId]);
    if (task?.account_workspace_id) return task.account_workspace_id;
  }
  const receipt = get(store.db, 'SELECT account_workspace_id FROM agent_delivery_receipts WHERE work_id=?', [workId]);
  if (receipt?.account_workspace_id) return receipt.account_workspace_id;
  return store.resolveAccountWorkspaceId?.({ userId }) || 'workspace_personal';
}
