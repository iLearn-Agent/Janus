import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assetRoot } from '../../../paths.js';
import { safeJsonParse } from '../../../utils.js';
import {
  FOLLOWER_CLOUD_CAPABILITIES,
  FOLLOWER_RELEASE_BASELINE_VERSION,
  assessFollowerCloudCompatibility,
  createFollowerCloudClientContract,
  followerProjectionFromReport,
  followerRawReportFromReport,
  normalizeFollowerPreferenceSignal,
  stableFollowerProjectionId,
} from '../../../../shared/follower/cloudContracts.js';
import {
  applyFollowerSystemAgentBundle,
  followerEffectiveAssetPath,
  readFollowerSystemAgentBundle,
  rollbackFollowerSystemAgentBundle,
  validateFollowerSystemAgentBundle,
  verifyFollowerSystemAgentBundle,
} from '../../../../shared/follower/systemAgentBundle.js';
import { redactFollowerSecrets } from '../domain/privacy.js';

export class FollowerCloudService {
  constructor({ root, store, cloudSync = null, appVersion = FOLLOWER_RELEASE_BASELINE_VERSION, deviceId = () => 'local' } = {}) {
    this.root = root;
    this.store = store;
    this.cloudSync = cloudSync;
    this.appVersion = appVersion || FOLLOWER_RELEASE_BASELINE_VERSION;
    this.deviceId = deviceId;
    this.syncing = new Map();
    this.defaulting = new Map();
  }

  localStatus(context) {
    const state = this.store.followerAccessSnapshot(context);
    const binding = this.store.followerEvolutionBinding(context);
    const bundle = readFollowerSystemAgentBundle(this.root);
    const cachedCapabilities = safeJsonParse(this.store.settingGet?.('follower:cloud_capabilities', '{}') || '{}', {});
    const remoteEvolution = safeJsonParse(this.store.settingGet?.(this.evolutionStatusKey(context), '{}') || '{}', {});
    const pendingEvidenceCount = this.store.pendingFollowerPreferenceSignals?.({ ...context, limit: 500 }).length || 0;
    return { configured: Boolean(this.cloudSync?.status?.().configured), reportSyncEnabled: state.reportSyncEnabled,
      evolutionEnabled: state.evolutionEnabled, binding, bundle, capabilities: cachedCapabilities, remoteEvolution, pendingEvidenceCount };
  }

  async capabilities() {
    this.requireCloud();
    const contract = this.contract();
    const result = await this.cloudSync.followerCapabilities(contract);
    const compatibility = assessFollowerCloudCompatibility(result?.clientCompatibility?.contract || contract, {
      requiredCapabilities: ['follower-report-projection-v1', 'follower-raw-report-v1'],
    });
    if (result?.enabled === false || !compatibility.compatible) throw cloudError('follower_cloud_incompatible', compatibility.reasons.join(', '));
    this.store.settingSet?.('follower:cloud_capabilities', JSON.stringify(result || {}));
    return result;
  }

  async updateSettings(context, { reportSyncEnabled, evolutionEnabled } = {}) {
    void reportSyncEnabled; void evolutionEnabled;
    return this.ensureDefaultCloud(context, { requireConfigured: true });
  }

  async ensureDefaultCloud(context, { requireConfigured = false } = {}) {
    const key = `${context.ownerUserId}:${context.workspaceId}`;
    if (this.defaulting.has(key)) return this.defaulting.get(key);
    const task = this.#ensureDefaultCloud(context, { requireConfigured }).finally(() => this.defaulting.delete(key));
    this.defaulting.set(key, task);
    return task;
  }

  async #ensureDefaultCloud(context, { requireConfigured = false } = {}) {
    const configured = Boolean(this.cloudSync?.status?.().configured);
    const evolutionEnabled = context.workspaceId === 'workspace_personal';
    const current = this.store.followerAccessSnapshot(context);
    const currentBinding = this.store.followerEvolutionBinding(context);
    const updated = current.reportSyncEnabled === true && current.evolutionEnabled === evolutionEnabled
      && currentBinding?.reportSyncEnabled === true && currentBinding?.evolutionEnabled === evolutionEnabled
      ? { state: current, binding: currentBinding }
      : this.store.updateFollowerCloudSettings({ ...context, reportSyncEnabled: true, evolutionEnabled });
    if (!configured) {
      if (requireConfigured) throw cloudError('follower_cloud_not_configured');
      return { ...updated, cloud: this.localStatus(context), status: 'pending_cloud_configuration' };
    }
    await this.capabilities();
    if (evolutionEnabled) {
      const binding = this.store.followerEvolutionBinding(context);
      if (!binding?.canonicalServiceInstanceId || binding.state !== 'active') {
        const remote = await this.cloudSync.ensureFollowerServiceInstance({ workspaceId: context.workspaceId, enabled: true, contract: this.contract() });
        this.applyRemoteEvolutionState(context, remote);
      }
      await this.syncEvidence(context);
    }
    await this.syncReports(context);
    return { ...updated, cloud: this.localStatus(context), status: 'synchronized' };
  }

  async syncReports(context) {
    const key = `${context.ownerUserId}:${context.workspaceId}`;
    if (this.syncing.has(key)) return this.syncing.get(key);
    const task = this.#syncReports(context).finally(() => this.syncing.delete(key));
    this.syncing.set(key, task);
    return task;
  }

  async refreshWorkSources() {
    if (!this.cloudSync?.status?.().configured || typeof this.cloudSync?.syncNow !== 'function') {
      return { status: 'skipped', reason: 'not_configured' };
    }
    return this.cloudSync.syncNow({ reason: 'follower_context_refresh' });
  }

  async #syncReports(context) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.reportSyncEnabled) return { status: 'disabled', pulled: 0, uploaded: 0 };
    this.requireCloud();
    await this.capabilities();
    const cursorKey = `follower:projection_cursor:${context.ownerUserId}:${context.workspaceId}`;
    let cursor = this.store.settingGet?.(cursorKey, '') || '';
    let pulled = 0; let hasMore = true;
    while (hasMore) {
      const page = await this.cloudSync.followerReportChanges({ workspaceId: context.workspaceId, cursor, limit: 200, contract: this.contract() });
      for (const item of page.items || []) {
        this.store.upsertFollowerReportProjection({ ...context, projection: item });
        pulled += 1;
      }
      cursor = String(page.cursor || cursor);
      hasMore = Boolean(page.hasMore);
      if (pulled >= 1000) break;
    }
    this.store.settingSet?.(cursorKey, cursor);
    const recovery = this.cloudSync.freshDatabaseRecoveryState?.() || {};
    if (recovery.mode === 'fresh_database_recovery' && !recovery.cloudPullCompleted) {
      return { status: 'pull_only', pulled, uploaded: 0, cursor };
    }
    const outbox = this.store.claimFollowerSyncOutbox({ ...context, leaseOwner: `follower_sync:${process.pid}`,
      leaseExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), limit: 50 });
    if (!outbox.length) return { status: 'synchronized', pulled, uploaded: 0, cursor };
    const items = outbox.map((row) => this.outboxPayload(row)).filter(Boolean);
    if (!items.length) return { status: 'synchronized', pulled, uploaded: 0, cursor };
    try {
      const response = await this.cloudSync.pushFollowerReports({ workspaceId: context.workspaceId, contract: this.contract(), items });
      const results = new Map((response.results || []).map((item) => [item.clientRecordId, item]));
      let uploaded = 0;
      for (const row of outbox) {
        const result = results.get(row.id);
        const completed = ['accepted', 'duplicate', 'deleted'].includes(result?.status);
        this.store.settleFollowerSyncOutbox({ id: row.id, status: completed ? 'completed' : 'failed',
          projectionSessionId: result?.projectionSessionId || '', projectionMessageId: result?.projectionMessageId || '',
          error: completed ? '' : result?.code || 'follower_projection_upload_failed' });
        if (completed) uploaded += 1;
      }
      return { status: uploaded === outbox.length ? 'synchronized' : 'partial', pulled, uploaded, cursor };
    } catch (error) {
      for (const row of outbox) this.store.settleFollowerSyncOutbox({ id: row.id, status: 'failed', error: safeError(error) });
      throw error;
    }
  }

  async deleteProjection(context, projection) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.reportSyncEnabled) throw cloudError('follower_report_sync_disabled');
    await this.capabilities();
    const clientRecordId = `follower_projection_delete_${sha256(`${projection.id}:${projection.validatedContentHash}`).slice(0, 32)}`;
    const response = await this.cloudSync.pushFollowerReports({ workspaceId: context.workspaceId, contract: this.contract(), items: [{
      clientRecordId, operation: 'delete', projectionId: projection.id, validatedHash: projection.validatedContentHash,
    }] });
    const result = (response.results || [])[0] || {};
    if (!['deleted', 'duplicate'].includes(result.status)) throw cloudError(result.code || 'follower_projection_delete_failed');
    return result;
  }

  async syncFollowup(context, thread = {}) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.reportSyncEnabled || !this.cloudSync) return { status: 'local_only' };
    await this.capabilities();
    const messages = (thread.messages || []).map((message) => {
      const redacted = redactFollowerSecrets(String(message.content || '')).text;
      return { id: message.id, threadId: thread.id, reportId: thread.reportId, role: message.role,
        content: redacted, createdAt: message.createdAt };
    });
    const result = await this.cloudSync.pushFollowerFollowups({ workspaceId: context.workspaceId, contract: this.contract(), messages });
    return result;
  }

  async pullFollowup(context, { reportId = '', threadId = '' } = {}) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.reportSyncEnabled || !this.cloudSync) return { status: 'local_only', messages: [] };
    await this.capabilities();
    const result = await this.cloudSync.followerFollowupMessages({ workspaceId: context.workspaceId, reportId, contract: this.contract() });
    for (const message of result.messages || []) this.store.upsertFollowerFollowupMessage({ ...message, threadId });
    return result;
  }

  async recordSignal(context, value = {}, { ensureEvolution = false, deferUploadErrors = false } = {}) {
    let setupError = null;
    if (ensureEvolution && context.workspaceId === 'workspace_personal' && this.cloudSync?.status?.().configured) {
      const state = this.store.followerAccessSnapshot(context);
      const binding = this.store.followerEvolutionBinding(context);
      if (!state.evolutionEnabled || !binding?.canonicalServiceInstanceId || binding.state !== 'active') {
        try { await this.ensureDefaultCloud(context, { requireConfigured: true }); } catch (error) { setupError = error; }
      }
    }
    const signal = normalizeFollowerPreferenceSignal(value);
    const local = this.store.recordFollowerPreferenceSignal({ ...context, signal });
    const state = this.store.followerAccessSnapshot(context);
    if (setupError) {
      if (!deferUploadErrors) throw setupError;
      return { signal: local, upload: { status: 'pending', code: safeError(setupError) } };
    }
    if (!this.cloudSync?.status?.().configured) {
      return { signal: local, upload: { status: 'pending_cloud_configuration' } };
    }
    if (!state.evolutionEnabled) return { signal: local, upload: { status: 'local_only' } };
    if (local.validationState === 'uploaded' && local.evidenceId) {
      return { signal: local, upload: { status: 'duplicate', evidenceId: local.evidenceId } };
    }
    let synced;
    try { synced = await this.syncEvidence(context); } catch (error) {
      if (!deferUploadErrors) throw error;
      return { signal: local, upload: { status: 'pending', code: safeError(error) } };
    }
    const result = synced.results.find((item) => item.clientRecordId === local.id) || { status: 'pending' };
    return { signal: local, upload: result };
  }

  async recordReportPattern(context, report = {}) {
    const projectionId = stableFollowerProjectionId({ reportId: report.id, originDeviceId: this.deviceId(),
      validatedHash: report.validatedContentHash });
    const countBy = (items, key) => (Array.isArray(items) ? items : []).reduce((counts, item) => {
      const value = String(item?.[key] || '');
      if (value) counts[value] = (counts[value] || 0) + 1;
      return counts;
    }, {});
    return this.recordSignal(context, { sourceKind: 'follower_report_projection', sourceId: projectionId,
      sourceVersion: report.validatedContentHash, signalKind: 'report_pattern', normalized: {
        reportKind: report.kind, claimStatuses: countBy(report.report?.claims, 'status'),
        extensionCategories: countBy(report.report?.suggestions, 'category'),
        coverageCategories: (report.report?.coverage || []).map((item) => item.category).filter(Boolean),
      }, lineageKey: `report-pattern:${projectionId}`, explicit: false, confidence: 1, personalEligible: false, clusterEligible: true });
  }

  async syncEvidence(context) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.evolutionEnabled) return { status: 'disabled', uploaded: 0, results: [] };
    const binding = this.store.followerEvolutionBinding(context);
    if (!binding?.canonicalServiceInstanceId) throw cloudError('follower_service_instance_missing');
    const pending = this.store.pendingFollowerPreferenceSignals({ ...context, limit: 100 });
    if (!pending.length) return { status: 'synchronized', uploaded: 0, results: [] };
    const response = await this.cloudSync.uploadFollowerEvidence({ workspaceId: context.workspaceId,
      serviceInstanceId: binding.canonicalServiceInstanceId, contract: this.contract(), items: pending.map((item) => ({
        clientRecordId: item.id, sourceKind: item.sourceKind, sourceId: item.sourceId, sourceVersion: item.sourceVersion,
        signalKind: item.signalKind, normalized: item.normalized, lineageKey: item.lineageKey, explicit: item.explicit,
        confidence: item.confidence, personalEligible: item.personalEligible, clusterEligible: item.clusterEligible,
      })) });
    const results = response.results || [];
    for (const result of results) {
      const accepted = ['accepted', 'duplicate'].includes(result.status);
      this.store.settleFollowerPreferenceSignal({ id: result.clientRecordId, evolutionOutboxId: accepted ? result.clientRecordId : '',
        evidenceId: result.evidenceId || '', state: accepted ? 'uploaded' : result.status === 'rejected' ? 'rejected' : 'validated' });
    }
    if (results.some((item) => ['accepted', 'duplicate'].includes(item.status))) {
      try { this.applyRemoteEvolutionState(context, await this.cloudSync.followerEvolutionStatus({ workspaceId: context.workspaceId, contract: this.contract() })); } catch {}
    }
    return { status: results.every((item) => ['accepted', 'duplicate'].includes(item.status)) ? 'synchronized' : 'partial',
      uploaded: results.filter((item) => ['accepted', 'duplicate'].includes(item.status)).length, results };
  }

  async refreshEvolution(context) {
    const state = this.store.followerAccessSnapshot(context);
    if (!state.evolutionEnabled) return this.localStatus(context);
    await this.syncEvidence(context);
    const remote = await this.cloudSync.followerEvolutionStatus({ workspaceId: context.workspaceId, contract: this.contract() });
    this.applyRemoteEvolutionState(context, remote);
    if (remote?.bundle?.status === 'canary_passed') await this.checkSystemBundle(context);
    return this.localStatus(context);
  }

  async rollbackPersonal(context, { kind = 'personal_overlay', targetVersionId = '' } = {}) {
    const remote = await this.cloudSync.rollbackFollowerPersonalVersion({ workspaceId: context.workspaceId, kind, targetVersionId, contract: this.contract() });
    this.applyRemoteEvolutionState(context, remote);
    return this.localStatus(context);
  }

  async decidePersonal(context, { versionId = '', decision = '', expectedStateRevision = 0, commandId = '' } = {}) {
    const remote = await this.cloudSync.decideFollowerPersonalVersion({ workspaceId: context.workspaceId, versionId, decision,
      expectedStateRevision, commandId, contract: this.contract() });
    this.applyRemoteEvolutionState(context, remote);
    return this.localStatus(context);
  }

  rollbackSystemBundle(context) {
    const rolledBack = rollbackFollowerSystemAgentBundle({ root: this.root });
    this.store.upsertFollowerEvolutionBinding({ ...context, patch: { clusterBundleId: rolledBack.bundleId,
      clusterSkillVersion: rolledBack.releaseVersion, state: 'active', lastError: '' } });
    return { status: 'rolled_back', bundle: rolledBack };
  }

  async checkSystemBundle(context) {
    const current = readFollowerSystemAgentBundle(this.root);
    const response = await this.cloudSync.followerSystemBundle({ currentBundleId: current?.bundleId || '', appVersion: this.appVersion,
      contract: this.contract() });
    if (!response?.available || !response.bundle) return { status: 'up_to_date', current };
    const bundle = response.bundle;
    validateFollowerSystemAgentBundle(bundle, { appVersion: this.appVersion });
    const publicKeyPath = process.env.JANUS_RELEASE_SIGNING_PUBLIC_KEY || path.join(assetRoot, 'release-signing-public.pem');
    if (!fs.existsSync(publicKeyPath)) throw cloudError('follower_bundle_trust_key_missing');
    verifyFollowerSystemAgentBundle(bundle, { publicKeyPem: fs.readFileSync(publicKeyPath, 'utf8') });
    const applied = applyFollowerSystemAgentBundle({ root: this.root, bundle, appVersion: this.appVersion });
    this.store.upsertFollowerEvolutionBinding({ ...context, patch: { clusterBundleId: bundle.bundleId,
      clusterSkillVersion: bundle.releaseVersion, state: 'active', lastError: '' } });
    return { status: 'applied', bundle: applied };
  }

  effectiveAssets(context) {
    const binding = this.store.followerEvolutionBinding(context);
    const skillPath = followerEffectiveAssetPath(this.root, 'SKILL.md') || path.join(assetRoot, 'system_agents', 'follower_agent', 'SKILL.md');
    const baseSkill = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, 'utf8') : '';
    const overlay = String(binding?.personalOverlayText || '').trim();
    const effectiveSkill = overlay ? `${baseSkill}\n\n<!-- FOLLOWER PERSONAL OVERLAY START -->\n${overlay}\n<!-- FOLLOWER PERSONAL OVERLAY END -->\n` : baseSkill;
    return { effectiveSkill, effectiveSkillHash: sha256(effectiveSkill), clusterSkillVersion: binding?.clusterSkillVersion || '',
      personalOverlayVersion: binding?.personalOverlayVersion || '', preferenceMemoryVersion: binding?.preferenceMemoryVersion || '',
      preferenceMemoryHash: binding?.preferenceMemoryHash || '', preferenceMemory: binding?.preferenceMemory || {} };
  }

  contract() { return createFollowerCloudClientContract({ appVersion: this.appVersion, capabilities: FOLLOWER_CLOUD_CAPABILITIES }); }

  outboxPayload(row) {
    const raw = this.store.db.prepare('SELECT * FROM follower_reports WHERE id=?').get(row.reportId);
    if (!raw || raw.validated_content_hash !== row.validatedHash) {
      this.store.settleFollowerSyncOutbox({ id: row.id, status: 'blocked_incompatible', error: 'follower_validated_hash_changed' });
      return null;
    }
    if (row.operation === 'delete') return { clientRecordId: row.id, operation: 'delete', reportId: raw.id,
      projectionId: stableFollowerProjectionId({ reportId: raw.id, originDeviceId: this.deviceId(), validatedHash: row.validatedHash }),
      validatedHash: row.validatedHash };
    const projection = followerProjectionFromReport({ id: raw.id, report: safeJsonParse(raw.report_json, {}), syncBody: raw.sync_body,
      privacyState: raw.privacy_state, privacyValidatorVersion: raw.privacy_validator_version,
      validatedContentHash: raw.validated_content_hash, createdAt: raw.created_at, updatedAt: raw.updated_at }, {
      originDeviceId: this.deviceId(), revision: 1,
    });
    const rawReport = followerRawReportFromReport({ id: raw.id, report: safeJsonParse(raw.report_json, {}),
      renderedBody: raw.rendered_body, privacyState: raw.privacy_state, privacyValidatorVersion: raw.privacy_validator_version,
      validatedContentHash: raw.validated_content_hash, createdAt: raw.created_at, updatedAt: raw.updated_at }, {
      originDeviceId: this.deviceId(),
    });
    return { clientRecordId: row.id, operation: 'upsert', projection, rawReport };
  }

  applyRemoteEvolutionState(context, remote = {}) {
    const instance = remote.serviceInstance || remote.instance || remote;
    this.store.settingSet?.(this.evolutionStatusKey(context), JSON.stringify(remote || {}));
    return this.store.upsertFollowerEvolutionBinding({ ...context, patch: {
      remoteUserId: instance.remoteUserId || instance.userId || '', canonicalServiceInstanceId: instance.id || instance.serviceInstanceId || '',
      state: instance.status || (instance.enabled === false ? 'disabled' : 'active'), evolutionEnabled: instance.enabled !== false,
      personalOverlayVersion: remote.personalOverlay?.version || '', personalOverlayText: remote.personalOverlay?.text || '',
      personalOverlayHash: remote.personalOverlay?.hash || '', preferenceMemoryVersion: remote.preferenceMemory?.version || '',
      preferenceMemory: remote.preferenceMemory?.value || {}, preferenceMemoryHash: remote.preferenceMemory?.hash || '', lastError: '',
    } });
  }

  evolutionStatusKey(context) { return `follower:evolution_status:${context.ownerUserId}:${context.workspaceId}`; }

  requireCloud() { if (!this.cloudSync?.status?.().configured) throw cloudError('follower_cloud_not_configured'); }
}

function safeError(error) { return String(error?.code || error?.message || error || 'follower_cloud_error').slice(0, 500); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function cloudError(code, detail = '') { const error = new Error(detail ? `${code}: ${detail}` : code); error.code = code; return error; }
