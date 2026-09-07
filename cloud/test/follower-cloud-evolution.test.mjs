import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import { newDb } from 'pg-mem';

import { migrate } from '../src/db.mjs';
import { createFollowerCloudAuthority } from '../src/modules/follower/index.mjs';
import { createFollowerCloudClientContract } from '../../src/shared/follower/cloudContracts.js';
import { validateFollowerSystemAgentBundle, verifyFollowerSystemAgentBundle } from '../../src/shared/follower/systemAgentBundle.js';

test('Follower cloud projection, canonical service identity, personal versions, cohort, Canary, and signed bundle are capability gated', async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const { Pool } = database.adapters.createPg();
  const pool = new Pool();
  await pool.query('CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("INSERT INTO schema_migrations(filename) VALUES('024_cluster_cohort_ledger_contract.sql')");
  await migrate(pool);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const authority = createFollowerCloudAuthority({ pool, env: { JANUS_FOLLOWER_SYSTEM_SIGNING_PRIVATE_KEY: privateKeyPem,
    JANUS_FOLLOWER_BUNDLE_VERSION: '1.0.1' } });
  const contract = createFollowerCloudClientContract({ appVersion: '1.0.0' });

  for (let index = 1; index <= 7; index += 1) {
    const userId = `follower_cloud_user_${index}`;
    await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified)
      VALUES($1,$2,$3,$4,'hash',true)`, [userId, `${userId}@example.test`, `Follower ${index}`, userId]);
    const grant = { userId, deviceId: `device_${index}` };
    const first = await authority.ensureServiceInstance(grant, { workspaceId: 'workspace_personal', enabled: true, contract });
    const second = await authority.ensureServiceInstance(grant, { workspaceId: 'workspace_personal', enabled: true, contract });
    assert.equal(first.serviceInstance.id, second.serviceInstance.id, 'multiple devices must resolve the same canonical service identity');
    const common = { workspaceId: 'workspace_personal', serviceInstanceId: first.serviceInstance.id, contract };
    const evidence = await authority.ingestEvidence(grant, { ...common, items: [
      { clientRecordId: `${userId}_feedback`, sourceKind: 'follower_report_feedback', sourceId: `report_${index}`,
        signalKind: 'report_feedback', normalized: { rating: 'helpful' }, lineageKey: `feedback:${index}` },
      { clientRecordId: `${userId}_outcome`, sourceKind: 'follower_suggestion_outcome', sourceId: `suggestion_${index}`,
        signalKind: 'suggestion_outcome', normalized: { outcome: 'completed' }, lineageKey: `outcome:${index}` },
      { clientRecordId: `${userId}_preference`, sourceKind: 'follower_preference_instruction', sourceId: `preference_${index}`,
        signalKind: 'verbosity', normalized: { value: 'short' }, lineageKey: `verbosity:${index}` },
    ] });
    assert.equal(evidence.results.every((item) => item.status === 'accepted'), true);
    let status = await authority.evolutionStatus(grant, { workspaceId: 'workspace_personal', contract });
    assert.equal(status.personalOverlay, null, 'personal candidates must not auto-activate');
    assert.equal(status.preferenceMemory, null, 'Preference Memory candidates must not auto-activate');
    if (index === 1) await assert.rejects(() => authority.decidePersonal(grant, { workspaceId: 'workspace_personal',
      versionId: status.candidates[0].id, decision: 'accept', expectedStateRevision: status.serviceInstance.stateRevision - 1,
      commandId: 'stale-personal-decision', contract }), (error) => error.code === 'follower_personal_revision_conflict');
    for (const candidate of status.candidates) {
      const commandId = `${userId}:accept:${candidate.id}`;
      status = await authority.decidePersonal(grant, { workspaceId: 'workspace_personal', versionId: candidate.id,
        decision: 'accept', expectedStateRevision: status.serviceInstance.stateRevision,
        commandId, contract });
      const repeated = await authority.decidePersonal(grant, { workspaceId: 'workspace_personal', versionId: candidate.id,
        decision: 'accept', expectedStateRevision: status.serviceInstance.stateRevision, commandId, contract });
      assert.equal(repeated.serviceInstance.stateRevision, status.serviceInstance.stateRevision, 'duplicate personal decisions must be idempotent');
    }
    assert.match(status.personalOverlay.text, /short/);
    assert.equal(status.preferenceMemory.value.verbosity, 'short');
  }

  const firstUserGrant = { userId: 'follower_cloud_user_1', deviceId: 'device_1' };
  await assert.rejects(() => authority.evolutionStatus(firstUserGrant, { workspaceId: 'workspace_personal', contract: {} }),
    (error) => error.code === 'follower_client_incompatible');
  const firstUserStatus = await authority.evolutionStatus(firstUserGrant, { workspaceId: 'workspace_personal', contract });
  await authority.ingestEvidence(firstUserGrant, { workspaceId: 'workspace_personal', serviceInstanceId: firstUserStatus.serviceInstance.id, contract, items: [{
    clientRecordId: 'user_1_detailed', sourceKind: 'follower_preference_instruction', sourceId: 'preference_detailed',
    signalKind: 'verbosity', normalized: { value: 'detailed' }, lineageKey: 'verbosity:detailed',
  }] });
  let changedStatus = await authority.evolutionStatus(firstUserGrant, { workspaceId: 'workspace_personal', contract });
  assert.match(changedStatus.personalOverlay.text, /short/, 'new evidence must leave the active version unchanged until accepted');
  for (const candidate of changedStatus.candidates) {
    changedStatus = await authority.decidePersonal(firstUserGrant, { workspaceId: 'workspace_personal', versionId: candidate.id,
      decision: 'accept', expectedStateRevision: changedStatus.serviceInstance.stateRevision,
      commandId: `user_1:accept-detailed:${candidate.id}`, contract });
  }
  assert.match(changedStatus.personalOverlay.text, /detailed/);
  const rolledBackPersonal = await authority.rollbackPersonal(firstUserGrant, { workspaceId: 'workspace_personal', kind: 'personal_overlay', contract });
  assert.match(rolledBackPersonal.personalOverlay.text, /short/);

  const projectionGrant = { userId: 'follower_cloud_user_1', deviceId: 'device_1' };
  const projection = { schemaVersion: 'follower_report_projection_v1', projectionId: `follower_projection_${'a'.repeat(40)}`,
    originDeviceId: 'device_1', reportKind: 'daily_brief', window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' },
    summary: 'Safe summary', claims: [], suggestions: [], coverage: [], syncBody: 'Safe summary', validatedHash: 'validated_hash',
    privacyValidatorVersion: 'follower_privacy_v1', revision: 1, createdAt: '2026-08-12T10:00:00.000Z', updatedAt: '2026-08-12T10:00:00.000Z' };
  const rawReport = { schemaVersion: 'follower_raw_report_v1', reportId: 'report_1', originDeviceId: 'device_1', reportKind: 'daily_brief',
    report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: projection.window, coverage: [],
      claims: [{ id: 'claim_1', status: 'discussed_not_executed', text: 'Full report claim', sourceRefs: ['source_1'] }], suggestions: [], summary: 'Safe summary' },
    renderedBody: 'Safe summary\n\nFull report claim', validatedHash: projection.validatedHash,
    privacyValidatorVersion: projection.privacyValidatorVersion, createdAt: projection.createdAt, updatedAt: projection.updatedAt };
  const pushed = await authority.pushReports(projectionGrant, { workspaceId: 'workspace_personal', contract,
    items: [{ clientRecordId: 'projection_upload_1', operation: 'upsert', projection, rawReport }] });
  assert.equal(pushed.results[0].status, 'accepted', JSON.stringify(pushed.results[0]));
  const duplicatePush = await authority.pushReports(projectionGrant, { workspaceId: 'workspace_personal', contract,
    items: [{ clientRecordId: 'projection_upload_2', operation: 'upsert', projection, rawReport }] });
  assert.equal(duplicatePush.results[0].status, 'duplicate');
  const conflictingRawReport = { ...rawReport, validatedHash: 'different_validated_hash' };
  const conflictingProjection = { ...projection, validatedHash: conflictingRawReport.validatedHash };
  const conflictingPush = await authority.pushReports(projectionGrant, { workspaceId: 'workspace_personal', contract,
    items: [{ clientRecordId: 'projection_upload_conflict', operation: 'upsert', projection: conflictingProjection,
      rawReport: conflictingRawReport }] });
  assert.equal(conflictingPush.results[0].status, 'rejected');
  assert.equal(conflictingPush.results[0].code, 'follower_raw_report_identity_collision');
  assert.equal(Number((await pool.query('SELECT COUNT(*) count FROM cloud_follower_report_changes')).rows[0].count), 1);
  const storedRaw = (await pool.query('SELECT * FROM cloud_follower_raw_reports WHERE owner_user_id=$1 AND report_id=$2', [
    projectionGrant.userId, rawReport.reportId,
  ])).rows[0];
  assert.deepEqual(storedRaw.report_json.claims[0].sourceRefs, ['source_1']);
  assert.match(storedRaw.rendered_body, /Full report claim/);
  const linkedFeedback = (await pool.query(`SELECT evidence_id FROM cloud_follower_preference_signals
    WHERE owner_user_id=$1 AND account_workspace_id='workspace_personal' AND source_kind='follower_report_feedback'
      AND source_id=$2`, [projectionGrant.userId, rawReport.reportId])).rows;
  assert.equal(linkedFeedback.length, 1, 'feedback must link to the raw report through report_id');
  const changes = await authority.reportChanges(projectionGrant, { workspaceId: 'workspace_personal', contract, cursor: '', limit: 10 });
  assert.equal(changes.items.length, 1);
  assert.equal(JSON.stringify(changes.items).includes('sourceId'), false);
  const followupPush = await authority.pushFollowups(projectionGrant, { workspaceId: 'workspace_personal', contract, messages: [{
    id: 'followup_message_1', threadId: 'followup_thread_1', reportId: rawReport.reportId, role: 'user', content: 'What changed?',
    createdAt: '2026-08-12T10:05:00.000Z',
  }] });
  assert.equal(followupPush.results[0].status, 'accepted');
  const followupDuplicate = await authority.pushFollowups(projectionGrant, { workspaceId: 'workspace_personal', contract, messages: [{
    id: 'followup_message_1', threadId: 'followup_thread_1', reportId: rawReport.reportId, role: 'user', content: 'What changed?',
    createdAt: '2026-08-12T10:05:00.000Z',
  }] });
  assert.equal(followupDuplicate.results[0].status, 'duplicate');
  const followups = await authority.followupMessages(projectionGrant, { workspaceId: 'workspace_personal', reportId: rawReport.reportId, contract });
  assert.deepEqual(followups.messages.map((item) => item.content), ['What changed?']);
  await assert.rejects(() => authority.pushFollowups(projectionGrant, { workspaceId: 'workspace_personal', contract: {}, messages: [] }),
    (error) => error.code === 'follower_client_incompatible');
  await assert.rejects(() => authority.reportChanges(projectionGrant, { workspaceId: 'workspace_personal', contract: {}, cursor: '', limit: 10 }),
    (error) => error.code === 'follower_client_incompatible');

  for (let index = 2; index <= 7; index += 1) {
    const grant = { userId: `follower_cloud_user_${index}`, deviceId: `device_${index}` };
    const status = await authority.evolutionStatus(grant, { workspaceId: 'workspace_personal', contract });
    await authority.ingestEvidence(grant, { workspaceId: 'workspace_personal', serviceInstanceId: status.serviceInstance.id, contract, items: [{
      clientRecordId: `balanced_language_${index}`, sourceKind: 'follower_preference_instruction', sourceId: `language_${index}`,
      signalKind: 'language', normalized: { value: 'en' }, lineageKey: `language:${index}`,
    }] });
  }

  const cluster = await authority.evaluateCluster();
  assert.equal(cluster.status, 'gated');
  await assert.rejects(() => authority.recordCanary({ candidateId: cluster.candidateId, ownerUserId: 'follower_cloud_user_1',
    serviceInstanceId: firstUserStatus.serviceInstance.id, outcome: 'passed', metrics: { privacy: 'passed', regressionCount: 0 } }),
  (error) => error.code === 'follower_canary_candidate_invalid');
  assert.equal((await authority.recordGovernance({ candidateId: cluster.candidateId, reviewerUserId: 'admin_user', decision: 'passed',
    metrics: { privacyPassed: true, supportProofPassed: true } })).status, 'governance_approved');
  assert.equal((await authority.recordShadow({ candidateId: cluster.candidateId, reviewerUserId: 'admin_user', decision: 'passed',
    metrics: { crossUserHoldoutCount: 3, privacyViolations: 0, regressionCount: 0 } })).status, 'shadow_passed');
  for (let index = 8; index <= 10; index += 1) {
    const userId = `follower_cloud_user_${index}`;
    await pool.query(`INSERT INTO users(id,email,display_name,username,password_hash,email_verified)
      VALUES($1,$2,$3,$4,'hash',true)`, [userId, `${userId}@example.test`, `Follower ${index}`, userId]);
    const grant = { userId, deviceId: `device_${index}` };
    const status = await authority.ensureServiceInstance(grant, { workspaceId: 'workspace_personal', enabled: true, contract });
    const canary = await authority.recordCanary({ candidateId: cluster.candidateId, ownerUserId: userId,
      serviceInstanceId: status.serviceInstance.id, outcome: 'passed', metrics: { privacy: 'passed', regressionCount: 0 } });
    if (index === 10) assert.equal(canary.status, 'canary_passed');
  }
  const published = await authority.publishCandidate({ candidateId: cluster.candidateId, releaseVersion: '1.0.1' });
  assert.equal(published.releaseTarget, 'system_agent_follower');
  const distributed = await authority.systemBundle(projectionGrant, { currentBundleId: '', appVersion: '1.0.0', contract });
  assert.equal(distributed.available, true);
  validateFollowerSystemAgentBundle(distributed.bundle, { appVersion: '1.0.0' });
  assert.equal(verifyFollowerSystemAgentBundle(distributed.bundle, { publicKeyPem }).valid, true);
  await assert.rejects(() => authority.systemBundle(projectionGrant, { currentBundleId: '', appVersion: '1.0.0', contract: {} }),
    (error) => error.code === 'follower_client_incompatible');
  await pool.end();
});
