import { normalizeUBuddyDeliverables } from '../../../../shared/contracts/uBuddyDispatch.js';

const HIGH_RISK = /(?:删除|清空|付款|购买|转账|发布到|公开|上线|部署|提交审批|密码|密钥|凭据|credential|password|api\s*key|private\s*key|rm\s+-rf)/i;
const EXPLICIT_GROUP = /(?:创建|建立|发起|进入|使用)?\s*(?:任务群|协作群|群任务|task\s*group)/i;

export function classifyUBuddyIntent({
  prompt = '',
  mentions = [],
  attachments = [],
  route = null,
  candidates = [],
  friendships = [],
} = {}) {
  const text = String(prompt || '').trim();
  const userMentions = (mentions || []).filter((item) => item?.principalType === 'user' && item.userId);
  const agentMentions = (mentions || []).filter((item) => item?.principalType === 'agent' && (item.agentId || item.agentInstanceId));
  const routeAgentIds = route?.mode === 'single_agent'
    ? [route.targetAgentId].filter(Boolean)
    : route?.mode === 'workflow'
      ? [...(route.explicitAgentIds || []), route.targetAgentId].filter(Boolean)
      : [];
  const routeAgentInstances = route?.mode === 'workflow' ? route.explicitAgentInstanceIds || [] : [];
  const targetAgents = uniqueAgents([
    ...agentMentions.map((item) => resolveMentionAgent(item, candidates)),
    ...routeAgentInstances.map((agentInstanceId) => resolveRouteAgentInstance(agentInstanceId, candidates)),
    ...routeAgentIds.map((agentId) => resolveRouteAgent(agentId, route, candidates)),
  ].filter(Boolean));
  const targetUsers = uniqueUsers(userMentions.map((mention) => {
    const relationship = (friendships || []).find((item) => String((item.friend || item.user || item)?.id || '') === String(mention.userId));
    return relationship?.friend || relationship?.user || relationship || { id: mention.userId };
  }));
  const highRisk = HIGH_RISK.test(text);
  const multipleTargets = targetUsers.length + targetAgents.length > 1;
  const explicitGroup = EXPLICIT_GROUP.test(text);
  const groupReasons = [
    ...(targetUsers.length > 1 ? ['multiple_recipients'] : []),
    ...(targetAgents.length > 1 ? ['multiple_agents'] : []),
    ...(targetUsers.length && targetAgents.length ? ['mixed_participants'] : []),
    ...(explicitGroup ? ['explicit_task_group'] : []),
  ];
  const deliverables = inferDeliverables(text, attachments);

  if (!targetUsers.length && !targetAgents.length && route?.mode !== 'workflow') {
    return decision('direct_answer', 'direct', {
      confidence: 0.94,
      reasonCodes: ['no_dispatch_target'],
      objective: text,
      deliverables,
    });
  }
  if (highRisk) {
    const postApprovalIntent = multipleTargets || route?.mode === 'workflow' ? 'multi_agent_task' : 'single_agent_task';
    return decision('approval_required_task', dispatchMode(targetUsers, targetAgents, postApprovalIntent), {
      postApprovalIntent,
      targetUsers,
      targetAgents,
      objective: text,
      deliverables,
      requiresTaskGroup: groupReasons.length > 0,
      taskGroupReasons: groupReasons,
      reasonCodes: ['high_risk_confirmation'],
    });
  }
  if (multipleTargets || route?.mode === 'workflow' || explicitGroup) {
    return decision('multi_agent_task', 'task_group', {
      targetUsers,
      targetAgents,
      objective: stripMentionText(text, mentions),
      deliverables,
      requiresTaskGroup: true,
      taskGroupReasons: groupReasons.length ? groupReasons : ['explicit_multi_agent'],
      reasonCodes: ['multiple_execution_participants'],
    });
  }
  if (targetUsers.length === 1) {
    return decision('single_agent_task', 'external_single_delegation', {
      targetUsers,
      objective: stripMentionText(text, mentions),
      deliverables,
      reasonCodes: ['task_mode_external_delegation'],
    });
  }
  return decision('single_agent_task', 'local_single_agent', {
    targetAgents,
    objective: stripMentionText(text, mentions),
    deliverables,
    reasonCodes: ['single_local_agent'],
  });
}

function decision(intent, executionMode, extra = {}) {
  return {
    version: 1,
    intent,
    postApprovalIntent: extra.postApprovalIntent || '',
    executionMode,
    targetUsers: extra.targetUsers || [],
    targetAgents: extra.targetAgents || [],
    objective: String(extra.objective || '').trim(),
    deliverables: normalizeUBuddyDeliverables(extra.deliverables, '完成用户请求并返回可核验结果'),
    confidence: Number(extra.confidence || 0.9),
    reasonCodes: extra.reasonCodes || [],
    requiresTaskGroup: Boolean(extra.requiresTaskGroup),
    taskGroupReasons: extra.taskGroupReasons || [],
  };
}

function dispatchMode(users, agents, intent) {
  if ((users.length + agents.length) > 1 || intent === 'multi_agent_task') return 'task_group';
  return users.length ? 'external_single_delegation' : 'local_single_agent';
}

function resolveMentionAgent(mention = {}, candidates = []) {
  const candidate = (candidates || []).find((item) => (
    (mention.agentInstanceId && item.agentInstanceId === mention.agentInstanceId)
    || (!mention.agentInstanceId && mention.agentId && item.agentId === mention.agentId)
  ));
  return candidate ? publicAgentTarget(candidate) : {
    agentId: String(mention.agentId || '').trim(),
    agentInstanceId: String(mention.agentInstanceId || '').trim(),
    name: String(mention.displayText || mention.agentId || 'Agent').replace(/^@/, '').trim(),
  };
}

function resolveRouteAgent(agentId = '', route = {}, candidates = []) {
  const candidate = (candidates || []).find((item) => (
    item.agentId === agentId && (!route.targetAgentInstanceId || item.agentInstanceId === route.targetAgentInstanceId)
  ));
  return candidate ? publicAgentTarget(candidate) : { agentId, agentInstanceId: '', name: agentId };
}

function resolveRouteAgentInstance(agentInstanceId = '', candidates = []) {
  const candidate = (candidates || []).find((item) => item.agentInstanceId === agentInstanceId);
  return candidate ? publicAgentTarget(candidate) : { agentId: '', agentInstanceId, name: agentInstanceId };
}

function publicAgentTarget(candidate = {}) {
  return {
    agentId: String(candidate.agentId || '').trim(),
    agentInstanceId: String(candidate.agentInstanceId || '').trim(),
    name: String(candidate.name || candidate.displayName || candidate.agentId || 'Agent').trim(),
    departmentId: String(candidate.departmentId || '').trim(),
  };
}

function uniqueAgents(items = []) {
  return [...new Map(items.map((item) => [item.agentInstanceId || item.agentId, item]).filter(([key]) => key)).values()];
}

function uniqueUsers(items = []) {
  return [...new Map(items.map((item) => [String(item.id || ''), item]).filter(([key]) => key)).values()];
}

function inferDeliverables(text = '', attachments = []) {
  const result = [];
  if (/ppt|pptx|演示文稿|幻灯片/i.test(text)) result.push('可编辑的 PPTX 演示文稿');
  if (/报告|文档|方案|汇报/i.test(text)) result.push('完整的书面交付文档');
  if (/代码|实现|修改/i.test(text)) result.push('完成的代码修改及验证结果');
  if (Array.isArray(attachments) && attachments.length) result.push(`处理 ${attachments.length} 个附件`);
  if (!result.length) result.push('完成请求并返回明确结果');
  return result;
}

function stripMentionText(text = '', mentions = []) {
  return (mentions || []).reduce((value, mention) => value.replaceAll(String(mention.displayText || ''), ''), String(text || ''))
    .replace(/^\s*[:：,，、和与及-]+\s*/, '').trim();
}
