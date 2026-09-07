export const UBUDDY_COLLABORATION_MODE_DECISION_VERSION = 'UBUDDY_COLLABORATION_MODE_DECISION_V1';
export const UBUDDY_COLLABORATION_PLAN_VERSION = 'UBUDDY_COLLABORATION_PLAN_V1';
export const UBUDDY_COLLABORATION_CLARIFICATION_VERSION = 'UBUDDY_COLLABORATION_CLARIFICATION_V1';
export const UBUDDY_COLLABORATION_MODE_CONFIDENCE = 0.8;

const MODES = new Set(['manager_delegation', 'peer_collaboration']);
const PARTICIPATION = new Set(['coordinator_only', 'coordinator_and_worker']);
const ASSIGNMENT_INTENTS = new Set(['explicit', 'auto']);
const PARTICIPANT_SELECTION_INTENTS = new Set(['all', 'auto']);
const PLAN_STATUSES = new Set(['awaiting_confirmation', 'confirmed', 'superseded', 'cancelled']);
const CLARIFICATION_STATUSES = new Set(['pending', 'resolved', 'cancelled']);
const EXECUTION_STRATEGIES = new Set(['complementary', 'independent_validation']);

export function validateUBuddyCollaborationClarification(value = {}, { throwOnError = true } = {}) {
  const source = objectValue(value);
  const clarification = {
    version: clean(source.version, 120),
    status: clean(source.status, 40).toLowerCase(),
    continuationId: clean(source.continuationId || source.continuation_id, 240),
    proposalId: clean(source.proposalId || source.proposal_id, 240),
    sourceMessageId: clean(source.sourceMessageId || source.source_message_id, 240),
    reasonCode: clean(source.reasonCode || source.reason_code, 120),
    question: clean(source.question, 1000),
    options: cleanStrings(source.options, 4, 160),
    candidateUserIds: uniqueIds(source.candidateUserIds || source.candidate_user_ids),
    requiredUserIds: uniqueIds(source.requiredUserIds || source.required_user_ids),
    createdAt: iso(source.createdAt || source.created_at) || new Date().toISOString(),
  };
  const diagnostics = [];
  if (clarification.version !== UBUDDY_COLLABORATION_CLARIFICATION_VERSION) {
    diagnostics.push(error('collaboration_clarification_version_invalid', 'version'));
  }
  if (!CLARIFICATION_STATUSES.has(clarification.status)) {
    diagnostics.push(error('collaboration_clarification_status_invalid', 'status'));
  }
  if (!clarification.continuationId) diagnostics.push(error('collaboration_clarification_id_missing', 'continuationId'));
  if (!clarification.proposalId) diagnostics.push(error('collaboration_clarification_proposal_missing', 'proposalId'));
  if (!clarification.sourceMessageId) diagnostics.push(error('collaboration_clarification_source_missing', 'sourceMessageId'));
  if (!clarification.candidateUserIds.length) diagnostics.push(error('collaboration_clarification_candidates_missing', 'candidateUserIds'));
  const candidateSet = new Set(clarification.candidateUserIds);
  for (const userId of clarification.requiredUserIds) {
    if (!candidateSet.has(userId)) diagnostics.push(error('collaboration_clarification_required_invalid', 'requiredUserIds'));
  }
  if (clarification.status === 'pending' && !clarification.question) {
    diagnostics.push(error('collaboration_clarification_question_missing', 'question'));
  }
  if (clarification.options.length === 1) diagnostics.push(error('collaboration_clarification_options_invalid', 'options'));
  return finish(clarification, diagnostics, throwOnError, 'ubuddy_collaboration_clarification_invalid');
}

export function validateUBuddyCollaborationModeDecision(value = {}, {
  candidateUserIds = [],
  throwOnError = true,
} = {}) {
  const source = objectValue(value);
  const diagnostics = [];
  const version = clean(source.version, 120);
  const decision = clean(source.decision, 40).toLowerCase();
  const collaborationMode = clean(source.collaborationMode || source.collaboration_mode, 80).toLowerCase();
  const initiatorParticipation = clean(source.initiatorParticipation || source.initiator_participation, 80).toLowerCase();
  const assignmentIntent = clean(source.assignmentIntent || source.assignment_intent, 40).toLowerCase();
  const participantSelectionIntent = clean(source.participantSelectionIntent || source.participant_selection_intent, 40).toLowerCase();
  const confidence = boundedConfidence(source.confidence);
  const allowedCandidates = uniqueIds(candidateUserIds);
  const assignments = normalizeAssignments(source.explicitAssignments || source.explicit_assignments);
  const clarificationSources = Array.isArray(source.clarifications) && source.clarifications.length
    ? source.clarifications : source.clarification ? [source.clarification] : [];
  const clarifications = clarificationSources.slice(0, 12).map((item, index) => ({
    id: clean(item?.id || item?.reasonCode || `collaboration_${index + 1}`, 120),
    header: clean(item?.header, 120), reasonCode: clean(item?.reasonCode || item?.reason_code, 120),
    question: clean(item?.question, 1000), options: cleanStrings(item?.options, 6, 160),
    allowOther: item?.allowOther !== false, required: item?.required !== false,
  })).filter((item) => item.question);
  const clarification = clarifications[0] || normalizeClarification(source.clarification);

  if (version !== UBUDDY_COLLABORATION_MODE_DECISION_VERSION) diagnostics.push(error('collaboration_mode_version_invalid', 'version'));
  if (!['ready', 'clarification'].includes(decision)) diagnostics.push(error('collaboration_mode_decision_invalid', 'decision'));
  if (!MODES.has(collaborationMode)) diagnostics.push(error('collaboration_mode_invalid', 'collaborationMode'));
  if (!PARTICIPATION.has(initiatorParticipation)) diagnostics.push(error('collaboration_participation_invalid', 'initiatorParticipation'));
  if (!ASSIGNMENT_INTENTS.has(assignmentIntent)) diagnostics.push(error('collaboration_assignment_intent_invalid', 'assignmentIntent'));
  if (!PARTICIPANT_SELECTION_INTENTS.has(participantSelectionIntent)) diagnostics.push(error('collaboration_participant_selection_intent_invalid', 'participantSelectionIntent'));
  if (collaborationMode === 'manager_delegation' && initiatorParticipation !== 'coordinator_only') {
    diagnostics.push(error('manager_participation_invalid', 'initiatorParticipation'));
  }
  if (collaborationMode === 'peer_collaboration' && initiatorParticipation !== 'coordinator_and_worker') {
    diagnostics.push(error('peer_participation_invalid', 'initiatorParticipation'));
  }
  const allowed = new Set(allowedCandidates);
  const assignmentIds = new Set(assignments.map((item) => item.assignmentId));
  for (const assignment of assignments) {
    if (assignment.assigneeKind === 'user' && !allowed.has(assignment.userId)) {
      diagnostics.push(error('collaboration_assignment_user_not_candidate', 'explicitAssignments'));
    }
    if (assignment.assigneeKind === 'self' && assignment.userId) diagnostics.push(error('collaboration_self_user_id_invalid', 'explicitAssignments'));
    for (const dependency of assignment.dependencies) {
      if (!assignmentIds.has(dependency) || dependency === assignment.assignmentId) {
        diagnostics.push(error('collaboration_assignment_dependency_invalid', 'explicitAssignments'));
      }
    }
  }
  if (decision === 'ready' && confidence < UBUDDY_COLLABORATION_MODE_CONFIDENCE) {
    diagnostics.push(error('collaboration_mode_confidence_low', 'confidence'));
  }
  if (decision === 'clarification' && !clarifications.length) diagnostics.push(error('collaboration_clarification_missing', 'clarifications'));
  if (decision === 'ready' && clarification.question) diagnostics.push(error('collaboration_ready_has_clarification', 'clarification'));
  if (decision === 'ready' && assignmentIntent === 'explicit') {
    const userAssignmentCounts = assignmentCountsByUser(assignments);
    const assignedUsers = new Set(userAssignmentCounts.keys());
    const missingUsers = allowedCandidates.filter((userId) => !assignedUsers.has(userId));
    if (missingUsers.length) diagnostics.push(error('collaboration_explicit_assignment_incomplete', 'explicitAssignments'));
    if ([...userAssignmentCounts.values()].some((count) => count !== 1)) {
      diagnostics.push(error('collaboration_explicit_assignment_duplicate_user', 'explicitAssignments'));
    }
    const selfCount = assignments.filter((item) => item.assigneeKind === 'self').length;
    if (collaborationMode === 'peer_collaboration' && selfCount !== 1) diagnostics.push(error('collaboration_peer_self_assignment_missing', 'explicitAssignments'));
    if (collaborationMode === 'manager_delegation' && selfCount) diagnostics.push(error('collaboration_manager_self_assignment_invalid', 'explicitAssignments'));
  }
  if (decision === 'ready' && assignmentIntent === 'auto' && assignments.length) {
    diagnostics.push(error('collaboration_auto_has_explicit_assignments', 'explicitAssignments'));
  }
  if (assignmentsHaveCycle(assignments)) diagnostics.push(error('collaboration_assignment_cycle', 'explicitAssignments'));

  return finish({
    version,
    decision,
    collaborationMode,
    initiatorParticipation,
    assignmentIntent,
    participantSelectionIntent,
    explicitAssignments: assignments,
    confidence,
    clarification,
    clarifications,
  }, diagnostics, throwOnError, 'ubuddy_collaboration_mode_decision_invalid');
}

export function validateUBuddyCollaborationPlan(value = {}, { throwOnError = true, requireWorkstreamMetadata = false } = {}) {
  const source = objectValue(value);
  const diagnostics = [];
  const plan = {
    version: clean(source.version, 120),
    proposalId: clean(source.proposalId || source.proposal_id, 200),
    revision: positiveInteger(source.revision) || 1,
    status: clean(source.status, 40).toLowerCase(),
    collaborationMode: clean(source.collaborationMode || source.collaboration_mode, 80).toLowerCase(),
    initiatorParticipation: clean(source.initiatorParticipation || source.initiator_participation, 80).toLowerCase(),
    assignmentSource: clean(source.assignmentSource || source.assignment_source, 80).toLowerCase(),
    executionStrategy: clean(source.executionStrategy || source.execution_strategy, 80).toLowerCase() || 'complementary',
    candidateUserIds: uniqueIds(source.candidateUserIds || source.candidate_user_ids),
    requiredUserIds: uniqueIds(source.requiredUserIds || source.required_user_ids),
    selectedUserIds: uniqueIds(source.selectedUserIds || source.selected_user_ids),
    profileRevisionSnapshots: normalizeObjects(source.profileRevisionSnapshots || source.profile_revision_snapshots),
    selectionDecision: objectValue(source.selectionDecision || source.selection_decision),
    assignments: normalizeAssignments(source.assignments),
    finalIntegrator: clean(source.finalIntegrator || source.final_integrator, 80) || 'self_ubuddy',
    confirmationRequired: source.confirmationRequired !== false,
    confidence: boundedConfidence(source.confidence),
    strategyVersion: clean(source.strategyVersion || source.strategy_version, 160),
    createdAt: iso(source.createdAt || source.created_at) || new Date().toISOString(),
    confirmedAt: iso(source.confirmedAt || source.confirmed_at),
  };
  if (plan.version !== UBUDDY_COLLABORATION_PLAN_VERSION) diagnostics.push(error('collaboration_plan_version_invalid', 'version'));
  if (!plan.proposalId) diagnostics.push(error('collaboration_plan_id_missing', 'proposalId'));
  if (!PLAN_STATUSES.has(plan.status)) diagnostics.push(error('collaboration_plan_status_invalid', 'status'));
  if (!MODES.has(plan.collaborationMode)) diagnostics.push(error('collaboration_plan_mode_invalid', 'collaborationMode'));
  if (!PARTICIPATION.has(plan.initiatorParticipation)) diagnostics.push(error('collaboration_plan_participation_invalid', 'initiatorParticipation'));
  if (!['explicit_user', 'ubuddy_planned'].includes(plan.assignmentSource)) diagnostics.push(error('collaboration_plan_assignment_source_invalid', 'assignmentSource'));
  if (!EXECUTION_STRATEGIES.has(plan.executionStrategy)) diagnostics.push(error('collaboration_plan_execution_strategy_invalid', 'executionStrategy'));
  const candidates = new Set(plan.candidateUserIds);
  const selected = new Set(plan.selectedUserIds);
  if (!selected.size) diagnostics.push(error('collaboration_plan_selected_empty', 'selectedUserIds'));
  if (!plan.assignments.length) diagnostics.push(error('collaboration_plan_assignments_empty', 'assignments'));
  for (const id of plan.requiredUserIds) if (!candidates.has(id) || !selected.has(id)) diagnostics.push(error('collaboration_plan_required_invalid', 'requiredUserIds'));
  for (const id of selected) if (!candidates.has(id)) diagnostics.push(error('collaboration_plan_selected_invalid', 'selectedUserIds'));
  const userAssignmentCounts = assignmentCountsByUser(plan.assignments);
  const assignedUsers = new Set(userAssignmentCounts.keys());
  for (const id of selected) if (!assignedUsers.has(id)) diagnostics.push(error('collaboration_plan_selected_assignment_missing', 'assignments'));
  for (const id of assignedUsers) if (!selected.has(id)) diagnostics.push(error('collaboration_plan_assignment_not_selected', 'assignments'));
  if ([...userAssignmentCounts.values()].some((count) => count !== 1)) {
    diagnostics.push(error('collaboration_plan_assignment_duplicate_user', 'assignments'));
  }
  if (plan.executionStrategy === 'complementary') {
    const workstreamKeys = plan.assignments.map((item) => item.workstreamKey).filter(Boolean);
    if (new Set(workstreamKeys).size !== workstreamKeys.length) {
      diagnostics.push(error('collaboration_plan_workstream_duplicate', 'assignments'));
    }
    const objectiveKeys = plan.assignments.map((item) => normalizedAssignmentSignature(item.objective)).filter(Boolean);
    if (new Set(objectiveKeys).size !== objectiveKeys.length) {
      diagnostics.push(error('collaboration_plan_objective_duplicate', 'assignments'));
    }
    const deliverableKeys = plan.assignments.map((item) => normalizedAssignmentSignature(item.deliverables.join('|'))).filter(Boolean);
    if (deliverableKeys.length > 1 && new Set(deliverableKeys).size !== deliverableKeys.length) {
      diagnostics.push(error('collaboration_plan_deliverables_duplicate', 'assignments'));
    }
  }
  const assignmentIds = new Set(plan.assignments.map((item) => item.assignmentId));
  for (const assignment of plan.assignments) {
    if (assignment.dependencies.some((dependency) => !assignmentIds.has(dependency) || dependency === assignment.assignmentId)) {
      diagnostics.push(error('collaboration_plan_assignment_dependency_invalid', 'assignments'));
      break;
    }
  }
  const selfCount = plan.assignments.filter((item) => item.assigneeKind === 'self').length;
  if (plan.collaborationMode === 'peer_collaboration' && selfCount !== 1) diagnostics.push(error('collaboration_plan_self_assignment_missing', 'assignments'));
  if (plan.collaborationMode === 'manager_delegation' && selfCount) diagnostics.push(error('collaboration_plan_self_assignment_invalid', 'assignments'));
  if (assignmentsHaveCycle(plan.assignments)) diagnostics.push(error('collaboration_plan_assignment_cycle', 'assignments'));
  if (plan.assignmentSource === 'explicit_user' && plan.confirmationRequired) diagnostics.push(error('collaboration_explicit_confirmation_invalid', 'confirmationRequired'));
  if (plan.assignmentSource === 'ubuddy_planned' && !plan.confirmationRequired && plan.status === 'awaiting_confirmation') {
    diagnostics.push(error('collaboration_auto_confirmation_missing', 'confirmationRequired'));
  }
  return finish(plan, diagnostics, throwOnError, 'ubuddy_collaboration_plan_invalid');
}

export function collaborationPlanRemoteAssignments(plan = {}) {
  return (Array.isArray(plan.assignments) ? plan.assignments : []).filter((item) => item.assigneeKind === 'user').map((item) => ({
    recipientId: item.userId,
    title: item.title,
    instruction: item.objective,
    metadata: {
      assignmentId: item.assignmentId,
      workstreamKey: item.workstreamKey,
      deliverables: item.deliverables,
      dependencies: item.dependencies,
      collaborationMode: plan.collaborationMode,
      executionStrategy: plan.executionStrategy,
      finalIntegrator: plan.finalIntegrator || 'self_ubuddy',
    },
  }));
}

export function collaborationPlanSelfAssignment(plan = {}) {
  return (Array.isArray(plan.assignments) ? plan.assignments : []).find((item) => item.assigneeKind === 'self') || null;
}

function normalizeAssignments(value = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const source = objectValue(raw);
    const assignmentId = clean(source.assignmentId || source.assignment_id, 120);
    const assigneeKind = clean(source.assigneeKind || source.assignee_kind, 20).toLowerCase();
    const userId = assigneeKind === 'user' ? clean(source.userId || source.user_id, 160) : '';
    const objective = clean(source.objective || source.instruction, 4000);
    if (!assignmentId || seen.has(assignmentId) || !['self', 'user'].includes(assigneeKind) || (assigneeKind === 'user' && !userId) || !objective) continue;
    seen.add(assignmentId);
    result.push({
      assignmentId,
      workstreamKey: clean(source.workstreamKey || source.workstream_key || assignmentId, 120).toLowerCase(),
      assigneeKind,
      userId,
      title: clean(source.title, 240) || objective.slice(0, 80),
      objective,
      deliverables: cleanStrings(source.deliverables, 12, 240),
      dependencies: uniqueIds(source.dependencies).slice(0, 24),
    });
    if (result.length >= 101) break;
  }
  return result;
}

function normalizedAssignmentSignature(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function assignmentsHaveCycle(assignments = []) {
  const graph = new Map(assignments.map((item) => [item.assignmentId, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) || []) if (graph.has(dependency) && visit(dependency)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function assignmentCountsByUser(assignments = []) {
  const counts = new Map();
  for (const assignment of assignments) {
    if (assignment.assigneeKind !== 'user' || !assignment.userId) continue;
    counts.set(assignment.userId, (counts.get(assignment.userId) || 0) + 1);
  }
  return counts;
}

function normalizeClarification(value = {}) {
  const source = objectValue(value);
  return {
    reasonCode: clean(source.reasonCode || source.reason_code, 120),
    question: clean(source.question, 1000),
    options: cleanStrings(source.options, 4, 160),
  };
}

function normalizeObjects(value = []) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map((item) => objectValue(item));
}

function finish(value, diagnostics, throwOnError, code) {
  const result = { valid: diagnostics.length === 0, value, diagnostics };
  if (throwOnError && !result.valid) {
    const failure = new Error(diagnostics.map((item) => item.code).join(', '));
    failure.code = code;
    failure.diagnostics = diagnostics;
    throw failure;
  }
  return result;
}

function error(code, field) { return { severity: 'error', code, field }; }
function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '', maximum = 240) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum); }
function uniqueIds(value = []) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 160)).filter(Boolean))]; }
function cleanStrings(value = [], maximum = 24, length = 240) { return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(typeof item === 'string' ? item : item?.label, length)).filter(Boolean))].slice(0, maximum); }
function boundedConfidence(value) { const number = Number(value ?? 0); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0; }
function positiveInteger(value) { const number = Math.floor(Number(value || 0)); return Number.isFinite(number) && number > 0 ? number : 0; }
function iso(value = '') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : ''; }
