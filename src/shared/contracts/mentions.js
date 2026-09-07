const PRINCIPAL_TYPES = new Set(['user', 'ubuddy', 'agent', 'organization', 'plugin', 'skill', 'group_audience']);

export const GROUP_MENTION_AUDIENCES = Object.freeze({
  HUMAN_MEMBERS: 'human_members',
  MEMBER_UBUDDIES: 'member_ubuddies',
});

export const UBUDDY_ORGANIZATION_AUDIENCE_VERSION = 'ubuddy_organization_audience_v1';
export const UBUDDY_ORGANIZATION_AUDIENCE_ALL_MEMBERS = 'all_members';

export const UBUDDY_MENTION_SELECTION_VERSION = 'ubuddy_mention_selection_v1';
export const UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION = 'ubuddy_participant_selection_policy_v1';
export const UBUDDY_PARTICIPANT_SELECTION_POLICIES = Object.freeze({
  ALL_MENTIONED: 'all_mentioned',
  AUTO_SELECT: 'auto_select',
});
export const UBUDDY_MENTION_SELECTION_MODES = Object.freeze([
  'candidate_pool',
  'all_selected',
  'explicit_single',
]);

export const UBUDDY_MULTI_MENTION_VERSION = 'ubuddy_multi_mention_v1';

const MULTI_MENTION_FORMAL_WORK = /(?:创建|建立|发起|派发|分配|开始|执行|负责|完成|制作|做一份|写一份|写|撰写|整理|分析|生成|绘制|编写|准备|处理|交付|调研|汇报|总结|检查|测试|修复|开发|设计|翻译|输出|提交|复习|文档|报告|方案|代码|文件|表格|ppt|pptx|演示文稿|项目|任务)/i;
const MULTI_MENTION_SIMPLE_MESSAGE = /^(?:(?:大家|你们|各位)?\s*(?:好|你好|您好|在吗|在线吗|收到吗|看到了吗|能看到吗|听到了吗|有空吗|辛苦了)[？?。.！!\s]*|(?:请)?\s*(?:提醒|通知|转告|告诉).{0,80}|.{0,48}(?:当前状态|现在状态|进度如何|进展如何|是否收到|有没有收到|能否收到|什么时候|几点|多少|是什么|是不是|可以吗|能否|可否|吗)[？?。.！!\s]*)$/i;

export function createPickerMentionEntity({ principalType = 'user', userId = '', ownerUserId = '', agentId = '', agentInstanceId = '', organizationId = '', pluginId = '', skillId = '', audience = '', displayText = '', mentionId = '' } = {}) {
  const type = String(principalType || '').trim().toLowerCase();
  const entity = {
    principalType: PRINCIPAL_TYPES.has(type) ? type : 'user',
    userId: type === 'user' ? String(userId || ownerUserId || '').trim() : '',
    ownerUserId: type === 'ubuddy' ? String(ownerUserId || userId || '').trim() : '',
    agentId: type === 'agent' ? String(agentId || '').trim() : '',
    agentInstanceId: type === 'agent' ? String(agentInstanceId || '').trim() : '',
    organizationId: type === 'organization' ? String(organizationId || '').trim() : '',
    pluginId: type === 'plugin' ? String(pluginId || '').trim() : '',
    skillId: type === 'skill' ? String(skillId || '').trim() : '',
    audience: type === 'organization'
      ? String(audience || UBUDDY_ORGANIZATION_AUDIENCE_ALL_MEMBERS).trim()
      : type === 'group_audience' ? String(audience || '').trim() : '',
    displayText: String(displayText || '').trim(),
    mentionId: String(mentionId || `mention_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).trim(),
    source: 'picker',
  };
  return normalizeMentionEntity(entity);
}

export function normalizeMentionEntity(value = {}, { requirePicker = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const principalType = String(value.principalType || value.principal_type || '').trim().toLowerCase();
  if (!PRINCIPAL_TYPES.has(principalType)) return null;
  const userId = principalType === 'user'
    ? String(value.userId || value.user_id || '').trim()
    : '';
  const ownerUserId = principalType === 'ubuddy'
    ? String(value.ownerUserId || value.owner_user_id || '').trim()
    : '';
  const agentId = principalType === 'agent'
    ? String(value.agentId || value.agent_id || '').trim()
    : '';
  const agentInstanceId = principalType === 'agent'
    ? String(value.agentInstanceId || value.agent_instance_id || '').trim()
    : '';
  const organizationId = principalType === 'organization'
    ? String(value.organizationId || value.organization_id || '').trim()
    : '';
  const pluginId = principalType === 'plugin'
    ? String(value.pluginId || value.plugin_id || '').trim()
    : '';
  const skillId = principalType === 'skill'
    ? String(value.skillId || value.skill_id || '').trim()
    : '';
  const audience = ['organization', 'group_audience'].includes(principalType)
    ? String(value.audience || '').trim().toLowerCase()
    : '';
  const displayText = String(value.displayText || value.display_text || value.token || '').trim();
  const mentionId = String(value.mentionId || value.mention_id || '').trim();
  const source = String(value.source || '').trim().toLowerCase();
  const groupAudience = principalType === 'group_audience' && Object.values(GROUP_MENTION_AUDIENCES).includes(audience);
  if (!(userId || ownerUserId || agentId || agentInstanceId || organizationId || pluginId || skillId || groupAudience) || !displayText || !mentionId) return null;
  if (principalType === 'organization' && audience !== UBUDDY_ORGANIZATION_AUDIENCE_ALL_MEMBERS) return null;
  if (requirePicker && source !== 'picker') return null;
  return {
    principalType,
    userId,
    ownerUserId,
    agentId,
    agentInstanceId,
    organizationId,
    pluginId,
    skillId,
    audience,
    displayText,
    mentionId,
    source: source || 'picker',
  };
}

export function normalizeMentionEntities(values = [], { content = null, requirePicker = true, allowedUserIds = null } = {}) {
  const allowed = allowedUserIds == null ? null : new Set([...allowedUserIds].map((item) => String(item || '').trim()).filter(Boolean));
  const text = content == null ? null : String(content || '');
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const entity = normalizeMentionEntity(value, { requirePicker });
    if (!entity) continue;
    const principalId = entity.userId || entity.ownerUserId || entity.agentInstanceId || entity.agentId || entity.organizationId || entity.pluginId || entity.skillId || entity.audience;
    if (allowed && !['agent', 'plugin', 'skill', 'group_audience'].includes(entity.principalType) && !allowed.has(principalId)) continue;
    if (text != null && !text.includes(entity.displayText)) continue;
    const key = `${entity.principalType}:${principalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entity);
  }
  return result;
}

export function mentionPrincipalId(entity = {}) {
  return String(entity.userId || entity.ownerUserId || entity.agentInstanceId || entity.agentId || entity.organizationId || entity.pluginId || entity.skillId || entity.audience || '').trim();
}

export function multiMentionTargetUserIds(mentions = [], {
  content = null,
  currentUserId = '',
  source = 'secretary_chat',
  requirePicker = true,
} = {}) {
  const normalized = normalizeMentionEntities(mentions, { content, requirePicker });
  const current = String(currentUserId || '').trim();
  const groupSource = source === 'natural_chat_group';
  return [...new Set(normalized.map((mention) => {
    if (groupSource) return mention.principalType === 'ubuddy' ? mention.ownerUserId : '';
    if (mention.principalType === 'user') return mention.userId;
    return mention.principalType === 'ubuddy' ? mention.ownerUserId : '';
  }).map((item) => String(item || '').trim()).filter((item) => item && item !== current))];
}

export function classifyMultiMentionTrigger({
  content = '',
  mentions = [],
  currentUserId = '',
  source = 'secretary_chat',
  attachmentCount = 0,
} = {}) {
  const targetUserIds = multiMentionTargetUserIds(mentions, {
    content,
    currentUserId,
    source,
    requirePicker: true,
  });
  if (targetUserIds.length < 2) {
    return {
      version: UBUDDY_MULTI_MENTION_VERSION,
      classification: 'none',
      targetUserIds,
      reasonCode: 'fewer_than_two_targets',
    };
  }
  const normalizedMentions = normalizeMentionEntities(mentions, { content, requirePicker: true });
  const instruction = normalizedMentions.reduce((text, mention) => (
    mention.displayText ? text.replaceAll(mention.displayText, '') : text
  ), String(content || '')).replace(/\s+/g, ' ').trim();
  const clearlySimple = Number(attachmentCount || 0) === 0
    && !MULTI_MENTION_FORMAL_WORK.test(instruction)
    && MULTI_MENTION_SIMPLE_MESSAGE.test(instruction);
  const explicitTask = MULTI_MENTION_FORMAL_WORK.test(instruction);
  return {
    version: UBUDDY_MULTI_MENTION_VERSION,
    classification: clearlySimple ? 'simple_message' : explicitTask ? 'multi_task' : 'none',
    targetUserIds,
    reasonCode: clearlySimple ? 'clearly_simple_multi_mention'
      : explicitTask ? 'explicit_multi_mention_task' : 'multi_mention_context_only',
  };
}

export function hasExplicitDelegationIntent({ content = '', mentions = [] } = {}) {
  const normalizedMentions = normalizeMentionEntities(mentions, { content, requirePicker: true });
  const instruction = normalizedMentions.reduce((text, mention) => (
    mention.displayText ? text.replaceAll(mention.displayText, '') : text
  ), String(content || '')).replace(/\s+/g, ' ').trim();
  return MULTI_MENTION_FORMAL_WORK.test(instruction);
}

export function mentionDeletionRange({ value = '', tokens = [], key = '', selectionStart = 0, selectionEnd = selectionStart } = {}) {
  if (!['Backspace', 'Delete'].includes(key)) return null;
  const ranges = mentionTokenRanges(value, tokens);
  let start = Math.max(0, Number(selectionStart) || 0);
  let end = Math.max(start, Number(selectionEnd) || start);
  if (start === end) {
    const targetIndex = key === 'Backspace' ? start - 1 : start;
    return ranges.find((item) => item.start <= targetIndex && targetIndex < item.end) || null;
  }
  const intersecting = ranges.filter((item) => item.start < end && item.end > start);
  if (!intersecting.length) return null;
  start = Math.min(start, ...intersecting.map((item) => item.start));
  end = Math.max(end, ...intersecting.map((item) => item.end));
  return { start, end };
}

export function mentionTokenRanges(value = '', tokens = []) {
  const source = String(value || '');
  const normalizedTokens = [...new Set((Array.isArray(tokens) ? tokens : [])
    .map((item) => String(item || '').trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  const ranges = [];
  let cursor = 0;
  while (cursor < source.length) {
    const token = normalizedTokens.find((candidate) => source.startsWith(candidate, cursor));
    if (!token) {
      cursor += 1;
      continue;
    }
    ranges.push({ start: cursor, end: cursor + token.length });
    cursor += token.length;
  }
  return ranges;
}

export function normalizeMentionSelectionContext({
  mentions = [],
  content = '',
  requiredUserIds = [],
  resolvedCandidateUserIds = null,
  participantSelectionPolicyVersion = '',
  participantSelectionPolicy = '',
  requirePicker = true,
} = {}) {
  const normalizedMentions = normalizeMentionEntities(mentions, { content, requirePicker });
  const candidateUserIds = [...new Set((Array.isArray(resolvedCandidateUserIds)
    ? resolvedCandidateUserIds
    : normalizedMentions
      .filter((item) => ['user', 'ubuddy'].includes(item.principalType))
      .map(mentionPrincipalId))
    .map((item) => String(item || '').trim()).filter(Boolean))];
  const candidateSet = new Set(candidateUserIds);
  const explicitRequired = [...new Set((Array.isArray(requiredUserIds) ? requiredUserIds : [])
    .map((item) => String(item || '').trim()).filter((item) => candidateSet.has(item)))];
  const explicitAllSelected = participantSelectionPolicyVersion === UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION
    && participantSelectionPolicy === UBUDDY_PARTICIPANT_SELECTION_POLICIES.ALL_MENTIONED;
  const selectionMode = candidateUserIds.length === 1
    ? 'explicit_single'
    : candidateUserIds.length > 1 && explicitAllSelected
      ? 'all_selected'
      : 'candidate_pool';
  const normalizedRequired = selectionMode === 'explicit_single' || selectionMode === 'all_selected'
    ? [...candidateUserIds]
    : explicitRequired;
  return {
    version: UBUDDY_MENTION_SELECTION_VERSION,
    participantSelectionPolicyVersion: UBUDDY_PARTICIPANT_SELECTION_POLICY_VERSION,
    participantSelectionPolicy: explicitAllSelected
      ? UBUDDY_PARTICIPANT_SELECTION_POLICIES.ALL_MENTIONED
      : UBUDDY_PARTICIPANT_SELECTION_POLICIES.AUTO_SELECT,
    selectionMode,
    candidateUserIds,
    requiredUserIds: normalizedRequired,
  };
}
