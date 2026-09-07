import { classifyTaskType } from '../domain/taskExecutionMetrics.js';
import {
  proposeUBuddyTaskGraph,
} from './uBuddyTaskGraphPlanner.js';

export async function planUBuddyDispatch({
  prompt = '',
  candidates = [],
  organization = { agents: [] },
  attachments = [],
  root = '',
  cwd = '',
  model = '',
  reasoningEffort = '',
  permissionMode = '',
  signal = null,
  executionContext = null,
  propose = proposeUBuddyTaskGraph,
} = {}) {
  const cleanPrompt = String(prompt || '').trim();
  if (!cleanPrompt) throw new Error('uBuddy dispatch requires a task request.');
  const constraints = resolveUBuddyAgentConstraints({
    prompt: cleanPrompt,
    candidates,
    organization,
  });
  const eligibleCandidates = constrainedCandidates(candidates, constraints);
  if (!eligibleCandidates.length) throw new Error('employee_not_active: no eligible employee is available for this task.');
  const objective = buildUBuddyDispatchObjective(cleanPrompt, attachments);
  const planningPrompt = [
    cleanPrompt,
    objective.deliverables.length ? `Required deliverables:\n- ${objective.deliverables.join('\n- ')}` : '',
    constraints.requiredAgentIds.length ? `Required execution agents: ${constraints.requiredAgentIds.join(', ')}` : '',
    constraints.requiredAgentInstanceIds.length ? `Required execution Agent instances: ${constraints.requiredAgentInstanceIds.join(', ')}` : '',
    constraints.preferredAgentIds.length ? `Preferred execution agents: ${constraints.preferredAgentIds.join(', ')}` : '',
    'Decide the actual work stages, dependencies, and best employee for every stage. Do not classify the request as single-agent or multi-agent in advance. A single employee may own multiple dependent nodes when that is the best plan.',
  ].filter(Boolean).join('\n\n');

  try {
    const proposal = await propose({
      prompt: planningPrompt,
      candidates: eligibleCandidates,
      root,
      cwd,
      model,
      reasoningEffort,
      permissionMode,
      signal,
      executionContext,
    });
    if (proposal.status === 'needs_clarification') {
      return {
        objective,
        nodes: [],
        finalNodeId: '',
        deliverablePlan: null,
        clarification: proposal.clarification,
        confidence: proposal.confidence,
        mode: 'clarification',
        constraints,
      };
    }
    assertRequiredAgentsUsed(proposal.nodes, constraints.requiredAgentIds, constraints.requiredAgentInstanceIds);
    return {
      objective,
      nodes: proposal.nodes,
      finalNodeId: proposal.finalNodeId,
      deliverablePlan: proposal.deliverablePlan || null,
      rationale: dispatchRationale(proposal.nodes, constraints),
      confidence: 0.9,
      mode: 'model',
      constraints,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const targetLabel = constraints.requiredAgentIds.length
      ? ` for explicitly requested Agents ${constraints.requiredAgentIds.join(', ')}`
      : '';
    const planningError = new Error(`uBuddy task graph planning failed${targetLabel}; no unrelated single-Agent fallback was created. ${String(error?.message || error)}`);
    planningError.code = 'ubuddy_task_graph_planning_failed';
    planningError.cause = error;
    throw planningError;
  }
}

export function resolveUBuddyAgentConstraints({ prompt = '', candidates = [], organization = { agents: [] } } = {}) {
  const active = new Set((candidates || []).map((item) => item.agentId));
  const compact = normalizeMentionText(prompt);
  const mentioned = (organization.agents || []).filter((agent) => {
    if (!agent?.id || agent.id === 'secretary_agent' || !active.has(agent.id)) return false;
    const aliases = [
      agent.id,
      agent.name,
      String(agent.name || '').replace(/\s+agent$/i, ''),
      agent.id === 'general_agent' ? '通用Agent' : '',
      agent.id === 'ppt' ? 'PPTAgent' : '',
    ].map(normalizeMentionText).filter((item) => item.length >= 3);
    return aliases.some((alias) => compact.includes(alias));
  }).map((agent) => agent.id);
  const preferenceOnly = /(优先|尽量|prefer|if possible)/i.test(String(prompt || ''));
  const mentionedInstances = (candidates || []).filter((candidate) => {
    if (!candidate?.agentId || !candidate?.agentInstanceId) return false;
    const aliases = [candidate.name, candidate.displayName, candidate.agentInstanceId]
      .map(normalizeMentionText).filter((item) => item.length >= 2);
    return aliases.some((alias) => compact.includes(alias));
  });
  return {
    requiredAgentIds: preferenceOnly ? [] : [...new Set([...mentioned, ...mentionedInstances.map((item) => item.agentId)])],
    requiredAgentInstanceIds: preferenceOnly ? [] : [...new Set(mentionedInstances.map((item) => item.agentInstanceId))],
    preferredAgentIds: preferenceOnly ? [...new Set(mentioned)] : [],
    preferredAgentInstanceIds: preferenceOnly ? [...new Set(mentionedInstances.map((item) => item.agentInstanceId))] : [],
    excludedAgentIds: [],
  };
}

function constrainedCandidates(candidates = [], constraints = {}) {
  const required = new Set(constraints.requiredAgentIds || []);
  const requiredInstances = new Set(constraints.requiredAgentInstanceIds || []);
  const instanceBoundFamilies = new Set((candidates || [])
    .filter((item) => requiredInstances.has(item.agentInstanceId)).map((item) => item.agentId));
  const excluded = new Set(constraints.excludedAgentIds || []);
  const filtered = (candidates || []).filter((item) => !excluded.has(item.agentId)
    && (!instanceBoundFamilies.has(item.agentId) || requiredInstances.has(item.agentInstanceId)));
  if (!required.size) return filtered;
  return filtered.filter((item) => required.has(item.agentId));
}

function assertRequiredAgentsUsed(nodes = [], requiredAgentIds = [], requiredAgentInstanceIds = []) {
  if (!requiredAgentIds.length) return;
  const used = new Set(nodes.map((node) => node.agentId));
  const missing = requiredAgentIds.filter((agentId) => !used.has(agentId));
  if (missing.length) throw new Error(`uBuddy dispatch omitted required agents: ${missing.join(', ')}`);
  const usedInstances = new Set(nodes.map((node) => node.agentInstanceId).filter(Boolean));
  const missingInstances = requiredAgentInstanceIds.filter((agentInstanceId) => !usedInstances.has(agentInstanceId));
  if (missingInstances.length) throw new Error(`uBuddy dispatch omitted required Agent instances: ${missingInstances.join(', ')}`);
}

function buildUBuddyDispatchObjective(prompt = '', attachments = []) {
  const taskType = classifyTaskType(prompt);
  const deliverables = ({
    code_change: ['完成请求范围内的代码修改', '运行相关测试或检查'],
    file_generation: ['生成用户要求的文件或文档', '说明产物和验证情况'],
    command_execution: ['执行必要操作', '汇总关键输出与结果'],
    research: ['形成有依据的调研结论', '说明限制与待确认项'],
    explanation: ['清晰解释问题并给出结论'],
  })[taskType] || ['完成用户要求并给出可核验结果'];
  if (Array.isArray(attachments) && attachments.length) deliverables.push(`处理 ${attachments.length} 个附件`);
  const summary = String(prompt || '').replace(/\s+/g, ' ').trim();
  return {
    taskType,
    summary: summary.length > 180 ? `${summary.slice(0, 179)}…` : summary,
    deliverables,
    constraints: [],
    openQuestions: [],
  };
}

function dispatchRationale(nodes = [], constraints = {}) {
  const agents = [...new Set(nodes.map((node) => node.agentId).filter(Boolean))];
  const stages = nodes.length;
  const constraint = constraints.requiredAgentIds?.length
    ? `并遵守指定执行人 ${constraints.requiredAgentIds.join('、')}`
    : '';
  return `uBuddy 根据有效 Skill、交付阶段、依赖关系和队列状态规划了 ${stages} 个执行节点，由 ${agents.join('、')} 负责${constraint}。`;
}

function normalizeMentionText(value = '') {
  return String(value || '').toLowerCase().replace(/[\s_\-·.]+/g, '');
}
