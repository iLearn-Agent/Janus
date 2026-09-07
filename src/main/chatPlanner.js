import { classifyPptIntent } from './pptIntent.js';

const COMPLEXITY_SIGNALS = [
  /(先.+再.+最后|从.+到.+完整|端到端|全流程|一整套|完整方案|分阶段|多部门|协同|协作)/is,
  /\b(end[- ]to[- ]end|complete workflow|multi[- ]stage|multi[- ]department|coordinate|collaborate|roadmap)\b/i,
];

const ACTION_TERMS = /(分析|调研|检索|搜索|查询|查找|筛选|整理|归纳|设计|实现|编写|撰写|生成|制作|评估|验证|汇总|整合|规划|修改|润色|对比|research|search|query|find|filter|organize|analyse|analyze|design|implement|write|generate|create|evaluate|validate|summari[sz]e|integrate|plan|revise)/gi;

const RESEARCH_SOURCE_TERMS = /(调研|检索|搜索|查询|查找|research|search|query|find)/i;
const RESEARCH_SYNTHESIS_TERMS = /(筛选|整理|归纳|汇总|整合|对比|总结|filter|organize|summari[sz]e|integrate|compare)/i;

const LIGHTWEIGHT_CONVERSATIONAL_TERMS = /^(?:hi|hello|hey|yo|ok|okay|thanks?|thank you|thx|\u4f60\u597d|\u60a8\u597d|\u55e8|\u54c8\u55bd|\u5728\u5417|\u8c22\u8c22|\u611f\u8c22|\u597d\u7684|\u597d|\u55ef|\u6536\u5230|\u53ef\u4ee5|\u884c|\u65e9\u4e0a\u597d|\u4e0b\u5348\u597d|\u665a\u4e0a\u597d)[\u3002.!\uff01?\uff1f,\uff0c\s]*$/iu;

export function planHomeChatRoute({
  message = '',
  routePreference = 'auto',
  selectedDepartmentId = '',
  selectedAgentId = '',
  organization = { departments: [], agents: [] },
  attachments = [],
  existingSession = null,
  allowCollaboration = true,
} = {}) {
  const text = String(message || '').trim();
  const explicit = routePreference === 'explicit';
  const pptIntent = classifyPptIntent(text, { attachments });
  const scores = scoreDepartments(text, organization, { pptIntent });
  const rankedDepartments = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1]);
  const matchedDepartments = rankedDepartments.map(([departmentId]) => departmentId);
  const actionCount = new Set((text.match(ACTION_TERMS) || []).map((item) => item.toLowerCase())).size;
  const researchWorkflow = RESEARCH_SOURCE_TERMS.test(text) && RESEARCH_SYNTHESIS_TERMS.test(text);
  const complexitySignals = COMPLEXITY_SIGNALS.filter((pattern) => pattern.test(text)).length;
  const attachmentWeight = Array.isArray(attachments) && attachments.length ? 1 : 0;
  const complexityScore = Math.min(10,
    (text.length >= 260 ? 2 : text.length >= 120 ? 1 : 0) +
    Math.min(3, actionCount) +
    (researchWorkflow ? 1 : 0) +
    complexitySignals * 2 +
    Math.max(0, matchedDepartments.length - 1) * 2 +
    attachmentWeight
  );
  const strongCollaboration = matchedDepartments.length >= 2 && (complexityScore >= 5 || actionCount >= 3);
  const lightweightConversation = isLightweightConversationalTurn(text, {
    attachments,
    matchedDepartments,
    actionCount,
    complexitySignals,
  });
  const generalAgentId = validAgentId('general_agent', 'general', organization);
  const establishedDepartment = (organization.departments || []).some((item) => item.id === existingSession?.departmentId);
  const establishedMode = existingSession?.departmentId === 'collaboration'
    ? 'collaboration'
    : existingSession?.departmentId === 'general'
      ? existingSession?.agentId ? 'agent' : 'normal'
      : establishedDepartment ? 'agent' : '';

  let mode = generalAgentId ? 'agent' : 'normal';
  let departmentId = generalAgentId ? 'general' : '';
  let agentId = generalAgentId;
  let rationale = generalAgentId
    ? '当前任务没有匹配到专业部门，由不隶属部门的 Generalist 负责执行。'
    : '当前没有可用的 Generalist，使用普通聊天响应。';
  let confidence = 0.72;

  if (lightweightConversation && !explicit) {
    mode = 'normal';
    departmentId = '';
    agentId = '';
    rationale = 'Lightweight greeting or acknowledgement; use plain chat for a faster response.';
    confidence = 0.98;
  } else if (explicit && selectedDepartmentId === 'collaboration') {
    mode = 'collaboration';
    rationale = '用户已显式选择部门协作，规划器保留该选择并生成跨部门任务图。';
    confidence = 1;
  } else if (explicit && (!selectedDepartmentId || selectedDepartmentId === 'general')) {
    mode = generalAgentId ? 'agent' : 'normal';
    departmentId = generalAgentId ? 'general' : '';
    agentId = generalAgentId;
    rationale = generalAgentId ? '用户选择普通聊天，由 Generalist 执行。' : '当前没有可用的 Generalist。';
    confidence = 1;
  } else if (explicit && selectedDepartmentId && selectedDepartmentId !== 'general') {
    mode = 'agent';
    departmentId = selectedDepartmentId;
    agentId = validAgentId(selectedAgentId, departmentId, organization) || chooseAgentForDepartment(departmentId, text, organization);
    rationale = '用户已显式选择专业部门，规划器按所选部门和 agent 执行。';
    confidence = 1;
  } else if (establishedMode) {
    mode = establishedMode;
    departmentId = mode === 'agent' ? existingSession.departmentId : '';
    agentId = mode === 'agent' ? existingSession.agentId || chooseAgentForDepartment(departmentId, text, organization) : '';
    rationale = '这是已有对话的后续消息，为保持上下文一致性继续使用原处理模式。';
    confidence = 0.96;
  } else if (allowCollaboration && strongCollaboration) {
    mode = 'collaboration';
    rationale = `需求同时涉及 ${matchedDepartments.length} 个专业领域并包含多个执行动作，采用部门协作以拆解依赖和最终整合。`;
    confidence = Math.min(0.95, 0.72 + matchedDepartments.length * 0.06 + complexitySignals * 0.05);
  } else if (rankedDepartments.length && (rankedDepartments[0][1] >= 2 || hasStrongDepartmentIntent(rankedDepartments[0][0], text))) {
    mode = 'agent';
    departmentId = rankedDepartments[0][0];
    agentId = chooseAgentForDepartment(departmentId, text, organization);
    rationale = `需求的主要意图集中在${departmentLabel(departmentId, organization)}，由单部门 agent 处理更直接。`;
    confidence = Math.min(0.93, 0.68 + rankedDepartments[0][1] * 0.08);
  }

  if (mode === 'agent' && !agentId) {
    mode = generalAgentId ? 'agent' : 'normal';
    departmentId = generalAgentId ? 'general' : '';
    agentId = generalAgentId;
    rationale = generalAgentId ? '对应专业 Agent 不可用，改由 Generalist 执行。' : '当前没有可路由的 Agent。';
    confidence = 0.55;
  }

  const complexity = mode === 'collaboration' || complexityScore >= 6
    ? 'complex'
    : complexityScore >= 3 ? 'moderate' : 'simple';
  const steps = planSteps({ mode, departmentId, agentId, complexity, organization, matchedDepartments });
  return {
    version: 'home_chat_planner_v1',
    mode,
    targetKind: mode === 'agent' ? 'agent' : mode,
    departmentId: mode === 'agent' ? departmentId : mode === 'collaboration' ? 'collaboration' : 'general',
    agentId: mode === 'agent' ? agentId : '',
    explicit,
    complexity,
    complexityScore,
    confidence: Number(confidence.toFixed(2)),
    rationale,
    matchedDepartments,
    signals: {
      departmentScores: scores,
      actionCount,
      researchWorkflow,
      complexitySignals,
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
      pptIntent,
    },
    title: suggestChatTitle(text, { mode, departmentId, attachments }),
    steps,
  };
}

function isLightweightConversationalTurn(text, {
  attachments = [],
  matchedDepartments = [],
  actionCount = 0,
  complexitySignals = 0,
} = {}) {
  const clean = String(text || '')
    .replace(/__JANUS_ATTACHMENT_RESOURCES__[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Boolean(clean)
    && clean.length <= 24
    && !attachments?.length
    && !matchedDepartments?.length
    && actionCount === 0
    && complexitySignals === 0
    && LIGHTWEIGHT_CONVERSATIONAL_TERMS.test(clean);
}

export function suggestChatTitle(message = '', { mode = '', departmentId = '', attachments = [] } = {}) {
  const source = String(message || '')
    .replace(/__JANUS_ATTACHMENT_RESOURCES__[\s\S]*$/i, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const attachmentName = Array.isArray(attachments)
    ? String(attachments.find((item) => item?.name || item?.filename)?.name || attachments.find((item) => item?.filename)?.filename || '').trim()
    : '';
  if (!source) return conciseTitle(attachmentName ? `分析 ${attachmentName}` : fallbackChatTitle(mode, departmentId));

  let title = source;
  const leadingFillers = [
    /^(?:你好|您好|hi|hello)[,，!！。:\s]*/i,
    /^(?:请帮我|麻烦你?|劳烦你?|能否|可否|可以帮我|帮我|我想请你|我想要|我需要|现在我需要|现在需要|想请你)[,，:：\s]*/i,
  ];
  let changed = true;
  while (changed) {
    const before = title;
    for (const pattern of leadingFillers) title = title.replace(pattern, '');
    changed = title !== before;
  }

  title = title
    .replace(/^(?:简单)?(?:介绍|解释|说明|讲解)(?:一下)?\s*/i, '')
    .replace(/^(?:写|撰写)(?:一篇|一份|一个)?\s*/i, '')
    .replace(/^(?:制作|生成|绘制|创建)(?:一份|一个|一套)?(?:主要)?(?:用|使用)?\s*/i, '')
    .replace(/^(?:将|把)\s*/i, '')
    .replace(/^(?:如图(?:所示)?的?|下面这个|以下这个)\s*/i, '')
    .replace(/(?:能不能|可以吗|行不行|谢谢|感谢)[?？!！。\s]*$/i, '')
    .trim();

  const firstSentence = title.split(/[。！？!?；;]/, 1)[0]?.trim() || title;
  const commaParts = firstSentence.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  title = commaParts.find((item) => item.length >= 4) || firstSentence;
  const colonHead = title.split(/[：:]/, 1)[0]?.trim() || '';
  if (colonHead.length >= 4) title = colonHead;
  title = title
    .replace(/中文的/u, '中文')
    .replace(/的摘要和提纲$/u, '摘要与提纲')
    .replace(/摘要和提纲$/u, '摘要与提纲')
    .replace(/是什么$/u, '')
    .replace(/(?:改成|修改为|调整为)$/u, '改版')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || /^(?:这个|那个|问题|咨询|求助|请问)$/u.test(title)) {
    title = attachmentName ? `分析 ${attachmentName}` : fallbackChatTitle(mode, departmentId);
  }
  const prefix = departmentId === 'ppt_department' && !/\b(?:ppt|pptx|幻灯片|演示)\b/i.test(title)
    ? 'PPT：'
    : mode === 'collaboration' && !/^协作[：:]/u.test(title) ? '协作：' : '';
  return conciseTitle(`${prefix}${title}`);
}

function conciseTitle(value = '') {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '新对话';
  const mostlyCjk = (clean.match(/[\u3400-\u9fff]/g) || []).length >= Math.max(2, clean.length / 3);
  const maxLength = mostlyCjk ? 24 : 64;
  if (Array.from(clean).length <= maxLength) return clean;
  const clipped = Array.from(clean).slice(0, maxLength).join('').replace(/[\s,，:：、\-]+$/u, '');
  return `${clipped}…`;
}

function fallbackChatTitle(mode = '', departmentId = '') {
  if (mode === 'collaboration' || departmentId === 'collaboration') return '部门协作任务';
  if (departmentId === 'ppt_department') return 'PPT 制作';
  if (departmentId === 'image_generation') return '图像生成';
  return '新对话';
}

function hasStrongDepartmentIntent(departmentId, text) {
  return departmentId === 'ppt_department' && classifyPptIntent(text).creation;
}

export function formatChatPlanSummary(plan, organization = { departments: [], agents: [] }) {
  if (!plan) return '正在规划执行路径';
  if (plan.mode === 'collaboration') {
    const labels = (plan.matchedDepartments || []).map((id) => departmentLabel(id, organization));
    return `计划：部门协作${labels.length ? ` · ${labels.join(' / ')}` : ''}`;
  }
  if (plan.mode === 'agent') {
    const agent = organization.agents?.find((item) => item.id === plan.agentId);
    return `计划：${departmentLabel(plan.departmentId, organization)} · ${agent?.name || plan.agentId}`;
  }
  return '计划：普通聊天 · 直接分析并回答';
}

function scoreDepartments(text, organization = { departments: [], agents: [] }, { pptIntent = null } = {}) {
  const scores = {
    ppt_department: pptIntent?.creation ? 3 : 0,
  };
  for (const department of organization.departments || []) {
    if (!department?.id || department.id === 'secretary_department' || Object.hasOwn(scores, department.id)) continue;
    const agents = (organization.agents || []).filter((agent) => agent.departmentId === department.id);
    const corpus = [department.name, department.description, ...agents.flatMap((agent) => [agent.name, agent.description, ...(agent.skills || [])])].join(' ');
    const terms = domainTerms(corpus);
    scores[department.id] = Math.min(4, terms.filter((term) => String(text || '').toLowerCase().includes(term)).length);
  }
  return scores;
}

function domainTerms(source = '') {
  const stop = new Set(['部门', 'agent', '负责', '处理', '执行', '任务', '分析', '系统', '用户', '工作', '能力', '专业', '管理', '进行', '提供']);
  const output = new Set();
  for (const token of String(source || '').toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u3400-\u9fff]{2,}/g) || []) {
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const term = token.slice(index, index + 2);
        if (!stop.has(term)) output.add(term);
      }
    } else if (!stop.has(token)) output.add(token);
  }
  return [...output].slice(0, 120);
}

function chooseAgentForDepartment(departmentId, text, organization) {
  const available = (organization.agents || []).filter((agent) => agent.departmentId === departmentId && agent.routable !== false);
  const preferred = departmentId === 'ppt_department'
    ? 'ppt'
    : departmentId === 'secretary_department' ? 'secretary_agent'
      : departmentId === 'general' ? 'general_agent' : '';
  return available.find((agent) => agent.id === preferred)?.id || available[0]?.id || '';
}

function validAgentId(agentId, departmentId, organization) {
  return (organization.agents || []).find((agent) => (
    agent.id === agentId && agent.departmentId === departmentId && agent.routable !== false
  ))?.id || '';
}

function planSteps({ mode, departmentId, agentId, complexity, organization, matchedDepartments }) {
  if (mode === 'collaboration') {
    return [
      { id: 'understand', label: '理解目标与交付物', detail: '识别任务边界、附件和成功标准', status: 'active' },
      { id: 'decompose', label: '拆解跨部门任务', detail: `为 ${(matchedDepartments || []).length || '多个'} 个领域建立依赖图`, status: 'pending' },
      { id: 'execute', label: '并行执行专业节点', detail: '调度研究、项目、论文或 PPT agent', status: 'pending' },
      { id: 'coordinate', label: '处理通信与阻塞', detail: '解决 agent 间信息请求和等待节点', status: 'pending' },
      { id: 'synthesize', label: '汇总最终交付', detail: '整合各部门结果并标注未决项', status: 'pending' },
    ];
  }
  if (mode === 'agent') {
    const agent = organization.agents?.find((item) => item.id === agentId);
    return [
      { id: 'understand', label: '理解专业需求', detail: `确认${departmentLabel(departmentId, organization)}任务边界`, status: 'active' },
      { id: 'prepare', label: '加载 Agent 上下文', detail: `读取 ${agent?.name || agentId} 的 Skill、Memory 和附件`, status: 'pending' },
      { id: 'execute', label: complexity === 'simple' ? '生成专业回答' : '分阶段执行任务', detail: '按专业工作流完成分析与内容生成', status: 'pending' },
      { id: 'deliver', label: '检查并交付', detail: departmentId === 'ppt_department' ? '验证页面结构和 PPTX 产物' : '检查完整性、边界和可执行性', status: 'pending' },
    ];
  }
  return [
    { id: 'understand', label: '理解问题', detail: '识别用户目标和必要上下文', status: 'active' },
    { id: 'execute', label: complexity === 'simple' ? '组织回答' : '分析并分阶段回答', detail: '形成清晰、直接的回复', status: 'pending' },
    { id: 'deliver', label: '完成交付', detail: '检查答案是否覆盖当前需求', status: 'pending' },
  ];
}

function departmentLabel(departmentId, organization) {
  return organization.departments?.find((item) => item.id === departmentId)?.name || ({
    secretary_department: '秘书中心',
    general: 'Generalist',
    ppt_department: 'PPT 部门',
  })[departmentId] || departmentId;
}
