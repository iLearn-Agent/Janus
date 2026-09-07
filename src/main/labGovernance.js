export const BUDDY_AGENT_ID = 'secretary_agent';
export const BUDDY_DEPARTMENT_ID = 'secretary_department';
export const GENERAL_AGENT_ID = 'general_agent';

const FULL_PARTICIPATION = Object.freeze({
  recruitment: true,
  assessment: true,
  promotion: true,
  demotion: true,
  probation: true,
  merge: true,
  retirement: true,
  dismissal: true,
});

export function labGovernancePolicy(agentOrId = '') {
  const agentId = typeof agentOrId === 'string' ? agentOrId : String(agentOrId?.id || '');
  const departmentId = typeof agentOrId === 'string' ? '' : String(agentOrId?.departmentId || '');
  if (agentId === BUDDY_AGENT_ID || departmentId === BUDDY_DEPARTMENT_ID) {
    return {
      recruitment: false,
      assessment: true,
      assessmentScope: ['private_task_assistance', 'delegation_coordination', 'task_follow_through', 'privacy_boundary'],
      failedAssessmentAction: 'rollback_best_assessed_skill_only',
      promotion: false,
      demotion: false,
      probation: false,
      merge: false,
      retirement: false,
      dismissal: false,
    };
  }
  if (agentId === GENERAL_AGENT_ID) {
    return {
      recruitment: true,
      recruitmentScope: ['new_agent', 'new_department'],
      assessment: false,
      promotion: false,
      demotion: false,
      probation: false,
      merge: false,
      retirement: false,
      dismissal: false,
    };
  }
  return { ...FULL_PARTICIPATION };
}
