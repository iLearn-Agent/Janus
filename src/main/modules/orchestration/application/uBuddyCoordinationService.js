export function createUBuddyCoordinationService({
  store,
  workerId = `ubuddy_runtime_${process.pid}`,
  leaseMs = 60_000,
  recoveryIntervalMs = Number(process.env.JANUS_UBUDDY_WAKE_RECOVERY_INTERVAL_MS || 30_000),
  clock = () => Date.now(),
} = {}) {
  if (!store) throw new Error('uBuddy coordination service requires a Store.');
  let lastRecoveryAt = 0;

  return {
    start(input = {}) {
      return store.startUBuddyCoordination(input);
    },

    waitForAgents(input = {}) {
      return store.markUBuddyWaitingForAgents(input);
    },

    sleep(input = {}) {
      return store.markUBuddySleeping(input);
    },

    markUBuddySleeping(taskRunId = '', leader = {}) {
      return store.markUBuddySleeping({
        taskRunId,
        leaderAgentId: leader.leaderAgentId || leader.agentId || '',
        leaderAgentInstanceId: leader.leaderAgentInstanceId || leader.agentInstanceId || '',
        sleepReason: leader.sleepReason || leader.reason || '',
      });
    },

    requestWake(input = {}) {
      return store.requestUBuddyWake(input);
    },

    requestUBuddyWake(taskRunId = '', reasonCode = '', payload = {}) {
      return store.requestUBuddyWake({ taskRunId, reasonCode, ...payload, payload: payload.payload || payload });
    },

    claimPendingWakes({ limit = 20, now = clock() } = {}) {
      return store.claimPendingUBuddyWakes({ limit, now, workerId, leaseMs });
    },

    consumePendingUBuddyWake(taskRunId = '', { now = clock() } = {}) {
      return store.consumePendingUBuddyWake(taskRunId, { now, workerId, leaseMs });
    },

    acknowledgeWake(input = {}) {
      return store.acknowledgeUBuddyWake(input);
    },

    acknowledgeUBuddyWake(wakeEventId = '', messageId = '') {
      return store.acknowledgeUBuddyWake({ wakeEventId, deliveryMessageId: messageId });
    },

    failWakeDelivery(input = {}) {
      return store.failUBuddyWakeDelivery(input);
    },

    recover({ force = false, limit = 200, now = clock() } = {}) {
      const currentMs = timestampMs(now);
      const configuredIntervalMs = Number(recoveryIntervalMs || 30_000);
      const intervalMs = Number.isFinite(configuredIntervalMs) ? Math.max(1_000, configuredIntervalMs) : 30_000;
      if (!force && lastRecoveryAt && currentMs - lastRecoveryAt < intervalMs) {
        return { skipped: true, reason: 'recovery_interval_not_elapsed', pending: [] };
      }
      lastRecoveryAt = currentMs;
      return { skipped: false, ...store.recoverUBuddyCoordination({ now, limit }) };
    },

    recoverUBuddyCoordination(options = {}) {
      return this.recover({ force: true, ...options });
    },

    state(taskRunId = '') {
      return store.getUBuddyCoordinationState(taskRunId);
    },

    wake(wakeEventId = '') {
      return store.getUBuddyWakeEvent(wakeEventId);
    },
  };
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}
