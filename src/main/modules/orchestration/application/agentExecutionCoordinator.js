const DURABLE_AGENT_WORK_KINDS = new Set([
  'task_node', 'ubuddy_agent_message', 'ubuddy_workspace_message', 'ubuddy_task_supplement',
]);

export class AgentExecutionCoordinator {
  constructor({ store, pollIntervalMs = 80 } = {}) {
    if (!store) throw new Error('Agent execution coordinator requires a Store.');
    this.store = store;
    this.pollIntervalMs = Math.max(20, Number(pollIntervalMs || 80));
    this.kindHandlers = new Map();
    this.workHandlers = new Map();
    this.waiters = new Map();
    this.results = new Map();
    this.finishedListeners = new Set();
    this.availabilityListeners = new Set();
    this.controllers = new Map();
    this.preservedWorkIds = new Set();
    this.activeExecutions = new Set();
    this.started = false;
    this.draining = false;
    this.drainRequested = false;
    this.workspaceRunner = (_workspaceId, operation) => operation();
  }

  setWorkspaceRunner(runner) {
    this.workspaceRunner = typeof runner === 'function' ? runner : ((_workspaceId, operation) => operation());
  }

  recover() {
    return this.store.recoverAgentWorkQueue();
  }

  registerHandler(workKind = '', handler = null) {
    const kind = String(workKind || '').trim();
    if (!kind || typeof handler !== 'function') throw new Error('Agent execution handler requires work kind and callback.');
    this.kindHandlers.set(kind, handler);
    this.wake();
    return () => this.kindHandlers.delete(kind);
  }

  onFinished(listener) {
    if (typeof listener !== 'function') return () => {};
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  onAvailabilityChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  start() {
    this.started = true;
    this.wake();
  }

  stop({ reason = 'runtime_shutdown', preserveDurable = false } = {}) {
    this.started = false;
    const shutdownError = interruptionError(reason);
    for (const [workId, controller] of this.controllers.entries()) {
      const work = this.store.getAgentWork(workId);
      if (preserveDurable && DURABLE_AGENT_WORK_KINDS.has(String(work?.workKind || ''))) {
        this.preservedWorkIds.add(workId);
        this.store.interruptAgentWork?.({ id: workId, reason: 'runtime_shutdown_resume' });
      }
      controller.abort(shutdownError);
    }
    const active = [...this.activeExecutions];
    return active.length ? Promise.allSettled(active) : null;
  }

  enqueue({ userId = '', agentInstanceId = '', workKind = '', workId = '', payload = {}, workspaceId = '' } = {}) {
    const work = this.store.enqueueAgentWork({ userId, agentInstanceId, workKind, workId, payload, workspaceId });
    this.notifyAvailabilityChanged(work, 'queued');
    this.wake();
    return work;
  }

  cancel({ id = '', workKind = '', workId = '', reason = 'cancelled_by_user' } = {}) {
    const work = id ? this.store.getAgentWork(id) : this.store.findAgentWork({ workKind, workId });
    if (!work || ['completed', 'failed', 'cancelled'].includes(work.status)) return work || null;
    if (work.status === 'queued') {
      const cancelled = this.store.cancelAgentWork({ id: work.id, reason });
      this.notifyAvailabilityChanged(cancelled, 'cancelled');
      this.workHandlers.delete(work.id);
      this.settleWaiters(work.id, cancelled);
      for (const listener of this.finishedListeners) {
        try { listener(cancelled, { result: undefined, error: null, transient: false }); } catch {}
      }
      this.drainRequested = true;
      this.wake();
      return cancelled;
    }
    this.controllers.get(work.id)?.abort(cancelledError());
    return this.store.getAgentWork(work.id);
  }

  wake() {
    if (!this.started) return;
    this.drainRequested = true;
    queueMicrotask(() => this.drain().catch(() => {}));
  }

  async waitForWork(id = '', { signal = null, onQueued = null } = {}) {
    const initial = this.store.getAgentWork(id);
    if (!initial) throw new Error(`Agent work not found: ${id}`);
    if (terminalStatus(initial.status)) return this.finishResult(initial);
    if (initial.status === 'queued') onQueued?.(initial);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          const current = this.store.getAgentWork(id);
          if (current?.status === 'queued') {
            this.store.finishAgentWork({ id, status: 'cancelled', errorText: 'Cancelled before execution.' });
            this.settleWaiters(id, this.store.getAgentWork(id));
            return;
          }
          this.removeWaiter(id, waiter);
          reject(cancelledError());
        };
        if (signal.aborted) return waiter.abort();
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      const list = this.waiters.get(id) || [];
      list.push(waiter);
      this.waiters.set(id, list);
      this.wake();
    });
  }

  async run({ userId = '', agentInstanceId = '', workKind = '', workId = '', payload = {}, workspaceId = '', signal = null, onQueued = null, execute } = {}) {
    if (typeof execute !== 'function') throw new Error('Agent execution work requires an execute callback.');
    if (!userId || !agentInstanceId) return execute();
    const work = this.enqueue({ userId, agentInstanceId, workKind, workId, payload, workspaceId });
    this.workHandlers.set(work.id, execute);
    return this.waitForWork(work.id, { signal, onQueued });
  }

  async drain() {
    if (!this.started || this.draining) return;
    this.draining = true;
    try {
      while (this.started && this.drainRequested) {
        this.drainRequested = false;
        const queued = this.store.listAgentWorkQueue({ statuses: ['queued'], limit: 500 });
        for (const work of queued) {
          const transient = this.workHandlers.has(work.id);
          const handler = this.workHandlers.get(work.id) || this.kindHandlers.get(work.workKind);
          if (!handler) continue;
          const claimed = this.store.claimAgentWork({ id: work.id, agentInstanceId: work.agentInstanceId });
          if (!claimed) continue;
          this.notifyAvailabilityChanged(claimed, 'running');
          const execution = this.executeClaimed(claimed, handler, { transient });
          this.activeExecutions.add(execution);
          void execution.catch(() => this.wake()).finally(() => this.activeExecutions.delete(execution));
        }
      }
    } finally {
      this.draining = false;
      if (this.started && this.drainRequested) this.wake();
    }
  }

  async executeClaimed(work, handler, { transient = false } = {}) {
    let result;
    let error = null;
    const controller = new AbortController();
    this.controllers.set(work.id, controller);
    try {
      result = await this.workspaceRunner(work.workspaceId || work.accountWorkspaceId || '', () => (
        handler(work, { signal: controller.signal })
      ));
      if (!this.preservedWorkIds.has(work.id)) {
        this.results.set(work.id, result);
        this.store.finishAgentWork({ id: work.id, status: controller.signal.aborted ? 'cancelled' : 'completed' });
      }
    } catch (caught) {
      error = caught;
      if (!this.preservedWorkIds.has(work.id)) {
        this.store.finishAgentWork({
          id: work.id,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          errorText: controller.signal.aborted ? 'cancelled_by_user' : caught?.message || String(caught),
        });
      }
    } finally {
      this.controllers.delete(work.id);
      this.workHandlers.delete(work.id);
    }
    if (this.preservedWorkIds.delete(work.id)) {
      const interrupted = this.store.interruptAgentWork?.({ id: work.id, reason: 'runtime_shutdown_resume' })
        || this.store.getAgentWork(work.id);
      this.notifyAvailabilityChanged(interrupted, 'queued');
      this.settleWaiters(work.id, interrupted, error || interruptionError('runtime_shutdown'));
      return;
    }
    const finished = this.store.getAgentWork(work.id);
    this.notifyAvailabilityChanged(finished, finished?.status || 'completed');
    this.settleWaiters(work.id, finished, error);
    for (const listener of this.finishedListeners) {
      try { listener(finished, { result, error, transient }); } catch {}
    }
    this.wake();
  }

  notifyAvailabilityChanged(work, workState = '') {
    if (!work?.agentInstanceId) return;
    const availability = this.store.getAgentAvailability?.({
      userId: work.userId || '', agentInstanceId: work.agentInstanceId,
      workspaceId: work.accountWorkspaceId || work.workspaceId || '',
    }) || { agentInstanceId: work.agentInstanceId, availability: ['completed', 'failed', 'cancelled'].includes(workState) ? 'idle' : 'working', workState };
    const event = { type: 'agent_availability_changed', work, ...availability };
    for (const listener of this.availabilityListeners) {
      try { listener(event); } catch {}
    }
  }

  settleWaiters(id, work, error = null) {
    const waiters = this.waiters.get(id) || [];
    this.waiters.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
      if (error || work?.status === 'failed') waiter.reject(error || new Error(work.errorText || 'Agent work failed.'));
      else if (work?.status === 'cancelled') waiter.reject(cancelledError());
      else waiter.resolve(this.finishResult(work));
    }
    this.results.delete(id);
  }

  removeWaiter(id, waiter) {
    const remaining = (this.waiters.get(id) || []).filter((item) => item !== waiter);
    if (remaining.length) this.waiters.set(id, remaining);
    else this.waiters.delete(id);
  }

  finishResult(work) {
    const result = this.results.get(work.id);
    if (work.status === 'failed') throw new Error(work.errorText || 'Agent work failed.');
    if (work.status === 'cancelled') throw cancelledError();
    return result;
  }
}

function terminalStatus(status = '') {
  return ['completed', 'failed', 'cancelled'].includes(String(status || ''));
}

function cancelledError() {
  const error = new Error('Agent work cancelled.');
  error.code = 'agent_work_cancelled';
  return error;
}

function interruptionError(reason = 'runtime_shutdown') {
  const error = new Error(reason === 'runtime_shutdown'
    ? 'Agent work interrupted by application shutdown and queued for resume.'
    : `Agent work interrupted: ${reason}`);
  error.code = String(reason || 'runtime_shutdown');
  return error;
}
