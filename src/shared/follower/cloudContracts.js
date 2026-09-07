import crypto from 'node:crypto';

import { normalizeFollowerReport } from './contracts.js';

export const FOLLOWER_CLOUD_CONTRACT_VERSION = 1;
export const FOLLOWER_RELEASE_BASELINE_VERSION = '1.0.0';
export const FOLLOWER_CLOUD_CAPABILITIES = Object.freeze([
  'follower-report-projection-v1',
  'follower-raw-report-v1',
  'follower-followup-sync-v1',
  'follower-system-service-v1',
  'follower-evidence-v1',
  'follower-personal-overlay-v1',
  'follower-system-agent-bundle-v1',
]);
export const FOLLOWER_EVIDENCE_SOURCE_KINDS = Object.freeze([
  'follower_report_projection',
  'follower_preference_instruction',
  'follower_report_feedback',
  'follower_report_correction',
  'follower_suggestion_outcome',
]);
export const FOLLOWER_SIGNAL_KINDS = Object.freeze([
  'verbosity', 'language', 'focus', 'suggestion_count', 'report_pattern', 'report_feedback', 'fact_correction', 'suggestion_outcome',
]);
export const FOLLOWER_CLUSTER_PROFILE = Object.freeze({
  id: 'follower_service_cluster_v1',
  minimumUsers: 7,
  minimumSupportingInstances: 3,
  maximumUserWeightShare: 0.15,
  minimumEvidence: 15,
  minimumFeedback: 5,
  minimumOutcomes: 5,
  releaseTarget: 'system_agent_follower',
});

export function createFollowerCloudClientContract({ appVersion = FOLLOWER_RELEASE_BASELINE_VERSION, capabilities = FOLLOWER_CLOUD_CAPABILITIES } = {}) {
  return {
    contractVersion: FOLLOWER_CLOUD_CONTRACT_VERSION,
    appVersion: clean(appVersion, 40),
    capabilities: uniqueStrings(capabilities, 30, 100).sort(),
  };
}

export function assessFollowerCloudCompatibility(value = {}, { requiredCapabilities = FOLLOWER_CLOUD_CAPABILITIES } = {}) {
  const contract = {
    contractVersion: Number(value?.contractVersion || 0),
    appVersion: clean(value?.appVersion, 40),
    capabilities: uniqueStrings(value?.capabilities, 30, 100),
  };
  const reasons = [];
  if (contract.contractVersion !== FOLLOWER_CLOUD_CONTRACT_VERSION) reasons.push('follower_contract_unsupported');
  if (compareVersions(contract.appVersion, FOLLOWER_RELEASE_BASELINE_VERSION) < 0) reasons.push('follower_app_version_too_old');
  const offered = new Set(contract.capabilities);
  for (const capability of requiredCapabilities) if (!offered.has(capability)) reasons.push(`follower_capability_missing:${capability}`);
  return { compatible: reasons.length === 0, status: reasons.length ? 'incompatible' : 'compatible', reasons, contract };
}

export function followerProjectionFromReport(reportValue = {}, { originDeviceId = '', revision = 1 } = {}) {
  const report = normalizeFollowerReport(reportValue.report || reportValue);
  const validatedHash = clean(reportValue.validatedContentHash || reportValue.validated_hash, 128);
  const syncBody = cleanMultiline(reportValue.syncBody || reportValue.sync_body, 24_000);
  if (reportValue.privacyState !== 'passed' || !validatedHash || !syncBody) throw followerContractError('follower_projection_not_validated');
  const projectionId = stableFollowerProjectionId({
    reportId: reportValue.id,
    originDeviceId,
    validatedHash,
  });
  return {
    schemaVersion: 'follower_report_projection_v1',
    projectionId,
    originDeviceId: clean(originDeviceId, 200),
    reportKind: report.kind,
    window: report.window,
    summary: cleanMultiline(report.summary, 2_400),
    claims: report.claims.map(({ id, status, text }) => ({ id, status, text })),
    suggestions: report.suggestions.map(({ id, category, title, rationale, expectedValue, perspective, researchQuestion, smallestNextStep }) => ({
      id, category, title, rationale, expectedValue, perspective, researchQuestion, smallestNextStep,
    })),
    coverage: report.coverage.map(({ category, itemCount, truncated, warningCode }) => ({ category, itemCount, truncated, warningCode })),
    syncBody,
    validatedHash,
    privacyValidatorVersion: clean(reportValue.privacyValidatorVersion, 100),
    revision: Math.max(1, Number(revision || 1)),
    createdAt: iso(reportValue.createdAt) || new Date().toISOString(),
    updatedAt: iso(reportValue.updatedAt) || new Date().toISOString(),
  };
}

export function followerRawReportFromReport(reportValue = {}, { originDeviceId = '' } = {}) {
  const report = normalizeFollowerReport(reportValue.report || reportValue);
  const validatedHash = clean(reportValue.validatedContentHash || reportValue.validated_hash, 128);
  const renderedBody = cleanMultiline(reportValue.renderedBody || reportValue.rendered_body, 32_000);
  if (reportValue.privacyState !== 'passed' || !validatedHash || !renderedBody) throw followerContractError('follower_raw_report_not_validated');
  return {
    schemaVersion: 'follower_raw_report_v1',
    reportId: clean(reportValue.id, 240),
    originDeviceId: clean(originDeviceId, 200),
    reportKind: report.kind,
    report,
    renderedBody,
    validatedHash,
    privacyValidatorVersion: clean(reportValue.privacyValidatorVersion, 100),
    createdAt: iso(reportValue.createdAt) || new Date().toISOString(),
    updatedAt: iso(reportValue.updatedAt) || new Date().toISOString(),
  };
}

export function normalizeFollowerPreferenceSignal(value = {}) {
  const sourceKind = clean(value.sourceKind || value.source_kind, 100);
  const signalKind = clean(value.signalKind || value.signal_kind, 100);
  if (!FOLLOWER_EVIDENCE_SOURCE_KINDS.includes(sourceKind)) throw followerContractError('follower_evidence_source_invalid');
  if (!FOLLOWER_SIGNAL_KINDS.includes(signalKind)) throw followerContractError('follower_signal_kind_invalid');
  const normalized = normalizeSignalPayload(signalKind, value.normalized || value.normalized_json || {});
  const signalHash = sha256(JSON.stringify({ signalKind, normalized }));
  return {
    sourceKind,
    sourceId: clean(value.sourceId || value.source_id, 240),
    sourceVersion: clean(value.sourceVersion || value.source_version, 240),
    signalKind,
    normalized,
    signalHash,
    lineageKey: clean(value.lineageKey || value.lineage_key || `${sourceKind}:${value.sourceId || value.source_id || ''}`, 300),
    explicit: value.explicit !== false,
    confidence: Math.max(0, Math.min(1, Number(value.confidence ?? 1))),
    personalEligible: value.personalEligible !== false,
    clusterEligible: value.clusterEligible !== false,
    occurredAt: iso(value.occurredAt || value.occurred_at) || new Date().toISOString(),
  };
}

export function followerClusterEvidenceCategory(sourceKind = '') {
  if (sourceKind === 'follower_suggestion_outcome') return 'outcome';
  if (sourceKind === 'follower_report_feedback' || sourceKind === 'follower_report_correction') return 'feedback';
  return 'preference';
}

export function evaluateFollowerClusterEvidence(items = [], profile = FOLLOWER_CLUSTER_PROFILE) {
  const eligible = (Array.isArray(items) ? items : []).filter((item) => FOLLOWER_EVIDENCE_SOURCE_KINDS.includes(item.sourceKind || item.source_kind));
  const byLineage = new Map();
  for (const item of eligible.sort((left, right) => String(left.occurredAt || left.occurred_at || '').localeCompare(String(right.occurredAt || right.occurred_at || '')))) {
    const owner = item.ownerUserId || item.owner_user_id || '';
    const lineage = item.lineageKey || item.lineage_key || item.evidenceId || item.evidence_id || '';
    byLineage.set(`${owner}:${item.sourceKind || item.source_kind}:${lineage}`, item);
  }
  const valid = [...byLineage.values()];
  const users = new Set(valid.map((item) => item.ownerUserId || item.owner_user_id).filter(Boolean));
  const instances = new Set(valid.map((item) => item.serviceInstanceId || item.service_instance_id).filter(Boolean));
  const categories = valid.reduce((result, item) => {
    const category = followerClusterEvidenceCategory(item.sourceKind || item.source_kind);
    result[category] = (result[category] || 0) + 1;
    return result;
  }, {});
  const reasons = [];
  const evidenceByUser = valid.reduce((result, item) => {
    const owner = item.ownerUserId || item.owner_user_id || '';
    if (owner) result[owner] = (result[owner] || 0) + 1;
    return result;
  }, {});
  const maximumUserShare = valid.length ? Math.max(0, ...Object.values(evidenceByUser)) / valid.length : 0;
  if (users.size < profile.minimumUsers) reasons.push('follower_cluster_users_insufficient');
  if (instances.size < profile.minimumSupportingInstances) reasons.push('follower_cluster_support_insufficient');
  if (valid.length < profile.minimumEvidence) reasons.push('follower_cluster_evidence_insufficient');
  if ((categories.feedback || 0) < profile.minimumFeedback) reasons.push('follower_cluster_feedback_insufficient');
  if ((categories.outcome || 0) < profile.minimumOutcomes) reasons.push('follower_cluster_outcome_insufficient');
  if (maximumUserShare > profile.maximumUserWeightShare + Number.EPSILON) reasons.push('follower_cluster_user_weight_exceeded');
  return { eligible: reasons.length === 0, reasons, userCount: users.size, supportingInstanceCount: instances.size,
    evidenceCount: valid.length, categories, maximumUserShare, evidenceByUser,
    selectedEvidenceIds: valid.map((item) => item.evidenceId || item.evidence_id).filter(Boolean), profile };
}

export function stableFollowerProjectionId({ reportId = '', originDeviceId = '', validatedHash = '' } = {}) {
  return `follower_projection_${sha256([reportId, originDeviceId, validatedHash].join('\n')).slice(0, 40)}`;
}

export function stableFollowerServiceInstanceId({ remoteUserId = '', workspaceId = '' } = {}) {
  return `follower_service_${sha256([remoteUserId, workspaceId, 'follower_agent', 'system_service'].join('\n')).slice(0, 40)}`;
}

function normalizeSignalPayload(kind, value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (kind === 'report_pattern') return {
    reportKind: enumValue(source.reportKind, ['daily_brief', 'weekly_review', 'growth_guidance'], 'daily_brief'),
    claimStatuses: countMap(source.claimStatuses, ['completed', 'in_progress', 'blocked', 'waiting_for_input', 'discussed_not_executed']),
    extensionCategories: countMap(source.extensionCategories, ['insight', 'recommendation', 'research_direction']),
    coverageCategories: uniqueStrings(source.coverageCategories, 12, 80),
  };
  if (kind === 'verbosity') return { value: enumValue(source.value, ['shorter', 'short', 'standard', 'detailed'], 'standard') };
  if (kind === 'language') return { value: enumValue(source.value, ['zh-CN', 'en'], 'zh-CN') };
  if (kind === 'focus') return { values: uniqueStrings(source.values || source.value, 8, 80).filter((item) => ['risks', 'deliveries', 'blockers', 'next_steps', 'projects'].includes(item)) };
  if (kind === 'suggestion_count') return { value: Math.max(1, Math.min(8, Number(source.value || 3) || 3)) };
  if (kind === 'report_feedback') return { rating: enumValue(source.rating || source.value, ['helpful', 'not_helpful'], 'helpful') };
  if (kind === 'suggestion_outcome') return { outcome: enumValue(source.outcome || source.value, ['accepted', 'ignored', 'completed', 'failed'], 'ignored') };
  return { field: enumValue(source.field, ['status', 'date', 'scope', 'ownership', 'priority', 'other'], 'other'),
    correctionType: enumValue(source.correctionType || source.value, ['incorrect', 'outdated', 'missing_context', 'unsupported'], 'incorrect') };
}

function countMap(value, allowed) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(allowed.map((key) => [key, Math.max(0, Math.min(100, Math.floor(Number(source[key]) || 0)))])
    .filter(([, count]) => count > 0));
}

function uniqueStrings(value, maximum, length) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(input.map((item) => clean(item, length)).filter(Boolean))].slice(0, maximum);
}

function enumValue(value, allowed, fallback) {
  const normalized = clean(value, 100);
  return allowed.includes(normalized) ? normalized : fallback;
}

function clean(value = '', maximum = 240) { return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum); }
function cleanMultiline(value = '', maximum = 1200) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, maximum); }
function iso(value = '') { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function compareVersions(left, right) {
  const parts = (value) => String(value || '0').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((item) => Number(item) || 0);
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < 3; index += 1) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  return 0;
}
function followerContractError(code) { const error = new Error(code); error.code = code; return error; }
