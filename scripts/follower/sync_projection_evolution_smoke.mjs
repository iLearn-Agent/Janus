import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerCloudService } from '../../src/main/modules/follower/application/FollowerCloudService.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';
import { createFollowerCloudClientContract } from '../../src/shared/follower/cloudContracts.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-sync-'));
let db;
try {
  db = openDatabase(root, { appVersion: '1.0.0' });
  const store = new Store(db, { root });
  const context = { ownerUserId: 'follower_sync_user', workspaceId: 'workspace_personal' };
  const contract = createFollowerCloudClientContract({ appVersion: '1.0.0' });
  const uploaded = [];
  const evidenceBatches = [];
  let pulled = false;
  let failEvidenceUpload = false;
  const cloudSync = {
    status: () => ({ configured: true, deviceId: 'device_a' }),
    freshDatabaseRecoveryState: () => JSON.parse(store.settingGet('database:fresh_recovery_state', '{}') || '{}'),
    followerCapabilities: async () => ({ enabled: true, clientCompatibility: { contract }, capabilities: contract.capabilities }),
    followerReportChanges: async () => pulled ? { items: [], cursor: '1', hasMore: false } : (pulled = true, { items: [{
      schemaVersion: 'follower_report_projection_v1', projectionId: `follower_projection_${'b'.repeat(40)}`, originDeviceId: 'device_b',
      reportKind: 'daily_brief', window: { startAt: '2026-08-11T00:00:00.000Z', endAt: '2026-08-11T10:00:00.000Z', timezone: 'Asia/Shanghai' },
      summary: 'Remote safe report', claims: [], suggestions: [], coverage: [], syncBody: 'Remote safe report', validatedHash: 'remote_hash',
      privacyValidatorVersion: 'follower_privacy_v1', revision: 1, createdAt: '2026-08-11T10:00:00.000Z', updatedAt: '2026-08-11T10:00:00.000Z',
    }], cursor: '1', hasMore: false }),
    pushFollowerReports: async (payload) => {
      uploaded.push(...payload.items);
      return { results: payload.items.map((item) => ({ clientRecordId: item.clientRecordId, status: 'accepted',
        projectionSessionId: 'readonly_follower_reports', projectionMessageId: item.projection?.projectionId || item.projectionId })) };
    },
    ensureFollowerServiceInstance: async () => ({ enabled: true, serviceInstance: { id: 'canonical_follower_service', remoteUserId: 'remote_user',
      workspaceId: 'workspace_personal', subjectKind: 'system_service', status: 'active', stateRevision: 1 },
      personalOverlay: null, preferenceMemory: null }),
    updateFollowerServiceInstance: async () => ({ enabled: false, serviceInstance: { id: 'canonical_follower_service', status: 'inactive' } }),
    uploadFollowerEvidence: async (payload) => {
      if (failEvidenceUpload) throw new Error('temporary evidence transport failure');
      evidenceBatches.push(payload.items.map((item) => ({ ...item })));
      return { results: payload.items.map((item) => ({ clientRecordId: item.clientRecordId,
        evidenceId: `evidence_${item.signalHash}`, status: 'accepted' })) };
    },
    followerEvolutionStatus: async () => ({ enabled: true, serviceInstance: { id: 'canonical_follower_service', remoteUserId: 'remote_user',
      workspaceId: 'workspace_personal', subjectKind: 'system_service', status: 'active', stateRevision: 1 },
      personalOverlay: null, preferenceMemory: null, candidates: [] }),
  };
  const service = new FollowerCloudService({ root, store, cloudSync, appVersion: '1.0.0', deviceId: () => 'device_a' });
  store.updateFollowerAccess({ ...context, disclosureConfirmed: true, grants: { task_activity: true } });
  await service.ensureDefaultCloud(context);
  assert.equal(store.followerAccessSnapshot(context).reportSyncEnabled, true);
  assert.equal(store.followerAccessSnapshot(context).evolutionEnabled, true);
  assert.equal(store.followerAccessSnapshot(context).grants.sync_sanitized_reports, true);
  assert.equal(store.followerEvolutionBinding(context).canonicalServiceInstanceId, 'canonical_follower_service');
  const access = store.followerAccessSnapshot(context);
  const run = store.createFollowerRun({ ...context, kind: 'daily_brief', clientRequestId: 'sync_run',
    window: { startAt: '2026-08-12T00:00:00.000Z', endAt: '2026-08-12T10:00:00.000Z', timezone: 'Asia/Shanghai' }, authorization: access });
  const localReport = store.commitFollowerReport({ runId: run.id, report: { schemaVersion: 'follower_report_v2', kind: 'daily_brief', window: run.window,
    coverage: [], claims: [{ id: 'raw_claim', status: 'discussed_not_executed', text: 'Full report claim', sourceRefs: ['source_raw'] }], suggestions: [], summary: 'Local safe report' }, renderedBody: 'Local safe report\n\nFull report claim', syncBody: 'Local safe report', sources: [{
      refId: 'source_raw', sourceKind: 'agent_message', sourceId: 'message_raw', sourceVersion: '1', contentHash: 'raw_hash',
      occurredAt: '2026-08-12T09:00:00.000Z', observedAt: '2026-08-12T10:00:00.000Z', availabilityState: 'available', localReference: {},
    }],
    privacy: { state: 'passed', validatorVersion: 'follower_privacy_v1', validatedHash: 'local_hash' } });
  const followerService = new FollowerService({
    root, store, auth: { requireUser: () => ({ id: context.ownerUserId }) },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    cloudService: service, contextBroker: { collect: () => ({ sources: [], coverage: [] }) }, executeModel: async () => '' });
  store.settingSet('database:fresh_recovery_state', JSON.stringify({ mode: 'fresh_database_recovery', cloudPullCompleted: false }));
  const pullOnly = await service.syncReports(context);
  assert.equal(pullOnly.status, 'pull_only');
  assert.equal(uploaded.length, 0);
  assert.equal(store.listFollowerReportProjections(context).length, 1);
  assert.equal(followerService.reports(context).length, 2, 'local report and independent remote report should both remain visible');
  store.upsertFollowerReportProjection({ ...context, projection: { schemaVersion: 'follower_report_projection_v1', projectionId: 'follower_projection_local_duplicate', originDeviceId: 'device_b', reportKind: 'daily_brief', window: run.window, summary: 'Local safe report', claims: [], suggestions: [], coverage: [], syncBody: 'Local safe report', validatedHash: 'local_hash', privacyValidatorVersion: 'follower_privacy_v1', revision: 1, createdAt: run.createdAt, updatedAt: run.createdAt } });
  assert.equal(followerService.reports(context).length, 2, 'a synced projection of the local report must be hidden as a duplicate');
  followerService.close();
  store.settingSet('database:fresh_recovery_state', JSON.stringify({ mode: 'fresh_database_recovery', cloudPullCompleted: true }));
  const synchronized = await service.syncReports(context);
  assert.equal(synchronized.uploaded, 1);
  assert.equal(uploaded[0].projection.syncBody, 'Local safe report');
  assert.equal(JSON.stringify(uploaded[0].projection).includes('sourceRefs'), false);
  assert.equal(uploaded[0].rawReport.schemaVersion, 'follower_raw_report_v1');
  assert.deepEqual(uploaded[0].rawReport.report.claims[0].sourceRefs, ['source_raw']);
  assert.match(uploaded[0].rawReport.renderedBody, /Full report claim/);
  const signal = await followerService.recordFeedback({ reportId: localReport.id, rating: 'helpful' });
  assert.equal(signal.upload.status, 'accepted');
  const uploadedFeedback = evidenceBatches.flat().find((item) => item.clientRecordId === signal.signal.id);
  assert.equal(uploadedFeedback.sourceKind, 'follower_report_feedback');
  assert.equal(uploadedFeedback.sourceId, localReport.id);
  assert.equal(uploadedFeedback.sourceVersion, localReport.validatedContentHash);
  assert.equal(uploadedFeedback.signalKind, 'report_feedback');
  assert.deepEqual(uploadedFeedback.normalized, { rating: 'helpful' });
  assert.equal(uploadedFeedback.personalEligible, true);
  assert.equal(uploadedFeedback.clusterEligible, true);
  failEvidenceUpload = true;
  const pendingFeedback = await followerService.recordFeedback({ reportId: localReport.id, rating: 'not_helpful' });
  assert.equal(pendingFeedback.upload.status, 'pending');
  assert.equal(store.pendingFollowerPreferenceSignals({ ...context, limit: 10 }).length, 1);
  failEvidenceUpload = false;
  await service.refreshEvolution(context);
  assert.equal(store.pendingFollowerPreferenceSignals({ ...context, limit: 10 }).length, 0, 'pending Follower Evidence must retry from the durable local outbox');
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM sessions').get().count), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) count FROM messages').get().count), 0);
  console.log('Follower Sync projection and personal evolution smoke passed');
} finally {
  try { db?.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
