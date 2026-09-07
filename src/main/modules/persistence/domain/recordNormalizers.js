import { safeJsonParse } from '../../../utils.js';

function normalizeProject(row) {
  if (!row) return null;
  const status = row.status || 'active';
  return {
    id: row.id,
    userId: row.user_id || 'local_admin',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    title: row.title || 'Untitled project',
    workspaceRoot: row.workspace_root || '',
    workspace_root: row.workspace_root || '',
    status,
    archived: status === 'archived',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSession(row) {
  if (!row) return null;
  const pinnedAt = row.pinned_at || '';
  const status = row.status || 'active';
  const lastMessage = compactPreviewText(row.last_message || row.lastMessage || '', 180);
  const lastMessageRole = String(row.last_message_role || row.lastMessageRole || '').trim();
  const lastMessageAt = row.last_message_at || row.lastMessageAt || '';
  return {
    id: row.id,
    conversationId: row.conversation_id || row.id,
    conversation_id: row.conversation_id || row.id,
    userId: row.user_id || 'local_admin',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    title: row.title,
    departmentId: row.department_id,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    projectId: row.project_id || '',
    project_id: row.project_id || '',
    workspaceRoot: row.workspace_root || '',
    workspace_root: row.workspace_root || '',
    interactionMode: normalizeInteractionMode(row.interaction_mode),
    interaction_mode: normalizeInteractionMode(row.interaction_mode),
    memoryUseEnabled: row.memory_use_enabled !== 0,
    memory_use_enabled: row.memory_use_enabled !== 0,
    memoryGenerateEnabled: row.memory_generate_enabled !== 0,
    memory_generate_enabled: row.memory_generate_enabled !== 0,
    goal: row.goal_objective || row.goal_status || Number(row.goal_tokens_used || 0) > 0
      || Number(row.goal_time_used_seconds || 0) > 0 ? {
      objective: row.goal_objective || '',
      status: normalizeGoalStatus(row.goal_status),
      tokensUsed: Math.max(0, Number(row.goal_tokens_used || 0)),
      timeUsedSeconds: Math.max(0, Number(row.goal_time_used_seconds || 0)),
    } : null,
    codexThreadId: row.codex_thread_id,
    conversationRole: row.conversation_role || 'standard',
    writeState: row.write_state || 'writable',
    supersededBySessionId: row.superseded_by_session_id || '',
    readOnly: (row.write_state || 'writable') === 'read_only',
    status,
    pinnedAt,
    pinned_at: pinnedAt,
    pinned: Boolean(pinnedAt),
    archived: status === 'archived',
    lastMessage,
    last_message: lastMessage,
    lastMessageRole,
    last_message_role: lastMessageRole,
    lastMessageAt,
    last_message_at: lastMessageAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeInteractionMode(value = '') {
  const mode = String(value || '').trim();
  return ['goal', 'plan'].includes(mode) ? mode : '';
}

function normalizeWorkspacePath(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function requestCodexThreadReset(updates = []) {
  if (!updates.includes("codex_thread_id = ''")) updates.push("codex_thread_id = ''");
}

function normalizeGoalStatus(value = '') {
  const status = String(value || '').trim();
  return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status) ? status : '';
}

function compareSessionsForDisplay(left = {}, right = {}) {
  const leftPinned = left.pinnedAt || left.pinned_at || '';
  const rightPinned = right.pinnedAt || right.pinned_at || '';
  if (leftPinned || rightPinned) {
    if (!leftPinned) return 1;
    if (!rightPinned) return -1;
    const pinnedCompare = String(rightPinned).localeCompare(String(leftPinned));
    if (pinnedCompare) return pinnedCompare;
  }
  return String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || ''));
}

function normalizeMemoryEntryContent(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\W_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function textMatchesQuery(text, normalizedQuery) {
  const haystack = normalizeSearchText(text);
  if (!normalizedQuery || !haystack) return false;
  if (haystack.includes(normalizedQuery)) return true;
  const parts = normalizedQuery.split(' ').filter(Boolean);
  return parts.length > 0 && parts.every((part) => haystack.includes(part));
}

function compactPreviewText(text, limit = 180) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}...`;
}

function messageMetadataSearchText(metadataJson) {
  const metadata = safeJsonParse(metadataJson, null);
  if (!metadata || typeof metadata !== 'object') return '';
  return flattenSearchValues(metadata).join(' ');
}

function flattenSearchValues(value, result = []) {
  if (value == null) return result;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    result.push(String(value));
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenSearchValues(item, result);
    return result;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) flattenSearchValues(item, result);
  }
  return result;
}

function searchMatchExcerpt(text, normalizedQuery, limit = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const folded = normalizeSearchText(value);
  let index = folded.indexOf(normalizedQuery);
  if (index < 0) {
    for (const part of normalizedQuery.split(' ')) {
      if (!part) continue;
      index = folded.indexOf(part);
      if (index >= 0) break;
    }
  }
  if (index < 0) return compactPreviewText(value, limit);
  const start = Math.max(0, index - 48);
  const end = Math.min(value.length, start + limit);
  const adjustedStart = Math.max(0, end - limit);
  const prefix = adjustedStart > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';
  return `${prefix}${value.slice(adjustedStart, end).trim()}${suffix}`;
}

function normalizeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    sessionId: row.session_id,
    conversationId: row.conversation_id || row.session_id || '',
    memoryId: row.memory_id || '',
    taskWorkspaceId: row.task_workspace_id || '',
    senderUserId: row.sender_user_id || '',
    sourceEventId: row.source_event_id || '',
    sourceMessageId: row.source_message_id || '',
    taskRunId: row.task_run_id,
    taskNodeId: row.task_node_id,
    role: row.role,
    content: row.content,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    departmentId: row.department_id,
    contextSpaceId: row.context_space_id || '',
    visible: Boolean(row.visible),
    metadata: safeJsonParse(row.metadata_json, {}),
    nodeCount: Number(row.node_count || 0),
    completedNodeCount: Number(row.completed_node_count || 0),
    waitingNodeCount: Number(row.waiting_node_count || 0),
    openCommunicationCount: Number(row.open_communication_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function normalizeConversation(row) {
  if (!row) return null;
  const status = row.status || 'active';
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    conversationKind: row.conversation_kind || 'direct',
    ownerUserId: row.owner_user_id || '',
    title: row.title || 'Untitled',
    agentId: row.agent_id || '',
    agentInstanceId: row.agent_instance_id || '',
    groupId: row.group_id || '',
    taskWorkspaceId: row.task_workspace_id || '',
    projectId: row.project_id || '',
    workspaceRoot: row.workspace_root || '',
    status,
    archived: status === 'archived',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function normalizeTaskWorkspace(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    delegationId: row.delegation_id || '',
    taskRunId: row.task_run_id || '',
    groupId: row.group_id || '',
    ownerUserId: row.owner_user_id || '',
    conversationId: row.conversation_id || '',
    workspaceRoot: row.workspace_root || '',
    workspaceEpoch: row.workspace_epoch || '',
    visibility: row.visibility || 'private',
    status: row.status || 'active',
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function normalizeMessageAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    conversationId: row.conversation_id || '',
    messageId: row.message_id || '',
    taskWorkspaceId: row.task_workspace_id || '',
    fileId: row.file_id || '',
    relationType: row.relation_type || 'attachment',
    name: row.name || '',
    contentType: row.content_type || '',
    sizeBytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || '',
    localPath: row.local_path || '',
    remoteFileId: row.remote_file_id || '',
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function normalizeModelExecution(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    projectId: row.project_id,
    conversationId: row.conversation_id,
    requestMessageId: row.request_message_id,
    responseMessageId: row.response_message_id,
    taskRunId: row.task_run_id,
    taskNodeId: row.task_node_id,
    departmentId: row.department_id,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    agentVersionId: row.agent_version_id || '',
    personalSkillVersionId: row.personal_skill_version_id || '',
    agentRole: row.agent_role,
    executionKind: row.execution_kind,
    providerId: row.provider_id,
    requestedModel: row.requested_model,
    effectiveModel: row.effective_model,
    reasoningEffort: row.reasoning_effort,
    modelSource: row.model_source,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    skillHash: row.skill_hash,
    memoryHash: row.memory_hash,
    memoryManifestHash: row.memory_manifest_hash || '',
    organizationVersion: row.organization_version,
    status: row.status,
    errorText: row.error_text,
    metadata: safeJsonParse(row.metadata_json, {}),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTaskRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    title: row.title,
    prompt: row.prompt,
    departmentId: row.department_id,
    leadAgentId: row.lead_agent_id,
    leadAgentInstanceId: row.lead_agent_instance_id || '',
    status: row.status,
    summary: row.summary,
    metadata: safeJsonParse(row.metadata_json, {}),
    nodeCount: Number(row.node_count || 0),
    completedNodeCount: Number(row.completed_node_count || 0),
    waitingNodeCount: Number(row.waiting_node_count || 0),
    retryingNodeCount: Number(row.retrying_node_count || 0),
    openCommunicationCount: Number(row.open_communication_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeTaskNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    title: row.title,
    objective: row.objective,
    departmentId: row.department_id,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    status: row.status,
    dependencies: safeJsonParse(row.dependencies_json, []),
    outputFormat: row.output_format,
    estimatedMinutes: Number(row.estimated_minutes || 0),
    priority: Number(row.priority || 0),
    parallelGroup: row.parallel_group,
    blocking: Boolean(row.blocking),
    notify: safeJsonParse(row.notify_json, []),
    fallback: row.fallback,
    waitReason: row.wait_reason,
    timeoutPolicy: row.timeout_policy,
    attemptCount: Math.max(0, Number(row.attempt_count || 0)),
    maxAttempts: Math.max(1, Number(row.max_attempts || 3)),
    nextRetryAt: row.next_retry_at || '',
    lastErrorCode: row.last_error_code || '',
    retryStrategy: row.retry_strategy || 'automatic',
    recoveryActions: safeJsonParse(row.recovery_actions_json, []),
    resultText: row.result_text,
    resultSummary: row.result_summary || '',
    evidenceRefs: safeJsonParse(row.evidence_json, []),
    errorText: row.error_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function normalizeTaskEvent(row) {
  if (!row) return null;
  const payload = safeJsonParse(row.payload_json, {});
  const status = String(payload.status || payload.after || taskEventStatus(row.event_type));
  return {
    id: row.id,
    eventId: row.id,
    taskRunId: row.task_run_id,
    taskId: row.task_run_id,
    taskNodeId: row.task_node_id,
    nodeId: row.task_node_id,
    eventType: row.event_type,
    actorId: row.actor_id,
    agentId: row.actor_id,
    privacyLevel: row.privacy_level || 'owner_private',
    status,
    summary: row.summary,
    command: String(payload.command || ''),
    output: String(payload.output || ''),
    payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function taskEventStatus(eventType = '') {
  const value = String(eventType || '').toLowerCase();
  const exact = {
    task_created: 'completed', task_leader_selected: 'completed', task_assigned: 'completed',
    task_dependency_changed: 'completed', task_cancel_requested: 'cancelled', task_cancelled: 'cancelled',
    node_retry_requested: 'waiting', node_retry_scheduled: 'waiting', node_retry_released: 'ready',
    node_queued: 'queued', node_started: 'running', node_running: 'running', node_ready: 'ready',
    node_waiting: 'blocked', node_waiting_for_communication: 'blocked', node_blocked: 'blocked',
    node_completed: 'completed', node_failed: 'failed', node_cancelled: 'cancelled',
    node_timeout: 'failed', node_non_blocking_skipped: 'completed',
    communication_opened: 'blocked', communication_resolved: 'completed', communication_target_rejected: 'failed',
    ppt_artifact_rendered: 'completed', deliverable_contract_passed: 'completed', deliverable_contract_failed: 'failed',
    delivery_validation_passed: 'completed', delivery_validation_failed: 'failed', task_recovery_sweep_failed: 'failed',
  };
  if (exact[value]) return exact[value];
  if (value.startsWith('graph_') || value.endsWith('_fallback_created')) return 'completed';
  return '';
}

function normalizeTaskGraphRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    revisionType: row.revision_type,
    reason: row.reason,
    before: safeJsonParse(row.before_json, {}),
    after: safeJsonParse(row.after_json, {}),
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

function normalizeTaskNodeResultVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    taskNodeId: row.task_node_id,
    graphRevisionId: row.graph_revision_id || '',
    versionNo: Number(row.version_no || 0),
    resultText: row.result_text || '',
    resultSummary: row.result_summary || '',
    evidenceRefs: safeJsonParse(row.evidence_json, []),
    decision: row.decision || 'pending',
    decisionReason: row.decision_reason || '',
    createdAt: row.created_at || '',
    decidedAt: row.decided_at || '',
  };
}

function normalizeCommunication(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    purpose: row.purpose,
    requestedInfo: row.requested_info,
    priority: row.priority,
    blocking: Boolean(row.blocking),
    expectedFormat: row.expected_format,
    contextSummary: row.context_summary,
    references: safeJsonParse(row.references_json, []),
    responseText: row.response_text,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function normalizeTaskRetrospective(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    participants: safeJsonParse(row.participants_json, []),
    assignment: safeJsonParse(row.assignment_json, {}),
    communications: safeJsonParse(row.communication_json, []),
    waits: safeJsonParse(row.wait_summary_json, []),
    skillFindings: safeJsonParse(row.skill_findings_json, []),
    memoryCandidates: safeJsonParse(row.memory_candidates_json, []),
    failurePoints: safeJsonParse(row.failure_points_json, []),
    finalSummary: row.final_summary,
    createdAt: row.created_at,
  };
}

function normalizeMemoryEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    userId: row.user_id || '',
    departmentId: row.department_id,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    memoryDocumentId: row.memory_document_id || '',
    taskRunId: row.task_run_id,
    memoryType: row.memory_type,
    content: row.content,
    lifecycleState: row.lifecycle_state,
    confidence: Number(row.confidence || 0),
    privacyLevel: row.privacy_level,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    reviewStatus: row.review_status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMemoryAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    duplicateCount: Number(row.duplicate_count || 0),
    staleCount: Number(row.stale_count || 0),
    lowConfidenceCount: Number(row.low_confidence_count || 0),
    privacyRiskCount: Number(row.privacy_risk_count || 0),
    migrationCandidateCount: Number(row.migration_candidate_count || 0),
    actions: safeJsonParse(row.actions_json, []),
    createdAt: row.created_at,
  };
}

function normalizeEvolutionRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    agentFamilyId: row.agent_family_id || row.agent_id,
    evolutionScope: row.evolution_scope || 'legacy',
    userId: row.user_id || '',
    userAgentInstanceId: row.user_agent_instance_id || '',
    cohortKey: row.cohort_key || '',
    algorithmVersion: row.algorithm_version || 'legacy_v1',
    evidenceCursorFrom: row.evidence_cursor_from || '',
    evidenceCursorTo: row.evidence_cursor_to || '',
    consentSnapshot: safeJsonParse(row.consent_snapshot_json, {}),
    departmentId: row.department_id,
    hrId: row.hr_id,
    evidenceMessageCount: Number(row.evidence_message_count || 0),
    status: row.status,
    proposalPath: row.proposal_path,
    summary: row.summary,
    sourceKind: row.source_kind || 'runtime_real',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeArchive(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    agentFamilyId: row.agent_family_id || row.agent_id,
    evolutionScope: row.evolution_scope || 'legacy',
    userId: row.user_id || '',
    userAgentInstanceId: row.user_agent_instance_id || '',
    departmentId: row.department_id,
    proposalPath: row.proposal_path,
    proposalHash: row.proposal_hash,
    diagnostics: safeJsonParse(row.diagnostics_json, {}),
    gateStatus: row.gate_status,
    gateScore: Number(row.gate_score || 0),
    gate: safeJsonParse(row.gate_json, {}),
    applied: Boolean(row.applied),
    preSkillHash: row.pre_skill_hash || '',
    postSkillHash: row.post_skill_hash || '',
    preMemoryHash: row.pre_memory_hash || '',
    postMemoryHash: row.post_memory_hash || '',
    sourceKind: row.source_kind || 'runtime_real',
    latestLabel: row.latest_label === null || row.latest_label === undefined
      ? null
      : {
          label: Boolean(row.latest_label),
          source: row.latest_label_source || '',
          confidence: Number(row.latest_label_confidence || 0),
          rationale: row.latest_label_rationale || '',
          synthetic: Boolean(row.latest_label_synthetic),
          createdAt: row.latest_label_created_at || '',
        },
    createdAt: row.created_at,
  };
}

function normalizeSkillVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    userAgentInstanceId: row.user_agent_instance_id || '',
    departmentId: row.department_id,
    path: row.path,
    sourceRunId: row.source_run_id,
    skillHash: row.skill_hash,
    createdAt: row.created_at,
  };
}

function normalizeTypedMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.owner_id,
    userId: row.user_id || '',
    departmentId: row.department_id,
    agentId: row.agent_id,
    agentInstanceId: row.agent_instance_id || '',
    memoryDocumentId: row.memory_document_id || '',
    taskRunId: row.task_run_id || '',
    relationshipId: row.relationship_id || '',
    memoryType: row.memory_type,
    content: row.content,
    privacyLevel: row.privacy_level,
    confidence: Number(row.confidence || 0),
    evidenceCount: Number(row.evidence_count || 0),
    hitCount: Number(row.hit_count || 0),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    updatedAt: row.updated_at,
  };
}

function normalizeHrReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    status: row.status,
    proposalPath: row.proposal_path,
    summary: row.summary,
    structural: safeJsonParse(row.structural_json, {}),
    gate: safeJsonParse(row.gate_json, {}),
    sourceKind: row.source_kind || 'runtime_real',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function normalizeAgentEvolutionReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    agentId: row.agent_id,
    departmentId: row.department_id,
    hrId: row.hr_id,
    decision: row.decision,
    rationale: row.rationale,
    requiredRevision: row.required_revision,
    risks: safeJsonParse(row.risks_json, []),
    createdAt: row.created_at,
  };
}

function normalizeGovernanceEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    agentId: row.agent_id,
    eventType: row.event_type,
    status: row.status,
    evidenceCount: Number(row.evidence_count || 0),
    confidence: Number(row.confidence || 0),
    rationale: row.rationale,
    migrationPlan: row.migration_plan,
    payload: safeJsonParse(row.payload_json, {}),
    sourceReviewId: row.source_review_id,
    sourceKind: row.source_kind || 'runtime_real',
    createdAt: row.created_at,
  };
}

function normalizePerformanceReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    agentId: row.agent_id,
    userId: row.user_id || '',
    agentFamilyId: row.agent_family_id || row.agent_id,
    userAgentInstanceId: row.user_agent_instance_id || '',
    reviewType: row.review_type,
    rating: row.rating,
    taskCount: Number(row.task_count || 0),
    successCount: Number(row.success_count || 0),
    failureCount: Number(row.failure_count || 0),
    communicationCount: Number(row.communication_count || 0),
    memoryHealth: safeJsonParse(row.memory_health_json, {}),
    recommendation: row.recommendation,
    score: Number(row.score || 0),
    scenarioMetrics: safeJsonParse(row.scenario_metrics_json, {}),
    skillVersionId: row.skill_version_id || '',
    skillHash: row.skill_hash || '',
    sourceReviewId: row.source_review_id,
    sourceKind: row.source_kind || 'runtime_real',
    createdAt: row.created_at,
  };
}

function normalizeSpecialistExperiment(row) {
  if (!row) return null;
  return {
    id: row.id,
    departmentId: row.department_id,
    candidateAgentId: row.candidate_agent_id,
    sourceAgentId: row.source_agent_id,
    baselineAgentId: row.baseline_agent_id || row.source_agent_id || '',
    startedByReviewId: row.started_by_review_id || '',
    state: row.state || row.status,
    status: row.status,
    metrics: safeJsonParse(row.metrics_json, {}),
    decisionNotes: row.decision_notes || '',
    baselineTaskRunId: row.baseline_task_run_id,
    candidateTaskRunId: row.candidate_task_run_id,
    evaluation: safeJsonParse(row.evaluation_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWorkflowCredit(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    reviewId: row.review_id,
    departmentId: row.department_id,
    agentId: row.agent_id,
    workflowStep: row.workflow_step,
    failureType: row.failure_type,
    responsibility: Number(row.responsibility || 0),
    evidenceSummary: row.evidence_summary,
    recommendation: row.recommendation,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export {
  normalizeProject,
  normalizeSession,
  normalizeInteractionMode,
  normalizeWorkspacePath,
  requestCodexThreadReset,
  normalizeGoalStatus,
  compareSessionsForDisplay,
  normalizeMemoryEntryContent,
  normalizeSearchText,
  textMatchesQuery,
  compactPreviewText,
  messageMetadataSearchText,
  flattenSearchValues,
  searchMatchExcerpt,
  normalizeMessage,
  normalizeConversation,
  normalizeTaskWorkspace,
  normalizeMessageAttachment,
  normalizeModelExecution,
  normalizeTaskRun,
  normalizeTaskNode,
  normalizeTaskEvent,
  normalizeTaskGraphRevision,
  normalizeTaskNodeResultVersion,
  normalizeCommunication,
  normalizeTaskRetrospective,
  normalizeMemoryEntry,
  normalizeMemoryAudit,
  normalizeEvolutionRun,
  normalizeArchive,
  normalizeSkillVersion,
  normalizeTypedMemory,
  normalizeHrReview,
  normalizeAgentEvolutionReview,
  normalizeGovernanceEvent,
  normalizePerformanceReview,
  normalizeSpecialistExperiment,
  normalizeWorkflowCredit,
};
