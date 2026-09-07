import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCloudServer } from '../src/cloud/server.js';
import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-ubuddy-profile-social-'));
const previousAuthUrl = process.env.JANUS_AUTH_URL;
const previousFlag = process.env.JANUS_UBUDDY_PROFILE_PUBLICATION;
const previousHistoryFlag = process.env.JANUS_UBUDDY_PROFILE_HISTORY;
const sentCodes = new Map();
let cloud;
let alice;
let bob;

try {
  process.env.JANUS_UBUDDY_PROFILE_PUBLICATION = 'on';
  process.env.JANUS_UBUDDY_PROFILE_HISTORY = 'on';
  cloud = createCloudServer({
    home: path.join(tempRoot, 'cloud'), token: 'profile-cloud-token', syncToken: 'profile-sync-token',
    emailCodeSecret: 'profile-email-secret',
    mailer: { configured: true, async sendEmailCode({ email, purpose, code }) { sentCodes.set(`${email}:${purpose}`, code); } },
  });
  const address = await cloud.listen({ host: '127.0.0.1', port: 0 });
  process.env.JANUS_AUTH_URL = `http://127.0.0.1:${address.port}`;
  alice = await createRuntime({
    root: path.join(tempRoot, 'alice'), isDev: true,
    uBuddyCapabilityProfileProvider: {
      async generateUBuddyCapabilityProfile({ userId, uBuddyAgentInstanceId, profileRevision, sourceEffectiveSkillHash }) {
        return { ...capabilityProfile(userId, profileRevision, '擅长研究、报告和跨 Agent 协调。'),
          uBuddyAgentInstanceId, sourceEffectiveSkillHash };
      },
    },
  });
  bob = await createRuntime({ root: path.join(tempRoot, 'bob'), isDev: true });
  await register(alice, 'profile-alice.sqlite@example.com', 'Profile Alice', 'alice-password');
  await register(bob, 'profile-bob.sqlite@example.com', 'Profile Bob', 'bob-password');
  await alice.regenerateUBuddyCapabilityProfile();
  await waitForActiveProfile(alice);
  await alice.updateUBuddyCapabilityProfilePublicationPreference({ enabled: true, visibility: 'friends' });

  const published = await alice.publishUBuddyCapabilityProfile({ commandId: 'sqlite-profile-publish-1' });
  assert.equal(published.sync.processed, 1);
  assert.equal(alice.db.prepare(`SELECT status FROM ubuddy_capability_profile_publication_outbox
    WHERE command_id='sqlite-profile-publish-1'`).get().status, 'completed');
  const publicationPreference = (await alice.uBuddyCapabilityProfileHistory()).preference;
  assert.equal(publicationPreference.lastPublishedRevision, 1);
  assert.equal(publicationPreference.lastCloudStateRevision, 1);
  assert.equal(cloud.db.prepare(`SELECT count(*) AS count FROM social_ubuddy_capability_profiles
    WHERE publication_state='active'`).get().count, 1);

  const legacyUnsafeProfile = {
    ...capabilityProfile(alice.currentUser().id, 99, 'password=legacy-outbox-secret'),
    privacyRiskConfirmedAt: '2026-08-03T00:00:00.000Z',
  };
  const legacyPayload = { commandId: 'legacy-unsafe-outbox', expectedStateRevision: 0, profile: legacyUnsafeProfile };
  alice.db.prepare(`INSERT INTO ubuddy_capability_profile_publication_outbox(
    id,owner_user_id,profile_revision,command_id,operation_kind,expected_cloud_state_revision,
    payload_hash,payload_json,status,created_at,updated_at
  ) VALUES('legacy-unsafe-outbox-row',?,99,'legacy-unsafe-outbox','publish',0,'legacy-hash',?,'pending',datetime('now'),datetime('now'))`).run(
    alice.currentUser().id, JSON.stringify(legacyPayload),
  );
  const rejectedLegacySync = await alice.retryUBuddyCapabilityProfilePublication();
  assert.equal(rejectedLegacySync.rejected, 1);
  const scrubbedOutbox = alice.db.prepare(`SELECT status,payload_json,last_error,next_attempt_at
    FROM ubuddy_capability_profile_publication_outbox WHERE id='legacy-unsafe-outbox-row'`).get();
  assert.equal(scrubbedOutbox.status, 'blocked_capability');
  assert.equal(scrubbedOutbox.payload_json, '{}');
  assert.equal(scrubbedOutbox.last_error, 'profile_validation_failed');
  assert.match(scrubbedOutbox.next_attempt_at, /^9999-/);

  const aliceRemoteId = alice.currentUser().remoteId;
  const aliceLocalIdAtBob = (await bob.friendSearch({ query: 'profile-alice.sqlite@example.com' }))[0].id;
  const hidden = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob] });
  assert.deepEqual(hidden.profiles, []);

  await bob.friendSendRequest({ userId: aliceLocalIdAtBob });
  const incoming = (await alice.friendsOverview()).requests.incoming[0];
  await alice.friendAcceptRequest({ requestId: incoming.id });
  const visible = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob] });
  assert.equal(visible.profiles[0].profile.introduction, '擅长研究、报告和跨 Agent 协调。');
  assert.equal(visible.profiles[0].ownerRemoteUserId, aliceRemoteId);
  const cached = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob], cachedOnly: true });
  assert.equal(cached.profiles[0].cached, undefined);
  assert.equal(cached.profiles[0].stale, false);

  const cacheRow = bob.db.prepare('SELECT * FROM ubuddy_capability_profile_cache LIMIT 1').get();
  const unsafeCachedProfile = { ...JSON.parse(cacheRow.profile_json), introduction: 'Authorization: Bearer legacy-cache-secret' };
  bob.db.prepare('UPDATE ubuddy_capability_profile_cache SET profile_json=?').run(JSON.stringify(unsafeCachedProfile));
  const rejectedCache = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob], cachedOnly: true });
  assert.deepEqual(rejectedCache.profiles, []);
  assert.equal(bob.db.prepare('SELECT count(*) AS count FROM ubuddy_capability_profile_cache').get().count, 0,
    'legacy unsafe cached Profiles must be deleted on read');

  const cloudActive = cloud.db.prepare(`SELECT * FROM social_ubuddy_capability_profiles
    WHERE publication_state='active'`).get();
  const unsafeCloudProfile = { ...JSON.parse(cloudActive.profile_json), introduction: '/srv/private/legacy-cloud.txt' };
  cloud.db.prepare(`UPDATE social_ubuddy_capability_profiles SET profile_json=?
    WHERE owner_user_id=? AND publication_state='active'`).run(JSON.stringify(unsafeCloudProfile), aliceRemoteId);
  const rejectedCloudProfile = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob] });
  assert.deepEqual(rejectedCloudProfile.profiles, [], 'legacy unsafe cloud Profiles must not be returned');

  await assert.rejects(
    bob.publishUBuddyCapabilityProfile({ commandId: 'provider-missing' }),
    (error) => error?.code === 'ubuddy_profile_not_found',
  );

  await bob.friendBlock({ userId: aliceLocalIdAtBob });
  assert.equal(bob.db.prepare('SELECT count(*) AS count FROM ubuddy_capability_profile_cache').get().count, 0);
  const blocked = await bob.queryUBuddyCapabilityProfiles({ userIds: [aliceLocalIdAtBob] });
  assert.deepEqual(blocked.profiles, []);

  const unpublished = await alice.unpublishUBuddyCapabilityProfile({ commandId: 'sqlite-profile-unpublish-1' });
  assert.equal(unpublished.sync.processed, 1);
  assert.equal(cloud.db.prepare(`SELECT count(*) AS count FROM social_ubuddy_capability_profiles
    WHERE publication_state='active'`).get().count, 0);
  assert.equal(cloud.db.prepare(`SELECT count(*) AS count FROM social_ubuddy_capability_profiles
    WHERE publication_state='archived'`).get().count, 1);

  const viewSource = await readFile(new URL('../src/renderer/app/views/networkView.js', import.meta.url), 'utf8');
  assert.match(viewSource, /uBuddy 团队简介/);
  const renderProfileBody = viewSource.slice(viewSource.indexOf('function renderContactUBuddyCapabilityProfile'), viewSource.indexOf('export function renderGroupProfileDialog'));
  assert.doesNotMatch(renderProfileBody, /evidenceSummary/);

  process.stdout.write('uBuddy capability profile social publication and discovery smoke passed.\n');
} finally {
  alice?.close();
  bob?.close();
  if (cloud) await cloud.close();
  if (previousAuthUrl === undefined) delete process.env.JANUS_AUTH_URL;
  else process.env.JANUS_AUTH_URL = previousAuthUrl;
  if (previousFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_PUBLICATION;
  else process.env.JANUS_UBUDDY_PROFILE_PUBLICATION = previousFlag;
  if (previousHistoryFlag === undefined) delete process.env.JANUS_UBUDDY_PROFILE_HISTORY;
  else process.env.JANUS_UBUDDY_PROFILE_HISTORY = previousHistoryFlag;
  await rm(tempRoot, { recursive: true, force: true });
}

async function waitForActiveProfile(runtime) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const history = await runtime.uBuddyCapabilityProfileHistory();
    if (history.profiles.some((item) => item.publicationState === 'active')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('uBuddy capability Profile generation did not become active.');
}

async function register(runtime, email, displayName, password) {
  await runtime.authSendEmailCode({ email, purpose: 'register', method: 'email' });
  const code = sentCodes.get(`${email}:register`);
  assert.match(code, /^\d{6}$/);
  return runtime.authRegister({ email, displayName, password, code });
}

function capabilityProfile(ownerUserId, profileRevision, introduction) {
  return {
    version: 'ubuddy_capability_profile_v1', ownerUserId, uBuddyAgentInstanceId: 'ubuddy-profile-agent',
    profileRevision, introduction, supportedTaskTypes: ['research', 'coordination'], deliverableTypes: ['report', 'document'],
    capabilityTags: ['研究', '协作'], preferredTasks: ['结构化任务'], unsupportedTasks: ['需要线下签字的任务'],
    collaborationModes: ['direct'], privacyConstraints: ['不公开私聊内容'], evidenceSummary: '仅包含公开能力概述',
    sourceEffectiveSkillHash: 'sqlite-profile-skill-hash', visibility: 'friends', publicationState: 'active',
    generatedAt: '2026-08-03T00:00:00.000Z', approvedAt: '2026-08-03T00:01:00.000Z',
  };
}
