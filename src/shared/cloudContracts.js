export const CLOUD_CONTEXT_KINDS = Object.freeze([
  'general_memory',
  'project',
  'task',
  'relationship',
]);

export const CLOUD_CONTEXT_LIFECYCLE_STATES = Object.freeze(['active', 'inactive', 'archived']);
export const CLOUD_MEMORY_SCOPES = Object.freeze(['general', 'task', 'project', 'relationship']);
export const CLOUD_MEMORY_VISIBILITIES = Object.freeze([
  'agent_private',
  'owner_private',
  'work_collaborators',
  'work_leadership',
  'work_participants',
  'work_summary',
]);
export const CLOUD_MEMORY_MAPPING_STATES = Object.freeze(['active', 'superseded', 'revoked']);
export const CLOUD_PERSONAL_SCHEDULE_STATES = Object.freeze([
  'never_evaluated',
  'insufficient_evidence',
  'queued',
  'applied',
  'evaluated_rejected',
  'failed_retryable',
  'failed_terminal',
  'legacy_proposal_stale',
]);
export const CLOUD_AGENT_INSTANCE_STATES = Object.freeze(['active', 'inactive']);
export const CLOUD_AGENT_INSTANCE_KINDS = Object.freeze(['employee', 'system', 'governance', 'unavailable']);
export const CLOUD_PERFORMANCE_LEVELS = Object.freeze(Array.from({ length: 10 }, (_, index) => `P${index + 1}`));
export const CLOUD_LEADERSHIP_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);
export const CLOUD_LEADERSHIP_STATUSES = Object.freeze(['active', 'frozen', 'inactive']);
export const CLOUD_LEADERSHIP_ASSIGNMENT_MODES = Object.freeze(['normal', 'trial']);
export const CLOUD_LEADERSHIP_ROLES = Object.freeze(['task_lead', 'team_lead', 'cross_team_lead']);
export const CLOUD_PERSONAL_PROPOSAL_STATES = Object.freeze([
  'ready', 'partially_applied', 'applied', 'rejected', 'legacy_proposal_stale',
]);
export const CLOUD_MEMORY_OPERATION_STATES = Object.freeze(['pending', 'applied', 'rejected']);
export const CLOUD_SKILL_VERSION_STATES = Object.freeze(['candidate', 'active', 'archived', 'rejected']);
export const CLOUD_SKILL_STABILITY_STATES = Object.freeze(['candidate', 'stable']);
export const CLOUD_VERSION_HEALTH_STATES = Object.freeze([
  'collecting', 'healthy', 'regressing', 'rollback_required', 'rolled_back',
]);
export const CLOUD_COHORT_STATES = Object.freeze(['active', 'ineligible', 'inactive']);
export const CLOUD_MARKET_ARTIFACT_STATES = Object.freeze(['draft', 'released', 'rejected', 'archived']);
export const CLOUD_MARKET_ADOPTION_STATES = Object.freeze(['adopted', 'superseded', 'rolled_back', 'ignored']);

export const CLOUD_MEMORY_CONTRACT_VERSION = 2;
export const CLOUD_EMPLOYEE_CONTRACT_VERSION = 2;
export const CLOUD_EMPLOYEE_POLICY_VERSION = 'employee_cloud_authority_v1';
export const CLOUD_LEADERSHIP_POLICY_VERSION = 'leadership_v2';
export const CLOUD_EMPLOYEE_QUOTA_LIMIT = 10;

export function cloudEmployeeCapability(enabled = true, code = '') {
  return {
    enabled: Boolean(enabled),
    authority: 'cloud',
    authorityLocked: true,
    contractVersion: CLOUD_EMPLOYEE_CONTRACT_VERSION,
    policyVersion: CLOUD_EMPLOYEE_POLICY_VERSION,
    quotaLimit: CLOUD_EMPLOYEE_QUOTA_LIMIT,
    lifecycleMutation: 'command_only',
    canonicalInstances: true,
    profileSequenceAuthority: 'server',
    instanceAliasProjection: 'overview_v1',
    localInstanceAdoption: 'recruit_preserve_state_v1',
    requiredCapabilities: ['employee-instance-profile-uniqueness-v1'],
    bootstrapSupported: true,
    ...(code ? { code } : {}),
  };
}

export function cloudMultiMemoryCapability(enabled = true, code = '') {
  return {
    enabled: Boolean(enabled),
    contractVersion: CLOUD_MEMORY_CONTRACT_VERSION,
    contextSpaces: Boolean(enabled),
    cloudKeyMappings: Boolean(enabled),
    accountContextState: Boolean(enabled),
    offlineLocalWrites: true,
    ...(code ? { code } : {}),
  };
}

export function normalizeCloudMemoryVisibility(value = '') {
  const visibility = String(value || 'agent_private').trim().toLowerCase();
  if (visibility === 'private') return 'agent_private';
  if (!CLOUD_MEMORY_VISIBILITIES.includes(visibility)) throw new Error(`Unsupported cloud Memory visibility: ${visibility}`);
  return visibility;
}

export function normalizeCloudTriggerKind(value = '') {
  const kind = String(value || 'scheduled').trim().toLowerCase();
  if (['auto', 'automatic', 'scheduled'].includes(kind)) return 'scheduled';
  if (kind === 'manual') return 'manual';
  throw new Error(`Unsupported evolution trigger kind: ${kind}`);
}
