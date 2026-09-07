import crypto from 'node:crypto';

export const EVOLUTION_SCOPES = Object.freeze(['personal', 'cluster']);
export const EVOLUTION_EVIDENCE_SOURCE_KINDS = Object.freeze([
  'message',
  'conversation_segment',
  'memory_version',
  'task_created',
  'task_assigned',
  'task_result',
  'task_acceptance',
  'task_revision',
  'task_rework',
  'task_failure',
  'task_blocked',
  'task_cancelled',
  'task_dependency_changed',
  'model_execution',
  'model_execution_metric',
  'collaboration_message',
  'delegation_event',
  'task_shared_summary',
  'market_adoption',
  'market_rejection',
  'market_rollback',
]);
export const DEPRECATED_EVOLUTION_EVIDENCE_SOURCE_KINDS = Object.freeze([
  'task_node_result',
  'task_retrospective',
]);
export const EVIDENCE_REJECTION_KINDS = Object.freeze([
  'gate',
  'hr_review',
  'regression',
  'privacy',
  'mixed',
  'user_rejected',
  'invalid_source',
  'legacy_unknown',
]);
export const EVIDENCE_USAGE_STATES = Object.freeze([
  'available',
  'reserved',
  'consumed',
  'evaluated_rejected',
  'released',
]);
export const EVOLUTION_RUN_STATES = Object.freeze([
  'queued',
  'claimed',
  'running',
  'proposed',
  'canary',
  'applied',
  'failed_retryable',
  'failed_terminal',
  'evaluated_rejected',
  'rolled_back',
  'skipped',
  'insufficient_evidence',
]);
export const EVOLUTION_JOB_STATES = Object.freeze([
  'queued',
  'claimed',
  'running',
  'waiting_canary',
  'completed',
  'failed_retryable',
  'failed_terminal',
  'cancelled',
]);
export const PERSONAL_EVOLUTION_ALGORITHM_VERSION = 'personal_cloud_authority_v1';
export const CLUSTER_EVOLUTION_ALGORITHM_VERSION = 'cluster_market_v2';
export const EVIDENCE_CONTRACT_POLICY_VERSION = 'evidence_contract_v1';
export const PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION = 'personal_threshold_v1';
export const MARKET_CANARY_POLICY_VERSION = 'market_canary_real_user_default_on_v2';
export const MARKET_CANARY_MODE = 'real_user_default_on';
export const MARKET_CANDIDATE_STATES = Object.freeze([
  'draft',
  'gated',
  'governance_approved',
  'shadow_passed',
  'canary_running',
  'canary_passed',
  'released',
  'gate_rejected',
  'governance_rejected',
  'regression_rejected',
  'privacy_rejected',
  'canary_rejected',
  'rolled_back',
  'archived',
]);
export const MARKET_VERSION_KINDS = Object.freeze(['market_base', 'legacy_sections']);
export const MARKET_VERSION_STATES = Object.freeze(['draft', 'released', 'suspended', 'rolled_back', 'rejected', 'archived']);
export const MARKET_ADOPTION_STATES = Object.freeze(['adopted', 'superseded', 'rolled_back', 'ignored']);
export const PERSONAL_MINIMUM_EVIDENCE = 5;
export const PERSONAL_MAXIMUM_EVIDENCE = 60;
export const PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const PERSONAL_EVOLUTION_RETRY_INTERVAL_MS = 5 * 60 * 1000;
export const DEPRECATED_EVOLUTION_ENVIRONMENT_VARIABLES = Object.freeze([
  'JANUS_CLOUD_EVOLUTION_AUTHORITY',
  'JANUS_PHASE8_EVOLUTION_ENABLED',
  'JANUS_PERSONAL_EVOLUTION_V2',
  'JANUS_LOCAL_EVOLUTION_ENABLED',
  'JANUS_EVOLVE_ENABLED',
  'JANUS_CLUSTER_EVOLUTION_V2',
]);
export const CLUSTER_MINIMUM_USERS = 7;
export const CLUSTER_MINIMUM_SUPPORTING_INSTANCES = 3;
export const CLUSTER_MAXIMUM_USER_WEIGHT_SHARE = 0.15;
export const CLUSTER_COHORT_IDENTITY_VERSION = 'cluster_cohort_identity_v1';
export const CLUSTER_PARTICIPATION_POLICY_VERSION = 'cluster_active_synced_mandatory_v1';
export const CLUSTER_RE_EVALUATION_POLICY_VERSION = 'cluster_re_evaluation_v1';
export const CLUSTER_EVIDENCE_CATEGORIES = Object.freeze(['chat', 'memory', 'completedTask', 'other']);
export const DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS = Object.freeze({
  total: 15,
  chat: 5,
  memory: 3,
  completedTask: 5,
});
export const PERFORMANCE_LEVEL_WEIGHTS = Object.freeze({
  P1: 0.50, P2: 0.60, P3: 0.75, P4: 0.90, P5: 1.00,
  P6: 1.15, P7: 1.30, P8: 1.50, P9: 1.75, P10: 2.00,
});

export function cloudEvolutionAuthorityEnabled(_env = process.env) {
  return true;
}

const deprecatedEvolutionLogScopes = new Set();

export function logDeprecatedEvolutionEnvironment({ env = process.env, logger = console, processName = 'janus' } = {}) {
  const detected = DEPRECATED_EVOLUTION_ENVIRONMENT_VARIABLES.filter((name) => Object.hasOwn(env, name));
  const scope = String(processName || 'janus');
  if (!detected.length || deprecatedEvolutionLogScopes.has(scope)) return detected;
  deprecatedEvolutionLogScopes.add(scope);
  logger?.warn?.(`[${scope}] Deprecated evolution environment variables are ignored: ${detected.join(', ')}`);
  return detected;
}

export function stableEvolutionEvidenceId(input = {}) {
  const parts = [
    input.ownerUserId || input.owner_user_id || '',
    input.userAgentInstanceId || input.user_agent_instance_id || '',
    input.sourceKind || input.source_kind || '',
    input.sourceId || input.source_id || '',
    input.sourceVersionId || input.source_version_id || '',
    input.contentHash || input.content_hash || '',
  ];
  return `evidence_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex')}`;
}

export function normalizeEvolutionEvidenceSourceKind(value = '', { allowDeprecated = true } = {}) {
  const sourceKind = String(value || '').trim();
  const supported = EVOLUTION_EVIDENCE_SOURCE_KINDS.includes(sourceKind)
    || (allowDeprecated && DEPRECATED_EVOLUTION_EVIDENCE_SOURCE_KINDS.includes(sourceKind));
  if (!supported) throw contractError('evidence_source_kind_invalid', `Unsupported evolution evidence source kind: ${sourceKind || '(empty)'}`);
  return sourceKind;
}

export function evolutionEvidenceClusterScopeAutomatic(sourceKind = '') {
  return [
    'message', 'conversation_segment', 'memory_version',
    'task_result', 'task_acceptance', 'task_rework', 'task_failure', 'task_blocked', 'task_cancelled',
    'task_node_result', 'task_retrospective', 'model_execution', 'model_execution_metric',
    'collaboration_message', 'delegation_event', 'task_shared_summary',
    'market_adoption', 'market_rejection', 'market_rollback',
  ].includes(String(sourceKind || '').trim());
}

export function personalEvolutionThresholdEligible(sourceKind = '') {
  return [
    'message', 'conversation_segment', 'collaboration_message',
    'memory_version', 'task_shared_summary',
    'task_result', 'task_acceptance', 'task_rework', 'task_failure', 'task_blocked', 'task_cancelled',
    'task_node_result', 'task_retrospective',
    'model_execution', 'model_execution_metric',
  ].includes(String(sourceKind || '').trim());
}

export function normalizeEvolutionEvidenceIdentity(input = {}, { allowDeprecated = true } = {}) {
  const identity = {
    ownerUserId: String(input.ownerUserId || input.owner_user_id || '').trim(),
    userAgentInstanceId: String(input.userAgentInstanceId || input.user_agent_instance_id || '').trim(),
    sourceKind: normalizeEvolutionEvidenceSourceKind(input.sourceKind || input.source_kind, { allowDeprecated }),
    sourceId: String(input.sourceId || input.source_id || '').trim(),
    sourceVersionId: String(input.sourceVersionId || input.source_version_id || '').trim(),
    contentHash: String(input.contentHash || input.content_hash || '').trim(),
  };
  if (!identity.ownerUserId || !identity.userAgentInstanceId) {
    throw contractError('evidence_subject_required', 'Evolution evidence requires an owner user and Agent instance.');
  }
  if (!identity.sourceId) throw contractError('evidence_source_required', 'Evolution evidence requires a source ID.');
  if (['memory_version', 'task_shared_summary'].includes(identity.sourceKind) && !identity.sourceVersionId) {
    throw contractError('memory_version_required', 'Memory evolution evidence requires a source version ID.');
  }
  if (!identity.contentHash) throw contractError('evidence_content_hash_required', 'Evolution evidence requires a content hash.');
  return identity;
}

export function normalizeEvidenceRejectionKind(value = '', { allowEmpty = true } = {}) {
  const kind = String(value || '').trim();
  if (!kind && allowEmpty) return '';
  if (!EVIDENCE_REJECTION_KINDS.includes(kind)) {
    throw contractError('evidence_rejection_kind_invalid', `Invalid evidence rejection kind: ${kind || '(empty)'}`);
  }
  return kind;
}

export function evidenceUsageTransitionAllowed({
  from = '',
  to = '',
  currentRunId = '',
  nextRunId = '',
  currentReEvaluationBasisHash = '',
  nextReEvaluationBasisHash = '',
} = {}) {
  const previous = normalizeEvidenceUsageState(from);
  const next = normalizeEvidenceUsageState(to);
  if (previous === next) return true;
  if (['available', 'released'].includes(previous) && next === 'reserved') return true;
  if (previous === 'reserved' && ['consumed', 'evaluated_rejected', 'released'].includes(next)) return true;
  if (previous === 'evaluated_rejected' && next === 'reserved') {
    const oldBasis = String(currentReEvaluationBasisHash || '');
    const newBasis = String(nextReEvaluationBasisHash || '');
    return Boolean(newBasis && newBasis !== oldBasis && nextRunId && nextRunId !== currentRunId);
  }
  return false;
}

export function evolutionReEvaluationBasisHash({ algorithmVersion = '', policyVersion = '', relatedEvidenceIds = [] } = {}) {
  const evidenceIds = [...new Set((Array.isArray(relatedEvidenceIds) ? relatedEvidenceIds : []).map(String).filter(Boolean))].sort();
  const parts = [String(algorithmVersion || '').trim(), String(policyVersion || '').trim(), ...evidenceIds];
  if (!parts[0] && !parts[1] && !evidenceIds.length) return '';
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

export function clusterEvidenceThresholdsFromEnv(env = process.env) {
  const thresholds = {
    total: clusterThresholdValue(env, 'JANUS_PHASE8_CLUSTER_MIN_EVIDENCE', DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS.total),
    chat: clusterThresholdValue(env, 'JANUS_PHASE8_CLUSTER_MIN_CHAT_EVIDENCE', DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS.chat),
    memory: clusterThresholdValue(env, 'JANUS_PHASE8_CLUSTER_MIN_MEMORY_EVIDENCE', DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS.memory),
    completedTask: clusterThresholdValue(env, 'JANUS_PHASE8_CLUSTER_MIN_COMPLETED_TASK_EVIDENCE', DEFAULT_CLUSTER_EVIDENCE_THRESHOLDS.completedTask),
  };
  const categoryTotal = thresholds.chat + thresholds.memory + thresholds.completedTask;
  if (thresholds.total < categoryTotal) {
    throw contractError(
      'cluster_evidence_thresholds_invalid',
      `Cluster evidence total threshold (${thresholds.total}) must be at least the sum of category thresholds (${categoryTotal}).`,
    );
  }
  return Object.freeze(thresholds);
}

export function clusterEvidenceCategory(value = '') {
  const sourceKind = String(value || '').trim();
  if (['message', 'conversation_segment', 'collaboration_message'].includes(sourceKind)) return 'chat';
  if (['memory_version', 'task_shared_summary'].includes(sourceKind)) return 'memory';
  if ([
    'task_result', 'task_acceptance', 'task_revision', 'task_rework', 'task_failure', 'task_blocked',
    'task_cancelled', 'task_dependency_changed', 'model_execution', 'model_execution_metric',
    'task_node_result', 'task_retrospective',
  ].includes(sourceKind)) return 'completedTask';
  return 'other';
}

export function stableClusterCohortKey({ type = 'family', familyId = '', departmentId = '', capabilityTags = [] } = {}) {
  if (type === 'family') {
    const normalizedFamilyId = String(familyId || '').trim();
    if (!normalizedFamilyId) throw contractError('cluster_cohort_family_required', 'Family cohort requires an Agent family ID.');
    return `family:${normalizedFamilyId}`;
  }
  if (type === 'similar') {
    const normalizedDepartmentId = String(departmentId || '').trim();
    const tags = [...new Set((Array.isArray(capabilityTags) ? capabilityTags : []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
    if (!normalizedDepartmentId || !tags.length) {
      throw contractError('cluster_similar_cohort_identity_invalid', 'Similar cohort requires a department and capability tags.');
    }
    return `similar:${normalizedDepartmentId}:${tags.join('|')}`;
  }
  throw contractError('cluster_cohort_type_invalid', `Unsupported cluster cohort type: ${type || '(empty)'}`);
}

export function stableClusterCohortId(cohortKey = '') {
  const key = String(cohortKey || '').trim();
  if (!key) throw contractError('cluster_cohort_key_required', 'Cluster cohort key is required.');
  return `cohort_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

export function clusterReEvaluationBasisHash({
  cohortKey = '', evidenceCategory = 'other', algorithmVersion = '', policyVersion = EVIDENCE_CONTRACT_POLICY_VERSION,
  reEvaluationPolicyVersion = CLUSTER_RE_EVALUATION_POLICY_VERSION, relatedEvidenceIds = [],
} = {}) {
  const category = CLUSTER_EVIDENCE_CATEGORIES.includes(evidenceCategory) ? evidenceCategory : 'other';
  const evidenceIds = [...new Set((Array.isArray(relatedEvidenceIds) ? relatedEvidenceIds : []).map(String).filter(Boolean))].sort();
  return crypto.createHash('sha256').update([
    String(cohortKey || '').trim(), category, String(algorithmVersion || '').trim(), String(policyVersion || '').trim(),
    String(reEvaluationPolicyVersion || '').trim(), ...evidenceIds,
  ].join('\n')).digest('hex');
}

export function evidenceRejectionKindForReason(value = '') {
  const reason = String(value || '').toLowerCase();
  if (reason.includes('mixed')) return 'mixed';
  if (reason.includes('privacy')) return 'privacy';
  if (reason.includes('regression') || reason.includes('replay')) return 'regression';
  if (reason.includes('review') || reason.includes('hr') || reason.includes('governance') || reason.includes('role')) return 'hr_review';
  if (reason.includes('user')) return 'user_rejected';
  if (reason.includes('source')) return 'invalid_source';
  return 'gate';
}

export function marketCandidateTransitionAllowed(from = '', to = '') {
  if (!MARKET_CANDIDATE_STATES.includes(from) || !MARKET_CANDIDATE_STATES.includes(to)) return false;
  if (from === to) return true;
  const allowed = {
    draft: ['gated', 'gate_rejected', 'archived'],
    gated: ['governance_approved', 'governance_rejected', 'privacy_rejected', 'archived'],
    governance_approved: ['shadow_passed', 'regression_rejected', 'privacy_rejected', 'governance_rejected', 'archived'],
    shadow_passed: ['canary_running', 'rolled_back', 'archived'],
    canary_running: ['canary_passed', 'canary_rejected', 'rolled_back'],
    canary_passed: ['released', 'canary_rejected'],
    released: ['rolled_back', 'archived'],
    gate_rejected: ['archived'],
    governance_rejected: ['archived'],
    regression_rejected: ['archived'],
    privacy_rejected: ['archived'],
    canary_rejected: ['archived'],
    rolled_back: ['archived'],
    archived: [],
  };
  return allowed[from].includes(to);
}

export function evolutionConsumerId({ scope = 'personal', agentInstanceId = '', cohortId = '' } = {}) {
  if (scope === 'personal') {
    if (!agentInstanceId) throw new Error('Personal evolution requires an Agent instance consumer.');
    return agentInstanceId;
  }
  if (scope === 'cluster') {
    if (!cohortId) throw new Error('Cluster evolution requires a cohort consumer.');
    return cohortId;
  }
  throw new Error(`Unsupported evolution scope: ${scope}`);
}

export function normalizeEvidenceUsageState(value = '') {
  const state = String(value || '').trim();
  if (!EVIDENCE_USAGE_STATES.includes(state)) throw new Error(`Invalid evidence usage state: ${state}`);
  return state;
}

export function normalizeEvolutionRunState(value = '') {
  const state = String(value || '').trim();
  if (!EVOLUTION_RUN_STATES.includes(state)) throw new Error(`Invalid evolution run state: ${state}`);
  return state;
}

export function disabledEvolutionCapability(kind = 'cluster') {
  return {
    authority: 'cloud',
    authorityLocked: true,
    enabled: true,
    mutationEnabled: false,
    executionAvailable: false,
    readiness: { database: false, model: false, encryption: false },
    code: `${kind}_evolution_unavailable`,
  };
}

export function performanceLevelForScore(value = 0) {
  const score = Math.min(100, Math.max(0, Number(value || 0)));
  if (score >= 95) return 'P10';
  if (score >= 88) return 'P9';
  if (score >= 80) return 'P8';
  if (score >= 70) return 'P7';
  if (score >= 60) return 'P6';
  if (score >= 50) return 'P5';
  if (score >= 40) return 'P4';
  if (score >= 30) return 'P3';
  if (score >= 20) return 'P2';
  return 'P1';
}

export function calculateAgentPerformanceLevel(metrics = {}) {
  const quality = boundedScore(metrics.resultQuality ?? metrics.result_quality);
  const reliability = boundedScore(metrics.reliability);
  const firstPass = boundedScore(metrics.firstPassRate ?? metrics.first_pass_rate);
  const efficiency = boundedScore(metrics.normalizedEfficiency ?? metrics.normalized_efficiency);
  const collaboration = boundedScore(metrics.collaborationSafety ?? metrics.collaboration_safety);
  const score = Number((quality * 0.40 + reliability * 0.20 + firstPass * 0.15 + efficiency * 0.15 + collaboration * 0.10).toFixed(2));
  const level = performanceLevelForScore(score);
  const completedTaskCount = Math.max(0, Number(metrics.completedTaskCount ?? metrics.completed_task_count ?? 0));
  const provisional = completedTaskCount < 10;
  return { score, level, completedTaskCount, provisional, contributionWeight: provisional ? Math.min(1, PERFORMANCE_LEVEL_WEIGHTS[level]) : PERFORMANCE_LEVEL_WEIGHTS[level] };
}

function boundedScore(value) { return Math.min(100, Math.max(0, Number(value || 0))); }

function clusterThresholdValue(env, name, fallback) {
  if (!Object.hasOwn(env || {}, name) || String(env[name] ?? '').trim() === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 0) {
    throw contractError('cluster_evidence_thresholds_invalid', `${name} must be a non-negative integer.`);
  }
  return value;
}

function contractError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
