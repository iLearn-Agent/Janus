import crypto from 'node:crypto';

import { evaluateUBuddyPeerRoutingShadow } from '../domain/uBuddyPeerCapabilityCatalog.js';

export const DEFAULT_UBUDDY_PEER_PROFILE_REFRESH_TIMEOUT_MS = 800;
export const DEFAULT_UBUDDY_PEER_ROUTING_AUTO_CONFIDENCE = 0.75;
export const UBUDDY_PEER_ROUTING_SHADOW_EVENT_TYPE = 'ubuddy_peer_routing_shadow_evaluated';

export async function evaluateUBuddyPeerRoutingShadowIfEnabled({
  ...options
} = {}) {
  const context = await resolveUBuddyPeerRoutingShadowContextIfEnabled(options);
  return context.routingShadow;
}

export async function resolveUBuddyPeerRoutingAutoContext({
  enabled = false,
  selectionMode = 'candidate_pool',
  candidateUserIds = [],
  requiredUserIds = [],
  intake = {},
  socialRelay = null,
  publicAvailabilityByUserId = {},
  timeoutMs = DEFAULT_UBUDDY_PEER_PROFILE_REFRESH_TIMEOUT_MS,
  confidenceThreshold = DEFAULT_UBUDDY_PEER_ROUTING_AUTO_CONFIDENCE,
  now = new Date(),
} = {}) {
  const candidates = uniqueIds(candidateUserIds);
  const required = uniqueIds(requiredUserIds).filter((userId) => candidates.includes(userId));
  const bypassAuto = !enabled || selectionMode === 'all_selected' || selectionMode === 'explicit_single' || candidates.length < 2;
  if (bypassAuto) {
    return {
      routingShadow: null,
      profileRevisionSnapshots: [],
      selection: {
        version: 'ubuddy_peer_selection_v1',
        status: 'ready',
        selectionMode: candidates.length === 1 ? 'explicit_single' : 'all_selected',
        candidateUserIds: candidates,
        requiredUserIds: selectionMode === 'candidate_pool' ? required : candidates,
        selectedUserIds: candidates,
        rejectedCandidates: [],
        scoreBreakdown: [],
        confidence: 1,
        strategyVersion: enabled ? 'user_all_selected_v1' : 'legacy_all_mentions_v1',
        rationale: enabled
          ? (candidates.length === 1 ? '用户明确指定单一接收人，跳过自动筛选。' : '用户明确要求全员参与，跳过自动筛选。')
          : '自动 Profile 筛选未启用，沿用所有明确 @ 用户参与的兼容行为。',
        clarification: { reasonCode: '', question: '' },
      },
    };
  }
  const context = await resolveUBuddyPeerRoutingShadowContextIfEnabled({
    enabled: true,
    candidateUserIds: candidates,
    intake: { ...intake, state: 'ready', candidateUserIds: candidates, requiredUserIds: required },
    socialRelay,
    publicAvailabilityByUserId,
    timeoutMs,
    now,
  });
  const shadow = context.routingShadow;
  const confidence = Number(shadow?.confidence || 0);
  const selected = uniqueIds(shadow?.selectedRecipients);
  const ready = selected.length > 0 && confidence >= Number(confidenceThreshold || DEFAULT_UBUDDY_PEER_ROUTING_AUTO_CONFIDENCE);
  const rejected = (shadow?.rejectedCandidates || []).map((item) => ({
    userId: String(item?.userId || ''),
    reasonCode: String(item?.reasonCodes?.[0] || 'not_selected'),
    reason: routingReasonText(item?.reasonCodes),
  }));
  return {
    ...context,
    selection: {
      version: 'ubuddy_peer_selection_v1',
      status: ready ? 'ready' : selected.length ? 'needs_clarification' : 'no_match',
      selectionMode: 'candidate_pool',
      candidateUserIds: candidates,
      requiredUserIds: required,
      selectedUserIds: ready ? selected : [],
      rejectedCandidates: rejected,
      scoreBreakdown: shadow?.scoreBreakdown || [],
      confidence,
      strategyVersion: shadow?.strategyVersion || 'ubuddy_peer_routing_shadow_v1',
      rationale: ready
        ? routingSelectionRationale(shadow)
        : selected.length
          ? `推荐置信度 ${Math.round(confidence * 100)}% 低于自动派发阈值，请用户确认参与人。`
          : '候选人的公开能力简介、可用状态或任务匹配度不足，无法安全自动派发。',
      clarification: ready ? { reasonCode: '', question: '' } : {
        reasonCode: selected.length ? 'peer_selection_low_confidence' : 'peer_selection_no_match',
        question: selected.length
          ? 'uBuddy 对参与人选择的把握不足。你希望全员参与，还是重新指定必须参与的人？'
          : '当前候选中没有找到合适且可用的接收人。你希望全员参与，还是更换候选人？',
      },
    },
  };
}

export async function resolveUBuddyPeerRoutingShadowContextIfEnabled({
  enabled = false,
  candidateUserIds = [],
  intake = {},
  socialRelay = null,
  publicAvailabilityByUserId = {},
  timeoutMs = DEFAULT_UBUDDY_PEER_PROFILE_REFRESH_TIMEOUT_MS,
  now = new Date(),
} = {}) {
  const candidates = uniqueIds(candidateUserIds);
  if (!enabled || candidates.length < 2 || String(intake?.state || 'ready') !== 'ready') {
    return { routingShadow: null, profileRevisionSnapshots: [] };
  }
  const cached = await safeProfileQuery(socialRelay, candidates, true);
  let profileItems = cached.profiles;
  const cachedIds = new Set(profileItems.map(profileOwnerId).filter(Boolean));
  if (candidates.some((userId) => !cachedIds.has(userId))) {
    const refreshed = await boundedProfileRefresh(socialRelay, candidates, timeoutMs);
    if (refreshed?.profiles?.length) profileItems = mergeProfiles(profileItems, refreshed.profiles);
  }
  const routingShadow = evaluateUBuddyPeerRoutingShadow({
    candidateUserIds: candidates,
    profileItems,
    publicAvailabilityByUserId,
    intake,
    now,
  });
  return {
    routingShadow,
    profileRevisionSnapshots: profileRevisionSnapshotsForRouting({
      candidateUserIds: candidates,
      profileItems,
      routingShadow,
    }),
  };
}

export function profileRevisionSnapshotsForRouting({ candidateUserIds = [], profileItems = [], routingShadow = null } = {}) {
  const candidates = uniqueIds(candidateUserIds);
  const available = new Set((routingShadow?.candidatePool || [])
    .filter((item) => item?.profileAvailable === true).map((item) => String(item.userId || '')).filter(Boolean));
  const profiles = new Map((Array.isArray(profileItems) ? profileItems : []).map((item) => [profileOwnerId(item), item]));
  return candidates.map((ownerUserId) => {
    const item = profiles.get(ownerUserId);
    const profile = item?.profile || item || {};
    const profileRevision = Math.max(0, Math.floor(Number(profile.profileRevision || profile.profile_revision || 0)));
    const sourceEffectiveSkillHash = cleanHash(profile.sourceEffectiveSkillHash || profile.source_effective_skill_hash);
    if (!available.has(ownerUserId) || !profileRevision || !sourceEffectiveSkillHash) return null;
    return { ownerUserId, profileRevision, sourceEffectiveSkillHash };
  }).filter(Boolean);
}

export function recordUBuddyPeerRoutingShadowTaskEvents({
  store = null, decision = null, dispatchId = '', taskRunIds = [], actorId = 'secretary_agent',
} = {}) {
  if (!decision || typeof store?.recordTaskEvent !== 'function') return [];
  const events = [];
  for (const taskRunId of uniqueIds(taskRunIds)) {
    const eventId = stableShadowEventId(dispatchId, taskRunId);
    const event = store.recordTaskEvent({
      eventId,
      taskRunId,
      eventType: UBUDDY_PEER_ROUTING_SHADOW_EVENT_TYPE,
      actorId,
      privacyLevel: 'owner_private',
      summary: `Shadow routing evaluated ${decision.candidatePool?.length || 0} candidates and recommended ${decision.selectedRecipients?.length || 0}.`,
      payload: decision,
    });
    if (event) events.push(event);
  }
  return events;
}

export function stableShadowEventId(dispatchId = '', taskRunId = '') {
  const digest = crypto.createHash('sha256')
    .update(`ubuddy_peer_shadow:${String(dispatchId || '')}:${String(taskRunId || '')}`)
    .digest('hex').slice(0, 32);
  return `ubuddy_peer_shadow_${digest}`;
}

async function boundedProfileRefresh(socialRelay, candidateUserIds, timeoutMs) {
  if (typeof socialRelay?.queryUBuddyCapabilityProfiles !== 'function') return { profiles: [] };
  const timeout = Math.max(1, Math.min(5_000, Number(timeoutMs) || DEFAULT_UBUDDY_PEER_PROFILE_REFRESH_TIMEOUT_MS));
  let timer = null;
  try {
    return await Promise.race([
      safeProfileQuery(socialRelay, candidateUserIds, false),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ profiles: [], timeout: true }), timeout); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeProfileQuery(socialRelay, candidateUserIds, cachedOnly) {
  if (typeof socialRelay?.queryUBuddyCapabilityProfiles !== 'function') return { profiles: [] };
  try {
    const result = await socialRelay.queryUBuddyCapabilityProfiles({ userIds: candidateUserIds, cachedOnly });
    return { ...result, profiles: Array.isArray(result?.profiles) ? result.profiles : [] };
  } catch (error) {
    return { profiles: [], errorCode: String(error?.code || 'profile_query_failed') };
  }
}

function mergeProfiles(cached = [], refreshed = []) {
  const profiles = new Map();
  for (const item of [...cached, ...refreshed]) {
    const userId = profileOwnerId(item);
    if (userId) profiles.set(userId, item);
  }
  return [...profiles.values()];
}

function profileOwnerId(item = {}) {
  return String(item?.ownerUserId || item?.profile?.ownerUserId || '').trim();
}

function uniqueIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))];
}

function cleanHash(value = '') {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32,160}$/.test(text) ? text : '';
}

function routingReasonText(reasonCodes = []) {
  const labels = {
    profile_unavailable: '没有可用的公开能力简介',
    unsupported_match: '公开简介明确标注不支持该类任务',
    publicly_unavailable: '当前公开状态不可用',
    below_eligibility_threshold: '任务和交付物匹配度低于阈值',
    not_needed_for_minimum_coverage: '已有更小的参与组合可以覆盖任务要求',
  };
  const values = uniqueIds(reasonCodes).map((code) => labels[code] || code);
  return values.join('；') || '当前未进入最小充分参与组合';
}

function routingSelectionRationale(shadow = {}) {
  const labels = {
    single_candidate_full_coverage: '选择了可单独覆盖任务要求的候选人。',
    required_candidates_preserved_then_minimum_coverage: '先保留用户要求必须参与的人，再补充覆盖缺口所需的最少候选人。',
    greedy_minimum_coverage: '选择了能够覆盖任务要求的最小候选组合。',
  };
  return labels[shadow?.selectionReason] || '根据公开能力、交付物匹配、简介新鲜度和当前负载选择参与人。';
}
