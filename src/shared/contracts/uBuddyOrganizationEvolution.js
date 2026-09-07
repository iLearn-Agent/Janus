import crypto from 'node:crypto';

export const UBUDDY_ORG_TRACE_VERSION = 'UBUDDY_ORG_TRACE_V1';
export const UBUDDY_ORG_PLAYBOOK_VERSION = 'UBUDDY_ORG_PLAYBOOK_V1';
export const UBUDDY_ORG_POLICY_MAX_RULES = 64;

const POLICY_STAGES = new Set(['shadow', 'assignment', 'decomposition']);
const DECOMPOSITION_OPERATORS = new Set([
  'require_specialist_stage',
  'parallelize_independent_nodes',
  'require_synthesis_stage',
]);

export function validateUBuddyOrganizationPlaybook(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('uBuddy organization playbook must be an object.');
  if (String(value.version || '') !== UBUDDY_ORG_PLAYBOOK_VERSION) throw new Error('Unsupported uBuddy organization playbook version.');
  const policyVersionId = boundedText(value.policyVersionId, 160);
  if (!policyVersionId) throw new Error('uBuddy organization playbook requires policyVersionId.');
  const stage = boundedText(value.stage || 'shadow', 32).toLowerCase();
  if (!POLICY_STAGES.has(stage)) throw new Error(`Unsupported uBuddy organization playbook stage: ${stage}.`);
  const taskScopes = normalizeTaskScopes(value.taskScopes);
  const assignmentRules = normalizeAssignmentRules(value.assignmentRules);
  const decompositionRules = normalizeDecompositionRules(value.decompositionRules);
  if (assignmentRules.length + decompositionRules.length > UBUDDY_ORG_POLICY_MAX_RULES) {
    throw new Error(`uBuddy organization playbook exceeds ${UBUDDY_ORG_POLICY_MAX_RULES} rules.`);
  }
  return {
    version: UBUDDY_ORG_PLAYBOOK_VERSION,
    policyVersionId,
    parentPolicyVersionId: boundedText(value.parentPolicyVersionId, 160),
    stage,
    taskScopes,
    assignmentRules,
    decompositionRules,
    hardConstraints: {
      preserveMentionedAgents: value.hardConstraints?.preserveMentionedAgents !== false,
      activeCandidatesOnly: true,
      preserveDeliverables: true,
      preserveFinalNode: true,
    },
    provenance: normalizeProvenance(value.provenance),
    createdAt: validIso(value.createdAt),
  };
}

export function uBuddyOrganizationPolicyHash(playbook = {}) {
  const normalized = validateUBuddyOrganizationPlaybook(playbook);
  const semanticPolicy = {
    version: normalized.version,
    stage: normalized.stage,
    taskScopes: normalized.taskScopes,
    assignmentRules: normalized.assignmentRules.map(({ evidenceCount, rationale, ...rule }) => rule),
    decompositionRules: normalized.decompositionRules.map(({ evidenceCount, rationale, ...rule }) => rule),
    hardConstraints: normalized.hardConstraints,
  };
  return crypto.createHash('sha256').update(stableJson(semanticPolicy)).digest('hex');
}

export function organizationPolicyMatchesTask(playbook = {}, { taskType = '', objective = '' } = {}) {
  const scopes = Array.isArray(playbook.taskScopes) ? playbook.taskScopes : [];
  if (!scopes.length) return true;
  const normalizedTaskType = boundedText(taskType, 120).toLowerCase();
  const normalizedObjective = String(objective || '').toLowerCase();
  return scopes.some((scope) => (
    (!scope.taskTypes.length || scope.taskTypes.includes(normalizedTaskType))
    && (!scope.objectiveIncludes.length || scope.objectiveIncludes.some((token) => normalizedObjective.includes(token)))
  ));
}

function normalizeTaskScopes(value) {
  return (Array.isArray(value) ? value : []).slice(0, 24).map((scope, index) => ({
    id: boundedText(scope?.id || `scope_${index + 1}`, 100),
    taskTypes: uniqueStrings(scope?.taskTypes, 24, 120).map((item) => item.toLowerCase()),
    objectiveIncludes: uniqueStrings(scope?.objectiveIncludes, 24, 120).map((item) => item.toLowerCase()),
    minimumConfidence: clamp(scope?.minimumConfidence ?? 0.7, 0, 1),
  }));
}

function normalizeAssignmentRules(value) {
  return (Array.isArray(value) ? value : []).slice(0, UBUDDY_ORG_POLICY_MAX_RULES).map((rule, index) => {
    const toAgentId = boundedText(rule?.toAgentId, 160);
    const toAgentInstanceId = boundedText(rule?.toAgentInstanceId, 200);
    if (!toAgentId || !toAgentInstanceId || toAgentId === 'secretary_agent') {
      throw new Error(`Invalid assignment rule at index ${index}.`);
    }
    return {
      id: boundedText(rule?.id || `assignment_${index + 1}`, 100),
      taskTypes: uniqueStrings(rule?.taskTypes, 24, 120).map((item) => item.toLowerCase()),
      objectiveIncludes: uniqueStrings(rule?.objectiveIncludes, 24, 120).map((item) => item.toLowerCase()),
      nodeTitleIncludes: uniqueStrings(rule?.nodeTitleIncludes, 24, 120).map((item) => item.toLowerCase()),
      fromAgentId: boundedText(rule?.fromAgentId, 160),
      fromAgentInstanceId: boundedText(rule?.fromAgentInstanceId, 200),
      toAgentId,
      toAgentInstanceId,
      minimumConfidence: clamp(rule?.minimumConfidence ?? 0.7, 0, 1),
      evidenceCount: Math.max(0, Math.floor(Number(rule?.evidenceCount || 0))),
      rationale: boundedText(rule?.rationale, 1000),
    };
  });
}

function normalizeDecompositionRules(value) {
  return (Array.isArray(value) ? value : []).slice(0, UBUDDY_ORG_POLICY_MAX_RULES).map((rule, index) => {
    const operator = boundedText(rule?.operator, 80);
    if (!DECOMPOSITION_OPERATORS.has(operator)) throw new Error(`Invalid decomposition operator at index ${index}.`);
    return {
      id: boundedText(rule?.id || `decomposition_${index + 1}`, 100),
      operator,
      taskTypes: uniqueStrings(rule?.taskTypes, 24, 120).map((item) => item.toLowerCase()),
      objectiveIncludes: uniqueStrings(rule?.objectiveIncludes, 24, 120).map((item) => item.toLowerCase()),
      role: boundedText(rule?.role, 120),
      minimumConfidence: clamp(rule?.minimumConfidence ?? 0.8, 0, 1),
      evidenceCount: Math.max(0, Math.floor(Number(rule?.evidenceCount || 0))),
      rationale: boundedText(rule?.rationale, 1000),
    };
  });
}

function normalizeProvenance(value = {}) {
  return {
    algorithmVersion: boundedText(value?.algorithmVersion || 'ubuddy_org_policy_miner_v1', 120),
    evidenceTraceIds: uniqueStrings(value?.evidenceTraceIds, 100, 200),
    evidenceCount: Math.max(0, Math.floor(Number(value?.evidenceCount || 0))),
    summary: boundedText(value?.summary, 2000),
  };
}

function uniqueStrings(value, limit, length) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => boundedText(item, length)).filter(Boolean))].slice(0, limit);
}

function boundedText(value, limit) {
  return String(value || '').trim().slice(0, limit);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function validIso(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
