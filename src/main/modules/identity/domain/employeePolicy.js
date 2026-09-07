export const EMPLOYEE_QUOTA_LIMIT = 10;
export const EMPLOYEE_POLICY_VERSION = 'employee_recruitment_phase_a_v1';
export const EMPLOYEE_CLOUD_POLICY_VERSION = 'employee_cloud_authority_v1';

export const AGENT_INSTANCE_KINDS = Object.freeze({
  employee: 'employee',
  system: 'system',
  governance: 'governance',
  unavailable: 'unavailable',
});

export const EMPLOYMENT_STATES = Object.freeze({
  active: 'active',
  inactive: 'inactive',
  pendingCloudConfirmation: 'pending_cloud_confirmation',
  conflict: 'conflict',
});

export class EmployeePolicyError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'EmployeePolicyError';
    this.code = code;
  }
}

export function classifyAgentFamily(agent = {}) {
  const id = String(agent.id || '').trim();
  const role = String(agent.role || '').trim();
  const status = String(agent.lifecycleStatus || agent.status || '').trim().toLowerCase();
  const lifecycleUnavailable = ['disabled', 'retired', 'archived'].includes(status);
  const installableSkillPending = Boolean(agent.skillPackageId) && agent.skillInstalled === false;
  const unavailable = lifecycleUnavailable || (agent.enabled === false && !installableSkillPending);

  if (id === 'secretary_agent') {
    return classification({ instanceKind: AGENT_INSTANCE_KINDS.system, quotaCost: 0 });
  }
  if (['hr', 'department_leader'].includes(role)) {
    return classification({ instanceKind: AGENT_INSTANCE_KINDS.governance, quotaCost: 0 });
  }
  if (id === 'general_agent' && !unavailable) {
    return classification({
      instanceKind: AGENT_INSTANCE_KINDS.employee,
      recruitable: true,
      defaultForNewUser: true,
      quotaCost: 1,
    });
  }
  if (installableSkillPending && !unavailable) {
    return classification({
      instanceKind: AGENT_INSTANCE_KINDS.employee,
      recruitable: true,
      quotaCost: 1,
    });
  }
  if (!unavailable && Boolean(agent.routable)) {
    return classification({
      instanceKind: AGENT_INSTANCE_KINDS.employee,
      recruitable: true,
      quotaCost: 1,
    });
  }
  return classification({ instanceKind: AGENT_INSTANCE_KINDS.unavailable, quotaCost: 0 });
}

export function countsTowardEmployeeQuota(instance = {}) {
  return instance.instanceKind === AGENT_INSTANCE_KINDS.employee
    && instance.employmentState === EMPLOYMENT_STATES.active
    && !instance.quotaExempt;
}

export function canRouteEmployee({ instance = {}, family = {} } = {}) {
  const familyStatus = String(family.status || '').trim().toLowerCase();
  const active = countsTowardEmployeeQuota(instance) && instance.status === 'active';
  const locallyActiveWhileSyncing = instance.instanceKind === AGENT_INSTANCE_KINDS.employee
    && instance.authorityState === 'pending'
    && instance.pendingTargetState === EMPLOYMENT_STATES.active
    && instance.employmentState !== EMPLOYMENT_STATES.conflict
    && !instance.quotaExempt;
  return (active || locallyActiveWhileSyncing)
    && family.instanceKind === AGENT_INSTANCE_KINDS.employee
    && family.routable === true
    && family.recruitable === true
    && !['disabled', 'retired', 'archived', 'unavailable'].includes(familyStatus);
}

export function employeeQuotaSnapshot(instances = [], limit = EMPLOYEE_QUOTA_LIMIT) {
  const safeLimit = Math.max(1, Number(limit || EMPLOYEE_QUOTA_LIMIT));
  const used = instances.filter(countsTowardEmployeeQuota).length;
  return {
    used,
    limit: safeLimit,
    remaining: Math.max(0, safeLimit - used),
    grandfatheredOverLimit: used > safeLimit,
    policyState: used > safeLimit ? 'grandfathered_over_limit' : 'within_limit',
    policyVersion: EMPLOYEE_POLICY_VERSION,
  };
}

export function canRecruitAgent({ family = {}, instance = null, quota = {}, requireInstalledSkill = false } = {}) {
  if (family.instanceKind !== AGENT_INSTANCE_KINDS.employee || !family.recruitable) {
    return { allowed: false, code: 'agent_not_recruitable' };
  }
  if (requireInstalledSkill
    && Boolean(String(family.metadata?.skillPackageId || '').trim())
    && family.routable !== true) {
    return { allowed: false, code: 'agent_skill_install_required' };
  }
  if (instance?.employmentState === EMPLOYMENT_STATES.active) {
    return { allowed: false, code: 'agent_already_active' };
  }
  const pendingLocalDeactivation = instance?.authorityState === 'pending'
    && instance?.pendingTargetState === EMPLOYMENT_STATES.inactive
    && instance?.employmentState === EMPLOYMENT_STATES.inactive;
  if ((instance?.authorityState === 'pending' && !pendingLocalDeactivation)
    || instance?.employmentState === EMPLOYMENT_STATES.conflict) {
    return { allowed: false, code: 'employee_command_pending' };
  }
  if (instance?.employmentState === EMPLOYMENT_STATES.pendingCloudConfirmation
    && instance?.pendingTargetState === EMPLOYMENT_STATES.active) {
    return { allowed: false, code: 'employee_command_pending' };
  }
  if (Number(quota.used || 0) >= Number(quota.limit || EMPLOYEE_QUOTA_LIMIT)) {
    return { allowed: false, code: 'employee_quota_exceeded' };
  }
  return { allowed: true, code: instance ? 'reactivate' : 'recruit' };
}

export function employeePolicyError(code, message = '') {
  return new EmployeePolicyError(code, message || employeePolicyMessage(code));
}

function employeePolicyMessage(code) {
  const messages = {
    agent_not_recruitable: 'Agent family is not recruitable.',
    agent_skill_install_required: 'The required local Skill must be installed before recruiting this Agent.',
    agent_already_active: 'Employee Agent is already active.',
    agent_instance_not_found: 'Employee Agent instance was not found.',
    employee_not_active: 'Employee Agent is not active.',
    employee_quota_exceeded: 'Employee quota exceeded.',
    employee_state_conflict: 'Employee state revision is stale.',
    employee_command_pending: 'An employee lifecycle command is already queued for cloud synchronization.',
    recruitment_command_required: 'Recruitment commandId is required.',
    agent_instance_owner_mismatch: 'Employee Agent instance does not belong to the user.',
  };
  return messages[code] || code;
}

function classification({ instanceKind, recruitable = false, defaultForNewUser = false, quotaCost = 0 }) {
  return {
    instanceKind,
    recruitable: Boolean(recruitable),
    defaultForNewUser: Boolean(defaultForNewUser),
    quotaCost: Number(quotaCost || 0),
    classificationVersion: EMPLOYEE_POLICY_VERSION,
  };
}
