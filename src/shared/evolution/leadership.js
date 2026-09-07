import crypto from 'node:crypto';

export const LEADERSHIP_ALGORITHM_VERSION = 'leadership_90d_100tasks_v2';
export const LEADERSHIP_WINDOW_DAYS = 90;
export const LEADERSHIP_MAX_ASSIGNMENTS = 100;
export const LEADERSHIP_PROVISIONAL_TASKS = 5;
export const LEADERSHIP_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const LEADERSHIP_LEVEL_THRESHOLDS = Object.freeze({ L0: 0, L1: 60, L2: 75, L3: 88 });
export const LEADERSHIP_RETENTION_THRESHOLDS = Object.freeze({ L0: 0, L1: 50, L2: 65, L3: 78 });
export const LEADERSHIP_METRIC_WEIGHTS = Object.freeze({
  deliveryQuality: 0.25,
  decompositionMatching: 0.20,
  reviewReworkControl: 0.20,
  dependencyCoordination: 0.15,
  teamEfficiencyUplift: 0.10,
  safety: 0.10,
});
export const LEADERSHIP_LEVEL_CAPS = Object.freeze({
  L0: { roles: [], maxAgents: 0, maxNodes: 1, maxTaskGroups: 0, crossDepartment: false },
  L1: { roles: ['task_lead'], maxAgents: 3, maxNodes: 6, maxTaskGroups: 1, crossDepartment: false },
  L2: { roles: ['task_lead', 'team_lead'], maxAgents: 6, maxNodes: 12, maxTaskGroups: 1, crossDepartment: false },
  L3: { roles: ['task_lead', 'team_lead', 'cross_team_lead'], maxAgents: 20, maxNodes: 20, maxTaskGroups: 4, crossDepartment: true },
});

export const LEADERSHIP_PROMOTION_TASKS = Object.freeze({ L1: 5, L2: 15, L3: 30 });
export const LEADERSHIP_PROMOTION_P_LEVELS = Object.freeze({ L1: 3, L2: 5, L3: 7 });
const WORK_HOARDING_THRESHOLDS = Object.freeze({ task_lead: 0.50, team_lead: 0.40, cross_team_lead: 0.25 });

export function calculateLeadershipEvaluation(input = {}) {
  const deterministic = input.deterministic || input;
  const review = input.governanceReview || input.governance_review || {};
  const role = normalizeLeadershipRole(input.role || 'task_lead');
  const metrics = {
    deliveryQuality: bounded(review.deliveryQuality ?? deterministic.deliveryQuality ?? deterministic.acceptanceScore ?? 0),
    decompositionMatching: bounded(review.decompositionMatching ?? deterministic.decompositionMatching ?? 0),
    reviewReworkControl: bounded(review.reviewReworkControl ?? deterministic.reviewReworkControl ?? reworkControlScore(deterministic)),
    dependencyCoordination: bounded(review.dependencyCoordination ?? deterministic.dependencyCoordination ?? coordinationScore(deterministic)),
    teamEfficiencyUplift: bounded(review.teamEfficiencyUplift ?? deterministic.teamEfficiencyUplift ?? upliftScore(deterministic)),
    safety: bounded(deterministic.safety ?? safetyScore(deterministic)),
  };
  const workHoarding = workHoardingAssessment(deterministic, role);
  const score = round(Math.max(0, Object.entries(LEADERSHIP_METRIC_WEIGHTS)
    .reduce((sum, [key, weight]) => sum + metrics[key] * weight, 0) - workHoarding.penalty));
  const evidenceRefs = uniqueStrings([
    ...(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []),
    ...(Array.isArray(review.evidenceRefs) ? review.evidenceRefs : []),
  ]);
  const severeSafetyViolation = Boolean(deterministic.severeSafetyViolation || deterministic.severe_safety_violation);
  return {
    agentInstanceId: String(input.agentInstanceId || input.agent_instance_id || ''),
    taskId: String(input.taskId || input.task_id || ''),
    workScopeId: String(input.workScopeId || input.work_scope_id || ''),
    assignmentId: String(input.assignmentId || input.assignment_id || ''),
    assignmentMode: normalizeAssignmentMode(input.assignmentMode || input.assignment_mode),
    role,
    taskTypeKey: String(input.taskTypeKey || input.task_type_key || 'general'),
    departmentCount: Math.max(1, integer(input.departmentCount ?? input.department_count, 1)),
    participantCount: Math.max(1, integer(input.participantCount ?? input.participant_count, 1)),
    completedAt: isoDate(input.completedAt || input.completed_at || input.occurredAt || input.occurred_at),
    metrics,
    score,
    evidenceRefs,
    evidenceComplete: input.evidenceComplete !== false && evidenceRefs.length > 0,
    severeSafetyViolation,
    workHoarding,
    operational: {
      actualDurationMs: Math.max(0, Number(deterministic.actualDurationMs ?? deterministic.actual_duration_ms ?? 0)),
      estimatedDurationMs: Math.max(0, Number(deterministic.estimatedDurationMs ?? deterministic.estimated_duration_ms ?? 0)),
      completedNodeCount: Math.max(0, integer(deterministic.completedNodeCount ?? deterministic.completed_node_count, 0)),
      totalNodeCount: Math.max(0, integer(deterministic.totalNodeCount ?? deterministic.total_node_count, 0)),
    },
    baseline: normalizeBaseline(review.baseline || input.baseline),
    evaluatorVersion: String(input.evaluatorVersion || input.evaluator_version || ''),
    governanceDecision: normalizeGovernanceDecision(review.decision || input.governanceDecision || input.governance_decision),
  };
}

export function calculateLeadershipSnapshot(evaluations = [], {
  now = new Date(), currentLevel = 'L0', status = 'active',
  windowDays = LEADERSHIP_WINDOW_DAYS, maxAssignments = LEADERSHIP_MAX_ASSIGNMENTS,
} = {}) {
  const cutoff = now.getTime() - Math.max(1, Number(windowDays || LEADERSHIP_WINDOW_DAYS)) * 86400000;
  const items = evaluations
    .map((item) => item?.metrics ? normalizeEvaluation(item) : calculateLeadershipEvaluation(item))
    .filter((item) => item.taskId && Date.parse(item.completedAt) >= cutoff && item.evidenceComplete)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    .slice(0, Math.max(1, Number(maxAssignments || LEADERSHIP_MAX_ASSIGNMENTS)));
  let weightedScore = 0;
  let totalWeight = 0;
  const metrics = Object.fromEntries(Object.keys(LEADERSHIP_METRIC_WEIGHTS).map((key) => [key, 0]));
  const rawWeights = items.map((item) => item.assignmentMode === 'trial' ? 0.75
    : item.departmentCount > 1 || item.role === 'cross_team_lead' ? 1.25 : 1);
  const rawWeightTotal = rawWeights.reduce((sum, weight) => sum + weight, 0);
  for (const [index, item] of items.entries()) {
    const weight = items.length >= 10 ? Math.min(rawWeights[index], rawWeightTotal * 0.10) : rawWeights[index];
    weightedScore += item.score * weight;
    totalWeight += weight;
    for (const key of Object.keys(metrics)) metrics[key] += item.metrics[key] * weight;
  }
  const score = round(totalWeight ? weightedScore / totalWeight : 0);
  for (const key of Object.keys(metrics)) metrics[key] = round(totalWeight ? metrics[key] / totalWeight : 0);
  const taskCount = items.length;
  const teamLeadTrialCount = items.filter((item) => item.assignmentMode === 'trial' && item.role === 'team_lead').length;
  const crossTeamTrialCount = items.filter((item) => item.assignmentMode === 'trial' && item.role === 'cross_team_lead').length;
  const crossTeamGovernanceApprovals = items.filter((item) => item.assignmentMode === 'trial' && item.role === 'cross_team_lead' && item.governanceDecision === 'approved').length;
  const baselineComparisons = items.filter((item) => item.baseline.available && item.baseline.passed);
  const baselineUplift = round(average(baselineComparisons.map((item) => item.baseline.uplift), 0));
  const severeSafetyViolation = items.some((item) => item.severeSafetyViolation);
  const severeSafetyInputHash = hashObject(items.filter((item) => item.severeSafetyViolation).map((item) => [item.taskId, item.assignmentId, item.completedAt]));
  const normalizedLevel = normalizeLeadershipLevel(currentLevel);
  return {
    algorithmVersion: LEADERSHIP_ALGORITHM_VERSION,
    windowDays,
    maxAssignments,
    windowStartedAt: new Date(cutoff).toISOString(),
    windowEndedAt: now.toISOString(),
    score,
    level: normalizedLevel,
    status: severeSafetyViolation ? 'frozen' : normalizeLeadershipStatus(status),
    provisional: taskCount < LEADERSHIP_PROVISIONAL_TASKS,
    leadershipTaskCount: taskCount,
    taskIds: items.map((item) => item.taskId),
    crossDepartmentTaskCount: items.filter((item) => item.departmentCount > 1 || item.role === 'cross_team_lead').length,
    teamLeadTrialCount,
    crossTeamTrialCount,
    crossTeamGovernanceApprovals,
    governanceApproved: crossTeamGovernanceApprovals >= 3,
    baselineComparisonCount: baselineComparisons.length,
    baselineUplift,
    metrics,
    severeSafetyViolation,
    severeSafetyInputHash,
    inputHash: hashObject(items.map((item) => [item.taskId, item.assignmentId, item.completedAt, item.score, item.evidenceRefs])),
    nextLevel: nextLeadershipLevel(normalizedLevel),
    promotion: leadershipPromotionReadiness({ currentLevel: normalizedLevel, score, taskCount, teamLeadTrialCount,
      crossTeamTrialCount, crossDepartmentTaskCount: items.filter((item) => item.departmentCount > 1 || item.role === 'cross_team_lead').length,
      baselineComparisonCount: baselineComparisons.length, baselineUplift, governanceApproved: crossTeamGovernanceApprovals >= 3,
      severeSafetyViolation }),
  };
}

export function leadershipPromotionReadiness({
  currentLevel = 'L0', score = 0, taskCount = 0, teamLeadTrialCount = 0,
  crossTeamTrialCount = 0, crossDepartmentTaskCount = 0, baselineComparisonCount = 0, baselineUplift = 0,
  professionalLevel = '', professionalProvisional = true, governanceApproved = false,
  severeSafetyViolation = false,
} = {}) {
  const fromLevel = normalizeLeadershipLevel(currentLevel);
  const targetLevel = nextLeadershipLevel(fromLevel);
  if (!targetLevel) return { ready: false, fromLevel, targetLevel: '', reason: 'maximum_level', reasons: ['maximum_level'] };
  const reasons = [];
  const threshold = LEADERSHIP_LEVEL_THRESHOLDS[targetLevel];
  if (Number(score || 0) < threshold) reasons.push('score_below_threshold');
  if (Number(taskCount || 0) < LEADERSHIP_PROMOTION_TASKS[targetLevel]) reasons.push('leadership_tasks_insufficient');
  if (severeSafetyViolation) reasons.push('safety_frozen');
  const requiredProfessionalLevel = LEADERSHIP_PROMOTION_P_LEVELS[targetLevel];
  if (professionalProvisional || professionalLevelNumber(professionalLevel) < requiredProfessionalLevel) {
    reasons.push(`professional_p${requiredProfessionalLevel}_required`);
  }
  if (targetLevel === 'L2') {
    if (teamLeadTrialCount < 2) reasons.push('team_lead_trials_insufficient');
    if (baselineComparisonCount < 1 || baselineUplift <= 0) reasons.push('baseline_uplift_required');
  }
  if (targetLevel === 'L3') {
    if (crossTeamTrialCount < 3) reasons.push('cross_team_trials_insufficient');
    if (crossDepartmentTaskCount < 10) reasons.push('cross_department_tasks_insufficient');
    if (baselineComparisonCount < 3 || baselineUplift < 5) reasons.push('five_percent_uplift_required');
    if (!governanceApproved) reasons.push('governance_approval_required');
  }
  return { ready: reasons.length === 0, fromLevel, targetLevel, threshold,
    minimumTasks: LEADERSHIP_PROMOTION_TASKS[targetLevel], minimumProfessionalLevel: `P${requiredProfessionalLevel}`,
    approvalRequired: ['L2', 'L3'].includes(targetLevel),
    automatic: targetLevel === 'L1', reasons };
}

export function leadershipAssignmentEligibility({
  level = 'L0', status = 'active', role = 'task_lead', assignmentMode = 'normal',
  participantCount = 1, nodeCount = 1, taskGroupCount = 1, activeTaskGroups = 0, departmentCount = 1,
  professionalLevel = '', professionalProvisional = true, ownerApproved = false, supervisorApproved = false,
  governanceApproved = false,
} = {}) {
  const normalizedLevel = normalizeLeadershipLevel(level);
  const normalizedRole = normalizeLeadershipRole(role);
  const mode = normalizeAssignmentMode(assignmentMode);
  const reasons = [];
  if (normalizeLeadershipStatus(status) !== 'active') reasons.push('leadership_not_active');
  if (mode === 'trial') {
    const caps = trialCaps(normalizedLevel, normalizedRole);
    if (!caps) reasons.push('trial_role_not_available');
    else {
      if (!ownerApproved && !supervisorApproved) reasons.push('supervisor_approval_required');
      if (participantCount > caps.maxAgents) reasons.push('agent_limit_exceeded');
      if (nodeCount > caps.maxNodes) reasons.push('node_limit_exceeded');
      if (departmentCount > (caps.crossDepartment ? 99 : 1)) reasons.push('cross_department_not_allowed');
      if (activeTaskGroups + taskGroupCount > caps.maxTaskGroups) reasons.push('task_group_limit_exceeded');
      const targetLevel = nextLeadershipLevel(normalizedLevel);
      const requiredProfessionalLevel = LEADERSHIP_PROMOTION_P_LEVELS[targetLevel] || 10;
      if (professionalProvisional || professionalLevelNumber(professionalLevel) < requiredProfessionalLevel) reasons.push(`professional_p${requiredProfessionalLevel}_required`);
      if (targetLevel === 'L3' && !governanceApproved) reasons.push('governance_approval_required');
    }
    return { eligible: reasons.length === 0, level: normalizedLevel, role: normalizedRole, assignmentMode: mode, caps: caps || {}, reasons };
  }
  const caps = LEADERSHIP_LEVEL_CAPS[normalizedLevel];
  if (!caps.roles.includes(normalizedRole)) reasons.push('leadership_level_insufficient');
  if (participantCount > caps.maxAgents) reasons.push('agent_limit_exceeded');
  if (nodeCount > caps.maxNodes) reasons.push('node_limit_exceeded');
  if (activeTaskGroups + taskGroupCount > caps.maxTaskGroups) reasons.push('task_group_limit_exceeded');
  if (departmentCount > 1 && !caps.crossDepartment) reasons.push('cross_department_not_allowed');
  return { eligible: reasons.length === 0, level: normalizedLevel, role: normalizedRole, assignmentMode: mode, caps, reasons };
}

export function nextLeadershipLevel(level = 'L0') {
  const index = LEADERSHIP_LEVELS.indexOf(normalizeLeadershipLevel(level));
  return index >= 0 && index < LEADERSHIP_LEVELS.length - 1 ? LEADERSHIP_LEVELS[index + 1] : '';
}

export function normalizeLeadershipLevel(value = 'L0') {
  const level = String(value || 'L0').toUpperCase();
  return LEADERSHIP_LEVELS.includes(level) ? level : 'L0';
}

export function normalizeLeadershipRole(value = 'task_lead') {
  const role = String(value || 'task_lead').toLowerCase();
  return ['task_lead', 'team_lead', 'cross_team_lead'].includes(role) ? role : 'task_lead';
}

export function normalizeAssignmentMode(value = 'normal') {
  return String(value || 'normal').toLowerCase() === 'trial' ? 'trial' : 'normal';
}

function trialCaps(level, role) {
  if (level === 'L0' && role === 'task_lead') return { roles: ['task_lead'], targetLevel: 'L1', maxAgents: 3, maxNodes: 6, maxTaskGroups: 1, crossDepartment: false };
  if (level === 'L1' && role === 'team_lead') return { roles: ['team_lead'], targetLevel: 'L2', maxAgents: 6, maxNodes: 12, maxTaskGroups: 1, crossDepartment: false };
  if (level === 'L2' && role === 'cross_team_lead') return { roles: ['cross_team_lead'], targetLevel: 'L3', maxAgents: 20, maxNodes: 20, maxTaskGroups: 4, crossDepartment: true };
  return null;
}

function normalizeEvaluation(item = {}) {
  return { ...item, agentInstanceId: String(item.agentInstanceId || item.agent_instance_id || ''), taskId: String(item.taskId || item.task_id || ''), assignmentId: String(item.assignmentId || item.assignment_id || ''),
    completedAt: isoDate(item.completedAt || item.completed_at), assignmentMode: normalizeAssignmentMode(item.assignmentMode || item.assignment_mode),
    role: normalizeLeadershipRole(item.role), departmentCount: Math.max(1, integer(item.departmentCount ?? item.department_count, 1)),
    score: bounded(item.score), metrics: Object.fromEntries(Object.keys(LEADERSHIP_METRIC_WEIGHTS).map((key) => [key, bounded(item.metrics?.[key])])),
    evidenceRefs: uniqueStrings(item.evidenceRefs || item.evidence_refs || []), evidenceComplete: item.evidenceComplete !== false,
    baseline: normalizeBaseline(item.baseline), governanceDecision: normalizeGovernanceDecision(item.governanceDecision || item.governance_decision) };
}

function reworkControlScore(input) {
  const rework = Math.max(0, Number(input.reworkCount ?? input.rework_count ?? 0));
  const escaped = Math.max(0, Number(input.escapedErrorCount ?? input.escaped_error_count ?? 0));
  const caught = Math.max(0, Number(input.caughtErrorCount ?? input.caught_error_count ?? 0));
  return bounded(80 + caught * 5 - rework * 12 - escaped * 20);
}

function coordinationScore(input) {
  const blockedMinutes = Math.max(0, Number(input.avoidableBlockedMinutes ?? input.avoidable_blocked_minutes ?? 0));
  const missed = Math.max(0, Number(input.missedDependencyNotificationCount ?? input.missed_dependency_notification_count ?? 0));
  const response = bounded(input.blockerResponseScore ?? input.blocker_response_score ?? 100);
  return bounded(response - Math.min(45, blockedMinutes / 4) - missed * 10);
}

function upliftScore(input) { return bounded(50 + Number(input.baselineUplift ?? input.baseline_uplift ?? 0) * 5); }
function workHoardingAssessment(input = {}, role = 'task_lead') {
  const totalNodeCount = Math.max(0, Number(input.totalNodeCount ?? input.total_node_count ?? 0));
  const validTakeoverNodeCount = Math.max(0, Number(input.validTakeoverNodeCount ?? input.valid_takeover_node_count ?? 0));
  const reportedShare = Math.max(0, Math.min(1, Number(input.leaderNodeShare ?? input.leader_node_share ?? 0)));
  const takeoverShare = totalNodeCount > 0 ? Math.min(reportedShare, validTakeoverNodeCount / totalNodeCount) : 0;
  const effectiveShare = Math.max(0, reportedShare - takeoverShare);
  const threshold = WORK_HOARDING_THRESHOLDS[role] ?? 0.50;
  const penalty = round(Math.min(20, Math.max(0, effectiveShare - threshold) * 50));
  return { leaderNodeShare: round(reportedShare, 4), validTakeoverShare: round(takeoverShare, 4),
    effectiveLeaderNodeShare: round(effectiveShare, 4), threshold, penalty };
}
function safetyScore(input) {
  if (input.severeSafetyViolation || input.severe_safety_violation) return 0;
  return bounded(100 - Math.max(0, Number(input.securityViolationCount ?? input.security_violation_count ?? 0)) * 25
    - Math.max(0, Number(input.unauthorizedAccessCount ?? input.unauthorized_access_count ?? 0)) * 15);
}

function normalizeBaseline(value = {}) {
  const baseline = value && typeof value === 'object' ? value : {};
  return { available: Boolean(baseline.available), kind: String(baseline.kind || ''),
    sampleCount: Math.max(0, integer(baseline.sampleCount ?? baseline.sample_count, 0)), uplift: round(Number(baseline.uplift || 0)),
    passed: Boolean(baseline.passed), referenceId: String(baseline.referenceId || baseline.reference_id || '') };
}

function normalizeLeadershipStatus(value = 'active') {
  const status = String(value || 'active').toLowerCase();
  return ['active', 'frozen', 'inactive'].includes(status) ? status : 'active';
}
function normalizeGovernanceDecision(value = '') {
  const decision = String(value || '').toLowerCase();
  return ['approved', 'full', 'pass'].includes(decision) ? 'approved' : ['rejected', 'reject', 'failed'].includes(decision) ? 'rejected' : 'pending';
}
function professionalLevelNumber(value = '') { return Math.max(0, Math.min(10, Number(String(value || '').replace(/^P/i, '')) || 0)); }
function isoDate(value) { const timestamp = Date.parse(value || ''); return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString(); }
function integer(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? Math.trunc(number) : fallback; }
function bounded(value) { return Math.min(100, Math.max(0, Number(value || 0))); }
function round(value, digits = 2) { const factor = 10 ** digits; return Math.round(Number(value || 0) * factor) / factor; }
function average(values, fallback = 0) { return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : fallback; }
function uniqueStrings(values = []) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))]; }
function hashObject(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
