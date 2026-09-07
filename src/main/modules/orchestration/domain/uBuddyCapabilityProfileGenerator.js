import crypto from 'node:crypto';

import {
  normalizeUBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../../../../shared/contracts/uBuddyCapabilityProfile.js';

export const UBUDDY_CAPABILITY_PROFILE_GENERATOR_VERSION = 'ubuddy_profile_preview_generator_v1';

const CAPABILITY_RULES = Object.freeze([
  rule(/task intake|actionable brief|objective|requirements?|constraints?|deliverables?|需求|目标|约束|交付物|任务收集|任务澄清/i,
    '任务澄清与需求整理', '需求整理', '把口头需求整理为目标、约束、交付物和验收要点。', ['document']),
  rule(/context(?:ual)? intent|recent conversation|resolve references|whole sentence|上下文|指代|意图理解/i,
    '上下文意图理解', '意图理解', '结合当前上下文理解指代、版本和真实操作意图。', ['answer']),
  rule(/summar(?:y|ies|ize)|rewrite|meeting notes?|requirement documents?|checklists?|文档|总结|改写|会议纪要|清单/i,
    '信息整理与文档起草', '文档整理', '整理摘要、说明、需求文档、会议纪要和检查清单。', ['document', 'report']),
  rule(/ordinary questions?|direct handling|bounded analysis|research|问答|轻量分析|研究/i,
    '直接问答与轻量分析', '分析与问答', '处理职责范围内的问答、研究整理和轻量分析。', ['answer', 'report']),
  rule(/delegat(?:e|ion)|coordinate|routing|task graph|multi-agent|分派|委托|协调|路由|多.?Agent/i,
    '任务分派与协作协调', '协作协调', '选择合适的执行者并协调单 Agent 或多 Agent 任务。', ['report']),
  rule(/cross-user|another account|recipient|requester|跨用户|其他用户|接收方|委托方/i,
    '跨用户委托协调', '跨用户协作', '整理并跟进经确认的跨用户委托。', ['document']),
  rule(/track ownership|status reports?|progress|follow-up|pending decisions?|进度|状态汇报|跟进|待决策/i,
    '进度跟踪与状态汇报', '进度跟踪', '跟踪负责人、依赖、阻塞和下一步决策。', ['report']),
  rule(/result-version|latest valid result|correct\/latest version|superseded|结果版本|最新结果|正确结果|版本管理/i,
    '结果版本管理', '版本控制', '识别当前有效结果并避免提交失败、过期或错误版本。', ['document']),
  rule(/failure recovery|blocked|blocker|timeout|失败恢复|阻塞|超时/i,
    '失败恢复与阻塞说明', '失败恢复', '在失败或阻塞时保留上下文并给出可执行的恢复路径。', ['report']),
  rule(/\bfiles?\b|\bworkspace\b|\bproject work\b|\bartifact\b|文件|工作区|项目/i,
    '受控文件与项目工作', '文件工作', '在有效工作区和明确边界内处理低风险文件任务。', ['document']),
  rule(/presentations?|slides?|pptx?|演示文稿|幻灯片/i,
    '演示文稿任务协调', '演示文稿', '协调演示文稿的内容准备、制作与验收。', ['presentation']),
  rule(/spreadsheets?|excel|csv|表格/i,
    '表格任务协调', '表格', '协调结构化表格的整理、生成与校验。', ['spreadsheet']),
  rule(/\bcode\b|\bcoding\b|\brepository\b|\bsoftware\b|代码|仓库|软件/i,
    '代码任务协调', '代码协作', '协调代码修改、验证和交付。', ['code_change']),
  rule(/images?|visuals?|design|图片|图像|视觉|设计/i,
    '图像与视觉任务协调', '视觉内容', '协调图像或视觉类产物的生成与验收。', ['image']),
  rule(/translat(?:e|ion)|翻译/i,
    '翻译与语言转换', '翻译', '处理明确范围内的翻译与语言转换。', ['document']),
  rule(/publish|publication|submit|share|对外|发布|提交|共享/i,
    '经确认的结果提交', '提交控制', '在所有者确认后提交或共享已验证的有效结果。', ['document']),
  rule(/privacy|confidential|credentials?|private conversations?|隐私|保密|凭据|私聊/i,
    '隐私边界控制', '隐私保护', '按批准的接收方和目的最小化披露信息。', []),
]);

export function generateUBuddyCapabilityProfile({
  ownerUserId = '', userId = '', uBuddyAgentInstanceId = '', profileRevision = 1,
  effectiveSkill = '', effectiveSkillHash = '', sourceEffectiveSkillHash = '', now = new Date(),
} = {}) {
  const skill = String(effectiveSkill || '').trim();
  if (!skill) throw generationError('ubuddy_profile_effective_skill_missing');
  const matches = CAPABILITY_RULES.filter((item) => item.pattern.test(skill));
  const taskTypes = unique(matches.map((item) => item.taskType), 10);
  if (taskTypes.length < 2) throw generationError('ubuddy_profile_skill_evidence_insufficient');
  const capabilityTags = unique(matches.map((item) => item.tag), 12);
  const preferredTasks = unique(matches.map((item) => item.preferred), 8);
  const deliverableTypes = unique(matches.flatMap((item) => item.deliverables), 7);
  const collaborationModes = collaborationModesForSkill(skill);
  const unsupportedTasks = unsupportedTasksForSkill(skill);
  const privacyConstraints = privacyConstraintsForSkill(skill);
  const computedSkillHash = sha256(skill);
  const suppliedSkillHash = cleanHash(effectiveSkillHash || sourceEffectiveSkillHash);
  const skillHash = suppliedSkillHash === computedSkillHash ? suppliedSkillHash : computedSkillHash;
  const profile = normalizeUBuddyCapabilityProfile({
    ownerUserId: ownerUserId || userId,
    uBuddyAgentInstanceId,
    profileRevision,
    introduction: `我的 uBuddy 是专业私人秘书与任务协调入口，擅长${joinChinese(taskTypes.slice(0, 4))}，并遵守确认、隐私与真实状态边界。`,
    supportedTaskTypes: taskTypes,
    deliverableTypes,
    capabilityTags,
    preferredTasks,
    unsupportedTasks,
    improvementDirections: improvementDirectionsForSkill(skill),
    collaborationModes,
    privacyConstraints,
    evidenceSummary: `当前有效 Skill 可验证地覆盖${joinChinese(taskTypes.slice(0, 6))}；同时规定${joinChinese(collaborationModes.slice(0, 4))}，并要求保护私有信息、核验结果状态和避免未经确认的对外承诺。`,
    sourceEffectiveSkillHash: skillHash,
    visibility: 'private',
    publicationState: 'draft',
    generatedAt: validDate(now).toISOString(),
  });
  validateUBuddyCapabilityProfile(profile, { throwOnError: true });
  return profile;
}

export function fallbackUBuddyCapabilityProfile({
  ownerUserId = '', uBuddyAgentInstanceId = '', effectiveSkillHash = '', now = new Date(),
} = {}) {
  const profile = normalizeUBuddyCapabilityProfile({
    ownerUserId,
    uBuddyAgentInstanceId,
    profileRevision: 1,
    introduction: '我的 uBuddy 是专业私人秘书与任务协调入口，可帮助整理需求、协调执行并跟进结果。',
    supportedTaskTypes: ['任务澄清与需求整理', '任务分派与协作协调', '进度跟踪与状态汇报'],
    deliverableTypes: ['answer', 'report', 'document'],
    capabilityTags: ['需求整理', '协作协调', '进度跟踪', '隐私保护'],
    preferredTasks: ['把口头需求整理为清晰任务。', '协调合适的执行者并跟进结果。'],
    unsupportedTasks: ['未经确认的对外发布、正式承诺或信息共享。', '要求披露私有信息、凭据或未发布材料的任务。'],
    improvementDirections: ['扩大经有效 Skill 明确验证的专业任务覆盖。', '提升复杂任务路由、状态核验和交付验收的一致性。'],
    collaborationModes: ['uBuddy 直接处理', '转交单个 specialist Agent', '协调多 Agent 任务'],
    privacyConstraints: ['简介仅根据当前有效 Skill 生成，不读取私有 Memory、私聊或附件内容。', '对外共享前需要所有者明确确认。'],
    evidenceSummary: '完整简介暂时无法生成；当前显示不含私有内容的基础能力说明。',
    sourceEffectiveSkillHash: cleanHash(effectiveSkillHash) || sha256(''),
    visibility: 'private',
    publicationState: 'draft',
    generatedAt: validDate(now).toISOString(),
  });
  validateUBuddyCapabilityProfile(profile, { throwOnError: true });
  return profile;
}

function collaborationModesForSkill(skill) {
  const modes = [];
  if (/direct handling|handle .* yourself|直接处理|默认直接/i.test(skill)) modes.push('uBuddy 直接处理');
  if (/specialist Agent|single Agent|单 Agent|专业 Agent/i.test(skill)) modes.push('转交单个 specialist Agent');
  if (/task graph|multi-Agent|多.?Agent|协作任务/i.test(skill)) modes.push('协调多 Agent 任务');
  if (/cross-user|another account|跨用户|其他用户/i.test(skill)) modes.push('经确认的跨用户委托');
  if (/task-group|shared file workspace|任务群|共享文件工作区/i.test(skill)) modes.push('任务群共享工作区协作');
  return unique(modes.length ? modes : ['uBuddy 直接处理', '转交合适的 Agent'], 8);
}

function unsupportedTasksForSkill(skill) {
  const items = [];
  if (/unsupported calendar|unsupported .*messaging|Do not claim unsupported|不得虚构|不支持的.*操作/i.test(skill)) {
    items.push('系统未明确支持或无法验证结果的日历、消息、文件和执行操作。');
  }
  if (/explicit confirmation|confirmed action|owner.*confirm|未经.*确认|明确确认/i.test(skill)) {
    items.push('未经所有者明确确认的对外发布、正式承诺或结果提交。');
  }
  if (/specialist.*pipeline|specialist.*contract|专用.*管线|专业产物/i.test(skill)) {
    items.push('需要专用专业产物管线且不应由 uBuddy 直接冒充完成的任务。');
  }
  if (/no project workspace|select\/create a project|缺少.*工作区|没有.*工作区/i.test(skill)) {
    items.push('缺少有效项目工作区时的本地文件创建或修改。');
  }
  if (/private conversations?|personal Memory|credentials?|unpublished|私聊|私有 Memory|凭据|未发布/i.test(skill)) {
    items.push('要求披露私有对话、Memory、凭据、未发布材料或无关本地信息的任务。');
  }
  return unique(items.length ? items : ['超出已验证能力边界且无法安全转交的任务。'], 8);
}

function privacyConstraintsForSkill(skill) {
  const items = ['简介仅根据当前有效 Skill 生成，不读取私有 Memory、私聊或附件内容。'];
  if (/necessary .* approved recipient|minimi[sz]e disclosure|披露.*必要|接收方|目的/i.test(skill)) {
    items.push('仅向获批接收方披露完成任务所必需的信息。');
  }
  if (/explicit confirmation|confirmed action|明确确认|确认后/i.test(skill)) {
    items.push('对外发布、正式承诺和共享结果前需要所有者明确确认。');
  }
  if (/absolute paths?|credentials?|execution logs?|model internals?|绝对路径|凭据|执行日志|模型内部/i.test(skill)) {
    items.push('不公开本地绝对路径、凭据、未发布材料或内部执行信息。');
  }
  return unique(items, 8);
}

function improvementDirectionsForSkill(skill) {
  const items = ['扩大经有效 Skill 明确验证的专业任务覆盖。'];
  if (/clarif|missing information|澄清|缺失信息/i.test(skill)) items.push('减少不必要澄清，同时保持关键约束完整。');
  if (/routing|delegate|task graph|路由|分派|委托|协作/i.test(skill)) items.push('提升复杂任务路由和执行者匹配的一致性。');
  if (/verify|truthful status|result-version|核验|真实状态|结果版本/i.test(skill)) items.push('继续提高状态核验和有效结果选择的准确性。');
  return unique(items, 6);
}

function rule(pattern, taskType, tag, preferred, deliverables) {
  return { pattern, taskType, tag, preferred, deliverables };
}

function generationError(code) {
  const error = new Error('uBuddy capability Profile generation failed.');
  error.code = code;
  return error;
}

function unique(values = [], maximum = 24) {
  return [...new Set(values.filter(Boolean))].slice(0, maximum);
}

function joinChinese(values = []) {
  if (values.length < 2) return values[0] || '任务整理与协调';
  return values.length === 2 ? `${values[0]}和${values[1]}` : `${values.slice(0, -1).join('、')}以及${values.at(-1)}`;
}

function cleanHash(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(text) ? text : '';
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}
