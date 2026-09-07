export const DESKTOP_ACTIVITY_STATE = Object.freeze({
  FOREGROUND: 'foreground',
  BACKGROUND_WORK: 'background_work',
  BACKGROUND_IDLE: 'background_idle',
  SUSPENDED: 'suspended',
});

export function deriveDesktopActivityState({
  suspended = false,
  locked = false,
  hasVisibleWindow = false,
  hasBackgroundWork = false,
} = {}) {
  if (suspended) return DESKTOP_ACTIVITY_STATE.SUSPENDED;
  if (hasVisibleWindow && !locked) return DESKTOP_ACTIVITY_STATE.FOREGROUND;
  if (hasBackgroundWork) return DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK;
  return DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE;
}

export function shouldQuitWhenAllWindowsClosed(platform = process.platform, {
  keepAlive = false,
  closeBehavior = '',
} = {}) {
  if (keepAlive) return false;
  if (String(closeBehavior || '') === 'quit') return true;
  return String(platform || '') !== 'darwin';
}

export function desktopLoopDelay(kind = '', {
  state = DESKTOP_ACTIVITY_STATE.FOREGROUND,
  onBattery = false,
  idleRounds = 0,
  foregroundIdleMs = 10_000,
  foregroundActiveMs = 3_000,
  configuredMs = 60_000,
} = {}) {
  if (state === DESKTOP_ACTIVITY_STATE.SUSPENDED) return null;
  switch (String(kind || '')) {
    case 'social':
      if (state === DESKTOP_ACTIVITY_STATE.FOREGROUND) {
        return Math.max(2_000, Number(foregroundIdleMs || 10_000));
      }
      if (state === DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK) {
        return Math.max(15_000, Number(foregroundActiveMs || 3_000));
      }
      return [30_000, 60_000, 120_000, 300_000][Math.min(3, Math.max(0, Number(idleRounds || 0)))] || 300_000;
    case 'task_recovery':
      if (state === DESKTOP_ACTIVITY_STATE.FOREGROUND) return Math.max(1_000, Number(configuredMs || 5_000));
      if (state === DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK) return Math.max(15_000, Number(configuredMs || 5_000));
      return null;
    case 'maintenance':
    case 'model_catalog':
      if (state === DESKTOP_ACTIVITY_STATE.FOREGROUND) return Math.max(60_000, Number(configuredMs || 60_000));
      if (state === DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK) return Math.max(5 * 60_000, Number(configuredMs || 60_000));
      return onBattery ? null : Math.max(15 * 60_000, Number(configuredMs || 60_000));
    case 'cloud_sync':
      if (state === DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE && onBattery) {
        return Math.max(30 * 60_000, Number(configuredMs || 15 * 60_000));
      }
      return Math.max(60_000, Number(configuredMs || 15 * 60_000));
    default:
      return Math.max(1_000, Number(configuredMs || 60_000));
  }
}

export function uBuddyRecoveryDelay(kind = '', {
  state = DESKTOP_ACTIVITY_STATE.FOREGROUND,
  configuredMs = 5_000,
} = {}) {
  if (state === DESKTOP_ACTIVITY_STATE.SUSPENDED) return null;
  const baseline = Math.max(1_000, Number(configuredMs || 5_000));
  if (state === DESKTOP_ACTIVITY_STATE.FOREGROUND) return baseline;
  if (state === DESKTOP_ACTIVITY_STATE.BACKGROUND_WORK) return Math.max(15_000, baseline);
  return Math.max(5 * 60_000, baseline);
}

export function socialPollHadActivity(result = null) {
  if (!result || result.skipped) return false;
  if (Number(result.messages || 0) > 0 || Number(result.delegations || 0) > 0) return true;
  if (Array.isArray(result.incomingMessages) && result.incomingMessages.length) return true;
  if (Array.isArray(result.collaboration?.tasks) && result.collaboration.tasks.some((task) => ![
    'result_accepted', 'completed', 'closed', 'withdrawn', 'declined', 'rejected', 'failed',
  ].includes(String(task.status || '')))) return true;
  return Number(result.workMemoryPublications?.processed || result.workMemoryPublications?.published || 0) > 0;
}

export function taskUpdateRequiresImmediateSocialPoll(payload = {}) {
  const delegation = payload?.delegation && typeof payload.delegation === 'object'
    ? payload.delegation
    : null;
  if (!delegation?.id || payload?.task?.id || delegation.taskRunId || delegation.task_run_id) return false;
  if (String(payload?.change?.type || '') !== 'delegation_progress'
    || String(payload?.change?.progressEventKey || '') !== 'intake_completed') return false;
  if (String(delegation.metadata?.intakeStatus || '') !== 'completed'
    || String(delegation.metadata?.dependencyState || '') === 'waiting') return false;
  return ['accepted', 'preparing', 'awaiting_approval'].includes(String(delegation.status || ''));
}
