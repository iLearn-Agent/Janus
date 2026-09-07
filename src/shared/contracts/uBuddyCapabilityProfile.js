export const UBUDDY_CAPABILITY_PROFILE_VERSION = 'ubuddy_capability_profile_v1';
export const UBUDDY_CAPABILITY_PROFILE_PREVIEW_PROJECTION_VERSION = 'ubuddy_capability_profile_preview_projection_v1';

export const UBUDDY_CAPABILITY_PROFILE_VISIBILITIES = Object.freeze([
  'private',
  'friends',
  'organization',
]);

export const UBUDDY_CAPABILITY_PROFILE_STATES = Object.freeze([
  'draft',
  'validated',
  'active',
  'archived',
  'rejected',
]);

export const uBuddyCapabilityProfile = Object.freeze({
  name: 'uBuddyCapabilityProfile',
  version: UBUDDY_CAPABILITY_PROFILE_VERSION,
  fields: Object.freeze({
    version: 'string',
    ownerUserId: 'string',
    uBuddyAgentInstanceId: 'string',
    profileRevision: 'positive integer',
    introduction: 'string',
    supportedTaskTypes: 'string[]',
    deliverableTypes: 'string[]',
    capabilityTags: 'string[]',
    preferredTasks: 'string[]',
    unsupportedTasks: 'string[]',
    improvementDirections: 'string[]',
    collaborationModes: 'string[]',
    privacyConstraints: 'string[]',
    evidenceSummary: 'string',
    sourceEffectiveSkillHash: 'string',
    visibility: 'private | friends | organization',
    publicationState: 'draft | validated | active | archived | rejected',
    generatedAt: 'ISO-8601 timestamp',
    approvedAt: 'ISO-8601 timestamp',
    publishedAt: 'ISO-8601 timestamp',
    privacyRiskConfirmedAt: 'ISO-8601 timestamp',
    privacyRiskCodes: 'string[]',
  }),
  requiredFields: Object.freeze([
    'ownerUserId', 'uBuddyAgentInstanceId', 'profileRevision', 'introduction', 'sourceEffectiveSkillHash',
  ]),
});

export const uBuddyCapabilityProfilePreviewProjection = Object.freeze({
  name: 'uBuddyCapabilityProfilePreviewProjection',
  version: UBUDDY_CAPABILITY_PROFILE_PREVIEW_PROJECTION_VERSION,
  omittedPrivateFields: Object.freeze(['ownerUserId', 'uBuddyAgentInstanceId']),
});

const DELIVERABLE_TYPES = new Set([
  'answer', 'report', 'document', 'presentation', 'spreadsheet', 'image', 'code_change',
]);
const SENSITIVE_PATTERNS = Object.freeze([
  { code: 'profile_contains_email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: 'profile_contains_credential', pattern: /(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|client[_ -]?secret|session[_ -]?id|cookie|私钥|密码|密钥)\s*[:=：]|(?:proxy-)?authorization\s*[:=：]\s*bearer\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { code: 'profile_contains_token', pattern: /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/i },
  { code: 'profile_contains_local_path', pattern: /(?:file:\/\/|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\s]+|(?:^|[\s("'`])\/(?!\/)(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)/i },
  { code: 'profile_contains_private_evidence', pattern: /(?:私聊原文|私聊记录原文|Memory\s*原文|未公开任务内容|附件内容\s*[:：]|private\s+conversation\s+transcript)/i },
  { code: 'profile_contains_private_filename', pattern: /(?:附件(?:文件|文件名)?|私有文件|本地文件|文件名|attachment(?:\s+file(?:name)?)?|private\s+file)\s*[:=：]\s*\S+/i },
  { code: 'profile_contains_username', pattern: /(?:用户名|username|user[_ -]?name)\s*[:=：]\s*[^\s,，。;；]+|@[A-Za-z0-9_][A-Za-z0-9_.-]{2,}/i },
  { code: 'profile_contains_internal_prompt', pattern: /(?:system\s+prompt|developer\s+message|模型提示词|系统提示词|内部诊断(?:信息)?|stack\s+trace|command\s+line)\s*[:：]/i },
]);

export function normalizeUBuddyCapabilityProfile(value = {}) {
  const source = objectValue(value);
  const rawVisibility = clean(source.visibility).toLowerCase();
  const rawState = clean(source.publicationState || source.publication_state || source.status).toLowerCase();
  return {
    version: clean(source.version) || UBUDDY_CAPABILITY_PROFILE_VERSION,
    ownerUserId: clean(source.ownerUserId || source.owner_user_id, 160),
    uBuddyAgentInstanceId: clean(source.uBuddyAgentInstanceId || source.ubuddy_agent_instance_id, 160),
    profileRevision: positiveInteger(source.profileRevision || source.profile_revision),
    introduction: clean(source.introduction || source.summary, 600),
    supportedTaskTypes: cleanStringArray(source.supportedTaskTypes || source.supported_task_types, 32, 160),
    deliverableTypes: normalizeDeliverableTypes(source.deliverableTypes || source.deliverable_types),
    capabilityTags: cleanStringArray(source.capabilityTags || source.capability_tags, 40, 120),
    preferredTasks: cleanStringArray(source.preferredTasks || source.preferred_tasks, 24, 240),
    unsupportedTasks: cleanStringArray(source.unsupportedTasks || source.unsupported_tasks, 24, 240),
    improvementDirections: cleanStringArray(source.improvementDirections || source.improvement_directions, 16, 240),
    collaborationModes: cleanStringArray(source.collaborationModes || source.collaboration_modes, 16, 120),
    privacyConstraints: cleanStringArray(source.privacyConstraints || source.privacy_constraints, 24, 300),
    evidenceSummary: clean(source.evidenceSummary || source.evidence_summary, 1_000),
    sourceEffectiveSkillHash: clean(source.sourceEffectiveSkillHash || source.source_effective_skill_hash, 160),
    visibility: UBUDDY_CAPABILITY_PROFILE_VISIBILITIES.includes(rawVisibility) ? rawVisibility : 'private',
    publicationState: UBUDDY_CAPABILITY_PROFILE_STATES.includes(rawState) ? rawState : 'draft',
    generatedAt: isoTimestamp(source.generatedAt || source.generated_at),
    approvedAt: isoTimestamp(source.approvedAt || source.approved_at),
    publishedAt: isoTimestamp(source.publishedAt || source.published_at),
    privacyRiskConfirmedAt: isoTimestamp(source.privacyRiskConfirmedAt || source.privacy_risk_confirmed_at),
    privacyRiskCodes: cleanStringArray(source.privacyRiskCodes || source.privacy_risk_codes, 24, 120),
  };
}

export function validateUBuddyCapabilityProfile(value = {}, { throwOnError = false } = {}) {
  const source = objectValue(value);
  const profile = normalizeUBuddyCapabilityProfile(value);
  const diagnostics = [];
  if (profile.version !== UBUDDY_CAPABILITY_PROFILE_VERSION) {
    diagnostics.push(errorDiagnostic('profile_version_unsupported', 'version', 'Unsupported uBuddy capability profile version.'));
  }
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.visibility, allowedValues: UBUDDY_CAPABILITY_PROFILE_VISIBILITIES,
    code: 'profile_visibility_invalid', field: 'visibility', message: 'A capability profile requires a supported visibility.' });
  addInvalidEnumDiagnostic({ diagnostics, rawValue: source.publicationState ?? source.publication_state ?? source.status,
    allowedValues: UBUDDY_CAPABILITY_PROFILE_STATES, code: 'profile_publication_state_invalid', field: 'publicationState',
    message: 'A capability profile requires a supported publication state.' });
  if (!profile.ownerUserId) diagnostics.push(errorDiagnostic('profile_owner_missing', 'ownerUserId', 'A capability profile requires an owner user id.'));
  if (!profile.uBuddyAgentInstanceId) diagnostics.push(errorDiagnostic('profile_agent_instance_missing', 'uBuddyAgentInstanceId', 'A capability profile requires a uBuddy Agent instance id.'));
  if (!profile.profileRevision) diagnostics.push(errorDiagnostic('profile_revision_invalid', 'profileRevision', 'A capability profile revision must be a positive integer.'));
  if (!profile.introduction) diagnostics.push(errorDiagnostic('profile_introduction_missing', 'introduction', 'A capability profile requires an introduction.'));
  if (!profile.sourceEffectiveSkillHash) diagnostics.push(errorDiagnostic('profile_skill_hash_missing', 'sourceEffectiveSkillHash', 'A capability profile requires its effective Skill hash.'));
  const publicTextFields = [
    ['introduction', profile.introduction],
    ['supportedTaskTypes', profile.supportedTaskTypes.join('\n')],
    ['capabilityTags', profile.capabilityTags.join('\n')],
    ['preferredTasks', profile.preferredTasks.join('\n')],
    ['unsupportedTasks', profile.unsupportedTasks.join('\n')],
    ['improvementDirections', profile.improvementDirections.join('\n')],
    ['collaborationModes', profile.collaborationModes.join('\n')],
    ['privacyConstraints', profile.privacyConstraints.join('\n')],
    ['evidenceSummary', profile.evidenceSummary],
  ];
  for (const [field, text] of publicTextFields) {
    for (const sensitive of SENSITIVE_PATTERNS) {
      if (!sensitive.pattern.test(text)) continue;
      diagnostics.push(errorDiagnostic(sensitive.code, field, 'The public capability profile contains private or sensitive evidence.'));
    }
  }
  return finishValidation('ubuddy_capability_profile_invalid', profile, diagnostics, throwOnError);
}

export function projectUBuddyCapabilityProfileForPreview(value = {}) {
  const validation = validateUBuddyCapabilityProfile(value, { throwOnError: true });
  const projected = { ...validation.value };
  delete projected.ownerUserId;
  delete projected.uBuddyAgentInstanceId;
  delete projected.privacyRiskConfirmedAt;
  delete projected.privacyRiskCodes;
  return {
    projectionVersion: UBUDDY_CAPABILITY_PROFILE_PREVIEW_PROJECTION_VERSION,
    ...projected,
  };
}

export function redactUBuddyCapabilityProfileSensitiveContent(value = {}) {
  const profile = normalizeUBuddyCapabilityProfile(value);
  return normalizeUBuddyCapabilityProfile({
    ...profile,
    introduction: '简介生成结果包含敏感信息，相关内容已移除。',
    supportedTaskTypes: [],
    deliverableTypes: [],
    capabilityTags: [],
    preferredTasks: [],
    unsupportedTasks: [],
    improvementDirections: [],
    collaborationModes: [],
    privacyConstraints: ['敏感内容已阻断；重新生成前不会启用或发布该版本。'],
    evidenceSummary: '原生成结果未通过隐私校验，内容已从本地简介记录中移除。',
    visibility: 'private',
    publicationState: 'rejected',
    approvedAt: '',
    publishedAt: '',
    privacyRiskConfirmedAt: '',
    privacyRiskCodes: [],
  });
}

function normalizeDeliverableTypes(value = []) {
  return cleanStringArray(value, 20, 80).map((item) => item.toLowerCase()).filter((item) => DELIVERABLE_TYPES.has(item));
}

function cleanStringArray(value = [], maximum = 24, itemLength = 240) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = clean(item, itemLength);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maximum) break;
  }
  return result;
}

function finishValidation(code, value, diagnostics, throwOnError) {
  const result = { valid: diagnostics.every((item) => item.severity !== 'error'), value, diagnostics };
  if (throwOnError && !result.valid) {
    const error = new Error(diagnostics.map((item) => item.message).join(' '));
    error.code = code;
    error.diagnostics = diagnostics;
    throw error;
  }
  return result;
}

function errorDiagnostic(code, field, message) {
  return { severity: 'error', code, field, message };
}

function addInvalidEnumDiagnostic({ diagnostics, rawValue, allowedValues, code, field, message }) {
  const normalized = clean(rawValue).toLowerCase();
  if (normalized && !allowedValues.includes(normalized)) diagnostics.push(errorDiagnostic(code, field, message));
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function positiveInteger(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isoTimestamp(value = '') {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function clean(value = '', maximum = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}
