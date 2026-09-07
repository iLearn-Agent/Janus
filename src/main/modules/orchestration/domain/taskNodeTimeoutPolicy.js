// Research and artifact nodes routinely spend longer than a single model turn
// in tools; 15 minutes caused valid pipeline work to be killed at the Codex
// process boundary before the scheduler could report a useful result.
const MIN_TASK_NODE_TIMEOUT_MS = 30 * 60_000;
const MAX_TASK_NODE_TIMEOUT_MS = 60 * 60_000;
const TASK_NODE_TIMEOUT_BUFFER_MS = 5 * 60_000;
const TASK_NODE_RECOVERY_GRACE_MS = 2 * 60_000;

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function configuredModelTimeoutMs(env = process.env) {
  return positiveNumber(env.JANUS_UBUDDY_TASK_NODE_MODEL_TIMEOUT_MS)
    || positiveNumber(env.JANUS_UBUDDY_WORKSPACE_NODE_TIMEOUT_MS);
}

export function taskNodeModelTimeoutMs({ node = {}, env = process.env } = {}) {
  const configured = configuredModelTimeoutMs(env);
  if (configured) return Math.max(1_000, configured);
  const estimatedMinutes = positiveNumber(node.estimatedMinutes || node.estimated_minutes);
  if (!estimatedMinutes) return MIN_TASK_NODE_TIMEOUT_MS;
  return Math.min(
    MAX_TASK_NODE_TIMEOUT_MS,
    Math.max(MIN_TASK_NODE_TIMEOUT_MS, estimatedMinutes * 60_000 + TASK_NODE_TIMEOUT_BUFFER_MS),
  );
}

export function taskNodeRecoveryTimeoutMs({ node = {}, overrideMs = null, env = process.env } = {}) {
  const explicit = positiveNumber(overrideMs) || positiveNumber(env.JANUS_TASK_NODE_TIMEOUT_MS);
  if (explicit) return Math.max(1, explicit);
  return taskNodeModelTimeoutMs({ node, env }) + TASK_NODE_RECOVERY_GRACE_MS;
}

export const TASK_NODE_TIMEOUT_POLICY = Object.freeze({
  minimumMs: MIN_TASK_NODE_TIMEOUT_MS,
  maximumMs: MAX_TASK_NODE_TIMEOUT_MS,
  estimateBufferMs: TASK_NODE_TIMEOUT_BUFFER_MS,
  recoveryGraceMs: TASK_NODE_RECOVERY_GRACE_MS,
});
