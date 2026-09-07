export const DELIVERY_REVIEW_POLICY_VERSION = 'delivery_review_policy_v1';
export const FINAL_DELIVERY_POLICY_VERSION = 'final_delivery_policy_v1';
export const DEFAULT_MAX_QUALITY_REVISIONS = 2;
export const MAX_DELIVERY_REVIEW_EVENT_IDS = 1_000;
export const MAX_FINAL_DELIVERY_EVENT_IDS = 100;

export const DELIVERY_REVIEW_STATES = Object.freeze([
  'submitted', 'verifying', 'revision_requested', 'reworking', 'accepted',
  'action_required', 'revision_exhausted', 'failed',
]);

export const DELIVERY_REVIEW_EVENT_TYPES = Object.freeze([
  'submitted', 'verification_started', 'validation_passed', 'validation_failed',
  'rework_started', 'user_action_required', 'verification_uncertain', 'execution_failed',
  'owner_accepted', 'revision_limit_delivered',
]);

export const FINAL_DELIVERY_STATES = Object.freeze([
  'not_delivered', 'delivered', 'user_confirmed', 'closed', 'failed',
]);

export const FINAL_DELIVERY_EVENT_TYPES = Object.freeze([
  'delivered', 'user_confirmed', 'closed', 'delivery_failed', 'retry_started', 'revision_requested',
]);

export const DeliveryReviewPolicy = Object.freeze({
  name: 'DeliveryReviewPolicy',
  version: DELIVERY_REVIEW_POLICY_VERSION,
  fields: Object.freeze({
    version: 'string',
    state: 'submitted | verifying | revision_requested | reworking | action_required | accepted | failed | revision_exhausted',
    maxQualityRevisions: 'positive integer',
    qualityRevisionCount: 'non-negative integer',
    executionAttemptCount: 'non-negative integer',
    lastReviewEventId: 'string',
    processedReviewEventIds: 'string[]',
    failureCodes: 'string[]',
    failedChecks: 'object[]',
    requiredChanges: 'string[]',
    preservedRequirements: 'string[]',
    revisionNumber: 'non-negative integer',
    revisionLimit: 'positive integer',
    updatedAt: 'ISO-8601 timestamp',
  }),
  eventTypes: DELIVERY_REVIEW_EVENT_TYPES,
  defaultMaxQualityRevisions: DEFAULT_MAX_QUALITY_REVISIONS,
});

export const FinalDeliveryPolicy = Object.freeze({
  name: 'FinalDeliveryPolicy',
  version: FINAL_DELIVERY_POLICY_VERSION,
  fields: Object.freeze({
    version: 'string',
    state: 'not_delivered | delivered | user_confirmed | closed | failed',
    deliveredAt: 'ISO-8601 timestamp',
    userConfirmedAt: 'ISO-8601 timestamp',
    closedAt: 'ISO-8601 timestamp',
    failedAt: 'ISO-8601 timestamp',
    failureReason: 'string',
    retryable: 'boolean',
    retryAttemptCount: 'non-negative integer',
    lastEventId: 'string',
    processedEventIds: 'string[]',
    updatedAt: 'ISO-8601 timestamp',
  }),
  eventTypes: FINAL_DELIVERY_EVENT_TYPES,
});

export function deriveTaskLifecycleProgress(value = {}) {
  const source = objectValue(value);
  const taskStatus = clean(source.taskStatus || source.task_status).toLowerCase();
  const reviewState = clean(source.reviewState || source.review_state).toLowerCase();
  const deliverySource = objectValue(source.finalDelivery || source.final_delivery);
  let finalDeliveryState = clean(
    source.finalDeliveryState || source.final_delivery_state || deliverySource.state,
  ).toLowerCase();
  const acceptanceSource = clean(source.acceptanceSource || source.acceptance_source).toLowerCase();
  const confirmationPending = source.confirmationRequired === true || source.confirmation_required === true;
  const hasConfirmationProtocol = source.hasConfirmationProtocol === true
    || source.has_confirmation_protocol === true
    || confirmationPending
    || Boolean(finalDeliveryState || reviewState || acceptanceSource);
  if (!finalDeliveryState && acceptanceSource === 'owner_override') finalDeliveryState = 'closed';
  if (!finalDeliveryState && hasConfirmationProtocol && reviewState === 'accepted') finalDeliveryState = 'delivered';

  const executionPercent = clampPercent(
    source.executionPercent ?? source.execution_percent ?? source.percent,
  );
  let requestedPhase = normalizeLifecyclePhase(source.phase, taskStatus, reviewState);
  const failureStage = clean(source.failureStage || source.failure_stage).toLowerCase();
  if (failureStage.includes('verif') || failureStage.includes('validation')) requestedPhase = 'verifying';
  else if (failureStage.includes('deliver')) requestedPhase = 'delivering';
  else if (['failed', 'cancelled'].includes(taskStatus) && requestedPhase === 'confirming' && executionPercent > 0) requestedPhase = 'executing';

  if (['closed', 'user_confirmed'].includes(finalDeliveryState)
    || ['closed', 'result_accepted'].includes(taskStatus)) {
    return lifecycleProgressResult(100, executionPercent, 'delivering', '完成', false);
  }

  if (['failed', 'cancelled', 'withdrawn', 'declined', 'rejected'].includes(taskStatus)
    || finalDeliveryState === 'failed') {
    const cancelled = ['cancelled', 'withdrawn', 'declined', 'rejected'].includes(taskStatus);
    return lifecycleProgressResult(
      Math.min(95, lifecyclePercentForPhase(requestedPhase, executionPercent)),
      executionPercent,
      requestedPhase,
      cancelled ? '已取消' : finalDeliveryState === 'failed' ? '交付失败' : '任务失败',
      false,
    );
  }

  if (confirmationPending || finalDeliveryState === 'delivered' || taskStatus === 'submitted' || requestedPhase === 'delivered') {
    return lifecycleProgressResult(95, executionPercent, 'delivering', '待确认交付', true);
  }

  if (taskStatus === 'completed' && !hasConfirmationProtocol && requestedPhase === 'delivering') {
    return lifecycleProgressResult(100, executionPercent, 'delivering', '完成', false);
  }

  let phase = requestedPhase;
  let label = lifecycleLabelForPhase(phase);
  if (['submitted', 'verifying'].includes(reviewState)) {
    phase = 'verifying';
    label = '验证中';
  } else if (reviewState === 'revision_requested') {
    phase = 'verifying';
    label = '等待修改';
  } else if (reviewState === 'reworking') {
    phase = 'verifying';
    label = '修改中';
  } else if (reviewState === 'action_required') {
    phase = 'verifying';
    label = '等待用户处理';
  } else if (reviewState === 'revision_exhausted') {
    phase = 'delivering';
    label = '准备交付当前版本';
  } else if (reviewState === 'accepted') {
    phase = 'delivering';
    label = '交付中';
  }
  return lifecycleProgressResult(
    lifecyclePercentForPhase(phase, executionPercent),
    executionPercent,
    phase,
    label,
    false,
  );
}

const TERMINAL_STATES = new Set(['accepted', 'revision_exhausted', 'failed']);

export function normalizeDeliveryReviewPolicy(value = {}) {
  const source = objectValue(value);
  const rawState = clean(source.state).toLowerCase();
  const maxQualityRevisions = boundedInteger(
    source.maxQualityRevisions ?? source.max_quality_revisions ?? DEFAULT_MAX_QUALITY_REVISIONS,
    20,
  );
  return {
    version: clean(source.version) || DELIVERY_REVIEW_POLICY_VERSION,
    state: DELIVERY_REVIEW_STATES.includes(rawState) ? rawState : 'submitted',
    maxQualityRevisions,
    qualityRevisionCount: boundedInteger(source.qualityRevisionCount ?? source.quality_revision_count, 20),
    executionAttemptCount: boundedInteger(source.executionAttemptCount ?? source.execution_attempt_count, 10_000),
    lastReviewEventId: clean(source.lastReviewEventId || source.last_review_event_id, 200),
    processedReviewEventIds: cleanStringArray(source.processedReviewEventIds || source.processed_review_event_ids,
      MAX_DELIVERY_REVIEW_EVENT_IDS, 200),
    failureCodes: cleanStringArray(source.failureCodes || source.failure_codes, 24, 120),
    failedChecks: normalizeFailedChecks(source.failedChecks || source.failed_checks),
    requiredChanges: cleanStringArray(source.requiredChanges || source.required_changes, 24, 500),
    preservedRequirements: cleanStringArray(source.preservedRequirements || source.preserved_requirements, 48, 500),
    revisionNumber: boundedInteger(source.revisionNumber ?? source.revision_number
      ?? source.qualityRevisionCount ?? source.quality_revision_count, 20),
    revisionLimit: maxQualityRevisions,
    updatedAt: isoTimestamp(source.updatedAt || source.updated_at),
  };
}

export function validateDeliveryReviewPolicy(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const review = normalizeDeliveryReviewPolicy(value);
  const diagnostics = [];
  if (review.version !== DELIVERY_REVIEW_POLICY_VERSION) {
    diagnostics.push(errorDiagnostic('delivery_review_version_unsupported', 'version', 'Unsupported delivery-review policy version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.state, allowedValues: DELIVERY_REVIEW_STATES,
    code: 'delivery_review_state_invalid', field: 'state', message: 'A delivery-review policy requires a supported state.' });
  if (review.maxQualityRevisions < 1) {
    diagnostics.push(errorDiagnostic('delivery_review_limit_invalid', 'maxQualityRevisions', 'At least one quality revision must be allowed.'));
  }
  if (review.qualityRevisionCount > review.maxQualityRevisions) {
    diagnostics.push(errorDiagnostic('delivery_review_count_exceeds_limit', 'qualityRevisionCount', 'The quality revision count cannot exceed its limit.'));
  }
  return finishValidation('delivery_review_policy_invalid', review, diagnostics, throwOnError);
}

export function normalizeFinalDeliveryPolicy(value = {}, fallback = {}) {
  const source = objectValue(value);
  const fallbackSource = objectValue(fallback);
  const rawState = clean(source.state).toLowerCase();
  let state = FINAL_DELIVERY_STATES.includes(rawState) ? rawState : '';
  if (!state) {
    const reviewState = clean(fallbackSource.deliveryReviewState || fallbackSource.reviewState).toLowerCase();
    const acceptanceSource = clean(fallbackSource.deliveryReviewOutcome || fallbackSource.acceptanceSource).toLowerCase();
    const failed = fallbackSource.deliveryFailed === true || reviewState === 'failed';
    state = failed ? 'failed'
      : acceptanceSource === 'owner_override' ? 'closed'
        : reviewState === 'accepted' ? 'delivered' : 'not_delivered';
  }
  const legacyTerminalAt = fallbackSource.deliveryValidatedAt || fallbackSource.deliveredAt
    || fallbackSource.updatedAt || fallbackSource.updated_at;
  const deliveredAt = isoTimestamp(source.deliveredAt || source.delivered_at || legacyTerminalAt);
  const userConfirmedAt = isoTimestamp(source.userConfirmedAt || source.user_confirmed_at
    || fallbackSource.userConfirmedAt || (state === 'closed' ? deliveredAt : ''));
  const closedAt = isoTimestamp(source.closedAt || source.closed_at
    || fallbackSource.deliveryClosedAt || (state === 'closed' ? userConfirmedAt || deliveredAt : ''));
  const failedAt = isoTimestamp(source.failedAt || source.failed_at || fallbackSource.deliveryFailedAt);
  return {
    version: clean(source.version) || FINAL_DELIVERY_POLICY_VERSION,
    state,
    deliveredAt,
    userConfirmedAt,
    closedAt,
    failedAt,
    failureReason: clean(source.failureReason || source.failure_reason || fallbackSource.failureReason, 1_000),
    retryable: source.retryable !== false && fallbackSource.retryable !== false,
    retryAttemptCount: boundedInteger(source.retryAttemptCount ?? source.retry_attempt_count, 1_000),
    lastEventId: clean(source.lastEventId || source.last_event_id, 200),
    processedEventIds: cleanStringArray(source.processedEventIds || source.processed_event_ids,
      MAX_FINAL_DELIVERY_EVENT_IDS, 200),
    updatedAt: isoTimestamp(source.updatedAt || source.updated_at),
  };
}

export function validateFinalDeliveryPolicy(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const policy = normalizeFinalDeliveryPolicy(value);
  const diagnostics = [];
  if (policy.version !== FINAL_DELIVERY_POLICY_VERSION) {
    diagnostics.push(errorDiagnostic('final_delivery_version_unsupported', 'version', 'Unsupported final-delivery policy version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.state, allowedValues: FINAL_DELIVERY_STATES,
    code: 'final_delivery_state_invalid', field: 'state', message: 'A final-delivery policy requires a supported state.' });
  if (policy.state === 'closed' && (!policy.userConfirmedAt || !policy.closedAt)) {
    diagnostics.push(errorDiagnostic('final_delivery_close_confirmation_required', 'state', 'A closed delivery requires user confirmation and close timestamps.'));
  }
  return finishValidation('final_delivery_policy_invalid', policy, diagnostics, throwOnError);
}

export function transitionFinalDelivery(value = {}, eventValue = {}) {
  const current = normalizeFinalDeliveryPolicy(value);
  const event = normalizeFinalDeliveryEvent(eventValue);
  if (!event.id || !FINAL_DELIVERY_EVENT_TYPES.includes(event.type)) {
    return { changed: false, duplicate: false, action: 'invalid_event', delivery: current };
  }
  if (current.lastEventId === event.id || current.processedEventIds.includes(event.id)) {
    return { changed: false, duplicate: true, action: 'duplicate', delivery: current };
  }
  if (!finalDeliveryEventAllowed(current.state, event.type)) {
    return { changed: false, duplicate: false, action: current.state === 'closed' ? 'terminal' : 'invalid_transition', delivery: current };
  }
  const next = {
    ...current,
    lastEventId: event.id,
    processedEventIds: [...current.processedEventIds, event.id].slice(-MAX_FINAL_DELIVERY_EVENT_IDS),
    updatedAt: event.occurredAt || current.updatedAt,
  };
  if (event.type === 'delivered') {
    next.state = 'delivered';
    next.deliveredAt = event.occurredAt || current.deliveredAt;
    next.failedAt = '';
    next.failureReason = '';
  }
  if (event.type === 'user_confirmed') {
    next.state = 'user_confirmed';
    next.userConfirmedAt = event.occurredAt || current.userConfirmedAt;
  }
  if (event.type === 'closed') {
    next.state = 'closed';
    next.closedAt = event.occurredAt || current.closedAt;
  }
  if (event.type === 'delivery_failed') {
    next.state = 'failed';
    next.failedAt = event.occurredAt || current.failedAt;
    next.failureReason = event.failureReason || current.failureReason || '交付失败。';
    next.retryable = event.retryable;
  }
  if (event.type === 'retry_started') {
    next.state = 'not_delivered';
    next.retryAttemptCount = current.retryAttemptCount + 1;
    next.failureReason = '';
    next.failedAt = '';
  }
  if (event.type === 'revision_requested') next.state = 'not_delivered';
  return { changed: JSON.stringify(next) !== JSON.stringify(current), duplicate: false, action: event.type, delivery: next };
}

export function transitionDeliveryReview(value = {}, eventValue = {}) {
  const current = normalizeDeliveryReviewPolicy(value);
  const event = normalizeReviewEvent(eventValue);
  if (!event.id || !DELIVERY_REVIEW_EVENT_TYPES.includes(event.type)) {
    return { changed: false, duplicate: false, action: 'invalid_event', review: current };
  }
  if (current.lastReviewEventId === event.id || current.processedReviewEventIds.includes(event.id)) {
    return { changed: false, duplicate: true, action: 'duplicate', review: current };
  }
  const terminalOverride = event.type === 'owner_accepted'
    || (event.type === 'revision_limit_delivered' && current.state === 'revision_exhausted');
  if (TERMINAL_STATES.has(current.state) && !terminalOverride) {
    return { changed: false, duplicate: false, action: 'terminal', review: current };
  }
  if (!reviewEventAllowed(current.state, event.type)) {
    return { changed: false, duplicate: false, action: 'invalid_transition', review: current };
  }
  const next = {
    ...current,
    lastReviewEventId: event.id,
    processedReviewEventIds: [...current.processedReviewEventIds, event.id].slice(-MAX_DELIVERY_REVIEW_EVENT_IDS),
    failureCodes: event.failureCodes,
    failedChecks: event.failedChecks,
    requiredChanges: event.requiredChanges,
    preservedRequirements: event.preservedRequirements.length ? event.preservedRequirements : current.preservedRequirements,
    updatedAt: event.occurredAt || current.updatedAt,
  };
  let action = event.type;
  if (event.type === 'submitted') next.state = 'submitted';
  if (event.type === 'verification_started') next.state = 'verifying';
  if (event.type === 'validation_passed') {
    next.state = 'accepted';
    next.failureCodes = [];
    next.failedChecks = [];
    next.requiredChanges = [];
  }
  if (event.type === 'validation_failed') {
    if (event.requiresUserAction) {
      next.state = 'action_required';
      action = 'user_action_required';
    } else if (!event.correctable) {
      next.state = 'failed';
      action = 'uncorrectable_failure';
    } else if (current.qualityRevisionCount < current.maxQualityRevisions) {
      next.state = 'revision_requested';
      next.qualityRevisionCount = current.qualityRevisionCount + 1;
      next.revisionNumber = next.qualityRevisionCount;
      action = 'revision_requested';
    } else {
      next.state = event.hardContract ? 'action_required' : 'revision_exhausted';
      action = 'revision_exhausted';
    }
  }
  if (event.type === 'rework_started') next.state = 'reworking';
  if (event.type === 'user_action_required') next.state = 'action_required';
  if (event.type === 'verification_uncertain') {
    next.state = 'action_required';
    action = 'verification_uncertain';
  }
  if (event.type === 'execution_failed') {
    next.state = 'failed';
    next.executionAttemptCount = current.executionAttemptCount + 1;
  }
  if (event.type === 'owner_accepted') {
    next.state = 'accepted';
    action = 'owner_accepted';
  }
  if (event.type === 'revision_limit_delivered') {
    next.state = 'accepted';
    action = 'revision_limit_delivered';
  }
  return { changed: JSON.stringify(next) !== JSON.stringify(current), duplicate: false, action, review: next };
}

function reviewEventAllowed(state, eventType) {
  if (eventType === 'owner_accepted') return DELIVERY_REVIEW_STATES.includes(state);
  if (eventType === 'revision_limit_delivered') return state === 'revision_exhausted';
  if (eventType === 'submitted') return ['submitted', 'revision_requested', 'reworking', 'action_required'].includes(state);
  if (eventType === 'verification_started') return ['submitted', 'reworking'].includes(state);
  if (['validation_passed', 'validation_failed'].includes(eventType)) return state === 'verifying';
  if (eventType === 'rework_started') return state === 'revision_requested';
  if (['user_action_required', 'verification_uncertain'].includes(eventType)) {
    return ['submitted', 'verifying', 'revision_requested', 'reworking'].includes(state);
  }
  if (eventType === 'execution_failed') return true;
  return false;
}

function finalDeliveryEventAllowed(state, eventType) {
  if (eventType === 'delivered') return ['not_delivered', 'failed'].includes(state);
  if (eventType === 'user_confirmed') return state === 'delivered';
  if (eventType === 'closed') return state === 'user_confirmed';
  if (eventType === 'delivery_failed') return ['not_delivered', 'delivered', 'failed'].includes(state);
  if (eventType === 'retry_started') return state === 'failed';
  if (eventType === 'revision_requested') return state === 'delivered';
  return false;
}

function normalizeReviewEvent(value = {}) {
  const source = objectValue(value);
  return {
    id: clean(source.id || source.eventId || source.event_id, 200),
    type: clean(source.type || source.eventType || source.event_type).toLowerCase(),
    correctable: source.correctable !== false,
    requiresUserAction: Boolean(source.requiresUserAction || source.requires_user_action),
    hardContract: Boolean(source.hardContract || source.hard_contract),
    failureCodes: cleanStringArray(source.failureCodes || source.failure_codes, 24, 120),
    failedChecks: normalizeFailedChecks(source.failedChecks || source.failed_checks),
    requiredChanges: cleanStringArray(source.requiredChanges || source.required_changes, 24, 500),
    preservedRequirements: cleanStringArray(source.preservedRequirements || source.preserved_requirements, 48, 500),
    occurredAt: isoTimestamp(source.occurredAt || source.occurred_at),
  };
}

function normalizeFinalDeliveryEvent(value = {}) {
  const source = objectValue(value);
  return {
    id: clean(source.id || source.eventId || source.event_id, 200),
    type: clean(source.type || source.eventType || source.event_type).toLowerCase(),
    failureReason: clean(source.failureReason || source.failure_reason || source.message, 1_000),
    retryable: source.retryable !== false,
    occurredAt: isoTimestamp(source.occurredAt || source.occurred_at) || new Date().toISOString(),
  };
}

function normalizeFailedChecks(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 24).map((item, index) => {
    if (typeof item === 'string') return { code: `check_${index + 1}`, summary: clean(item, 500) };
    const source = objectValue(item);
    return {
      code: clean(source.code || source.id || `check_${index + 1}`, 120),
      summary: clean(source.summary || source.message || source.reason, 500),
      requirement: clean(source.requirement || source.criterion, 500),
      evidence: clean(source.evidence || source.detail, 1000),
    };
  }).filter((item) => item.summary || item.requirement || item.evidence);
}

function cleanStringArray(value = [], maximum = 24, itemLength = 240) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = clean(item, itemLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
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

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function normalizeLifecyclePhase(value = '', taskStatus = '', reviewState = '') {
  const phase = clean(value).toLowerCase();
  if (phase === 'coordinating' || phase === 'waiting_for_agents') return 'executing';
  if (['confirming', 'planning', 'executing', 'verifying', 'delivering', 'delivered'].includes(phase)) return phase;
  if (['submitted', 'verifying', 'revision_requested', 'reworking', 'action_required'].includes(reviewState)) return 'verifying';
  if (reviewState === 'accepted' || reviewState === 'revision_exhausted') return 'delivering';
  if (taskStatus === 'verifying') return 'verifying';
  if (['draft_ready', 'awaiting_delivery', 'delivering', 'submitted', 'completed', 'closed', 'result_accepted'].includes(taskStatus)) return 'delivering';
  if (['pending', 'ready', 'queued', 'running', 'working', 'waiting', 'blocked', 'cancelling', 'failed', 'cancelled'].includes(taskStatus)) return 'executing';
  return 'confirming';
}

function lifecyclePercentForPhase(phase = '', executionPercent = 0) {
  if (phase === 'planning') return 15;
  if (phase === 'executing') return Math.round(25 + (clampPercent(executionPercent) * 0.5));
  if (phase === 'verifying') return 85;
  if (phase === 'delivering') return 90;
  if (phase === 'delivered') return 95;
  return 5;
}

function lifecycleLabelForPhase(phase = '') {
  return ({
    confirming: '确认目标中',
    planning: '规划中',
    executing: '执行中',
    verifying: '验证中',
    delivering: '交付中',
    delivered: '待确认交付',
  })[phase] || '处理中';
}

function lifecycleProgressResult(percent, executionPercent, phase, label, confirmationRequired) {
  return {
    percent: clampPercent(percent),
    executionPercent: clampPercent(executionPercent),
    phase,
    label,
    confirmationRequired: Boolean(confirmationRequired),
  };
}

function isoTimestamp(value = '') {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
