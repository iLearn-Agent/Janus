const AVAILABILITY_VALUES = new Set(['idle', 'working']);
const WORK_STATE_VALUES = new Set(['reserved', 'queued', 'running', 'blocked']);
const COORDINATION_STATE_VALUES = new Set([
  'planning', 'waiting_for_agents', 'sleeping', 'awakened', 'delivering', 'completed', 'failed', 'cancelled',
]);
const STATUS_SOURCE_PRIORITY = Object.freeze({ coordination: 0, employee: 1, availability: 2, task_progress: 3 });

export function normalizeAgentWorkStatus(source = {}, employee = {}) {
  const explicitWorkState = normalizeWorkState(source.workState || source.work_state);
  const explicitAvailability = String(source.availability || '').trim();
  const sourceWork = source.currentWork ?? source.current_work ?? null;
  const legacyWork = sourceWork || (explicitAvailability === 'idle' ? null : employee.currentWork) || null;
  const legacyStatus = normalizeWorkState(legacyWork?.status);
  const queueDepth = Math.max(0, Number(source.queueDepth ?? source.queue_depth ?? employee.queueDepth ?? 0));
  const workState = explicitWorkState || legacyStatus || (legacyWork ? 'running' : queueDepth ? 'queued' : '');
  const availability = workState
    ? 'working'
    : AVAILABILITY_VALUES.has(explicitAvailability) ? explicitAvailability : 'idle';
  const currentWork = currentWorkSummary(legacyWork);
  const taskRunId = String(legacyWork?.taskRunId || legacyWork?.task_run_id
    || legacyWork?.payload?.taskRunId || legacyWork?.payload?.task_run_id || source.taskRunId || source.task_run_id || '').trim();
  const updatedAt = String(
    source.updatedAt || source.updated_at
    || source.currentWork?.updatedAt || source.current_work?.updated_at
    || employee.currentWork?.updatedAt || employee.updatedAt || employee.updated_at || '',
  ).trim();
  return {
    agentInstanceId: String(source.agentInstanceId || source.agent_instance_id || employee.id || '').trim(),
    name: String(source.name || source.displayName || employee.displayName || employee.display_name || employee.family?.name || employee.agentFamilyId || '').trim(),
    agentFamilyId: String(source.agentFamilyId || source.agent_family_id || employee.agentFamilyId || '').trim(),
    availability,
    workState,
    currentWork,
    taskRunId,
    accountWorkspaceId: String(legacyWork?.accountWorkspaceId || legacyWork?.account_workspace_id
      || legacyWork?.payload?.accountWorkspaceId || legacyWork?.payload?.account_workspace_id
      || source.accountWorkspaceId || source.account_workspace_id || '').trim(),
    updatedAt,
  };
}

export function normalizeCoordinationSnapshot(source = {}) {
  if (!source || typeof source !== 'object') return null;
  const coordinationState = normalizeCoordinationState(source.coordinationState || source.coordination_state || source.state);
  const leaderSource = source.leader && typeof source.leader === 'object' ? source.leader : {};
  const participants = dedupeAgentParticipants((Array.isArray(source.participants) ? source.participants : [])
    .map((participant) => ({
      ...normalizeAgentWorkStatus(participant),
      recoveryConversationRecord: isRecoveryConversationRecord(participant),
    }))
    .filter((participant) => participant.agentInstanceId));
  const waitingRequirements = Array.isArray(source.waitingRequirements)
    ? source.waitingRequirements
    : Array.isArray(source.waiting_requirements) ? source.waiting_requirements : [];
  const revision = Math.max(0, Number(source.stateRevision ?? source.state_revision ?? source.revision ?? 0));
  const generation = Math.max(0, Number(source.generation ?? source.coordinationGeneration ?? source.coordination_generation ?? 0));
  return {
    ...source,
    coordinationState,
    leader: {
      ...leaderSource,
      agentInstanceId: String(leaderSource.agentInstanceId || leaderSource.agent_instance_id || '').trim(),
      name: String(leaderSource.name || leaderSource.displayName || '').trim(),
      leadershipLevel: normalizeLeadershipLevel(leaderSource.leadershipLevel || leaderSource.leadership_level),
    },
    participants,
    waitingRequirements,
    generation,
    stateRevision: revision,
    updatedAt: String(source.updatedAt || source.updated_at || '').trim(),
    wakeReason: normalizeWakeReason(source.wakeReason || source.wake_reason || source.wake || null),
    failureReport: normalizeFailureReport(source.failureReport || source.failure_report || source.publicFailure || null),
  };
}

export function coordinationSnapshotFromUpdate(payload = {}, task = null) {
  const source = payload.coordination
    || payload.coordinationSnapshot
    || payload.change?.coordination
    || task?.coordination
    || task?.metadata?.coordinationSnapshot
    || task?.metadata?.coordination
    || null;
  if (!source) return null;
  return normalizeCoordinationSnapshot({
    ...source,
    wakeReason: source.wakeReason || source.wake_reason || payload.wakeReason || payload.change?.wakeReason || task?.metadata?.wakeReason || task?.metadata?.wake,
    failureReport: source.failureReport || source.failure_report || payload.failureReport || payload.change?.failureReport || task?.metadata?.failureReport || task?.metadata?.publicFailure,
    updatedAt: source.updatedAt || source.updated_at || task?.updatedAt || '',
  });
}

export function applyCoordinationUpdate(state, payload = {}, task = null) {
  const snapshot = coordinationSnapshotFromUpdate(payload, task);
  const taskRunId = String(payload.taskRunId || payload.task_run_id || task?.id || snapshot?.taskRunId || '').trim();
  if (!snapshot || !taskRunId) return { applied: false, taskRunId: '', agentInstanceIds: [] };
  const previous = state.uBuddyCoordinationByTaskId?.[taskRunId] || null;
  if (previous && compareCoordinationVersion(snapshot, previous) < 0) {
    return { applied: false, stale: true, taskRunId, agentInstanceIds: [] };
  }
  if (previous && compareCoordinationVersion(snapshot, previous) === 0
    && JSON.stringify(snapshot) === JSON.stringify(previous)) {
    return { applied: false, duplicate: true, taskRunId, agentInstanceIds: [] };
  }
  state.uBuddyCoordinationByTaskId = {
    ...(state.uBuddyCoordinationByTaskId || {}),
    [taskRunId]: snapshot,
  };
  const nextStatuses = { ...(state.agentWorkStatusByInstanceId || {}) };
  const agentInstanceIds = [];
  for (const participant of snapshot.participants) {
    const coordinationStatus = { ...participant, statusSource: 'coordination' };
    nextStatuses[participant.agentInstanceId] = preferredAgentWorkStatus(
      coordinationStatus,
      nextStatuses[participant.agentInstanceId],
    );
    agentInstanceIds.push(participant.agentInstanceId);
  }
  state.agentWorkStatusByInstanceId = nextStatuses;
  return { applied: true, taskRunId, agentInstanceIds: [...new Set(agentInstanceIds)] };
}

export function applyAgentWorkStatusUpdates(state, statuses = [], { source: statusSource = 'availability' } = {}) {
  const nextStatuses = { ...(state.agentWorkStatusByInstanceId || {}) };
  const agentInstanceIds = [];
  for (const source of Array.isArray(statuses) ? statuses : []) {
    const status = { ...normalizeAgentWorkStatus(source, source), statusSource: String(statusSource || 'availability') };
    if (!status.agentInstanceId) continue;
    nextStatuses[status.agentInstanceId] = preferredAgentWorkStatus(
      status,
      nextStatuses[status.agentInstanceId] || {},
    );
    agentInstanceIds.push(status.agentInstanceId);
  }
  state.agentWorkStatusByInstanceId = nextStatuses;
  return [...new Set(agentInstanceIds)];
}

export function applyEmployeeWorkStatusSnapshot(state, roster = []) {
  return applyAgentWorkStatusUpdates(
    state,
    (Array.isArray(roster) ? roster : []).filter(hasExplicitAgentWorkStatus),
    { source: 'employee' },
  );
}

export function shouldApplyAgentTaskProgress(currentStatus = {}, taskRunId = '') {
  const currentTaskRunId = String(currentStatus.taskRunId || '').trim();
  const incomingTaskRunId = String(taskRunId || '').trim();
  return !(currentStatus.availability === 'working' && currentTaskRunId
    && incomingTaskRunId && currentTaskRunId !== incomingTaskRunId);
}

export function agentWorkEventMatchesWorkspace(payload = {}, activeWorkspaceId = 'workspace_personal') {
  const payloadWorkspaceId = String(payload.accountWorkspaceId || payload.account_workspace_id || payload.workspaceId || '').trim();
  return !payloadWorkspaceId || payloadWorkspaceId === String(activeWorkspaceId || 'workspace_personal');
}

export function coordinationForTask(state, taskRunId = '', task = null) {
  const id = String(taskRunId || task?.id || '').trim();
  const live = state.uBuddyCoordinationByTaskId?.[id] || null;
  const persisted = normalizeCoordinationSnapshot(task?.metadata?.coordinationSnapshot || task?.metadata?.coordination || null);
  if (live && persisted) return compareCoordinationVersion(persisted, live) > 0 ? persisted : live;
  return live || persisted || fallbackCoordinationFromTask(task);
}

export function agentWorkStatusFor(state, employee = {}, participant = null) {
  const id = String(participant?.agentInstanceId || employee?.id || '').trim();
  const liveStatus = state.agentWorkStatusByInstanceId?.[id] || null;
  const employeeStatus = hasExplicitAgentWorkStatus(employee)
    ? { ...normalizeAgentWorkStatus({ ...employee, agentInstanceId: id }, employee), statusSource: 'employee' }
    : null;
  const currentStatus = liveStatus && employeeStatus
    ? preferredAgentWorkStatus(employeeStatus, liveStatus)
    : liveStatus || employeeStatus;
  if (!participant) return normalizeAgentWorkStatus(currentStatus || {}, employee);
  if (!currentStatus) return normalizeAgentWorkStatus(participant, employee);
  return normalizeAgentWorkStatus(preferredAgentWorkStatus(participant, currentStatus), employee);
}

export function normalizeWakeReason(value = null) {
  if (!value) return null;
  if (typeof value === 'string') return { code: value, summary: '' };
  return {
    ...value,
    code: String(value.code || value.reasonCode || value.reason_code || '').trim(),
    summary: String(value.summary || value.message || value.reason || '').trim(),
    createdAt: String(value.createdAt || value.created_at || value.updatedAt || value.updated_at || '').trim(),
  };
}

export function normalizeFailureReport(value = null) {
  if (!value) return null;
  if (typeof value === 'string') return { summary: value };
  return {
    ...value,
    errorCode: String(value.errorCode || value.error_code || value.code || '').trim(),
    summary: String(value.summary || value.message || '').trim(),
    cause: String(value.cause || value.reason || '').trim(),
    retryable: value.retryable === true,
    attemptCount: Math.max(0, Number(value.attemptCount ?? value.attempt_count ?? 0)),
    maxAttempts: Math.max(0, Number(value.maxAttempts ?? value.max_attempts ?? 0)),
    attemptedActions: Array.isArray(value.attemptedActions)
      ? value.attemptedActions.map(String).filter(Boolean)
      : Array.isArray(value.attempted_actions) ? value.attempted_actions.map(String).filter(Boolean) : [],
    suggestedNextStep: String(value.suggestedNextStep || value.suggested_next_step || '').trim(),
  };
}

function fallbackCoordinationFromTask(task = null) {
  if (!task?.id) return null;
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const participantIds = [...new Set(nodes.map((node) => node.agentInstanceId).filter(Boolean))];
  if (!participantIds.length && !task.leadAgentInstanceId) return null;
  const participants = participantIds.map((agentInstanceId) => {
    const activeNode = nodes.find((node) => node.agentInstanceId === agentInstanceId
      && ['ready', 'queued', 'running', 'waiting', 'retry_wait', 'blocked'].includes(String(node.status || '')));
    const workState = normalizeWorkState(activeNode?.status) || (activeNode?.status === 'ready' ? 'reserved' : '');
    return normalizeAgentWorkStatus({
      agentInstanceId,
      availability: workState ? 'working' : 'idle',
      workState,
      currentWork: activeNode?.title || '',
      updatedAt: activeNode?.updatedAt || task.updatedAt || '',
    });
  });
  const selection = task.metadata?.taskLeaderSelection || {};
  return normalizeCoordinationSnapshot({
    coordinationState: ['completed', 'failed', 'cancelled'].includes(String(task.status || ''))
      ? String(task.status)
      : 'sleeping',
    leader: {
      agentInstanceId: task.leadAgentInstanceId || selection.agentInstanceId || '',
      name: selection.name || '',
      leadershipLevel: task.metadata?.leadershipLevelSnapshot || selection.leadershipLevel || 'L0',
    },
    participants,
    waitingRequirements: [],
    updatedAt: task.updatedAt || '',
  });
}

function compareCoordinationVersion(left = {}, right = {}) {
  const generation = Number(left.generation || 0) - Number(right.generation || 0);
  if (generation) return generation > 0 ? 1 : -1;
  const revision = Number(left.stateRevision || 0) - Number(right.stateRevision || 0);
  if (revision) return revision > 0 ? 1 : -1;
  const leftTime = Date.parse(left.updatedAt || '') || 0;
  const rightTime = Date.parse(right.updatedAt || '') || 0;
  if (leftTime === rightTime) return 0;
  return leftTime > rightTime ? 1 : -1;
}

function preferredAgentWorkStatus(incomingStatus = {}, currentStatus = {}) {
  const incomingTime = Date.parse(incomingStatus.updatedAt || incomingStatus.updated_at || '') || 0;
  const currentTime = Date.parse(currentStatus.updatedAt || currentStatus.updated_at || '') || 0;
  const sameTask = Boolean(incomingStatus.taskRunId && currentStatus.taskRunId
    && incomingStatus.taskRunId === currentStatus.taskRunId);
  if (sameTask && currentStatus.statusSource === 'task_progress'
    && incomingStatus.statusSource !== 'task_progress'
    && incomingStatus.availability === 'working'
    && currentStatus.currentWork) return currentStatus;
  if (incomingStatus.availability === 'idle' && currentStatus.statusSource === 'task_progress'
    && incomingTime >= currentTime) return incomingStatus;
  if (incomingTime && currentTime && incomingTime !== currentTime) return incomingTime > currentTime ? incomingStatus : currentStatus;
  const incomingPriority = Number(STATUS_SOURCE_PRIORITY[incomingStatus.statusSource] ?? -1);
  const currentPriority = Number(STATUS_SOURCE_PRIORITY[currentStatus.statusSource] ?? -1);
  if (incomingPriority !== currentPriority) return incomingPriority > currentPriority ? incomingStatus : currentStatus;
  if (incomingTime !== currentTime) return incomingTime > currentTime ? incomingStatus : currentStatus;
  return incomingStatus;
}

function hasExplicitAgentWorkStatus(value = {}) {
  return value.availability === 'idle' || value.availability === 'working'
    || Boolean(value.workState || value.work_state || value.currentWork || value.current_work);
}

function normalizeWorkState(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (WORK_STATE_VALUES.has(normalized)) return normalized;
  if (normalized === 'ready') return 'reserved';
  if (normalized === 'waiting' || normalized === 'retry_wait') return 'blocked';
  return '';
}

function normalizeCoordinationState(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (COORDINATION_STATE_VALUES.has(normalized)) return normalized;
  return 'planning';
}

function normalizeLeadershipLevel(value = '') {
  const normalized = String(value || '').trim().toUpperCase();
  return /^L[0-3]$/.test(normalized) ? normalized : 'L0';
}

function currentWorkSummary(value = null) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value.currentAction || value.current_action || value.summary || value.title
    || value.payload?.currentAction || value.payload?.summary || value.payload?.title
    || value.workId || value.work_id || '').trim();
}

function dedupeAgentParticipants(participants = []) {
  const grouped = new Map();
  for (const participant of participants) {
    const id = String(participant.agentInstanceId || '').trim();
    if (!id) continue;
    const current = grouped.get(id);
    if (!current) {
      grouped.set(id, { ...participant, hasRealParticipantRecord: !participant.recoveryConversationRecord });
      continue;
    }
    const currentTime = Date.parse(current.updatedAt || '') || 0;
    const incomingTime = Date.parse(participant.updatedAt || '') || 0;
    const latest = incomingTime >= currentTime ? participant : current;
    const fallback = latest === participant ? current : participant;
    grouped.set(id, {
      ...fallback,
      ...latest,
      agentInstanceId: id,
      name: preferredParticipantName(current, participant),
      agentFamilyId: latest.agentFamilyId || fallback.agentFamilyId || '',
      currentWork: latest.availability === 'idle' ? '' : latest.currentWork || fallback.currentWork || '',
      updatedAt: latest.updatedAt || fallback.updatedAt || '',
      hasRealParticipantRecord: Boolean(current.hasRealParticipantRecord || !participant.recoveryConversationRecord),
    });
  }
  return [...grouped.values()]
    .filter((participant) => participant.hasRealParticipantRecord)
    .map(({ recoveryConversationRecord: _recoveryConversationRecord, hasRealParticipantRecord: _hasRealParticipantRecord, ...participant }) => participant);
}

function preferredParticipantName(...participants) {
  const values = participants.filter(Boolean);
  const preferred = values.find((participant) => !participant.recoveryConversationRecord && participant.name)
    || values.find((participant) => participant.name);
  return String(preferred?.name || '').trim();
}

function isRecoveryConversationRecord(value = {}) {
  const kind = String(value.conversationRole || value.conversation_role || value.recordKind || value.record_kind
    || value.sourceKind || value.source_kind || '').trim();
  return Boolean(value.recoveryConversationId || value.recovery_conversation_id || /(?:^|_)recovery(?:_|$)/i.test(kind));
}
