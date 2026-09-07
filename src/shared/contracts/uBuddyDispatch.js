export const UBUDDY_INTENTS = Object.freeze([
  'direct_answer',
  'simple_message',
  'single_agent_task',
  'multi_agent_task',
  'approval_required_task',
]);

export const UBUDDY_DISPATCH_TYPES = Object.freeze([
  'simple_message',
  'local_agent',
  'external_delegation',
  'task_group',
]);

export const UBUDDY_DRAFT_STATUSES = Object.freeze([
  'generating',
  'slow',
  'ready',
  'failed',
  'manual_edit',
  'published',
  'cancelled',
  'superseded',
]);

export const UBUDDY_DISPATCH_V3_VERSION = 3;
export const UBUDDY_READINESS_PROOF_VERSION = 'ubuddy_readiness_proof_v1';

export const UBUDDY_PEER_SELECTION_VERSION = 'ubuddy_peer_selection_v1';

export const UBUDDY_PEER_SELECTION_STATUSES = Object.freeze([
  'ready',
  'needs_clarification',
  'no_match',
]);

export const UBUDDY_PEER_SELECTION_MODES = Object.freeze([
  'explicit_single',
  'all_selected',
  'candidate_pool',
]);

export const uBuddyPeerSelectionDecision = Object.freeze({
  name: 'uBuddyPeerSelectionDecision',
  version: UBUDDY_PEER_SELECTION_VERSION,
  fields: Object.freeze({
    version: 'string',
    status: 'ready | needs_clarification | no_match',
    selectionMode: 'explicit_single | all_selected | candidate_pool',
    candidateUserIds: 'string[]',
    requiredUserIds: 'string[]',
    selectedUserIds: 'string[]',
    rejectedCandidates: '{ userId: string, reasonCode: string, reason: string }[]',
    profileSnapshots: '{ ownerUserId: string, profileRevision: positive integer, sourceEffectiveSkillHash: string }[]',
    confidence: 'number between 0 and 1',
    strategyVersion: 'string',
    rationale: 'string',
    clarification: '{ reasonCode: string, question: string }',
  }),
  requiredWhenReady: Object.freeze([
    'candidateUserIds', 'selectedUserIds', 'strategyVersion', 'rationale',
  ]),
});

export const uBuddyDispatchV3 = Object.freeze({
  name: 'uBuddyDispatchV3',
  version: UBUDDY_DISPATCH_V3_VERSION,
  fields: Object.freeze({
    version: '3',
    id: 'string',
    title: 'string',
    dispatchType: 'simple_message | local_agent | external_delegation | task_group',
    intent: 'direct_answer | simple_message | single_agent_task | multi_agent_task | approval_required_task',
    postApprovalIntent: 'string',
    executionMode: 'string',
    objective: 'string',
    deliverables: 'string[]',
    requiresTaskGroup: 'boolean',
    taskGroupReasons: 'string[]',
    sourceType: 'string',
    sourcePeerId: 'string',
    sourceSecretarySessionId: 'string',
    sourceConversationId: 'string',
    sourceMessageId: 'string',
    sourceGroupId: 'string',
    projectId: 'string',
    parentTaskRunId: 'string',
    continuationRequestMessageId: 'string',
    taskIntake: 'object | null',
    privacyScope: 'string',
    riskLevel: 'string',
    sourceContent: 'string',
    instruction: 'string',
    attachments: '{ id: string, name: string, kind: string, size: non-negative integer, sha256: string, remoteFileId: string }[]',
    fileReferences: 'object[]',
    mentions: '{ principalType: string, userId: string, ownerUserId: string, agentId: string, agentInstanceId: string, organizationId: string, pluginId: string, skillId: string, audience: string, displayText: string, mentionId: string, source: string }[]',
    participantSelectionPolicyVersion: 'string',
    participantSelectionPolicy: 'all_mentioned | auto_select | string',
    organizationAudienceSnapshot: '{ version: string, organizationId: string, organizationName: string, memberUserIds: string[], memberCount: non-negative integer, membershipHash: string, resolvedAt: string } | null',
    participants: '{ userId: string, selected: boolean }[]',
    agents: '{ agentId: string, agentInstanceId: string }[]',
    assignments: '{ recipientId: string, title: string, instruction: string, metadata: object }[]',
    selectionMode: 'candidate_pool | all_selected | explicit_single',
    candidateUserIds: 'string[]',
    requiredUserIds: 'string[]',
    selectedUserIds: 'string[]',
    profileRevisionSnapshots: '{ ownerUserId: string, profileRevision: positive integer, sourceEffectiveSkillHash: string }[]',
    selectionDecision: '{ version: string, status: string, rejectedCandidates: object[], scoreBreakdown: object[], confidence: number, strategyVersion: string, rationale: string, clarification: object }',
    private: 'true',
    ubuddyProcessingMode: 'string',
    diagnostics: 'object | null',
    route: 'object | null',
    routingShadow: 'object | null',
    collaborationPlan: 'object | null',
    readinessProof: '{ version: string, ready: boolean, auditedAt: string, scopeHash: string, intakeHash: string } | null',
    planningSessionId: 'string',
    planningRevision: 'positive integer',
    planningDecisionDigest: 'string',
  }),
  requiredFields: Object.freeze([
    'id', 'title', 'dispatchType', 'intent', 'objective',
  ]),
  requiredForTaskDispatch: Object.freeze(['deliverables']),
  requiredForPeerDispatch: Object.freeze([
    'selectionMode', 'candidateUserIds', 'selectedUserIds', 'selectionDecision',
  ]),
  requiredForLocalAgentDispatch: Object.freeze(['agents']),
});

export function isUBuddyIntent(value = '') {
  return UBUDDY_INTENTS.includes(String(value || '').trim());
}

export function isPublishableUBuddyDispatchDraft(draft = {}) {
  const status = String(draft.status || '').trim();
  if (status === 'ready') return Boolean(draft.publishable !== false);
  if (status !== 'manual_edit') return false;
  return Boolean(
    draft.manuallyReviewed
    && String(draft.title || '').trim()
    && String(draft.objective || draft.instruction || '').trim()
    && Array.isArray(draft.deliverables)
    && draft.deliverables.some((item) => String(item || '').trim()),
  );
}

export function normalizeUBuddyDeliverables(value = [], fallback = '') {
  const result = [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().slice(0, 240))
    .filter(Boolean))].slice(0, 12);
  if (!result.length && String(fallback || '').trim()) result.push(String(fallback).trim().slice(0, 240));
  return result;
}

export function normalizeUBuddyPeerSelection(value = {}) {
  const source = objectValue(value);
  const rawStatus = clean(source.status).toLowerCase();
  const rawMode = clean(source.selectionMode || source.selection_mode).toLowerCase();
  return {
    version: clean(source.version) || UBUDDY_PEER_SELECTION_VERSION,
    status: UBUDDY_PEER_SELECTION_STATUSES.includes(rawStatus) ? rawStatus : 'needs_clarification',
    selectionMode: UBUDDY_PEER_SELECTION_MODES.includes(rawMode) ? rawMode : 'candidate_pool',
    candidateUserIds: cleanIdArray(source.candidateUserIds || source.candidate_user_ids),
    requiredUserIds: cleanIdArray(source.requiredUserIds || source.required_user_ids),
    selectedUserIds: cleanIdArray(source.selectedUserIds || source.selected_user_ids),
    rejectedCandidates: normalizeRejectedCandidates(source.rejectedCandidates || source.rejected_candidates),
    profileSnapshots: normalizeProfileSnapshots(source.profileSnapshots || source.profile_snapshots),
    confidence: boundedConfidence(source.confidence),
    strategyVersion: clean(source.strategyVersion || source.strategy_version, 120),
    rationale: clean(source.rationale, 2_000),
    clarification: normalizeSelectionClarification(source.clarification),
  };
}

export function validateUBuddyPeerSelection(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const selection = normalizeUBuddyPeerSelection(value);
  const diagnostics = [];
  if (selection.version !== UBUDDY_PEER_SELECTION_VERSION) {
    diagnostics.push(errorDiagnostic('peer_selection_version_unsupported', 'version', 'Unsupported uBuddy peer-selection version.'));
  }
  addInvalidEnumDiagnostic({
    diagnostics,
    rawValue: source.status,
    allowedValues: UBUDDY_PEER_SELECTION_STATUSES,
    code: 'peer_selection_status_invalid',
    field: 'status',
    message: 'A peer-selection decision requires a supported status.',
  });
  addInvalidEnumDiagnostic({
    diagnostics,
    rawValue: source.selectionMode ?? source.selection_mode,
    allowedValues: UBUDDY_PEER_SELECTION_MODES,
    code: 'peer_selection_mode_invalid',
    field: 'selectionMode',
    message: 'A peer-selection decision requires a supported selection mode.',
  });
  const candidateIds = new Set(selection.candidateUserIds);
  const requiredIds = new Set(selection.requiredUserIds);
  const selectedIds = new Set(selection.selectedUserIds);
  for (const userId of requiredIds) {
    if (!candidateIds.has(userId)) diagnostics.push(errorDiagnostic('peer_selection_required_not_candidate', 'requiredUserIds', 'Every required user must be in the candidate pool.'));
    if (selection.status === 'ready' && !selectedIds.has(userId)) diagnostics.push(errorDiagnostic('peer_selection_required_not_selected', 'selectedUserIds', 'Every required user must be selected.'));
  }
  for (const userId of selectedIds) {
    if (!candidateIds.has(userId)) diagnostics.push(errorDiagnostic('peer_selection_selected_not_candidate', 'selectedUserIds', 'Every selected user must be in the candidate pool.'));
  }
  for (const item of selection.rejectedCandidates) {
    if (!candidateIds.has(item.userId)) diagnostics.push(errorDiagnostic('peer_selection_rejected_not_candidate', 'rejectedCandidates', 'Every rejected user must be in the candidate pool.'));
    if (selectedIds.has(item.userId)) diagnostics.push(errorDiagnostic('peer_selection_selected_and_rejected', 'rejectedCandidates', 'A selected user cannot also be rejected.'));
  }
  for (const snapshot of selection.profileSnapshots) {
    if (!candidateIds.has(snapshot.ownerUserId)) diagnostics.push(errorDiagnostic('peer_selection_snapshot_not_candidate', 'profileSnapshots', 'Every Profile snapshot must belong to a candidate user.'));
    if (!snapshot.profileRevision) diagnostics.push(errorDiagnostic('peer_selection_snapshot_revision_invalid', 'profileSnapshots', 'Every Profile snapshot requires a positive revision.'));
    if (!snapshot.sourceEffectiveSkillHash) diagnostics.push(errorDiagnostic('peer_selection_snapshot_skill_hash_missing', 'profileSnapshots', 'Every Profile snapshot requires its effective Skill hash.'));
  }
  if (selection.status === 'ready') {
    if (!selection.candidateUserIds.length) diagnostics.push(errorDiagnostic('peer_selection_candidates_missing', 'candidateUserIds', 'A ready peer selection requires candidates.'));
    if (!selection.selectedUserIds.length) diagnostics.push(errorDiagnostic('peer_selection_targets_missing', 'selectedUserIds', 'A ready peer selection requires at least one selected user.'));
    if (selection.selectionMode === 'explicit_single' && selection.selectedUserIds.length !== 1) {
      diagnostics.push(errorDiagnostic('peer_selection_explicit_single_invalid', 'selectedUserIds', 'Explicit-single selection requires exactly one selected user.'));
    }
    if (selection.selectionMode === 'all_selected'
      && (selection.selectedUserIds.length !== selection.candidateUserIds.length
        || selection.candidateUserIds.some((userId) => !selectedIds.has(userId)))) {
      diagnostics.push(errorDiagnostic('peer_selection_all_selected_invalid', 'selectedUserIds', 'All-selected mode requires every candidate to be selected.'));
    }
    if (!selection.strategyVersion) diagnostics.push(errorDiagnostic('peer_selection_strategy_missing', 'strategyVersion', 'A ready peer selection requires a strategy version.'));
    if (!selection.rationale) diagnostics.push(errorDiagnostic('peer_selection_rationale_missing', 'rationale', 'A ready peer selection requires a rationale.'));
  } else {
    if (selection.selectedUserIds.length) diagnostics.push(errorDiagnostic('peer_selection_non_ready_has_targets', 'selectedUserIds', 'A non-ready peer selection cannot contain selected users.'));
    if (selection.status === 'needs_clarification' && !selection.clarification.question) {
      diagnostics.push(errorDiagnostic('peer_selection_clarification_missing', 'clarification.question', 'A selection that needs clarification requires one question.'));
    }
  }
  return finishValidation('ubuddy_peer_selection_invalid', selection, diagnostics, throwOnError);
}

export function normalizeUBuddyDispatchV3(value = {}) {
  const source = stripLocalPaths(objectValue(value));
  const legacySelection = normalizeUBuddyPeerSelection(source.peerSelection || source.peer_selection);
  const rawSelectionMode = clean(source.selectionMode || source.selection_mode || legacySelection.selectionMode).toLowerCase();
  return {
    version: normalizedDispatchVersion(source.version),
    id: clean(source.id, 200),
    title: clean(source.title, 240),
    dispatchType: clean(source.dispatchType || source.dispatch_type, 80),
    intent: clean(source.intent, 80),
    postApprovalIntent: clean(source.postApprovalIntent || source.post_approval_intent, 80),
    executionMode: clean(source.executionMode || source.execution_mode, 80),
    objective: clean(source.objective || source.instruction, 4_000),
    deliverables: normalizeUBuddyDeliverables(source.deliverables),
    requiresTaskGroup: Boolean(source.requiresTaskGroup || source.requires_task_group),
    taskGroupReasons: cleanStringArray(source.taskGroupReasons || source.task_group_reasons, 24, 120),
    sourceType: clean(source.sourceType || source.source_type, 80) || 'secretary_chat',
    sourcePeerId: clean(source.sourcePeerId || source.source_peer_id, 160),
    sourceSecretarySessionId: clean(source.sourceSecretarySessionId || source.source_secretary_session_id, 240),
    sourceConversationId: clean(source.sourceConversationId || source.source_conversation_id
      || source.sourceSecretarySessionId || source.source_secretary_session_id, 240),
    sourceMessageId: clean(source.sourceMessageId || source.source_message_id, 240),
    sourceGroupId: clean(source.sourceGroupId || source.source_group_id, 240),
    projectId: clean(source.projectId || source.project_id, 240),
    parentTaskRunId: clean(source.parentTaskRunId || source.parent_task_run_id, 240),
    continuationRequestMessageId: clean(source.continuationRequestMessageId || source.continuation_request_message_id, 240),
    taskIntake: nullableObject(source.taskIntake || source.task_intake),
    privacyScope: clean(source.privacyScope || source.privacy_scope, 80),
    riskLevel: clean(source.riskLevel || source.risk_level, 80),
    sourceContent: clean(source.sourceContent || source.source_content, 4_000),
    instruction: clean(source.instruction || source.objective, 4_000),
    attachments: normalizeAttachmentRefs(source.attachments),
    fileReferences: normalizeObjectArray(source.fileReferences || source.file_references, 100),
    mentions: normalizeMentions(source.mentions),
    participantSelectionPolicyVersion: clean(source.participantSelectionPolicyVersion
      || source.participant_selection_policy_version, 120),
    participantSelectionPolicy: clean(source.participantSelectionPolicy
      || source.participant_selection_policy, 80),
    organizationAudienceSnapshot: normalizeOrganizationAudienceSnapshot(
      source.organizationAudienceSnapshot || source.organization_audience_snapshot,
    ),
    participants: normalizeParticipants(source.participants),
    agents: normalizeAgents(source.agents),
    assignments: normalizeAssignments(source.assignments),
    selectionMode: UBUDDY_PEER_SELECTION_MODES.includes(rawSelectionMode) ? rawSelectionMode : 'candidate_pool',
    candidateUserIds: cleanIdArray(source.candidateUserIds || source.candidate_user_ids || legacySelection.candidateUserIds),
    requiredUserIds: cleanIdArray(source.requiredUserIds || source.required_user_ids || legacySelection.requiredUserIds),
    selectedUserIds: cleanIdArray(source.selectedUserIds || source.selected_user_ids || legacySelection.selectedUserIds),
    profileRevisionSnapshots: normalizeProfileSnapshots(source.profileRevisionSnapshots
      || source.profile_revision_snapshots || legacySelection.profileSnapshots),
    selectionDecision: normalizeSelectionDecision(source.selectionDecision || source.selection_decision || legacySelection),
    private: true,
    ubuddyProcessingMode: clean(source.ubuddyProcessingMode || source.ubuddy_processing_mode, 80) || 'deterministic',
    diagnostics: nullableObject(source.diagnostics),
    route: nullableObject(source.route),
    routingShadow: nullableObject(source.routingShadow || source.routing_shadow),
    collaborationPlan: nullableObject(source.collaborationPlan || source.collaboration_plan),
    readinessProof: normalizeReadinessProof(source.readinessProof || source.readiness_proof),
    planningSessionId: clean(source.planningSessionId || source.planning_session_id, 240),
    planningRevision: positiveInteger(source.planningRevision || source.planning_revision),
    planningDecisionDigest: clean(source.planningDecisionDigest || source.planning_decision_digest, 160),
  };
}

export function uBuddyDispatchReadinessScope(value = {}) {
  const dispatch = normalizeUBuddyDispatchV3(value);
  return {
    objective: dispatch.objective,
    deliverables: dispatch.deliverables,
    taskIntake: dispatch.taskIntake,
    privacyScope: dispatch.privacyScope,
    riskLevel: dispatch.riskLevel,
    attachments: dispatch.attachments,
    participants: dispatch.participants,
    agents: dispatch.agents,
    assignments: dispatch.assignments,
    selectedUserIds: dispatch.selectedUserIds,
    planningSessionId: dispatch.planningSessionId,
    planningRevision: dispatch.planningRevision,
    planningDecisionDigest: dispatch.planningDecisionDigest,
  };
}

export function createUBuddyReadinessProof(value = {}, { auditedAt = new Date().toISOString(), ready = true } = {}) {
  const scope = uBuddyDispatchReadinessScope(value);
  return {
    version: UBUDDY_READINESS_PROOF_VERSION,
    ready: Boolean(ready),
    auditedAt: clean(auditedAt, 80),
    scopeHash: stableHash(scope),
    intakeHash: stableHash(scope.taskIntake || {}),
  };
}

export function uBuddyReadinessProofMatches(value = {}) {
  const proof = normalizeReadinessProof(value.readinessProof || value.readiness_proof);
  if (!proof || proof.version !== UBUDDY_READINESS_PROOF_VERSION || !proof.ready) return false;
  const expected = createUBuddyReadinessProof(value, { auditedAt: proof.auditedAt, ready: true });
  return proof.scopeHash === expected.scopeHash && proof.intakeHash === expected.intakeHash;
}

export function validateUBuddyDispatchV3(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const legacySelectionSource = objectValue(source.peerSelection || source.peer_selection);
  const selectionDecisionSource = objectValue(source.selectionDecision || source.selection_decision);
  const dispatch = normalizeUBuddyDispatchV3(value);
  const diagnostics = [];
  if (dispatch.version !== UBUDDY_DISPATCH_V3_VERSION) {
    diagnostics.push(errorDiagnostic('dispatch_version_unsupported', 'version', 'Unsupported uBuddy dispatch version.'));
  }
  addInvalidEnumDiagnostic({
    diagnostics,
    rawValue: source.selectionMode ?? source.selection_mode
      ?? legacySelectionSource.selectionMode ?? legacySelectionSource.selection_mode,
    allowedValues: UBUDDY_PEER_SELECTION_MODES,
    code: 'dispatch_selection_mode_invalid',
    field: 'selectionMode',
    message: 'A uBuddy dispatch requires a supported peer-selection mode.',
  });
  addInvalidEnumDiagnostic({
    diagnostics,
    rawValue: selectionDecisionSource.status ?? legacySelectionSource.status,
    allowedValues: UBUDDY_PEER_SELECTION_STATUSES,
    code: 'dispatch_selection_status_invalid',
    field: 'selectionDecision.status',
    message: 'A uBuddy dispatch requires a supported peer-selection status.',
  });
  if (!dispatch.id) diagnostics.push(errorDiagnostic('dispatch_id_missing', 'id', 'A uBuddy dispatch requires an idempotency id.'));
  if (!dispatch.title) diagnostics.push(errorDiagnostic('dispatch_title_missing', 'title', 'A uBuddy dispatch requires a title.'));
  if (!UBUDDY_DISPATCH_TYPES.includes(dispatch.dispatchType)) {
    diagnostics.push(errorDiagnostic('dispatch_type_invalid', 'dispatchType', 'A uBuddy dispatch requires a supported dispatch type.'));
  }
  if (!isUBuddyIntent(dispatch.intent)) diagnostics.push(errorDiagnostic('dispatch_intent_invalid', 'intent', 'A uBuddy dispatch requires a supported intent.'));
  if (!dispatch.objective) diagnostics.push(errorDiagnostic('dispatch_objective_missing', 'objective', 'A uBuddy dispatch requires an objective.'));
  if (dispatch.dispatchType !== 'simple_message' && !dispatch.deliverables.length) {
    diagnostics.push(errorDiagnostic('dispatch_deliverables_missing', 'deliverables', 'A task dispatch requires at least one deliverable.'));
  }
  if (dispatch.organizationAudienceSnapshot) {
    const organizationMention = dispatch.mentions.find((mention) => (
      mention.principalType === 'organization'
      && mention.organizationId === dispatch.organizationAudienceSnapshot.organizationId
      && mention.audience === 'all_members'
    ));
    const snapshotIds = new Set(dispatch.organizationAudienceSnapshot.memberUserIds);
    const candidateIds = new Set(dispatch.candidateUserIds);
    if (!organizationMention) {
      diagnostics.push(errorDiagnostic(
        'dispatch_organization_audience_mention_missing',
        'mentions',
        'An organization audience snapshot requires its structured organization mention.',
      ));
    }
    if (dispatch.selectionMode !== 'all_selected') {
      diagnostics.push(errorDiagnostic(
        'dispatch_organization_audience_selection_invalid',
        'selectionMode',
        'An organization audience must preserve every resolved member as selected.',
      ));
    }
    if ([...snapshotIds].some((userId) => !candidateIds.has(userId))) {
      diagnostics.push(errorDiagnostic(
        'dispatch_organization_audience_candidates_mismatch',
        'candidateUserIds',
        'Organization audience candidates must include every member in the frozen snapshot.',
      ));
    }
  }

  if (dispatch.participantSelectionPolicy === 'all_mentioned') {
    const candidates = [...dispatch.candidateUserIds].sort();
    const required = [...dispatch.requiredUserIds].sort();
    const selected = [...dispatch.selectedUserIds].sort();
    const sameSet = (left, right) => left.length === right.length
      && left.every((userId, index) => userId === right[index]);
    if (dispatch.selectionMode !== 'all_selected' && candidates.length > 1) {
      diagnostics.push(errorDiagnostic(
        'dispatch_all_mentioned_mode_invalid',
        'selectionMode',
        'All-mentioned participant policy requires all-selected mode.',
      ));
    }
    if (!sameSet(candidates, required) || !sameSet(candidates, selected)) {
      diagnostics.push(errorDiagnostic(
        'dispatch_all_mentioned_participants_mismatch',
        'selectedUserIds',
        'Every explicitly mentioned participant must remain required and selected.',
      ));
    }
  }

  const usesPeerSelection = dispatch.dispatchType !== 'local_agent';
  if (usesPeerSelection) {
    const peerValidation = validateUBuddyPeerSelection({
      ...dispatch.selectionDecision,
      selectionMode: dispatch.selectionMode,
      candidateUserIds: dispatch.candidateUserIds,
      requiredUserIds: dispatch.requiredUserIds,
      selectedUserIds: dispatch.selectedUserIds,
      profileSnapshots: dispatch.profileRevisionSnapshots,
    });
    diagnostics.push(...peerValidation.diagnostics.map((item) => ({
      ...item,
      field: `selectionDecision.${item.field}`,
    })));
  } else if (!dispatch.agents.length) {
    diagnostics.push(errorDiagnostic('dispatch_agents_missing', 'agents', 'A local Agent dispatch requires at least one Agent target.'));
  }
  if (usesPeerSelection && dispatch.selectionDecision.status === 'ready') {
    const selectedIds = new Set(dispatch.selectedUserIds);
    const participantIds = new Set(dispatch.participants.map((item) => item.userId));
    const assignmentIds = new Set(dispatch.assignments.map((item) => item.recipientId));
    for (const userId of selectedIds) {
      if (!participantIds.has(userId)) diagnostics.push(errorDiagnostic('dispatch_selected_participant_missing', 'participants', 'Every selected peer must be a selected participant.'));
      if (['external_delegation', 'task_group'].includes(dispatch.dispatchType) && !assignmentIds.has(userId)) {
        diagnostics.push(errorDiagnostic('dispatch_selected_assignment_missing', 'assignments', 'Every selected external peer must have an assignment.'));
      }
    }
    for (const userId of participantIds) {
      if (!selectedIds.has(userId)) diagnostics.push(errorDiagnostic('dispatch_participant_not_selected', 'participants', 'Every selected participant must be selected by the peer decision.'));
    }
    for (const userId of assignmentIds) {
      if (!selectedIds.has(userId)) diagnostics.push(errorDiagnostic('dispatch_assignment_not_selected', 'assignments', 'Every assignment recipient must be selected by the peer decision.'));
    }
  }
  return finishValidation('ubuddy_dispatch_v3_invalid', dispatch, diagnostics, throwOnError);
}

function normalizeSelectionDecision(value = {}) {
  const selection = normalizeUBuddyPeerSelection(value);
  const source = objectValue(value);
  return {
    version: selection.version,
    status: selection.status,
    rejectedCandidates: selection.rejectedCandidates,
    scoreBreakdown: normalizeScoreBreakdown(source.scoreBreakdown || source.score_breakdown),
    confidence: selection.confidence,
    strategyVersion: selection.strategyVersion,
    rationale: selection.rationale,
    clarification: selection.clarification,
  };
}

function normalizeScoreBreakdown(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => stripLocalPaths(objectValue(item)));
}

function normalizeObjectArray(value = [], maximum = 100) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).map((item) => stripLocalPaths(objectValue(item)));
}

function normalizeRejectedCandidates(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = objectValue(item);
    const userId = clean(source.userId || source.user_id, 160);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({
      userId,
      reasonCode: clean(source.reasonCode || source.reason_code, 120),
      reason: clean(source.reason, 600),
    });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeProfileSnapshots(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = objectValue(item);
    const ownerUserId = clean(source.ownerUserId || source.owner_user_id, 160);
    if (!ownerUserId || seen.has(ownerUserId)) continue;
    seen.add(ownerUserId);
    result.push({
      ownerUserId,
      profileRevision: positiveInteger(source.profileRevision || source.profile_revision),
      sourceEffectiveSkillHash: clean(source.sourceEffectiveSkillHash || source.source_effective_skill_hash, 160),
    });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeSelectionClarification(value = {}) {
  const source = objectValue(value);
  return {
    reasonCode: clean(source.reasonCode || source.reason_code, 120),
    question: clean(source.question, 1_000),
  };
}

function normalizeParticipants(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = objectValue(item);
    const userId = clean(source.userId || source.user_id || source.id, 160);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({ userId, selected: source.selected !== false });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAssignments(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = objectValue(item);
    const recipientId = clean(source.recipientId || source.recipient_id, 160);
    const instruction = clean(source.instruction, 4_000);
    if (!recipientId || !instruction || seen.has(recipientId)) continue;
    seen.add(recipientId);
    result.push({
      assignmentId: clean(source.assignmentId || source.assignment_id || source.metadata?.assignmentId, 120),
      recipientId,
      title: clean(source.title, 240),
      instruction,
      metadata: nullableObject(source.metadata) || {},
    });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAgents(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = typeof item === 'string' ? { agentId: item } : objectValue(item);
    const agentId = clean(source.agentId || source.agent_id || source.id, 160);
    const agentInstanceId = clean(source.agentInstanceId || source.agent_instance_id, 160);
    const key = `${agentId}:${agentInstanceId}`;
    if (!agentId || seen.has(key)) continue;
    seen.add(key);
    result.push({ agentId, agentInstanceId });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeAttachmentRefs(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = typeof item === 'string' ? { id: item } : objectValue(item);
    const id = clean(source.id || source.attachmentId || source.attachment_id || source.fileId || source.file_id
      || source.remoteFileId || source.remote_file_id, 240);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      name: clean(source.name || source.filename, 240),
      kind: clean(source.kind || source.type || source.contentType || source.content_type, 120),
      size: nonNegativeInteger(source.size ?? source.sizeBytes ?? source.size_bytes, Number.MAX_SAFE_INTEGER),
      sha256: clean(source.sha256, 160),
      remoteFileId: clean(source.remoteFileId || source.remote_file_id, 240),
    });
    if (result.length >= 20) break;
  }
  return result;
}

function normalizeMentions(value = []) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const source = objectValue(item);
    const principalType = clean(source.principalType || source.principal_type, 40).toLowerCase();
    const userId = clean(source.userId || source.user_id, 160);
    const ownerUserId = clean(source.ownerUserId || source.owner_user_id, 160);
    const agentId = clean(source.agentId || source.agent_id, 160);
    const agentInstanceId = clean(source.agentInstanceId || source.agent_instance_id, 160);
    const organizationId = clean(source.organizationId || source.organization_id, 160);
    const pluginId = clean(source.pluginId || source.plugin_id, 240);
    const audience = clean(source.audience, 80).toLowerCase();
    const mentionId = clean(source.mentionId || source.mention_id, 200);
    const principalId = userId || ownerUserId || agentInstanceId || agentId || organizationId || pluginId;
    const key = mentionId || `${principalType}:${principalId}`;
    if (!['user', 'ubuddy', 'agent', 'organization', 'plugin'].includes(principalType) || !principalId || seen.has(key)) continue;
    if (principalType === 'organization' && audience !== 'all_members') continue;
    seen.add(key);
    result.push({
      principalType,
      userId,
      ownerUserId,
      agentId,
      agentInstanceId,
      organizationId,
      pluginId,
      audience,
      displayText: clean(source.displayText || source.display_text, 240),
      mentionId,
      source: clean(source.source, 40),
    });
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeOrganizationAudienceSnapshot(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = objectValue(value);
  const organizationId = clean(source.organizationId || source.organization_id, 160);
  const memberUserIds = cleanIdArray(source.memberUserIds || source.member_user_ids);
  if (!organizationId || !memberUserIds.length) return null;
  return {
    version: clean(source.version, 80) || 'ubuddy_organization_audience_snapshot_v1',
    mentionVersion: clean(source.mentionVersion || source.mention_version, 80),
    organizationId,
    organizationName: clean(source.organizationName || source.organization_name, 240),
    memberUserIds,
    memberCount: memberUserIds.length,
    membershipHash: clean(source.membershipHash || source.membership_hash, 160),
    resolvedAt: clean(source.resolvedAt || source.resolved_at, 80),
  };
}

function normalizeReadinessProof(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = objectValue(value);
  return {
    version: clean(source.version, 80),
    ready: source.ready === true,
    auditedAt: clean(source.auditedAt || source.audited_at, 80),
    scopeHash: clean(source.scopeHash || source.scope_hash, 160),
    intakeHash: clean(source.intakeHash || source.intake_hash, 160),
  };
}

function stableHash(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function cleanIdArray(value = []) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = clean(item, 160);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 100) break;
  }
  return result;
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

function stripLocalPaths(value) {
  if (Array.isArray(value)) return value.map(stripLocalPaths);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['path', 'sourcepath', 'source_path', 'localpath', 'local_path'].includes(String(key).toLowerCase()))
    .map(([key, item]) => [key, stripLocalPaths(item)]));
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

function positiveInteger(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value, maximum) {
  const number = Math.floor(Number(value || 0));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(maximum, number));
}

function nullableObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedConfidence(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizedDispatchVersion(value) {
  if (value == null || value === '') return UBUDDY_DISPATCH_V3_VERSION;
  const number = Number(value);
  return Number.isInteger(number) ? number : 0;
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
