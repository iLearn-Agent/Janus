import { all, get, run } from '../../../db.js';
import { nowIso, sha256Text } from '../../../utils.js';

const PROFILE_STATES = new Set(['draft', 'validated', 'active', 'archived', 'rejected']);
const GENERATION_STATES = new Set(['pending', 'generating', 'completed', 'failed']);

export function installUBuddyCapabilityProfileStoreMethods(prototype) {
  Object.assign(prototype, {
    reserveUBuddyCapabilityProfileDraft({ ownerUserId = '', uBuddyAgentInstanceId = '', sourceEffectiveSkillHash = '', trigger = 'skill_changed' } = {}) {
      const ownerId = clean(ownerUserId);
      const instanceId = clean(uBuddyAgentInstanceId);
      const skillHash = clean(sourceEffectiveSkillHash);
      if (!ownerId || !instanceId || !skillHash) throw new Error('uBuddy Profile draft identity is incomplete.');
      const existing = get(this.db, `SELECT * FROM ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND source_effective_skill_hash=?`, [ownerId, instanceId, skillHash]);
      if (existing) return { profile: normalizeRow(existing), idempotent: true };
      const withinTransaction = Boolean(this.db.inTransaction);
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const duplicate = get(this.db, `SELECT * FROM ubuddy_capability_profiles
          WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND source_effective_skill_hash=?`, [ownerId, instanceId, skillHash]);
        if (duplicate) {
          if (!withinTransaction) this.db.exec('COMMIT');
          return { profile: normalizeRow(duplicate), idempotent: true };
        }
        const revision = Number(get(this.db, `SELECT COALESCE(MAX(profile_revision),0)+1 AS revision
          FROM ubuddy_capability_profiles WHERE owner_user_id=? AND ubuddy_agent_instance_id=?`, [ownerId, instanceId])?.revision || 1);
        const now = nowIso();
        run(this.db, `INSERT INTO ubuddy_capability_profiles(
          owner_user_id,ubuddy_agent_instance_id,profile_revision,source_effective_skill_hash,
          publication_state,generation_status,generation_trigger,created_at,updated_at
        ) VALUES(?,?,?,?, 'draft','pending',?,?,?)`, [ownerId, instanceId, revision, skillHash, clean(trigger, 120) || 'skill_changed', now, now]);
        const row = get(this.db, `SELECT * FROM ubuddy_capability_profiles
          WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [ownerId, instanceId, revision]);
        if (!withinTransaction) this.db.exec('COMMIT');
        return { profile: normalizeRow(row), idempotent: false };
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    updateUBuddyCapabilityProfileGeneration({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0, generationStatus = '', generationError = '' } = {}) {
      const status = GENERATION_STATES.has(generationStatus) ? generationStatus : 'failed';
      run(this.db, `UPDATE ubuddy_capability_profiles SET generation_status=?,generation_error=?,updated_at=?
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [
        status, clean(generationError, 2_000), nowIso(), clean(ownerUserId), clean(uBuddyAgentInstanceId), positiveInteger(profileRevision),
      ]);
      return this.getUBuddyCapabilityProfile({ ownerUserId, uBuddyAgentInstanceId, profileRevision });
    },

    completeUBuddyCapabilityProfileDraft({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0, profile = {}, validation = {}, capabilityScope = {}, privacyRisks = [], publicationState = 'validated', requiresUserConfirmation = false, confirmationReason = '' } = {}) {
      const state = PROFILE_STATES.has(publicationState) ? publicationState : 'rejected';
      const now = nowIso();
      const profileJson = JSON.stringify(profile || {});
      const scopeJson = JSON.stringify(capabilityScope || {});
      const updated = run(this.db, `UPDATE ubuddy_capability_profiles SET
        profile_version=?,publication_state=?,generation_status='completed',profile_json=?,content_hash=?,
        validation_json=?,capability_scope_json=?,capability_scope_hash=?,privacy_risk_json=?,
        requires_user_confirmation=?,confirmation_reason=?,generation_error='',generated_at=?,validated_at=?,
        rejected_at=?,updated_at=?
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?
          AND publication_state IN ('draft','rejected')`, [
        clean(profile?.version) || 'ubuddy_capability_profile_v1', state, profileJson, sha256Text(profileJson),
        JSON.stringify(validation || {}), scopeJson, sha256Text(scopeJson), JSON.stringify(Array.isArray(privacyRisks) ? privacyRisks : []),
        requiresUserConfirmation ? 1 : 0, clean(confirmationReason, 500), now,
        state === 'rejected' ? '' : now, state === 'rejected' ? now : '', now,
        clean(ownerUserId), clean(uBuddyAgentInstanceId), positiveInteger(profileRevision),
      ]);
      if (Number(updated?.changes || 0) !== 1) {
        throw profileError('ubuddy_profile_draft_not_mutable', '只有草稿或已拒绝的简介版本可以写入生成结果。');
      }
      return this.getUBuddyCapabilityProfile({ ownerUserId, uBuddyAgentInstanceId, profileRevision });
    },

    activateUBuddyCapabilityProfile({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0,
      confirmed = false, inheritApprovedScope = false, allowUnconfirmedLocalActivation = false } = {}) {
      const ownerId = clean(ownerUserId);
      const instanceId = clean(uBuddyAgentInstanceId);
      const revision = positiveInteger(profileRevision);
      const target = get(this.db, `SELECT * FROM ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [ownerId, instanceId, revision]);
      if (!target) throw profileError('ubuddy_profile_not_found', 'uBuddy 简介版本不存在。');
      if (!['validated', 'active', 'archived'].includes(target.publication_state)) throw profileError('ubuddy_profile_not_validated', '只有验证通过的简介才能启用。');
      if (parseJson(target.privacy_risk_json, []).length) {
        throw profileError('ubuddy_profile_sensitive_content_blocked', '简介包含必须删除的敏感内容，不能启用。');
      }
      const inherited = Boolean(inheritApprovedScope);
      const otherActiveExists = Boolean(get(this.db, `SELECT 1 FROM ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND publication_state='active' AND profile_revision<>? LIMIT 1`, [
        ownerId, instanceId, revision,
      ]));
      const localActivationAllowed = Boolean(allowUnconfirmedLocalActivation)
        && String(target.confirmation_reason || '') === 'first_publication_authorization'
        && !otherActiveExists;
      if (target.requires_user_confirmation && !target.user_confirmed_at && !confirmed && !inherited && !localActivationAllowed) {
        throw profileError('ubuddy_profile_confirmation_required', '该简介需要人工确认后才能启用。');
      }
      if (target.publication_state === 'active') {
        if (confirmed || inherited) run(this.db, `UPDATE ubuddy_capability_profiles SET
          user_confirmed_at=CASE WHEN ? THEN COALESCE(NULLIF(user_confirmed_at,''),?) ELSE user_confirmed_at END,
          requires_user_confirmation=0,
          confirmation_reason=CASE WHEN ? THEN 'approved_scope_reused' ELSE confirmation_reason END,updated_at=?
          WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [
          confirmed ? 1 : 0, nowIso(), inherited ? 1 : 0, nowIso(), ownerId, instanceId, revision,
        ]);
        return this.getUBuddyCapabilityProfile({ ownerUserId: ownerId, uBuddyAgentInstanceId: instanceId, profileRevision: revision });
      }
      const now = nowIso();
      const withinTransaction = Boolean(this.db.inTransaction);
      if (!withinTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `UPDATE ubuddy_capability_profiles SET publication_state='archived',archived_at=?,updated_at=?
          WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND publication_state='active' AND profile_revision<>?`, [
          now, now, ownerId, instanceId, revision,
        ]);
        run(this.db, `UPDATE ubuddy_capability_profiles SET publication_state='active',activated_at=?,archived_at='',
          user_confirmed_at=CASE WHEN ? THEN COALESCE(NULLIF(user_confirmed_at,''),?) ELSE user_confirmed_at END,
          requires_user_confirmation=CASE WHEN ? OR ? THEN 0 ELSE requires_user_confirmation END,
          confirmation_reason=CASE WHEN ? THEN 'approved_scope_reused' ELSE confirmation_reason END,updated_at=?
          WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [
          now, confirmed ? 1 : 0, now, confirmed ? 1 : 0, inherited ? 1 : 0,
          inherited ? 1 : 0, now, ownerId, instanceId, revision,
        ]);
        if (!withinTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (!withinTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return this.getUBuddyCapabilityProfile({ ownerUserId: ownerId, uBuddyAgentInstanceId: instanceId, profileRevision: revision });
    },

    rejectUBuddyCapabilityProfile({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0, reason = 'user_rejected' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_capability_profiles SET publication_state='rejected',confirmation_reason=?,
        requires_user_confirmation=0,rejected_at=?,updated_at=?
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=? AND publication_state<>'active'`, [
        clean(reason, 500), now, now, clean(ownerUserId), clean(uBuddyAgentInstanceId), positiveInteger(profileRevision),
      ]);
      return this.getUBuddyCapabilityProfile({ ownerUserId, uBuddyAgentInstanceId, profileRevision });
    },

    rejectActiveUBuddyCapabilityProfile({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0,
      reason = 'user_rejected' } = {}) {
      const now = nowIso();
      const updated = run(this.db, `UPDATE ubuddy_capability_profiles SET publication_state='rejected',
        requires_user_confirmation=0,confirmation_reason=?,rejected_at=?,updated_at=?
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?
          AND publication_state='active' AND requires_user_confirmation=1`, [
        clean(reason, 500), now, now, clean(ownerUserId), clean(uBuddyAgentInstanceId), positiveInteger(profileRevision),
      ]);
      if (Number(updated?.changes || 0) !== 1) {
        throw profileError('ubuddy_profile_review_not_pending', '当前生效简介没有待处理的审核请求。');
      }
      return this.getUBuddyCapabilityProfile({ ownerUserId, uBuddyAgentInstanceId, profileRevision });
    },

    getUBuddyCapabilityProfile({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0, sourceEffectiveSkillHash = '' } = {}) {
      const predicates = ['owner_user_id=?', 'ubuddy_agent_instance_id=?'];
      const params = [clean(ownerUserId), clean(uBuddyAgentInstanceId)];
      if (positiveInteger(profileRevision)) { predicates.push('profile_revision=?'); params.push(positiveInteger(profileRevision)); }
      if (sourceEffectiveSkillHash) { predicates.push('source_effective_skill_hash=?'); params.push(clean(sourceEffectiveSkillHash)); }
      return normalizeRow(get(this.db, `SELECT * FROM ubuddy_capability_profiles WHERE ${predicates.join(' AND ')}
        ORDER BY profile_revision DESC LIMIT 1`, params));
    },

    getActiveUBuddyCapabilityProfileRecord({ ownerUserId = '', uBuddyAgentInstanceId = '' } = {}) {
      return normalizeRow(get(this.db, `SELECT * FROM ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND publication_state='active' LIMIT 1`, [
        clean(ownerUserId), clean(uBuddyAgentInstanceId),
      ]));
    },

    quarantineUBuddyCapabilityProfile({ ownerUserId = '', uBuddyAgentInstanceId = '', profileRevision = 0,
      profile = {}, validation = {}, privacyRisks = [], reason = 'sensitive_profile_quarantined' } = {}) {
      const now = nowIso();
      const profileJson = JSON.stringify(profile || {});
      run(this.db, `UPDATE ubuddy_capability_profiles SET publication_state='rejected',generation_status='completed',
        profile_json=?,content_hash=?,validation_json=?,capability_scope_json='{}',capability_scope_hash=?,
        privacy_risk_json=?,requires_user_confirmation=0,confirmation_reason=?,user_confirmed_at='',
        generation_error=?,rejected_at=CASE WHEN rejected_at='' THEN ? ELSE rejected_at END,
        updated_at=? WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`, [
        profileJson, sha256Text(profileJson), JSON.stringify(validation || {}), sha256Text('{}'),
        JSON.stringify(Array.isArray(privacyRisks) ? privacyRisks : []), clean(reason, 500), clean(reason, 2_000), now, now,
        clean(ownerUserId), clean(uBuddyAgentInstanceId), positiveInteger(profileRevision),
      ]);
      return this.getUBuddyCapabilityProfile({ ownerUserId, uBuddyAgentInstanceId, profileRevision });
    },

    listUBuddyCapabilityProfileHistory({ ownerUserId = '', uBuddyAgentInstanceId = '', limit = 100 } = {}) {
      return all(this.db, `SELECT * FROM ubuddy_capability_profiles
        WHERE owner_user_id=? AND ubuddy_agent_instance_id=? ORDER BY profile_revision DESC LIMIT ?`, [
        clean(ownerUserId), clean(uBuddyAgentInstanceId), Math.max(1, Math.min(500, Number(limit) || 100)),
      ]).map(normalizeRow);
    },
  });
}

function normalizeRow(row = null) {
  if (!row) return null;
  const storedProfile = parseJson(row.profile_json, {});
  return {
    ownerUserId: row.owner_user_id || '',
    uBuddyAgentInstanceId: row.ubuddy_agent_instance_id || '',
    profileRevision: Number(row.profile_revision || 0),
    sourceEffectiveSkillHash: row.source_effective_skill_hash || '',
    profileVersion: row.profile_version || 'ubuddy_capability_profile_v1',
    publicationState: row.publication_state || 'draft',
    generationStatus: row.generation_status || 'pending',
    generationTrigger: row.generation_trigger || '',
    profile: {
      ...storedProfile,
      ownerUserId: row.owner_user_id || storedProfile.ownerUserId || '',
      uBuddyAgentInstanceId: row.ubuddy_agent_instance_id || storedProfile.uBuddyAgentInstanceId || '',
      profileRevision: Number(row.profile_revision || storedProfile.profileRevision || 0),
      sourceEffectiveSkillHash: row.source_effective_skill_hash || storedProfile.sourceEffectiveSkillHash || '',
      publicationState: row.publication_state || storedProfile.publicationState || 'draft',
      generatedAt: row.generated_at || storedProfile.generatedAt || '',
      approvedAt: row.user_confirmed_at || storedProfile.approvedAt || '',
    },
    contentHash: row.content_hash || '',
    validation: parseJson(row.validation_json, {}),
    capabilityScope: parseJson(row.capability_scope_json, {}),
    capabilityScopeHash: row.capability_scope_hash || '',
    privacyRisks: parseJson(row.privacy_risk_json, []),
    requiresUserConfirmation: Boolean(row.requires_user_confirmation),
    confirmationReason: row.confirmation_reason || '',
    userConfirmedAt: row.user_confirmed_at || '',
    generationError: row.generation_error || '',
    generatedAt: row.generated_at || '',
    validatedAt: row.validated_at || '',
    activatedAt: row.activated_at || '',
    archivedAt: row.archived_at || '',
    rejectedAt: row.rejected_at || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function parseJson(value = '', fallback = {}) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function positiveInteger(value) {
  const number = Math.floor(Number(value || 0));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function clean(value = '', maximum = 240) {
  return String(value || '').trim().slice(0, maximum);
}

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
