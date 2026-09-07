import { normalizeUBuddyCapabilityProfile } from '../../../../shared/contracts/uBuddyCapabilityProfile.js';
import {
  UBUDDY_PEER_ROUTING_SHADOW_VERSION,
  validateUBuddyPeerRoutingShadowDecision,
} from '../../../../shared/contracts/uBuddyPeerRoutingShadow.js';
import { classifyTaskType } from './taskExecutionMetrics.js';

export const UBUDDY_PEER_ROUTING_SHADOW_STRATEGY_VERSION = UBUDDY_PEER_ROUTING_SHADOW_VERSION;

const SCORE_WEIGHTS = Object.freeze({
  taskType: 25,
  deliverable: 20,
  capability: 15,
  collaboration: 10,
  freshness: 10,
  publicLoad: 10,
  singlePerson: 10,
  unsupportedPenalty: -40,
});

const DELIVERABLE_ALIASES = Object.freeze({
  answer: ['answer', 'qa', '问答', '回答', '答复'],
  report: ['report', '报告', '调研', '分析'],
  document: ['document', 'doc', '文档', '说明', '方案'],
  presentation: ['presentation', 'ppt', 'pptx', 'slides', '演示文稿', '幻灯片'],
  spreadsheet: ['spreadsheet', 'excel', 'xlsx', 'csv', '表格'],
  image: ['image', 'picture', 'visual', '图片', '图像', '视觉'],
  code_change: ['code', 'code change', 'repository', '代码', '仓库', '修复', '实现'],
});

const TASK_TYPE_ALIASES = Object.freeze({
  code_change: ['code_change', 'code', 'coding', 'repository', 'software', '代码', '仓库', '开发', '修复', '实现'],
  file_generation: ['file_generation', 'file', 'document', 'report', 'spreadsheet', 'presentation', '文件', '文档', '报告', '表格', '演示文稿'],
  command_execution: ['command_execution', 'command', 'shell', 'build', 'deploy', '命令', '脚本', '构建', '部署'],
  research: ['research', 'investigate', 'survey', '调研', '研究', '检索'],
  explanation: ['explanation', 'explain', 'describe', '解释', '说明', '原理'],
  collaboration: ['collaboration', 'coordinate', 'multi-agent', '协作', '协调', '多agent'],
  qa: ['qa', 'answer', 'question', '问答', '回答'],
});

const CAPABILITY_RULES = Object.freeze([
  ['code', /\b(?:code|coding|repository|repo|software|api|javascript|typescript|python)\b|代码|仓库|开发|修复|重构|实现/i],
  ['research', /\b(?:research|investigate|survey|search)\b|调研|研究|检索|调查/i],
  ['document', /\b(?:document|report|writing|summary)\b|文档|报告|写作|总结|方案/i],
  ['presentation', /\b(?:presentation|pptx?|slides?)\b|演示文稿|幻灯片/i],
  ['spreadsheet', /\b(?:spreadsheet|excel|xlsx|csv)\b|表格/i],
  ['image', /\b(?:image|visual|design|picture)\b|图片|图像|视觉|设计/i],
  ['translation', /\b(?:translate|translation)\b|翻译/i],
  ['coordination', /\b(?:coordinate|coordination|collaboration|multi-agent)\b|协调|协作|分派|委托|多.?agent/i],
  ['analysis', /\b(?:analysis|analyze|explain)\b|分析|解释|说明/i],
]);

const COLLABORATION_RULES = Object.freeze([
  ['single', /\b(?:single|one person|individual)\b|单人|一个人|单个/i],
  ['multi', /\b(?:multi-agent|team|collaboration|coordinate)\b|多人|团队|协作|协调|多.?agent/i],
  ['cross_user', /\b(?:cross-user|external delegation|another user)\b|跨用户|外部委托|其他用户/i],
]);

const TOKEN_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with',
  'agent', 'ubuddy', 'task', 'user', 'please', '需要', '请帮', '帮我', '一个', '一份', '进行', '完成', '任务', '用户', '协作',
]);

export function buildUBuddyPeerCapabilityCatalog({
  candidateUserIds = [], profileItems = [], publicAvailabilityByUserId = {}, now = new Date(),
} = {}) {
  const candidateIds = uniqueIds(candidateUserIds);
  const profiles = new Map((Array.isArray(profileItems) ? profileItems : []).map((item) => {
    const profile = normalizeUBuddyCapabilityProfile(item?.profile || item);
    return [String(item?.ownerUserId || profile.ownerUserId || ''), { item, profile }];
  }).filter(([userId]) => candidateIds.includes(userId)));
  const catalog = candidateIds.map((userId) => {
    const entry = profiles.get(userId);
    const profile = entry?.profile || null;
    const profileAvailable = Boolean(profile?.ownerUserId && profile.publicationState === 'active'
      && ['friends', 'organization'].includes(profile.visibility));
    const availability = normalizePublicAvailability(publicAvailabilityByUserId?.[userId]
      || entry?.item?.publicAvailability || entry?.item?.availability || entry?.item?.publicStatus);
    const updatedAt = profileAvailable
      ? validIso(profile.publishedAt || profile.generatedAt || entry?.item?.fetchedAt)
      : '';
    return Object.freeze({
      userId,
      profileAvailable,
      profileRevision: profileAvailable ? Math.max(0, Number(profile.profileRevision || 0)) : 0,
      profileUpdatedAt: updatedAt,
      contentHash: profileAvailable ? cleanHash(entry?.item?.contentHash || profile.sourceEffectiveSkillHash) : '',
      publicAvailability: availability.status,
      publicLoad: availability.load,
      profile: profileAvailable ? Object.freeze({
        introduction: profile.introduction,
        supportedTaskTypes: Object.freeze([...profile.supportedTaskTypes]),
        deliverableTypes: Object.freeze([...profile.deliverableTypes]),
        capabilityTags: Object.freeze([...profile.capabilityTags]),
        preferredTasks: Object.freeze([...profile.preferredTasks]),
        unsupportedTasks: Object.freeze([...profile.unsupportedTasks]),
        collaborationModes: Object.freeze([...profile.collaborationModes]),
      }) : null,
      evaluatedAt: validDate(now).toISOString(),
    });
  });
  return Object.freeze(catalog);
}

export function scoreUBuddyPeerCandidates({ catalog = [], intake = {}, now = new Date() } = {}) {
  const requirements = buildRequirements(intake);
  return (Array.isArray(catalog) ? catalog : []).map((candidate) => scoreCandidate(candidate, requirements, now));
}

export function selectShadowRecipients({ scores = [], intake = {} } = {}) {
  const requiredUserIds = uniqueIds(intake?.requiredUserIds || intake?.requiredUsers?.map((item) => item?.userId));
  const scoreByUserId = new Map(scores.map((item) => [item.userId, item]));
  const selected = requiredUserIds.filter((userId) => scoreByUserId.has(userId));
  const selectedSet = new Set(selected);
  const requirements = buildRequirements(intake);
  const requirementKeys = new Set(requirements.coverageKeys);
  const covered = new Set(selected.flatMap((userId) => scoreByUserId.get(userId)?.coverageKeys || []));
  const eligible = scores.filter((item) => item.eligible && !selectedSet.has(item.userId));
  const single = eligible.filter((item) => item.totalScore >= 65
    && [...requirementKeys].every((key) => item.coverageKeys.includes(key)))
    .sort(scoreSort)[0];
  let selectionReason = '';
  if (!selected.length && single) {
    selected.push(single.userId);
    selectedSet.add(single.userId);
    single.coverageKeys.forEach((key) => covered.add(key));
    selectionReason = 'single_candidate_full_coverage';
  } else {
    while ([...requirementKeys].some((key) => !covered.has(key))) {
      const next = eligible.filter((item) => !selectedSet.has(item.userId)).map((item) => ({
        item,
        newCoverage: item.coverageKeys.filter((key) => requirementKeys.has(key) && !covered.has(key)).length,
      })).filter((entry) => entry.newCoverage > 0).sort((left, right) => (
        right.newCoverage - left.newCoverage || scoreSort(left.item, right.item)
      ))[0]?.item;
      if (!next) break;
      selected.push(next.userId);
      selectedSet.add(next.userId);
      next.coverageKeys.forEach((key) => covered.add(key));
    }
    selectionReason = selected.length
      ? requiredUserIds.length ? 'required_candidates_preserved_then_minimum_coverage' : 'greedy_minimum_coverage'
      : 'no_eligible_candidate';
  }
  const rejectedCandidates = scores.filter((item) => !selectedSet.has(item.userId)).map((item) => ({
    userId: item.userId,
    reasonCodes: item.reasonCodes.length ? item.reasonCodes : ['not_needed_for_minimum_coverage'],
  }));
  const coverageRatio = requirementKeys.size
    ? [...requirementKeys].filter((key) => covered.has(key)).length / requirementKeys.size
    : selected.length ? 1 : 0;
  const selectedScores = selected.map((userId) => scoreByUserId.get(userId)?.totalScore || 0);
  const rejectedScores = rejectedCandidates.map((item) => scoreByUserId.get(item.userId)?.totalScore || 0);
  const average = selectedScores.length ? selectedScores.reduce((sum, value) => sum + value, 0) / selectedScores.length / 100 : 0;
  const margin = selectedScores.length
    ? clamp(((Math.min(...selectedScores) - (rejectedScores.length ? Math.max(...rejectedScores) : 0)) + 100) / 200, 0, 1)
    : 0;
  const requiredMissingProfile = selected.some((userId) => requiredUserIds.includes(userId) && !scoreByUserId.get(userId)?.profileAvailable);
  const confidence = selected.length
    ? clamp(0.5 * coverageRatio + 0.3 * average + 0.2 * margin - (requiredMissingProfile ? 0.15 : 0), 0, 1)
    : 0;
  return { selectedRecipients: selected, rejectedCandidates, selectionReason, confidence };
}

export function evaluateUBuddyPeerRoutingShadow({
  candidateUserIds = [], profileItems = [], publicAvailabilityByUserId = {}, intake = {}, now = new Date(),
} = {}) {
  const catalog = buildUBuddyPeerCapabilityCatalog({ candidateUserIds, profileItems, publicAvailabilityByUserId, now });
  const scores = scoreUBuddyPeerCandidates({ catalog, intake, now });
  const selection = selectShadowRecipients({ scores, intake });
  return validateUBuddyPeerRoutingShadowDecision({
    version: UBUDDY_PEER_ROUTING_SHADOW_VERSION,
    candidatePool: catalog.map((item) => ({
      userId: item.userId,
      profileAvailable: item.profileAvailable,
      profileRevision: item.profileRevision,
      profileUpdatedAt: item.profileUpdatedAt,
      publicAvailability: item.publicAvailability,
    })),
    selectedRecipients: selection.selectedRecipients,
    rejectedCandidates: selection.rejectedCandidates,
    scoreBreakdown: scores.map((item) => ({
      userId: item.userId,
      totalScore: item.totalScore,
      eligible: item.eligible,
      dimensions: item.dimensions,
      coverageKeys: item.coverageKeys,
      reasonCodes: item.reasonCodes,
    })),
    selectionReason: selection.selectionReason,
    confidence: selection.confidence,
    profileRevisions: catalog.map((item) => ({
      userId: item.userId,
      profileRevision: item.profileRevision,
      contentHash: item.contentHash,
      updatedAt: item.profileUpdatedAt,
    })),
    strategyVersion: UBUDDY_PEER_ROUTING_SHADOW_STRATEGY_VERSION,
  }, { throwOnError: true }).value;
}

function scoreCandidate(candidate, requirements, now) {
  const profileText = candidate.profile ? normalizeText([
    candidate.profile.introduction,
    ...candidate.profile.supportedTaskTypes,
    ...candidate.profile.deliverableTypes,
    ...candidate.profile.capabilityTags,
    ...candidate.profile.preferredTasks,
    ...candidate.profile.collaborationModes,
  ].join(' ')) : '';
  const unsupportedText = candidate.profile ? normalizeText(candidate.profile.unsupportedTasks.join(' ')) : '';
  const profileTokens = selectionTokens(profileText);
  const unsupportedTokens = selectionTokens(unsupportedText);
  const genericOverlap = tokenOverlapCount(requirements.selectionTokens, profileTokens);
  const taskTypeMatched = Boolean(profileText && matchesAny(profileText, TASK_TYPE_ALIASES[requirements.taskType] || [requirements.taskType]));
  const matchedDeliverables = requirements.deliverables.filter((type) => matchesAny(profileText, DELIVERABLE_ALIASES[type] || [type]));
  const matchedCapabilities = requirements.capabilities.filter((item) => matchesAny(profileText, [item, ...capabilityAliases(item)]));
  const matchedCollaboration = requirements.collaborationModes.filter((item) => matchesAny(profileText, collaborationAliases(item)));
  const unsupportedMatch = Boolean(unsupportedText && (
    requirements.matchTerms.some((term) => term.length >= 2 && unsupportedText.includes(term))
    || meaningfulTokenOverlap(requirements.selectionTokens, unsupportedTokens)
  ));
  const coverageKeys = [
    ...(taskTypeMatched ? [`task_type:${requirements.taskType}`] : []),
    ...matchedDeliverables.map((item) => `deliverable:${item}`),
    ...matchedCapabilities.map((item) => `capability:${item}`),
    ...matchedCollaboration.map((item) => `collaboration:${item}`),
  ];
  const taskTypeScore = taskTypeMatched
    ? SCORE_WEIGHTS.taskType
    : matchedDeliverables.length || matchedCapabilities.length || genericOverlap ? SCORE_WEIGHTS.taskType / 2 : 0;
  const deliverableScore = ratioScore(matchedDeliverables.length, requirements.deliverables.length, SCORE_WEIGHTS.deliverable);
  const capabilityScore = ratioScore(matchedCapabilities.length, requirements.capabilities.length, SCORE_WEIGHTS.capability);
  const collaborationScore = ratioScore(matchedCollaboration.length, requirements.collaborationModes.length, SCORE_WEIGHTS.collaboration);
  const freshnessScore = profileFreshnessScore(candidate.profileUpdatedAt, now);
  const publicLoadScore = publicLoadScoreFor(candidate.publicAvailability, candidate.publicLoad);
  const requiredCoverage = requirements.coverageKeys.length
    ? requirements.coverageKeys.filter((key) => coverageKeys.includes(key)).length / requirements.coverageKeys.length
    : 0;
  const singlePersonScore = requiredCoverage === 1 ? SCORE_WEIGHTS.singlePerson : 0;
  const penalty = unsupportedMatch ? SCORE_WEIGHTS.unsupportedPenalty : 0;
  const totalScore = clamp(taskTypeScore + deliverableScore + capabilityScore + collaborationScore
    + freshnessScore + publicLoadScore + singlePersonScore + penalty, 0, 100);
  const reasonCodes = [
    ...(!candidate.profileAvailable ? ['profile_unavailable'] : []),
    ...(unsupportedMatch ? ['unsupported_match'] : []),
    ...(candidate.publicAvailability === 'unavailable' ? ['publicly_unavailable'] : []),
    ...(totalScore < 45 ? ['below_eligibility_threshold'] : []),
  ];
  return {
    userId: candidate.userId,
    profileAvailable: candidate.profileAvailable,
    profileRevision: candidate.profileRevision,
    totalScore,
    eligible: candidate.profileAvailable && !unsupportedMatch && candidate.publicAvailability !== 'unavailable' && totalScore >= 45,
    dimensions: {
      taskTypeMatch: taskTypeScore,
      deliverableMatch: deliverableScore,
      capabilityCoverage: capabilityScore,
      collaborationMatch: collaborationScore,
      profileFreshness: freshnessScore,
      publicLoad: publicLoadScore,
      singlePersonCompleteness: singlePersonScore,
      unsupportedPenalty: penalty,
    },
    coverageKeys: [...new Set(coverageKeys)].sort(),
    reasonCodes,
  };
}

function buildRequirements(intake = {}) {
  const objective = normalizeText(intake?.objective || intake?.instruction || '');
  const deliverableText = (Array.isArray(intake?.deliverables) ? intake.deliverables : []).join(' ');
  const taskType = classifyTaskType(`${objective} ${deliverableText}`);
  const deliverables = normalizeDeliverableRequirements(intake?.deliverables, taskType);
  const capabilities = CAPABILITY_RULES.filter(([, pattern]) => pattern.test(`${objective} ${deliverableText}`)).map(([key]) => key);
  if (!capabilities.length) capabilities.push(taskType === 'qa' ? 'analysis' : canonicalCapabilityForTaskType(taskType));
  const collaborationModes = COLLABORATION_RULES.filter(([, pattern]) => pattern.test(objective)).map(([key]) => key);
  const coverageKeys = [
    `task_type:${taskType}`,
    ...deliverables.map((item) => `deliverable:${item}`),
    ...capabilities.map((item) => `capability:${item}`),
    ...collaborationModes.map((item) => `collaboration:${item}`),
  ];
  const matchTerms = [...new Set([
    ...(TASK_TYPE_ALIASES[taskType] || []),
    ...deliverables.flatMap((item) => DELIVERABLE_ALIASES[item] || [item]),
    ...capabilities.flatMap((item) => [item, ...capabilityAliases(item)]),
  ].map(normalizeText).filter(Boolean))];
  return {
    taskType,
    deliverables,
    capabilities,
    collaborationModes,
    coverageKeys: [...new Set(coverageKeys)],
    matchTerms,
    selectionTokens: selectionTokens(`${objective} ${deliverableText}`),
  };
}

function normalizeDeliverableRequirements(value = [], taskType = '') {
  const textItems = Array.isArray(value) ? value : [];
  const matched = Object.entries(DELIVERABLE_ALIASES).filter(([, aliases]) => (
    textItems.some((item) => matchesAny(normalizeText(item), aliases))
  )).map(([type]) => type);
  if (matched.length) return [...new Set(matched)];
  if (taskType === 'code_change') return ['code_change'];
  if (taskType === 'file_generation') return ['document'];
  if (taskType === 'research') return ['report'];
  return ['answer'];
}

function profileFreshnessScore(value, now) {
  const updatedAt = Date.parse(value || '');
  if (!Number.isFinite(updatedAt)) return 0;
  const ageDays = Math.max(0, (validDate(now).getTime() - updatedAt) / 86_400_000);
  if (ageDays <= 7) return 10;
  if (ageDays <= 30) return 7;
  if (ageDays <= 90) return 4;
  return 1;
}

function publicLoadScoreFor(status = 'unknown', load = null) {
  if (status === 'available' || status === 'online') return load === 'high' ? 5 : 8;
  if (status === 'busy') return 2;
  if (status === 'unavailable') return 0;
  return 5;
}

function normalizePublicAvailability(value) {
  const source = value && typeof value === 'object' ? value : { status: value };
  const raw = normalizeText(source.status || source.availability || 'unknown');
  const status = ['available', 'online', 'busy', 'unavailable', 'offline'].includes(raw) ? raw : 'unknown';
  const rawLoad = normalizeText(source.load || source.publicLoad || '');
  const load = ['low', 'medium', 'high'].includes(rawLoad) ? rawLoad : null;
  return { status, load };
}

function scoreSort(left, right) {
  return right.totalScore - left.totalScore
    || right.profileRevision - left.profileRevision
    || left.userId.localeCompare(right.userId);
}

function ratioScore(matched, total, maximum) {
  if (!total) return maximum;
  return Math.round((matched / total) * maximum * 100) / 100;
}

function matchesAny(text, aliases = []) {
  return aliases.some((alias) => text.includes(normalizeText(alias)));
}

function capabilityAliases(value) {
  return ({
    code: ['coding', 'repository', '代码', '仓库', '开发'],
    research: ['research', '调研', '研究'],
    document: ['document', 'report', '文档', '报告', '写作'],
    presentation: ['presentation', 'ppt', '演示文稿'],
    spreadsheet: ['spreadsheet', 'excel', '表格'],
    image: ['image', 'visual', '图片', '视觉'],
    translation: ['translation', '翻译'],
    coordination: ['coordination', 'collaboration', '协调', '协作'],
    analysis: ['analysis', 'explanation', '分析', '解释'],
  })[value] || [value];
}

function collaborationAliases(value) {
  return ({
    single: ['single', 'direct', '单个', '直接处理', '单 agent'],
    multi: ['multi-agent', 'team', 'collaboration', '多 agent', '任务群', '协作'],
    cross_user: ['cross-user', 'external delegation', '跨用户', '外部委托'],
  })[value] || [value];
}

function canonicalCapabilityForTaskType(taskType) {
  return ({
    code_change: 'code', file_generation: 'document', command_execution: 'code', research: 'research',
    explanation: 'analysis', collaboration: 'coordination', qa: 'analysis',
  })[taskType] || 'analysis';
}

function uniqueIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item?.userId || item || '').trim()).filter(Boolean))];
}

function normalizeText(value = '') {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function selectionTokens(value = '') {
  const text = normalizeText(value);
  const result = new Set();
  for (const token of text.match(/[a-z0-9][a-z0-9_+.-]*/g) || []) {
    if (token.length > 1 && !TOKEN_STOPWORDS.has(token)) result.add(token);
  }
  for (const phrase of text.match(/[\p{Script=Han}]+/gu) || []) {
    if (phrase.length <= 12 && phrase.length > 1 && !TOKEN_STOPWORDS.has(phrase)) result.add(phrase);
    for (let index = 0; index < phrase.length - 1; index += 1) {
      const bigram = phrase.slice(index, index + 2);
      if (!TOKEN_STOPWORDS.has(bigram)) result.add(bigram);
    }
  }
  return result;
}

function tokenOverlapCount(left = new Set(), right = new Set()) {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function meaningfulTokenOverlap(left = new Set(), right = new Set()) {
  const matches = [...left].filter((token) => right.has(token));
  return matches.some((token) => /^[a-z0-9]/.test(token) && token.length >= 4) || matches.length >= 2;
}

function cleanHash(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{16,160}$/.test(text) ? text : '';
}

function validIso(value = '') {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
