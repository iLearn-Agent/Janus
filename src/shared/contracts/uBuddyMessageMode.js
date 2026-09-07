export const UBUDDY_MESSAGE_MODE_VERSION = 'ubuddy_message_mode_v1';

export const UBUDDY_MESSAGE_MODES = Object.freeze({
  TASK: 'task',
  ASK: 'ask',
});

export function resolveUBuddyMessageMode({
  enabled = false,
  version = '',
  mode = '',
} = {}) {
  const capable = enabled === true && String(version || '').trim() === UBUDDY_MESSAGE_MODE_VERSION;
  if (!capable) return { enabled: false, version: '', mode: 'legacy' };
  const normalized = String(mode || UBUDDY_MESSAGE_MODES.TASK).trim().toLowerCase();
  if (!Object.values(UBUDDY_MESSAGE_MODES).includes(normalized)) {
    const error = new Error(`Unsupported uBuddy message mode: ${normalized || 'missing'}.`);
    error.code = 'invalid_ubuddy_message_mode';
    throw error;
  }
  return { enabled: true, version: UBUDDY_MESSAGE_MODE_VERSION, mode: normalized };
}
