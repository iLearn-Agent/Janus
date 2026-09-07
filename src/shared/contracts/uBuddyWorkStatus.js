export const AGENT_WORK_STATUS_PROJECTION_VERSION = 'agent_work_status_projection_v1';

export const AGENT_WORK_STATUS_VALUES = Object.freeze([
  'idle', 'reserved', 'queued', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled',
]);

export const AGENT_WORK_ACTOR_KINDS = Object.freeze([
  'local_agent', 'ubuddy', 'remote_agent', 'remote_ubuddy',
]);

export const AGENT_WORK_STAGE_VALUES = Object.freeze([
  'planning', 'executing', 'verifying', 'delivering', 'completed', 'failed', 'cancelled',
]);

export const AGENT_WORK_STATUS_VISIBILITIES = Object.freeze([
  'owner_private',
  'participant_public',
]);

export const AgentWorkStatusTimelineEntry = Object.freeze({
  fields: Object.freeze({
    id: 'string',
    sourceKind: 'task_event | task_node | delivery_event | delegation_milestone',
    status: 'string',
    stage: 'string',
    summary: 'public string',
    occurredAt: 'ISO-8601 timestamp',
    evidenceRefs: 'public evidence references[]',
  }),
});

export const AgentWorkStatusProjection = Object.freeze({
  name: 'AgentWorkStatusProjection',
  version: AGENT_WORK_STATUS_PROJECTION_VERSION,
  fields: Object.freeze({
    version: 'string',
    projectionId: 'stable string',
    actorKind: 'local_agent | ubuddy | remote_agent | remote_ubuddy',
    actorLabel: 'public string',
    ownerUserId: 'owner-private string',
    agentId: 'string',
    agentInstanceId: 'owner-private string',
    taskRunId: 'string',
    delegationId: 'string',
    taskNodeId: 'string',
    currentNodeTitle: 'public string',
    status: 'idle | reserved | queued | running | waiting | blocked | completed | failed | cancelled',
    currentStage: 'planning | executing | verifying | delivering | completed | failed | cancelled',
    currentAction: 'public string',
    completedSummary: 'public string',
    blocker: 'public blocker | null',
    nextStep: 'public string',
    progress: '{ completed: non-negative integer, total: non-negative integer, percent: integer | null }',
    evidenceRefs: 'public evidence references[]',
    timeline: 'AgentWorkStatusTimelineEntry[]',
    visibility: 'owner_private | participant_public',
    sourceEventId: 'string',
    sourceRevision: 'non-negative integer',
    updatedAt: 'ISO-8601 timestamp',
  }),
  requiredScope: Object.freeze(['taskRunId | delegationId', 'projectionId | agentInstanceId | ownerUserId', 'updatedAt']),
});

export const AgentWorkStatusProjectionEnvelope = Object.freeze({
  name: 'AgentWorkStatusProjectionEnvelope',
  version: AGENT_WORK_STATUS_PROJECTION_VERSION,
  fields: Object.freeze({
    version: 'string',
    scopeKind: 'task_run | delivery | delegation',
    scopeId: 'string',
    actors: 'AgentWorkStatusProjection[]',
    updatedAt: 'ISO-8601 timestamp',
  }),
});

export function normalizeAgentWorkStatusProjection(value = {}) {
  const source = objectValue(value);
  const rawStatus = clean(source.status || source.workState || source.work_state).toLowerCase();
  const rawStage = clean(source.currentStage || source.current_stage || source.stage).toLowerCase();
  const rawVisibility = clean(source.visibility || source.privacyLevel || source.privacy_level).toLowerCase();
  const total = boundedInteger(source.progress?.total ?? source.total, 100_000);
  const completed = Math.min(total || 100_000, boundedInteger(source.progress?.completed ?? source.completed, 100_000));
  const actorKind = clean(source.actorKind || source.actor_kind, 80) || 'local_agent';
  const agentInstanceId = clean(source.agentInstanceId || source.agent_instance_id, 160);
  const ownerUserId = clean(source.ownerUserId || source.owner_user_id, 160);
  const agentId = clean(source.agentId || source.agent_id, 160);
  const taskRunId = clean(source.taskRunId || source.task_run_id, 160);
  const delegationId = clean(source.delegationId || source.delegation_id, 160);
  return {
    version: clean(source.version) || AGENT_WORK_STATUS_PROJECTION_VERSION,
    projectionId: clean(source.projectionId || source.projection_id, 240)
      || [actorKind, taskRunId || delegationId, agentInstanceId || agentId || ownerUserId].filter(Boolean).join(':'),
    actorKind,
    actorLabel: sanitizePublicWorkStatusText(source.actorLabel || source.actor_label || source.name, 160),
    ownerUserId,
    agentId,
    agentInstanceId,
    taskRunId,
    delegationId,
    taskNodeId: clean(source.taskNodeId || source.task_node_id || source.nodeId || source.node_id, 160),
    currentNodeTitle: sanitizePublicWorkStatusText(source.currentNodeTitle || source.current_node_title, 240),
    status: AGENT_WORK_STATUS_VALUES.includes(rawStatus) ? rawStatus : 'idle',
    currentStage: AGENT_WORK_STAGE_VALUES.includes(rawStage) ? rawStage : stageForStatus(rawStatus),
    currentAction: sanitizePublicWorkStatusText(source.currentAction || source.current_action, 600),
    completedSummary: sanitizePublicWorkStatusText(source.completedSummary || source.completed_summary, 1_000),
    blocker: normalizeWorkStatusBlocker(source.blocker),
    nextStep: sanitizePublicWorkStatusText(source.nextStep || source.next_step, 600),
    progress: {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : null,
    },
    evidenceRefs: normalizeWorkStatusEvidenceRefs(source.evidenceRefs || source.evidence_refs),
    timeline: normalizeWorkStatusTimeline(source.timeline),
    visibility: AGENT_WORK_STATUS_VISIBILITIES.includes(rawVisibility) ? rawVisibility : 'owner_private',
    sourceEventId: clean(source.sourceEventId || source.source_event_id, 200),
    sourceRevision: boundedInteger(source.sourceRevision || source.source_revision, Number.MAX_SAFE_INTEGER),
    updatedAt: isoTimestamp(source.updatedAt || source.updated_at),
  };
}

export function normalizeAgentWorkStatusProjectionEnvelope(value = {}) {
  const source = objectValue(value);
  const scopeKind = ['task_run', 'delivery', 'delegation'].includes(String(source.scopeKind || source.scope_kind || ''))
    ? String(source.scopeKind || source.scope_kind)
    : 'task_run';
  const actors = (Array.isArray(source.actors) ? source.actors : [])
    .map(normalizeAgentWorkStatusProjection)
    .filter((item) => item.projectionId && item.updatedAt);
  const latest = actors.map((item) => item.updatedAt).filter(Boolean).sort().at(-1) || '';
  return {
    version: clean(source.version) || AGENT_WORK_STATUS_PROJECTION_VERSION,
    scopeKind,
    scopeId: clean(source.scopeId || source.scope_id, 240),
    actors,
    updatedAt: isoTimestamp(source.updatedAt || source.updated_at || latest),
  };
}

export function publicAgentWorkStatusProjection(value = {}) {
  const projection = normalizeAgentWorkStatusProjection(value);
  return normalizeAgentWorkStatusProjection({
    ...projection,
    actorKind: projection.actorKind === 'ubuddy' ? 'remote_ubuddy'
      : projection.actorKind === 'local_agent' ? 'remote_agent' : projection.actorKind,
    ownerUserId: '',
    agentInstanceId: '',
    visibility: 'participant_public',
    evidenceRefs: publicEvidenceRefs(projection.evidenceRefs),
    timeline: projection.timeline.slice(-20).map((item) => ({ ...item, evidenceRefs: publicEvidenceRefs(item.evidenceRefs) })),
  });
}

export function publicAgentWorkStatusProjectionEnvelope(value = {}) {
  const envelope = normalizeAgentWorkStatusProjectionEnvelope(value);
  return normalizeAgentWorkStatusProjectionEnvelope({
    ...envelope,
    actors: envelope.actors.map(publicAgentWorkStatusProjection),
  });
}

export function validateAgentWorkStatusProjection(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const projection = normalizeAgentWorkStatusProjection(value);
  const diagnostics = [];
  if (projection.version !== AGENT_WORK_STATUS_PROJECTION_VERSION) {
    diagnostics.push(errorDiagnostic('work_status_version_unsupported', 'version', 'Unsupported Agent work-status projection version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.status ?? source.workState ?? source.work_state,
    allowedValues: AGENT_WORK_STATUS_VALUES, code: 'work_status_value_invalid', field: 'status',
    message: 'An Agent work-status projection requires a supported status.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.actorKind ?? source.actor_kind,
    allowedValues: AGENT_WORK_ACTOR_KINDS, code: 'work_status_actor_kind_invalid', field: 'actorKind',
    message: 'An Agent work-status projection requires a supported actor kind.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.currentStage ?? source.current_stage ?? source.stage,
    allowedValues: AGENT_WORK_STAGE_VALUES, code: 'work_status_stage_invalid', field: 'currentStage',
    message: 'An Agent work-status projection requires a supported work stage.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.visibility ?? source.privacyLevel ?? source.privacy_level,
    allowedValues: AGENT_WORK_STATUS_VISIBILITIES, code: 'work_status_visibility_invalid', field: 'visibility',
    message: 'An Agent work-status projection requires a supported visibility.' });
  if (!projection.taskRunId && !projection.delegationId) {
    diagnostics.push(errorDiagnostic('work_status_scope_missing', 'taskRunId', 'A work-status projection requires a task or delegation id.'));
  }
  if (!projection.projectionId && !projection.agentInstanceId && !projection.ownerUserId) {
    diagnostics.push(errorDiagnostic('work_status_actor_missing', 'projectionId', 'A work-status projection requires a stable actor identity.'));
  }
  if (!projection.updatedAt) diagnostics.push(errorDiagnostic('work_status_timestamp_missing', 'updatedAt', 'A work-status projection requires a valid update timestamp.'));
  return finishValidation('agent_work_status_projection_invalid', projection, diagnostics, throwOnError);
}

const TERMINAL_WORK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function applyAgentWorkStatusProjection(currentValue = null, incomingValue = {}) {
  const incomingValidation = validateAgentWorkStatusProjection(incomingValue);
  const incoming = incomingValidation.value;
  if (!incomingValidation.valid) {
    return { changed: false, duplicate: false, action: 'invalid_incoming', projection: incoming,
      diagnostics: incomingValidation.diagnostics };
  }

  const hasCurrent = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
    && Object.keys(currentValue).length > 0;
  if (!hasCurrent) {
    return { changed: true, duplicate: false, action: 'applied', projection: incoming, diagnostics: [] };
  }

  const currentValidation = validateAgentWorkStatusProjection(currentValue);
  const current = currentValidation.value;
  if (!currentValidation.valid) {
    return { changed: false, duplicate: false, action: 'invalid_current', projection: current,
      diagnostics: currentValidation.diagnostics };
  }
  if (workScopeKey(current) !== workScopeKey(incoming)) {
    return { changed: false, duplicate: false, action: 'scope_mismatch', projection: current, diagnostics: [] };
  }
  if (!sameWorkActor(current, incoming)) {
    return { changed: false, duplicate: false, action: 'actor_mismatch', projection: current, diagnostics: [] };
  }
  if (current.sourceEventId && incoming.sourceEventId === current.sourceEventId) {
    return { changed: false, duplicate: true, action: 'duplicate', projection: current, diagnostics: [] };
  }

  if (current.sourceRevision > 0) {
    if (incoming.sourceRevision === 0) {
      return { changed: false, duplicate: false, action: 'unversioned_rejected', projection: current, diagnostics: [] };
    }
    if (incoming.sourceRevision < current.sourceRevision) {
      return { changed: false, duplicate: false, action: 'stale_revision', projection: current, diagnostics: [] };
    }
    if (incoming.sourceRevision === current.sourceRevision) {
      return { changed: false, duplicate: false, action: 'revision_conflict', projection: current, diagnostics: [] };
    }
  } else if (incoming.sourceRevision === 0) {
    const currentUpdatedAt = Date.parse(current.updatedAt);
    const incomingUpdatedAt = Date.parse(incoming.updatedAt);
    if (incomingUpdatedAt < currentUpdatedAt) {
      return { changed: false, duplicate: false, action: 'stale_timestamp', projection: current, diagnostics: [] };
    }
    if (incomingUpdatedAt === currentUpdatedAt) {
      return { changed: false, duplicate: false, action: 'timestamp_conflict', projection: current, diagnostics: [] };
    }
  }

  if (TERMINAL_WORK_STATUSES.has(current.status) && !TERMINAL_WORK_STATUSES.has(incoming.status)) {
    return { changed: false, duplicate: false, action: 'terminal_regression', projection: current, diagnostics: [] };
  }
  return {
    changed: JSON.stringify(current) !== JSON.stringify(incoming),
    duplicate: false,
    action: 'applied',
    projection: incoming,
    diagnostics: [],
  };
}

function workScopeKey(projection = {}) {
  return `task:${projection.taskRunId || ''}:delegation:${projection.delegationId || ''}:node:${projection.taskNodeId || ''}`;
}

function sameWorkActor(current = {}, incoming = {}) {
  if (current.projectionId !== incoming.projectionId) return false;
  return ['actorKind', 'ownerUserId', 'agentId', 'agentInstanceId'].every((field) => (
    !current[field] || !incoming[field] || current[field] === incoming[field]
  ));
}

export function validateAgentWorkStatusProjectionEnvelope(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const envelope = normalizeAgentWorkStatusProjectionEnvelope(value);
  const diagnostics = [];
  if (envelope.version !== AGENT_WORK_STATUS_PROJECTION_VERSION) {
    diagnostics.push(errorDiagnostic('work_status_envelope_version_unsupported', 'version', 'Unsupported Agent work-status envelope version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.scopeKind ?? source.scope_kind,
    allowedValues: ['task_run', 'delivery', 'delegation'], code: 'work_status_envelope_scope_kind_invalid', field: 'scopeKind',
    message: 'An Agent work-status envelope requires a supported scope kind.' });
  if (!envelope.scopeId) diagnostics.push(errorDiagnostic('work_status_envelope_scope_missing', 'scopeId', 'A work-status envelope requires a scope id.'));
  envelope.actors.forEach((actor, index) => {
    for (const diagnostic of validateAgentWorkStatusProjection(actor).diagnostics) {
      diagnostics.push({ ...diagnostic, field: `actors.${index}.${diagnostic.field}` });
    }
  });
  return finishValidation('agent_work_status_projection_envelope_invalid', envelope, diagnostics, throwOnError);
}

export function sanitizePublicWorkStatusText(value = '', maximum = 600) {
  return String(value || '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[敏感信息已隐藏]')
    .replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|client[_ -]?secret|secret|私钥|密码|密钥)\s*[:=：]\s*[^\s,，;；]+/gi, '[敏感信息已隐藏]')
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gi, '[敏感信息已隐藏]')
    .replace(/file:\/\/[^\s<>"'`，。；;）)]+/gi, '[本地路径已隐藏]')
    .replace(/\/(?:home|Users|tmp|var|private|mnt|opt|Volumes)\/[^\s<>"'`，。；;）)]+/g, '[本地路径已隐藏]')
    .replace(/[A-Za-z]:\\[^\s<>"'`，。；;）)]+|\\\\[^\\\s]+\\[^\s<>"'`，。；;）)]+/g, '[本地路径已隐藏]')
    .replace(/(?:私聊|private\s+(?:chat|message|conversation))\s*[:：]\s*[^。.!！?？]{1,500}/gi, '[私聊内容已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function normalizeWorkStatusBlocker(value = null) {
  if (!value) return null;
  const source = typeof value === 'string' ? { summary: value } : objectValue(value);
  const summary = sanitizePublicWorkStatusText(source.summary || source.message || source.reason, 800);
  const suggestedNextStep = sanitizePublicWorkStatusText(source.suggestedNextStep || source.suggested_next_step, 600);
  if (!summary && !suggestedNextStep) return null;
  return {
    summary: summary || '当前工作暂时无法继续。',
    errorCode: clean(source.errorCode || source.error_code || source.code, 120),
    retryable: source.retryable !== false,
    attemptCount: boundedInteger(source.attemptCount || source.attempt_count, 100),
    maxAttempts: boundedInteger(source.maxAttempts || source.max_attempts, 100),
    nextRetryAt: isoTimestamp(source.nextRetryAt || source.next_retry_at),
    suggestedNextStep,
  };
}

function normalizeWorkStatusEvidenceRefs(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).map((item) => {
    const source = typeof item === 'string' ? { id: item } : objectValue(item);
    const url = /^https:\/\//i.test(String(source.url || '')) ? String(source.url).slice(0, 2_000) : '';
    const rawId = String(source.id || source.refId || source.ref_id || '').trim();
    const id = /^(?:file:|[A-Za-z]:\\)|[\\/]/i.test(rawId) ? '' : clean(rawId, 240);
    const label = sanitizePublicWorkStatusText(source.label || source.title || source.name, 240);
    if (!id && !url && !label) return null;
    return {
      kind: clean(source.kind || source.type || 'evidence', 80),
      id,
      label,
      url,
    };
  }).filter(Boolean);
}

function publicEvidenceRefs(value = []) {
  return normalizeWorkStatusEvidenceRefs(value).filter((item) => item.url || [
    'task_event', 'task_node', 'deliverable', 'remote_file', 'delegation_milestone',
  ].includes(item.kind));
}

function normalizeWorkStatusTimeline(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).map((item) => {
    const source = objectValue(item);
    const id = clean(source.id, 240);
    const summary = sanitizePublicWorkStatusText(source.summary || source.message || source.detail, 600);
    const occurredAt = isoTimestamp(source.occurredAt || source.occurred_at || source.updatedAt || source.createdAt);
    if (!id && !summary && !occurredAt) return null;
    return {
      id,
      sourceKind: clean(source.sourceKind || source.source_kind || 'task_event', 80),
      status: clean(source.status, 40),
      stage: clean(source.stage, 40),
      summary,
      occurredAt,
      evidenceRefs: normalizeWorkStatusEvidenceRefs(source.evidenceRefs || source.evidence_refs),
    };
  }).filter(Boolean);
}

function stageForStatus(status = '') {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (['running', 'queued', 'waiting', 'blocked', 'reserved'].includes(status)) return 'executing';
  return 'planning';
}

function finishValidation(code, value, diagnostics, throwOnError) {
  const result = { valid: diagnostics.every((item) => item.severity !== 'error'), value, diagnostics };
  if (throwOnError && !result.valid) {
    const error = new Error(diagnostics.map((item) => item.message).join(' '));
    error.code = code;
    error.diagnostics = diagnostics;
    throw error;
  }
  return result;
}

function errorDiagnostic(code, field, message) {
  return { severity: 'error', code, field, message };
}

function addInvalidEnumDiagnostic({ diagnostics, rawValue, allowedValues, code, field, message }) {
  const normalized = clean(rawValue).toLowerCase();
  if (normalized && !allowedValues.includes(normalized)) diagnostics.push(errorDiagnostic(code, field, message));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, maximum) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(maximum, number));
}

function isoTimestamp(value = '') {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
