import crypto from 'node:crypto';

import { projectUBuddyCapabilityProfileForPreview } from '../../../../shared/contracts/uBuddyCapabilityProfile.js';

import {
  fallbackUBuddyCapabilityProfile,
  generateUBuddyCapabilityProfile,
  UBUDDY_CAPABILITY_PROFILE_GENERATOR_VERSION,
} from '../domain/uBuddyCapabilityProfileGenerator.js';

export function createUBuddyCapabilityProfilePreviewService({
  auth, store, org, featureFlags, generateProfile = generateUBuddyCapabilityProfile, now = () => new Date(),
} = {}) {
  return {
    async preview() {
      const user = auth.requireUser();
      const workspaceId = store.activeAccountWorkspace?.({
        userId: user.id,
        deviceId: store.contextDeviceId?.() || 'local',
      })?.id || '';
      const enabled = featureFlags?.snapshot?.({ userId: user.id, workspaceId })?.profilePreviewV1 === true;
      if (!enabled) return { enabled: false, reason: 'feature_flag_disabled' };

      const source = resolvePreviewSkillSource({ store, org, userId: user.id });
      let generatedAt = new Date();
      try {
        generatedAt = now();
        const profile = await generateProfile({
          ownerUserId: user.id,
          uBuddyAgentInstanceId: source.agentInstanceId,
          effectiveSkill: source.effectiveSkill,
          effectiveSkillHash: source.effectiveSkillHash,
          now: generatedAt,
        });
        return previewResult(profile, 'generated');
      } catch {
        const profile = fallbackUBuddyCapabilityProfile({
          ownerUserId: user.id,
          uBuddyAgentInstanceId: source.agentInstanceId,
          effectiveSkillHash: source.effectiveSkillHash,
          now: generatedAt,
        });
        return previewResult(profile, 'fallback');
      }
    },
  };
}

function resolvePreviewSkillSource({ store, org, userId = '' } = {}) {
  let agentInstanceId = 'secretary_agent';
  let effectiveSkill = '';
  let effectiveSkillHash = '';
  try {
    const instance = store.findUserAgentInstance?.({ userId, agentFamilyId: 'secretary_agent' }) || null;
    if (instance?.id) agentInstanceId = instance.id;
    const resolution = instance?.id ? store.resolveEffectiveSkill?.({ agentInstanceId: instance.id }) : null;
    effectiveSkill = String(resolution?.effectiveSkill || '').trim();
    effectiveSkillHash = String(resolution?.effectiveSkillHash || '').trim();
  } catch {}
  if (!effectiveSkill) {
    try { effectiveSkill = String(org?.readSkill?.(org?.agent?.('secretary_agent')) || '').trim(); } catch {}
  }
  effectiveSkillHash = sha256(effectiveSkill);
  return { agentInstanceId, effectiveSkill, effectiveSkillHash };
}

function previewResult(profile, source) {
  return {
    enabled: true,
    source,
    generatedLocally: true,
    persisted: false,
    published: false,
    generatorVersion: UBUDDY_CAPABILITY_PROFILE_GENERATOR_VERSION,
    profile: projectUBuddyCapabilityProfileForPreview(profile),
  };
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
