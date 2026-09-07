import { nowIso } from '../../../utils.js';
import {
  normalizeUBuddyCapabilityProfile,
  redactUBuddyCapabilityProfileSensitiveContent,
  validateUBuddyCapabilityProfile,
} from '../../../../shared/contracts/uBuddyCapabilityProfile.js';
import { generateUBuddyCapabilityProfile } from '../../orchestration/index.js';

const SECRETARY_AGENT_FAMILY_ID = 'secretary_agent';
const PREFERENCE_PREFIX = 'ubuddy:capability_profile_publication:';

export function createUBuddyCapabilityProfileService({ store, generator = null, enabled = () => true, currentUserId = () => '' } = {}) {
  const jobs = new Map();
  const publicationJobs = new Set();
  let autoPublisher = null;

  const preferenceFor = (userId) => normalizePreference(safeJson(store.settingGet(`${PREFERENCE_PREFIX}${userId}`, '{}')));
  const savePreference = (userId, value) => {
    const normalized = normalizePreference(value);
    store.settingSet(`${PREFERENCE_PREFIX}${userId}`, JSON.stringify(normalized));
    return normalized;
  };
  const queueAutoPublication = ({ userId, record, preference }) => {
    if (!autoPublisher || !record || record.publicationState !== 'active' || record.requiresUserConfirmation
      || !preference.enabled || !preference.authorizedAt
      || Number(preference.lastPublishedRevision || 0) === Number(record.profileRevision || 0)) return null;
    let task = null;
    task = Promise.resolve().then(() => autoPublisher({
      userId,
      profile: record.profile,
      profileRevision: record.profileRevision,
      contentHash: record.contentHash,
      preference,
    })).catch(() => null).finally(() => publicationJobs.delete(task));
    publicationJobs.add(task);
    return task;
  };
  const resolveBuddy = ({ userId = '', agentInstanceId = '' } = {}) => {
    const instance = agentInstanceId
      ? store.getUserAgentInstance(agentInstanceId)
      : store.findUserAgentInstance({ userId, agentFamilyId: SECRETARY_AGENT_FAMILY_ID });
    if (!instance || instance.userId !== userId || instance.agentFamilyId !== SECRETARY_AGENT_FAMILY_ID) return null;
    const skillResolution = store.resolveEffectiveSkill({ agentInstanceId: instance.id });
    if (!skillResolution) return null;
    return {
      instance,
      resolution: {
        ...skillResolution,
        family: store.getAgentFamily(instance.agentFamilyId),
      },
    };
  };

  const runGeneration = async ({ userId, agentInstanceId, profileRevision, trigger, sourceResolution }) => {
    const buddy = resolveBuddy({ userId, agentInstanceId });
    if (!buddy) throw new Error('uBuddy Agent instance is unavailable.');
    const resolution = sourceResolution || buddy.resolution;
    const preference = preferenceFor(userId);
    store.updateUBuddyCapabilityProfileGeneration({
      ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision, generationStatus: 'generating',
    });
    try {
      const generated = await generateProfile(generator, {
        userId,
        uBuddyAgentInstanceId: agentInstanceId,
        profileRevision,
        sourceEffectiveSkillHash: resolution.effectiveSkillHash,
        effectiveSkill: resolution.effectiveSkill,
        family: resolution.family,
        baseVersion: resolution.baseVersion,
        personalSkillVersion: resolution.personalSkillVersion,
        trigger,
      });
      const profile = normalizeUBuddyCapabilityProfile({
        ...generated,
        ownerUserId: userId,
        uBuddyAgentInstanceId: agentInstanceId,
        profileRevision,
        sourceEffectiveSkillHash: resolution.effectiveSkillHash,
        publicationState: 'draft',
        visibility: generated?.visibility || preference.visibility,
        generatedAt: generated?.generatedAt || nowIso(),
      });
      const validation = validateUBuddyCapabilityProfile(profile);
      const privacyRisks = validation.diagnostics.filter(isPrivacyDiagnostic);
      const structuralDiagnostics = validation.diagnostics.filter((item) => !isPrivacyDiagnostic(item));
      const hasBlockingPrivacyRisk = privacyRisks.some((item) => item.severity === 'error');
      const currentResolution = resolveBuddy({ userId, agentInstanceId })?.resolution || null;
      if (!currentResolution || currentResolution.effectiveSkillHash !== resolution.effectiveSkillHash) {
        const storedProfile = hasBlockingPrivacyRisk
          ? redactUBuddyCapabilityProfileSensitiveContent(profile)
          : profile;
        const stale = store.completeUBuddyCapabilityProfileDraft({
          ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision, profile: storedProfile,
          validation: hasBlockingPrivacyRisk ? safeRejectedValidation(validation) : validation,
          capabilityScope: hasBlockingPrivacyRisk ? {} : capabilityScope(profile), privacyRisks, publicationState: 'rejected',
          requiresUserConfirmation: false, confirmationReason: 'source_skill_superseded',
        });
        queueMicrotask(() => schedule({ userId, agentInstanceId, trigger: 'superseded_generation_reconcile' }));
        return stale;
      }
      if (hasBlockingPrivacyRisk) {
        const redactedProfile = redactUBuddyCapabilityProfileSensitiveContent(profile);
        return store.completeUBuddyCapabilityProfileDraft({
          ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision, profile: redactedProfile,
          validation: safeRejectedValidation(validation), capabilityScope: {}, privacyRisks, publicationState: 'rejected',
          requiresUserConfirmation: false, confirmationReason: 'privacy_validation_failed',
        });
      }
      if (structuralDiagnostics.some((item) => item.severity === 'error')) {
        return store.completeUBuddyCapabilityProfileDraft({
          ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision, profile,
          validation: { ...validation, diagnostics: structuralDiagnostics },
          capabilityScope: capabilityScope(profile), privacyRisks, publicationState: 'rejected',
          confirmationReason: 'validation_failed',
        });
      }
      const active = store.getActiveUBuddyCapabilityProfileRecord({ ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId });
      const scope = capabilityScope(profile);
      const approvedScope = preference.authorizedAt
        ? nonEmptyCapabilityScope(preference.approvedCapabilityScope) || active?.capabilityScope || null
        : null;
      const expanded = approvedScope ? expandedCapabilityScope(approvedScope, scope) : [];
      const confirmationReasons = [
        ...(expanded.length ? ['capability_scope_expanded'] : []),
        ...(!preference.authorizedAt ? ['first_publication_authorization'] : []),
      ];
      let record = store.completeUBuddyCapabilityProfileDraft({
        ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision, profile,
        validation, capabilityScope: scope, privacyRisks: [], publicationState: 'validated',
        requiresUserConfirmation: confirmationReasons.length > 0,
        confirmationReason: confirmationReasons.join(','),
      });
      if (record.requiresUserConfirmation && active) return record;
      record = store.activateUBuddyCapabilityProfile({
        ownerUserId: userId,
        uBuddyAgentInstanceId: agentInstanceId,
        profileRevision,
        allowUnconfirmedLocalActivation: record.confirmationReason === 'first_publication_authorization' && !active,
      });
      queueAutoPublication({ userId, record, preference });
      return record;
    } catch (error) {
      store.updateUBuddyCapabilityProfileGeneration({
        ownerUserId: userId, uBuddyAgentInstanceId: agentInstanceId, profileRevision,
        generationStatus: 'failed', generationError: error?.message || error,
      });
      throw error;
    }
  };

  const schedule = ({ userId = '', agentInstanceId = '', trigger = 'skill_changed', force = false } = {}) => {
    if (!enabled({ userId })) return { status: 'disabled' };
    const buddy = resolveBuddy({ userId, agentInstanceId });
    if (!buddy) return { status: 'ignored', reason: 'not_ubuddy' };
    const reservation = store.reserveUBuddyCapabilityProfileDraft({
      ownerUserId: userId,
      uBuddyAgentInstanceId: buddy.instance.id,
      sourceEffectiveSkillHash: buddy.resolution.effectiveSkillHash,
      trigger,
    });
    let existing = reservation.profile;
    if (reservation.idempotent && existing?.generationStatus === 'completed'
      && existing.contentHash && existing?.profile && Object.keys(existing.profile).length) {
      const existingValidation = validateUBuddyCapabilityProfile(existing.profile);
      const existingPrivacyRisks = existingValidation.diagnostics.filter(isPrivacyDiagnostic);
      if (!existingValidation.valid) {
        const sensitive = existingPrivacyRisks.some((item) => item.severity === 'error');
        existing = store.quarantineUBuddyCapabilityProfile({
          ownerUserId: userId,
          uBuddyAgentInstanceId: buddy.instance.id,
          profileRevision: existing.profileRevision,
          profile: sensitive ? redactUBuddyCapabilityProfileSensitiveContent(existing.profile) : existing.profile,
          validation: safeRejectedValidation(existingValidation),
          privacyRisks: existingPrivacyRisks,
          reason: sensitive ? 'sensitive_profile_quarantined' : 'stored_profile_validation_failed',
        });
        savePreference(userId, { ...preferenceFor(userId), enabled: false, visibility: 'private' });
        force = true;
      }
    }
    const key = `${userId}:${buddy.instance.id}:${existing.profileRevision}`;
    if (jobs.has(key)) return { status: 'idempotent', profile: existing };
    const recoverInterrupted = reservation.idempotent && !force
      && ['pending', 'generating'].includes(existing.generationStatus)
      && ['startup_reconcile', 'settings_opened', 'superseded_generation_reconcile'].includes(trigger);
    if (reservation.idempotent && !force && !recoverInterrupted) {
      let restored = existing;
      if (['archived', 'validated'].includes(existing.publicationState) && existing.generationStatus === 'completed') {
        const currentPreference = preferenceFor(userId);
        const approvedScope = currentPreference.authorizedAt
          ? nonEmptyCapabilityScope(currentPreference.approvedCapabilityScope)
          : null;
        const approvalCoversProfile = Boolean(approvedScope)
          && expandedCapabilityScope(approvedScope, existing.capabilityScope).length === 0;
        try {
          const inheritApprovedScope = existing.requiresUserConfirmation
            && !existing.userConfirmedAt && approvalCoversProfile;
          if (existing.requiresUserConfirmation && !existing.userConfirmedAt && !inheritApprovedScope) throw profileError(
            'ubuddy_profile_confirmation_required', '该简介需要人工确认后才能启用。',
          );
          restored = store.activateUBuddyCapabilityProfile({
            ownerUserId: userId,
            uBuddyAgentInstanceId: buddy.instance.id,
            profileRevision: existing.profileRevision,
            confirmed: Boolean(existing.userConfirmedAt),
            inheritApprovedScope,
          });
        } catch {
          restored = store.getUBuddyCapabilityProfile({
            ownerUserId: userId,
            uBuddyAgentInstanceId: buddy.instance.id,
            profileRevision: existing.profileRevision,
          }) || existing;
        }
      }
      queueAutoPublication({ userId, record: restored, preference: preferenceFor(userId) });
      return { status: restored.publicationState === 'active' && existing.publicationState !== 'active' ? 'reactivated' : 'idempotent', profile: restored };
    }
    if (reservation.idempotent && force && !(['failed', 'pending'].includes(existing.generationStatus)
      || existing.publicationState === 'rejected')) {
      return { status: 'idempotent', profile: existing };
    }
    if (!jobs.has(key)) {
      const job = Promise.resolve()
        .then(() => runGeneration({
          userId,
          agentInstanceId: buddy.instance.id,
          profileRevision: existing.profileRevision,
          trigger,
          sourceResolution: buddy.resolution,
        }))
        .catch(() => null)
        .finally(() => jobs.delete(key));
      jobs.set(key, job);
    }
    return { status: 'queued', profile: existing };
  };

  return {
    scheduleUBuddyCapabilityProfileGeneration: schedule,
    reconcileUBuddyCapabilityProfile({ userId = '', trigger = 'startup_reconcile' } = {}) {
      return schedule({ userId, trigger });
    },
    async waitForIdle() {
      await Promise.resolve();
      while (jobs.size || publicationJobs.size) {
        await Promise.allSettled([...jobs.values(), ...publicationJobs]);
        await Promise.resolve();
      }
    },
    setAutoPublisher(handler = null) {
      autoPublisher = typeof handler === 'function' ? handler : null;
    },
    listUBuddyCapabilityProfileHistory({ userId = '', limit = 100 } = {}) {
      const buddy = resolveBuddy({ userId });
      if (!buddy) return [];
      return store.listUBuddyCapabilityProfileHistory({ ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id, limit });
    },
    getActiveUBuddyCapabilityProfile({ userId = '' } = {}) {
      const buddy = resolveBuddy({ userId });
      if (!buddy) return null;
      const active = store.getActiveUBuddyCapabilityProfileRecord({ ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id });
      if (!active) return null;
      const validation = validateUBuddyCapabilityProfile(active.profile);
      if (validation.valid) return validation.value;
      const privacyRisks = validation.diagnostics.filter(isPrivacyDiagnostic);
      store.quarantineUBuddyCapabilityProfile({
        ownerUserId: userId,
        uBuddyAgentInstanceId: buddy.instance.id,
        profileRevision: active.profileRevision,
        profile: redactUBuddyCapabilityProfileSensitiveContent(active.profile),
        validation: safeRejectedValidation(validation),
        privacyRisks,
      });
      savePreference(userId, { ...preferenceFor(userId), enabled: false, visibility: 'private' });
      return null;
    },
    getUBuddyProfilePublicationPreference({ userId = '' } = {}) {
      return preferenceFor(userId);
    },
    setUBuddyProfilePublicationPreference({ userId = '', enabled: publishEnabled, visibility = '' } = {}) {
      const current = preferenceFor(userId);
      const nextVisibility = ['friends', 'organization'].includes(visibility) ? visibility : publishEnabled === false ? 'private' : current.visibility;
      return savePreference(userId, {
        ...current,
        enabled: publishEnabled === undefined ? current.enabled : Boolean(publishEnabled),
        visibility: nextVisibility,
      });
    },
    authorizeUBuddyProfilePublication({ userId = '', visibility = 'friends', profileRevision = 0 } = {}) {
      const current = preferenceFor(userId);
      const buddy = resolveBuddy({ userId });
      const active = buddy ? store.getActiveUBuddyCapabilityProfileRecord({
        ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id,
      }) : null;
      if (!active) {
        throw profileError('ubuddy_profile_not_found', '当前没有可公开的 uBuddy 简介。');
      }
      if (profileRevision && Number(active?.profileRevision || 0) !== Number(profileRevision)) {
        throw profileError('ubuddy_profile_publication_revision_conflict', '待发布的 uBuddy 简介版本已经变化。');
      }
      if (active.requiresUserConfirmation
        && active.sourceEffectiveSkillHash !== buddy.resolution.effectiveSkillHash) {
        throw profileError('ubuddy_profile_source_skill_stale', '该简介对应的 Skill 已不是当前生效版本，请审核最新简介。');
      }
      if (active?.privacyRisks?.length) {
        throw profileError('ubuddy_profile_sensitive_content_blocked', '该简介包含必须删除的敏感内容，不能公开。');
      }
      const confirmed = active?.requiresUserConfirmation
        ? store.activateUBuddyCapabilityProfile({
          ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id,
          profileRevision: active.profileRevision, confirmed: true,
        })
        : active;
      return savePreference(userId, {
        ...current,
        enabled: true,
        visibility: ['friends', 'organization'].includes(visibility) ? visibility : 'friends',
        authorizedAt: current.authorizedAt || nowIso(),
        approvedCapabilityScope: confirmed?.capabilityScope || current.approvedCapabilityScope,
        approvedCapabilityScopeHash: confirmed?.capabilityScopeHash || current.approvedCapabilityScopeHash,
        approvedProfileRevision: confirmed?.profileRevision || current.approvedProfileRevision,
      });
    },
    async reviewUBuddyCapabilityProfile({ userId = '', profileRevision = 0, decision = '', visibility = 'friends' } = {}) {
      const buddy = resolveBuddy({ userId });
      if (!buddy) throw new Error('uBuddy Agent instance is unavailable.');
      const record = store.getUBuddyCapabilityProfile({
        ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id, profileRevision,
      });
      if (!record) throw new Error('uBuddy 简介版本不存在。');
      if (decision === 'reject') {
        if (record.publicationState === 'active') {
          if (!record.requiresUserConfirmation) {
            throw profileError('ubuddy_profile_review_not_pending', '当前生效简介没有待处理的审核请求。');
          }
          const rejected = store.rejectActiveUBuddyCapabilityProfile({
            ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id, profileRevision,
          });
          savePreference(userId, { ...preferenceFor(userId), enabled: false, visibility: 'private' });
          return rejected;
        }
        return store.rejectUBuddyCapabilityProfile({
          ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id, profileRevision, reason: 'user_rejected',
        });
      }
      if (decision !== 'approve') throw new Error('uBuddy 简介审核决定无效。');
      if (record.sourceEffectiveSkillHash !== buddy.resolution.effectiveSkillHash) {
        throw profileError('ubuddy_profile_source_skill_stale', '该简介对应的 Skill 已不是当前生效版本，请审核最新简介。');
      }
      if (record.privacyRisks.length) {
        const error = new Error('简介包含必须删除的敏感内容，不能通过人工确认启用或发布。');
        error.code = 'ubuddy_profile_sensitive_content_blocked';
        throw error;
      }
      const active = store.activateUBuddyCapabilityProfile({
        ownerUserId: userId, uBuddyAgentInstanceId: buddy.instance.id, profileRevision, confirmed: true,
      });
      const preference = savePreference(userId, {
        ...preferenceFor(userId), enabled: true,
        visibility: ['friends', 'organization'].includes(visibility) ? visibility : 'friends',
        authorizedAt: preferenceFor(userId).authorizedAt || nowIso(),
        approvedCapabilityScope: active.capabilityScope,
        approvedCapabilityScopeHash: active.capabilityScopeHash,
        approvedProfileRevision: active.profileRevision,
      });
      let publication = null;
      if (autoPublisher) {
        try {
          publication = await autoPublisher({
            userId,
            profile: { ...active.profile, visibility: preference.visibility },
            profileRevision: active.profileRevision,
            contentHash: active.contentHash,
            preference,
          });
        } catch (error) {
          publication = { status: 'deferred', error: String(error?.message || error || 'publication_failed') };
        }
      }
      return { profile: active, preference, publication };
    },
    markUBuddyCapabilityProfilePublication({ operationKind = '', profileRevision = 0, stateRevision = 0, ownerUserId = '', userId: suppliedUserId = '' } = {}) {
      const userId = ownerUserId || suppliedUserId || currentUserId();
      if (!userId) return null;
      const current = preferenceFor(userId);
      const buddy = resolveBuddy({ userId });
      const published = buddy && profileRevision ? store.getUBuddyCapabilityProfile({
        ownerUserId: userId,
        uBuddyAgentInstanceId: buddy.instance.id,
        profileRevision,
      }) : null;
      return savePreference(userId, {
        ...current,
        lastPublishedRevision: operationKind === 'unpublish' ? 0 : Number(profileRevision || current.lastPublishedRevision || 0),
        lastCloudStateRevision: Number(stateRevision || current.lastCloudStateRevision || 0),
        lastPublishedAt: nowIso(),
        approvedCapabilityScope: operationKind === 'unpublish' ? current.approvedCapabilityScope : published?.capabilityScope || current.approvedCapabilityScope,
        approvedCapabilityScopeHash: operationKind === 'unpublish' ? current.approvedCapabilityScopeHash : published?.capabilityScopeHash || current.approvedCapabilityScopeHash,
        approvedProfileRevision: operationKind === 'unpublish' ? current.approvedProfileRevision : published?.profileRevision || current.approvedProfileRevision,
      });
    },
  };
}

async function generateProfile(generator, context) {
  if (typeof generator === 'function') return generator(context);
  if (typeof generator?.generateUBuddyCapabilityProfile === 'function') return generator.generateUBuddyCapabilityProfile(context);
  if (typeof generator?.generate === 'function') return generator.generate(context);
  return generateUBuddyCapabilityProfile({ ...context, now: new Date() });
}

function capabilityScope(profile = {}) {
  return {
    supportedTaskTypes: sorted(profile.supportedTaskTypes),
    deliverableTypes: sorted(profile.deliverableTypes),
    capabilityTags: sorted(profile.capabilityTags),
    collaborationModes: sorted(profile.collaborationModes),
  };
}

function safeRejectedValidation(validation = {}) {
  return {
    valid: false,
    diagnostics: (Array.isArray(validation?.diagnostics) ? validation.diagnostics : []).map((item) => ({
      severity: String(item?.severity || 'error'),
      code: String(item?.code || ''),
      field: String(item?.field || ''),
      message: String(item?.message || ''),
    })),
  };
}

function expandedCapabilityScope(previous = {}, next = {}) {
  const additions = [];
  for (const key of ['supportedTaskTypes', 'deliverableTypes', 'capabilityTags', 'collaborationModes']) {
    const before = new Set(Array.isArray(previous?.[key]) ? previous[key] : []);
    for (const value of Array.isArray(next?.[key]) ? next[key] : []) {
      if (!before.has(value)) additions.push(`${key}:${value}`);
    }
  }
  return additions;
}

function sorted(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

function isPrivacyDiagnostic(item = {}) {
  return String(item.code || '').startsWith('profile_contains_');
}

function normalizePreference(value = {}) {
  const visibility = ['private', 'friends', 'organization'].includes(value?.visibility) ? value.visibility : 'private';
  return {
    enabled: Boolean(value?.enabled) && visibility !== 'private',
    visibility,
    authorizedAt: String(value?.authorizedAt || ''),
    lastPublishedRevision: Number(value?.lastPublishedRevision || 0),
    lastCloudStateRevision: Number(value?.lastCloudStateRevision || 0),
    lastPublishedAt: String(value?.lastPublishedAt || ''),
    approvedCapabilityScope: nonEmptyCapabilityScope(value?.approvedCapabilityScope) || {},
    approvedCapabilityScopeHash: String(value?.approvedCapabilityScopeHash || ''),
    approvedProfileRevision: Number(value?.approvedProfileRevision || 0),
  };
}

function nonEmptyCapabilityScope(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = capabilityScope(value);
  return Object.values(normalized).some((items) => items.length) ? normalized : null;
}

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeJson(value = '') {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}
