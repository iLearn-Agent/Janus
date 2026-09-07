export const PPT_AGENT_ID = 'ppt';

export const PPT_STYLE_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'general',
    label: '通用PPT',
    description: '不指定固定风格，按主题、听众和模板生成通用演示文稿。',
  }),
  Object.freeze({
    id: 'academic_report',
    label: '学术汇报风',
    description: '面向课程汇报、论文讲解和技术科普，突出清晰结构、严谨方法与证据链条。',
  }),
  Object.freeze({
    id: 'major_project',
    label: '重大项目风',
    description: '面向项目申报、实施方案、阶段评审和验收汇报，突出目标、技术路线、交付成果与风险控制。',
  }),
]);

export const LEGACY_PPT_AGENT_STYLE_MAP = Object.freeze({
  ppt: 'general',
  ppt_academic_report: 'academic_report',
  ppt_major_project: 'major_project',
  ppt_research_scout: 'general',
});

export const LEGACY_PPT_AGENT_IDS = Object.freeze([
  'ppt_academic_report',
  'ppt_major_project',
  'ppt_research_scout',
]);

const PPT_STYLE_IDS = new Set(PPT_STYLE_OPTIONS.map((item) => item.id));

export function normalizePptStyleId(value = '') {
  const id = String(value || '').trim();
  if (PPT_STYLE_IDS.has(id)) return id;
  return LEGACY_PPT_AGENT_STYLE_MAP[id] || 'general';
}

export function pptStyleForAgentId(agentId = '') {
  return normalizePptStyleId(LEGACY_PPT_AGENT_STYLE_MAP[String(agentId || '').trim()] || 'general');
}

export function canonicalPptAgentId(agentId = '') {
  const id = String(agentId || '').trim();
  return Object.hasOwn(LEGACY_PPT_AGENT_STYLE_MAP, id) ? PPT_AGENT_ID : id;
}

export function isLegacyPptAgentId(agentId = '') {
  return LEGACY_PPT_AGENT_IDS.includes(String(agentId || '').trim());
}

export function pptStyleOption(styleId = '') {
  const normalized = normalizePptStyleId(styleId);
  return PPT_STYLE_OPTIONS.find((item) => item.id === normalized) || PPT_STYLE_OPTIONS[0];
}

export function pptStyleFromConversation({ session = null, messages = [] } = {}) {
  for (let index = (Array.isArray(messages) ? messages.length : 0) - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata || {};
    const selected = metadata.pptStyleId
      || metadata.ppt_style_id
      || metadata.pptContext?.styleId
      || metadata.ppt_context?.style_id;
    if (selected) return normalizePptStyleId(selected);
  }
  return pptStyleForAgentId(session?.agentId || session?.agent_id || 'ppt');
}
