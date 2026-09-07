const DEFAULT_TASK_UI_UPDATE_DELAY_MS = 250;
const MIN_TASK_UI_UPDATE_DELAY_MS = 100;
const MAX_TASK_UI_UPDATE_DELAY_MS = 1_000;

const COALESCIBLE_TASK_CHANGES = new Set([
  'node_activity',
  'node_progress',
  'node_heartbeat',
  'task_reconciled',
  'ubuddy_sleeping',
  'ubuddy_waiting_for_agents',
  'ubuddy_agents_allocated',
]);

const AVAILABILITY_TASK_CHANGES = new Set([
  'task_created',
  'node_queued',
  'node_running',
  'node_waiting',
  'node_blocked',
  'node_retry_scheduled',
  'node_retry_released',
  'node_completed',
  'node_failed',
  'node_cancelled',
  'task_finalized',
  'work_finished',
  'ubuddy_sleeping',
  'ubuddy_waiting_for_agents',
  'ubuddy_agents_allocated',
]);

export function taskUiUpdateDelayMs(env = process.env) {
  const configured = Number(env.JANUS_TASK_UI_UPDATE_DELAY_MS);
  if (!Number.isFinite(configured)) return DEFAULT_TASK_UI_UPDATE_DELAY_MS;
  return Math.max(MIN_TASK_UI_UPDATE_DELAY_MS, Math.min(MAX_TASK_UI_UPDATE_DELAY_MS, configured));
}

export function taskUpdateCanCoalesce(payload = {}) {
  const taskRunId = String(payload?.task?.id || payload?.taskRunId || payload?.task_run_id || '').trim();
  if (!taskRunId) return false;
  return COALESCIBLE_TASK_CHANGES.has(String(payload?.change?.type || ''));
}

export function taskUpdateAffectsAvailability(payload = {}) {
  return AVAILABILITY_TASK_CHANGES.has(String(payload?.change?.type || ''));
}

export function createTaskUiUpdatePublisher({
  delayMs = DEFAULT_TASK_UI_UPDATE_DELAY_MS,
  publish,
  onFlush = null,
  onError = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof publish !== 'function') throw new Error('Task UI update publisher requires a publish callback.');
  const waitMs = Math.max(MIN_TASK_UI_UPDATE_DELAY_MS, Math.min(MAX_TASK_UI_UPDATE_DELAY_MS, Number(delayMs || DEFAULT_TASK_UI_UPDATE_DELAY_MS)));
  const pending = new Map();

  const flush = (taskRunId) => {
    const entry = pending.get(taskRunId);
    if (!entry) return false;
    pending.delete(taskRunId);
    if (entry.timer) clearTimer(entry.timer);
    try {
      publish(entry.payload, {
        taskRunId,
        coalescedCount: entry.count,
        queuedAt: entry.queuedAt,
        delayMs: waitMs,
      });
    } catch (error) {
      try { onError?.(error, { taskRunId, coalescedCount: entry.count, immediate: false }); } catch {}
    }
    try {
      onFlush?.({
        taskRunId,
        coalescedCount: entry.count,
        queuedAt: entry.queuedAt,
        delayMs: waitMs,
      });
    } catch {}
    return true;
  };

  const enqueue = (payload = {}) => {
    const taskRunId = String(payload?.task?.id || payload?.taskRunId || payload?.task_run_id || '').trim();
    if (!taskUpdateCanCoalesce(payload)) {
      const superseded = taskRunId ? pending.get(taskRunId) : null;
      if (superseded) {
        pending.delete(taskRunId);
        if (superseded.timer) clearTimer(superseded.timer);
      }
      const publication = {
        taskRunId,
        coalescedCount: 1 + Number(superseded?.count || 0),
        immediate: true,
        delayMs: 0,
      };
      try { publish(payload, publication); }
      catch (error) {
        try { onError?.(error, publication); } catch {}
      }
      return { queued: false, immediate: true, taskRunId };
    }
    const current = pending.get(taskRunId);
    if (current) {
      current.payload = payload;
      current.count += 1;
      return { queued: true, immediate: false, taskRunId, coalescedCount: current.count };
    }
    const entry = {
      payload,
      count: 1,
      queuedAt: Date.now(),
      timer: null,
    };
    pending.set(taskRunId, entry);
    entry.timer = setTimer(() => flush(taskRunId), waitMs);
    entry.timer?.unref?.();
    return { queued: true, immediate: false, taskRunId, coalescedCount: 1 };
  };

  const close = ({ flushPending = false } = {}) => {
    const taskRunIds = [...pending.keys()];
    if (flushPending) {
      for (const taskRunId of taskRunIds) flush(taskRunId);
    } else {
      for (const entry of pending.values()) if (entry.timer) clearTimer(entry.timer);
      pending.clear();
    }
  };

  return {
    enqueue,
    flush,
    close,
    pendingCount: () => pending.size,
  };
}
