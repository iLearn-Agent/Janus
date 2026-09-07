import crypto from 'node:crypto';

import {
  CLUSTER_EVOLUTION_ALGORITHM_VERSION,
  CLUSTER_MAXIMUM_USER_WEIGHT_SHARE,
  CLUSTER_MINIMUM_USERS,
  EVIDENCE_CONTRACT_POLICY_VERSION,
  clusterEvidenceCategory,
  clusterReEvaluationBasisHash,
  stableClusterCohortKey,
} from './contracts.js';
import { diagnoseEvolutionEvidence } from './diagnosis.js';
import { evolutionPrivacyFindings, sanitizeEvolutionPayloadForStorage } from './core.js';

export const PHASE8_ALGORITHM_VERSION = CLUSTER_EVOLUTION_ALGORITHM_VERSION;
export const PERFORMANCE_ALGORITHM_VERSION = 'performance_90d_100tasks_v2';
export const PERFORMANCE_WINDOW_DAYS = 90;
export const PERFORMANCE_MAX_TASKS = 100;
export const PERFORMANCE_MINIMUM_PEER_SAMPLE = 5;
export const CLUSTER_MIN_USERS = CLUSTER_MINIMUM_USERS;
export const CLUSTER_MIN_SUPPORTERS = 3;
export const CLUSTER_USER_WEIGHT_CAP = CLUSTER_MAXIMUM_USER_WEIGHT_SHARE;
export const CLUSTER_CANARY_MINIMUM_USERS = CLUSTER_MINIMUM_USERS;
export const CLUSTER_CANARY_MINIMUM_CASES = CLUSTER_MINIMUM_USERS;

const LEVEL_WEIGHTS = Object.freeze({ P1: 0.5, P2: 0.6, P3: 0.75, P4: 0.9, P5: 1, P6: 1.15, P7: 1.3, P8: 1.5, P9: 1.75, P10: 2 });

export function calculatePerformanceSnapshot(events = [], { now = new Date(), windowDays = PERFORMANCE_WINDOW_DAYS, maxTasks = PERFORMANCE_MAX_TASKS } = {}) {
  const cutoff = now.getTime() - Math.max(1, Number(windowDays || PERFORMANCE_WINDOW_DAYS)) * 86400000;
  const tasks = normalizeTaskEvents(events)
    .filter((item) => !item.completedAt || Date.parse(item.completedAt) >= cutoff)
    .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    .slice(0, Math.max(1, Number(maxTasks || PERFORMANCE_MAX_TASKS)));
  if (!tasks.length) return {
    algorithmVersion: PERFORMANCE_ALGORITHM_VERSION,windowDays,maxTasks,
    windowStartedAt:new Date(cutoff).toISOString(),windowEndedAt:now.toISOString(),completedTaskCount:0,terminalAttemptCount:0,
    quality:0,reliability:0,firstPass:0,efficiency:0,collaborationSafety:0,failureRate:0,blockedRate:0,
    score:0,level:'P1',provisional:true,provisionalReason:'fewer_than_10_completed_tasks',authority:'cloud',
    peerBaselineKind:'unavailable',peerSampleCount:0,contributionWeight:0.5,inputHash:hashObject([]),
  };
  const completed = tasks.filter((item) => item.completed || item.accepted);
  const qualityTasks = tasks.filter((item) => item.completed || item.accepted || item.rework || item.failed);
  const quality = average(qualityTasks.map(taskQuality), 0);
  const terminal = tasks.filter((item) => item.terminal !== false && !item.cancelled);
  const failureRate = ratio(terminal.filter((item) => item.failed).length, terminal.length);
  const blockedRate = ratio(terminal.filter((item) => item.blocked).length, terminal.length);
  const reliability = bounded(100 * (1 - 0.7 * failureRate - 0.3 * blockedRate));
  const accepted = qualityTasks.filter((item) => item.accepted || item.acceptanceScore !== null);
  const firstPass = 100 * ratio(accepted.filter((item) => item.firstPass).length, accepted.length);
  const efficiencyTasks = tasks.filter((item) => (item.completed || item.accepted || item.rework) && !item.failed);
  const efficiency = average(efficiencyTasks.map(taskEfficiency), 50);
  const response = 100 * ratio(tasks.filter((item) => item.responseWithinSla).length, tasks.filter((item) => item.hasResponseSignal).length);
  const evidence = 100 * ratio(tasks.filter((item) => item.evidenceComplete).length, tasks.length);
  const security = bounded(100 - tasks.reduce((sum, item) => sum + item.securityViolationCount * 25, 0));
  const collaborationSafety = tasks.length ? bounded(response * 0.4 + evidence * 0.35 + security * 0.25) : 0;
  const score = round(quality * 0.4 + reliability * 0.2 + firstPass * 0.15 + efficiency * 0.15 + collaborationSafety * 0.1);
  const level = performanceLevel(score);
  const completedTaskCount = completed.length;
  const peerBaselineKinds = uniqueStrings(efficiencyTasks.map((item) => item.peerBaselineKind).filter(Boolean));
  return {
    algorithmVersion: PERFORMANCE_ALGORITHM_VERSION,
    windowDays,
    maxTasks,
    windowStartedAt: new Date(cutoff).toISOString(),
    windowEndedAt: now.toISOString(),
    completedTaskCount,
    terminalAttemptCount: terminal.length,
    quality: round(quality), reliability: round(reliability), firstPass: round(firstPass), efficiency: round(efficiency), collaborationSafety: round(collaborationSafety),
    failureRate: round(failureRate, 4), blockedRate: round(blockedRate, 4), score, level,
    provisional: completedTaskCount < 10,
    provisionalReason: completedTaskCount < 10 ? 'fewer_than_10_completed_tasks' : '',
    authority: 'cloud',
    peerBaselineKind: peerBaselineKinds.length === 1 ? peerBaselineKinds[0] : peerBaselineKinds.length ? 'mixed' : 'unavailable',
    peerSampleCount: Math.max(0, ...efficiencyTasks.map((item) => Number(item.peerSampleCount || 0))),
    contributionWeight: completedTaskCount < 10 ? Math.min(1, LEVEL_WEIGHTS[level]) : LEVEL_WEIGHTS[level],
    inputHash: hashObject(tasks),
  };
}

export function deriveAuthoritativeTaskPerformanceEvent({ node = {}, run = {}, instance = {}, sourceVersionId = '' } = {}) {
  const status = String(node.status || '').trim().toLowerCase();
  if (!['completed', 'accepted', 'rework', 'failed', 'blocked', 'cancelled'].includes(status)) return null;
  const sourceId = String(node.id || '').trim();
  const agentInstanceId = String(node.agentInstanceId || node.agent_instance_id || node.userAgentInstanceId || node.user_agent_instance_id || instance.id || '').trim();
  const ownerUserId = String(run.ownerUserId || run.owner_user_id || instance.ownerUserId || instance.user_id || '').trim();
  if (!sourceId || !agentInstanceId || !ownerUserId) return null;
  const metadata = { ...objectValue(run.metadata_json), ...objectValue(run.metadata), ...objectValue(node.metadata_json), ...objectValue(node.metadata) };
  const startedAt = node.startedAt || node.started_at || '';
  const completedAt = node.completedAt || node.completed_at || node.updatedAt || node.updated_at || sourceVersionId || '';
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  const actualMinutes = Number.isFinite(startedMs) && Number.isFinite(completedMs) ? Math.max(0, (completedMs - startedMs) / 60000) : 0;
  const evidenceRefs = arrayValue(node.evidenceRefs || node.evidence_refs || node.evidence_json || node.evidence);
  const acceptanceScore = finiteOrNull(metadata.acceptanceScore ?? metadata.acceptance_score);
  const accepted = status === 'accepted' || Boolean(metadata.accepted);
  const completed = ['completed', 'accepted'].includes(status);
  const rework = status === 'rework' || Boolean(metadata.rework);
  return {
    id: '', ownerUserId, agentInstanceId,
    agentFamilyId: String(instance.agentFamilyId || instance.agent_family_id || ''),
    taskId: String(node.taskRunId || node.task_run_id || run.id || ''),
    taskTypeKey: String(metadata.taskTypeKey || metadata.task_type_key || run.departmentId || run.department_id || instance.agentFamilyId || instance.agent_family_id || 'general'),
    eventKind: `task_${status}`, occurredAt: completedAt, completedAt,
    acceptanceScore, accepted, completed,
    completedUnreviewed: completed && !accepted && acceptanceScore === null,
    rework, failed: status === 'failed', blocked: status === 'blocked', cancelled: status === 'cancelled',
    terminal: status !== 'cancelled',
    firstPass: Boolean(metadata.firstPass ?? metadata.first_pass ?? (accepted && !rework)),
    estimatedMinutes: Math.max(0, Number(node.estimatedMinutes ?? node.estimated_minutes ?? 0)),
    actualMinutes,
    responseWithinSla: Boolean(metadata.responseWithinSla ?? metadata.response_within_sla),
    hasResponseSignal: Boolean(metadata.hasResponseSignal ?? metadata.has_response_signal),
    evidenceComplete: evidenceRefs.length > 0,
    securityViolationCount: Math.max(0, Number(metadata.securityViolationCount ?? metadata.security_violation_count ?? 0)),
    sourceKind: 'task_node', sourceId, sourceVersionId: String(sourceVersionId || node.updatedAt || node.updated_at || ''),
    sourceHash: hashObject({ sourceId, status, completedAt, acceptanceScore, accepted, rework, actualMinutes, evidenceRefs, metadata }),
    authority: 'cloud', validationStatus: 'validated',
  };
}

export function enrichPerformanceEventsWithPeerBaselines(events = [], population = [], { minimumPeerSample = PERFORMANCE_MINIMUM_PEER_SAMPLE } = {}) {
  const peers = normalizeTaskEvents(population).filter((item) => (item.completed || item.accepted) && !item.failed && Number(item.actualMinutes || 0) > 0);
  return normalizeTaskEvents(events).map((item) => {
    const eligible = peers.filter((peer) => peer.agentInstanceId !== item.agentInstanceId);
    const sameType = eligible.filter((peer) => peer.taskTypeKey === item.taskTypeKey);
    if (sameType.length >= minimumPeerSample) return { ...item, peerMedianMinutes: median(sameType.map((peer) => peer.actualMinutes)), peerBaselineKind: 'task_type', peerSampleCount: sameType.length };
    const sameFamily = eligible.filter((peer) => peer.agentFamilyId && peer.agentFamilyId === item.agentFamilyId);
    if (sameFamily.length >= minimumPeerSample) return { ...item, peerMedianMinutes: median(sameFamily.map((peer) => peer.actualMinutes)), peerBaselineKind: 'agent_family', peerSampleCount: sameFamily.length };
    if (Number(item.estimatedMinutes || 0) > 0) return { ...item, peerMedianMinutes: Number(item.estimatedMinutes), peerBaselineKind: 'estimate', peerSampleCount: 0 };
    return { ...item, peerMedianMinutes: 0, peerBaselineKind: 'neutral', peerSampleCount: 0 };
  });
}

export function evaluateRealUserCanary({
  assignments = [], events = [], minimumUsers = CLUSTER_CANARY_MINIMUM_USERS,
  minimumCases = CLUSTER_CANARY_MINIMUM_CASES, maximumScoreRegression = 10,
  maximumFailureRateIncrease = 0.1,
} = {}) {
  const enrolled = assignments.filter((item) => (item.status || 'enrolled') === 'enrolled');
  const assignmentByInstance = new Map(enrolled.map((item) => [String(item.agentInstanceId || item.user_agent_instance_id || ''), item]));
  const observed = normalizeTaskEvents(events).filter((item) => assignmentByInstance.has(item.agentInstanceId));
  const userIds = new Set(observed.map((item) => String(assignmentByInstance.get(item.agentInstanceId)?.ownerUserId
    || assignmentByInstance.get(item.agentInstanceId)?.user_id || item.ownerUserId || '')).filter(Boolean));
  const caseCount = observed.length;
  const baselineScores = enrolled.map((item) => Number(item.baselineScore ?? item.baseline_score)).filter(Number.isFinite);
  const baselineFailureRates = enrolled.map((item) => Number(item.baselineFailureRate ?? item.baseline_failure_rate)).filter(Number.isFinite);
  const baselineScore = round(average(baselineScores, 0));
  const baselineFailureRate = round(average(baselineFailureRates, 0), 4);
  const candidateScore = round(average(observed.map(taskQuality), 0));
  const terminal = observed.filter((item) => item.terminal !== false && !item.cancelled);
  const candidateFailureRate = round(ratio(terminal.filter((item) => item.failed || item.blocked).length, terminal.length), 4);
  const privacyViolation = observed.some((item) => item.confirmedPrivacyViolation);
  const roleViolation = observed.some((item) => item.confirmedRoleViolation);
  const result = {
    policyVersion: 'market_canary_observation_v1', userCount: userIds.size, caseCount,
    minimumUsers, minimumCases, baselineScore, candidateScore, scoreDelta: round(candidateScore - baselineScore),
    baselineFailureRate, candidateFailureRate, failureRateDelta: round(candidateFailureRate - baselineFailureRate, 4),
    privacyViolation, roleViolation,
  };
  if (userIds.size < minimumUsers || caseCount < minimumCases) return { ...result, status: 'insufficient' };
  if (privacyViolation) return { ...result, status: 'rejected', reason: 'canary_privacy_violation' };
  if (roleViolation) return { ...result, status: 'rejected', reason: 'canary_role_violation' };
  if (candidateScore < baselineScore - maximumScoreRegression) return { ...result, status: 'rejected', reason: 'canary_score_regression' };
  if (candidateFailureRate > baselineFailureRate + maximumFailureRateIncrease) return { ...result, status: 'rejected', reason: 'canary_failure_regression' };
  return { ...result, status: 'approved' };
}

export function performanceLevel(score = 0) {
  const value = bounded(score);
  if (value >= 95) return 'P10';
  if (value >= 88) return 'P9';
  if (value >= 80) return 'P8';
  if (value >= 70) return 'P7';
  if (value >= 60) return 'P6';
  if (value >= 50) return 'P5';
  if (value >= 40) return 'P4';
  if (value >= 30) return 'P3';
  if (value >= 20) return 'P2';
  return 'P1';
}

export function buildCohortEligibility({
  instances = [], evidence = [], evidenceForCohort = null, minimumUsers = CLUSTER_MIN_USERS, evidenceThresholds = { total: 1 },
} = {}) {
  const active = instances.filter((item) => item.status === 'active' && item.syncEnabled !== false && item.ownerUserId && item.agentInstanceId);
  const familyGroups = groupBy(active, (item) => item.agentFamilyId);
  const cohorts = [];
  const assigned = new Set();
  for (const [familyId, members] of familyGroups) {
    const key = stableClusterCohortKey({ type: 'family', familyId });
    const scopedEvidence = typeof evidenceForCohort === 'function' ? evidenceForCohort({ type: 'family', key, familyId, departmentId: members[0]?.departmentId || '', members }) : evidence;
    const item = cohortEligibility({ type: 'family', key, familyId, departmentId: members[0]?.departmentId || '', members, evidence: scopedEvidence, minimumUsers, evidenceThresholds });
    cohorts.push(item);
    if (item.eligible) members.forEach((member) => assigned.add(member.agentInstanceId));
  }
  const remaining = active.filter((item) => !assigned.has(item.agentInstanceId));
  const departmentGroups = groupBy(remaining.filter((item) => item.departmentId), (item) => item.departmentId);
  for (const [departmentId, departmentMembers] of departmentGroups) {
    for (const members of connectedCapabilityGroups(departmentMembers)) {
      const tags = uniqueStrings(members.flatMap((item) => item.capabilityTags || [])).sort();
      const key = stableClusterCohortKey({ type: 'similar', departmentId, capabilityTags: tags });
      const scopedEvidence = typeof evidenceForCohort === 'function' ? evidenceForCohort({ type: 'similar', key, departmentId, capabilityTags: tags, members }) : evidence;
      cohorts.push(cohortEligibility({ type: 'similar', key, departmentId, members, evidence: scopedEvidence, minimumUsers, evidenceThresholds }));
    }
  }
  return cohorts;
}

export function selectClusterEligibleEvidence({
  cohortKey = '', evidence = [], usage = [], claims = [], algorithmVersion = PHASE8_ALGORITHM_VERSION,
  policyVersion = EVIDENCE_CONTRACT_POLICY_VERSION,
} = {}) {
  const lineageEvidence = dedupeClusterEvidenceLineage(evidence);
  const usageByEvidence = new Map(usage.map((item) => [String(item.evidenceId || item.evidence_id || ''), item]));
  const claimsByEvidence = new Map(claims.map((item) => [String(item.evidenceId || item.evidence_id || ''), item]));
  const relatedByCategory = new Map();
  for (const item of lineageEvidence) {
    const category = clusterEvidenceCategory(item.sourceKind || item.source_kind || '');
    if (!relatedByCategory.has(category)) relatedByCategory.set(category, []);
    relatedByCategory.get(category).push(String(item.evidenceId || item.evidence_id || ''));
  }
  const basisByCategory = new Map([...relatedByCategory].map(([category, evidenceIds]) => [category, clusterReEvaluationBasisHash({
    cohortKey, evidenceCategory: category, algorithmVersion, policyVersion, relatedEvidenceIds: evidenceIds,
  })]));
  const selected = [];
  for (const item of lineageEvidence) {
    const evidenceId = String(item.evidenceId || item.evidence_id || '');
    if (!evidenceId) continue;
    const claim = claimsByEvidence.get(evidenceId);
    if (claim && ['reserved', 'consumed'].includes(String(claim.claimState || claim.claim_state || ''))) continue;
    const currentUsage = usageByEvidence.get(evidenceId);
    const status = String(currentUsage?.status || 'available');
    const category = clusterEvidenceCategory(item.sourceKind || item.source_kind || '');
    const nextBasisHash = basisByCategory.get(category) || '';
    if (['available', 'released'].includes(status)) {
      selected.push({ ...item, evidenceCategory: category, eligibilityKind: 'new', nextReEvaluationBasisHash: '' });
      continue;
    }
    if (status === 'evaluated_rejected' && nextBasisHash
      && nextBasisHash !== String(currentUsage.reEvaluationBasisHash || currentUsage.re_evaluation_basis_hash || '')) {
      selected.push({ ...item, evidenceCategory: category, eligibilityKind: 'reconsiderable', nextReEvaluationBasisHash: nextBasisHash });
    }
  }
  return selected;
}

export function dedupeClusterEvidenceLineage(evidence = []) {
  const metadataFor = (item) => {
    const value=item.metadata||item.metadata_json||{};
    if(value&&typeof value==='object')return value;
    try{return JSON.parse(value||'{}')||{};}catch{return {};}
  };
  const coveredMessages=new Set();
  for(const item of evidence){
    if(String(item.sourceKind||item.source_kind||'')!=='conversation_segment')continue;
    for(const id of metadataFor(item).sourceMessageIds||[])coveredMessages.add(String(id));
  }
  const byLineage=new Map();
  for(const item of evidence){
    const sourceKind=String(item.sourceKind||item.source_kind||'');
    const sourceId=String(item.sourceId||item.source_id||'');
    if(sourceKind==='message'&&coveredMessages.has(sourceId))continue;
    const metadata=metadataFor(item);
    const evidenceId=String(item.evidenceId||item.evidence_id||'');
    const lineage=String(item.lineageKey||item.lineage_key||metadata.lineageKey
      ||(sourceId?`${sourceKind}:${sourceId}:${item.sourceVersionId||item.source_version_id||''}`:evidenceId));
    const current=byLineage.get(lineage);
    if(!current||sourceKind==='conversation_segment')byLineage.set(lineage,item);
  }
  return [...byLineage.values()];
}

export function clusterEvidenceBreakdown(evidence = []) {
  return evidence.reduce((counts, item) => {
    counts.total += 1;
    const category = clusterEvidenceCategory(item.sourceKind || item.source_kind || '');
    if (Object.hasOwn(counts, category)) counts[category] += 1;
    return counts;
  }, { total: 0, chat: 0, memory: 0, completedTask: 0 });
}

export function clusterEvidenceThresholdReasons(evidence = [], thresholds = {}) {
  const breakdown = clusterEvidenceBreakdown(evidence);
  const normalized = { total: 0, chat: 0, memory: 0, completedTask: 0, ...(thresholds || {}) };
  return ['total', 'chat', 'memory', 'completedTask']
    .filter((key) => breakdown[key] < Math.max(0, Number(normalized[key] || 0)))
    .map((key) => `insufficient_${key}_evidence`);
}

export function selectClusterEvidenceWindow(evidence = [], { limit = 180, thresholds = {} } = {}) {
  const maximum = Math.max(1, Number(limit || 180));
  const required = { chat: 0, memory: 0, completedTask: 0, ...(thresholds || {}) };
  const selected = [];
  const selectedIds = new Set();
  for (const category of ['chat', 'memory', 'completedTask']) {
    for (const item of evidence) {
      if (selected.filter((entry) => clusterEvidenceCategory(entry.sourceKind || entry.source_kind || '') === category).length >= Number(required[category] || 0)) break;
      const evidenceId = String(item.evidenceId || item.evidence_id || '');
      if (!evidenceId || selectedIds.has(evidenceId) || clusterEvidenceCategory(item.sourceKind || item.source_kind || '') !== category) continue;
      selected.push(item);
      selectedIds.add(evidenceId);
    }
  }
  for (const item of evidence) {
    if (selected.length >= maximum) break;
    const evidenceId = String(item.evidenceId || item.evidence_id || '');
    if (!evidenceId || selectedIds.has(evidenceId)) continue;
    selected.push(item);
    selectedIds.add(evidenceId);
  }
  return selected.slice(0, maximum);
}

export function capClusterEvidenceWeights(items = [], capShare = CLUSTER_USER_WEIGHT_CAP) {
  const normalizedCapShare = Number(capShare);
  if (!(normalizedCapShare > 0 && normalizedCapShare < 1)) throw new RangeError('Cluster user weight cap must be between zero and one.');
  const normalized = items.map((item) => {
    const rawWeight = Number(item.rawWeight || 0);
    return { ...item, rawWeight: Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : 0 };
  });
  const rawTotal = normalized.reduce((sum, item) => sum + item.rawWeight, 0);
  if (!rawTotal) return [];
  const rawByUser = normalized.reduce((weights, item) => {
    const userId = String(item.ownerUserId || '');
    weights.set(userId, (weights.get(userId) || 0) + item.rawWeight);
    return weights;
  }, new Map());
  const positiveUsers = [...rawByUser.entries()].filter(([, weight]) => weight > 0);
  const minimumUsers = Math.ceil(1 / normalizedCapShare);
  if (positiveUsers.length < minimumUsers) {
    const error = new RangeError(`Cluster user weight cap requires at least ${minimumUsers} positive-weight users.`);
    error.code = 'insufficient_users_for_weight_cap';
    error.minimumUsers = minimumUsers;
    throw error;
  }
  const cappedUsers = new Set();
  let effectiveTotal = rawTotal;
  let userCap = effectiveTotal * normalizedCapShare;
  while (true) {
    const newlyCapped = positiveUsers.filter(([userId, weight]) => !cappedUsers.has(userId) && weight > userCap);
    if (!newlyCapped.length) break;
    newlyCapped.forEach(([userId]) => cappedUsers.add(userId));
    const denominator = 1 - cappedUsers.size * normalizedCapShare;
    if (denominator <= 0) throw new Error('Cluster user weight cap normalization is infeasible.');
    const uncappedRawTotal = positiveUsers.reduce((sum, [userId, weight]) => sum + (cappedUsers.has(userId) ? 0 : weight), 0);
    effectiveTotal = uncappedRawTotal / denominator;
    userCap = effectiveTotal * normalizedCapShare;
  }
  const targetByUser = new Map(positiveUsers.map(([userId, weight]) => [userId, cappedUsers.has(userId) ? userCap : weight]));
  const weighted = normalized.map((item) => {
    const userId = String(item.ownerUserId || '');
    const userRawWeight = rawByUser.get(userId) || 0;
    const effectiveWeight = userRawWeight > 0 ? item.rawWeight * (targetByUser.get(userId) || 0) / userRawWeight : 0;
    return {
      ...item,
      effectiveWeight,
      clippedWeight: item.rawWeight - effectiveWeight,
      cohortRawTotal: rawTotal,
      userCap,
    };
  }).filter((item) => item.effectiveWeight > 0);
  assertClusterUserWeightCap(weighted, normalizedCapShare);
  return weighted;
}

export function clusterEvidenceWeight({ performanceWeight = 1, confidence = 1, occurredAt = '', relevance = 1, acceptanceQuality = 1, now = new Date() } = {}) {
  const ageDays = occurredAt ? Math.max(0, (now.getTime() - Date.parse(occurredAt)) / 86400000) : 0;
  const timeDecay = Math.pow(0.5, ageDays / 90);
  return round(Math.max(0, performanceWeight) * bounded01(confidence) * timeDecay * bounded01(relevance) * bounded01(acceptanceQuality), 6);
}

export async function runClusterEvolutionCore({
  cohort,
  evidence = [],
  currentMarketSections = [],
  modelExecutor,
  holdoutCases = [],
  supportSecret = crypto.randomBytes(32),
  privacyContext = {},
} = {}) {
  if (typeof modelExecutor !== 'function') throw new Error('Cluster evolution requires a model executor.');
  const diagnosis = diagnoseEvolutionEvidence({
    agentFamilyId: cohort.familyId || uniqueStrings(cohort.members?.map((item) => item.agentFamilyId))[0] || '',
    departmentId: cohort.departmentId || '',
    evidence,
  });
  const shadowCases = deriveCrossUserHoldout(evidence, CLUSTER_CANARY_MINIMUM_USERS);
  const heldOutIds = new Set(shadowCases.map((item) => item.evidenceId));
  const proposalEvidence = evidence.filter((item) => !heldOutIds.has(item.evidenceId));
  const anonymousEvidence = anonymizeClusterEvidence(proposalEvidence, supportSecret);
  const resolvedPrivacyContext = buildMarketPrivacyContext({ cohort, evidence: proposalEvidence, privacyContext });
  const raw = await modelExecutor({ kind: 'cluster_proposal', modelRole: 'cluster_proposer',
    prompt: clusterProposalPrompt(cohort, anonymousEvidence, currentMarketSections, diagnosis) });
  const proposal = parseJsonObject(raw, 'Cluster proposer returned invalid JSON.');
  const initialSections = normalizeMarketSections(proposal.sections || []);
  const initialAssessment = await assessMarketCandidate({ proposal: { ...proposal,sections: initialSections },cohort,
    evidence: anonymousEvidence,diagnosis,privacyContext:resolvedPrivacyContext,modelExecutor,reviewStage:'initial_gate' });
  const gate = initialAssessment.gate;
  const publicProposal = publicMarketProposal(proposal,initialSections);
  if (gate.status !== 'passed') return { status: 'rejected', reason: 'market_gate_rejected', diagnosis,
    proposal: publicProposal,sections: initialSections,gate,supportProofs:initialAssessment.supportProofs };
  const reviewedFamilies = uniqueStrings(cohort.members?.map((item) => item.agentFamilyId));
  const familyResults = [];
  for (const familyId of reviewedFamilies) {
    let sections = initialSections;
    let review = await reviewClusterFamily({ familyId, cohort, diagnosis, proposal, sections, gate, modelExecutor });
    let revisionCount = 0;
    let familyGate = gate;
    let supportProofs = initialAssessment.supportProofs;
    if (review.decision === 'partial') {
      revisionCount = 1;
      const revisedRaw = await modelExecutor({
        kind: 'cluster_revision', modelRole: 'cluster_proposer',
        prompt: JSON.stringify({ familyId, departmentId: cohort.departmentId, diagnosis, review, proposal: { ...proposal, sections }, instruction: 'Revise the market Proposal exactly once. Return the same JSON shape and only reusable capability rules for this Agent family.' }),
      });
      const revised = parseJsonObject(revisedRaw, 'Cluster revision returned invalid JSON.');
      sections = normalizeMarketSections(revised.sections || []);
      const revisedAssessment=await assessMarketCandidate({proposal:{...revised,sections},cohort:{...cohort,familyId},
        evidence:anonymousEvidence,diagnosis,privacyContext:resolvedPrivacyContext,modelExecutor,reviewStage:'revision_gate'});
      familyGate = revisedAssessment.gate;
      supportProofs = revisedAssessment.supportProofs;
      review = familyGate.status === 'passed'
        ? await reviewClusterFamily({ familyId, cohort, diagnosis, proposal: revised, sections, gate: familyGate, modelExecutor })
        : { familyId, decision: 'reject', rationale: 'Revised candidate failed the market Gate.', approvedSectionIds: [] };
    }
    if (review.decision !== 'full') {
      familyResults.push({ familyId, status: 'rejected', rejectionStage: 'governance', sections: [], review, gate: familyGate,
        revisionCount,evaluations:[],supportProofs,finalPrivacyReview:null });
      continue;
    }
    const finalPrivacyReview=await assessFinalMarketPrivacy({familyId,sections,proposal,privacyContext:resolvedPrivacyContext,modelExecutor});
    if(finalPrivacyReview.status!=='passed'){
      familyResults.push({familyId,status:'rejected',rejectionStage:'privacy',sections:[],review,gate:familyGate,revisionCount,
        evaluations:[],supportProofs,finalPrivacyReview});
      continue;
    }
    const evaluations = await evaluateClusterFamily({
      familyId, sections, currentMarketSections, cases: holdoutCases.length ? holdoutCases : (proposal.eval_cases || []), modelExecutor,
    });
    const rejected = !evaluations.length || evaluations.some((item) => item.regression || item.privacyViolation || item.roleViolation);
    const rejectionStage = evaluations.some((item) => item.privacyViolation) ? 'privacy'
      : evaluations.some((item) => item.roleViolation) ? 'governance'
        : rejected ? 'regression' : '';
    familyResults.push({ familyId, status: rejected ? 'rejected' : 'approved', rejectionStage, sections, review,
      gate: familyGate, revisionCount, evaluations, supportProofs, finalPrivacyReview });
  }
  const approved = familyResults.filter((item) => item.status === 'approved');
  if (!approved.length) return {
    status: 'rejected', reason: clusterFamilyRejectionReason(familyResults), diagnosis,
    proposal: publicProposal, sections: initialSections, gate,
    reviews: familyResults.map((item) => item.review), familyResults,
  };
  return {
    status: 'approved', diagnosis, proposal: publicProposal, gate,
    sections: approved[0].sections, reviews: familyResults.map((item) => item.review), familyResults,
    approvedFamilyIds: approved.map((item) => item.familyId), evaluations: approved.flatMap((item) => item.evaluations),
    shadowCases, shadow: { mode: 'cross_user_async', status: 'pending', userCount: new Set(shadowCases.map((item) => item.ownerUserId)).size, caseCount: shadowCases.length },
  };
}

export async function runClusterShadowEvaluation({ familyResults = [], currentMarketSections = [], shadowCases = [], modelExecutor,
  minimumUsers = CLUSTER_CANARY_MINIMUM_USERS, minimumCases = CLUSTER_CANARY_MINIMUM_CASES } = {}) {
  if (typeof modelExecutor !== 'function') throw new Error('Cluster Shadow evaluation requires a model executor.');
  const cases = shadowCases.filter((item) => item?.input && item?.ownerUserId);
  const userCount = new Set(cases.map((item) => item.ownerUserId)).size;
  if (userCount < minimumUsers || cases.length < minimumCases) {
    return { status: 'insufficient', userCount, caseCount: cases.length, minimumUsers, minimumCases, evaluations: [] };
  }
  const evaluations = [];
  for (const family of familyResults.filter((item) => item.status === 'approved')) {
    const familyId = family.familyId;
    const familyBaseline = currentMarketSections.filter((section) => !section.agentFamilyId || section.agentFamilyId === familyId);
    for (const [index, item] of cases.slice(0, Math.max(minimumCases, 20)).entries()) {
      const baseline = await modelExecutor({ kind: 'cluster_replay_baseline', modelRole: 'candidate', prompt: JSON.stringify({ familyId, input: item.input, sections: familyBaseline, instruction: 'Return only the actual final Agent output. Do not mention evaluation, hidden checks, or an expected answer.' }) });
      const candidate = await modelExecutor({ kind: 'cluster_replay_candidate', modelRole: 'candidate', prompt: JSON.stringify({ familyId, input: item.input, sections: family.sections, instruction: 'Return only the actual final Agent output. Apply the supplied sections without mentioning evaluation, hidden checks, or an expected answer.' }) });
      const judgeRaw = await modelExecutor({ kind: 'cluster_replay_judge', modelRole: 'reviewer', prompt: JSON.stringify({ familyId, input: item.input, expected: item.expected || '', baseline, candidate, instruction: 'Return JSON {winner:baseline|candidate|tie,baseline_score,candidate_score,privacy_violation,role_violation,rationale}.' }) });
      const judge = parseJsonObject(judgeRaw, 'Cluster replay judge returned invalid JSON.');
      evaluations.push({ familyId, caseIndex: index, evidenceId: item.evidenceId, ownerUserId: item.ownerUserId, judge, regression: judge.winner === 'baseline' || Number(judge.candidate_score || 0) < Number(judge.baseline_score || 0), privacyViolation: Boolean(judge.privacy_violation), roleViolation: Boolean(judge.role_violation) });
    }
  }
  const passed = evaluations.length > 0 && evaluations.every((item) => !item.regression && !item.privacyViolation && !item.roleViolation);
  const reason = passed ? '' : evaluations.some((item) => item.privacyViolation) ? 'shadow_privacy_rejected'
    : evaluations.some((item) => item.roleViolation) ? 'shadow_governance_rejected' : 'shadow_regression_rejected';
  return { status: passed ? 'approved' : 'rejected', reason, userCount, caseCount: cases.length, evaluations,
    shadow: { mode: 'cross_user_async', familyCount: familyResults.filter((item) => item.status === 'approved').length, caseCount: cases.length, evaluationCount: evaluations.length, passed } };
}

// Compatibility export for older callers. This remains a Shadow evaluation and never authorizes release.
export const runClusterCanary = runClusterShadowEvaluation;

export function normalizeMarketSections(items = []) {
  const seen = new Set();
  return items.slice(0, 30).map((item, index) => {
    const title = String(item.title || `Section ${index + 1}`).trim().slice(0, 160);
    const sectionId = String(item.section_id || item.sectionId || stableSectionId(title)).trim();
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/i.test(sectionId) || seen.has(sectionId)) throw new Error(`Invalid or duplicate market section_id: ${sectionId}`);
    seen.add(sectionId);
    const content = String(item.content || '').trim();
    return { sectionId, title, content, contentHash: sha256(content), capabilityTags: uniqueStrings(item.capability_tags || item.capabilityTags), conflictKeys: uniqueStrings(item.conflict_keys || item.conflictKeys) };
  });
}

export function validateMarketCandidate(proposal = {}, cohort = {}, {
  evidence = [],diagnosis = {},supportProofs = [],privacyContext = {},
} = {}) {
  const reasons = [];
  if (!(proposal.sections || []).length) reasons.push('Candidate has no sections.');
  if (cohort.type === 'similar' && (proposal.sections || []).some((item) => item.role_expansion || item.roleExpansion)) reasons.push('Similar cohort may only create shared capability modules.');
  const privacyFindings = marketPrivacyFindings({
    summary: proposal.summary || '', risks: proposal.risks || [], evalCases: proposal.eval_cases || proposal.evalCases || [],
    sections: (proposal.sections || []).map((section) => ({
      sectionId: section.sectionId || section.section_id || '', title: section.title || '', content: section.content || '',
      capabilityTags: section.capabilityTags || section.capability_tags || [], conflictKeys: section.conflictKeys || section.conflict_keys || [],
    })),
  },{...privacyContext,evidence});
  if (privacyFindings.length) reasons.push('Candidate contains identity, credential, URL, private-path, project, or single-user material.');
  const diagnosisTerms = String(diagnosis.recommendation || diagnosis.primary_layer || '').toLowerCase().match(/[a-z]{4,}|[\u4e00-\u9fff]{2,}/g) || [];
  const candidateText = JSON.stringify(proposal.sections || []).toLowerCase();
  const diagnosisAligned = diagnosis.primary_layer === 'skill_procedure' || !diagnosisTerms.length || diagnosisTerms.some((term) => candidateText.includes(term));
  if (!diagnosisAligned) reasons.push('Candidate has weak diagnosis alignment.');
  const proofBySection=new Map(supportProofs.map((item)=>[item.sectionId,item]));
  for (const section of proposal.sections || []) {
    if (!section.content || section.content.length > 16000) reasons.push(`Section ${section.sectionId} content is empty or too large.`);
    const proof=proofBySection.get(section.sectionId);
    if(!proof||proof.supportCount<CLUSTER_MIN_SUPPORTERS||proof.reviewerStatus!=='passed'){
      reasons.push(`Section ${section.sectionId} has fewer than three independently verified supporting users.`);
    }
  }
  return {status:reasons.length?'failed':'passed',reasons,diagnosticAlignment:diagnosisAligned,
    sectionSupport:supportProofs.map(publicSectionSupportSummary),privacyReport:{flagCount:privacyFindings.length,
      flags:uniqueStrings(privacyFindings.map((item)=>item.code))}};
}

async function assessMarketCandidate({proposal,cohort,evidence,diagnosis,privacyContext,modelExecutor,reviewStage}){
  const supportProofs=await reviewSectionSupport({sections:proposal.sections||[],evidence,modelExecutor,reviewStage});
  const deterministic=validateMarketCandidate(proposal,cohort,{evidence,diagnosis,supportProofs,privacyContext});
  if(deterministic.status!=='passed')return {supportProofs,gate:{...deterministic,
    independentPrivacyReview:{status:'not_run',reason:'deterministic_gate_failed'}}};
  const independentPrivacyReview=await independentMarketPrivacyReview({proposal,modelExecutor,reviewStage});
  const reasons=[...deterministic.reasons];
  if(independentPrivacyReview.status!=='passed')reasons.push('Independent privacy reviewer rejected the candidate.');
  return {supportProofs,gate:{...deterministic,status:reasons.length?'failed':'passed',reasons,independentPrivacyReview}};
}

async function reviewSectionSupport({sections,evidence,modelExecutor,reviewStage}){
  const proofs=[];
  for(const section of sections){
    const deterministic=deterministicSectionSupport(section,evidence);
    if(new Set(deterministic.map((item)=>item.contributorId)).size<CLUSTER_MIN_SUPPORTERS){
      proofs.push({sectionId:section.sectionId,supportCount:0,deterministicCandidateCount:deterministic.length,
        reviewerStatus:'insufficient_deterministic_support',reviewStage,items:[]});
      continue;
    }
    let reviewer={};
    try{
      const raw=await modelExecutor({kind:'cluster_support_review',modelRole:'independent_support_reviewer',prompt:JSON.stringify({
        reviewStage,section:{sectionId:section.sectionId,title:section.title,content:section.content,capabilityTags:section.capabilityTags},
        evidence:deterministic.map((item)=>({evidence_handle:item.evidenceHandle,contributor_id:item.contributorId,
          confidence:item.confidence,excerpt:String(item.content||'').slice(0,700)})),
        instruction:'Return JSON {decision:supported|reject,supported_evidence_handles:[],rationale}. Select only handles whose evidence independently supports the complete reusable section. Do not infer identities.',
      })});
      reviewer=parseJsonObject(raw,'Cluster section support reviewer returned invalid JSON.');
    }catch(error){
      proofs.push({sectionId:section.sectionId,supportCount:0,deterministicCandidateCount:deterministic.length,
        reviewerStatus:'failed_closed',reviewStage,reviewerRationale:String(error.message||error),items:[]});
      continue;
    }
    const allowedByHandle=new Map(deterministic.map((item)=>[item.evidenceHandle,item]));
    const approvedHandles=uniqueStrings(reviewer.supported_evidence_handles||reviewer.supportedEvidenceHandles||[])
      .filter((handle)=>allowedByHandle.has(handle));
    const reviewed=reviewer.decision==='supported'?approvedHandles.map((handle)=>allowedByHandle.get(handle)):[];
    const contributorIds=new Set(reviewed.map((item)=>item.contributorId));
    const passed=contributorIds.size>=CLUSTER_MIN_SUPPORTERS;
    proofs.push({sectionId:section.sectionId,supportCount:passed?contributorIds.size:0,
      deterministicCandidateCount:deterministic.length,reviewerStatus:passed?'passed':'rejected',reviewStage,
      reviewerRationale:String(reviewer.rationale||''),items:passed?reviewed.map((item)=>({evidenceId:item.evidenceId,
        agentInstanceId:item.agentInstanceId,contributorId:item.contributorId,evidenceHandle:item.evidenceHandle,
        confidence:item.confidence,deterministicPass:true,reviewerPass:true})):[]});
  }
  return proofs;
}

function deterministicSectionSupport(section,evidence){
  const sectionTerms=new Set(marketTerms([section.title,section.content,...(section.capabilityTags||[])].join('\n')));
  const capabilityTags=uniqueStrings(section.capabilityTags||[]).map((item)=>item.toLowerCase());
  const supported=[];
  for(const item of evidence){
    const content=String(item.content||'');const lower=content.toLowerCase();
    const evidenceTerms=new Set(marketTerms(content));
    const overlap=[...sectionTerms].filter((term)=>evidenceTerms.has(term));
    const tagMatch=capabilityTags.some((tag)=>tag.length>=3&&lower.includes(tag));
    if(!tagMatch&&overlap.length<2)continue;
    const confidence=Math.min(1,0.8+(tagMatch?0.1:0)+Math.min(0.1,overlap.length*0.025));
    if(confidence<0.8)continue;
    supported.push({...item,confidence:Number(confidence.toFixed(3))});
  }
  return supported.sort((left,right)=>right.confidence-left.confidence||String(left.evidenceHandle).localeCompare(String(right.evidenceHandle)));
}

function anonymizeClusterEvidence(evidence,secret){
  const key=Buffer.isBuffer(secret)?secret:Buffer.from(String(secret||''));
  return evidence.map((item)=>({...item,
    contributorId:`contributor_${hmacSha256(key,`user:${item.ownerUserId}`).slice(0,20)}`,
    evidenceHandle:`evidence_${hmacSha256(key,`evidence:${item.evidenceId}`).slice(0,24)}`,
  }));
}

async function assessFinalMarketPrivacy({familyId,sections,proposal,privacyContext,modelExecutor}){
  const publicProposal={summary:String(proposal.summary||''),sections:sections.map((section)=>({sectionId:section.sectionId,
    title:section.title,content:section.content,capabilityTags:section.capabilityTags,conflictKeys:section.conflictKeys}))};
  const findings=marketPrivacyFindings(publicProposal,privacyContext);
  if(findings.length)return {status:'failed',stage:'final_pre_shadow',deterministicStatus:'failed',reviewerStatus:'not_run',
    findingCodes:uniqueStrings(findings.map((item)=>item.code))};
  const reviewer=await independentMarketPrivacyReview({proposal:publicProposal,modelExecutor,reviewStage:'final_pre_shadow',familyId});
  return {status:reviewer.status,stage:'final_pre_shadow',deterministicStatus:'passed',reviewerStatus:reviewer.status,
    findingCodes:uniqueStrings(reviewer.flags||[]),reviewer};
}

async function independentMarketPrivacyReview({proposal,modelExecutor,reviewStage,familyId=''}){
  try{
    const raw=await modelExecutor({kind:'cluster_privacy_review',modelRole:'independent_privacy_reviewer',prompt:JSON.stringify({
      reviewStage,familyId,candidate:publicMarketProposal(proposal,proposal.sections||[]),
      instruction:'Return JSON {decision:pass|reject,flags:[],rationale}. Reject names, contact details, IDs, credentials, paths, URLs, unpublished project facts, and facts attributable to only one user.',
    })});
    const parsed=parseJsonObject(raw,'Cluster privacy reviewer returned invalid JSON.');
    const passed=parsed.decision==='pass'&&!(parsed.flags||[]).length;
    return {status:passed?'passed':'rejected',flags:uniqueStrings(parsed.flags||[]),rationale:String(parsed.rationale||'')};
  }catch(error){return {status:'failed_closed',flags:['reviewer_failure'],rationale:String(error.message||error)};}
}

export function marketPrivacyFindings(value,{knownIdentityTerms=[],knownIdentifiers=[],sensitiveTerms=[],evidence=[]}={}){
  const text=typeof value==='string'?value:JSON.stringify(value??null);
  const lower=text.toLowerCase();const findings=[];
  if(evolutionPrivacyFindings(text).length)findings.push({code:'private_pattern'});
  for(const term of uniqueStrings([...knownIdentityTerms,...knownIdentifiers])){
    const clean=term.trim();if(clean.length>=3&&lower.includes(clean.toLowerCase()))findings.push({code:'known_identity_or_id'});
  }
  for(const term of uniqueStrings(sensitiveTerms)){
    const clean=term.trim();if(clean.length>=4&&lower.includes(clean.toLowerCase()))findings.push({code:'unpublished_project_fact'});
  }
  const evidenceByUser=new Map();
  for(const item of evidence){const user=String(item.ownerUserId||item.contributorId||'');if(!user)continue;
    const rows=evidenceByUser.get(user)||[];rows.push(String(item.content||'').toLowerCase());evidenceByUser.set(user,rows);}
  const phrases=candidateSensitivePhrases(text);
  for(const phrase of phrases){
    const supportingUsers=[...evidenceByUser].filter(([,rows])=>rows.some((content)=>content.includes(phrase))).map(([user])=>user);
    if(supportingUsers.length===1)findings.push({code:'single_user_attributable_phrase'});
  }
  return dedupeFindings(findings);
}

function buildMarketPrivacyContext({cohort,evidence,privacyContext}){
  return {...privacyContext,evidence,knownIdentifiers:uniqueStrings([...(privacyContext.knownIdentifiers||[]),
    ...(cohort.members||[]).flatMap((item)=>[item.ownerUserId,item.agentInstanceId]),...evidence.map((item)=>item.evidenceId)])};
}

function publicMarketProposal(proposal,sections){
  return sanitizeEvolutionPayloadForStorage({summary:String(proposal.summary||''),sections:(sections||[]).map((section)=>({
    sectionId:section.sectionId,title:section.title,content:section.content,
    capabilityTags:section.capabilityTags,conflictKeys:section.conflictKeys,
  })),eval_cases:Array.isArray(proposal.eval_cases)?proposal.eval_cases.slice(0,20):[],risks:Array.isArray(proposal.risks)?proposal.risks.slice(0,20):[]});
}

function publicSectionSupportSummary(proof){return {sectionId:proof.sectionId,supportCount:Number(proof.supportCount||0),
  deterministicCandidateCount:Number(proof.deterministicCandidateCount||0),reviewerStatus:proof.reviewerStatus||'not_run'};}
function marketTerms(value){return uniqueStrings(String(value||'').toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g)||[]);}
function candidateSensitivePhrases(value){
  const text=String(value||'').toLowerCase();const phrases=new Set();
  for(const line of text.split(/[\r\n。！？!?]+/).map((item)=>item.trim()).filter((item)=>item.length>=18))phrases.add(line);
  const words=text.match(/[a-z0-9]{3,}/g)||[];
  for(let index=0;index+5<words.length;index+=1)phrases.add(words.slice(index,index+6).join(' '));
  return [...phrases].slice(0,200);
}
function dedupeFindings(items){return [...new Map(items.map((item)=>[item.code,item])).values()];}
function hmacSha256(key,value){return crypto.createHmac('sha256',key).update(String(value||'')).digest('hex');}

export function compileMarketEffectiveSkill({ baseSections = [], adoptedSections = [], personalOverlay = '', conflictResolutions = {} } = {}) {
  const selected = new Map();
  for (const section of [...baseSections, ...adoptedSections]) selected.set(section.sectionId, section);
  const normal = [];
  const marketWins = [];
  for (const section of selected.values()) {
    const resolution = conflictResolutions[section.sectionId] || 'none';
    if (resolution === 'personal') continue;
    if (resolution === 'market') marketWins.push(section);
    else normal.push(section);
  }
  const render = (items) => items.map((item) => `<!-- JANUS MARKET SECTION:${item.sectionId} -->\n## ${item.title}\n${item.content}`).join('\n\n');
  return [render(normal), personalOverlay ? `<!-- JANUS PERSONAL OVERLAY START -->\n${String(personalOverlay).trim()}\n<!-- JANUS PERSONAL OVERLAY END -->` : '', render(marketWins)].filter(Boolean).join('\n\n');
}

export function deriveOverlayConflictIndex(overlay = '', sections = []) {
  const text = String(overlay || '').toLowerCase();
  return sections.filter((section) => section.conflictKeys.some((key) => text.includes(String(key).toLowerCase())) || text.includes(section.title.toLowerCase())).map((section) => section.sectionId);
}

function cohortEligibility({ type, key, familyId = '', departmentId = '', members, evidence, minimumUsers, evidenceThresholds }) {
  const users = new Set(members.map((item) => item.ownerUserId));
  const instanceIds = new Set(members.map((item) => item.agentInstanceId));
  const relevantEvidence = evidence.filter((item) => instanceIds.has(item.agentInstanceId));
  const breakdown = clusterEvidenceBreakdown(relevantEvidence);
  const thresholds = { total: 1, chat: 0, memory: 0, completedTask: 0, ...(evidenceThresholds || {}) };
  const reasons = [];
  if (users.size < minimumUsers) reasons.push('insufficient_users');
  reasons.push(...clusterEvidenceThresholdReasons(relevantEvidence, thresholds));
  return {
    cohortKey: key, type, familyId, departmentId, capabilityTags: uniqueStrings(members.flatMap((item) => item.capabilityTags || [])), members,
    userCount: users.size, evidenceCount: relevantEvidence.length,
    newEvidenceCount: relevantEvidence.filter((item) => item.eligibilityKind !== 'reconsiderable').length,
    reconsiderableEvidenceCount: relevantEvidence.filter((item) => item.eligibilityKind === 'reconsiderable').length,
    evidenceBreakdown: breakdown, evidenceThresholds: thresholds, fallbackReason: type === 'similar' ? 'family_ineligible' : '',
    eligibilityReasons: reasons, eligible: reasons.length === 0,
  };
}
function normalizeTaskEvents(events) {
  const normalized = events.map((item, index) => ({
    ownerUserId: String(item.ownerUserId || item.owner_user_id || ''),
    agentInstanceId: String(item.agentInstanceId || item.agent_instance_id || ''),
    agentFamilyId: String(item.agentFamilyId || item.agent_family_id || ''),
    taskId: String(item.taskId || item.task_id || `event:${index}`),
    taskTypeKey: String(item.taskTypeKey || item.task_type_key || 'general'),
    eventKind: String(item.eventKind || item.event_kind || ''),
    completedAt: item.completedAt || item.completed_at || item.occurredAt || item.occurred_at || '',
    acceptanceScore: finiteOrNull(item.acceptanceScore ?? item.acceptance_score), accepted: Boolean(item.accepted), completed: Boolean(item.completed),
    completedUnreviewed: Boolean(item.completedUnreviewed ?? item.completed_unreviewed), rework: Boolean(item.rework),
    failed: Boolean(item.failed), blocked: Boolean(item.blocked), cancelled: Boolean(item.cancelled), terminal: item.terminal !== false,
    firstPass: Boolean(item.firstPass ?? item.first_pass), estimatedMinutes: Math.max(0, Number(item.estimatedMinutes ?? item.estimated_minutes ?? 0)),
    actualMinutes: Math.max(0, Number(item.actualMinutes ?? item.actual_minutes ?? 0)), peerMedianMinutes: Math.max(0, Number(item.peerMedianMinutes ?? item.peer_median_minutes ?? 0)),
    responseWithinSla: Boolean(item.responseWithinSla ?? item.response_within_sla), hasResponseSignal: Boolean(item.hasResponseSignal ?? item.has_response_signal),
    evidenceComplete: Boolean(item.evidenceComplete ?? item.evidence_complete), securityViolationCount: Math.max(0, Number(item.securityViolationCount ?? item.security_violation_count ?? 0)),
    peerBaselineKind: String(item.peerBaselineKind || item.peer_baseline_kind || ''), peerSampleCount: Math.max(0, Number(item.peerSampleCount ?? item.peer_sample_count ?? 0)),
    sourceKind: String(item.sourceKind || item.source_kind || ''), sourceId: String(item.sourceId || item.source_id || ''),
    sourceVersionId: String(item.sourceVersionId || item.source_version_id || ''), authority: String(item.authority || ''),
    confirmedPrivacyViolation: Boolean(item.confirmedPrivacyViolation ?? item.privacyViolationConfirmed ?? item.confirmed_privacy_violation),
    confirmedRoleViolation: Boolean(item.confirmedRoleViolation ?? item.roleViolationConfirmed ?? item.confirmed_role_violation),
  })).sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt)));
  const byTask = new Map();
  for (const item of normalized) {
    const taskKey = `${item.agentInstanceId}\0${item.taskId}`;
    const previous = byTask.get(taskKey);
    byTask.set(taskKey, previous ? {
      ...previous, ...item,
      completed: previous.completed || item.completed,
      rework: previous.rework || item.rework,
      failed: previous.failed || item.failed,
      blocked: previous.blocked || item.blocked,
      cancelled: previous.cancelled || item.cancelled,
      firstPass: item.firstPass && !previous.rework && !item.rework && !previous.failed && !item.failed,
      evidenceComplete: previous.evidenceComplete || item.evidenceComplete,
      hasResponseSignal: previous.hasResponseSignal || item.hasResponseSignal,
      responseWithinSla: item.hasResponseSignal ? item.responseWithinSla : previous.responseWithinSla,
      securityViolationCount: Math.max(previous.securityViolationCount, item.securityViolationCount),
    } : item);
  }
  return [...byTask.values()];
}
function taskQuality(item) { if (item.acceptanceScore !== null) return bounded(item.acceptanceScore); if (item.accepted) return 100; if (item.rework) return 50; if (item.failed) return 0; if (item.completedUnreviewed) return 70; return 70; }
function taskEfficiency(item) { if (!item.actualMinutes) return 50; const baseline = item.peerMedianMinutes || item.estimatedMinutes; return baseline ? bounded((baseline / item.actualMinutes) * 100) : 50; }
function average(values, fallback) { return values.length ? values.reduce((a, b) => a + Number(b || 0), 0) / values.length : fallback; }
function ratio(a, b) { return b ? a / b : 0; }
function bounded(value) { return Math.min(100, Math.max(0, Number(value || 0))); }
function bounded01(value) { return Math.min(1, Math.max(0, Number(value || 0))); }
function finiteOrNull(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function round(value, digits = 2) { const scale = 10 ** digits; return Math.round(Number(value || 0) * scale) / scale; }
function uniqueStrings(values = []) { return [...new Set(values.map(String).map((item) => item.trim()).filter(Boolean))]; }
function objectValue(value) { if (value && typeof value === 'object' && !Array.isArray(value)) return value; try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function arrayValue(value) { if (Array.isArray(value)) return value; try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function median(values = []) { const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!sorted.length) return 0; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function groupBy(items, keyFor) { const result = new Map(); for (const item of items) { const key = keyFor(item); const rows = result.get(key) || []; rows.push(item); result.set(key, rows); } return result; }
function connectedCapabilityGroups(items) {
  const pending = new Set(items.filter((item) => uniqueStrings(item.capabilityTags || []).length));
  const groups = [];
  while (pending.size) {
    const [seed] = pending;
    pending.delete(seed);
    const group = [seed];
    const tags = new Set(uniqueStrings(seed.capabilityTags || []));
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of [...pending]) {
        const itemTags = uniqueStrings(item.capabilityTags || []);
        if (!itemTags.some((tag) => tags.has(tag))) continue;
        pending.delete(item);
        group.push(item);
        itemTags.forEach((tag) => tags.add(tag));
        expanded = true;
      }
    }
    groups.push(group);
  }
  return groups;
}
function stableSectionId(title) { return `section_${sha256(title.toLowerCase()).slice(0, 16)}`; }
function assertClusterUserWeightCap(items, capShare) {
  const total = items.reduce((sum, item) => sum + Number(item.effectiveWeight || 0), 0);
  if (!total) return;
  const byUser = items.reduce((weights, item) => {
    const userId = String(item.ownerUserId || '');
    weights.set(userId, (weights.get(userId) || 0) + Number(item.effectiveWeight || 0));
    return weights;
  }, new Map());
  for (const [userId, weight] of byUser) {
    if (weight / total <= capShare + 1e-10) continue;
    const error = new Error(`Cluster user ${userId || '<unknown>'} exceeds the effective weight cap.`);
    error.code = 'cluster_user_weight_cap_invariant_violation';
    throw error;
  }
}
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function hashObject(value) { return sha256(JSON.stringify(value)); }
function parseJsonObject(raw, message) { let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''); const match = text.match(/\{[\s\S]*\}/); if (match) text = match[0]; try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; } catch {} throw new Error(message); }
async function reviewClusterFamily({ familyId, cohort, diagnosis, proposal, sections, gate, modelExecutor }) {
  const reviewRaw = await modelExecutor({
    kind: 'cluster_governance_review', modelRole: 'department_hr',
    prompt: JSON.stringify({ familyId, departmentId: cohort.departmentId, diagnosis, gate, proposal: { summary: proposal.summary || '', sections }, rules: 'Return JSON {decision:full|partial|reject,rationale,required_revision,approved_section_ids}. Reject cross-department changes, role expansion, private facts, or untestable rules.' }),
  });
  const parsed = parseJsonObject(reviewRaw, 'Cluster governance review returned invalid JSON.');
  const approvedSectionIds = uniqueStrings(parsed.approved_section_ids || []);
  const approvesAll = sections.every((section) => approvedSectionIds.includes(section.sectionId));
  let decision = ['full', 'partial', 'reject'].includes(parsed.decision) ? parsed.decision : 'reject';
  if (decision === 'full' && !approvesAll) decision = 'partial';
  return { familyId, decision, rationale: String(parsed.rationale || ''), requiredRevision: String(parsed.required_revision || ''), approvedSectionIds };
}

async function evaluateClusterFamily({ familyId, sections, currentMarketSections, cases, modelExecutor }) {
  const selectedCases = cases.filter((item) => item?.input).slice(0, 8);
  const baselineSections = currentMarketSections.filter((section) => !section.agentFamilyId || section.agentFamilyId === familyId);
  const evaluations = [];
  for (const [index, item] of selectedCases.entries()) {
    const baseline = await modelExecutor({ kind: 'cluster_replay_baseline', modelRole: 'candidate', prompt: JSON.stringify({ familyId, input: item.input, sections: baselineSections, instruction: 'Return only the actual final Agent output. Do not mention evaluation, hidden checks, or an expected answer.' }) });
    const candidate = await modelExecutor({ kind: 'cluster_replay_candidate', modelRole: 'candidate', prompt: JSON.stringify({ familyId, input: item.input, sections, instruction: 'Return only the actual final Agent output. Apply the supplied sections without mentioning evaluation, hidden checks, or an expected answer.' }) });
    const judgeRaw = await modelExecutor({ kind: 'cluster_replay_judge', modelRole: 'reviewer', prompt: JSON.stringify({ familyId, input: item.input, expected: item.expected || '', baseline, candidate, instruction: 'Return JSON {winner:baseline|candidate|tie,baseline_score,candidate_score,privacy_violation,role_violation,rationale}.' }) });
    const judge = parseJsonObject(judgeRaw, 'Cluster replay judge returned invalid JSON.');
    evaluations.push({ familyId, caseIndex: index, judge, regression: judge.winner === 'baseline' || Number(judge.candidate_score || 0) < Number(judge.baseline_score || 0), privacyViolation: Boolean(judge.privacy_violation), roleViolation: Boolean(judge.role_violation) });
  }
  return evaluations;
}

function deriveCrossUserHoldout(evidence = [], limit = CLUSTER_CANARY_MINIMUM_CASES) {
  const counts = evidence.reduce((result, item) => result.set(item.ownerUserId, (result.get(item.ownerUserId) || 0) + 1), new Map());
  const selected = new Map();
  for (const item of [...evidence].reverse()) {
    if (!item.ownerUserId || counts.get(item.ownerUserId) < 2 || selected.has(item.ownerUserId) || !String(item.content || '').trim()) continue;
    selected.set(item.ownerUserId, {
      evidenceId: item.evidenceId,
      ownerUserId: item.ownerUserId,
      input: String(item.content).slice(0, 1600),
      expected: 'Improve the response without exposing private facts, identities, or expanding the Agent role.',
      source: 'cross_user_holdout',
    });
  }
  return [...selected.values()].sort((left, right) => String(left.ownerUserId).localeCompare(String(right.ownerUserId))).slice(0, limit);
}
function clusterProposalPrompt(cohort, evidence, currentSections, diagnosis) { return `Return JSON only with summary, sections, eval_cases, and risks. Include 1-3 concrete eval_cases, each with input and expected. Each section requires section_id,title,content,capability_tags,conflict_keys. Every section must be directly and completely supported by matching evidence from at least three distinct anonymous contributors: reuse at least two exact substantive terms shared by those evidence excerpts in the section title, content, or capability_tags. When the repeated evidence describes one procedure, return exactly one section and do not split it into abstract scope, policy, decision, or governance modules. Never claim or list supporting users, instances, contributors, or evidence IDs; support is computed independently. Do not include identities, credentials, paths, URLs, unpublished facts, or single-user facts. Similar cohorts may only propose shared capability modules.\nCohort:${JSON.stringify({ type: cohort.type, departmentId: cohort.departmentId, familyIds: uniqueStrings(cohort.members?.map((item) => item.agentFamilyId)) })}\nDiagnosis:${JSON.stringify(diagnosis)}\nCurrent market:${JSON.stringify(currentSections)}\nWeighted anonymous evidence:${evidence.map((item) => `${item.contributorId}:${item.evidenceHandle}:${item.effectiveWeight}:${String(item.content || '').slice(0, 1200)}`).join('\n')}`; }

function clusterFamilyRejectionReason(results = []) {
  const stages = new Set(results.map((item) => item.rejectionStage).filter(Boolean));
  if (stages.size > 1) return 'market_mixed_rejected';
  const stage = [...stages][0] || 'governance';
  return `market_${stage}_rejected`;
}
