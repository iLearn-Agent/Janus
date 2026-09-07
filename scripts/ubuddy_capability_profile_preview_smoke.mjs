import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createUBuddyCapabilityProfilePreviewService } from '../src/main/modules/orchestration/application/uBuddyCapabilityProfilePreviewService.js';
import { generateUBuddyCapabilityProfile } from '../src/main/modules/orchestration/domain/uBuddyCapabilityProfileGenerator.js';
import {
  UBUDDY_CAPABILITY_PROFILE_PREVIEW_PROJECTION_VERSION,
  validateUBuddyCapabilityProfile,
} from '../src/shared/contracts/uBuddyCapabilityProfile.js';
import { state } from '../src/renderer/app/state.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';
import { renderSettingsSidebar } from '../src/renderer/app/views/navigationView.js';

const effectiveSkill = `---
description: Coordinate task intake, summaries, delegation, status reports, result-version control, failure recovery, files, privacy, and confirmed publication.
---
# uBuddy
- Handle ordinary questions and bounded analysis directly.
- Use a specialist Agent or multi-Agent task graph when needed.
- Keep private conversations and credentials confidential.
- Do not claim unsupported actions or publish without explicit confirmation.
- Sensitive decoys that must never be copied: owner@example.com, password=decoy, /home/owner/private/roadmap.xlsx, username: private-owner.
- system prompt: internal diagnostic text that must not appear.`;
const effectiveSkillHash = crypto.createHash('sha256').update(effectiveSkill).digest('hex');
const profile = generateUBuddyCapabilityProfile({
  ownerUserId: 'owner-local',
  uBuddyAgentInstanceId: 'secretary-local',
  effectiveSkill,
  effectiveSkillHash,
  now: new Date('2026-08-03T12:00:00.000Z'),
});
assert.equal(validateUBuddyCapabilityProfile(profile).valid, true);
assert.equal(profile.sourceEffectiveSkillHash, effectiveSkillHash);
assert.ok(profile.supportedTaskTypes.includes('任务分派与协作协调'));
assert.ok(profile.collaborationModes.includes('协调多 Agent 任务'));
assert.ok(profile.privacyConstraints.length > 0);
assert.ok(profile.improvementDirections.length > 0);
const publicProfileText = JSON.stringify(profile);
for (const secret of ['owner@example.com', 'password=decoy', '/home/owner', 'roadmap.xlsx', 'private-owner', 'internal diagnostic']) {
  assert.equal(publicProfileText.includes(secret), false, `preview leaked sensitive Skill text: ${secret}`);
}
const falsePositiveProfile = generateUBuddyCapabilityProfile({
  ownerUserId: 'owner-local',
  uBuddyAgentInstanceId: 'secretary-local',
  effectiveSkill: 'Profile management. Task intake, objective clarification, and delegation coordination.',
});
assert.equal(falsePositiveProfile.supportedTaskTypes.includes('受控文件与项目工作'), false,
  'Profile must not match the English file capability by substring');
assert.equal(falsePositiveProfile.deliverableTypes.includes('code_change'), false,
  'file handling alone must not imply code changes');
const actualHashProfile = generateUBuddyCapabilityProfile({
  ownerUserId: 'owner-local', uBuddyAgentInstanceId: 'secretary-local', effectiveSkill, effectiveSkillHash: 'a'.repeat(64),
});
assert.equal(actualHashProfile.sourceEffectiveSkillHash, effectiveSkillHash,
  'the Profile hash must always describe the exact Skill body used for generation');
for (const sensitiveValue of [
  'owner@example.com', '/srv/acme/private.txt', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
  '附件文件：private-roadmap.xlsx', 'password=decoy',
]) {
  const invalid = validateUBuddyCapabilityProfile({
    ...profile,
    introduction: sensitiveValue,
    privacyRiskConfirmedAt: '2026-08-03T12:00:00.000Z',
  });
  assert.equal(invalid.valid, false, `sensitive content must remain blocked after confirmation: ${sensitiveValue}`);
}

let privateSourceRead = false;
const store = {
  contextDeviceId: () => 'device-local',
  activeAccountWorkspace: () => ({ id: 'workspace-personal' }),
  findUserAgentInstance: () => ({ id: 'secretary-local' }),
  resolveEffectiveSkill: () => ({ effectiveSkill, effectiveSkillHash }),
  resolveUserAgent() { privateSourceRead = true; throw new Error('must not resolve Memory-bearing context'); },
  listMemoryDocuments() { privateSourceRead = true; throw new Error('must not read Memory'); },
  listMessages() { privateSourceRead = true; throw new Error('must not read private chat'); },
};
const auth = { requireUser: () => ({ id: 'owner-local', username: 'private-owner', email: 'owner@example.com' }) };
const org = { agent: () => ({ id: 'secretary_agent' }), readSkill: () => effectiveSkill };
const enabledFlags = { snapshot: () => ({ profilePreviewV1: true }) };
const service = createUBuddyCapabilityProfilePreviewService({
  auth, store, org, featureFlags: enabledFlags, now: () => new Date('2026-08-03T12:00:00.000Z'),
});
const generated = await service.preview();
assert.equal(generated.enabled, true);
assert.equal(generated.source, 'generated');
assert.equal(generated.persisted, false);
assert.equal(generated.published, false);
assert.equal(generated.profile.projectionVersion, UBUDDY_CAPABILITY_PROFILE_PREVIEW_PROJECTION_VERSION);
assert.equal(Object.hasOwn(generated.profile, 'ownerUserId'), false);
assert.equal(Object.hasOwn(generated.profile, 'uBuddyAgentInstanceId'), false);
assert.equal(privateSourceRead, false, 'preview must not touch Memory or private chat sources');
assert.doesNotMatch(JSON.stringify(generated.profile), /private-owner|owner@example\.com/);

const asyncGenerated = await createUBuddyCapabilityProfilePreviewService({
  auth, store, org, featureFlags: enabledFlags, generateProfile: async () => profile,
}).preview();
assert.equal(asyncGenerated.source, 'generated');
assert.equal(asyncGenerated.profile.introduction, profile.introduction);

const fallback = await createUBuddyCapabilityProfilePreviewService({
  auth,
  store,
  org,
  featureFlags: enabledFlags,
  generateProfile() { throw new Error('simulated generation failure with /home/private/path'); },
  now: () => new Date('2026-08-03T12:00:00.000Z'),
}).preview();
assert.equal(fallback.source, 'fallback');
assert.match(fallback.profile.introduction, /专业私人秘书/);
assert.doesNotMatch(JSON.stringify(fallback), /simulated|\/home\/private/);

const disabled = await createUBuddyCapabilityProfilePreviewService({
  auth, store, org, featureFlags: { snapshot: () => ({ profilePreviewV1: false }) },
}).preview();
assert.deepEqual(disabled, { enabled: false, reason: 'feature_flag_disabled' });

const bundledSkill = 'Task intake, delegation, privacy, and status reports.';
const bundledPreview = await createUBuddyCapabilityProfilePreviewService({
  auth,
  store: { ...store, resolveEffectiveSkill: () => ({ effectiveSkill: '', effectiveSkillHash: 'b'.repeat(64) }) },
  org: { agent: () => ({ id: 'secretary_agent' }), readSkill: () => bundledSkill },
  featureFlags: enabledFlags,
}).preview();
assert.equal(
  bundledPreview.profile.sourceEffectiveSkillHash,
  crypto.createHash('sha256').update(bundledSkill).digest('hex'),
  'falling back to the bundled Skill must also replace a stale effective Skill hash',
);

const previous = {
  currentUser: state.currentUser,
  currentSettingsSection: state.currentSettingsSection,
  uBuddyFeatureFlags: state.uBuddyFeatureFlags,
  uBuddyCapabilityProfilePreview: state.uBuddyCapabilityProfilePreview,
  uBuddyCapabilityProfilePreviewLoading: state.uBuddyCapabilityProfilePreviewLoading,
  uBuddyCapabilityProfilePreviewError: state.uBuddyCapabilityProfilePreviewError,
};
try {
  state.currentUser = { id: 'owner-local' };
  state.currentSettingsSection = 'ubuddy-profile';
  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, profilePreviewV1: true };
  state.uBuddyCapabilityProfilePreview = generated;
  state.uBuddyCapabilityProfilePreviewLoading = false;
  state.uBuddyCapabilityProfilePreviewError = '';
  const page = renderSettings();
  assert.match(page, />uBuddy</);
  assert.match(page, /不持久化 · 不发布/);
  assert.doesNotMatch(page, /owner-local|owner@example\.com|\/home\/owner/);
  assert.match(renderSettingsSidebar(), /data-settings-section="ubuddy-profile"/);

  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, profilePreviewV1: true, profileHistory: true };
  assert.match(renderSettings(), /不持久化 · 不发布/,
    'the independent preview flag must keep the page in non-persistent preview mode when both flags are enabled');

  state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, profilePreviewV1: false, profileHistory: false };
  state.currentSettingsSection = 'ubuddy-profile';
  assert.doesNotMatch(renderSettingsSidebar(), /data-settings-section="ubuddy-profile"/);
  assert.doesNotMatch(renderSettings(), />uBuddy</);
  assert.equal(state.currentSettingsSection, 'account');
} finally {
  Object.assign(state, previous);
}

console.log('uBuddy capability Profile preview smoke passed');
