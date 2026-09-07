import { classifyPptIntent } from '../../../pptIntent.js';

export const UBUDDY_ROUTE_VERSION = 'ubuddy_route_v2';
export const UBUDDY_ESCALATION_TAG = 'JANUS_UBUDDY_ESCALATION_V1';

const COLLABORATION_SIGNAL = /(?:多部门协作|部门协作|跨部门|多个(?:\s*agent|智能体)|多\s*(?:个|名)?\s*(?:agent|智能体)|agent\s*(?:协作|合作)|协同(?:完成|处理|执行)|task\s*graph|multi[- ]agent)/i;
const DELEGATION_VERB = /(?:交给|派给|分配给|安排|调用|启用|让|请|告诉|委托|转给|由)/i;
const EXECUTION_VERB = /(?:处理|完成|执行|制作|生成|撰写|编写|实现|修改|分析|调研|研究|检查|审校|负责|来做|帮忙)/i;

export function planUBuddyRoute({
  prompt = '',
  attachments = [],
  candidates = [],
  organization = { agents: [] },
  forceWorkflow = false,
} = {}) {
  const text = String(prompt || '').trim();
  const activeIds = new Set((candidates || []).map((candidate) => String(candidate.agentId || '')).filter(Boolean));
  const explicitInstanceTargets = explicitUBuddyInstanceTargets(text, candidates);
  const explicitAgentIds = [...new Set([
    ...explicitUBuddyAgentTargets(text, organization, activeIds),
    ...explicitInstanceTargets.map((candidate) => candidate.agentId),
  ])];
  const pptIntent = classifyPptIntent(text, { attachments });

  if (forceWorkflow) {
    return route('workflow', 'task_rerun_lineage', { source: 'explicit', explicitAgentIds });
  }
  if (explicitAgentIds.length > 1 || explicitInstanceTargets.length > 1 || COLLABORATION_SIGNAL.test(text)) {
    return route('workflow', explicitAgentIds.length > 1 || explicitInstanceTargets.length > 1
      ? 'multiple_agents_requested'
      : 'collaboration_requested', {
      source: 'explicit',
      explicitAgentIds,
      explicitAgentInstanceIds: explicitInstanceTargets.map((candidate) => candidate.agentInstanceId),
    });
  }
  if (explicitAgentIds.length === 1) {
    const explicitInstance = explicitInstanceTargets.length === 1 ? explicitInstanceTargets[0] : null;
    return route('single_agent', 'agent_explicitly_requested', {
      source: 'explicit',
      targetAgentId: explicitAgentIds[0],
      targetAgentInstanceId: explicitInstance?.agentInstanceId || '',
      explicitAgentIds,
      explicitAgentInstanceIds: explicitInstance ? [explicitInstance.agentInstanceId] : [],
    });
  }
  if (pptIntent.creation) {
    return route('single_agent', 'specialist_artifact_required', {
      source: 'local',
      targetAgentId: activeIds.has('ppt') ? 'ppt' : '',
      requiredCapabilities: ['pptx_generation'],
    });
  }
  return route('direct', 'ubuddy_default_direct', { source: 'local' });
}

export function parseUBuddyEscalation(value = '') {
  const text = String(value || '').trim();
  const match = text.match(new RegExp(`^<${UBUDDY_ESCALATION_TAG}>([\\s\\S]+)</${UBUDDY_ESCALATION_TAG}>$`));
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new Error('uBuddy escalation control output is not valid JSON.');
  }
  const mode = parsed?.mode === 'workflow' ? 'workflow' : parsed?.mode === 'single_agent' ? 'single_agent' : '';
  if (!mode) throw new Error('uBuddy escalation must select single_agent or workflow.');
  return route(mode, String(parsed.reasonCode || 'ubuddy_capability_boundary').trim().slice(0, 120), {
    source: 'direct_escalation',
    targetAgentId: String(parsed.targetAgentId || parsed.preferredAgentId || '').trim(),
    targetAgentInstanceId: String(parsed.targetAgentInstanceId || parsed.preferredAgentInstanceId || '').trim(),
    requiredCapabilities: cleanStringArray(parsed.requiredCapabilities, 12, 120),
    reason: String(parsed.reason || '').trim().slice(0, 800),
  });
}

export function isUBuddyEscalationPrefix(value = '') {
  const text = String(value || '').trimStart();
  const prefix = `<${UBUDDY_ESCALATION_TAG}>`;
  return prefix.startsWith(text) || text.startsWith(prefix);
}

export function selectUBuddyEscalationCandidate(candidates = [], escalation = {}) {
  const active = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.agentId && candidate?.agentInstanceId);
  if (escalation.targetAgentInstanceId) {
    return active.find((candidate) => candidate.agentInstanceId === escalation.targetAgentInstanceId
      && (!escalation.targetAgentId || candidate.agentId === escalation.targetAgentId)) || null;
  }
  if (escalation.targetAgentId) {
    return active.find((candidate) => candidate.agentId === escalation.targetAgentId) || null;
  }
  const capabilities = cleanStringArray(escalation.requiredCapabilities, 12, 120);
  if (!capabilities.length) return null;
  return active.map((candidate) => {
    const skill = String(candidate.effectiveSkill || '').toLowerCase();
    const hits = capabilityMatchScore(capabilities, skill);
    return { candidate, hits, queueDepth: Number(candidate.queueDepth || 0) };
  }).filter((item) => item.hits > 0)
    .sort((left, right) => right.hits - left.hits || left.queueDepth - right.queueDepth)[0]?.candidate || null;
}

const CAPABILITY_CONCEPTS = [
  ['code', 'coding', 'program', 'programming', 'script', '代码', '编程', '程序'],
  ['verify', 'verification', 'validate', 'validation', 'test', 'testing', '验证', '校验', '检查'],
  ['analysis', 'analyze', 'reasoning', '分析', '推理', '问题求解'],
  ['write', 'writing', 'document', 'documentation', '写作', '撰写', '文档'],
  ['research', 'investigate', '调研', '研究'],
  ['file', 'artifact', '文件', '产物'],
  ['ppt', 'pptx', 'slides', 'deck', '演示文稿', '幻灯片'],
];

function capabilityMatchScore(capabilities = [], skill = '') {
  const capabilityText = capabilities.join(' ').toLowerCase();
  const lexical = capabilityText.split(/[^\p{L}\p{N}]+/u).filter((item) => item.length >= 2);
  const lexicalHits = new Set(lexical.filter((item) => skill.includes(item))).size;
  const conceptHits = CAPABILITY_CONCEPTS.filter((aliases) => (
    aliases.some((alias) => capabilityText.includes(alias))
      && aliases.some((alias) => skill.includes(alias))
  )).length;
  return lexicalHits + conceptHits * 2;
}

function explicitUBuddyAgentTargets(text = '', organization = { agents: [] }, activeIds = new Set()) {
  const normalizedText = String(text || '');
  const targets = [];
  for (const agent of organization.agents || []) {
    if (!agent?.id || agent.id === 'secretary_agent' || !activeIds.has(agent.id)) continue;
    const aliases = agentAliases(agent).filter(Boolean);
    if (aliases.some((alias) => explicitAliasRequested(normalizedText, alias))) targets.push(agent.id);
  }
  return [...new Set(targets)];
}

function explicitUBuddyInstanceTargets(text = '', candidates = []) {
  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!candidate?.agentId || !candidate?.agentInstanceId) return false;
    const aliases = [candidate.name, candidate.displayName, candidate.agentInstanceId]
      .map((item) => String(item || '').trim()).filter((item) => item.length >= 2);
    return aliases.some((alias) => explicitAliasRequested(text, alias));
  });
  return [...new Map(matches.map((candidate) => [candidate.agentInstanceId, candidate])).values()];
}

function explicitAliasRequested(text = '', alias = '') {
  const escaped = escapeRegExp(alias);
  const before = new RegExp(`${DELEGATION_VERB.source}.{0,20}${escaped}`, 'i');
  const after = new RegExp(`${escaped}.{0,24}${EXECUTION_VERB.source}`, 'i');
  return before.test(text) || after.test(text);
}

function agentAliases(agent = {}) {
  const aliases = [agent.id, agent.name, String(agent.name || '').replace(/\s+agent$/i, '')];
  if (agent.id === 'general_agent') aliases.push('Generalist', 'General Agent', '通用 Agent', '通用Agent', '通用 agent');
  if (agent.id === 'ppt') aliases.push('PPT Designer', 'PPTDesigner', 'PPTAgent', 'PPT Agent');
  return [...new Set(aliases.map((item) => String(item || '').trim()).filter((item) => item.length >= 2))];
}

function route(mode, reasonCode, extra = {}) {
  return {
    version: UBUDDY_ROUTE_VERSION,
    mode,
    source: extra.source || 'local',
    reasonCode,
    targetAgentId: extra.targetAgentId || '',
    targetAgentInstanceId: extra.targetAgentInstanceId || '',
    explicitAgentIds: cleanStringArray(extra.explicitAgentIds, 12, 120),
    explicitAgentInstanceIds: cleanStringArray(extra.explicitAgentInstanceIds, 12, 160),
    requiredCapabilities: cleanStringArray(extra.requiredCapabilities, 12, 120),
    reason: extra.reason || '',
  };
}

function cleanStringArray(value, limit, itemLimit) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim().slice(0, itemLimit)).filter(Boolean))].slice(0, limit);
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
