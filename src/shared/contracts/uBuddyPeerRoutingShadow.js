export const UBUDDY_PEER_ROUTING_SHADOW_VERSION = 'ubuddy_peer_routing_shadow_v1';

export const uBuddyPeerRoutingShadowDecision = Object.freeze({
  name: 'uBuddyPeerRoutingShadowDecision',
  version: UBUDDY_PEER_ROUTING_SHADOW_VERSION,
  fields: Object.freeze({
    version: 'string',
    candidatePool: '{ userId: string, profileAvailable: boolean, profileRevision: non-negative integer, profileUpdatedAt: string, publicAvailability: string }[]',
    selectedRecipients: 'string[]',
    rejectedCandidates: '{ userId: string, reasonCodes: string[] }[]',
    scoreBreakdown: '{ userId: string, totalScore: number, eligible: boolean, dimensions: object, coverageKeys: string[], reasonCodes: string[] }[]',
    selectionReason: 'string',
    confidence: 'number between 0 and 1',
    profileRevisions: '{ userId: string, profileRevision: non-negative integer, contentHash: string, updatedAt: string }[]',
    strategyVersion: 'string',
  }),
  requiredFields: Object.freeze([
    'candidatePool', 'selectedRecipients', 'rejectedCandidates', 'scoreBreakdown',
    'selectionReason', 'confidence', 'profileRevisions', 'strategyVersion',
  ]),
});

export function normalizeUBuddyPeerRoutingShadowDecision(value = {}) {
  const source = objectValue(value);
  return {
    version: UBUDDY_PEER_ROUTING_SHADOW_VERSION,
    candidatePool: normalizeCandidatePool(source.candidatePool),
    selectedRecipients: cleanIds(source.selectedRecipients),
    rejectedCandidates: normalizeRejected(source.rejectedCandidates),
    scoreBreakdown: normalizeScores(source.scoreBreakdown),
    selectionReason: clean(source.selectionReason, 160),
    confidence: clamp(Number(source.confidence || 0), 0, 1),
    profileRevisions: normalizeRevisions(source.profileRevisions),
    strategyVersion: clean(source.strategyVersion, 120) || UBUDDY_PEER_ROUTING_SHADOW_VERSION,
  };
}

export function validateUBuddyPeerRoutingShadowDecision(value = {}, { throwOnError = false } = {}) {
  const decision = normalizeUBuddyPeerRoutingShadowDecision(value);
  const diagnostics = [];
  const candidates = new Set(decision.candidatePool.map((item) => item.userId));
  if (!decision.selectionReason) diagnostics.push({ code: 'shadow_selection_reason_missing' });
  if (decision.selectedRecipients.some((userId) => !candidates.has(userId))) {
    diagnostics.push({ code: 'shadow_selected_recipient_not_candidate' });
  }
  if (decision.scoreBreakdown.some((item) => !candidates.has(item.userId))) {
    diagnostics.push({ code: 'shadow_score_not_candidate' });
  }
  const result = { valid: diagnostics.length === 0, value: decision, diagnostics };
  if (throwOnError && !result.valid) {
    const error = new Error('Invalid uBuddy peer routing Shadow decision.');
    error.code = 'ubuddy_peer_routing_shadow_invalid';
    error.diagnostics = diagnostics;
    throw error;
  }
  return result;
}

function normalizeCandidatePool(value = []) {
  return uniqueByUserId(value).map((item) => ({
    userId: clean(item.userId, 160),
    profileAvailable: Boolean(item.profileAvailable),
    profileRevision: nonNegativeInteger(item.profileRevision),
    profileUpdatedAt: isoTimestamp(item.profileUpdatedAt),
    publicAvailability: clean(item.publicAvailability, 40) || 'unknown',
  }));
}

function normalizeRejected(value = []) {
  return uniqueByUserId(value).map((item) => ({
    userId: clean(item.userId, 160),
    reasonCodes: cleanStrings(item.reasonCodes, 12, 80),
  }));
}

function normalizeScores(value = []) {
  return uniqueByUserId(value).map((item) => ({
    userId: clean(item.userId, 160),
    totalScore: clamp(Number(item.totalScore || 0), 0, 100),
    eligible: Boolean(item.eligible),
    dimensions: Object.fromEntries(Object.entries(objectValue(item.dimensions))
      .map(([key, score]) => [clean(key, 80), Number(score || 0)]).filter(([key]) => key)),
    coverageKeys: cleanStrings(item.coverageKeys, 40, 120),
    reasonCodes: cleanStrings(item.reasonCodes, 20, 80),
  }));
}

function normalizeRevisions(value = []) {
  return uniqueByUserId(value).map((item) => ({
    userId: clean(item.userId, 160),
    profileRevision: nonNegativeInteger(item.profileRevision),
    contentHash: cleanHash(item.contentHash),
    updatedAt: isoTimestamp(item.updatedAt),
  }));
}

function uniqueByUserId(value = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const item = objectValue(raw);
    const userId = clean(item.userId || item.ownerUserId, 160);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    result.push({ ...item, userId });
  }
  return result;
}

function cleanIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 160)).filter(Boolean))];
}

function cleanStrings(value = [], maximum = 24, itemLength = 120) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, itemLength)).filter(Boolean))].slice(0, maximum);
}

function cleanHash(value = '') {
  const text = clean(value, 160).toLowerCase();
  return /^[a-f0-9]{16,160}$/.test(text) ? text : '';
}

function isoTimestamp(value = '') {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function nonNegativeInteger(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum));
}
