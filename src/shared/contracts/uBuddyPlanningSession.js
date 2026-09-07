export const UBUDDY_PLANNING_SESSION_VERSION = 'UBUDDY_PLANNING_SESSION_V1';
export const UBUDDY_PLANNING_DECISION_VERSION = 'UBUDDY_PLANNING_DECISION_V1';

export const UBUDDY_PLANNING_STATUSES = Object.freeze([
  'planning',
  'awaiting_clarification',
  'awaiting_confirmation',
  'ready_to_dispatch',
  'dispatching',
  'dispatched',
  'retryable_failure',
  'cancelled',
  'superseded',
]);

const DECISIONS = new Set(['direct_answer', 'awaiting_clarification', 'ready_for_dispatch']);
const TARGET_KINDS = new Set(['direct', 'local_agent', 'external_delegation', 'task_group']);
const ASSIGNEE_KINDS = new Set(['self', 'user', 'agent']);

export function normalizeUBuddyPlanningDecision(value = {}) {
  const source = objectValue(value);
  const target = objectValue(source.target);
  const readiness = objectValue(source.readiness);
  const collaboration = objectValue(source.collaboration);
  return {
    version: clean(source.version, 80) || UBUDDY_PLANNING_DECISION_VERSION,
    decision: clean(source.decision, 40).toLowerCase(),
    confidence: bounded(source.confidence),
    answer: clean(source.answer, 12_000),
    intake: objectOrNull(source.intake),
    target: {
      kind: clean(target.kind, 80).toLowerCase(),
      candidateUserIds: uniqueIds(target.candidateUserIds || target.candidate_user_ids),
      requiredUserIds: uniqueIds(target.requiredUserIds || target.required_user_ids),
      selectedUserIds: uniqueIds(target.selectedUserIds || target.selected_user_ids),
      selectedAgentInstanceIds: uniqueIds(target.selectedAgentInstanceIds || target.selected_agent_instance_ids),
    },
    collaboration: {
      mode: clean(collaboration.mode, 80).toLowerCase(),
      initiatorParticipation: clean(collaboration.initiatorParticipation || collaboration.initiator_participation, 80).toLowerCase(),
      participantSelectionIntent: clean(collaboration.participantSelectionIntent || collaboration.participant_selection_intent, 40).toLowerCase(),
      assignmentIntent: clean(collaboration.assignmentIntent || collaboration.assignment_intent, 40).toLowerCase() || 'auto',
    },
    assignments: normalizeAssignments(source.assignments),
    clarifications: normalizeClarifications(source.clarifications),
    readiness: {
      status: clean(readiness.status, 40).toLowerCase(),
      reason: clean(readiness.reason, 1000),
      knownFacts: cleanStrings(readiness.knownFacts || readiness.known_facts, 40, 500),
      safeAssumptions: cleanStrings(readiness.safeAssumptions || readiness.safe_assumptions, 40, 500),
      criticalUnknowns: cleanStrings(readiness.criticalUnknowns || readiness.critical_unknowns, 40, 500),
    },
    riskLevel: clean(source.riskLevel || source.risk_level, 40).toLowerCase() || 'low',
    rationale: clean(source.rationale, 2000),
  };
}

export function validateUBuddyPlanningDecision(value = {}, {
  allowedUserIds = [], allowedAgentInstanceIds = [], throwOnError = false,
} = {}) {
  const decision = normalizeUBuddyPlanningDecision(value);
  const diagnostics = [];
  if (decision.version !== UBUDDY_PLANNING_DECISION_VERSION) diagnostics.push(error('planning_decision_version_invalid', 'version'));
  if (!DECISIONS.has(decision.decision)) diagnostics.push(error('planning_decision_invalid', 'decision'));
  if (!TARGET_KINDS.has(decision.target.kind)) diagnostics.push(error('planning_target_kind_invalid', 'target.kind'));
  const allowedUsers = new Set(uniqueIds(allowedUserIds));
  const allowedAgents = new Set(uniqueIds(allowedAgentInstanceIds));
  for (const id of [...decision.target.candidateUserIds, ...decision.target.requiredUserIds, ...decision.target.selectedUserIds]) {
    if (!allowedUsers.has(id)) diagnostics.push(error('planning_user_not_authorized', 'target'));
  }
  for (const id of decision.target.selectedAgentInstanceIds) {
    if (!allowedAgents.has(id)) diagnostics.push(error('planning_agent_not_authorized', 'target.selectedAgentInstanceIds'));
  }
  const candidateUsers = new Set(decision.target.candidateUserIds);
  for (const id of [...decision.target.requiredUserIds, ...decision.target.selectedUserIds]) {
    if (!candidateUsers.has(id)) diagnostics.push(error('planning_selected_user_not_candidate', 'target'));
  }
  if (decision.decision === 'awaiting_clarification' && !decision.clarifications.length) {
    diagnostics.push(error('planning_clarifications_missing', 'clarifications'));
  }
  if (decision.decision === 'ready_for_dispatch') {
    if (!decision.intake) diagnostics.push(error('planning_intake_missing', 'intake'));
    if (decision.clarifications.length) diagnostics.push(error('planning_ready_has_clarifications', 'clarifications'));
    if (decision.readiness.status !== 'ready' || decision.readiness.criticalUnknowns.length) {
      diagnostics.push(error('planning_readiness_invalid', 'readiness'));
    }
    if (decision.target.kind === 'direct') diagnostics.push(error('planning_ready_target_direct', 'target.kind'));
    if (decision.target.kind === 'local_agent' && !decision.target.selectedAgentInstanceIds.length) {
      diagnostics.push(error('planning_local_agent_missing', 'target.selectedAgentInstanceIds'));
    }
    if (['external_delegation', 'task_group'].includes(decision.target.kind) && !decision.target.selectedUserIds.length) {
      diagnostics.push(error('planning_external_users_missing', 'target.selectedUserIds'));
    }
    if (!decision.assignments.length) diagnostics.push(error('planning_assignments_missing', 'assignments'));
  }
  const assignmentIdList = decision.assignments.map((item) => item.assignmentId);
  const assignmentIds = new Set(assignmentIdList);
  if (assignmentIds.size !== assignmentIdList.length) diagnostics.push(error('planning_assignment_id_duplicate', 'assignments.assignmentId'));
  for (const assignment of decision.assignments) {
    if (!ASSIGNEE_KINDS.has(assignment.assigneeKind)) {
      diagnostics.push(error('planning_assignment_assignee_kind_invalid', 'assignments.assigneeKind'));
    }
    if (assignment.assigneeKind === 'user' && !decision.target.selectedUserIds.includes(assignment.userId)) {
      diagnostics.push(error('planning_assignment_user_not_selected', 'assignments'));
    }
    if (assignment.assigneeKind === 'agent' && !decision.target.selectedAgentInstanceIds.includes(assignment.agentInstanceId)) {
      diagnostics.push(error('planning_assignment_agent_not_selected', 'assignments'));
    }
    for (const dependency of assignment.dependencies) {
      if (!assignmentIds.has(dependency) || dependency === assignment.assignmentId) {
        diagnostics.push(error('planning_assignment_dependency_invalid', 'assignments.dependencies'));
      }
    }
  }
  if (decision.decision === 'ready_for_dispatch') validateReadyAssignments(decision, diagnostics);
  if (hasCycle(decision.assignments)) diagnostics.push(error('planning_assignment_cycle', 'assignments.dependencies'));
  if (diagnostics.length && throwOnError) {
    const failure = new Error(`Invalid uBuddy planning decision: ${diagnostics.map((item) => item.code).join(', ')}`);
    failure.code = 'ubuddy_planning_decision_invalid';
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return { valid: diagnostics.length === 0, value: decision, diagnostics };
}

function validateReadyAssignments(decision, diagnostics) {
  const targetKind = decision.target.kind;
  const userAssignments = decision.assignments.filter((item) => item.assigneeKind === 'user');
  const agentAssignments = decision.assignments.filter((item) => item.assigneeKind === 'agent');
  const selfAssignments = decision.assignments.filter((item) => item.assigneeKind === 'self');
  if (targetKind === 'local_agent') {
    if (decision.target.selectedUserIds.length || userAssignments.length || selfAssignments.length) {
      diagnostics.push(error('planning_local_assignment_kind_invalid', 'assignments'));
    }
    for (const id of decision.target.selectedAgentInstanceIds) {
      if (!agentAssignments.some((item) => item.agentInstanceId === id)) {
        diagnostics.push(error('planning_selected_agent_unassigned', 'assignments'));
      }
    }
    return;
  }
  if (!['external_delegation', 'task_group'].includes(targetKind)) return;
  if (decision.target.selectedAgentInstanceIds.length || agentAssignments.length) {
    diagnostics.push(error('planning_external_agent_assignment_unsupported', 'assignments'));
  }
  if (targetKind === 'external_delegation' && decision.target.selectedUserIds.length !== 1) {
    diagnostics.push(error('planning_external_user_count_invalid', 'target.selectedUserIds'));
  }
  for (const id of decision.target.selectedUserIds) {
    const count = userAssignments.filter((item) => item.userId === id).length;
    if (count !== 1) diagnostics.push(error('planning_selected_user_assignment_invalid', 'assignments'));
  }
  if (decision.collaboration.mode === 'manager_delegation' && selfAssignments.length) {
    diagnostics.push(error('planning_manager_self_assignment_invalid', 'assignments'));
  }
  if (decision.collaboration.mode === 'peer_collaboration' && selfAssignments.length !== 1) {
    diagnostics.push(error('planning_peer_self_assignment_invalid', 'assignments'));
  }
}

export function createUBuddyPlanningCheckpoint({
  planningSessionId = '', revision = 1, status = 'planning', decision = null,
  ownerUserId = '', accountWorkspaceId = '', sourceSessionId = '', sourceMessageId = '',
  threadEpoch = 1, engineVersion = 'continuous_v1', updatedAt = new Date().toISOString(),
} = {}) {
  const checkpoint = {
    version: UBUDDY_PLANNING_SESSION_VERSION,
    planningSessionId: clean(planningSessionId, 240),
    revision: Math.max(1, Number(revision || 1)),
    status: clean(status, 40).toLowerCase(),
    ownerUserId: clean(ownerUserId, 160),
    accountWorkspaceId: clean(accountWorkspaceId, 160),
    sourceSessionId: clean(sourceSessionId, 240),
    sourceMessageId: clean(sourceMessageId, 240),
    threadEpoch: Math.max(1, Number(threadEpoch || 1)),
    engineVersion: clean(engineVersion, 80),
    decision: decision ? normalizeUBuddyPlanningDecision(decision) : null,
    updatedAt: iso(updatedAt) || new Date().toISOString(),
  };
  const diagnostics = [];
  if (!checkpoint.planningSessionId) diagnostics.push(error('planning_session_id_missing', 'planningSessionId'));
  if (!UBUDDY_PLANNING_STATUSES.includes(checkpoint.status)) diagnostics.push(error('planning_session_status_invalid', 'status'));
  if (!checkpoint.ownerUserId || !checkpoint.accountWorkspaceId || !checkpoint.sourceSessionId) {
    diagnostics.push(error('planning_session_scope_incomplete', 'scope'));
  }
  if (diagnostics.length) {
    const failure = new Error(`Invalid uBuddy planning checkpoint: ${diagnostics.map((item) => item.code).join(', ')}`);
    failure.code = 'ubuddy_planning_checkpoint_invalid';
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return checkpoint;
}

export function uBuddyPlanningDecisionDigest(value = {}) {
  return stableHash(JSON.stringify(canonicalValue(normalizeUBuddyPlanningDecision(value))));
}

function normalizeAssignments(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((item, index) => {
    const source = objectValue(item);
    return {
      assignmentId: clean(source.assignmentId || source.assignment_id || `assignment_${index + 1}`, 160),
      assigneeKind: clean(source.assigneeKind || source.assignee_kind, 40).toLowerCase(),
      userId: clean(source.userId || source.user_id, 160),
      agentInstanceId: clean(source.agentInstanceId || source.agent_instance_id, 160),
      title: clean(source.title, 240),
      objective: clean(source.objective, 4000),
      deliverables: cleanStrings(source.deliverables, 24, 500),
      dependencies: uniqueIds(source.dependencies),
    };
  }).filter((item) => item.assignmentId && item.title && item.objective);
}

function normalizeClarifications(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 12).map((item, index) => {
    const source = objectValue(item);
    return {
      id: clean(source.id || source.questionId || `question_${index + 1}`, 120),
      header: clean(source.header, 120),
      question: clean(source.question, 1000),
      reason: clean(source.reason, 500),
      answerType: clean(source.answerType || source.answer_type, 40) || 'single_choice',
      options: (Array.isArray(source.options) ? source.options : []).slice(0, 8).map((option) => {
        const normalized = typeof option === 'string' ? { value: option, label: option } : objectValue(option);
        return { value: clean(normalized.value || normalized.label, 240), label: clean(normalized.label || normalized.value, 240), description: clean(normalized.description, 500) };
      }).filter((option) => option.value && option.label),
      allowOther: source.allowOther !== false,
      required: source.required !== false,
    };
  }).filter((item) => item.id && item.question);
}

function hasCycle(assignments) {
  const edges = new Map(assignments.map((item) => [item.assignmentId, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of edges.get(id) || []) if (visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return assignments.some((item) => visit(item.assignmentId));
}

function uniqueIds(value = []) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 160)).filter(Boolean))]; }
function cleanStrings(value, limit, size) { return (Array.isArray(value) ? value : []).map((item) => clean(item, size)).filter(Boolean).slice(0, limit); }
function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function objectOrNull(value) { const result = objectValue(value); return Object.keys(result).length ? result : null; }
function clean(value, limit = 1000) { return String(value || '').trim().slice(0, limit); }
function bounded(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0; }
function iso(value) { const text = clean(value, 80); return text && Number.isFinite(Date.parse(text)) ? new Date(Date.parse(text)).toISOString() : ''; }
function error(code, field) { return { code, field }; }
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
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
