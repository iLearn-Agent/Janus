export const UBUDDY_CONTINUATION_VERSION = 'ubuddy_continuation_v1';

const KINDS = new Set(['task_intake', 'collaboration_mode', 'collaboration_plan']);
const STATUSES = new Set(['pending', 'resolving', 'resolved', 'cancelled', 'failed']);

export function createUBuddyContinuation(value = {}) {
  return validateUBuddyContinuation({
    ...value,
    version: UBUDDY_CONTINUATION_VERSION,
    status: value.status || 'pending',
    createdAt: value.createdAt || new Date().toISOString(),
  }, { throwOnError: true }).value;
}

export function validateUBuddyContinuation(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const continuation = {
    version: clean(source.version, 80),
    kind: clean(source.kind, 80).toLowerCase(),
    status: clean(source.status, 40).toLowerCase(),
    continuationId: clean(source.continuationId || source.continuation_id, 240),
    ownerUserId: clean(source.ownerUserId || source.owner_user_id, 160),
    accountWorkspaceId: clean(source.accountWorkspaceId || source.account_workspace_id, 160),
    sessionId: clean(source.sessionId || source.session_id, 240),
    requestMessageId: clean(source.requestMessageId || source.request_message_id, 240),
    taskReference: objectOrNull(source.taskReference || source.task_reference),
    mentions: objects(source.mentions, 100),
    attachments: objects(source.attachments, 20),
    fileReferences: objects(source.fileReferences || source.file_references, 100),
    memoryReferences: objects(source.memoryReferences || source.memory_references, 100),
    taskIntake: objectOrNull(source.taskIntake || source.task_intake),
    dispatchCommand: objectOrNull(source.dispatchCommand || source.dispatch_command),
    modePlannerThreadId: clean(source.modePlannerThreadId || source.mode_planner_thread_id, 240),
    assignmentPlannerThreadId: clean(source.assignmentPlannerThreadId || source.assignment_planner_thread_id, 240),
    responseDigest: clean(source.responseDigest || source.response_digest, 128),
    resolvedByMessageId: clean(source.resolvedByMessageId || source.resolved_by_message_id, 240),
    createdAt: iso(source.createdAt || source.created_at) || new Date().toISOString(),
    resolvedAt: iso(source.resolvedAt || source.resolved_at),
  };
  const diagnostics = [];
  if (continuation.version !== UBUDDY_CONTINUATION_VERSION) diagnostics.push(error('ubuddy_continuation_version_invalid', 'version'));
  if (!KINDS.has(continuation.kind)) diagnostics.push(error('ubuddy_continuation_kind_invalid', 'kind'));
  if (!STATUSES.has(continuation.status)) diagnostics.push(error('ubuddy_continuation_status_invalid', 'status'));
  if (!continuation.continuationId) diagnostics.push(error('ubuddy_continuation_id_missing', 'continuationId'));
  if (!continuation.ownerUserId) diagnostics.push(error('ubuddy_continuation_owner_missing', 'ownerUserId'));
  if (!continuation.accountWorkspaceId) diagnostics.push(error('ubuddy_continuation_workspace_missing', 'accountWorkspaceId'));
  if (!continuation.sessionId) diagnostics.push(error('ubuddy_continuation_session_missing', 'sessionId'));
  if (!continuation.requestMessageId) diagnostics.push(error('ubuddy_continuation_request_missing', 'requestMessageId'));
  if (['collaboration_mode', 'collaboration_plan'].includes(continuation.kind)) {
    if (!continuation.taskIntake) diagnostics.push(error('ubuddy_continuation_intake_missing', 'taskIntake'));
    if (!continuation.dispatchCommand) diagnostics.push(error('ubuddy_continuation_dispatch_missing', 'dispatchCommand'));
    if (!continuation.mentions.length) diagnostics.push(error('ubuddy_continuation_mentions_missing', 'mentions'));
  }
  if (continuation.status === 'resolved' && (!continuation.responseDigest || !continuation.resolvedAt)) {
    diagnostics.push(error('ubuddy_continuation_resolution_invalid', 'status'));
  }
  if (diagnostics.length && throwOnError) {
    const failure = new Error(`Invalid uBuddy continuation: ${diagnostics.map((item) => item.code).join(', ')}`);
    failure.code = 'ubuddy_continuation_invalid';
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return { valid: diagnostics.length === 0, value: continuation, diagnostics };
}

export function uBuddyContinuationResponseDigest(answers = []) {
  const normalized = (Array.isArray(answers) ? answers : []).map((item) => ({
    questionId: clean(item?.questionId || item?.question_id, 160),
    value: clean(item?.value, 4_000),
  })).filter((item) => item.questionId && item.value)
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  return stableHash(JSON.stringify(normalized));
}

function stableHash(value = '') {
  let first = 0x811c9dc5;
  let second = 0x01000193;
  for (const character of String(value)) {
    const code = character.codePointAt(0) || 0;
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function clean(value, limit = 1_000) {
  return String(value || '').trim().slice(0, limit);
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function objectOrNull(value) {
  const result = objectValue(value);
  return Object.keys(result).length ? result : null;
}

function objects(value, limit) {
  return (Array.isArray(value) ? value : []).filter((item) => item && typeof item === 'object' && !Array.isArray(item)).slice(0, limit);
}

function iso(value) {
  const text = clean(value, 80);
  return text && Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : '';
}

function error(code, field) {
  return { code, field };
}
