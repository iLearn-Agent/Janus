import {
  organizationPolicyMatchesTask,
  validateUBuddyOrganizationPlaybook,
} from '../../../../shared/contracts/uBuddyOrganizationEvolution.js';

export function isUBuddyOrganizationEvolutionEligible(context = {}) {
  return context.decision === 'task_plan'
    && context.dispatchAuthorized === true
    && context.readinessApproved === true
    && context.isNewTask === true
    && context.privacyScope === 'owner_private'
    && !context.parentTaskRunId
    && !context.continuation
    && !context.revision
    && !context.collaborationGroupId
    && !context.externalDelegationId
    && !context.organizationResearch;
}

export function applyUBuddyOrganizationPolicy({
  baselineDecision = null,
  eligibilityContext = {},
  candidates = [],
  mentionedAgentIds = [],
  activePolicySnapshot = null,
  assignmentEnabled = false,
  decompositionEnabled = false,
  validateDecision = null,
} = {}) {
  const baseline = baselineDecision;
  const unchanged = (reason, extra = {}) => ({
    effectiveDecision: baseline,
    applicationRecord: { applied: false, reason, policyVersionId: '', ruleIds: [], ...extra },
  });
  if (!baseline || baseline.decision !== 'task_plan') return unchanged('decision_not_task_plan');
  if (!isUBuddyOrganizationEvolutionEligible(eligibilityContext)) return unchanged('task_not_eligible');
  if (!activePolicySnapshot?.playbook) return unchanged('no_active_policy');

  try {
    const playbook = validateUBuddyOrganizationPlaybook(activePolicySnapshot.playbook);
    const taskContext = {
      taskType: eligibilityContext.taskType || '',
      objective: eligibilityContext.objective || '',
    };
    if (!organizationPolicyMatchesTask(playbook, taskContext)) return unchanged('policy_scope_miss', { policyVersionId: playbook.policyVersionId });
    const allowAssignment = assignmentEnabled && ['assignment', 'decomposition'].includes(playbook.stage);
    const allowDecomposition = decompositionEnabled && playbook.stage === 'decomposition';
    if (!allowAssignment && !allowDecomposition) return unchanged('policy_stage_not_enabled', { policyVersionId: playbook.policyVersionId });

    const candidateByInstance = new Map((Array.isArray(candidates) ? candidates : [])
      .map((candidate) => [String(candidate?.agentInstanceId || ''), candidate]).filter(([id]) => id));
    const mentioned = new Set((Array.isArray(mentionedAgentIds) ? mentionedAgentIds : []).map(String));
    const ruleIds = [];
    const nodes = baseline.nodes.map((node) => {
      if (!allowAssignment) return { ...node };
      const rule = playbook.assignmentRules.find((item) => assignmentRuleMatches(item, node, {
        ...taskContext, confidence: baseline.confidence,
      }));
      if (!rule) return { ...node };
      const target = candidateByInstance.get(rule.toAgentInstanceId);
      if (!target || String(target.agentId || '') !== rule.toAgentId) return { ...node };
      if (playbook.hardConstraints.preserveMentionedAgents && mentioned.has(node.agentId) && node.agentId !== rule.toAgentId) return { ...node };
      ruleIds.push(rule.id);
      return {
        ...node,
        agentId: rule.toAgentId,
        agentInstanceId: rule.toAgentInstanceId,
        departmentId: String(target.departmentId || node.departmentId || ''),
      };
    });
    if (!ruleIds.length) return unchanged('no_rule_match', { policyVersionId: playbook.policyVersionId });
    const proposal = {
      ...baseline,
      nodes,
      deliverables: baseline.deliverablePlan?.deliverables || [],
      agentSelectionRationale: `${baseline.agentSelectionRationale}\nOrganization policy ${playbook.policyVersionId}: ${[...new Set(ruleIds)].join(', ')}`.slice(0, 4000),
    };
    const effectiveDecision = typeof validateDecision === 'function' ? validateDecision(proposal) : proposal;
    return {
      effectiveDecision,
      applicationRecord: {
        applied: true,
        reason: 'assignment_policy_applied',
        policyVersionId: playbook.policyVersionId,
        policyHash: String(activePolicySnapshot.policyHash || ''),
        ruleIds: [...new Set(ruleIds)],
        decompositionShadowRuleIds: allowDecomposition ? playbook.decompositionRules.map((item) => item.id) : [],
      },
    };
  } catch (error) {
    return unchanged('policy_rejected', {
      policyVersionId: String(activePolicySnapshot?.playbook?.policyVersionId || activePolicySnapshot?.policyVersionId || ''),
      errorCode: String(error?.code || 'ubuddy_org_policy_invalid'),
    });
  }
}

function assignmentRuleMatches(rule, node, { taskType = '', objective = '', confidence = 0 } = {}) {
  const normalizedTaskType = String(taskType || '').toLowerCase();
  const normalizedObjective = String(objective || '').toLowerCase();
  const nodeText = `${String(node.title || '')}\n${String(node.objective || '')}`.toLowerCase();
  return Number(confidence || 0) >= Number(rule.minimumConfidence || 0)
    && (!rule.taskTypes.length || rule.taskTypes.includes(normalizedTaskType))
    && (!rule.objectiveIncludes.length || rule.objectiveIncludes.some((token) => normalizedObjective.includes(token)))
    && (!rule.nodeTitleIncludes.length || rule.nodeTitleIncludes.some((token) => nodeText.includes(token)))
    && (!rule.fromAgentId || rule.fromAgentId === node.agentId)
    && (!rule.fromAgentInstanceId || rule.fromAgentInstanceId === node.agentInstanceId)
    && !(rule.toAgentId === node.agentId && rule.toAgentInstanceId === node.agentInstanceId);
}
