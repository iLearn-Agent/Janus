import { deriveTaskLifecycleProgress } from './uBuddyDeliveryReview.js';

export const DELEGATION_STATUSES = Object.freeze([
  'assigned', 'preparing', 'awaiting_approval', 'accepted', 'running', 'working', 'draft_ready',
  'submitted', 'revision_requested', 'result_accepted', 'blocked', 'declined', 'withdrawn',
  'closed', 'completed', 'rejected', 'failed',
]);

export const DELEGATION_PROGRESS_PHASES = Object.freeze([
  'queued', 'preparing', 'planning', 'executing', 'verifying',
  'waiting', 'awaiting_delivery', 'delivering', 'delivered', 'blocked', 'failed',
]);

const DELEGATION_ACTION_TRANSITIONS = Object.freeze({
  publish: new Set(['assigned', 'preparing', 'awaiting_approval']),
  update_requirements: new Set(['assigned', 'preparing', 'awaiting_approval', 'accepted', 'working', 'running', 'draft_ready', 'submitted', 'revision_requested', 'result_accepted', 'blocked']),
  withdraw: new Set(['assigned', 'preparing', 'awaiting_approval', 'accepted', 'running', 'working', 'draft_ready', 'submitted', 'revision_requested', 'blocked', 'failed']),
  working: new Set(['assigned', 'accepted', 'running', 'revision_requested', 'blocked', 'failed', 'draft_ready']),
  submit: new Set(['working', 'running', 'draft_ready', 'revision_requested', 'blocked']),
  decline: new Set(['assigned', 'working', 'running', 'revision_requested', 'blocked']),
  blocked: new Set(['assigned', 'working', 'running', 'revision_requested', 'draft_ready']),
  accept_result: new Set(['submitted']),
  request_revision: new Set(['submitted', 'result_accepted']),
});

const PRIVATE_DELEGATION_METADATA_KEYS = Object.freeze([
  'preliminaryResult', 'intakeSummary', 'threadId', 'answerMessageId', 'sessionId', 'workspaceSessionId',
  'taskWorkspaceRoot', 'generatedTaskFiles', 'ownerConfirmationRequired', 'safePreparationOnly',
  'specializedExecutionError', 'recoveryExecutionError', 'deterministicRecovery',
  'workspaceUpdatedAt', 'workspaceExecutionError', 'workspaceExecutionFailedAt', 'workspaceRevisionRecovered',
  'ubuddyTeamCoordination', 'sourceSecretarySessionId', 'sourceSecretaryMessageId', 'ownerSecretarySessionId', 'ownerSecretaryMessageId',
  'executionEpoch', 'taskOrigin', 'workspaceEpoch', 'workspaceRepairedAt',
  'previousWorkspaceSessionId', 'activeTaskRunId', 'attemptTaskRunIds', 'executionFailureDetail',
  'syncState', 'syncError', 'pendingRemoteUpdate', 'pendingWorkspaceSync',
  'pendingSharedWorkspaceSync', 'sharedWorkspaceSyncError',
  'source_conversation_id', 'sourceConversationId', 'source_message_id', 'sourceMessageId',
  'source_group_id', 'sourceGroupId',
  'workDigestJobId', 'workDigestState', 'workDigestCoverage', 'workDigestExpiresAt', 'workDigestDraftVersionId',
]);

export function isDelegationStatus(value = '') {
  return DELEGATION_STATUSES.includes(String(value || '').trim().toLowerCase());
}

export function normalizeDelegationStatus(value = '') {
  const status = String(value || '').trim().toLowerCase();
  return isDelegationStatus(status) ? status : 'assigned';
}

export function delegationTransitionAllowed(status = '', action = '') {
  return Boolean(DELEGATION_ACTION_TRANSITIONS[action]?.has(status));
}

export function nextDelegationStatus(status = '', action = '') {
  if (action === 'publish') return 'assigned';
  if (action === 'update_requirements') return ['assigned', 'preparing', 'awaiting_approval'].includes(status) ? 'assigned' : 'revision_requested';
  return ({ withdraw: 'withdrawn', working: 'working', submit: 'submitted', decline: 'declined', blocked: 'blocked', accept_result: 'result_accepted', request_revision: 'revision_requested' })[action] || '';
}

export function legacyDelegationTransitionAllowed(from = '', to = '') {
  if (from === to) return true;
  const allowed = {
    assigned: ['preparing', 'accepted', 'running', 'working', 'draft_ready', 'blocked', 'completed', 'rejected', 'failed'],
    preparing: ['assigned', 'running', 'working', 'draft_ready', 'blocked', 'failed'],
    accepted: ['running', 'working', 'draft_ready', 'blocked', 'completed', 'failed'],
    running: ['assigned', 'accepted', 'working', 'draft_ready', 'blocked', 'completed', 'failed'],
    working: ['running', 'draft_ready', 'blocked', 'completed', 'failed'],
    revision_requested: ['running', 'working', 'draft_ready', 'completed', 'failed'],
    blocked: ['running', 'working', 'draft_ready', 'failed'],
    failed: ['running', 'working'],
    draft_ready: ['running', 'working', 'blocked', 'completed', 'failed'],
  };
  return Boolean(allowed[from]?.includes(to));
}

export function publicDelegationMetadata(metadata = {}) {
  const result = { ...(metadata && typeof metadata === 'object' ? metadata : {}) };
  for (const key of PRIVATE_DELEGATION_METADATA_KEYS) delete result[key];
  if (Object.prototype.hasOwnProperty.call(result, 'executionProgress')) {
    result.executionProgress = normalizeDelegationExecutionProgress(result.executionProgress);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'publicFailure')) {
    result.publicFailure = normalizeDelegationPublicFailure(result.publicFailure);
  }
  if (Object.prototype.hasOwnProperty.call(result, 'agentWorkStatusProjection')) {
    const projection = publicAgentWorkStatusProjectionEnvelope(result.agentWorkStatusProjection);
    if (projection.scopeKind === 'delegation' && projection.scopeId) result.agentWorkStatusProjection = projection;
    else delete result.agentWorkStatusProjection;
  }
  return result;
}

export function privateDelegationMetadata(metadata = {}) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  const result = {};
  for (const key of PRIVATE_DELEGATION_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  }
  return result;
}

export function privateWorkspaceMessageMetadata(metadata = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  return { ...source, privateTaskWorkspace: true };
}

export function normalizeDelegationExecutionProgress(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawPhase = String(value.phase || '').trim().toLowerCase();
  const phase = DELEGATION_PROGRESS_PHASES.includes(rawPhase) ? rawPhase : 'preparing';
  const total = boundedProgressNumber(value.total, 10_000);
  const completed = Math.min(total || 10_000, boundedProgressNumber(value.completed, 10_000));
  const currentStep = value.currentStep && typeof value.currentStep === 'object' && !Array.isArray(value.currentStep)
    ? {
        title: sanitizeDelegationPublicText(value.currentStep.title, 240),
        status: sanitizeDelegationPublicText(value.currentStep.status, 40),
        agentName: sanitizeDelegationPublicText(value.currentStep.agentName, 120),
      }
    : null;
  const nodes = normalizeDelegationProgressNodes(value.nodes);
  const milestones = normalizeDelegationProgressMilestones(value.milestones);
  const blocker = normalizeDelegationProgressBlocker(value.blocker);
  const executionPercent = Number.isFinite(Number(value.executionPercent))
    ? boundedProgressNumber(value.executionPercent, 100)
    : total ? Math.round((completed / total) * 100) : 0;
  const lifecycle = deriveTaskLifecycleProgress({
    phase: value.lifecyclePhase || phase,
    taskStatus: value.taskStatus || '',
    executionPercent,
    reviewState: value.reviewState || '',
    finalDeliveryState: value.finalDeliveryState || '',
    confirmationRequired: value.confirmationRequired === true,
  });
  const percent = Number.isFinite(Number(value.percent))
    ? boundedProgressNumber(value.percent, 100)
    : lifecycle.percent;
  return {
    version: 2,
    sequence: boundedProgressNumber(value.sequence, Number.MAX_SAFE_INTEGER),
    phase,
    taskStatus: sanitizeDelegationPublicText(value.taskStatus || value.task_status, 40),
    failureStage: sanitizeDelegationPublicText(value.failureStage || value.failure_stage, 80),
    outputDisposition: sanitizeDelegationPublicText(value.outputDisposition || value.output_disposition, 40),
    reviewState: sanitizeDelegationPublicText(value.reviewState || value.review_state, 40),
    message: sanitizeDelegationPublicText(value.message, 600),
    completed,
    total,
    executionPercent,
    percent,
    lifecyclePhase: sanitizeDelegationPublicText(value.lifecyclePhase || lifecycle.phase, 40),
    label: sanitizeDelegationPublicText(value.label || lifecycle.label, 80),
    confirmationRequired: value.confirmationRequired === true,
    running: boundedProgressNumber(value.running, 10_000),
    waiting: boundedProgressNumber(value.waiting, 10_000),
    failed: boundedProgressNumber(value.failed, 10_000),
    currentStep: currentStep?.title || currentStep?.status || currentStep?.agentName ? currentStep : null,
    nodes,
    milestones,
    blocker,
    updatedAt: normalizeDelegationTimestamp(value.updatedAt),
    terminal: Boolean(value.terminal || ['delivered', 'blocked', 'failed'].includes(phase)),
  };
}

function normalizeDelegationProgressNodes(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const title = sanitizeDelegationPublicText(node.title, 240);
    const status = sanitizeDelegationPublicText(node.status, 40);
    if (!title && !status) return null;
    return {
      id: sanitizeDelegationPublicText(node.id, 160),
      title: title || '任务节点',
      agentName: sanitizeDelegationPublicText(node.agentName, 120),
      status: status || 'pending',
      outputDisposition: sanitizeDelegationPublicText(node.outputDisposition || node.output_disposition, 40),
      summary: sanitizeDelegationPublicText(node.summary, 600),
      attemptCount: boundedProgressNumber(node.attemptCount, 100),
      maxAttempts: boundedProgressNumber(node.maxAttempts, 100),
      nextRetryAt: node.nextRetryAt ? normalizeDelegationTimestamp(node.nextRetryAt) : '',
      startedAt: node.startedAt ? normalizeDelegationTimestamp(node.startedAt) : '',
      completedAt: node.completedAt ? normalizeDelegationTimestamp(node.completedAt) : '',
      updatedAt: node.updatedAt ? normalizeDelegationTimestamp(node.updatedAt) : '',
    };
  }).filter(Boolean);
}

function normalizeDelegationProgressMilestones(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((milestone) => {
    if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) return null;
    const title = sanitizeDelegationPublicText(milestone.title, 240);
    const detail = sanitizeDelegationPublicText(milestone.detail, 600);
    if (!title && !detail) return null;
    return {
      key: sanitizeDelegationPublicText(milestone.key, 240),
      status: sanitizeDelegationPublicText(milestone.status, 40) || 'running',
      title: title || '任务进展',
      detail,
      agentName: sanitizeDelegationPublicText(milestone.agentName, 120),
      eventType: sanitizeDelegationPublicText(milestone.eventType || milestone.event_type, 80),
      sequence: boundedProgressNumber(milestone.sequence, Number.MAX_SAFE_INTEGER),
      occurredAt: normalizeDelegationTimestamp(milestone.occurredAt || milestone.occurred_at),
    };
  }).filter(Boolean);
}

function normalizeDelegationProgressBlocker(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = sanitizeDelegationPublicText(value.summary, 800);
  const suggestedNextStep = sanitizeDelegationPublicText(value.suggestedNextStep, 600);
  if (!summary && !suggestedNextStep) return null;
  return {
    nodeId: sanitizeDelegationPublicText(value.nodeId, 160),
    summary: summary || '当前节点暂时无法继续。',
    errorCode: sanitizeDelegationPublicText(value.errorCode, 120),
    attemptCount: boundedProgressNumber(value.attemptCount, 100),
    maxAttempts: boundedProgressNumber(value.maxAttempts, 100),
    nextRetryAt: value.nextRetryAt ? normalizeDelegationTimestamp(value.nextRetryAt) : '',
    suggestedNextStep,
    retryable: value.retryable !== false,
    userActionRequired: value.userActionRequired === true || value.requiresUserAction === true,
    requiresUserAction: value.requiresUserAction === true || value.userActionRequired === true,
  };
}

export function normalizeDelegationPublicFailure(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = sanitizeDelegationPublicText(value.message, 800);
  const code = sanitizeDelegationPublicText(value.code, 120);
  const stage = sanitizeDelegationPublicText(value.stage, 120);
  if (!message && !code && !stage) return null;
  return {
    code,
    stage,
    message: message || 'uBuddy 处理任务时遇到问题，任务已暂停等待处理。',
    retryable: value.retryable !== false,
    occurredAt: normalizeDelegationTimestamp(value.occurredAt),
  };
}

export function publicDelegationSubmissionText(value = '') {
  const hiddenPath = '[本地路径已隐藏]';
  const text = String(value || '')
    .replace(/\n*#{1,6}\s*执行记录\s*\n[\s\S]*?(?=\n#{1,6}\s|$)/gi, '')
    .replace(/^.*(?:Process timed out after \d+ms:|spawn\s+[^\s]+\s+ENOENT|codex[^\n]{0,120}(?:timed out|timeout)).*$/gim, '')
    .replace(/\/(?:home|Users|tmp|opt|private\/var|var\/folders)\/[^\s<>"'`，。；;）)]+/g, hiddenPath)
    .replace(/[A-Za-z]:\\(?:Users|Temp|Windows\\Temp|ProgramData)\\[^\s<>"'`，。；;）)]+/g, hiddenPath)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || 'uBuddy 已保留可编辑任务草稿和交付文件，请结合当前任务要求继续验收或提出修改。';
}

function boundedProgressNumber(value, maximum) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(maximum, number));
}

function normalizeDelegationTimestamp(value = '') {
  const timestamp = new Date(value || Date.now());
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : new Date().toISOString();
}

function sanitizeDelegationPublicText(value = '', maximum = 600) {
  return String(value || '')
    .replace(/\/(?:home|Users|tmp|opt|private\/var|var\/folders)\/[^\s<>"'`，。；;）)]+/g, '[本地路径已隐藏]')
    .replace(/[A-Za-z]:\\(?:Users|Temp|Windows\\Temp|ProgramData)\\[^\s<>"'`，。；;）)]+/g, '[本地路径已隐藏]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}
import { publicAgentWorkStatusProjectionEnvelope } from './uBuddyWorkStatus.js';
