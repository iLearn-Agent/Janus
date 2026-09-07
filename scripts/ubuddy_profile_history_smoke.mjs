import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { state } from '../src/renderer/app/state.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-profile-history-'));
let runtime = null;
let releaseAsyncGeneration = null;
const asyncGeneration = new Promise((resolve) => { releaseAsyncGeneration = resolve; });
let releaseStaleGeneration = null;
const staleGeneration = new Promise((resolve) => { releaseStaleGeneration = resolve; });
const profileGenerator = async (context) => {
  if (context.effectiveSkill.includes('PROFILE_GENERATION_FAIL')) throw new Error('simulated profile generation failure');
  if (context.effectiveSkill.includes('ASYNC_PROFILE_GATE')) await asyncGeneration;
  if (context.effectiveSkill.includes('STALE_PROFILE_GATE')) await staleGeneration;
  const hardPrivacy = context.effectiveSkill.includes('PROFILE_HARD_PRIVACY');
  const privacy = context.effectiveSkill.includes('PROFILE_PRIVACY_RISK');
  const expanded = context.effectiveSkill.includes('PROFILE_SCOPE_EXPAND');
  return {
    introduction: hardPrivacy ? 'password=must-not-publish' : privacy ? '可联系 profile-owner@example.com 协调任务。' : '帮助你澄清目标、协调 Agent 并跟踪交付。',
    supportedTaskTypes: ['任务澄清', 'Agent 协调', ...(expanded ? ['新增公开研究能力'] : [])],
    deliverableTypes: ['answer', 'report'],
    capabilityTags: ['任务整理', '协作协调', ...(expanded ? ['公开研究'] : [])],
    preferredTasks: ['目标明确并有验收标准的任务。'],
    unsupportedTasks: ['未经确认的公开承诺。'],
    improvementDirections: ['继续提高任务边界识别。'],
    collaborationModes: ['直接处理', '单 Agent 委托'],
    privacyConstraints: ['公开前检查隐私并取得授权。'],
    evidenceSummary: '仅根据当前有效 Skill 生成。',
  };
};

try {
  runtime = await createRuntime({
    root,
    isDev: true,
    serverAuthoritativeSkills: true,
    uBuddyCapabilityProfileProvider: profileGenerator,
  });
  const user = runtime.auth.createVerifiedUser({
    email: 'profile-history@example.com', password: 'profile-history-password', displayName: 'Profile History Owner', emailVerified: 1,
  });
  runtime.auth.setActiveUser(user.id);
  runtime.store.settingSet('ubuddy:feature_flags:v1', JSON.stringify({
    ubuddy_profile_history_v1: 'on',
    'ubuddy.profile_publication': 'on',
  }));
  runtime.store.provisionNewUserAgentDefaults({ userId: user.id, sourceDeviceId: 'profile-history-test' });
  const buddy = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'secretary_agent' });
  assert.ok(buddy?.id, 'the user must have a uBuddy instance');

  const firstQueued = runtime.uBuddyCapabilityProfiles.reconcileUBuddyCapabilityProfile({ userId: user.id, trigger: 'test_initial' });
  assert.equal(firstQueued.status, 'queued');
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  let history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, 1);
  assert.equal(history[0].publicationState, 'active');
  assert.equal(history[0].requiresUserConfirmation, true, 'first publication must require owner authorization');
  assert.ok(runtime.uBuddyCapabilityProfiles.getActiveUBuddyCapabilityProfile({ userId: user.id }),
    'the first safe local Profile may become active before public authorization');
  assert.equal(runtime.auth.listUBuddyCapabilityProfilePublicationOutbox({ limit: 100 }).length, 0,
    'an unapproved first Profile must not be published');
  const baseProfileRevision = history[0].profileRevision;
  assert.throws(() => runtime.store.activateUBuddyCapabilityProfile({
    ownerUserId: user.id, uBuddyAgentInstanceId: buddy.id, profileRevision: baseProfileRevision,
  }), (error) => error?.code === 'ubuddy_profile_confirmation_required',
  'storage callers must not implicitly confirm the first locally active Profile');
  await runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: baseProfileRevision, decision: 'reject', visibility: 'friends',
  });
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'rejected', 'rejecting the first active Profile must end its active state');
  assert.equal(runtime.uBuddyCapabilityProfiles.getActiveUBuddyCapabilityProfile({ userId: user.id }), null);
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).enabled, false);
  assert.throws(() => runtime.uBuddyCapabilityProfiles.authorizeUBuddyProfilePublication({
    userId: user.id, profileRevision: baseProfileRevision, visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_not_found');
  const regeneratedFirst = runtime.uBuddyCapabilityProfiles.scheduleUBuddyCapabilityProfileGeneration({
    userId: user.id, agentInstanceId: buddy.id, trigger: 'rejected_first_regeneration', force: true,
  });
  assert.equal(regeneratedFirst.status, 'queued');
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, 1, 'regenerating a rejected Skill hash must reuse the existing revision');
  assert.equal(history[0].publicationState, 'active');
  assert.equal(history[0].requiresUserConfirmation, true);

  const asyncSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'ASYNC_PROFILE_GATE' });
  const activation = runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: asyncSkill.id });
  assert.equal(activation.personalSkillVersion.id, asyncSkill.id, 'Skill activation must complete before Profile generation');
  await new Promise((resolve) => setImmediate(resolve));
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, 2);
  assert.equal(history[0].publicationState, 'draft');
  assert.ok(['pending', 'generating'].includes(history[0].generationStatus));
  const duplicate = runtime.uBuddyCapabilityProfiles.scheduleUBuddyCapabilityProfileGeneration({
    userId: user.id, agentInstanceId: buddy.id, trigger: 'duplicate_hash',
  });
  assert.equal(duplicate.status, 'idempotent');
  assert.equal(runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id }).length, 2,
    'the same effective Skill hash must not create another revision');
  assert.throws(() => runtime.uBuddyCapabilityProfiles.authorizeUBuddyProfilePublication({
    userId: user.id, profileRevision: baseProfileRevision, visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_source_skill_stale',
  'direct publication must not authorize an unconfirmed Profile for an obsolete Skill');
  releaseAsyncGeneration();
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'validated');
  assert.equal(history[1].publicationState, 'active');
  await runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: history[0].profileRevision, decision: 'approve', visibility: 'friends',
  });
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'active');
  assert.equal(history[1].publicationState, 'archived');
  assert.ok(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).authorizedAt);
  assert.equal(runtime.auth.listUBuddyCapabilityProfilePublicationOutbox({ limit: 100 }).length, 1,
    'explicit first-publication approval must enqueue publication');

  const safeUpdateSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'SAFE_AUTO_UPDATE' });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: safeUpdateSkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'active');
  const safeActiveRevision = history[0].profileRevision;
  const publicationCountBeforeExpansion = runtime.auth.listUBuddyCapabilityProfilePublicationOutbox({ limit: 100 }).length;
  assert.equal(publicationCountBeforeExpansion, 2, 'safe scope-preserving updates may auto-publish');
  await assert.rejects(runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: safeActiveRevision, decision: 'reject', visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_review_not_pending');
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).enabled, true,
    'rejecting a non-pending active Profile must not disable publication');

  const expandedSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'PROFILE_SCOPE_EXPAND' });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: expandedSkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'validated');
  assert.equal(history[0].requiresUserConfirmation, true);
  assert.match(history[0].confirmationReason, /capability_scope_expanded/);
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, safeActiveRevision,
    'an expanded Profile must preserve the previous active revision until approval');
  assert.throws(() => runtime.store.activateUBuddyCapabilityProfile({
    ownerUserId: user.id, uBuddyAgentInstanceId: buddy.id, profileRevision: history[0].profileRevision,
  }), (error) => error?.code === 'ubuddy_profile_confirmation_required',
  'storage callers must not bypass expanded-capability confirmation');
  assert.equal(runtime.auth.listUBuddyCapabilityProfilePublicationOutbox({ limit: 100 }).length, publicationCountBeforeExpansion,
    'expanded public capability scope must not auto-publish before confirmation');
  const firstExpandedRevision = history[0].profileRevision;

  const secondExpandedSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: buddy.id, overlayText: 'PROFILE_SCOPE_EXPAND SECOND_EXPANDED_HASH',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: secondExpandedSkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'validated');
  assert.equal(history[0].requiresUserConfirmation, true,
    'repeated expanded scopes must still compare against the last approved public scope');
  assert.match(history[0].confirmationReason, /capability_scope_expanded/);
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, safeActiveRevision);
  assert.equal(runtime.auth.listUBuddyCapabilityProfilePublicationOutbox({ limit: 100 }).length, publicationCountBeforeExpansion);
  await runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: history[0].profileRevision, decision: 'reject', visibility: 'friends',
  });
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'rejected');
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, safeActiveRevision,
    'rejecting an expanded Profile must leave the previous active revision unchanged');
  await assert.rejects(runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: firstExpandedRevision, decision: 'approve', visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_source_skill_stale');

  const failedSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'PROFILE_GENERATION_FAIL' });
  const failedActivation = runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: failedSkill.id });
  assert.equal(failedActivation.personalSkillVersion.id, failedSkill.id);
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].generationStatus, 'failed');
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, safeActiveRevision,
    'generation failure must preserve the previous active Profile');

  const privacySkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'PROFILE_PRIVACY_RISK' });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: privacySkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'rejected');
  assert.equal(history[0].requiresUserConfirmation, false);
  assert.equal(history[0].confirmationReason, 'privacy_validation_failed');
  assert.ok(history[0].privacyRisks.length > 0);
  assert.doesNotMatch(JSON.stringify(history[0]), /profile-owner@example\.com/,
    'rejected Profile records must not retain sensitive generated content');
  const activeBeforePrivacyApproval = history.find((item) => item.publicationState === 'active')?.profileRevision;
  assert.notEqual(activeBeforePrivacyApproval, history[0].profileRevision, 'privacy-risk Profile must not auto-activate');
  await assert.rejects(runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: history[0].profileRevision, decision: 'approve', visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_sensitive_content_blocked');
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'rejected');
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, activeBeforePrivacyApproval);

  const hardPrivacySkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'PROFILE_HARD_PRIVACY' });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: hardPrivacySkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'rejected');
  assert.equal(history[0].confirmationReason, 'privacy_validation_failed');
  assert.doesNotMatch(JSON.stringify(history[0]), /must-not-publish/);
  await assert.rejects(runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: history[0].profileRevision, decision: 'approve', visibility: 'friends',
  }), (error) => error?.code === 'ubuddy_profile_sensitive_content_blocked');

  const staleSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: buddy.id, overlayText: 'STALE_PROFILE_GATE PROFILE_PRIVACY_RISK',
  });
  const staleResolution = runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: staleSkill.id });
  await new Promise((resolve) => setImmediate(resolve));
  const duplicatePending = runtime.uBuddyCapabilityProfiles.scheduleUBuddyCapabilityProfileGeneration({
    userId: user.id, agentInstanceId: buddy.id, trigger: 'duplicate_pending_hash',
  });
  assert.equal(duplicatePending.status, 'idempotent');
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).enabled, true,
    'an idempotent duplicate must not validate or quarantine an unfinished draft');
  const successorSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'STALE_PROFILE_SUCCESSOR' });
  const successorResolution = runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: successorSkill.id });
  releaseStaleGeneration();
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  const staleRecord = history.find((item) => item.sourceEffectiveSkillHash === staleResolution.effectiveSkillHash);
  const successorRecord = history.find((item) => item.sourceEffectiveSkillHash === successorResolution.effectiveSkillHash);
  assert.equal(staleRecord?.publicationState, 'rejected');
  assert.equal(staleRecord?.confirmationReason, 'source_skill_superseded');
  assert.doesNotMatch(JSON.stringify(staleRecord), /profile-owner@example\.com/,
    'a stale generation result must still be redacted before it is retained');
  assert.equal(successorRecord?.publicationState, 'active', 'only the latest Skill generation may become active');

  const revisionCountBeforeRollback = history.length;
  const publicationCountBeforeRollback = Number(runtime.db.prepare(`SELECT count(*) AS count
    FROM ubuddy_capability_profile_publication_outbox WHERE owner_user_id=?`).get(user.id)?.count || 0);
  runtime.store.deactivatePersonalSkill({ agentInstanceId: buddy.id });
  const rollback = runtime.uBuddyCapabilityProfiles.scheduleUBuddyCapabilityProfileGeneration({
    userId: user.id, agentInstanceId: buddy.id, trigger: 'rollback_assertion',
  });
  assert.equal(rollback.status, 'reactivated');
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, revisionCountBeforeRollback, 'rolling back to an existing Skill hash must not create a duplicate revision');
  assert.equal(history.find((item) => item.publicationState === 'active')?.profileRevision, baseProfileRevision,
    'rolling back a Skill must reactivate its archived Profile');
  const rolledBackProfile = history.find((item) => item.profileRevision === baseProfileRevision);
  assert.equal(rolledBackProfile?.requiresUserConfirmation, false,
    'an already approved equivalent capability scope should be reusable after rollback');
  assert.equal(rolledBackProfile?.userConfirmedAt, '',
    'inherited scope approval must not be recorded as a direct confirmation of the historical revision');
  assert.equal(Number(runtime.db.prepare(`SELECT count(*) AS count
    FROM ubuddy_capability_profile_publication_outbox WHERE owner_user_id=?`).get(user.id)?.count || 0),
    publicationCountBeforeRollback + 1, 'a safe rollback should enqueue the reactivated historical Profile');
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).enabled, true);

  const notifyEffectiveSkillChanged = runtime.store.onEffectiveSkillChanged;
  runtime.store.onEffectiveSkillChanged = null;
  const interruptedSkill = runtime.store.createPersonalSkillVersion({ agentInstanceId: buddy.id, overlayText: 'INTERRUPTED_RECOVERY' });
  const interruptedResolution = runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: interruptedSkill.id });
  runtime.store.onEffectiveSkillChanged = notifyEffectiveSkillChanged;
  const interrupted = runtime.store.reserveUBuddyCapabilityProfileDraft({
    ownerUserId: user.id,
    uBuddyAgentInstanceId: buddy.id,
    sourceEffectiveSkillHash: interruptedResolution.effectiveSkillHash,
    trigger: 'interrupted_test',
  });
  runtime.store.updateUBuddyCapabilityProfileGeneration({
    ownerUserId: user.id, uBuddyAgentInstanceId: buddy.id,
    profileRevision: interrupted.profile.profileRevision, generationStatus: 'generating',
  });
  const revisionCountBeforeRecovery = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id }).length;
  await runtime.close();
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true, uBuddyCapabilityProfileProvider: profileGenerator,
  });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, revisionCountBeforeRecovery, 'interrupted generation recovery must reuse the reserved revision');
  const recovered = history.find((item) => item.sourceEffectiveSkillHash === interruptedResolution.effectiveSkillHash);
  assert.equal(recovered?.generationStatus, 'completed');
  assert.equal(recovered?.publicationState, 'active');

  runtime.uBuddyCapabilityProfiles.setAutoPublisher(() => {
    throw new Error('simulated synchronous publication failure');
  });
  const publicationFailureSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: buddy.id, overlayText: 'AUTO_PUBLICATION_FAILURE_SAFE_SCOPE',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: publicationFailureSkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'active');
  assert.equal(history[0].generationStatus, 'completed',
    'a synchronous auto-publication failure must not mark Profile generation as failed');
  assert.equal(history[0].generationError, '');

  const reviewPublicationFailureSkill = runtime.store.createPersonalSkillVersion({
    agentInstanceId: buddy.id, overlayText: 'PROFILE_SCOPE_EXPAND REVIEW_PUBLICATION_FAILURE',
  });
  runtime.store.activatePersonalSkillVersion({ agentInstanceId: buddy.id, skillVersionId: reviewPublicationFailureSkill.id });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history[0].publicationState, 'validated');
  const reviewWithDeferredPublication = await runtime.uBuddyCapabilityProfiles.reviewUBuddyCapabilityProfile({
    userId: user.id, profileRevision: history[0].profileRevision, decision: 'approve', visibility: 'friends',
  });
  assert.equal(reviewWithDeferredPublication.profile.publicationState, 'active');
  assert.equal(reviewWithDeferredPublication.publication?.status, 'deferred',
    'publication transport failure must not make a successful owner review appear rejected');

  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  const legacyActive = history.find((item) => item.publicationState === 'active');
  assert.ok(legacyActive, 'a previous safe active Profile must remain available before legacy quarantine');
  const legacyUnsafeProfile = {
    ...legacyActive.profile,
    introduction: '旧版本联系 legacy-owner@example.com',
    privacyRiskConfirmedAt: '2026-08-03T00:00:00.000Z',
  };
  runtime.db.prepare(`UPDATE ubuddy_capability_profiles SET profile_json=?,content_hash='legacy-unsafe-hash'
    WHERE owner_user_id=? AND ubuddy_agent_instance_id=? AND profile_revision=?`).run(
    JSON.stringify(legacyUnsafeProfile), user.id, buddy.id, legacyActive.profileRevision,
  );
  runtime.uBuddyCapabilityProfiles.setUBuddyProfilePublicationPreference({ userId: user.id, enabled: true, visibility: 'friends' });
  assert.equal(runtime.uBuddyCapabilityProfiles.getActiveUBuddyCapabilityProfile({ userId: user.id }), null,
    'legacy active Profiles must be revalidated before publication');
  const quarantinedLegacy = runtime.store.getUBuddyCapabilityProfile({
    ownerUserId: user.id, uBuddyAgentInstanceId: buddy.id, profileRevision: legacyActive.profileRevision,
  });
  assert.equal(quarantinedLegacy.publicationState, 'rejected');
  assert.doesNotMatch(JSON.stringify(quarantinedLegacy), /legacy-owner@example\.com/);
  assert.equal(runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }).enabled, false);

  const revisionCountBeforeReopen = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id }).length;
  await runtime.close();
  runtime = await createRuntime({
    root, isDev: true, serverAuthoritativeSkills: true, uBuddyCapabilityProfileProvider: profileGenerator,
  });
  await runtime.uBuddyCapabilityProfiles.waitForIdle();
  history = runtime.uBuddyCapabilityProfiles.listUBuddyCapabilityProfileHistory({ userId: user.id });
  assert.equal(history.length, revisionCountBeforeReopen, 'second open must preserve history without duplicate revisions');
  assert.equal(runtime.db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  assert.equal(runtime.db.prepare('PRAGMA foreign_key_check').all().length, 0);

  const previousState = {
    currentUser: state.currentUser,
    currentSettingsSection: state.currentSettingsSection,
    uBuddyFeatureFlags: state.uBuddyFeatureFlags,
    uBuddyCapabilityProfileHistory: state.uBuddyCapabilityProfileHistory,
  };
  try {
    state.currentUser = user;
    state.currentSettingsSection = 'ubuddy-profile';
    state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, profileHistory: true };
    state.uBuddyCapabilityProfileHistory = {
      profiles: history,
      preference: runtime.uBuddyCapabilityProfiles.getUBuddyProfilePublicationPreference({ userId: user.id }),
    };
    const markup = renderSettings();
    assert.match(markup, /版本历史/);
    assert.match(markup, /修订/);
    assert.match(markup, /本机版本历史/);
  } finally {
    Object.assign(state, previousState);
  }

  console.log('uBuddy Profile history smoke passed');
} finally {
  await Promise.resolve(runtime?.close?.()).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
