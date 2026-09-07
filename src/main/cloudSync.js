import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { all, get, run } from './db.js';
import { artifactMessage, parseArtifactMessage } from './artifacts.js';
import { readCodexVisibleMessages } from './transcripts.js';
import { clipText, newId, nowIso, safeJsonParse } from './utils.js';
import { assetRoot } from './paths.js';
import { CloudSyncClient, normalizeServerUrl } from '../../network/clients/cloudSyncClient.js';
import { applyMemoryOperations } from './modules/evolution/application/personalEvolutionCoordinator.js';
import { encryptEvolutionEnvelope,stableEvolutionEvidenceId } from '../shared/evolution/index.js';
import { decryptTaskMemoryContent } from '../shared/taskMemoryCrypto.js';
import { PRIVATE_ASSISTANT_DEPARTMENT_ID } from './privateAssistant.js';
import { LEGACY_PPT_AGENT_IDS, canonicalPptAgentId, isLegacyPptAgentId } from '../shared/pptAgents.js';
import { canonicalGeneralAgentId, isLegacyGeneralAgentId } from '../shared/generalAgents.js';
import {
  canonicalAgentFamilyName,
  canonicalAgentInstanceDisplayName,
  compactAgentInstanceProfiles,
  defaultAgentInstanceDisplayName,
  isDefaultAgentInstanceDisplayName,
} from '../shared/agentInstanceNaming.js';
import { redactDiagnosticValue } from '../shared/logging/index.js';
import { databaseMigrationIdsForVersion } from './modules/persistence/infrastructure/databaseMigrationRegistry.js';
import { collisionSafeChatContextStateId } from './modules/persistence/infrastructure/chatContextStateStoreMethods.js';
import {
  assessDatabaseClientCompatibility,
  createDatabaseClientContract,
} from '../shared/databaseEvolutionContract.js';
import { personalAccountId } from '../shared/accountWorkspaces.js';

const LEGACY_PPT_AGENT_ID_SET = new Set(LEGACY_PPT_AGENT_IDS);
const canonicalEmployeeAgentFamilyId = (value = '') => canonicalGeneralAgentId(canonicalPptAgentId(value));
const DESKTOP_APP_VERSION = readDesktopPackageVersion();

const DEFAULT_STATE_ID = 'default';
const EMPLOYEE_CLOUD_POLICY_VERSION = 'employee_cloud_authority_v1';
const MAX_DEFERRED_V6_CHANGE_ATTEMPTS = 50;
const MAX_FILE_BYTES = 60 * 1024 * 1024;
const SYNC_INCLUDE_DIRS = new Set(['outputs', 'artifacts', 'task_outputs', 'demo']);
const SENSITIVE_NAME_RE = /(^|[._-])(auth|secret|token|key|credential|password|private)([._-]|$)/i;
const EXCLUDED_DIRS = new Set([
  '.git',
  '.janus',
  '.npm-cache',
  '.electron-cache',
  'node_modules',
  'dist',
  'out',
  'logs',
  'config',
]);

export class CloudSyncService {
  constructor({
    root,
    db,
    store,
    client = new CloudSyncClient(),
    defaultConfig = packagedCloudSyncDefaults(),
    authStateProvider = null,
    authRefreshProvider = null,
    onEmployeeIdentityUpdated = null,
    evolutionAuthorityEnabled: _evolutionAuthorityEnabled = true,
  }) {
    this.root = root;
    this.db = db;
    this.store = store;
    this.client = client;
    this.authStateProvider = authStateProvider;
    this.authRefreshProvider = authRefreshProvider;
    this.onEmployeeIdentityUpdated = onEmployeeIdentityUpdated;
    this.evolutionAuthorityEnabled = true;
    this.employeeCapabilitiesCache = null;
    this.evolutionPreferenceRouteAvailable = null;
    this.evolutionGrantValidated = false;
    this.deviceGrantValidated = false;
    this.agentOwnershipGrantRecoveryPromise = null;
    this.employeeAuthoritySyncPromise = null;
    this.syncInFlight = null;
    this.autoSyncTimer = null;
    this.autoSyncWaiters = [];
    this.autoSyncReason = '';
    this.closed = false;
    ensureCloudState(this.db, defaultConfig);
    ensureCloudEvolutionCutover(this.db);
  }

  databaseClientContract() {
    const applied = new Set(all(this.db, 'SELECT id FROM schema_migrations ORDER BY applied_at,id').map((row) => row.id));
    return createDatabaseClientContract({
      appVersion: DESKTOP_APP_VERSION,
      migrationIds: databaseMigrationIdsForVersion(DESKTOP_APP_VERSION).filter((id) => applied.has(id)),
    });
  }

  freshDatabaseRecoveryState() {
    return safeJsonParse(this.store.settingGet?.('database:fresh_recovery_state', '{}') || '{}', {});
  }

  completeFreshDatabasePull(state = {}) {
    if (state.mode !== 'fresh_database_recovery' || state.cloudPullCompleted) return state;
    const completed = { ...state, cloudPullCompleted: true, bidirectionalSyncEnabled: true, completedAt: nowIso() };
    this.store.settingSet?.('database:fresh_recovery_state', JSON.stringify(completed));
    return completed;
  }

  status() {
    const state = this.state();
    const syncCapabilities = safeJsonParse(state.sync_capabilities_json, {});
    const configured = Boolean(state.server_url && (state.token || state.device_grant || this.authenticatedCloudIdentity(state)));
    const latestBatch = get(
      this.db,
      `SELECT * FROM cloud_sync_batches ORDER BY created_at DESC LIMIT 1`,
    );
    const pendingFileCount = get(
      this.db,
      `SELECT COUNT(*) AS count FROM cloud_file_manifest WHERE upload_status != 'uploaded'`,
    )?.count || 0;
    const pendingV6OutboxCount = Number(get(this.db, `SELECT COUNT(*) AS count FROM cloud_sync_v6_outbox
      WHERE status IN ('pending','sending','failed')`)?.count || 0);
    const deferredV6Changes = get(this.db, `SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status='quarantined' THEN 1 ELSE 0 END) AS quarantined_count
      FROM cloud_sync_v6_deferred_changes WHERE remote_user_id=?`, [state.user_id || '']) || {};
    const employeeProgression = safeJsonParse(
      this.store.settingGet?.('evolution:employee_progression_sync', '{}') || '{}',
      {},
    );
    return {
      ...publicState(state),
      configured,
      evolutionAuthority: 'cloud',
      evolutionAuthorityLocked: true,
      evolutionAuthorityEnabled: true,
      evolutionGrantReady: Boolean(state.evolution_grant && this.evolutionGrantValidated),
      deviceGrantReady: Boolean(state.device_grant && this.deviceGrantValidated),
      syncSchemaVersion: Number(state.sync_schema_version || 5),
      syncCapabilities,
      multiMemory: multiMemoryCloudStatus(state, syncCapabilities, configured),
      employeeAuthority: 'cloud',
      employeeAuthorityLocked: true,
      employeeAuthorityReady: Boolean(configured && state.evolution_grant && this.evolutionGrantValidated
        && Number(this.employeeCapabilitiesCache?.contractVersion || 0) >= 2
        && this.employeeCapabilitiesCache?.profileSequenceAuthority === 'server'),
      employeeCapabilities: this.employeeCapabilitiesCache || {},
      employeeGrantReady: Boolean(state.evolution_grant && this.evolutionGrantValidated),
      pendingEmployeeCommandCount: Number(get(this.db, `SELECT COUNT(*) AS count FROM employee_command_outbox
        WHERE status IN ('pending','sending','failed','blocked_auth','blocked_incompatible_cloud')`)?.count || 0),
      evolutionEvidenceOutbox: this.store.evolutionEvidenceOutboxCounts?.() || {},
      evolutionEvidenceUpload: this.evolutionEvidenceUploadStatus(state),
      pendingFileCount: Number(pendingFileCount || 0),
      pendingV6OutboxCount,
      deferredIdentityChangeCount: Number(deferredV6Changes.pending_count || 0),
      quarantinedIdentityChangeCount: Number(deferredV6Changes.quarantined_count || 0),
      employeeProgression,
      freshDatabaseRecovery: this.freshDatabaseRecoveryState(),
      latestBatch: latestBatch ? normalizeBatch(latestBatch) : null,
    };
  }

  saveConfig({
    serverUrl = '',
    token = '',
    autoSync = true,
    userId = '',
    deviceId = '',
  } = {}) {
    const current = this.state();
    const nextServerUrl = normalizeServerUrl(serverUrl || current.server_url);
    const next = {
      userId: String(userId || current.user_id || '').trim() || newId('user'),
      deviceId: String(deviceId || current.device_id || '').trim() || newId('device'),
      serverUrl: nextServerUrl,
      token: String(token || current.token || '').trim(),
      autoSync: autoSync ? 1 : 0,
    };
    const syncTargetChanged = next.serverUrl !== current.server_url || next.userId !== current.user_id || next.deviceId !== current.device_id;
    run(
      this.db,
      `UPDATE cloud_sync_state
       SET user_id = ?, device_id = ?, server_url = ?, token = ?, auto_sync = ?,
           evolution_grant = CASE WHEN ? THEN '' ELSE evolution_grant END,
           device_grant = CASE WHEN ? THEN '' ELSE device_grant END,
           sync_schema_version = CASE WHEN ? THEN 5 ELSE sync_schema_version END,
           sync_capabilities_json = CASE WHEN ? THEN '{}' ELSE sync_capabilities_json END,
           last_v6_cursor = CASE WHEN ? THEN '' ELSE last_v6_cursor END,
           last_sync_cursor = CASE WHEN ? THEN '' ELSE last_sync_cursor END,
           last_success_at = CASE WHEN ? THEN '' ELSE last_success_at END,
           last_error = CASE WHEN ? THEN '' ELSE last_error END,
           updated_at = ?
       WHERE id = ?`,
      [
        next.userId, next.deviceId, next.serverUrl, next.token, next.autoSync, syncTargetChanged ? 1 : 0,
        syncTargetChanged ? 1 : 0,
        syncTargetChanged ? 1 : 0, syncTargetChanged ? 1 : 0, syncTargetChanged ? 1 : 0,
        syncTargetChanged ? 1 : 0, syncTargetChanged ? 1 : 0, syncTargetChanged ? 1 : 0,
        nowIso(), DEFAULT_STATE_ID,
      ],
    );
    if (syncTargetChanged) {
      this.evolutionPreferenceRouteAvailable = null;
      run(
        this.db,
        `UPDATE cloud_file_manifest
         SET upload_status = 'pending', uploaded_at = '', last_error = '', updated_at = ?`,
        [nowIso()],
      );
      run(this.db, `UPDATE cloud_sync_v6_outbox SET status='orphaned',last_error='sync target changed',updated_at=?
        WHERE status IN ('pending','sending','failed')`, [nowIso()]);
      run(this.db, `UPDATE cloud_sync_v6_deferred_changes SET status='orphaned',last_error='sync target changed',updated_at=?
        WHERE status IN ('pending','quarantined')`, [nowIso()]);
    }
    return this.status();
  }

  requestAutoSync({ reason = 'event', delayMs = 2500 } = {}) {
    if (this.closed) return Promise.resolve({ status: 'cancelled', reason: 'closed' });
    const state = this.state();
    if (!state.auto_sync) {
      return Promise.resolve({ status: 'skipped', reason: 'auto_sync_disabled', cloud: this.status() });
    }
    if (!state.server_url || (!state.token && !state.device_grant && !this.authenticatedCloudIdentity(state))) {
      return Promise.resolve({ status: 'skipped', reason: 'not_configured', cloud: this.status() });
    }
    this.autoSyncReason = mergeReasons(this.autoSyncReason, reason);
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
    const wait = Math.max(0, Number(delayMs || 0));
    const promise = new Promise((resolve) => {
      this.autoSyncWaiters.push(resolve);
    });
    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      this.drainAutoSync().catch((error) => {
        if (this.closed) {
          this.resolveAutoSyncWaiters({ status: 'cancelled', reason: 'closed' });
          return;
        }
        const result = { status: 'failed', reason: this.autoSyncReason || reason, error: error.message || String(error), cloud: this.status() };
        this.setLastError(result.error);
        this.resolveAutoSyncWaiters(result);
      });
    }, wait);
    return promise;
  }

  async drainAutoSync() {
    if (this.closed) return { status: 'cancelled', reason: 'closed' };
    if (this.syncInFlight) {
      await this.syncInFlight.catch(() => null);
    }
    const reason = this.autoSyncReason || 'event';
    this.autoSyncReason = '';
    const result = await this.syncNow({ reason, auto: true });
    this.resolveAutoSyncWaiters(result);
    return result;
  }

  resolveAutoSyncWaiters(result) {
    const waiters = this.autoSyncWaiters.splice(0);
    for (const resolve of waiters) resolve(result);
  }

  close() {
    this.closed = true;
    if (this.autoSyncTimer) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = null;
    let cloud = null;
    try { cloud = this.status(); } catch {}
    this.resolveAutoSyncWaiters({ status: 'cancelled', reason: 'closed', ...(cloud ? { cloud } : {}) });
    return this.syncInFlight ? this.syncInFlight.catch(() => null) : null;
  }

  async syncNow({ reason = 'manual', auto = false } = {}) {
    if (this.closed) return { status: 'cancelled', reason: 'closed' };
    if (this.syncInFlight) {
      return this.syncInFlight;
    }
    this.syncInFlight = this.performSyncNow({ reason, auto });
    try {
      return await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  async performSyncNow({ reason = 'manual', auto = false } = {}) {
    const state = this.state();
    if (auto && !state.auto_sync) {
      return { status: 'skipped', reason: 'auto_sync_disabled', cloud: this.status() };
    }
    if (!state.server_url || (!state.token && !state.device_grant && !this.authenticatedCloudIdentity(state))) {
      const message = 'Cloud sync is not configured.';
      this.setLastError(message);
      return { status: 'skipped', reason: 'not_configured', message, cloud: this.status() };
    }

    if (state.device_grant || this.authenticatedCloudIdentity(state)) {
      return this.performV6SyncNow({ state, reason });
    }

    if (this.evolutionAuthorityEnabled) await this.prepareTaskMemoryCloudEnvelopes(state).catch(() => null);
    const payload = await this.buildBatchPayload(this.state());
    const batchId = payload.batch.id;
    run(
      this.db,
      `INSERT INTO cloud_sync_batches (
        id, reason, cursor_from, cursor_to, status, item_count, file_count, created_at
       ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
      [
        batchId,
        reason,
        payload.batch.cursorFrom,
        payload.batch.cursorTo,
        payload.batch.itemCount,
        payload.files.length,
        nowIso(),
      ],
    );

    try {
      const catalogPayload = employeeCatalogBootstrapPayload(payload);
      if (catalogPayload) {
        await this.client.submitBatch(state, catalogPayload);
      }
      const employeeBootstrap = await this.ensureEmployeeBootstrap(this.state()).catch((error) => ({
        status: 'unavailable', authority: 'cloud', code: error.code || 'employee_cloud_unavailable', error: error.message || String(error),
      }));
      const uploadedFileCount = await this.uploadFiles(state, payload.files);
      let response;
      try {
        response = await this.client.submitBatch(state, payload);
      } catch (error) {
        if (!/unsupported sync schema version/i.test(String(error.message || error))) throw error;
        response = await this.client.submitBatch(state, v3CompatiblePayload(payload));
      }
      const identity = state.user_id
        ? await this.client.identitySnapshot(state, { userId: state.user_id, cursor: state.last_identity_cursor || '' })
        : { status: 'skipped', cursor: state.last_identity_cursor || '', data: {} };
      if (identity?.status === 'ok') this.applyIdentitySnapshot(identity, { remoteUserId: state.user_id });
      const employees = employeeBootstrap?.status === 'unavailable'
        ? employeeBootstrap
        : await this.syncEmployeeAuthority(this.state()).catch((error) => ({
          status: 'unavailable', authority: 'cloud', code: error.code || 'employee_cloud_unavailable', error: error.message || String(error),
        }));
      const evolution = await this.syncEvolutionAuthority(this.state()).catch((error) => ({
        status: 'unavailable', authority: 'cloud', code: error.code || 'evolution_cloud_unavailable', error: error.message || String(error),
      }));
      const personalEvolution = state.user_id
        ? await this.client.personalEvolutionSnapshot(state, { userId: state.user_id, cursor: state.last_personal_evolution_cursor || '' }).catch((error) => (
            /404|not found/i.test(String(error.message || error))
              ? { status: 'unsupported', cursor: state.last_personal_evolution_cursor || '', data: {} }
              : Promise.reject(error)
          ))
        : { status: 'skipped', cursor: state.last_personal_evolution_cursor || '', data: {} };
      if (personalEvolution?.status === 'ok') this.applyPersonalEvolutionSnapshot(personalEvolution, { remoteUserId: state.user_id });
      run(
        this.db,
        `UPDATE cloud_sync_batches
         SET status = 'completed', response_json = ?, completed_at = ?
         WHERE id = ?`,
        [JSON.stringify(response || {}), nowIso(), batchId],
      );
      run(
        this.db,
        `UPDATE cloud_sync_state
         SET last_sync_cursor = ?, last_identity_cursor = ?, last_personal_evolution_cursor = ?, last_success_at = ?, last_error = '', updated_at = ?
         WHERE id = ?`,
        [payload.batch.cursorTo, identity?.cursor || state.last_identity_cursor || '', personalEvolution?.cursor || state.last_personal_evolution_cursor || '', nowIso(), nowIso(), DEFAULT_STATE_ID],
      );
      return { status: 'completed', batchId, uploadedFileCount, response, identity, employees, personalEvolution, evolution, cloud: this.status() };
    } catch (error) {
      const message = clipText(error.message || String(error), 2000);
      run(
        this.db,
        `UPDATE cloud_sync_batches
         SET status = 'failed', retry_count = retry_count + 1, error_text = ?, completed_at = ?
         WHERE id = ?`,
        [message, nowIso(), batchId],
      );
      this.setLastError(message);
      return { status: 'failed', batchId, error: message, cloud: this.status() };
    }
  }

  async performV6SyncNow({ state = this.state(), reason = 'manual' } = {}) {
    await this.ensureDeviceGrant(state);
    const activeState = this.state();
    const employeeBootstrap = await this.ensureEmployeeBootstrap(activeState);
    this.applyEmployeeOverview(employeeBootstrap);
    const employees = await this.syncEmployeeAuthority(this.state()).catch((error) => ({
      status: 'unavailable', authority: 'cloud', code: error.code || 'employee_cloud_unavailable', error: error.message || String(error),
    }));
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id=?', [activeState.user_id || '']);
    let deferredRecovery = localUser
      ? this.retryDeferredV6IdentityChanges({ remoteUserId: activeState.user_id, localUserId: localUser.id })
      : { resolved: 0, pending: 0, quarantined: 0 };
    if (this.evolutionAuthorityEnabled) await this.prepareTaskMemoryCloudEnvelopes(activeState).catch(() => null);
    const clientContract = this.databaseClientContract();
    const v5Payload = await this.buildBatchPayload(activeState);
    const payload = buildV6BatchPayload(this.db, v5Payload);
    const batchId = payload.batch.id;
    run(this.db, `INSERT INTO cloud_sync_batches (
      id,reason,cursor_from,cursor_to,status,item_count,file_count,created_at
    ) VALUES(?,?,?,?,'running',?,?,?)`, [
      batchId, reason, activeState.last_v6_cursor || '', payload.batch.cursorTo, payload.batch.itemCount, v5Payload.files.length, nowIso(),
    ]);
    try {
      let capabilities;
      try {
        capabilities = await this.client.syncV6Capabilities(this.state(), clientContract);
      } catch (error) {
        if (!isCloudGrantAuthorizationError(error)) throw error;
        this.clearCloudGrants();
        await this.ensureDeviceGrant(this.state());
        capabilities = await this.client.syncV6Capabilities(this.state(), clientContract);
      }
      const compatibility = capabilities?.databaseCompatibility
        || assessDatabaseClientCompatibility(clientContract, { requireContract: false });
      if (compatibility.compatible === false || compatibility.status === 'incompatible') {
        const error = new Error(`Cloud database contract is incompatible: ${(compatibility.reasons || []).join(', ')}`);
        error.code = 'sync_client_incompatible';
        throw error;
      }
      this.deviceGrantValidated = true;
      this.evolutionGrantValidated = true;
      const freshRecovery = this.freshDatabaseRecoveryState();
      const pullOnly = freshRecovery.mode === 'fresh_database_recovery' && !freshRecovery.cloudPullCompleted;
      const uploadedFileCount = pullOnly ? 0 : await this.uploadFilesV6(this.state(), v5Payload.files);
      const queuedBatch = pullOnly ? null : this.enqueueV6Outbox(this.state(), payload);
      const outbox = pullOnly
        ? { status: 'pull_only', processed: 0, cursorTo: '', lastResponse: null }
        : await this.drainV6Outbox(this.state(), { force: reason === 'manual', limit: 10 });
      const response = outbox.lastResponse || { status: outbox.status, batchId: queuedBatch?.batchId || batchId };
      const sourceBatchStatus = pullOnly ? 'pull_only'
        : get(this.db, 'SELECT status FROM cloud_sync_v6_outbox WHERE id=?', [queuedBatch.id])?.status || '';
      const sourceBatchReady = sourceBatchStatus === 'completed';
      let cursor = String(activeState.last_v6_cursor || '');
      let remoteChangeCount = 0;
      let snapshotEntityCount = 0;
      let deferredIdentityChangeCount = 0;
      let recoveredIdentityChangeCount = Number(deferredRecovery.resolved || 0);
      let hasMore = false;
      for (let pageNo = 0; pageNo < 20; pageNo += 1) {
        const page = await this.client.syncV6Changes(this.state(), { cursor, limit: 500, clientContract, accountId: payload.accountId });
        const snapshotEntities = page.resetRequired && Array.isArray(page.snapshot?.entities) ? page.snapshot.entities : [];
        if (snapshotEntities.length) {
          const appliedSnapshot = this.applyV6Changes(snapshotEntities, { remoteUserId: activeState.user_id });
          deferredIdentityChangeCount += Number(appliedSnapshot.deferred || 0);
          recoveredIdentityChangeCount += Number(appliedSnapshot.recovered || 0);
          snapshotEntityCount += snapshotEntities.length;
        }
        const changes = Array.isArray(page.changes) ? page.changes : [];
        if (changes.length) {
          const appliedChanges = this.applyV6Changes(changes, { remoteUserId: activeState.user_id });
          deferredIdentityChangeCount += Number(appliedChanges.deferred || 0);
          recoveredIdentityChangeCount += Number(appliedChanges.recovered || 0);
        }
        remoteChangeCount += changes.length;
        cursor = String(page.cursor || cursor);
        hasMore = Boolean(page.hasMore);
        if (!hasMore) break;
      }
      const keyRecovery = await this.recoverTaskMemoryKeys(this.state()).catch((error) => ({
        status: 'partial', recovered: 0, error: error.message || String(error),
      }));
      const progression = !sourceBatchReady
        ? await this.refreshEmployeeProgressionProjections(this.state())
        : null;
      const evolution = !sourceBatchReady
        ? { status: 'deferred', authority: 'cloud', reason: 'source_sync_pending', progression,
            outbox: this.store.evolutionEvidenceOutboxCounts?.() || {} }
        : await this.syncEvolutionAuthority(this.state()).catch((error) => ({
            status: 'unavailable', authority: 'cloud', code: error.code || 'evolution_cloud_unavailable', error: error.message || String(error),
          }));
      deferredRecovery = localUser
        ? this.retryDeferredV6IdentityChanges({ remoteUserId: activeState.user_id, localUserId: localUser.id })
        : deferredRecovery;
      recoveredIdentityChangeCount += Number(deferredRecovery.resolved || 0);
      const unresolvedIdentityChangeCount = Number(deferredRecovery.pending || 0) + Number(deferredRecovery.quarantined || 0);
      const freshPullComplete = pullOnly && !hasMore && unresolvedIdentityChangeCount === 0;
      if (freshPullComplete) this.completeFreshDatabasePull(freshRecovery);
      const batchStatus = pullOnly
        ? (freshPullComplete ? 'completed' : 'partial')
        : sourceBatchReady ? (unresolvedIdentityChangeCount ? 'partial' : 'completed') : 'queued';
      run(this.db, `UPDATE cloud_sync_batches SET status=?,response_json=?,completed_at=? WHERE id=?`, [
        batchStatus, JSON.stringify({ ...response, cursor, snapshotEntityCount, remoteChangeCount, hasMore, keyRecovery, outbox,
          sourceBatchStatus, deferredIdentityChangeCount, recoveredIdentityChangeCount, unresolvedIdentityChangeCount }),
        ['completed', 'partial'].includes(batchStatus) ? nowIso() : '', batchId,
      ]);
      run(this.db, `UPDATE cloud_sync_state SET sync_schema_version=6,sync_capabilities_json=?,last_sync_cursor=?,last_v6_cursor=?,
        last_success_at=?,last_error='',updated_at=? WHERE id=?`, [
        JSON.stringify(capabilities || {}), outbox.cursorTo || activeState.last_sync_cursor || '', cursor, nowIso(), nowIso(), DEFAULT_STATE_ID,
      ]);
      return { status: batchStatus, schemaVersion: 6, batchId, uploadedFileCount, response, capabilities,
        snapshotEntityCount, remoteChangeCount, deferredIdentityChangeCount, recoveredIdentityChangeCount,
        unresolvedIdentityChangeCount, hasMore, keyRecovery, employees, evolution, outbox, sourceBatchStatus, cloud: this.status() };
    } catch (error) {
      const message = clipText(error.message || String(error), 2000);
      const progression = await this.refreshEmployeeProgressionProjections(this.state()).catch((progressionError) => ({
        status: 'failed', refreshedAt: '', lastError: progressionError.message || String(progressionError),
      }));
      run(this.db, `UPDATE cloud_sync_batches SET status='failed',retry_count=retry_count+1,error_text=?,completed_at=? WHERE id=?`, [
        message, nowIso(), batchId,
      ]);
      this.setLastError(message);
      return { status: 'failed', schemaVersion: 6, batchId, error: message, progression, cloud: this.status() };
    }
  }

  async latestRelease({ channel = 'dev', platform = process.platform, arch = process.arch } = {}) {
    const state = this.state();
    if (!state.server_url) {
      return { status: 'skipped', reason: 'not_configured', channel, platform, arch };
    }
    try {
      return await this.client.latestRelease(state, { channel, platform, arch });
    } catch (error) {
      return {
        status: 'failed',
        channel,
        platform,
        arch,
        error: error.message || String(error),
      };
    }
  }


  uploadCompliance({ status = '', limit = 100 } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token) throw new Error('Cloud sync is not configured.');
    return this.client.uploadCompliance(state, { status, limit });
  }

  suspendCloudUser({ userId = '', reason = 'manual_suspension' } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token) throw new Error('Cloud sync is not configured.');
    return this.client.suspendCloudUser(state, { userId, reason });
  }

  reactivateCloudUser({ userId = '', reason = 'manual_reactivation' } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token) throw new Error('Cloud sync is not configured.');
    return this.client.reactivateCloudUser(state, { userId, reason });
  }

  traceFile({ sha256 = '', userId = '', deviceId = '' } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token) throw new Error('Cloud sync is not configured.');
    return this.client.traceFile(state, {
      sha256,
      userId,
      deviceId: deviceId || state.device_id,
    });
  }

  traceConversation({ conversationId = '', userId = '', deviceId = '' } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token) throw new Error('Cloud sync is not configured.');
    return this.client.traceConversation(state, {
      conversationId,
      userId,
      deviceId: deviceId || state.device_id,
    });
  }

  state() {
    ensureCloudState(this.db);
    return get(this.db, 'SELECT * FROM cloud_sync_state WHERE id = ?', [DEFAULT_STATE_ID]);
  }

  applyEvolutionPreference(preference = {}, state = this.state()) {
    const enabled = true;
    const policyVersion = 'evolution_mandatory_upload_v1';
    const revision = Math.max(1, Number(preference.stateRevision || 1));
    const commandId = String(preference.lastCommandId || '');
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id || '']);
    const updatedAt = nowIso();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, `UPDATE cloud_sync_state SET evolution_enabled=?,evolution_policy_version=?,
        evolution_state_revision=?,evolution_last_command_id=?,updated_at=? WHERE id=?`, [
        enabled ? 1 : 0, policyVersion, revision, commandId, updatedAt, DEFAULT_STATE_ID,
      ]);
      if (localUser) {
        run(this.db, `UPDATE user_agent_instances SET
          personal_evolution_consent=CASE WHEN ?=1 AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
          cluster_contribution_consent=CASE WHEN ?=1 AND sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
          personal_skill_auto_activate=0,updated_at=? WHERE user_id=?`, [
          enabled ? 1 : 0, enabled ? 1 : 0, updatedAt, localUser.id,
        ]);
        run(this.db, `UPDATE memory_documents SET
          allow_personal_evolution=CASE WHEN ?=1 AND lifecycle_state='active' AND EXISTS (
            SELECT 1 FROM user_agent_instances i WHERE i.id=memory_documents.user_agent_instance_id
              AND i.user_id=? AND i.sync_enabled=1 AND i.status='active') THEN 1 ELSE 0 END,
          allow_cluster_evolution=CASE WHEN ?=1 AND lifecycle_state='active' AND EXISTS (
            SELECT 1 FROM user_agent_instances i WHERE i.id=memory_documents.user_agent_instance_id
              AND i.user_id=? AND i.sync_enabled=1 AND i.status='active') THEN 1 ELSE 0 END,
          updated_at=? WHERE user_id=?`, [
          enabled ? 1 : 0, localUser.id, enabled ? 1 : 0, localUser.id, updatedAt, localUser.id,
        ]);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ...preference, enabled, policyVersion, stateRevision: revision, lastCommandId: commandId };
  }

  async evolutionPreference() {
    const state = this.state();
    if (this.evolutionPreferenceRouteAvailable === false) {
      return this.applyEvolutionPreference(cachedEvolutionPreference(state), state);
    }
    await this.ensureEvolutionGrant(state);
    try {
      const preference = await this.client.evolutionPreference(state);
      this.evolutionPreferenceRouteAvailable = true;
      return this.applyEvolutionPreference(preference, state);
    } catch (error) {
      if (!evolutionRouteUnavailable(error)) throw error;
      this.evolutionPreferenceRouteAvailable = false;
      return this.applyEvolutionPreference(cachedEvolutionPreference(state, error), state);
    }
  }

  async setEvolutionPreference({ enabled = true, commandId = '', expectedStateRevision } = {}) {
    if (enabled === false) {
      const error = new Error('Registered accounts must keep evolution evidence upload enabled.');
      error.code = 'evolution_preference_managed';
      error.status = 409;
      throw error;
    }
    const current = await this.evolutionPreference();
    const result = await this.client.setEvolutionPreference(this.state(), {
      enabled: enabled !== false,
      commandId: String(commandId || newId('evolution_preference')),
      expectedStateRevision: expectedStateRevision === undefined
        ? Number(current.stateRevision || 1)
        : Number(expectedStateRevision),
    });
    return this.applyEvolutionPreference(result, this.state());
  }

  async checkEvolutionUpdates() {
    await this.ensureEvolutionGrant(this.state());
    try {
      const updates = await this.client.evolutionUpdates(this.state());
      if (updates?.preference) this.applyEvolutionPreference(updates.preference, this.state());
      const checkedAt = updates?.checkedAt || nowIso();
      run(this.db, `UPDATE cloud_sync_state SET evolution_last_checked_at=?,evolution_last_check_error='',updated_at=? WHERE id=?`, [
        checkedAt, nowIso(), DEFAULT_STATE_ID,
      ]);
      this.store.settingSet('evolution:cloud_updates', JSON.stringify(updates || {}));
      return updates;
    } catch (error) {
      run(this.db, `UPDATE cloud_sync_state SET evolution_last_check_error=?,updated_at=? WHERE id=?`, [
        clipText(error.message || String(error), 2000), nowIso(), DEFAULT_STATE_ID,
      ]);
      throw error;
    }
  }

  async personalEvolutionVersions({ agentInstanceId = '' } = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, agentInstanceId);
    return this.withAgentOwnershipGrantRequest(canonicalInstanceId, (state) => (
      this.client.personalEvolutionVersions(state, { agentInstanceId: canonicalInstanceId })
    ));
  }

  async activatePersonalVersion({ agentInstanceId = '', versionId = '', commandId = '', expectedActiveVersionId } = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, agentInstanceId);
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [this.state().user_id || '']);
    const localInstance = localUser
      ? get(this.db, 'SELECT * FROM user_agent_instances WHERE id=? AND user_id=?', [canonicalInstanceId, localUser.id])
      : null;
    const expected = expectedActiveVersionId === undefined
      ? String(localInstance?.active_personal_skill_version_id || '')
      : String(expectedActiveVersionId || '');
    const resolvedCommandId = String(commandId || newId('personal_version'));
    return this.withAgentOwnershipGrantRequest(canonicalInstanceId, async (state) => {
      const result = await this.client.activatePersonalEvolutionVersion(state, versionId, {
        agentInstanceId: canonicalInstanceId,
        commandId: resolvedCommandId,
        expectedActiveVersionId: expected,
      });
      return this.refreshPersonalVersionProjection({ localUser, agentInstanceId: canonicalInstanceId, result });
    });
  }

  async refreshPersonalVersionProjection({ localUser = null, agentInstanceId = '', result = {} } = {}) {
    const versions = await this.client.personalEvolutionVersions(this.state(), { agentInstanceId });
    let projectedVersionCount = 0;
    if (localUser) {
      projectedVersionCount = this.applyCloudPersonalVersions(localUser.id, agentInstanceId, versions.items || []);
      run(this.db, 'UPDATE user_agent_instances SET active_personal_skill_version_id=?,updated_at=? WHERE id=? AND user_id=?', [
        String(result.activeVersionId || ''), nowIso(), agentInstanceId, localUser.id,
      ]);
    }
    return { ...result, versions: versions.items || [], projectedVersionCount };
  }

  authenticatedCloudIdentity(state = this.state()) {
    const authState = typeof this.authStateProvider === 'function' ? this.authStateProvider() : null;
    return Boolean(authState?.access_token && authState.remote_user_id && authState.remote_user_id === state.user_id);
  }

  async withAuthenticatedCloudIdentity(callback) {
    const readAuth = () => (typeof this.authStateProvider === 'function' ? this.authStateProvider() : null);
    let authState = readAuth();
    if (authState?.refresh_token
      && (!authState?.access_token || authState.remote_user_id !== this.state().user_id)
      && typeof this.authRefreshProvider === 'function') {
      await this.authRefreshProvider();
      authState = readAuth();
    }
    if (!authState?.access_token || authState.remote_user_id !== this.state().user_id) {
      const error = new Error('Authenticated cloud identity is required.');
      error.code = 'cloud_auth_required';
      error.status = 401;
      throw error;
    }
    try {
      return await callback(authState);
    } catch (error) {
      if (Number(error?.status || 0) !== 401 || typeof this.authRefreshProvider !== 'function') throw error;
      await this.authRefreshProvider();
      authState = readAuth();
      if (!authState?.access_token || authState.remote_user_id !== this.state().user_id) throw error;
      try {
        return await callback(authState);
      } catch (retryError) {
        if (Number(retryError?.status || 0) === 401 && !retryError?.code
          && /^\/api\/device-grants(?:\/|$)/.test(String(retryError?.route || ''))) {
          retryError.code = 'cloud_sync_contract_unsupported';
        }
        throw retryError;
      }
    }
  }

  clearCloudGrants() {
    this.evolutionGrantValidated = false;
    this.deviceGrantValidated = false;
    this.employeeCapabilitiesCache = null;
    run(this.db, `UPDATE cloud_sync_state SET evolution_grant='',device_grant='',updated_at=? WHERE id=?`, [nowIso(), DEFAULT_STATE_ID]);
  }

  clearLegacyToken() {
    run(this.db, `UPDATE cloud_sync_state SET token='',updated_at=? WHERE id=?`, [nowIso(), DEFAULT_STATE_ID]);
  }

  async withEvolutionGrantRequest(callback) {
    await this.ensureEvolutionGrant(this.state());
    try {
      const result = await callback(this.state());
      this.evolutionGrantValidated = true;
      return result;
    } catch (error) {
      if (!isCloudGrantAuthorizationError(error)) throw error;
      this.clearCloudGrants();
      await this.ensureEvolutionGrant(this.state());
      const result = await callback(this.state());
      this.evolutionGrantValidated = true;
      return result;
    }
  }

  async withDeviceGrantRequest(callback) {
    await this.ensureDeviceGrant(this.state());
    try {
      const result = await callback(this.state());
      this.deviceGrantValidated = true;
      this.evolutionGrantValidated = true;
      return result;
    } catch (error) {
      if (!isCloudGrantAuthorizationError(error)) throw error;
      this.clearCloudGrants();
      await this.ensureDeviceGrant(this.state());
      const result = await callback(this.state());
      this.deviceGrantValidated = true;
      this.evolutionGrantValidated = true;
      return result;
    }
  }

  async withAgentOwnershipGrantRequest(agentInstanceId = '', callback) {
    await this.ensureEvolutionGrant(this.state());
    let ownershipError = null;
    try {
      return await callback(this.state());
    } catch (error) {
      const staleGrantSubject = String(agentInstanceId || '').trim()
        && String(error?.code || '') === 'agent_instance_not_found'
        && this.authenticatedCloudIdentity(this.state());
      if (!staleGrantSubject) ownershipError = error;
      else {
        if (!this.agentOwnershipGrantRecoveryPromise) {
          this.agentOwnershipGrantRecoveryPromise = (async () => {
            this.clearCloudGrants();
            await this.ensureDeviceGrant(this.state());
          })().finally(() => { this.agentOwnershipGrantRecoveryPromise = null; });
        }
        await this.agentOwnershipGrantRecoveryPromise;
        try {
          return await callback(this.state());
        } catch (retryError) {
          ownershipError = retryError;
        }
      }
    }
    const localInstance = String(agentInstanceId || '').trim()
      ? get(this.db, `SELECT id,instance_kind,authority_state FROM user_agent_instances WHERE id=?`, [agentInstanceId])
      : null;
    const repairable = String(ownershipError?.code || '') === 'agent_instance_not_found'
      && localInstance?.instance_kind === 'employee'
      && ['local_confirmed', 'migration_grandfathered', 'pending'].includes(String(localInstance.authority_state || ''))
      && this.authenticatedCloudIdentity(this.state())
      && !this.syncInFlight;
    if (!repairable) throw ownershipError;
    const syncResult = await this.syncNow({ reason: 'agent_instance_ownership_repair' });
    const repaired = get(this.db, 'SELECT authority_state FROM user_agent_instances WHERE id=?', [agentInstanceId]);
    if (!['cloud_confirmed', 'pending'].includes(String(repaired?.authority_state || ''))
      || ['failed', 'skipped', 'cancelled'].includes(String(syncResult?.status || ''))) throw ownershipError;
    return callback(this.state());
  }

  setLastError(message) {
    run(
      this.db,
      `UPDATE cloud_sync_state SET last_error = ?, updated_at = ? WHERE id = ?`,
      [clipText(message || '', 2000), nowIso(), DEFAULT_STATE_ID],
    );
  }

  async buildBatchPayload(state = this.state()) {
    const cursor = state.last_sync_cursor || '';
    const generatedAt = nowIso();
    const boundLocalUser = get(this.db, 'SELECT id FROM auth_users WHERE remote_id = ?', [state.user_id || '']);
    const localIdentityUserId = boundLocalUser?.id || '';
    const allProjects = localIdentityUserId
      ? all(this.db, "SELECT * FROM projects WHERE user_id=? AND account_workspace_id='workspace_personal' ORDER BY updated_at ASC", [localIdentityUserId])
      : [];
    const allSessions = localIdentityUserId
      ? all(this.db, "SELECT * FROM sessions WHERE user_id=? AND account_workspace_id='workspace_personal' ORDER BY updated_at ASC", [localIdentityUserId])
        .filter((item) => item.department_id !== PRIVATE_ASSISTANT_DEPARTMENT_ID)
      : [];
    const syncableSessionIds = new Set(allSessions.map((item) => item.id));
    const allMessages = all(this.db, 'SELECT * FROM messages ORDER BY created_at ASC')
      .filter((item) => syncableSessionIds.has(item.session_id));
    const allModelExecutions = all(this.db, 'SELECT * FROM model_executions ORDER BY started_at ASC')
      .filter((item) => item.department_id !== PRIVATE_ASSISTANT_DEPARTMENT_ID
        && (item.user_id === localIdentityUserId || (!item.user_id && item.conversation_id && syncableSessionIds.has(item.conversation_id)))
        && (!item.conversation_id || syncableSessionIds.has(item.conversation_id)));
    const changedProjects = allProjects.filter((item) => changedAfter(item.updated_at, cursor));
    const changedSessions = allSessions.filter((item) => changedAfter(item.updated_at, cursor));
    const changedMessages = allMessages.filter((item) => changedAfter(item.created_at, cursor));
    const changedModelExecutions = allModelExecutions.filter((item) => changedAfter(item.updated_at || item.started_at, cursor));
    const syncableUserAgentInstances = localIdentityUserId ? all(
      this.db,
      `SELECT * FROM user_agent_instances
       WHERE user_id = ? AND sync_enabled = 1 AND authority_state NOT IN ('pending','conflict','rejected')
       ORDER BY updated_at ASC`,
      [localIdentityUserId],
    ) : [];
    const userAgentInstances = syncableUserAgentInstances.filter((item) => changedAfter(item.updated_at, cursor));
    const instanceIds = new Set(syncableUserAgentInstances.map((item) => item.id));
    const familyIds = new Set(syncableUserAgentInstances.map((item) => item.agent_family_id));
    const agentFamilies = localIdentityUserId
      ? all(this.db, `SELECT * FROM agent_families
        WHERE status NOT IN ('disabled','retired','archived')
          AND (recruitable=1 OR instance_kind IN ('system','governance') OR id IN (
            SELECT agent_family_id FROM user_agent_instances WHERE user_id=?
          )) ORDER BY updated_at ASC`, [localIdentityUserId])
      : [];
    for (const family of agentFamilies) familyIds.add(family.id);
    const versionIds = new Set([
      ...syncableUserAgentInstances.map((item) => item.base_agent_version_id).filter(Boolean),
      ...agentFamilies.map((item) => item.current_version_id).filter(Boolean),
    ]);
    const agentVersions = all(this.db, 'SELECT * FROM agent_versions ORDER BY created_at ASC')
      .filter((item) => versionIds.has(item.id));
    const userAgentSkillVersions = localIdentityUserId ? all(
      this.db,
      `SELECT uasv.* FROM user_agent_skill_versions uasv
       JOIN user_agent_instances uai ON uai.id = uasv.user_agent_instance_id
       WHERE uai.user_id = ? AND uai.sync_enabled = 1
         AND (? = '' OR uasv.created_at > ?)
       ORDER BY uasv.created_at ASC`,
      [localIdentityUserId, cursor, cursor],
    ) : [];
    const userAgentInstanceAliases = localIdentityUserId ? all(this.db, `SELECT * FROM user_agent_instance_aliases
      WHERE user_id = ? AND (? = '' OR created_at > ?) ORDER BY created_at`, [localIdentityUserId, cursor, cursor]) : [];
    const conversationAliases = localIdentityUserId ? all(this.db, `SELECT alias.*,conversation.account_workspace_id,
        conversation.agent_instance_id,conversation.conversation_kind
      FROM conversation_aliases alias JOIN conversations conversation ON conversation.id=alias.conversation_id
      WHERE conversation.owner_user_id=? AND conversation.account_workspace_id='workspace_personal'
        AND conversation.conversation_kind='direct' AND conversation.agent_instance_id!=''
        AND alias.alias_id!=alias.conversation_id AND (?='' OR alias.created_at>?)
      ORDER BY alias.created_at,alias.alias_id`, [localIdentityUserId, cursor, cursor]) : [];
    const syncableMemoryDocuments = localIdentityUserId ? all(
      this.db,
      `SELECT * FROM memory_documents
       WHERE user_id = ? AND account_workspace_id='workspace_personal' AND sync_enabled = 1
       ORDER BY updated_at ASC`,
      [localIdentityUserId],
    ).filter((item) => instanceIds.has(item.user_agent_instance_id)) : [];
    const memoryDocuments = syncableMemoryDocuments.filter((item) => changedAfter(item.updated_at, cursor));
    const memoryDocumentAliases = localIdentityUserId ? all(this.db, `SELECT * FROM memory_document_aliases
      WHERE user_id = ? AND reason!='cloud_document_identity' AND (? = '' OR created_at > ?) ORDER BY created_at`, [localIdentityUserId, cursor, cursor]) : [];
    const memoryDocumentIds = new Set(syncableMemoryDocuments.map((item) => item.id));
    const memoryCloudKeyById = new Map((localIdentityUserId ? all(this.db, "SELECT id,cloud_key FROM memory_documents WHERE user_id=? AND account_workspace_id='workspace_personal'", [localIdentityUserId]) : [])
      .map((item) => [item.id,item.cloud_key || item.id]));
    const memoryDocumentVersions = localIdentityUserId ? all(
      this.db,
      `SELECT mdv.*,md.cloud_key AS memory_cloud_key FROM memory_document_versions mdv
       JOIN memory_documents md ON md.id = mdv.memory_document_id
       WHERE md.user_id = ? AND md.account_workspace_id='workspace_personal' AND md.sync_enabled = 1
         AND (? = '' OR mdv.created_at > ?)
       ORDER BY mdv.created_at ASC`,
      [localIdentityUserId, cursor, cursor],
    ).filter((item) => memoryDocumentIds.has(item.memory_document_id)) : [];
    const agentContextSpaces = localIdentityUserId ? all(this.db, `SELECT * FROM agent_context_spaces
      WHERE user_id=? AND account_workspace_id='workspace_personal' AND context_kind!='legacy_history'
        AND (?='' OR updated_at>?) ORDER BY updated_at`, [localIdentityUserId, cursor, cursor])
      .filter((item) => instanceIds.has(item.user_agent_instance_id)) : [];
    const chatContextSpaceById = new Map((localIdentityUserId ? all(this.db, `SELECT * FROM agent_context_spaces
      WHERE user_id=? AND account_workspace_id='workspace_personal' AND context_kind!='legacy_history'`, [localIdentityUserId]) : []).map((item) => [item.id, item]));
    const agentContextStates = localIdentityUserId ? all(this.db, `SELECT * FROM agent_context_state
      WHERE user_id=? AND account_workspace_id='workspace_personal' AND sync_status='pending'
        AND (?='' OR updated_at>?) ORDER BY updated_at,user_agent_instance_id`, [localIdentityUserId, cursor, cursor])
      .filter((item) => instanceIds.has(item.user_agent_instance_id)) : [];
    const chatContextStates = localIdentityUserId ? all(this.db, `SELECT * FROM chat_context_states
      WHERE owner_user_id=? AND sync_status='pending' ORDER BY updated_at,id`, [localIdentityUserId])
      .filter((item) => syncableSessionIds.has(item.session_id)) : [];
    const rawMemorySyncMappings = localIdentityUserId ? all(this.db, `SELECT * FROM memory_sync_mappings
      WHERE owner_user_id=? AND (?='' OR updated_at>?) ORDER BY updated_at`, [
      localIdentityUserId,cursor,cursor,
    ]).filter((item) => memoryDocumentIds.has(item.memory_document_id)) : [];
    const memorySyncMappings = [...new Map(rawMemorySyncMappings.map((item) => [item.cloud_key,item])).values()];
    const personalEvolutionProposals = localIdentityUserId ? all(this.db, `SELECT pep.* FROM personal_evolution_proposals pep
      JOIN user_agent_instances uai ON uai.id = pep.user_agent_instance_id
      WHERE pep.user_id = ? AND pep.sync_scope = 'cloud' AND uai.sync_enabled = 1
        AND (? = '' OR pep.updated_at > ?) ORDER BY pep.updated_at`, [localIdentityUserId, cursor, cursor]) : [];
    const personalEvolutionMemoryOperations = localIdentityUserId ? all(this.db, `SELECT peo.* FROM personal_evolution_memory_operations peo
      JOIN personal_evolution_proposals pep ON pep.id = peo.proposal_id
      JOIN user_agent_instances uai ON uai.id = pep.user_agent_instance_id
      WHERE pep.user_id = ? AND pep.sync_scope = 'cloud' AND uai.sync_enabled = 1
        AND (? = '' OR peo.updated_at > ?) ORDER BY peo.updated_at`, [localIdentityUserId, cursor, cursor]) : [];
    const sessionById = new Map(allSessions.map((item) => [item.id, item]));
    const projects = changedProjects.map(cloudProjectPayload);
    const conversations = changedSessions.map(cloudConversationPayload);
    const messages = changedMessages.map((item) => cloudMessagePayload(
      item,
      sessionById.get(item.session_id),
      memoryCloudKeyById,
    ));
    const modelExecutions = changedModelExecutions.map(cloudModelExecutionPayload);
    const taskRuns = localIdentityUserId ? all(
      this.db,
      `SELECT * FROM task_runs
       WHERE owner_user_id = ? AND account_workspace_id='workspace_personal' AND (? = '' OR updated_at > ?)
       ORDER BY updated_at ASC`,
      [localIdentityUserId, cursor, cursor],
    ).map((row) => ({
      ...row,
      metadata: safeJsonParse(row.metadata_json, {}),
      metadata_json: undefined,
    })) : [];
    const taskRunIds = new Set(taskRuns.map((item) => item.id));
    const taskNodes = all(
      this.db,
      `SELECT * FROM task_nodes
       WHERE (? = '' OR updated_at > ?)
       ORDER BY updated_at ASC`,
      [cursor, cursor],
    ).filter((row) => taskRunIds.has(row.task_run_id));
    const taskEvents = all(
      this.db,
      `SELECT e.*,n.agent_instance_id AS user_agent_instance_id,r.owner_user_id
       FROM task_events e
       LEFT JOIN task_nodes n ON n.id=e.task_node_id
       LEFT JOIN task_runs r ON r.id=e.task_run_id
      WHERE (? = '' OR e.updated_at > ?)
       ORDER BY e.updated_at ASC,e.id ASC`,
      [cursor, cursor],
    ).filter((row) => row.owner_user_id === localIdentityUserId)
      .map(sanitizeTaskEventForCloud);
    const synchronizedTaskRunIds = new Set(syncableMemoryDocuments.map((item) => item.task_run_id).filter(Boolean));
    const taskSecurityContexts = localIdentityUserId ? all(this.db, `SELECT * FROM task_security_contexts
      WHERE owner_user_id = ? AND (? = '' OR updated_at > ?) ORDER BY updated_at`, [localIdentityUserId, cursor, cursor]) : [];
    const synchronizedTaskSecurityContexts = taskSecurityContexts.filter((item) => synchronizedTaskRunIds.has(item.task_run_id));
    const communications = all(
      this.db,
      `SELECT * FROM communications
       WHERE (? = '' OR created_at > ? OR COALESCE(resolved_at, '') > ?)
       ORDER BY created_at ASC`,
      [cursor, cursor, cursor],
    ).filter((row) => taskRunIds.has(row.task_run_id));
    const transcripts = [];
    for (const session of changedSessions) {
      transcripts.push(...readCodexVisibleMessages(this.root, session.id, session.codex_thread_id));
    }
    const fileMessages = changedMessages.filter((message) => sessionById.get(message.session_id)?.status !== 'deleted');
    const files = await this.scanOutputFiles(fileMessages, { cursor });
    const fileRefs = buildFileRefs({
      root: this.root,
      files,
      projects: allProjects,
      sessions: allSessions,
      messages: fileMessages,
    });
    this.persistFileRefs(fileRefs);
    const timestamps = [
      generatedAt,
      ...changedProjects.map((item) => item.updated_at),
      ...changedSessions.map((item) => item.updated_at),
      ...changedMessages.map((item) => item.created_at),
      ...changedModelExecutions.map((item) => item.updated_at || item.started_at),
      ...userAgentInstances.map((item) => item.updated_at),
      ...agentFamilies.map((item) => item.updated_at),
      ...agentVersions.map((item) => item.created_at),
      ...userAgentSkillVersions.map((item) => item.created_at),
      ...userAgentInstanceAliases.map((item) => item.created_at),
      ...conversationAliases.map((item) => item.created_at),
      ...memoryDocuments.map((item) => item.updated_at),
      ...memoryDocumentVersions.map((item) => item.created_at),
      ...memoryDocumentAliases.map((item) => item.created_at),
      ...agentContextSpaces.map((item) => item.updated_at),
      ...agentContextStates.map((item) => item.updated_at),
      ...chatContextStates.map((item) => item.updated_at),
      ...memorySyncMappings.map((item) => item.updated_at),
      ...personalEvolutionProposals.map((item) => item.updated_at),
      ...personalEvolutionMemoryOperations.map((item) => item.updated_at),
      ...taskRuns.map((item) => item.updated_at),
      ...synchronizedTaskSecurityContexts.map((item) => item.updated_at),
      ...taskNodes.map((item) => item.updated_at),
      ...taskEvents.map((item) => item.updated_at || item.created_at),
      ...communications.map((item) => item.resolved_at || item.created_at),
    ].filter(Boolean).sort();
    const itemCount = projects.length + conversations.length + messages.length + modelExecutions.length
      + userAgentInstances.length + agentFamilies.length + agentVersions.length
      + userAgentSkillVersions.length + userAgentInstanceAliases.length
      + conversationAliases.length
      + memoryDocuments.length + memoryDocumentVersions.length + memoryDocumentAliases.length
      + agentContextSpaces.length + agentContextStates.length + memorySyncMappings.length
      + chatContextStates.length
      + personalEvolutionProposals.length + personalEvolutionMemoryOperations.length
      + taskRuns.length + synchronizedTaskSecurityContexts.length + taskNodes.length + taskEvents.length + communications.length + transcripts.length + fileRefs.length;
    return {
      schemaVersion: 5,
      batch: {
        id: newId('sync_batch'),
        generatedAt,
        cursorFrom: cursor,
        cursorTo: timestamps.at(-1) || generatedAt,
        itemCount,
      },
      device: {
        userId: state.user_id,
        deviceId: state.device_id,
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
      },
      data: {
        projects,
        conversations,
        messages,
        modelExecutions,
        agentFamilies: agentFamilies.map(sanitizeCloudValue),
        agentVersions: agentVersions.map(sanitizeCloudValue),
        userAgentInstances: userAgentInstances.map(sanitizeCloudValue),
        userAgentSkillVersions: userAgentSkillVersions.map(sanitizeCloudValue),
        userAgentInstanceAliases: userAgentInstanceAliases.map(sanitizeCloudValue),
        conversationAliases: conversationAliases.map((item) => sanitizeCloudValue({
          id: item.alias_id,
          alias_conversation_id: item.alias_id,
          canonical_conversation_id: item.conversation_id,
          conversation_id: item.conversation_id,
          account_workspace_id: item.account_workspace_id || 'workspace_personal',
          conversation_kind: item.conversation_kind || 'direct',
          agent_instance_id: item.agent_instance_id || '',
          alias_kind: item.alias_kind || '',
          reason: item.reason || '',
          created_at: item.created_at || '',
        })),
        memoryDocuments: memoryDocuments.map((item) => memoryDocumentCloudPayload(item)),
        memoryDocumentVersions: memoryDocumentVersions.map((item) => sanitizeCloudValue({
          ...item,memory_document_id: item.memory_cloud_key || memoryCloudKeyById.get(item.memory_document_id) || item.memory_document_id,
          memory_cloud_key: undefined,
        })),
        memoryDocumentAliases: memoryDocumentAliases.map(sanitizeCloudValue),
        agentContextSpaces: agentContextSpaces.map((item) => sanitizeCloudValue({
          ...item,memory_document_id: memoryCloudKeyById.get(item.memory_document_id) || '',legacy_session_id: undefined,
        })),
        agentContextStates: agentContextStates.map((item) => sanitizeCloudValue({
          id: item.user_agent_instance_id,
          owner_user_id: item.user_id,
          user_agent_instance_id: item.user_agent_instance_id,
          primary_conversation_id: item.primary_session_id || '',
          active_context_space_id: item.active_context_space_id || '',
          active_memory_document_id: memoryCloudKeyById.get(item.active_memory_document_id) || item.active_memory_document_id || '',
          active_memory_cloud_key: memoryCloudKeyById.get(item.active_memory_document_id) || '',
          state_revision: item.state_revision,
          base_state_revision: item.base_state_revision,
          last_command_id: item.last_command_id || '',
          source_device_id: item.source_device_id || '',
          sync_status: item.sync_status || 'pending',
          created_at: item.created_at,
          updated_at: item.updated_at,
        })),
        chatContextStates: chatContextStates.map((item) => {
          const context = chatContextSpaceById.get(item.context_space_id || '');
          return sanitizeCloudValue({
            ...item,
            user_agent_instance_id: context?.user_agent_instance_id || '', context_kind: context?.context_kind || '',
            memory_document_id: memoryCloudKeyById.get(context?.memory_document_id) || '', project_id: context?.project_id || '',
            task_run_id: context?.task_run_id || '', delegation_id: context?.delegation_id || '', group_id: context?.group_id || '',
            relationship_user_id: context?.relationship_user_id || '',
          });
        }),
        memorySyncMappings: memorySyncMappings.map((item) => sanitizeCloudValue({
          id: item.cloud_key,owner_user_id: item.owner_user_id,user_agent_instance_id: item.user_agent_instance_id,
          cloud_key: item.cloud_key,memory_document_id: memoryCloudKeyById.get(item.memory_document_id) || item.cloud_key,status: item.status,
          created_at: item.created_at,updated_at: item.updated_at,
        })),
        personalEvolutionProposals: personalEvolutionProposals.map((item) => cloudPersonalEvolutionProposalPayload(this.db, item)),
        personalEvolutionMemoryOperations: personalEvolutionMemoryOperations.map((item) => sanitizeCloudValue({
          ...item,
          memory_document_id: memoryCloudKeyById.get(item.memory_document_id) || item.memory_document_id,
        })),
        taskRuns: taskRuns.map(sanitizeCloudValue),
        taskSecurityContexts: synchronizedTaskSecurityContexts.map(cloudTaskSecurityContextPayload),
        taskNodes: taskNodes.map(sanitizeCloudValue),
        taskEvents: taskEvents.map(sanitizeCloudValue),
        communications: communications.map(sanitizeCloudValue),
        codexTranscripts: transcripts.map((item) => {
          const session = sessionById.get(item.session_id) || {};
          const createdAt = item.created_at || '';
          const content = String(item.content || '');
          return {
            id: stableTranscriptId(item.session_id, item.role, content, createdAt),
            userId: session.user_id || '',
            conversationId: item.session_id,
            role: item.role,
            content,
            departmentId: session.department_id || '',
            agentId: session.agent_id || '',
            modelId: item.model_id || '',
            reasoningEffort: item.reasoning_effort || '',
            codexTurnId: item.turn_id || '',
            createdAt,
          };
        }),
        fileRefs,
      },
      files,
    };
  }

  applyIdentitySnapshot(snapshot = {}, { remoteUserId = '', deferMissingMemoryVersions = false } = {}) {
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [remoteUserId || '']);
    if (!localUser) return { status: 'skipped', reason: 'unbound_remote_user' };
    // Identity snapshots may be applied before the normal runtime bootstrap has
    // initialized workspace membership (for example during first sync or in a
    // background migration). Context-state imports resolve the user's primary
    // session through the Personal Workspace, so establish that invariant
    // before opening the snapshot transaction.
    this.store.ensureAccountWorkspaces({
      user: {
        id: localUser.id,
        displayName: localUser.display_name || '',
        avatarUrl: localUser.avatar_url || '',
      },
    });
    const data = snapshot.data || {};
    const families = Array.isArray(data.agentFamilies) ? data.agentFamilies : [];
    const versions = Array.isArray(data.agentVersions) ? data.agentVersions : [];
    const instances = Array.isArray(data.userAgentInstances) ? data.userAgentInstances : [];
    const instanceAliases = Array.isArray(data.userAgentInstanceAliases) ? data.userAgentInstanceAliases : [];
    const incomingAgentAliasIds = new Set(instanceAliases
      .filter((row) => String(row?.status || '').toLowerCase() !== 'deleted')
      .map((row) => String(row?.alias_instance_id || row?.aliasInstanceId || '').trim())
      .filter(Boolean));
    const skillVersions = Array.isArray(data.userAgentSkillVersions) ? data.userAgentSkillVersions : [];
    const documents = Array.isArray(data.memoryDocuments) ? data.memoryDocuments : [];
    const documentVersions = Array.isArray(data.memoryDocumentVersions) ? data.memoryDocumentVersions : [];
    const documentAliases = Array.isArray(data.memoryDocumentAliases) ? data.memoryDocumentAliases : [];
    const contextSpaces = Array.isArray(data.agentContextSpaces) ? data.agentContextSpaces : [];
    const contextStates = Array.isArray(data.agentContextStates) ? data.agentContextStates : [];
    const chatContextStates = Array.isArray(data.chatContextStates) ? data.chatContextStates : [];
    const memorySyncMappings = Array.isArray(data.memorySyncMappings) ? data.memorySyncMappings : [];
    const taskSecurityContexts = Array.isArray(data.taskSecurityContexts) ? data.taskSecurityContexts : [];
    const deferredMemoryVersions = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of families) upsertLocalAgentFamily(this.db, row);
      for (const row of versions) upsertLocalAgentVersion(this.db, row);
      for (const row of instances) {
        const rawFamilyId = row.agent_family_id || row.agentFamilyId || '';
        const familyId = canonicalEmployeeAgentFamilyId(rawFamilyId);
        const canonicalId = row.id || '';
        if (!familyId || !canonicalId) continue;
        const family = get(this.db, 'SELECT name,current_version_id FROM agent_families WHERE id=?', [familyId]) || {};
        const incomingBaseAgentVersionId = isLegacyGeneralAgentId(rawFamilyId)
          ? family.current_version_id || row.base_agent_version_id || row.baseAgentVersionId || ''
          : row.base_agent_version_id || row.baseAgentVersionId || '';
        const requestedIncomingSequence = Math.max(0, Math.floor(Number(
          row.family_instance_seq ?? row.familyInstanceSeq ?? 0,
        ) || 0));
        const incomingSequence = resolveLocalImportedAgentSequence(this.db, {
          userId: localUser.id,
          familyId,
          instanceId: canonicalId,
          requestedSequence: requestedIncomingSequence,
        });
        const rawIncomingDisplayName = String(row.display_name || row.displayName || '').trim();
        const incomingDisplayName = rawIncomingDisplayName && !isDefaultAgentInstanceDisplayName(
          rawIncomingDisplayName, family.name || familyId, familyId, requestedIncomingSequence || 1,
        )
          ? rawIncomingDisplayName
          : defaultAgentInstanceDisplayName(family.name || familyId, incomingSequence, familyId);
        // A current cloud snapshot can intentionally retain an inactive legacy
        // instance while also declaring that instance as an alias of the active
        // canonical row. Importing the legacy instance first would reverse the
        // declared edge (active -> legacy) before aliases are normalized and
        // create a transient cycle. The alias pass below preserves/merges that
        // history after all canonical instance rows have been materialized.
        if (incomingAgentAliasIds.has(canonicalId)) continue;
        const existingById = get(this.db, 'SELECT * FROM user_agent_instances WHERE id=? AND user_id=?', [canonicalId, localUser.id]);
        let existing = existingById;
        if (!existing && isLegacyPptAgentId(rawFamilyId)) {
          existing = get(this.db, `SELECT * FROM user_agent_instances WHERE user_id=? AND agent_family_id=?
            ORDER BY created_at,id LIMIT 1`, [localUser.id, familyId]);
        }
        if (existingById && isLegacyPptAgentId(existingById.agent_family_id)) {
          if (existing && existing.id !== existingById.id) {
            this.store.bindCanonicalAgentInstance({
              userId: localUser.id,
              aliasInstanceId: existing.id,
              canonicalInstanceId: existingById.id,
              reason: 'ppt_cloud_snapshot_canonical',
              withinTransaction: true,
            });
          }
          run(this.db, 'UPDATE user_agent_instances SET agent_family_id=?,updated_at=? WHERE id=?', [familyId, nowIso(), existingById.id]);
          existing = get(this.db, 'SELECT * FROM user_agent_instances WHERE id=?', [existingById.id]);
        }
        if (existing && existing.id !== canonicalId && isLegacyPptAgentId(rawFamilyId)) {
          this.store.bindCanonicalAgentInstance({
            userId: localUser.id,
            aliasInstanceId: existing.id,
            canonicalInstanceId: canonicalId,
            reason: 'cloud_canonical_merge',
            withinTransaction: true,
          });
        } else if (!existing) {
          run(this.db, `INSERT INTO user_agent_instances (
            id, user_id, agent_family_id, base_agent_version_id, active_personal_skill_version_id,
            status,instance_kind,employment_state,quota_exempt,recruited_at,deactivated_at,last_state_changed_at,
            state_revision,recruitment_source,policy_version,pending_target_state,authority_state,last_employee_command_id,
            sync_enabled, personal_evolution_consent, cluster_contribution_consent, created_at, updated_at,
            personal_skill_auto_activate,family_instance_seq,display_name,note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, ?,?,?,?)`, [
            canonicalId, localUser.id, familyId, incomingBaseAgentVersionId,
            row.active_personal_skill_version_id || row.activePersonalSkillVersionId || '', row.status || 'active',
            row.instance_kind || row.instanceKind || 'employee', row.employment_state || row.employmentState || (row.status === 'inactive' ? 'inactive' : 'active'),
            Number(row.quota_exempt ?? row.quotaExempt ?? 0), row.recruited_at || row.recruitedAt || '', row.deactivated_at || row.deactivatedAt || '',
            row.last_state_changed_at || row.lastStateChangedAt || '', Number(row.state_revision ?? row.stateRevision ?? 1),
            row.recruitment_source || row.recruitmentSource || 'cloud_sync', row.policy_version || row.policyVersion || EMPLOYEE_CLOUD_POLICY_VERSION,
            row.policy_version === EMPLOYEE_CLOUD_POLICY_VERSION || row.policyVersion === EMPLOYEE_CLOUD_POLICY_VERSION ? 'cloud_confirmed' : 'local_confirmed',
            row.sync_enabled === 0 || row.syncEnabled === false ? 0 : 1,
            row.personal_evolution_consent || row.personalEvolutionConsent ? 1 : 0,
            (row.sync_enabled !== 0 && row.syncEnabled !== false) && (row.status || 'active') === 'active' ? 1 : 0,
            row.created_at || row.createdAt || nowIso(),
            row.updated_at || row.updatedAt || nowIso(),
            row.personal_skill_auto_activate || row.personalSkillAutoActivate ? 1 : 0,
            incomingSequence,
            incomingDisplayName || defaultAgentInstanceDisplayName(family.name || familyId, incomingSequence, familyId), row.note || '',
          ]);
        }
        const localRow = get(this.db, `SELECT authority_state,state_revision,pending_target_state,last_employee_command_id
          FROM user_agent_instances WHERE id = ?`, [canonicalId]);
        const remoteUpdatedAt = row.updated_at || row.updatedAt || '';
        const localProfileUpdatedAt = existing?.updated_at || '';
        const remoteProfileWins = !existing || !localProfileUpdatedAt || !remoteUpdatedAt
          || remoteUpdatedAt >= localProfileUpdatedAt;
        const remoteEmploymentState = row.employment_state || row.employmentState || (row.status === 'inactive' ? 'inactive' : 'active');
        const remoteRevision = Number(row.state_revision ?? row.stateRevision ?? 1);
        const localPending = ['pending', 'conflict'].includes(localRow?.authority_state || '');
        const remoteSettlesPendingTarget = Boolean(localRow?.pending_target_state)
          && remoteEmploymentState === localRow.pending_target_state;
        const newerCloudAuthority = remoteRevision > Number(localRow?.state_revision || 0);
        const pendingCommand = localRow?.last_employee_command_id
          ? this.store.getEmployeeCommandOutbox?.({ userId: localUser.id, commandId: localRow.last_employee_command_id })
          : null;
        const preserveDependentIntent = Boolean(pendingCommand?.dependsOnCommandId);
        const preservePendingLifecycle = localPending && !remoteSettlesPendingTarget
          && (preserveDependentIntent || !newerCloudAuthority);
        const supersededPendingCommandId = localPending && !preservePendingLifecycle
          ? String(localRow?.last_employee_command_id || '')
          : '';
        run(this.db, `UPDATE user_agent_instances SET agent_family_id=?,base_agent_version_id = ?, active_personal_skill_version_id = ?,
          status = CASE WHEN ? THEN status ELSE ? END,
          instance_kind = CASE WHEN ? THEN instance_kind ELSE ? END,
          employment_state = CASE WHEN ? THEN employment_state ELSE ? END,
          quota_exempt = CASE WHEN ? THEN quota_exempt ELSE ? END,
          recruited_at = CASE WHEN ? THEN recruited_at ELSE ? END,
          deactivated_at = CASE WHEN ? THEN deactivated_at ELSE ? END,
          last_state_changed_at = CASE WHEN ? THEN last_state_changed_at ELSE ? END,
          state_revision = CASE WHEN ? THEN state_revision ELSE ? END,
          recruitment_source = CASE WHEN ? THEN recruitment_source ELSE ? END,
          policy_version = CASE WHEN ? THEN policy_version ELSE ? END,
          pending_target_state = CASE WHEN ? THEN pending_target_state ELSE '' END,
          authority_state = CASE WHEN ? THEN authority_state ELSE ? END,
          last_employee_command_id = CASE WHEN ? THEN last_employee_command_id ELSE '' END,
          sync_enabled = ?, personal_evolution_consent = ?, cluster_contribution_consent = ?,
          family_instance_seq=CASE WHEN ?>0 THEN ? ELSE family_instance_seq END,
          display_name=CASE WHEN ? AND ?<>'' THEN ? ELSE display_name END,
          note=CASE WHEN ? THEN ? ELSE note END,
          updated_at=CASE WHEN ? THEN ? ELSE updated_at END WHERE id = ?`, [
          familyId, incomingBaseAgentVersionId, row.active_personal_skill_version_id || row.activePersonalSkillVersionId || '',
          preservePendingLifecycle ? 1 : 0, row.status || 'active', preservePendingLifecycle ? 1 : 0, row.instance_kind || row.instanceKind || 'employee',
          preservePendingLifecycle ? 1 : 0, remoteEmploymentState,
          preservePendingLifecycle ? 1 : 0, Number(row.quota_exempt ?? row.quotaExempt ?? 0),
          preservePendingLifecycle ? 1 : 0, row.recruited_at || row.recruitedAt || '',
          preservePendingLifecycle ? 1 : 0, row.deactivated_at || row.deactivatedAt || '',
          preservePendingLifecycle ? 1 : 0, row.last_state_changed_at || row.lastStateChangedAt || '',
          preservePendingLifecycle ? 1 : 0, remoteRevision,
          preservePendingLifecycle ? 1 : 0, row.recruitment_source || row.recruitmentSource || 'cloud_sync',
          preservePendingLifecycle ? 1 : 0, row.policy_version || row.policyVersion || EMPLOYEE_CLOUD_POLICY_VERSION,
          preservePendingLifecycle ? 1 : 0,
          preservePendingLifecycle ? 1 : 0,
          row.policy_version === EMPLOYEE_CLOUD_POLICY_VERSION || row.policyVersion === EMPLOYEE_CLOUD_POLICY_VERSION ? 'cloud_confirmed' : 'local_confirmed',
          preservePendingLifecycle ? 1 : 0,
          row.sync_enabled === 0 || row.syncEnabled === false ? 0 : 1,
          row.personal_evolution_consent || row.personalEvolutionConsent ? 1 : 0,
          (row.sync_enabled !== 0 && row.syncEnabled !== false) && (row.status || 'active') === 'active' ? 1 : 0,
          incomingSequence, incomingSequence,
          remoteProfileWins ? 1 : 0, incomingDisplayName, incomingDisplayName,
          remoteProfileWins ? 1 : 0, row.note || '',
          remoteProfileWins ? 1 : 0, remoteUpdatedAt || nowIso(), canonicalId,
        ]);
        if (supersededPendingCommandId) {
          const targetReached = remoteSettlesPendingTarget;
          run(this.db, `UPDATE employee_command_outbox SET status=?,last_error=?,completed_at=?,updated_at=?
            WHERE command_id=? AND user_id=? AND status IN ('pending','sending','failed','blocked_auth','blocked_incompatible_cloud','conflict')`, [
            targetReached ? 'confirmed' : 'conflict',
            targetReached ? '' : 'superseded_by_newer_cloud_snapshot',
            nowIso(), nowIso(), supersededPendingCommandId, localUser.id,
          ]);
        }
        run(this.db, 'UPDATE user_agent_instances SET personal_skill_auto_activate = ? WHERE id = ?', [
          row.personal_skill_auto_activate || row.personalSkillAutoActivate ? 1 : 0,
          canonicalId,
        ]);
      }
      const normalizedAgentAliases = normalizeIncomingAgentInstanceAliases(this.db, localUser.id, instanceAliases);
      for (const canonicalId of normalizedAgentAliases.canonicalIds) {
        run(this.db, 'DELETE FROM user_agent_instance_aliases WHERE alias_instance_id=? AND user_id=?', [canonicalId, localUser.id]);
      }
      for (const row of normalizedAgentAliases.rows) {
        const aliasId = row.alias_instance_id || row.aliasInstanceId || '';
        const canonicalId = row.canonical_instance_id || row.canonicalInstanceId || '';
        if (!aliasId || !canonicalId || aliasId === canonicalId) continue;
        const existingAlias = get(this.db, `SELECT canonical_instance_id,user_id FROM user_agent_instance_aliases
          WHERE alias_instance_id=?`, [aliasId]);
        if (existingAlias?.canonical_instance_id === canonicalId && (!existingAlias.user_id || existingAlias.user_id === localUser.id)) continue;
        if (get(this.db, 'SELECT id FROM user_agent_instances WHERE id = ?', [aliasId])) {
          this.store.bindCanonicalAgentInstance({ userId: localUser.id, aliasInstanceId: aliasId, canonicalInstanceId: canonicalId, reason: row.reason || 'cloud_alias', withinTransaction: true });
        } else {
          this.store.assertAgentInstanceAliasBinding?.({
            userId: localUser.id, aliasInstanceId: aliasId, canonicalInstanceId: canonicalId,
          });
          run(this.db, `INSERT INTO user_agent_instance_aliases (alias_instance_id, canonical_instance_id, user_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(alias_instance_id) DO UPDATE SET canonical_instance_id = excluded.canonical_instance_id, user_id = excluded.user_id, reason = excluded.reason`,
          [aliasId, canonicalId, localUser.id, row.reason || 'cloud_alias', row.created_at || row.createdAt || nowIso()]);
        }
      }
      compactLocalAgentInstanceProfiles(this.db, localUser.id);
      for (const row of skillVersions) upsertLocalSkillVersion(this.db, row);
      for (const instanceId of new Set(skillVersions.map((row) => canonicalLocalAgentInstanceId(
        this.db, row.user_agent_instance_id || row.userAgentInstanceId || '',
      )).filter(Boolean))) {
        const winner = get(this.db, `SELECT id,updated_at,activated_at FROM user_agent_skill_versions
          WHERE user_agent_instance_id=? AND activated_at!='' ORDER BY activated_at DESC,updated_at DESC,id DESC LIMIT 1`, [instanceId]);
        if (winner) {
          run(this.db, `UPDATE user_agent_skill_versions SET status=CASE WHEN id=? THEN 'active' ELSE 'archived' END
            WHERE user_agent_instance_id=? AND activated_at!=''`, [winner.id, instanceId]);
          run(this.db, 'UPDATE user_agent_instances SET active_personal_skill_version_id=?,updated_at=? WHERE id=?', [
            winner.id, winner.updated_at || winner.activated_at || nowIso(), instanceId,
          ]);
        }
      }
      for (const row of documents) upsertLocalMemoryDocument(this.db, this.store, localUser.id, row);
      for (const row of documentAliases) {
        const aliasId = row.alias_document_id || row.aliasDocumentId || '';
        const canonicalId = row.canonical_document_id || row.canonicalDocumentId || '';
        if (!aliasId || !canonicalId || aliasId === canonicalId) continue;
        if (get(this.db, 'SELECT id FROM memory_documents WHERE id = ?', [aliasId])) {
          this.store.bindCanonicalMemoryDocument({ userId: localUser.id, aliasDocumentId: aliasId, canonicalDocumentId: canonicalId, reason: row.reason || 'cloud_alias', withinTransaction: true });
        } else {
          run(this.db, `INSERT INTO memory_document_aliases (alias_document_id, canonical_document_id, user_id, reason, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(alias_document_id) DO UPDATE SET canonical_document_id = excluded.canonical_document_id, user_id = excluded.user_id, reason = excluded.reason`,
          [aliasId, canonicalId, localUser.id, row.reason || 'cloud_alias', row.created_at || row.createdAt || nowIso()]);
        }
      }
      const remoteCloudKeyByDocumentId = new Map(memorySyncMappings
        .filter((row) => (row.status || 'active') === 'active')
        .map((row) => [row.memory_document_id || row.memoryDocumentId || '',row.cloud_key || row.cloudKey || '']));
      for (const row of [...memorySyncMappings].sort((left, right) => Number((left.status || 'active') === 'active') - Number((right.status || 'active') === 'active'))) {
        upsertLocalMemorySyncMapping(this.db, this.store, localUser.id, row);
      }
      const preparedDocumentVersions = documentVersions.map((row) => ({
        ...row,
        memory_document_id: remoteCloudKeyByDocumentId.get(row.memory_document_id || row.memoryDocumentId)
          || row.memory_document_id || row.memoryDocumentId,
      }));
      const resolvableDocumentVersions = preparedDocumentVersions.filter((row) => {
        const documentId = canonicalLocalMemoryDocumentId(this.db, row.memory_document_id || row.memoryDocumentId || '');
        if (documentId) return true;
        deferredMemoryVersions.push(row);
        return false;
      });
      if (deferredMemoryVersions.length && !deferMissingMemoryVersions) {
        const error = new Error('Memory document version owner does not exist');
        error.code = 'memory_document_owner_missing';
        throw error;
      }
      const documentIds = [...new Set(resolvableDocumentVersions.map((row) => (
        canonicalLocalMemoryDocumentId(this.db, row.memory_document_id || row.memoryDocumentId || '')
      )).filter(Boolean))];
      for (const documentId of documentIds) {
        const existingVersions = all(this.db, 'SELECT id FROM memory_document_versions WHERE memory_document_id = ? ORDER BY version_no', [documentId]);
        const minimumVersion = Number(get(this.db, 'SELECT MIN(version_no) AS value FROM memory_document_versions WHERE memory_document_id=?', [documentId])?.value || 0);
        let temporary = Math.min(-1, minimumVersion - 1);
        for (const existing of existingVersions) { run(this.db, 'UPDATE memory_document_versions SET version_no = ? WHERE id = ?', [temporary, existing.id]); temporary -= 1; }
      }
      for (const row of resolvableDocumentVersions) upsertLocalMemoryVersion(this.db, row);
      for (const row of contextSpaces) upsertLocalAgentContextSpace(this.db, localUser.id, {
        ...row,memory_cloud_key: remoteCloudKeyByDocumentId.get(row.memory_document_id || row.memoryDocumentId) || '',
      });
      reconcileLocalGeneralMemoryContextPointers(this.db, localUser.id);
      for (const row of contextStates) upsertLocalAgentContextState(this.db, this.store, localUser.id, {
        ...row,
        active_memory_cloud_key: remoteCloudKeyByDocumentId.get(row.active_memory_document_id || row.activeMemoryDocumentId)
          || row.active_memory_cloud_key || row.activeMemoryCloudKey || row.active_memory_document_id || row.activeMemoryDocumentId || '',
      });
      for (const row of chatContextStates) upsertLocalChatContextState(this.db, localUser.id, row);
      for (const row of taskSecurityContexts) upsertLocalTaskSecurityContext(this.db, localUser.id, row);
      for (const row of documents) {
        const cloudKey = row.cloud_key || row.cloudKey || row.id || '';
        const documentId = get(this.db, 'SELECT id FROM memory_documents WHERE user_id=? AND cloud_key=?', [localUser.id, cloudKey])?.id || '';
        if (!documentId) continue;
        const remoteCurrentVersionId = row.current_version_id || row.currentVersionId || '';
        const remoteCurrent = remoteCurrentVersionId ? get(this.db, 'SELECT conflict_state,content_hash FROM memory_document_versions WHERE id=? AND memory_document_id=?', [remoteCurrentVersionId,documentId]) : null;
        if (remoteCurrent && remoteCurrent.conflict_state !== 'unresolved') run(this.db, 'UPDATE memory_documents SET current_version_id=?,content_hash=?,updated_at=? WHERE id=?', [
          remoteCurrentVersionId,remoteCurrent.content_hash || row.content_hash || row.contentHash || '',row.updated_at || row.updatedAt || nowIso(),documentId,
        ]);
      }
      this.db.exec('COMMIT');
      for (const row of instances) {
        const instanceId = canonicalLocalAgentInstanceId(this.db, row.id || '');
        const instance = instanceId ? this.store.getUserAgentInstance?.(instanceId) : null;
        if (instance?.agentFamilyId === 'secretary_agent') {
          this.store.notifyEffectiveSkillChanged?.({
            userId: localUser.id,
            agentInstanceId: instance.id,
            trigger: 'ubuddy_cloud_identity_skill_updated',
          });
        }
      }
      const result = {
        status: deferredMemoryVersions.length ? 'partial' : 'applied',
        instanceCount: instances.length,
        memoryDocumentCount: documents.length,
        memoryVersionCount: resolvableDocumentVersions.length,
        deferredMemoryVersions,
        contextStateCount: contextStates.length,
      };
      if (instances.length || instanceAliases.length) {
        try {
          this.onEmployeeIdentityUpdated?.({
            reason: 'cloud_identity_snapshot',
            status: result.status,
            instanceCount: instances.length,
            aliasCount: instanceAliases.length,
          });
        } catch {
          // Renderer refresh notifications must never fail the identity transaction.
        }
      }
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async decidePersonalEvolution({ proposalId = '', decisions = [] } = {}) {
    const state = this.state();
    if (!state.server_url || !state.token || !state.user_id) throw new Error('Cloud sync is required for this Proposal decision.');
    return this.client.decidePersonalEvolution(state, {
      userId: state.user_id, proposalId, decisions, actorDeviceId: state.device_id,
    });
  }

  async ensureEvolutionGrant(state = this.state()) {
    if (!this.evolutionAuthorityEnabled) throw new Error('Cloud device authority is disabled.');
    if (!state.server_url) {
      const error = new Error('Cloud evolution server is not configured.');
      error.code = 'cloud_not_configured';
      throw error;
    }
    if (state.evolution_grant) return state.evolution_grant;
    if (state.device_grant) {
      run(this.db, 'UPDATE cloud_sync_state SET evolution_grant=?,updated_at=? WHERE id=?', [state.device_grant, nowIso(), DEFAULT_STATE_ID]);
      return state.device_grant;
    }
    if (!state.user_id || !state.device_id) throw new Error('Cloud user and device identity are required for evolution.');
    const payload = { userId: state.user_id, deviceId: state.device_id,
      scopes: ['evolution:read', 'evolution:write', 'employees:read', 'employees:write'] };
    const authState = typeof this.authStateProvider === 'function' ? this.authStateProvider() : null;
    if ((!authState?.access_token || authState.remote_user_id !== state.user_id) && !state.token) {
      const error = new Error('Authenticated cloud identity is required to issue an employee Device Grant.');
      error.code = 'cloud_auth_required';
      error.status = 401;
      throw error;
    }
    const grant = authState?.access_token && authState.remote_user_id === state.user_id
      ? await this.withAuthenticatedCloudIdentity((fresh) => this.client.bootstrapEvolutionGrant(this.state(), payload, { accessToken: fresh.access_token }))
      : state.token
        ? await this.client.bootstrapLegacyEvolutionGrant(state, payload)
        : null;
    if (!grant?.token) throw new Error('Cloud did not issue an evolution device grant.');
    run(this.db, 'UPDATE cloud_sync_state SET evolution_grant = ?, updated_at = ? WHERE id = ?', [grant.token, nowIso(), DEFAULT_STATE_ID]);
    this.evolutionGrantValidated = true;
    return grant.token;
  }

  async ensureDeviceGrant(state = this.state()) {
    if (state.device_grant) return state.device_grant;
    if (!state.user_id || !state.device_id) throw new Error('Cloud user and device identity are required for Sync V6.');
    const recovery = this.store.taskMemoryKeyring?.recoveryIdentity?.() || {};
    const registration = await this.withAuthenticatedCloudIdentity((authState) => this.client.registerDevice(this.state(), {
      deviceId: state.device_id,
      displayName: `${os.hostname()} (${process.platform})`,
      hostname: os.hostname(), platform: process.platform, arch: process.arch,
      publicKey: recovery.publicKey || '',
      metadata: { recoveryAlgorithm: recovery.algorithm || '', app: 'janus-desktop' },
    }, { accessToken: authState.access_token }));
    if (registration?.status !== 'approved') {
      const error = new Error('This device is pending approval from an existing approved device.');
      error.code = 'device_approval_pending';
      throw error;
    }
    const scopes = ['sync:read', 'sync:write', 'sync:files', 'sync:keys', 'devices:approve',
      'evolution:read', 'evolution:write', 'employees:read', 'employees:write'];
    const proof = this.store.taskMemoryKeyring.signDeviceGrantProof({ userId: state.user_id, deviceId: state.device_id, scopes });
    const grant = await this.withAuthenticatedCloudIdentity((authState) => this.client.issueDeviceGrant(this.state(), state.device_id, {
      scopes, proof,
    }, { accessToken: authState.access_token }));
    if (!grant?.token) throw new Error('Cloud did not issue a Device Grant.');
    run(this.db, `UPDATE cloud_sync_state SET device_grant=?,evolution_grant=?,sync_schema_version=6,updated_at=? WHERE id=?`, [
      grant.token, grant.token, nowIso(), DEFAULT_STATE_ID,
    ]);
    this.deviceGrantValidated = true;
    this.evolutionGrantValidated = true;
    return grant.token;
  }

  async employeeOverview() {
    const state = this.state();
    if (!state.server_url || !state.user_id) {
      const error = new Error('Cloud sync is not configured for employee authority.');
      error.code = 'cloud_not_configured';
      throw error;
    }
    const result = await this.ensureEmployeeBootstrap(state);
    return this.applyEmployeeOverview(result);
  }

  async employeeCapabilities(state = this.state()) {
    if (!state.server_url || !state.user_id) {
      const error = new Error('Cloud sync is not configured for employee authority.');
      error.code = 'cloud_not_configured';
      throw error;
    }
    if (Number(this.employeeCapabilitiesCache?.contractVersion || 0) >= 2) return this.employeeCapabilitiesCache;
    const capability = await this.withDeviceGrantRequest((activeState) => this.client.employeeCapabilities(activeState));
    if (!capability?.enabled || Number(capability.contractVersion || 0) < 2
      || capability.lifecycleMutation !== 'command_only' || capability.profileSequenceAuthority !== 'server') {
      const error = new Error('Cloud employee authority contract is not supported by this server.');
      error.code = 'employee_cloud_contract_unsupported';
      throw error;
    }
    this.employeeCapabilitiesCache = capability;
    return capability;
  }

  async ensureEmployeeBootstrap(state = this.state()) {
    await this.employeeCapabilities(state);
    let overview = await this.withDeviceGrantRequest((activeState) => this.client.employeeOverview(activeState));
    if (!overview?.bootstrap?.required) return overview;
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id]);
    if (!localUser) {
      const error = new Error('Cloud employee bootstrap is not bound to a local user.');
      error.code = 'employee_bootstrap_unbound_user';
      throw error;
    }
    const instances = this.store.listEmployeeRoster({ userId: localUser.id, includeInactive: true })
      .filter((instance) => ['active', 'inactive'].includes(instance.employmentState) && !['pending', 'conflict'].includes(instance.authorityState || ''))
      .map((instance) => ({
      proposedInstanceId: instance.id,
      agentFamilyId: canonicalEmployeeAgentFamilyId(instance.agentFamilyId),
      employmentState: instance.employmentState,
      stateRevision: Math.max(1, Number(instance.stateRevision || 1)),
      recruitedAt: instance.recruitedAt || '',
      deactivatedAt: instance.deactivatedAt || '',
      lastStateChangedAt: instance.lastStateChangedAt || '',
      familyInstanceSeq: Number(instance.familyInstanceSeq || 1),
      displayName: instance.displayName || '',
      note: instance.note || '',
      createdAt: instance.createdAt || '',
      updatedAt: instance.updatedAt || '',
      }));
    overview = await this.withDeviceGrantRequest((activeState) => this.client.employeeBootstrap(activeState, {
      bootstrapId: `employee-cutover:${state.user_id}:v1`,
      instances,
    }));
    return overview;
  }

  applyEmployeeOverview(result = {}) {
    const state = this.state();
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id]);
    if (localUser) {
      for (const instance of [...(Array.isArray(result.systemRoster) ? result.systemRoster : []), ...(Array.isArray(result.roster) ? result.roster : [])]) {
        this.store.applyCloudEmployeeInstance({ userId: localUser.id, instance });
      }
      for (const alias of Array.isArray(result.aliases) ? result.aliases : []) {
        if (!alias?.aliasInstanceId || !alias?.canonicalInstanceId) continue;
        this.store.bindCanonicalAgentInstance({
          userId: localUser.id,
          aliasInstanceId: alias.aliasInstanceId,
          canonicalInstanceId: alias.canonicalInstanceId,
          reason: alias.reason || 'employee_cloud_overview',
        });
      }
      this.store.reconcileProvisionalEmployeeInstances?.({ userId: localUser.id });
      this.canonicalizePendingPptEmployeeCommands({ localUser, overview: result });
    }
    return result;
  }

  canonicalizePendingPptEmployeeCommands({ localUser = null, overview = {} } = {}) {
    if (!localUser?.id) return 0;
    const remotePpt = [...(Array.isArray(overview.systemRoster) ? overview.systemRoster : []), ...(Array.isArray(overview.roster) ? overview.roster : [])]
      .find((instance) => canonicalEmployeeAgentFamilyId(instance.agentFamilyId || instance.agent_family_id || '') === 'ppt');
    const localPpt = this.store.findUserAgentInstance({ userId: localUser.id, agentFamilyId: 'ppt' });
    const canonicalInstanceId = String(remotePpt?.id || localPpt?.id || '').trim();
    const remoteRevision = Number(remotePpt?.stateRevision ?? remotePpt?.state_revision ?? 0);
    let changed = 0;
    for (const command of this.store.listEmployeeCommandOutbox({
      userId: localUser.id,
      statuses: ['pending', 'sending', 'failed', 'blocked_auth', 'blocked_incompatible_cloud'],
      limit: 500,
    })) {
      if (!isLegacyPptAgentId(command.agentFamilyId || command.payload?.agentFamilyId || '')) continue;
      const payload = {
        ...(command.payload || {}),
        agentFamilyId: 'ppt',
        ...(canonicalInstanceId && command.action !== 'recruit' ? { agentInstanceId: canonicalInstanceId } : {}),
        ...(canonicalInstanceId ? { proposedInstanceId: canonicalInstanceId } : {}),
      };
      const dependsOnCommandId = command.dependsOnCommandId || payload.dependsOnCommandId || '';
      if (!dependsOnCommandId && Number.isInteger(remoteRevision) && remoteRevision > 0) payload.expectedStateRevision = remoteRevision;
      run(this.db, `UPDATE employee_command_outbox SET agent_family_id='ppt',
        local_agent_instance_id=CASE WHEN ?<>'' THEN ? ELSE local_agent_instance_id END,
        proposed_instance_id=CASE WHEN ?<>'' THEN ? ELSE proposed_instance_id END,
        expected_state_revision=?,payload_json=?,updated_at=? WHERE command_id=? AND user_id=?`, [
        canonicalInstanceId, canonicalInstanceId, canonicalInstanceId, canonicalInstanceId,
        Number(payload.expectedStateRevision || command.expectedStateRevision || 0), JSON.stringify(payload), nowIso(), command.commandId, localUser.id,
      ]);
      changed += 1;
    }
    return changed;
  }

  async submitEmployeeCommand(command = {}) {
    const state = this.state();
    const overview = await this.ensureEmployeeBootstrap(state);
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id]);
    if (!localUser) throw new Error('Cloud employee command is not bound to a local user.');
    const canonicalFamilyId = canonicalEmployeeAgentFamilyId(command.agentFamilyId || command.payload?.agentFamilyId || '');
    let submittedCommand = {
      ...command,
      agentFamilyId: canonicalFamilyId,
      payload: { ...(command.payload || {}), agentFamilyId: canonicalFamilyId },
    };
    if (command.expectedStateRevisionMode === 'cloud_after_dependency'
      || command.payload?.expectedStateRevisionMode === 'cloud_after_dependency') {
      const dependencyId = command.dependsOnCommandId || command.payload?.dependsOnCommandId || '';
      const dependency = dependencyId
        ? this.store.getEmployeeCommandOutbox?.({ userId: localUser.id, commandId: dependencyId })
        : null;
      if (dependency && !employeeCommandDependencySettled(dependency.status)) {
        const error = new Error('The preceding employee lifecycle command has not settled.');
        error.code = 'employee_command_dependency_pending';
        throw error;
      }
      const instances = [
        ...(Array.isArray(overview?.systemRoster) ? overview.systemRoster : []),
        ...(Array.isArray(overview?.roster) ? overview.roster : []),
      ];
      const localInstanceId = command.localAgentInstanceId || command.payload?.agentInstanceId || '';
      const remote = instances.find((instance) => instance.id === localInstanceId);
      const remoteRevision = Number(remote?.stateRevision ?? remote?.state_revision ?? 0);
      if (!Number.isInteger(remoteRevision) || remoteRevision < 1) {
        const error = new Error('Cloud employee state revision is unavailable for the dependent lifecycle command.');
        error.code = 'employee_state_revision_unavailable';
        throw error;
      }
      submittedCommand = this.store.updateEmployeeCommandExpectedRevision?.({
        userId: localUser.id,
        commandId: command.commandId,
        expectedStateRevision: remoteRevision,
      }) || {
        ...command,
        payload: { ...(command.payload || command), expectedStateRevision: remoteRevision },
      };
    }
    const result = await this.withDeviceGrantRequest((activeState) => this.client.employeeCommand(activeState, submittedCommand.payload || submittedCommand));
    return this.store.applyCloudEmployeeCommandResult({
      userId: localUser.id,
      result,
      commandId: submittedCommand.commandId || submittedCommand.command_id || submittedCommand.payload?.commandId || '',
    });
  }

  async drainEmployeeCommandOutbox({ limit = 50 } = {}) {
    const state = this.state();
    await this.ensureEmployeeBootstrap(state);
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id]);
    if (!localUser) return { status: 'skipped', reason: 'unbound_remote_user', processed: 0 };
    this.store.recoverStaleEmployeeCommandOutbox?.({
      staleBefore: new Date(Date.now() - employeeCommandSendingStaleMs(this.client)).toISOString(),
    });
    const commands = employeeCommandExecutionOrder(this.store.listEmployeeCommandOutbox({
      userId: localUser.id, statuses: ['pending', 'failed', 'blocked_auth', 'blocked_incompatible_cloud'], limit,
    }));
    const results = [];
    for (const command of commands) {
      run(this.db, `UPDATE employee_command_outbox SET status='sending',updated_at=? WHERE command_id=?`, [nowIso(), command.commandId]);
      try {
        results.push(await this.submitEmployeeCommand(command));
      } catch (error) {
        if (error?.code === 'employee_command_dependency_pending') {
          run(this.db, `UPDATE employee_command_outbox SET status='pending',updated_at=? WHERE command_id=?`, [nowIso(), command.commandId]);
          results.push({ status: 'deferred', commandId: command.commandId, code: error.code });
          continue;
        }
        const status = employeeCommandFailureStatus(error);
        this.store.markEmployeeCommandAttempt({ commandId: command.commandId, status, error: employeeCommandFailureMessage(error) });
        results.push({ status, commandId: command.commandId, code: error.code || '', error: error.message || String(error) });
        break;
      }
    }
    const remaining = this.store.listEmployeeCommandOutbox({
      userId: localUser.id,
      statuses: ['pending', 'sending', 'failed', 'blocked_auth', 'blocked_incompatible_cloud'],
      limit: 500,
    });
    return {
      status: remaining.length ? 'partial' : 'completed',
      authority: 'cloud',
      processed: results.length,
      remaining: remaining.length,
      results,
    };
  }

  async syncEmployeeAuthority() {
    if (this.employeeAuthoritySyncPromise) return this.employeeAuthoritySyncPromise;
    this.employeeAuthoritySyncPromise = this.performEmployeeAuthoritySync();
    try {
      return await this.employeeAuthoritySyncPromise;
    } finally {
      this.employeeAuthoritySyncPromise = null;
    }
  }

  async performEmployeeAuthoritySync() {
    const initialOverview = await this.employeeOverview();
    const state = this.state();
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id]);
    const adoption = localUser ? this.store.stageLocalOnlyEmployeeAdoptions?.({
      userId: localUser.id,
      remoteUserId: state.user_id,
      sourceDeviceId: state.device_id,
      overview: initialOverview,
      capability: this.employeeCapabilitiesCache || {},
    }) : { inspected: 0, staged: 0, skipped: 0, reason: 'unbound_remote_user', items: [] };
    const outbox = await this.drainEmployeeCommandOutbox();
    const overview = await this.employeeOverview();
    const result = { status: 'synchronized', authority: 'cloud', adoption, outbox, overview };
    try {
      this.onEmployeeIdentityUpdated?.({
        reason: 'cloud_employee_authority',
        status: result.status,
        processed: Number(outbox?.processed || 0),
        remaining: Number(outbox?.remaining || 0),
      });
    } catch {
      // Renderer refresh notifications must never fail the authoritative sync.
    }
    return result;
  }

  async evolutionCapabilities() {
    const state = this.state();
    if (!state.server_url || (!state.token && !state.device_grant && !this.authenticatedCloudIdentity(state))) return { authority: 'cloud', authorityLocked: true, enabled: true,
      personal: { authority: 'cloud', authorityLocked: true, enabled: true, mutationEnabled: false, executionAvailable: false,
        readiness: { database: false, model: false, encryption: false }, code: 'cloud_not_configured' } };
    return this.withEvolutionGrantRequest((activeState) => this.client.evolutionCapabilities(activeState));
  }

  async followerCapabilities(contract = {}) {
    return this.withDeviceGrantRequest((activeState) => this.client.followerCapabilities(activeState, contract));
  }

  async pushFollowerReports(payload = {}) {
    return this.withDeviceGrantRequest((activeState) => this.client.pushFollowerReports(activeState, payload));
  }

  async followerReportChanges(options = {}) {
    return this.withDeviceGrantRequest((activeState) => this.client.followerReportChanges(activeState, options));
  }

  async pushFollowerFollowups(payload = {}) {
    return this.withDeviceGrantRequest((activeState) => this.client.pushFollowerFollowups(activeState, payload));
  }

  async followerFollowupMessages(options = {}) {
    return this.withDeviceGrantRequest((activeState) => this.client.followerFollowupMessages(activeState, options));
  }

  async ensureFollowerServiceInstance(payload = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.ensureFollowerServiceInstance(activeState, payload));
  }

  async updateFollowerServiceInstance(payload = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.updateFollowerServiceInstance(activeState, payload));
  }

  async followerEvolutionStatus(options = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.followerEvolutionStatus(activeState, options));
  }

  async uploadFollowerEvidence(payload = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.uploadFollowerEvidence(activeState, payload));
  }

  async rollbackFollowerPersonalVersion(payload = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.rollbackFollowerPersonalVersion(activeState, payload));
  }

  async decideFollowerPersonalVersion(payload = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.decideFollowerPersonalVersion(activeState, payload));
  }

  async followerSystemBundle(options = {}) {
    return this.withEvolutionGrantRequest((activeState) => this.client.followerSystemBundle(activeState, options));
  }

  async refreshEvolutionCapabilities() {
    const capabilities = await this.evolutionCapabilities();
    this.store.settingSet('evolution:cloud_capabilities', JSON.stringify(capabilities || {}));
    this.prepareTaskMemoryCloudEnvelopesFromCapabilities(capabilities || {});
    return capabilities || {};
  }

  async evolutionGrants() {
    const state = this.state();
    if (state.device_grant || this.authenticatedCloudIdentity(state)) {
      try {
        return await this.withAuthenticatedCloudIdentity((authState) => this.client.deviceGrants(this.state(), { accessToken: authState.access_token }));
      } catch (error) {
        if (![401, 404].includes(Number(error?.status || 0))) throw error;
      }
    }
    return this.withAuthenticatedCloudIdentity((authState) => this.client.evolutionGrants(this.state(), { accessToken: authState.access_token }));
  }

  async approveDeviceGrant(deviceId = '') {
    const state = this.state();
    await this.ensureDeviceGrant(state);
    return this.client.approveDevice(this.state(), deviceId);
  }

  async revokeEvolutionGrant(deviceId = '') {
    const state = this.state();
    const authState = typeof this.authStateProvider === 'function' ? this.authStateProvider() : null;
    if (!state.device_grant && (!authState?.access_token || authState.remote_user_id !== state.user_id)) {
      throw new Error('Authenticated cloud identity is required to revoke an evolution grant.');
    }
    const result = state.device_grant
      ? await this.client.revokeDevice(state, deviceId)
      : await this.client.revokeEvolutionGrant(state, deviceId, { accessToken: authState.access_token });
    if (deviceId === state.device_id && result.status === 'revoked') {
      run(this.db, `UPDATE cloud_sync_state SET evolution_grant='',device_grant='',updated_at=? WHERE id=?`, [nowIso(), DEFAULT_STATE_ID]);
    }
    return result;
  }

  enqueueEvolutionEvidence() {
    const state = this.state();
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id || '']);
    if (!localUser) return { queued: 0, reason: 'unbound_remote_user' };
    const instances = all(this.db, `SELECT * FROM user_agent_instances
      WHERE user_id = ? AND status IN ('active','inactive') AND sync_enabled = 1`, [localUser.id]);
    const cutoverAt = this.store.settingGet('evolution:cloud_cutover_at', '') || nowIso();
    const byId = new Map(instances.map((row) => [row.id, row]));
    const secretaryInstance = instances.find((row) => row.agent_family_id === 'secretary_agent' && row.status === 'active')
      || instances.find((row) => row.agent_family_id === 'secretary_agent') || null;
    let queued = 0;
    const quarantineUnattributed = ({ sourceKind, sourceId, sourceVersionId = '', reason = 'agent_instance_not_attributable' } = {}) => {
      const id = `evquar_${crypto.createHash('sha256').update([
        state.user_id,sourceKind,sourceId,sourceVersionId,reason,
      ].join('\n')).digest('hex').slice(0,32)}`;
      run(this.db, `INSERT OR IGNORE INTO evolution_evidence_quarantine (
        id,outbox_id,local_user_id,user_agent_instance_id,source_kind,source_id,source_version_id,
        reason_code,reason_text,retryable,resolution_status,created_at,updated_at
      ) VALUES (?,'',?,'',?,?,?,?,?,0,'pending',?,?)`, [
        id,localUser.id,sourceKind,sourceId,sourceVersionId,reason,
        'Historical Evidence could not be attributed to a synchronized Agent instance.',nowIso(),nowIso(),
      ]);
    };
    const enqueue = (instance, input) => {
      if (!instance || !input.sourceKind || !input.sourceId) return;
      const content = String(input.content || '');
      const encryptedContent = input.encryptedContent && typeof input.encryptedContent === 'object' ? input.encryptedContent : null;
      if (!content.trim() && !encryptedContent?.ciphertext) return;
      const historicalInactive = instance.status === 'inactive' && instance.deactivated_at
        && Date.parse(input.occurredAt || '') <= Date.parse(instance.deactivated_at);
      const allowedEvolutionScopes = [...new Set([
        ...(historicalInactive ? [] : input.allowedEvolutionScopes || []),
        ...(!historicalInactive && ['message','conversation_segment','task_result','task_acceptance','task_revision','task_rework',
          'task_failure','task_blocked','task_cancelled','task_dependency_changed','model_execution','model_execution_metric',
          'collaboration_message','delegation_event','task_shared_summary','memory_version'].includes(input.sourceKind) ? ['cluster'] : []),
      ].filter((scope) => ['personal', 'cluster'].includes(scope)))];
      if (!historicalInactive && !allowedEvolutionScopes.length) return;
      const contentHash = String(input.contentHash || (content ? crypto.createHash('sha256').update(content).digest('hex') : ''));
      if (!contentHash) return;
      const evidenceId = stableEvolutionEvidenceId({
        ownerUserId: state.user_id, userAgentInstanceId: instance.id, sourceKind: input.sourceKind,
        sourceId: input.sourceId, sourceVersionId: input.sourceVersionId || '', contentHash,
      });
      const payload = {
        evidenceId, userAgentInstanceId: instance.id, agentFamilyId: instance.agent_family_id,
        sourceKind: input.sourceKind, sourceId: input.sourceId, sourceVersionId: input.sourceVersionId || '',
        contextSpaceId: input.contextSpaceId || '', taskId: input.taskId || '', delegationId: input.delegationId || '',
        content: encryptedContent ? '' : content, encryptedContent: encryptedContent || undefined,
        contentHash, confidence: input.confidence ?? 1, privacyLevel: input.privacyLevel || 'owner_private',
        lineageKey: input.lineageKey || input.metadata?.lineageKey || `${input.sourceKind}:${input.sourceId}:${input.sourceVersionId || ''}`,
        occurredAt: input.occurredAt || nowIso(), allowedEvolutionScopes,
        metadata: { ...(input.metadata || {}), historicalInactive,
          lineageKey: input.lineageKey || input.metadata?.lineageKey || `${input.sourceKind}:${input.sourceId}:${input.sourceVersionId || ''}`, allowedEvolutionScopes },
      };
      const result = run(this.db, `INSERT OR IGNORE INTO evolution_evidence_upload_queue (
        evidence_id, owner_user_id, user_agent_instance_id, agent_family_id, source_kind, source_id,
        source_version_id, content_hash, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [
        evidenceId, state.user_id, instance.id, instance.agent_family_id, input.sourceKind, input.sourceId,
        input.sourceVersionId || '', contentHash, JSON.stringify(payload), nowIso(), nowIso(),
      ]);
      queued += Number(result?.changes || 0);
    };
    const messageBackfill = ensureLegacyEvidenceBackfill(this.db,state.user_id,'message',cutoverAt,get(this.db,`SELECT m.created_at at,m.id
      FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.user_id=? AND m.created_at<=? ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const messageRows = messageBackfill.status==='completed'?[]:all(this.db, `SELECT m.*, s.agent_instance_id AS session_agent_instance_id
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE s.user_id = ? AND m.visible = 1 AND m.role IN ('user','assistant')
        AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
        AND (m.created_at < ? OR (m.created_at = ? AND m.id <= ?)) ORDER BY m.created_at,m.id LIMIT 500`,
    [localUser.id,messageBackfill.cursorAt,messageBackfill.cursorAt,messageBackfill.cursorId,
      messageBackfill.upperBoundAt,messageBackfill.upperBoundAt,messageBackfill.upperBoundId]);
    for (const row of messageRows) {
      if (get(this.db,"SELECT 1 FROM evolution_evidence_outbox WHERE source_kind='message' AND source_id=? LIMIT 1",[row.id])) continue;
      const instance = byId.get(row.agent_instance_id || row.session_agent_instance_id || '');
      enqueue(instance, { sourceKind: 'message', sourceId: row.id, content: row.content, contextSpaceId: `session:${row.session_id}`, occurredAt: row.created_at,
        allowedEvolutionScopes: [instance?.personal_evolution_consent ? 'personal' : '', 'cluster'],
        metadata: { role: row.role, sessionId: row.session_id } });
    }
    advanceLegacyEvidenceBackfill(this.db,messageBackfill,messageRows.at(-1)?.created_at,messageRows.at(-1)?.id,messageRows.length<500);

    const segmentBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'conversation_segment',cutoverAt,get(this.db,`SELECT m.created_at at,m.id
      FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.user_id=? AND m.role='assistant' AND m.visible=1 AND m.created_at<=?
      AND s.department_id<>'private_assistant' AND NOT EXISTS (SELECT 1 FROM messages previous
        WHERE previous.session_id=m.session_id AND previous.role='assistant' AND previous.visible=1
          AND previous.created_at<m.created_at AND previous.created_at>(SELECT COALESCE(MAX(user_message.created_at),'') FROM messages user_message
            WHERE user_message.session_id=m.session_id AND user_message.role='user' AND user_message.visible=1 AND user_message.created_at<m.created_at))
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const segmentRows=segmentBackfill.status==='completed'?[]:all(this.db,`SELECT m.*,s.agent_instance_id AS session_agent_instance_id,s.department_id AS session_department_id
      FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.user_id=? AND m.role='assistant' AND m.visible=1
      AND s.department_id<>'private_assistant' AND (m.created_at>? OR (m.created_at=? AND m.id>?))
      AND (m.created_at<? OR (m.created_at=? AND m.id<=?)) ORDER BY m.created_at,m.id LIMIT 500`,[
      localUser.id,segmentBackfill.cursorAt,segmentBackfill.cursorAt,segmentBackfill.cursorId,
      segmentBackfill.upperBoundAt,segmentBackfill.upperBoundAt,segmentBackfill.upperBoundId]);
    for(const row of segmentRows){
      const userMessage=get(this.db,`SELECT * FROM messages WHERE session_id=? AND role='user' AND visible=1
        AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 1`,[row.session_id,row.created_at,row.created_at,row.id]);
      if(!userMessage)continue;
      const earlierAssistant=get(this.db,`SELECT id FROM messages WHERE session_id=? AND role='assistant' AND visible=1
        AND ((created_at>? OR (created_at=? AND id>?)) AND (created_at<? OR (created_at=? AND id<?))) LIMIT 1`,[
        row.session_id,userMessage.created_at,userMessage.created_at,userMessage.id,row.created_at,row.created_at,row.id]);
      if(earlierAssistant)continue;
      const versionId=`segment_${crypto.createHash('sha256').update(`${userMessage.id}\n${row.id}`).digest('hex').slice(0,32)}`;
      if(get(this.db,"SELECT 1 FROM evolution_evidence_outbox WHERE source_kind='conversation_segment' AND source_id=? AND source_version_id=? LIMIT 1",[row.session_id,versionId]))continue;
      const instance=byId.get(row.agent_instance_id||row.session_agent_instance_id||'');
      const content=`User:\n${String(userMessage.content||'').trim()}\n\nAssistant:\n${String(row.content||'').trim()}`;
      enqueue(instance,{sourceKind:'conversation_segment',sourceId:row.session_id,sourceVersionId:versionId,content,
        contextSpaceId:row.context_space_id||userMessage.context_space_id||'',occurredAt:row.created_at,
        allowedEvolutionScopes:[instance?.personal_evolution_consent?'personal':'','cluster'],
        metadata:{sessionId:row.session_id,sourceMessageIds:[userMessage.id,row.id],lineageKey:`conversation:${row.session_id}:${userMessage.id}:${row.id}`}});
    }
    advanceLegacyEvidenceBackfill(this.db,segmentBackfill,segmentRows.at(-1)?.created_at,segmentRows.at(-1)?.id,segmentRows.length<500);

    const taskBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'task_result',cutoverAt,get(this.db,`SELECT n.updated_at at,n.id
      FROM task_nodes n JOIN task_runs r ON r.id=n.task_run_id WHERE r.owner_user_id=? AND n.updated_at<=?
      ORDER BY n.updated_at DESC,n.id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const taskRows = taskBackfill.status==='completed'?[]:all(this.db, `SELECT n.*,r.owner_user_id FROM task_nodes n
      JOIN task_runs r ON r.id=n.task_run_id
      WHERE r.owner_user_id=? AND n.agent_instance_id<>''
        AND n.status IN ('completed','accepted','failed','blocked','rework')
        AND (n.updated_at > ? OR (n.updated_at = ? AND n.id > ?))
        AND (n.updated_at < ? OR (n.updated_at = ? AND n.id <= ?))
      ORDER BY n.updated_at,n.id LIMIT 500`, [localUser.id,taskBackfill.cursorAt,taskBackfill.cursorAt,taskBackfill.cursorId,
      taskBackfill.upperBoundAt,taskBackfill.upperBoundAt,taskBackfill.upperBoundId]);
    for (const row of taskRows) {
      if (get(this.db,`SELECT 1 FROM evolution_evidence_outbox WHERE source_id=? AND source_kind IN
        ('task_result','task_acceptance','task_rework','task_failure','task_blocked','task_cancelled') LIMIT 1`,[row.id])) continue;
      const instance = byId.get(row.agent_instance_id || '');
      const content = [row.title, row.objective, row.result_summary, row.result_text, row.error_text].filter(Boolean).join('\n\n');
      enqueue(instance, { sourceKind: legacyTerminalTaskEvidenceSourceKind(row.status), sourceId: row.id, sourceVersionId: row.updated_at || '', content, taskId: row.task_run_id,
        occurredAt: row.completed_at || row.updated_at,
        allowedEvolutionScopes: [instance?.personal_evolution_consent ? 'personal' : '', 'cluster'],
        metadata: { status: row.status, taskRunId: row.task_run_id, departmentId: row.department_id || '' } });
    }
    advanceLegacyEvidenceBackfill(this.db,taskBackfill,taskRows.at(-1)?.updated_at,taskRows.at(-1)?.id,taskRows.length<500);

    const lifecycleBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'task_lifecycle',cutoverAt,get(this.db,`SELECT e.created_at at,e.id
      FROM task_events e JOIN task_runs r ON r.id=e.task_run_id WHERE r.owner_user_id=? AND e.created_at<=?
      AND (e.event_type IN ('task_created','task_assigned','task_dependency_changed') OR e.event_type LIKE 'graph_%')
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const lifecycleRows=lifecycleBackfill.status==='completed'?[]:all(this.db,`SELECT e.*,r.lead_agent_instance_id,n.agent_instance_id node_agent_instance_id
      FROM task_events e JOIN task_runs r ON r.id=e.task_run_id LEFT JOIN task_nodes n ON n.id=e.task_node_id
      WHERE r.owner_user_id=? AND (e.event_type IN ('task_created','task_assigned','task_dependency_changed') OR e.event_type LIKE 'graph_%')
      AND (e.created_at>? OR (e.created_at=? AND e.id>?)) AND (e.created_at<? OR (e.created_at=? AND e.id<=?))
      ORDER BY e.created_at,e.id LIMIT 500`,[localUser.id,lifecycleBackfill.cursorAt,lifecycleBackfill.cursorAt,lifecycleBackfill.cursorId,
      lifecycleBackfill.upperBoundAt,lifecycleBackfill.upperBoundAt,lifecycleBackfill.upperBoundId]);
    for(const row of lifecycleRows){
      const sourceKind=legacyTaskLifecycleEvidenceSourceKind(row.event_type);if(!sourceKind)continue;
      if(get(this.db,'SELECT 1 FROM evolution_evidence_outbox WHERE source_kind=? AND source_version_id=? LIMIT 1',[sourceKind,row.id]))continue;
      const instance=byId.get(row.node_agent_instance_id||row.lead_agent_instance_id||'');
      enqueue(instance,{sourceKind,sourceId:row.task_node_id||row.task_run_id,sourceVersionId:row.id,
        content:[row.summary,row.payload_json].filter(Boolean).join('\n\n'),taskId:row.task_run_id,occurredAt:row.created_at,
        allowedEvolutionScopes:[instance?.personal_evolution_consent?'personal':'','cluster'],metadata:{eventType:row.event_type}});
    }
    advanceLegacyEvidenceBackfill(this.db,lifecycleBackfill,lifecycleRows.at(-1)?.created_at,lifecycleRows.at(-1)?.id,lifecycleRows.length<500);

    const memoryBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'memory_version',cutoverAt,get(this.db,`SELECT mdv.created_at at,mdv.id
      FROM memory_document_versions mdv JOIN memory_documents md ON md.id=mdv.memory_document_id WHERE md.user_id=? AND mdv.created_at<=?
      ORDER BY mdv.created_at DESC,mdv.id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const memoryRows = memoryBackfill.status==='completed'?[]:all(this.db, `SELECT mdv.*,md.user_agent_instance_id,md.context_space_id,md.scope,md.task_run_id,
      md.allow_personal_evolution,md.allow_cluster_evolution
      FROM memory_document_versions mdv JOIN memory_documents md ON md.id = mdv.memory_document_id
      WHERE md.user_id = ? AND md.sync_enabled = 1
        AND (mdv.created_at > ? OR (mdv.created_at = ? AND mdv.id > ?))
        AND (mdv.created_at < ? OR (mdv.created_at = ? AND mdv.id <= ?)) ORDER BY mdv.created_at,mdv.id LIMIT 500`,
    [localUser.id,memoryBackfill.cursorAt,memoryBackfill.cursorAt,memoryBackfill.cursorId,
      memoryBackfill.upperBoundAt,memoryBackfill.upperBoundAt,memoryBackfill.upperBoundId]);
    for (const row of memoryRows) {
      if (get(this.db,`SELECT 1 FROM evolution_evidence_outbox o WHERE o.source_kind='memory_version' AND o.source_version_id=?
        AND (o.source_id=? OR EXISTS (SELECT 1 FROM memory_document_aliases a WHERE a.alias_document_id=o.source_id AND a.canonical_document_id=?)) LIMIT 1`,
      [row.id,row.memory_document_id,row.memory_document_id])) continue;
      const instance = byId.get(row.user_agent_instance_id);
      const encryptedContent = row.encryption_algorithm ? {
        algorithm: row.encryption_algorithm,
        keyId: row.encryption_key_id,
        keyVersion: Number(row.encryption_key_version || 0),
        ciphertext: row.content_ciphertext,
        nonce: row.content_nonce,
        tag: row.content_tag,
        aad: row.content_aad,
      } : null;
      enqueue(instance, { sourceKind: 'memory_version', sourceId: row.memory_document_id, sourceVersionId: row.id,
        content: encryptedContent ? '' : row.content, encryptedContent, contentHash: row.content_hash,
        contextSpaceId: row.context_space_id || '', taskId: row.task_run_id || '', occurredAt: row.created_at,
        allowedEvolutionScopes: [row.allow_personal_evolution && instance?.personal_evolution_consent ? 'personal' : '', 'cluster'],
        metadata: { scope: row.scope, versionNo: row.version_no } });
    }
    advanceLegacyEvidenceBackfill(this.db,memoryBackfill,memoryRows.at(-1)?.created_at,memoryRows.at(-1)?.id,memoryRows.length<500);

    const modelBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'model_execution',cutoverAt,get(this.db,`SELECT updated_at at,id
      FROM model_executions WHERE user_id=? AND status IN ('completed','failed','cancelled') AND updated_at<=?
      ORDER BY updated_at DESC,id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const modelRows=modelBackfill.status==='completed'?[]:all(this.db,`SELECT * FROM model_executions WHERE user_id=?
      AND status IN ('completed','failed','cancelled') AND (updated_at>? OR (updated_at=? AND id>?))
      AND (updated_at<? OR (updated_at=? AND id<=?)) ORDER BY updated_at,id LIMIT 500`,[
      localUser.id,modelBackfill.cursorAt,modelBackfill.cursorAt,modelBackfill.cursorId,
      modelBackfill.upperBoundAt,modelBackfill.upperBoundAt,modelBackfill.upperBoundId]);
    for(const row of modelRows){
      if(get(this.db,"SELECT 1 FROM evolution_evidence_outbox WHERE source_kind='model_execution' AND source_id=? LIMIT 1",[row.id]))continue;
      const instance=byId.get(row.agent_instance_id||'');
      const snapshot={status:row.status,executionKind:row.execution_kind,providerId:row.provider_id,requestedModel:row.requested_model,
        effectiveModel:row.effective_model,reasoningEffort:row.reasoning_effort,conversationId:row.conversation_id,
        taskRunId:row.task_run_id,taskNodeId:row.task_node_id,errorText:row.error_text||'',occurredAt:row.completed_at||row.updated_at};
      enqueue(instance,{sourceKind:'model_execution',sourceId:row.id,sourceVersionId:row.completed_at||row.updated_at,
        content:JSON.stringify(snapshot),taskId:row.task_run_id,occurredAt:snapshot.occurredAt,
        allowedEvolutionScopes:[instance?.personal_evolution_consent?'personal':'','cluster'],metadata:snapshot});
      const executionMetadata=safeJsonParse(row.metadata_json,{});
      const startedAt=Date.parse(row.started_at||'');const completedAt=Date.parse(row.completed_at||row.updated_at||'');
      const metricSnapshot={status:row.status,executionKind:row.execution_kind,providerId:row.provider_id,
        effectiveModel:row.effective_model,reasoningEffort:row.reasoning_effort,
        durationMs:Number.isFinite(startedAt)&&Number.isFinite(completedAt)?Math.max(0,completedAt-startedAt):0,
        usage:executionMetadata.usage||executionMetadata.tokenUsage||executionMetadata.token_usage||{},
        taskRunId:row.task_run_id,taskNodeId:row.task_node_id,occurredAt:snapshot.occurredAt};
      enqueue(instance,{sourceKind:'model_execution_metric',sourceId:row.id,sourceVersionId:row.completed_at||row.updated_at,
        content:JSON.stringify(metricSnapshot),taskId:row.task_run_id,occurredAt:snapshot.occurredAt,
        allowedEvolutionScopes:[instance?.personal_evolution_consent?'personal':'','cluster'],metadata:metricSnapshot});
    }
    advanceLegacyEvidenceBackfill(this.db,modelBackfill,modelRows.at(-1)?.updated_at,modelRows.at(-1)?.id,modelRows.length<500);

    const collaborationBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'collaboration_message',cutoverAt,get(this.db,`SELECT created_at at,id
      FROM collaboration_group_messages WHERE sender_user_id=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const collaborationRows=collaborationBackfill.status==='completed'?[]:all(this.db,`SELECT * FROM collaboration_group_messages
      WHERE sender_user_id=? AND (created_at>? OR (created_at=? AND id>?)) AND (created_at<? OR (created_at=? AND id<=?))
      ORDER BY created_at,id LIMIT 500`,[localUser.id,collaborationBackfill.cursorAt,collaborationBackfill.cursorAt,
      collaborationBackfill.cursorId,collaborationBackfill.upperBoundAt,collaborationBackfill.upperBoundAt,collaborationBackfill.upperBoundId]);
    for(const row of collaborationRows){
      if(get(this.db,"SELECT 1 FROM evolution_evidence_outbox WHERE source_kind='collaboration_message' AND source_id=? LIMIT 1",[row.id]))continue;
      if(!secretaryInstance){quarantineUnattributed({sourceKind:'collaboration_message',sourceId:row.id,sourceVersionId:row.source_event_id||''});continue;}
      const metadata=safeJsonParse(row.metadata_json,{});
      enqueue(secretaryInstance,{sourceKind:'collaboration_message',sourceId:row.id,sourceVersionId:row.source_event_id||'',
        content:row.content,delegationId:String(metadata.delegationId||metadata.delegation_id||''),occurredAt:row.created_at,
        allowedEvolutionScopes:[secretaryInstance.personal_evolution_consent?'personal':'','cluster'],
        metadata:{groupId:row.group_id,kind:row.kind,senderAgentId:row.sender_agent_id||'',sourceEventId:row.source_event_id||''}});
    }
    advanceLegacyEvidenceBackfill(this.db,collaborationBackfill,collaborationRows.at(-1)?.created_at,collaborationRows.at(-1)?.id,collaborationRows.length<500);

    const delegationBackfill=ensureLegacyEvidenceBackfill(this.db,state.user_id,'delegation_event',cutoverAt,get(this.db,`SELECT created_at at,id
      FROM agent_delegation_revisions WHERE author_user_id=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1`,[localUser.id,cutoverAt]));
    const delegationRows=delegationBackfill.status==='completed'?[]:all(this.db,`SELECT r.*,d.status,d.group_id FROM agent_delegation_revisions r
      LEFT JOIN agent_delegations d ON d.id=r.delegation_id WHERE r.author_user_id=?
      AND (r.created_at>? OR (r.created_at=? AND r.id>?)) AND (r.created_at<? OR (r.created_at=? AND r.id<=?))
      ORDER BY r.created_at,r.id LIMIT 500`,[localUser.id,delegationBackfill.cursorAt,delegationBackfill.cursorAt,
      delegationBackfill.cursorId,delegationBackfill.upperBoundAt,delegationBackfill.upperBoundAt,delegationBackfill.upperBoundId]);
    for(const row of delegationRows){
      if(get(this.db,"SELECT 1 FROM evolution_evidence_outbox WHERE source_kind='delegation_event' AND source_id=? AND source_version_id=? LIMIT 1",[row.delegation_id,row.id]))continue;
      if(!secretaryInstance){quarantineUnattributed({sourceKind:'delegation_event',sourceId:row.delegation_id,sourceVersionId:row.id});continue;}
      const content=String(row.content||'').trim()||JSON.stringify({action:row.action,status:row.status||'',revisionNo:Number(row.revision_no||0)});
      enqueue(secretaryInstance,{sourceKind:'delegation_event',sourceId:row.delegation_id,sourceVersionId:row.id,content,
        delegationId:row.delegation_id,occurredAt:row.created_at,
        allowedEvolutionScopes:[secretaryInstance.personal_evolution_consent?'personal':'','cluster'],
        metadata:{action:row.action,status:row.status||'',revisionNo:Number(row.revision_no||0),groupId:row.group_id||''}});
    }
    advanceLegacyEvidenceBackfill(this.db,delegationBackfill,delegationRows.at(-1)?.created_at,delegationRows.at(-1)?.id,delegationRows.length<500);

    const backfills=[messageBackfill,segmentBackfill,taskBackfill,lifecycleBackfill,memoryBackfill,modelBackfill,collaborationBackfill,delegationBackfill];
    const batches=[messageRows,segmentRows,taskRows,lifecycleRows,memoryRows,modelRows,collaborationRows,delegationRows];
    return { queued,legacyBackfillComplete:backfills.every((item)=>item.status==='completed')||batches.every((rows)=>rows.length<500) };
  }

  async drainEvolutionEvidenceOutbox({ limit = 100 } = {}) {
    const state = this.state();
    await this.ensureEvolutionGrant(state);
    const localUser = get(this.db, 'SELECT id FROM auth_users WHERE remote_id=?', [state.user_id || '']);
    if (!localUser?.id) {
      return { status: 'deferred', reason: 'unbound_remote_user', uploaded: 0,
        upload: this.evolutionEvidenceUploadStatus(state), counts: this.store.evolutionEvidenceOutboxCounts?.() || {} };
    }
    const rows = this.store.claimEvolutionEvidenceOutbox?.({
      localUserId: localUser.id,
      limit: Math.min(500, Math.max(1, Number(limit || 100))),
      workerId: `cloud_sync_${state.device_id || process.pid}`,
    }) || [];
    if (!rows.length) return { status: 'empty', uploaded: 0, counts: this.store.evolutionEvidenceOutboxCounts?.() || {} };
    const uploadRows = [];
    let deferred = 0;
    let quarantined = 0;
    for (const row of rows) {
      const materialized = this.materializeEvolutionEvidenceOutbox(row, state);
      if (materialized.status === 'deferred') {
        this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
          status: 'deferred', error: materialized.reason, deferReason: materialized.reason,
          nextAttemptAt: evolutionEvidenceRetryAt(row, { status: 'deferred', reason: materialized.reason }),
        });
        deferred += 1;
        continue;
      }
      if (materialized.status === 'quarantined') {
        this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
          status: 'quarantined', error: materialized.reason, uploadedAt: nowIso(),
        });
        quarantined += 1;
        continue;
      }
      uploadRows.push({ row, payload: materialized.payload });
    }
    if (!uploadRows.length) {
      return { status: deferred ? 'deferred' : 'quarantined', uploaded: 0, deferred, quarantined,
        counts: this.store.evolutionEvidenceOutboxCounts?.() || {} };
    }
    try {
      const result = await this.client.uploadEvolutionEvidence(this.state(), uploadRows.map((item) => item.payload));
      const itemResults = new Map((result.results || []).map((item) => [String(item.clientRecordId || ''), item]).filter(([key]) => key));
      const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
      const cloudQuarantined = new Map((result.quarantined || []).map((item) => [item.evidenceId, item.reason || 'quarantined']));
      const rejectedBySource = new Map((result.rejected || []).map((item) => [item.sourceId || '', item]));
      let uploaded = 0;
      let rejected = 0;
      let failedRetryable = 0;
      for (const { row, payload } of uploadRows) {
        const remoteEvidenceId = payload.evidenceId;
        const itemResult = itemResults.get(row.outboxId);
        if (itemResult) {
          const resolvedEvidenceId = itemResult.evidenceId || remoteEvidenceId;
          if (['accepted', 'duplicate'].includes(itemResult.status)) {
            this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
              status: 'uploaded', remoteEvidenceId: resolvedEvidenceId, uploadedAt: nowIso(),
            });
            uploaded += 1;
            continue;
          }
          if (itemResult.status === 'deferred') {
            this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
              status: 'deferred', remoteEvidenceId: resolvedEvidenceId,
              error: itemResult.message || itemResult.code || 'Evidence source is not ready.',
              deferReason: itemResult.code || 'cloud_source_not_ready',
              nextAttemptAt: evolutionEvidenceRetryAt(row, { status: 'deferred', reason: itemResult.code || 'cloud_source_not_ready' }),
            });
            deferred += 1;
            continue;
          }
          if (itemResult.status === 'quarantined') {
            this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
              status: 'quarantined', remoteEvidenceId: resolvedEvidenceId,
              error: itemResult.message || itemResult.code || 'Evidence was quarantined.', uploadedAt: nowIso(),
            });
            quarantined += 1;
            continue;
          }
          if (itemResult.status === 'rejected') {
            this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
              status: itemResult.retryable ? 'failed_retryable' : 'rejected', remoteEvidenceId: resolvedEvidenceId,
              error: itemResult.message || itemResult.code || 'Cloud rejected evidence.',
              deferReason: itemResult.retryable ? (itemResult.code || 'cloud_retryable_rejection') : '',
              nextAttemptAt: itemResult.retryable
                ? evolutionEvidenceRetryAt(row, { status: 'failed_retryable', reason: itemResult.code || 'cloud_retryable_rejection' }) : '',
              uploadedAt: itemResult.retryable ? '' : nowIso(),
            });
            if (itemResult.retryable) failedRetryable += 1;
            else rejected += 1;
            continue;
          }
        }
        if (accepted.has(remoteEvidenceId)) {
          this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
            status: 'uploaded', remoteEvidenceId, uploadedAt: nowIso(),
          });
          uploaded += 1;
          continue;
        }
        const quarantineReason = cloudQuarantined.get(remoteEvidenceId);
        if (quarantineReason) {
          this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
            status: 'quarantined', remoteEvidenceId, error: quarantineReason, uploadedAt: nowIso(),
          });
          quarantined += 1;
          continue;
        }
        const rejection = rejectedBySource.get(payload.sourceId);
        if (rejection) {
          this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
            status: 'rejected', remoteEvidenceId, error: rejection.message || rejection.code || 'Cloud rejected evidence.', uploadedAt: nowIso(),
          });
          rejected += 1;
          continue;
        }
        this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
          status: 'failed_retryable', remoteEvidenceId, error: 'Cloud did not return an Evidence result.',
          deferReason: 'cloud_result_missing',
          nextAttemptAt: evolutionEvidenceRetryAt(row, { status: 'failed_retryable', reason: 'cloud_result_missing' }),
        });
        failedRetryable += 1;
      }
      return {
        status: result.status || (failedRetryable ? 'partial' : 'accepted'), uploaded, deferred, quarantined, rejected, failedRetryable,
        counts: this.store.evolutionEvidenceOutboxCounts?.() || {},
      };
    } catch (error) {
      for (const { row, payload } of uploadRows) {
        this.store.completeEvolutionEvidenceOutbox(row.outboxId, {
          status: 'failed_retryable', remoteEvidenceId: payload.evidenceId,
          error: clipText(error.message || String(error), 1000),
          deferReason: 'cloud_upload_failed',
          nextAttemptAt: evolutionEvidenceRetryAt(row, { status: 'failed_retryable', reason: 'cloud_upload_failed' }),
        });
      }
      throw error;
    }
  }

  materializeEvolutionEvidenceOutbox(row, state = this.state()) {
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE id=?', [row.localUserId]);
    if (!localUser || !localUser.remote_id || localUser.remote_id !== state.user_id) {
      return { status: 'deferred', reason: 'unbound_remote_user' };
    }
    const alias = get(this.db, 'SELECT canonical_instance_id FROM user_agent_instance_aliases WHERE alias_instance_id=?', [row.userAgentInstanceId]);
    const agentInstanceId = alias?.canonical_instance_id || row.userAgentInstanceId;
    const instance = get(this.db, 'SELECT * FROM user_agent_instances WHERE id=? AND user_id=?', [agentInstanceId, localUser.id]);
    if (!instance) return { status: 'quarantined', reason: 'agent_instance_not_found' };
    const historicalInactive = instance.status === 'inactive' && instance.deactivated_at
      && Date.parse(row.createdAt || '') <= Date.parse(instance.deactivated_at);
    if ((!historicalInactive && instance.status !== 'active') || !Number(instance.sync_enabled)) return { status: 'deferred', reason: 'agent_instance_not_syncable' };
    if (instance.agent_family_id !== row.agentFamilyId) return { status: 'quarantined', reason: 'agent_family_mismatch' };
    const snapshot = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {};
    const capability=safeJsonParse(this.store.settingGet('evolution:cloud_capabilities',''),{})?.evidenceEnvelope||{};
    let content = String(snapshot.content || '');
    let encryptedContent;
    let sourceId = row.sourceId;
    if (row.sourceKind === 'memory_version') {
      const documentAlias = get(this.db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id=?', [row.sourceId]);
      sourceId = documentAlias?.canonical_document_id || row.sourceId;
      const document = get(this.db, 'SELECT * FROM memory_documents WHERE id=?', [sourceId]);
      if (document && !Number(document.sync_enabled)) return { status: 'deferred', reason: 'memory_sync_disabled' };
      const version = get(this.db, 'SELECT * FROM memory_document_versions WHERE id=? AND memory_document_id=?', [row.sourceVersionId, sourceId]);
      if (version?.encryption_algorithm) {
        if(capability.available&&capability.activeKeyId&&capability.publicKey){
          try{content=String(this.store.decryptMemoryVersionContent?.(version)||'');}
          catch{return {status:'deferred',reason:'task_memory_local_key_unavailable'};}
        }else{
          encryptedContent = {
            algorithm: version.encryption_algorithm,
            keyId: version.encryption_key_id,
            keyVersion: Number(version.encryption_key_version || 0),
            ciphertext: version.content_ciphertext,
            nonce: version.content_nonce,
            tag: version.content_tag,
            aad: version.content_aad,
          };
          content = '';
        }
      } else if (!content && version) {
        content = String(version.content || '');
      } else if (snapshot.encryptedSource && !version) {
        return { status: 'quarantined', reason: 'encrypted_memory_source_missing' };
      }
    }
    if (!content.trim() && !encryptedContent?.ciphertext) return { status: 'quarantined', reason: 'evidence_content_missing' };
    let evolutionEnvelope;
    if(content.trim()&&capability.available&&capability.activeKeyId&&capability.publicKey){
      evolutionEnvelope=encryptEvolutionEnvelope(content,{activeKeyId:capability.activeKeyId,keys:{[capability.activeKeyId]:capability.publicKey}});
      content='';
    }
    const personalAllowed = !historicalInactive && Boolean(instance.personal_evolution_consent)
      && (!['memory_version','task_shared_summary'].includes(row.sourceKind) || Boolean(snapshot.allowPersonalEvolution));
    const allowedEvolutionScopes = [...new Set([personalAllowed ? 'personal' : '', historicalInactive ? '' : 'cluster'].filter(Boolean))];
    const evidenceId = stableEvolutionEvidenceId({
      ownerUserId: state.user_id,
      userAgentInstanceId: instance.id,
      sourceKind: row.sourceKind,
      sourceId,
      sourceVersionId: row.sourceVersionId,
      contentHash: row.contentHash,
    });
    return {
      status: 'ready',
      payload: {
        clientRecordId: row.outboxId,
        evidenceId,
        userAgentInstanceId: instance.id,
        agentFamilyId: instance.agent_family_id,
        sourceKind: row.sourceKind,
        sourceId,
        sourceVersionId: row.sourceVersionId || '',
        lineageKey: row.lineageKey || snapshot.lineageKey || `${row.sourceKind}:${sourceId}:${row.sourceVersionId || ''}`,
        contextSpaceId: row.contextSpaceId || snapshot.contextSpaceId || '',
        taskId: row.taskRunId || snapshot.taskRunId || '',
        delegationId: row.delegationId || '',
        content: encryptedContent || evolutionEnvelope ? '' : content,
        encryptedContent,
        evolutionEnvelope,
        contentHash: row.contentHash,
        confidence: row.confidence,
        privacyLevel: row.privacyLevel || 'owner_private',
        occurredAt: snapshot.occurredAt || row.createdAt || nowIso(),
        allowedEvolutionScopes,
        metadata: { ...snapshot, content: undefined, encryptedSource: undefined,
          lineageKey: row.lineageKey || snapshot.lineageKey || `${row.sourceKind}:${sourceId}:${row.sourceVersionId || ''}`,
          historicalInactive,allowedEvolutionScopes, outboxId: row.outboxId },
      },
    };
  }

  evolutionEvidenceUploadStatus(state = this.state()) {
    const localUserId = get(this.db, 'SELECT id FROM auth_users WHERE remote_id=?', [state.user_id || ''])?.id || '';
    return this.store.evolutionEvidenceOutboxStatus?.({ localUserId }) || {
      currentAccount: {}, otherAccountsPending: 0, permanentlyBlocked: 0, nextRetryAt: '', deferredReasons: {},
    };
  }

  async drainEvolutionEvidence({ limit = 100 } = {}) {
    const state = this.state();
    await this.ensureEvolutionGrant(state);
    const rows = all(this.db, `SELECT * FROM evolution_evidence_upload_queue WHERE status IN ('pending','failed')
      ORDER BY created_at LIMIT ?`, [Math.min(500, Math.max(1, Number(limit || 100)))]);
    if (!rows.length) return { status: 'empty', uploaded: 0 };
    const items = rows.map((row) => safeJsonParse(row.payload_json, {}));
    try {
      const result = await this.client.uploadEvolutionEvidence(this.state(), items);
      const accepted = new Set([...(result.accepted || []), ...(result.duplicates || [])]);
      const quarantined = new Map((result.quarantined || []).map((item) => [item.evidenceId, item.reason || 'quarantined']));
      const rejected = new Map((result.rejected || []).map((item) => [item.sourceId || '', item]));
      for (const row of rows) {
        const ok = accepted.has(row.evidence_id);
        const quarantineReason = quarantined.get(row.evidence_id) || '';
        const rejection = rejected.get(row.source_id);
        run(this.db, `UPDATE evolution_evidence_upload_queue SET status = ?, attempt_count = attempt_count + 1,
          last_error = ?, uploaded_at = ?, updated_at = ? WHERE evidence_id = ?`, [
          ok ? 'uploaded' : quarantineReason ? 'quarantined' : rejection ? 'rejected' : 'failed',
          ok ? '' : quarantineReason || rejection?.message || 'Cloud rejected evidence.',
          ok || quarantineReason || rejection ? nowIso() : '', nowIso(), row.evidence_id,
        ]);
      }
      return { status: result.status, uploaded: accepted.size, quarantined: result.quarantined || [], rejected: result.rejected || [] };
    } catch (error) {
      for (const row of rows) run(this.db, "UPDATE evolution_evidence_upload_queue SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE evidence_id = ?", [clipText(error.message || String(error), 1000), nowIso(), row.evidence_id]);
      throw error;
    }
  }

  async syncEvolutionAuthority(state = this.state()) {
    const preference = await this.evolutionPreference();
    if (preference.available === false) {
      const progression = await this.refreshEmployeeProgressionProjections(state);
      return { status: 'deferred', authority: 'cloud', reason: 'evolution_route_unavailable', preference, progression,
        outbox: this.store.evolutionEvidenceOutboxCounts?.() || {} };
    }
    const capabilities = await this.refreshEvolutionCapabilities();
    const outbox = await this.drainEvolutionEvidenceOutbox();
    const queued = this.enqueueEvolutionEvidence();
    const evidence = await this.drainEvolutionEvidence();
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [state.user_id || '']);
    let projectedVersionCount = 0;
    const evidenceCounts = {};
    let personalSchedules = { authority: 'cloud', items: [] };
    let progression = { status: 'skipped', reason: 'unbound_remote_user' };
    if (localUser) {
      const instances = all(this.db, 'SELECT * FROM user_agent_instances WHERE user_id = ? AND sync_enabled = 1', [localUser.id]);
      progression = await this.refreshEmployeeProgressionProjections(state, { capabilities, instances, localUser });
      personalSchedules = await this.client.personalEvolutionSchedule(this.state());
      if (capabilities.performance?.enabled) await this.client.uploadPerformanceEvents(this.state(), this.buildPerformanceEvents(localUser.id, instances));
      if (capabilities.leadership?.enabled) {
        const leadershipEvaluations = this.buildLeadershipEvaluations(localUser.id, instances);
        await this.client.uploadLeadershipEvents(this.state(), leadershipEvaluations.map((evaluation) => ({
          id: `levent_${crypto.createHash('sha256').update(`${evaluation.agentInstanceId}:${evaluation.taskId}:${evaluation.completedAt}`).digest('hex').slice(0, 32)}`,
          agentInstanceId: evaluation.agentInstanceId,
          taskId: evaluation.taskId,
          assignmentId: evaluation.assignmentId,
          eventKind: 'leadership_task_terminal',
          occurredAt: evaluation.completedAt,
          role: evaluation.role,
          assignmentMode: evaluation.assignmentMode,
          participantCount: evaluation.participantCount,
          departmentCount: evaluation.departmentCount,
          evidenceRefs: evaluation.evidenceRefs,
        })));
        for (const evaluation of leadershipEvaluations) {
          try {
            await this.client.evaluateLeadershipTask(this.state(), evaluation);
          } catch (error) {
            if (['leadership_task_not_synchronized', 'leadership_task_nodes_missing'].includes(String(error?.code || ''))) continue;
            throw error;
          }
        }
      }
      for (const instance of instances) {
        evidenceCounts[instance.id] = await this.client.evolutionEvidenceCounts(this.state(), { agentInstanceId: instance.id });
        const response = await this.client.personalEvolutionVersions(this.state(), { agentInstanceId: instance.id });
        projectedVersionCount += this.applyCloudPersonalVersions(localUser.id, instance.id, response.items || []);
        if (capabilities.market?.enabled) {
          const versions = await this.client.marketVersions(this.state(), { familyId: instance.agent_family_id, agentInstanceId: instance.id });
          const effective = await this.client.effectiveMarketSkill(this.state(), instance.id);
          const canary = await this.client.marketCanaryStatus(this.state(), { agentInstanceId: instance.id });
          this.saveStage8Projection(`market_versions:${instance.agent_family_id}`, 'market_versions', versions.items || []);
          this.saveStage8Projection(`effective_skill:${instance.id}`, 'effective_skill', effective.item || null, instance.id);
          this.saveStage8Projection(`market_canary:${instance.id}`, 'market_canary', canary || null, instance.id);
        }
      }
      if (capabilities.leadership?.enabled) {
        const governanceActions = await this.client.leadershipActions(this.state(), { status: 'pending', limit: 100 });
        const governanceAppeals = await this.client.leadershipAppeals(this.state(), { status: 'pending', limit: 100 });
        this.saveStage8Projection('leadership:governance_actions', 'leadership_governance_actions', governanceActions.items || []);
        this.saveStage8Projection('leadership:governance_appeals', 'leadership_governance_appeals', governanceAppeals.items || []);
      }
      if (capabilities.cluster?.enabled) {
        const cohorts = await this.client.clusterCohorts(this.state());
        const runs = await this.client.clusterRuns(this.state());
        const candidates = await this.client.marketCandidates(this.state());
        this.saveStage8Projection('cluster:cohorts', 'cluster_cohorts', cohorts.items || []);
        this.saveStage8Projection('cluster:runs', 'cluster_runs', runs.items || []);
        this.saveStage8Projection('market:candidates', 'market_candidates', candidates.items || []);
      }
    }
    this.store.settingSet('evolution:cloud_evidence_counts', JSON.stringify(evidenceCounts));
    this.store.settingSet('evolution:cloud_personal_schedules', JSON.stringify(personalSchedules));
    return { status: 'synchronized', authority: 'cloud', preference, outbox, queued, evidence, capabilities, progression, evidenceCounts, personalSchedules, projectedVersionCount };
  }

  async refreshEmployeeProgressionProjections(state = this.state(), { capabilities = null, instances = null, localUser = null } = {}) {
    const activeUser = localUser || get(this.db, 'SELECT * FROM auth_users WHERE remote_id=?', [state.user_id || '']);
    if (!activeUser) return { status: 'skipped', reason: 'unbound_remote_user', refreshedAt: '' };
    let activeCapabilities = capabilities;
    try {
      activeCapabilities ||= await this.refreshEvolutionCapabilities();
    } catch (error) {
      const failed = {
        status: 'failed',
        refreshedAt: '',
        lastError: employeeCommandFailureMessage(error),
        performanceCount: 0,
        leadershipCount: 0,
      };
      this.store.settingSet('evolution:employee_progression_sync', JSON.stringify(failed));
      return failed;
    }
    const rawSubjects = Array.isArray(instances) ? instances : all(this.db, `SELECT * FROM user_agent_instances
      WHERE user_id=? AND sync_enabled=1`, [activeUser.id]);
    const subjectsById = new Map();
    for (const subject of rawSubjects) {
      const canonicalId = canonicalLocalAgentInstanceId(this.db, subject.id || '');
      const canonical = canonicalId
        ? get(this.db, 'SELECT * FROM user_agent_instances WHERE id=? AND user_id=?', [canonicalId, activeUser.id])
        : null;
      const resolved = canonical || subject;
      if (resolved?.id && !subjectsById.has(resolved.id)) subjectsById.set(resolved.id, resolved);
    }
    const subjects = [...subjectsById.values()];
    const errors = [];
    const instanceResults = {};
    let performanceCount = 0;
    let leadershipCount = 0;
    for (const instance of subjects) {
      const result = { status: 'synchronized', refreshedAt: '', lastError: '', performance: 'disabled', leadership: 'disabled' };
      if (activeCapabilities.performance?.enabled) {
        try {
          const performance = await this.client.performanceLevel(this.state(), instance.id);
          this.saveStage8Projection(`performance:${instance.id}`, 'performance', performance.item || null, instance.id);
          performanceCount += 1;
          result.performance = 'synchronized';
        } catch (error) {
          errors.push({ agentInstanceId: instance.id, kind: 'performance', error: employeeCommandFailureMessage(error) });
          result.performance = 'failed';
          result.lastError ||= employeeCommandFailureMessage(error);
        }
      }
      if (activeCapabilities.leadership?.enabled) {
        try {
          const leadership = await this.client.leadershipLevel(this.state(), instance.id);
          const actions = await this.client.leadershipActions(this.state(), { agentInstanceId: instance.id });
          const appeals = await this.client.leadershipAppeals(this.state(), { agentInstanceId: instance.id });
          this.saveStage8Projection(`leadership:${instance.id}`, 'leadership', leadership.item || null, instance.id);
          this.saveStage8Projection(`leadership_actions:${instance.id}`, 'leadership_actions', actions.items || [], instance.id);
          this.saveStage8Projection(`leadership_appeals:${instance.id}`, 'leadership_appeals', appeals.items || [], instance.id);
          leadershipCount += 1;
          result.leadership = 'synchronized';
        } catch (error) {
          errors.push({ agentInstanceId: instance.id, kind: 'leadership', error: employeeCommandFailureMessage(error) });
          result.leadership = 'failed';
          result.lastError ||= employeeCommandFailureMessage(error);
        }
      }
      result.status = result.lastError ? 'partial' : 'synchronized';
      instanceResults[instance.id] = result;
    }
    const refreshedAt = nowIso();
    for (const result of Object.values(instanceResults)) result.refreshedAt = refreshedAt;
    const result = {
      status: errors.length ? 'partial' : 'synchronized',
      refreshedAt,
      lastError: errors[0]?.error || '',
      performanceCount,
      leadershipCount,
      errorCount: errors.length,
      instances: instanceResults,
    };
    this.store.settingSet('evolution:employee_progression_sync', JSON.stringify(result));
    return result;
  }

  async prepareTaskMemoryCloudEnvelopes(state = this.state()) {
    await this.ensureEvolutionGrant(state);
    const capabilities = await this.client.evolutionCapabilities(this.state());
    this.prepareTaskMemoryCloudEnvelopesFromCapabilities(capabilities);
    return capabilities;
  }

  prepareTaskMemoryCloudEnvelopesFromCapabilities(capabilities = {}) {
    const envelope = capabilities.taskMemoryEncryption || {};
    if (!envelope.available || !envelope.activeKeyId || !envelope.publicKey) return { activated: 0 };
    return this.store.ensurePendingTaskCloudEnvelopes?.({
      keyring: { activeKeyId: envelope.activeKeyId, keys: { [envelope.activeKeyId]: envelope.publicKey } },
    }) || { activated: 0 };
  }

  buildPerformanceEvents(localUserId, instances = []) {
    const byId = new Map(instances.map((row) => [row.id, row]));
    const events = [];
    for (const node of all(this.db, `SELECT n.*,r.owner_user_id,r.department_id AS run_department_id,r.metadata_json AS run_metadata_json
      FROM task_nodes n JOIN task_runs r ON r.id=n.task_run_id WHERE r.owner_user_id=?
        AND n.agent_instance_id!='' AND n.status IN ('completed','failed','blocked','cancelled','accepted','rework')`, [localUserId])) {
      const instance = byId.get(node.agent_instance_id);
      if (!instance) continue;
      events.push({
        agentInstanceId: instance.id,
        sourceKind: 'task_node',
        sourceId: node.id,
      });
    }
    return events;
  }

  buildLeadershipEvaluations(localUserId, instances = []) {
    const byId = new Map(instances.map((row) => [row.id, row]));
    const results = [];
    for (const runRow of all(this.db, `SELECT * FROM task_runs WHERE owner_user_id=? AND lead_agent_instance_id!=''
      AND status IN ('completed','failed','cancelled') ORDER BY updated_at`, [localUserId])) {
      const instance = byId.get(runRow.lead_agent_instance_id);
      if (!instance) continue;
      const nodes = all(this.db, 'SELECT * FROM task_nodes WHERE task_run_id=? ORDER BY created_at', [runRow.id]);
      if (!nodes.length) continue;
      const communications = all(this.db, 'SELECT * FROM communications WHERE task_run_id=? ORDER BY created_at', [runRow.id]);
      const resultVersions = all(this.db, 'SELECT * FROM task_node_result_versions WHERE task_run_id=? ORDER BY created_at', [runRow.id]);
      const metadata = safeJsonParse(runRow.metadata_json, {});
      if (!metadata.leadershipAssessmentEligible && !metadata.leadershipAssignmentId) continue;
      const evidenceRefs = [...nodes.map((node) => `task_node:${node.id}`), ...communications.map((item) => `communication:${item.id}`),
        ...resultVersions.map((item) => `result_version:${item.id}`)];
      const rejectedVersions = resultVersions.filter((item) => ['rejected', 'superseded'].includes(String(item.decision || ''))).length;
      const reworkCount = nodes.filter((node) => node.status === 'rework').length + rejectedVersions + Number(metadata.reworkCount || 0);
      const blockedNodes = nodes.filter((node) => node.status === 'blocked').length;
      const failedNodes = nodes.filter((node) => node.status === 'failed').length;
      const unresolvedCommunications = communications.filter((item) => !['resolved', 'closed'].includes(String(item.status || ''))).length;
      const distinctAgents = new Set(nodes.map((node) => node.agent_instance_id || node.agent_id).filter(Boolean)).size;
      const leaderNodeShare = nodes.length ? nodes.filter((node) => node.agent_instance_id === instance.id || (!node.agent_instance_id && node.agent_id === instance.agent_family_id)).length / nodes.length : 1;
      const accepted = Boolean(metadata.accepted || metadata.acceptanceScore != null);
      const deliveryQuality = Number(metadata.acceptanceScore ?? (runRow.status === 'completed' ? (accepted ? 90 : 75) : runRow.status === 'failed' ? 20 : 50));
      const decompositionMatching = Number(metadata.leadershipDecompositionScore
        ?? Math.max(0, Math.min(100, 60 + Math.min(20, nodes.length * 3) + Math.min(20, distinctAgents * 4))));
      const dependencyCoordination = Number(metadata.leadershipCoordinationScore ?? Math.max(0, 100 - blockedNodes * 15 - failedNodes * 20 - unresolvedCommunications * 8));
      const baselineUplift = Number(metadata.leadershipBaselineUplift || 0);
      results.push({
        agentInstanceId: instance.id,
        taskId: runRow.id,
        assignmentId: metadata.leadershipAssignmentId || '',
        assignmentMode: metadata.leadershipAssignmentMode || 'normal',
        role: metadata.leadershipRole || 'task_lead',
        taskTypeKey: metadata.taskTypeKey || runRow.department_id || instance.agent_family_id,
        departmentCount: Math.max(1, Array.isArray(metadata.collaboratingDepartmentIds) ? metadata.collaboratingDepartmentIds.length + 1 : 1),
        participantCount: Math.max(1, distinctAgents),
        completedAt: runRow.updated_at,
        evidenceRefs,
        evidenceComplete: evidenceRefs.length > 0,
        deterministic: {
          deliveryQuality,
          decompositionMatching,
          leaderNodeShare,
          reworkCount,
          escapedErrorCount: Number(metadata.escapedErrorCount || failedNodes),
          caughtErrorCount: Number(metadata.caughtErrorCount || rejectedVersions),
          dependencyCoordination,
          avoidableBlockedMinutes: Number(metadata.avoidableBlockedMinutes || blockedNodes * 15),
          missedDependencyNotificationCount: unresolvedCommunications,
          baselineUplift,
          securityViolationCount: Number(metadata.securityViolationCount || 0),
          unauthorizedAccessCount: Number(metadata.unauthorizedAccessCount || 0),
          severeSafetyViolation: Boolean(metadata.severeSafetyViolation),
        },
        governanceReview: metadata.leadershipGovernanceReview || {},
        baseline: metadata.leadershipBaseline || { available: false, uplift: baselineUplift, passed: baselineUplift > 0 },
        evaluatorVersion: metadata.leadershipEvaluatorVersion || 'desktop_deterministic_v1',
      });
    }
    return results;
  }

  saveStage8Projection(key, kind, payload, agentInstanceId = '') {
    run(this.db, `INSERT INTO cloud_stage8_projections (projection_key,projection_kind,user_agent_instance_id,payload_json,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(projection_key) DO UPDATE SET projection_kind=excluded.projection_kind,user_agent_instance_id=excluded.user_agent_instance_id,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
    [key, kind, agentInstanceId, JSON.stringify(payload ?? null), nowIso()]);
    if (kind === 'effective_skill' && agentInstanceId) {
      const instance = this.store.getUserAgentInstance?.(agentInstanceId);
      if (instance) this.store.notifyEffectiveSkillChanged?.({
        userId: instance.userId, agentInstanceId, trigger: 'base_or_market_skill_updated',
      });
    }
  }

  stage8Projection(key = '') {
    const row = get(this.db, 'SELECT * FROM cloud_stage8_projections WHERE projection_key=?', [key]);
    return row ? { kind: row.projection_kind, agentInstanceId: row.user_agent_instance_id, payload: safeJsonParse(row.payload_json, null), updatedAt: row.updated_at } : null;
  }

  async marketVersions({ familyId = '', agentInstanceId = '' } = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, agentInstanceId);
    const result = await this.withAgentOwnershipGrantRequest(canonicalInstanceId, async (state) => {
      const versions = await this.client.marketVersions(state, { familyId, agentInstanceId: canonicalInstanceId });
      const response = {
        authority: 'cloud',
        agentFamilyId: familyId,
        agentInstanceId: canonicalInstanceId,
        items: versions.items || [],
        effectiveSkill: null,
        canary: null,
      };
      if (canonicalInstanceId) {
        const [effective, canary] = await Promise.all([
          this.client.effectiveMarketSkill(state, canonicalInstanceId),
          this.client.marketCanaryStatus(state, { agentInstanceId: canonicalInstanceId }),
        ]);
        response.effectiveSkill = effective.item || null;
        response.canary = canary || null;
      }
      return response;
    });
    this.saveStage8Projection(`market_versions:${familyId}`, 'market_versions', result.items);
    if (canonicalInstanceId) {
      this.saveStage8Projection(`effective_skill:${canonicalInstanceId}`, 'effective_skill', result.effectiveSkill, canonicalInstanceId);
      this.saveStage8Projection(`market_canary:${canonicalInstanceId}`, 'market_canary', result.canary, canonicalInstanceId);
    }
    return result;
  }

  cachedEvolutionCapabilities() {
    return safeJsonParse(this.store.settingGet('evolution:cloud_capabilities', '{}'), {});
  }

  async adoptMarketSections(payload = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, payload.agentInstanceId || '');
    const result = await this.withAgentOwnershipGrantRequest(canonicalInstanceId, (state) => this.client.adoptMarketSections(state, {
      ...payload, agentInstanceId: canonicalInstanceId,
    }));
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async rollbackMarketSections(payload = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, payload.agentInstanceId || '');
    const result = await this.withAgentOwnershipGrantRequest(canonicalInstanceId, (state) => this.client.rollbackMarketSections(state, {
      ...payload, agentInstanceId: canonicalInstanceId,
    }));
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async ignoreMarketSections(payload = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, payload.agentInstanceId || '');
    const result = await this.withAgentOwnershipGrantRequest(canonicalInstanceId, (state) => this.client.ignoreMarketSections(state, {
      ...payload, agentInstanceId: canonicalInstanceId,
    }));
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async setMarketCanaryOptIn(payload={}) {
    const canonicalInstanceId=canonicalLocalAgentInstanceId(this.db,payload.agentInstanceId||'');
    const result=await this.withAgentOwnershipGrantRequest(canonicalInstanceId,(state)=>this.client.setMarketCanaryOptIn(state,{
      ...payload,agentInstanceId:canonicalInstanceId,
    }));
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async leadershipHistory(agentInstanceId = '', options = {}) {
    await this.ensureEvolutionGrant(this.state());
    return this.client.leadershipHistory(this.state(), agentInstanceId, options);
  }

  async requestLeadershipTrial(payload = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.requestLeadershipTrial(this.state(), payload);
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async decideLeadershipAction(actionId = '', payload = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.decideLeadershipAction(this.state(), actionId, payload);
    if (payload.agentInstanceId) await this.client.calculateLeadershipLevel(this.state(), payload.agentInstanceId);
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async restoreLeadership(agentInstanceId = '', payload = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.restoreLeadership(this.state(), agentInstanceId, payload);
    await this.client.calculateLeadershipLevel(this.state(), agentInstanceId);
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async submitLeadershipAppeal(payload = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.submitLeadershipAppeal(this.state(), payload);
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async leadershipAppeals(options = {}) {
    await this.ensureEvolutionGrant(this.state());
    return this.client.leadershipAppeals(this.state(), options);
  }

  async decideLeadershipAppeal(appealId = '', payload = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.decideLeadershipAppeal(this.state(), appealId, payload);
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  applyCloudPersonalVersions(localUserId, instanceId, versions = []) {
    let applied = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of versions) {
        const existing = get(this.db, 'SELECT id FROM user_agent_skill_versions WHERE id = ?', [row.id]);
        const previous = get(this.db, 'SELECT active_personal_skill_version_id FROM user_agent_instances WHERE id = ? AND user_id = ?', [instanceId, localUserId]);
        run(this.db, `INSERT OR IGNORE INTO evolution_projection_journal (
          id, cloud_run_id, cloud_version_id, user_agent_instance_id, previous_local_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`, [
          `evproj_${crypto.createHash('sha256').update(`${row.id}:${instanceId}`).digest('hex').slice(0, 32)}`,
          row.sourceEvolutionRunId || '', row.id, instanceId, previous?.active_personal_skill_version_id || '', nowIso(), nowIso(),
        ]);
        const baseVersionId = row.baseAgentVersionId || row.base_agent_version_id || get(this.db, 'SELECT base_agent_version_id FROM user_agent_instances WHERE id = ?', [instanceId])?.base_agent_version_id || '';
        const baseSkill = get(this.db, 'SELECT base_skill_content FROM agent_versions WHERE id = ?', [baseVersionId])?.base_skill_content || '';
        const overlayText = row.overlayText || row.overlay_text || '';
        const effectiveSkillContent = row.effectiveSkillContent || row.effective_skill_content || compileProjectedSkill(baseSkill, overlayText);
        upsertLocalSkillVersion(this.db, {
          ...row, baseAgentVersionId: baseVersionId, overlayText, effectiveSkillContent,
          effectiveSkillHash: row.effectiveSkillHash || row.effective_skill_hash || crypto.createHash('sha256').update(effectiveSkillContent).digest('hex'),
        });
        if (row.status === 'active') run(this.db, 'UPDATE user_agent_instances SET active_personal_skill_version_id = ?, updated_at = ? WHERE id = ? AND user_id = ?', [row.id, nowIso(), instanceId, localUserId]);
        run(this.db, "UPDATE evolution_projection_journal SET status = 'completed', completed_at = ?, updated_at = ?, error_text = '' WHERE cloud_version_id = ? AND user_agent_instance_id = ?", [nowIso(), nowIso(), row.id, instanceId]);
        if (!existing) applied += 1;
      }
      this.db.exec('COMMIT');
      this.store.notifyEffectiveSkillChanged?.({
        userId: localUserId, agentInstanceId: instanceId, trigger: 'personal_skill_cloud_projection',
      });
      return applied;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async requestPersonalEvolutionRun({ agentInstanceId = '', trigger = 'manual', force = false } = {}) {
    const state = this.state();
    await this.ensureEvolutionGrant(state);
    await this.evolutionPreference();
    await this.drainEvolutionEvidenceOutbox();
    this.enqueueEvolutionEvidence();
    await this.drainEvolutionEvidence();
    return this.client.requestPersonalEvolutionRun(this.state(), { agentInstanceId, triggerKind: trigger, force });
  }

  async personalEvolutionRuns({ agentInstanceId = '', limit = 30 } = {}) {
    await this.ensureEvolutionGrant(this.state());
    return this.client.personalEvolutionRuns(this.state(), { agentInstanceId, limit });
  }

  async evolutionEvidenceUsage({ agentInstanceId = '', scope = '', status = '', cursor = '', limit = 50 } = {}) {
    await this.ensureEvolutionGrant(this.state());
    return this.client.evolutionEvidenceUsage(this.state(), { agentInstanceId,scope,status,cursor,limit });
  }

  async personalEvolutionSchedule({ agentInstanceId = '' } = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.personalEvolutionSchedule(this.state(), { agentInstanceId });
    if (!agentInstanceId) this.store.settingSet('evolution:cloud_personal_schedules', JSON.stringify(result));
    return result;
  }

  async personalEvolutionRun(runId = '') {
    await this.ensureEvolutionGrant(this.state());
    return this.client.personalEvolutionRun(this.state(), runId);
  }

  async decidePersonalEvolutionRun({ runId = '', decisions = [], skillDecision = '', memoryDecisions = [] } = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.decidePersonalEvolutionRun(this.state(), runId, {
      decisions, skillDecision, memoryDecisions,
    });
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  async rollbackPersonalVersion({ agentInstanceId = '', targetVersionId = '', commandId = '', expectedActiveVersionId } = {}) {
    const canonicalInstanceId = canonicalLocalAgentInstanceId(this.db, agentInstanceId);
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [this.state().user_id || '']);
    const localInstance = localUser
      ? get(this.db, 'SELECT * FROM user_agent_instances WHERE id=? AND user_id=?', [canonicalInstanceId, localUser.id])
      : null;
    const resolvedCommandId = String(commandId || newId('personal_version'));
    const expected = expectedActiveVersionId === undefined
      ? String(localInstance?.active_personal_skill_version_id || '')
      : String(expectedActiveVersionId || '');
    return this.withAgentOwnershipGrantRequest(canonicalInstanceId, async (state) => {
      const result = await this.client.rollbackPersonalEvolutionVersion(state, {
        agentInstanceId: canonicalInstanceId,
        targetVersionId,
        commandId: resolvedCommandId,
        expectedActiveVersionId: expected,
      });
      return this.refreshPersonalVersionProjection({ localUser, agentInstanceId: canonicalInstanceId, result });
    });
  }

  async rollbackPersonalMemory({ agentInstanceId = '', memoryDocumentId = '', targetVersionId = '' } = {}) {
    await this.ensureEvolutionGrant(this.state());
    const result = await this.client.rollbackPersonalEvolutionVersion(this.state(), {
      agentInstanceId, memoryDocumentId, targetMemoryVersionId: targetVersionId,
    });
    await this.syncEvolutionAuthority(this.state());
    return result;
  }

  applyPersonalEvolutionSnapshot(snapshot = {}, { remoteUserId = '' } = {}) {
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [remoteUserId || '']);
    if (!localUser) return { status: 'skipped', reason: 'unbound_remote_user' };
    const proposals = Array.isArray(snapshot.data?.proposals) ? snapshot.data.proposals : [];
    const operations = Array.isArray(snapshot.data?.memoryOperations) ? snapshot.data.memoryOperations : [];
    const actions = Array.isArray(snapshot.data?.actions) ? snapshot.data.actions : [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of proposals) upsertLocalPersonalEvolutionProposal(this.db, this.store, localUser.id, row);
      for (const row of operations) upsertLocalPersonalEvolutionOperation(this.db, this.store, row);
      for (const row of proposals) {
        for (const evidence of Array.isArray(row.evidenceRefs) ? row.evidenceRefs : []) {
          this.store.addPersonalEvolutionEvidence(row.id, [{
            id: evidence.id, sourceKind: evidence.sourceKind || evidence.source_kind,
            sourceId: evidence.sourceId || evidence.source_id, sourceHash: evidence.sourceHash || evidence.source_hash,
            occurredAt: evidence.occurredAt || evidence.occurred_at, contextKey: evidence.contextKey || evidence.context_key,
            privacyLevel: evidence.privacyLevel || evidence.privacy_level || 'private', included: evidence.included !== false,
            rejectionReason: evidence.rejectionReason || evidence.rejection_reason || '',
          }]);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const action of actions) this.applyCanonicalPersonalEvolutionAction(localUser.id, action);
    return { status: 'applied', proposalCount: proposals.length, actionCount: actions.length };
  }

  applyCanonicalPersonalEvolutionAction(localUserId, row = {}) {
    const proposalId = row.proposal_id || row.proposalId || '';
    const targetKind = row.target_kind || row.targetKind || '';
    const targetId = row.target_id || row.targetId || '';
    const decision = row.decision || '';
    const proposal = this.store.getPersonalEvolutionProposal(proposalId);
    if (!proposal || proposal.userId !== localUserId) return { status: 'skipped' };
    const cloudAuthoritative = proposal.originDeviceId === 'cloud-authority';
    const existingAction = row.id ? get(this.db, 'SELECT * FROM personal_evolution_proposal_actions WHERE id = ?', [row.id]) : null;
    if (existingAction?.sync_status === 'confirmed') return { status: 'already_applied' };
    if (!existingAction) this.store.recordPersonalEvolutionAction({
      id: row.id || undefined, proposalId, targetKind, targetId, decision,
      actorUserId: localUserId, actorDeviceId: row.actor_device_id || row.actorDeviceId || '',
      revision: row.revision || 1, syncStatus: 'confirmed_pending_apply', confirmedAt: row.received_at || row.receivedAt || nowIso(),
    });
    try {
      if (targetKind === 'skill' && proposal.skillActionStatus === 'none') {
        if (decision === 'accept') {
          const candidate = get(this.db, 'SELECT id FROM user_agent_skill_versions WHERE id = ? AND user_agent_instance_id = ?', [proposal.candidatePersonalSkillVersionId, proposal.agentInstanceId]);
          if (!candidate) return { status: 'pending', reason: 'candidate_not_synced' };
          const activeVersionId = this.store.getUserAgentInstance(proposal.agentInstanceId)?.activePersonalSkillVersionId || '';
          if (cloudAuthoritative && activeVersionId !== candidate.id) return { status: 'pending', reason: 'cloud_skill_activation_not_projected' };
          if (!cloudAuthoritative && activeVersionId !== candidate.id) {
            this.store.activatePersonalSkillVersion({ agentInstanceId: proposal.agentInstanceId, skillVersionId: candidate.id });
          }
        }
        this.store.updatePersonalEvolutionProposal(proposal.id, { skillActionStatus: decision === 'accept' ? 'activated' : 'rejected' });
      }
      if (targetKind === 'memory_operation') {
        const operation = get(this.db, 'SELECT * FROM personal_evolution_memory_operations WHERE id = ? AND proposal_id = ?', [targetId, proposal.id]);
        if (!operation) return { status: 'pending', reason: 'memory_operation_not_synced' };
        if (decision === 'accept') {
          const document = this.store.getMemoryDocument(operation.memory_document_id);
          if (!document) return { status: 'pending', reason: 'memory_document_not_synced' };
          const alreadyApplied = get(this.db, `SELECT id FROM memory_document_versions
            WHERE memory_document_id = ? AND source_kind = 'personal_evolution_cloud' AND source_id = ?`, [document.id, operation.id]);
          const currentVersion = get(this.db, 'SELECT source_kind, source_id FROM memory_document_versions WHERE id = ?', [document.currentVersionId]);
          const continuedProposal = currentVersion?.source_kind === 'personal_evolution_cloud'
            && Boolean(get(this.db, 'SELECT id FROM personal_evolution_memory_operations WHERE id = ? AND proposal_id = ?', [currentVersion.source_id, proposal.id]));
          if (cloudAuthoritative && !alreadyApplied && !continuedProposal) {
            return { status: 'pending', reason: 'cloud_memory_version_not_projected' };
          }
          if (!alreadyApplied && !continuedProposal
            && (document.currentVersionId !== operation.baseline_version_id || document.contentHash !== operation.baseline_content_hash)) {
            this.store.updatePersonalEvolutionProposal(proposal.id, { status: 'expired', expiresReason: 'memory_baseline_changed', expiresAt: nowIso() });
            return { status: 'expired' };
          }
          if (!alreadyApplied) {
            const content = applyMemoryOperations(document.content, [{
              sectionName: operation.section_name, operationType: operation.operation_type,
              targetItemHash: operation.target_item_hash, proposedText: operation.proposed_text,
            }]);
            this.store.appendMemoryDocumentVersion({
              memoryDocumentId: document.id, content, sourceKind: 'personal_evolution_cloud',
              sourceId: operation.id, reviewStatus: 'approved', createdBy: localUserId,
            });
          }
        }
        run(this.db, 'UPDATE personal_evolution_memory_operations SET status = ?, updated_at = ? WHERE id = ?', [decision === 'accept' ? 'applied' : 'rejected', nowIso(), operation.id]);
      }
      if (row.id) run(this.db, "UPDATE personal_evolution_proposal_actions SET sync_status = 'confirmed', error_text = '' WHERE id = ?", [row.id]);
      recomputePersonalProposalState(this.store, proposal.id);
      return { status: 'applied' };
    } catch (error) {
      if (row.id) run(this.db, "UPDATE personal_evolution_proposal_actions SET sync_status = 'confirmed_pending_apply', error_text = ? WHERE id = ?", [clipText(error.message || String(error), 1000), row.id]);
      return { status: 'pending', error: String(error.message || error) };
    }
  }

  async scanOutputFiles(messages = [], { cursor = '' } = {}) {
    const files = [];
    const seenSources = new Set();
    const addFile = async (file, { explicitlyReferenced = false } = {}) => {
      const resolvedSource = path.resolve(file);
      if (seenSources.has(resolvedSource)) return;
      if (explicitlyReferenced ? !shouldSyncReferencedFile(file) : !shouldSyncFile(this.root, file)) return;
      const stat = await fsp.stat(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return;
      const relative = relativeToRoot(this.root, file);
      const insideRoot = relative && relative !== '..' && !relative.startsWith('../');
      let localPath = insideRoot ? relative : '';
      if (!explicitlyReferenced && cursor && !changedAfter(new Date(stat.mtimeMs).toISOString(), cursor)) {
        const pendingManifest = localPath ? get(this.db, `SELECT 1 AS pending FROM cloud_file_manifest
          WHERE local_path=? AND upload_status!='uploaded'`, [localPath]) : null;
        if (!pendingManifest) return;
      }
      const sha256 = await sha256File(file);
      if (!localPath) localPath = `external_refs/${sha256.slice(0, 16)}/${safeCloudFilename(path.basename(file))}`;
      const item = {
        localPath,
        sha256,
        sizeBytes: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        contentType: syncContentType(file),
        originalName: path.basename(file),
      };
      Object.defineProperty(item, 'sourcePath', { value: resolvedSource, enumerable: false });
      seenSources.add(resolvedSource);
      run(
        this.db,
        `INSERT INTO cloud_file_manifest (
          local_path, sha256, size_bytes, mtime_ms, upload_status, updated_at
         ) VALUES (?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(local_path) DO UPDATE SET
           sha256 = excluded.sha256,
           size_bytes = excluded.size_bytes,
           mtime_ms = excluded.mtime_ms,
           upload_status = CASE
             WHEN cloud_file_manifest.sha256 = excluded.sha256 AND cloud_file_manifest.upload_status = 'uploaded'
             THEN 'uploaded'
             ELSE 'pending'
           END,
           updated_at = excluded.updated_at`,
        [localPath, sha256, stat.size, Math.trunc(stat.mtimeMs), nowIso()],
      );
      files.push(item);
    };
    await walkIncludedFiles(this.root, async (file) => {
      await addFile(file);
    });
    for (const message of messages) {
      const metadata = safeJsonParse(message.metadata_json, {});
      for (const attachment of Array.isArray(metadata.attachments) ? metadata.attachments : []) {
        for (const file of referencedAttachmentFiles(this.root, attachment)) await addFile(file, { explicitlyReferenced: true });
      }
      for (const artifact of Array.isArray(metadata.outputArtifacts) ? metadata.outputArtifacts : []) {
        for (const file of referencedAttachmentFiles(this.root, artifact)) await addFile(file, { explicitlyReferenced: true });
      }
      const artifact = parseArtifactMessage(message.content);
      if (artifact?.data) {
        for (const file of referencedAttachmentFiles(this.root, artifact.data)) await addFile(file, { explicitlyReferenced: true });
      }
    }
    for (const manifest of all(this.db, `SELECT local_path FROM cloud_file_manifest
      WHERE upload_status!='uploaded' ORDER BY updated_at,local_path`)) {
      const localPath = safeCloudLocalPath(this.root, manifest.local_path || '');
      if (!localPath) continue;
      const file = path.resolve(this.root, localPath);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      await addFile(file, { explicitlyReferenced: true });
    }
    return files;
  }

  persistFileRefs(fileRefs) {
    const firstByPath = new Map();
    for (const ref of fileRefs) {
      run(
        this.db,
        `INSERT INTO cloud_file_refs (
          id, local_path, sha256, user_id, project_id, session_id, message_id,
          task_run_id, task_node_id, relation_type, source_kind, original_name,
          content_type, size_bytes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          sha256 = excluded.sha256,
          user_id = excluded.user_id,
          project_id = excluded.project_id,
          session_id = excluded.session_id,
          message_id = excluded.message_id,
          task_run_id = excluded.task_run_id,
          task_node_id = excluded.task_node_id,
          relation_type = excluded.relation_type,
          source_kind = excluded.source_kind,
          original_name = excluded.original_name,
          content_type = excluded.content_type,
          size_bytes = excluded.size_bytes,
          updated_at = excluded.updated_at`,
        [
          ref.id, ref.localPath, ref.sha256, ref.userId, ref.projectId, ref.conversationId,
          ref.messageId, ref.taskRunId, ref.taskNodeId, ref.relationType, ref.sourceKind,
          ref.originalName, ref.contentType, ref.sizeBytes, ref.createdAt, nowIso(),
        ],
      );
      if (!firstByPath.has(ref.localPath) || ref.messageId) firstByPath.set(ref.localPath, ref);
    }
    for (const [localPath, ref] of firstByPath) {
      run(
        this.db,
        `UPDATE cloud_file_manifest
         SET session_id = ?, message_id = ?, task_run_id = ?, updated_at = ?
         WHERE local_path = ?`,
        [ref.conversationId, ref.messageId, ref.taskRunId, nowIso(), localPath],
      );
    }
  }

  async uploadFiles(state, files) {
    const unique = new Map(files.map((item) => [item.sha256, item]));
    let uploadedCount = 0;
    for (const item of unique.values()) {
      const localPath = item.sourcePath || path.join(this.root, item.localPath);
      try {
        const current = get(
          this.db,
          `SELECT upload_status FROM cloud_file_manifest
           WHERE sha256 = ? AND upload_status = 'uploaded'
           LIMIT 1`,
          [item.sha256],
        );
        if (current) {
          run(this.db, `UPDATE cloud_file_manifest SET upload_status='uploaded',uploaded_at=?,last_error='',updated_at=?
            WHERE sha256=?`, [nowIso(), nowIso(), item.sha256]);
          uploadedCount += 1;
          continue;
        }
        const body = await fsp.readFile(localPath);
        await this.client.uploadFile(state, {
          sha256: item.sha256,
          localPath: item.localPath,
          sizeBytes: item.sizeBytes,
          body,
        });
        run(
          this.db,
          `UPDATE cloud_file_manifest
           SET upload_status = 'uploaded', uploaded_at = ?, last_error = '', updated_at = ?
           WHERE sha256 = ?`,
          [nowIso(), nowIso(), item.sha256],
        );
        uploadedCount += 1;
      } catch (error) {
        run(
          this.db,
          `UPDATE cloud_file_manifest
           SET upload_status = 'failed', last_error = ?, updated_at = ?
           WHERE sha256 = ?`,
          [clipText(error.message || String(error), 1000), nowIso(), item.sha256],
        );
        throw error;
      }
    }
    return uploadedCount;
  }

  async uploadFilesV6(state, files) {
    const unique = new Map(files.map((item) => [item.sha256, item]));
    let uploadedCount = 0;
    for (const item of unique.values()) {
      const localPath = item.sourcePath || path.join(this.root, item.localPath);
      try {
        const current = get(this.db, `SELECT upload_status FROM cloud_file_manifest
          WHERE sha256=? AND upload_status='uploaded' LIMIT 1`, [item.sha256]);
        if (current) {
          run(this.db, `UPDATE cloud_file_manifest SET upload_status='uploaded',uploaded_at=?,last_error='',updated_at=?
            WHERE sha256=?`, [nowIso(), nowIso(), item.sha256]);
          uploadedCount += 1;
          continue;
        }
        const initiated = await this.client.initiateV6File(state, {
          sha256: item.sha256, sizeBytes: item.sizeBytes, contentType: item.contentType || 'application/octet-stream',
        });
        if (initiated.status !== 'already_uploaded') {
          const body = await fsp.readFile(localPath);
          await this.client.uploadPresigned(initiated.upload, body);
          await this.client.completeV6File(state, { sha256: item.sha256 });
        }
        run(this.db, `UPDATE cloud_file_manifest SET upload_status='uploaded',uploaded_at=?,last_error='',updated_at=? WHERE sha256=?`, [
          nowIso(), nowIso(), item.sha256,
        ]);
        uploadedCount += 1;
      } catch (error) {
        run(this.db, `UPDATE cloud_file_manifest SET upload_status='failed',last_error=?,updated_at=? WHERE sha256=?`, [
          clipText(error.message || String(error), 1000), nowIso(), item.sha256,
        ]);
        throw error;
      }
    }
    return uploadedCount;
  }

  applyV6Changes(changes = [], { remoteUserId = '' } = {}) {
    const localUser = get(this.db, 'SELECT * FROM auth_users WHERE remote_id=?', [remoteUserId]);
    if (!localUser) return { status: 'skipped', reason: 'unbound_remote_user', applied: 0 };
    const clientContract = this.databaseClientContract();
    const clientCapabilities = new Set(clientContract.capabilities || []);
    const incompatibleChanges = (Array.isArray(changes) ? changes : []).filter((change) => {
      const minimumProtocolVersion = Number(change?.minimumProtocolVersion || change?.minimum_protocol_version || 0);
      const requiredCapabilities = Array.isArray(change?.requiredCapabilities)
        ? change.requiredCapabilities : Array.isArray(change?.required_capabilities) ? change.required_capabilities : [];
      return minimumProtocolVersion > Number(clientContract.syncProtocolVersion || 0)
        || requiredCapabilities.some((capability) => !clientCapabilities.has(String(capability || '')));
    });
    if (incompatibleChanges.length) {
      this.deferV6IdentityChanges(incompatibleChanges, {
        remoteUserId,
        localUserId: localUser.id,
        reasonCode: 'client_database_contract_incompatible',
      });
      const error = new Error(`Cloud changes require unsupported database capabilities (${incompatibleChanges.length} changes deferred).`);
      error.code = 'sync_client_incompatible';
      error.deferredChanges = incompatibleChanges.length;
      throw error;
    }
    const identity = {
      agentFamilies: [], agentVersions: [], userAgentInstances: [], userAgentSkillVersions: [],
      userAgentInstanceAliases: [], memoryDocuments: [], memoryDocumentVersions: [], memoryDocumentAliases: [],
      agentContextSpaces: [],
      agentContextStates: [],
      chatContextStates: [],
      memorySyncMappings: [],
      taskSecurityContexts: [],
    };
    const personal = { proposals: [], memoryOperations: [], actions: [] };
    const core = [];
    const acceptedChanges = [];
    let skipped = 0;
    const target = {
      agent_family: 'agentFamilies', agent_version: 'agentVersions', user_agent_instance: 'userAgentInstances',
      user_agent_skill_version: 'userAgentSkillVersions', agent_instance_alias: 'userAgentInstanceAliases',
      memory_document: 'memoryDocuments', memory_document_version: 'memoryDocumentVersions',
      memory_document_alias: 'memoryDocumentAliases', task_security_context: 'taskSecurityContexts',
      agent_context_space: 'agentContextSpaces',
      agent_context_state: 'agentContextStates',
      chat_context_state: 'chatContextStates',
      memory_sync_mapping: 'memorySyncMappings',
    };
    for (const change of Array.isArray(changes) ? changes : []) {
      const payload = change?.payload && typeof change.payload === 'object' ? { ...change.payload } : {};
      if (v6PayloadBelongsToAnotherLocalUser(this.db, localUser.id, payload)) {
        skipped += 1;
        continue;
      }
      acceptedChanges.push(change);
      if (change.operation === 'delete') payload.status = 'deleted';
      if (target[change.entityType]) identity[target[change.entityType]].push(payload);
      else if (change.entityType === 'personal_evolution_proposal') personal.proposals.push(payload);
      else if (change.entityType === 'personal_evolution_memory_operation') personal.memoryOperations.push(payload);
      else core.push({ ...change, payload });
    }
    const identityCount = Object.values(identity).reduce((sum, rows) => sum + rows.length, 0);
    const deferredContextIdentity = {
      agentContextStates: identity.agentContextStates.splice(0),
      chatContextStates: identity.chatContextStates.splice(0),
    };
    const baseIdentityCount = Object.values(identity).reduce((sum, rows) => sum + rows.length, 0);
    const identityResult = baseIdentityCount
      ? this.applyIdentitySnapshot({ status: 'ok', data: identity }, { remoteUserId, deferMissingMemoryVersions: true })
      : { status: 'applied', deferredMemoryVersions: [] };
    const deferredVersionIds = new Set((identityResult.deferredMemoryVersions || []).map((row) => String(row.id || '')));
    const deferredChanges = acceptedChanges.filter((change) => (
      change.entityType === 'memory_document_version' && deferredVersionIds.has(String(change.entityId || change.payload?.id || ''))
    ));
    if (deferredChanges.length) this.deferV6IdentityChanges(deferredChanges, {
      remoteUserId,
      localUserId: localUser.id,
      reasonCode: 'memory_document_owner_missing',
    });
    if (personal.proposals.length || personal.memoryOperations.length) {
      this.applyPersonalEvolutionSnapshot({ status: 'ok', data: personal }, { remoteUserId });
    }
    const prerequisiteCore = core.filter((change) => ['project', 'conversation', 'conversation_alias'].includes(change.entityType));
    prerequisiteCore.sort((left, right) => ['project', 'conversation', 'conversation_alias'].indexOf(left.entityType)
      - ['project', 'conversation', 'conversation_alias'].indexOf(right.entityType));
    const remainingCore = core.filter((change) => !['project', 'conversation', 'conversation_alias'].includes(change.entityType));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of prerequisiteCore) applyV6CoreChange(this.db, localUser.id, change);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (deferredContextIdentity.agentContextStates.length || deferredContextIdentity.chatContextStates.length) {
      this.applyIdentitySnapshot({ status: 'ok', data: deferredContextIdentity }, { remoteUserId });
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const change of remainingCore) applyV6CoreChange(this.db, localUser.id, change);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const canResolveDeferred = identity.memoryDocuments.length > 0
      || identity.memoryDocumentAliases.length > 0
      || identity.memorySyncMappings.length > 0;
    const recovered = canResolveDeferred
      ? this.retryDeferredV6IdentityChanges({ remoteUserId, localUserId: localUser.id })
      : { resolved: 0, pending: 0, quarantined: 0 };
    const deferredKeys = new Set(deferredChanges.map((change) => `${change.entityType}\u001f${change.entityId}\u001f${Number(change.revision || 0)}`));
    this.recordV6Revisions(acceptedChanges.filter((change) => !deferredKeys.has(
      `${change.entityType}\u001f${change.entityId}\u001f${Number(change.revision || 0)}`,
    )));
    return {
      status: deferredChanges.length ? 'partial' : 'applied',
      applied: identityCount - deferredChanges.length + personal.proposals.length + personal.memoryOperations.length + core.length,
      deferred: deferredChanges.length,
      recovered: Number(recovered.resolved || 0),
      pendingDeferred: Number(recovered.pending || 0),
      quarantinedDeferred: Number(recovered.quarantined || 0),
      skipped,
    };
  }

  deferV6IdentityChanges(changes = [], { remoteUserId = '', localUserId = '', reasonCode = 'dependency_missing' } = {}) {
    const now = nowIso();
    for (const change of Array.isArray(changes) ? changes : []) {
      const entityType = String(change.entityType || '');
      const entityId = String(change.entityId || change.payload?.id || '');
      if (!remoteUserId || !localUserId || !entityType || !entityId) continue;
      run(this.db, `INSERT INTO cloud_sync_v6_deferred_changes (
        remote_user_id,local_user_id,entity_type,entity_id,revision,operation,content_hash,payload_json,
        reason_code,status,attempt_count,last_error,first_seen_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)
      ON CONFLICT(remote_user_id,entity_type,entity_id,revision) DO UPDATE SET
        local_user_id=excluded.local_user_id,operation=excluded.operation,content_hash=excluded.content_hash,
        payload_json=excluded.payload_json,reason_code=excluded.reason_code,
        status='pending',last_error=excluded.last_error,resolved_at='',updated_at=excluded.updated_at`, [
        remoteUserId, localUserId, entityType, entityId, Number(change.revision || 0), change.operation || 'upsert',
        change.contentHash || '', JSON.stringify(change.payload || {}), reasonCode,
        reasonCode, now, now,
      ]);
    }
  }

  retryDeferredV6IdentityChanges({ remoteUserId = '', localUserId = '', limit = 200 } = {}) {
    if (!remoteUserId || !localUserId) return { resolved: 0, pending: 0, quarantined: 0 };
    const rows = all(this.db, `SELECT * FROM cloud_sync_v6_deferred_changes
      WHERE remote_user_id=? AND local_user_id=? AND status IN ('pending','quarantined')
      ORDER BY first_seen_at,entity_type,entity_id LIMIT ?`, [remoteUserId, localUserId, Math.max(1, Math.min(1000, Number(limit || 200)))]);
    let resolved = 0;
    for (const row of rows) {
      const change = {
        entityType: row.entity_type,
        entityId: row.entity_id,
        revision: Number(row.revision || 0),
        operation: row.operation || 'upsert',
        contentHash: row.content_hash || '',
        payload: safeJsonParse(row.payload_json, {}),
      };
      if (change.entityType !== 'memory_document_version') continue;
      const result = this.applyIdentitySnapshot({ status: 'ok', data: { memoryDocumentVersions: [change.payload] } }, {
        remoteUserId,
        deferMissingMemoryVersions: true,
      });
      const stillDeferred = (result.deferredMemoryVersions || []).length > 0;
      const attemptedAt = nowIso();
      if (!stillDeferred) {
        run(this.db, `UPDATE cloud_sync_v6_deferred_changes SET status='applied',attempt_count=attempt_count+1,
          last_error='',last_attempt_at=?,updated_at=?,resolved_at=?
          WHERE remote_user_id=? AND entity_type=? AND entity_id=? AND revision=?`, [
          attemptedAt, attemptedAt, attemptedAt, remoteUserId, row.entity_type, row.entity_id, row.revision,
        ]);
        resolved += 1;
        continue;
      }
      const attempts = Number(row.attempt_count || 0) + 1;
      run(this.db, `UPDATE cloud_sync_v6_deferred_changes SET status=?,attempt_count=?,last_error=?,
        last_attempt_at=?,updated_at=? WHERE remote_user_id=? AND entity_type=? AND entity_id=? AND revision=?`, [
        attempts >= MAX_DEFERRED_V6_CHANGE_ATTEMPTS ? 'quarantined' : 'pending', attempts,
        'memory_document_owner_missing', attemptedAt, attemptedAt,
        remoteUserId, row.entity_type, row.entity_id, row.revision,
      ]);
    }
    const counts = get(this.db, `SELECT
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status='quarantined' THEN 1 ELSE 0 END) AS quarantined_count
      FROM cloud_sync_v6_deferred_changes WHERE remote_user_id=?`, [remoteUserId]) || {};
    return {
      resolved,
      pending: Number(counts.pending_count || 0),
      quarantined: Number(counts.quarantined_count || 0),
    };
  }

  recordV6Revisions(changes = []) {
    for (const change of Array.isArray(changes) ? changes : []) {
      if (!change?.entityType || !change?.entityId || !Number(change.revision || 0)) continue;
      run(this.db, `INSERT INTO cloud_sync_entity_revisions(entity_type,entity_id,revision,content_hash,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET revision=excluded.revision,
        content_hash=excluded.content_hash,updated_at=excluded.updated_at`, [
        change.entityType, change.entityId, Number(change.revision), change.contentHash || '', nowIso(),
      ]);
    }
  }

  enqueueV6Outbox(state, payload = {}) {
    const payloadJson = stableCloudJson(payload);
    const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const existing = get(this.db, `SELECT * FROM cloud_sync_v6_outbox
      WHERE server_url=? AND user_id=? AND device_id=? AND payload_hash=?`, [
      state.server_url, state.user_id, state.device_id, payloadHash,
    ]);
    if (existing) return normalizeV6Outbox(existing);
    const id = newId('sync_outbox');
    const now = nowIso();
    run(this.db, `INSERT INTO cloud_sync_v6_outbox (
      id,batch_id,payload_hash,server_url,user_id,device_id,cursor_to,payload_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`, [
      id, payload.batch?.id || id, payloadHash, state.server_url, state.user_id, state.device_id,
      payload.batch?.cursorTo || '', payloadJson, now, now,
    ]);
    return normalizeV6Outbox(get(this.db, 'SELECT * FROM cloud_sync_v6_outbox WHERE id=?', [id]));
  }

  async drainV6Outbox(state = this.state(), { force = false, limit = 10 } = {}) {
    const staleSendingAt = new Date(Date.now() - 10 * 60_000).toISOString();
    run(this.db, `UPDATE cloud_sync_v6_outbox SET status='failed',last_error='sending lease expired',
      next_attempt_at='',updated_at=? WHERE status='sending' AND updated_at<?`, [nowIso(), staleSendingAt]);
    let processed = 0;
    let cursorTo = '';
    let lastResponse = null;
    while (processed < Math.min(25, Math.max(1, Number(limit || 10)))) {
      const row = get(this.db, `SELECT * FROM cloud_sync_v6_outbox
        WHERE server_url=? AND user_id=? AND device_id=? AND status IN ('pending','failed')
        ORDER BY created_at,id LIMIT 1`, [state.server_url, state.user_id, state.device_id]);
      if (!row) return { status: processed ? 'completed' : 'empty', processed, cursorTo, lastResponse };
      if (!force && row.next_attempt_at && row.next_attempt_at > nowIso()) {
        return { status: 'deferred', processed, cursorTo, nextAttemptAt: row.next_attempt_at, lastResponse };
      }
      const claimed = run(this.db, `UPDATE cloud_sync_v6_outbox SET status='sending',attempt_count=attempt_count+1,
        next_attempt_at='',last_error='',updated_at=? WHERE id=? AND status IN ('pending','failed')`, [nowIso(), row.id]);
      if (!claimed.changes) continue;
      const current = get(this.db, 'SELECT * FROM cloud_sync_v6_outbox WHERE id=?', [row.id]);
      try {
        lastResponse = await this.client.submitV6Batch(
          this.state(),
          safeJsonParse(current.payload_json, {}),
          this.databaseClientContract(),
        );
        this.recordV6Revisions(lastResponse.acceptedChanges || []);
        const completedAt = nowIso();
        run(this.db, `UPDATE cloud_sync_v6_outbox SET status='completed',response_json=?,last_error='',
          next_attempt_at='',completed_at=?,updated_at=? WHERE id=?`, [
          JSON.stringify(lastResponse || {}), completedAt, completedAt, current.id,
        ]);
        cursorTo = current.cursor_to || cursorTo;
        processed += 1;
      } catch (error) {
        const retryAt = new Date(Date.now() + syncRetryDelayMs(current.attempt_count)).toISOString();
        run(this.db, `UPDATE cloud_sync_v6_outbox SET status='failed',last_error=?,next_attempt_at=?,updated_at=? WHERE id=?`, [
          clipText(error.message || String(error), 2000), retryAt, nowIso(), current.id,
        ]);
        throw error;
      }
    }
    return { status: 'completed', processed, cursorTo, lastResponse };
  }

  async recoverTaskMemoryKeys(state = this.state()) {
    const contexts = all(this.db, `SELECT * FROM task_security_contexts
      WHERE cloud_sync_recovery_allowed=1 AND cloud_envelope_state='active' AND status='active'
        AND (local_envelope_state!='active' OR local_wrapped_key='') ORDER BY updated_at`);
    let recovered = 0;
    const failures = [];
    for (const context of contexts) {
      try {
        const remote = await this.client.rewrapTaskKey(state, { taskRunId: context.task_run_id, keyVersion: context.key_version });
        const envelope = this.store.taskMemoryKeyring.rewrapRecoveredTaskKey(remote, {
          taskRunId: context.task_run_id, keyVersion: context.key_version,
        });
        const dataKey = this.store.taskMemoryKeyring.unwrapTaskKey(envelope, {
          taskRunId: context.task_run_id, keyVersion: context.key_version,
        });
        const encrypted = get(this.db, `SELECT v.* FROM memory_document_versions v
          JOIN memory_documents d ON d.id=v.memory_document_id
          WHERE d.task_run_id=? AND v.encryption_algorithm!='' ORDER BY v.version_no LIMIT 1`, [context.task_run_id]);
        if (encrypted) {
          const content = decryptTaskMemoryContent({
            algorithm: encrypted.encryption_algorithm, ciphertext: encrypted.content_ciphertext,
            nonce: encrypted.content_nonce, tag: encrypted.content_tag, aad: encrypted.content_aad,
          }, dataKey);
          if (encrypted.content_hash && crypto.createHash('sha256').update(content).digest('hex') !== encrypted.content_hash) {
            throw new Error('Recovered task Memory key failed content hash verification.');
          }
        }
        const localDevice = this.store.taskMemoryKeyring.deviceKey();
        run(this.db, `UPDATE task_security_contexts SET local_key_id=?,local_envelope_state='active',
          local_wrap_algorithm=?,local_wrapping_key_id=?,local_wrapped_key=?,local_wrap_nonce=?,local_wrap_tag=?,updated_at=?
          WHERE task_run_id=?`, [
          localDevice.keyId, envelope.algorithm, envelope.wrappingKeyId, envelope.ciphertext, envelope.nonce, envelope.tag,
          nowIso(), context.task_run_id,
        ]);
        recovered += 1;
      } catch (error) {
        failures.push({ taskRunId: context.task_run_id, error: clipText(error.message || String(error), 500) });
      }
    }
    return { status: failures.length ? 'partial' : 'completed', recovered, failures };
  }
}

function applyLocalConversationAlias(db, localUserId, row = {}, entityId = '') {
  const aliasConversationId = v6Field(row, 'alias_conversation_id', 'aliasConversationId') || String(entityId || '').trim();
  const requestedCanonicalId = v6Field(row, 'canonical_conversation_id', 'canonicalConversationId')
    || v6Field(row, 'conversation_id', 'conversationId');
  if (!aliasConversationId || !requestedCanonicalId || aliasConversationId === requestedCanonicalId) {
    throw new Error('conversation_alias_invalid: alias and canonical conversation ids must be distinct.');
  }
  const canonicalConversationId = resolveLocalConversationAliasTarget(db, requestedCanonicalId, aliasConversationId);
  if (canonicalConversationId === aliasConversationId) {
    throw new Error('conversation_alias_cycle: conversation alias cycle detected.');
  }
  const existingAlias = get(db, 'SELECT conversation_id FROM conversation_aliases WHERE alias_id=?', [aliasConversationId]);
  if (existingAlias && existingAlias.conversation_id !== aliasConversationId) {
    const existingCanonicalId = resolveLocalConversationAliasTarget(db, existingAlias.conversation_id, aliasConversationId);
    if (existingCanonicalId !== canonicalConversationId) {
      throw new Error('conversation_alias_immutable: an existing conversation alias cannot be redirected.');
    }
  }
  const canonicalConversation = get(db, `SELECT * FROM conversations
    WHERE id=? AND owner_user_id=? AND conversation_kind='direct'`, [canonicalConversationId, localUserId]);
  if (!canonicalConversation) throw new Error('conversation_alias_target_missing: canonical direct conversation was not found.');
  const workspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId') || canonicalConversation.account_workspace_id || 'workspace_personal';
  if (workspaceId !== (canonicalConversation.account_workspace_id || 'workspace_personal')) {
    throw new Error('conversation_alias_workspace_mismatch: conversation alias cannot cross Workspace boundaries.');
  }
  const canonicalSession = get(db, `SELECT * FROM sessions WHERE user_id=? AND account_workspace_id=?
    AND (id=? OR conversation_id=?) ORDER BY CASE WHEN conversation_role='primary' AND write_state='writable' THEN 0 ELSE 1 END,
    updated_at DESC,id DESC LIMIT 1`, [localUserId, workspaceId, canonicalConversationId, canonicalConversationId]);
  const aliasSessions = all(db, `SELECT * FROM sessions WHERE user_id=? AND account_workspace_id=?
    AND (id=? OR conversation_id=?) ORDER BY created_at,id`, [localUserId, workspaceId, aliasConversationId, aliasConversationId]);
  let rebuildRequired = false;
  for (const session of aliasSessions) {
    if (session.conversation_id !== canonicalConversationId || session.conversation_role !== 'history'
      || session.write_state !== 'read_only' || session.codex_thread_id) rebuildRequired = true;
    if (session.codex_thread_id) {
      run(db, `INSERT INTO agent_conversation_thread_lineage(
        id,user_id,account_workspace_id,agent_instance_id,conversation_id,source_session_id,codex_thread_id,lineage_role,reason
      ) VALUES(?,?,?,?,?,?,?,'merged','cloud_conversation_alias_v1')
      ON CONFLICT(conversation_id,codex_thread_id) DO UPDATE SET source_session_id=excluded.source_session_id,
        lineage_role='merged',reason=excluded.reason`, [
        `thread_lineage:${session.id}:${session.codex_thread_id}`, localUserId, workspaceId,
        canonicalSession?.agent_instance_id || session.agent_instance_id || canonicalConversation.agent_instance_id || '',
        canonicalConversationId, session.id, session.codex_thread_id,
      ]);
    }
    run(db, `UPDATE sessions SET conversation_id=?,conversation_role='history',write_state='read_only',
      superseded_by_session_id=?,codex_thread_id='',updated_at=MAX(updated_at,?) WHERE id=?`, [
      canonicalConversationId, canonicalSession?.id || '', nowIso(), session.id,
    ]);
  }
  run(db, `UPDATE messages SET conversation_id=? WHERE conversation_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, `UPDATE message_attachments SET conversation_id=? WHERE conversation_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, `UPDATE model_executions SET conversation_id=? WHERE conversation_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, `UPDATE cloud_file_refs SET session_id=? WHERE session_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, `UPDATE cloud_file_manifest SET session_id=? WHERE session_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, `UPDATE agent_conversation_timeline_refs SET source_conversation_id=? WHERE source_conversation_id=?`, [
    canonicalConversationId, aliasConversationId,
  ]);
  run(db, `UPDATE conversation_aliases SET conversation_id=? WHERE conversation_id=?`, [canonicalConversationId, aliasConversationId]);
  run(db, 'DELETE FROM conversation_aliases WHERE alias_id=conversation_id');
  run(db, `INSERT INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'agent_single_window','cloud_conversation_alias_v1') ON CONFLICT(alias_id) DO UPDATE SET
    conversation_id=excluded.conversation_id,alias_kind=excluded.alias_kind,reason=excluded.reason`, [
    aliasConversationId, canonicalConversationId,
  ]);
  run(db, `UPDATE conversations SET status='deleted',updated_at=MAX(updated_at,?) WHERE id=? AND id!=?`, [
    nowIso(), aliasConversationId, canonicalConversationId,
  ]);
  if (canonicalSession?.agent_instance_id) {
    run(db, `INSERT INTO agent_conversation_branch_state(
      user_id,account_workspace_id,agent_instance_id,conversation_id,primary_session_id,thread_generation,rebuild_required,updated_at
    ) VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(user_id,account_workspace_id,agent_instance_id) DO UPDATE SET
      conversation_id=excluded.conversation_id,primary_session_id=excluded.primary_session_id,
      thread_generation=agent_conversation_branch_state.thread_generation+?,
      rebuild_required=MAX(agent_conversation_branch_state.rebuild_required,excluded.rebuild_required),updated_at=excluded.updated_at`, [
      localUserId, workspaceId, canonicalSession.agent_instance_id, canonicalConversationId, canonicalSession.id,
      rebuildRequired ? 1 : 0, nowIso(), rebuildRequired ? 1 : 0,
    ]);
  }
}

function resolveLocalConversationAliasTarget(db, value = '', forbiddenAliasId = '') {
  let currentId = String(value || '').trim();
  const visited = new Set(forbiddenAliasId ? [String(forbiddenAliasId)] : []);
  for (let depth = 0; currentId && depth < 128; depth += 1) {
    const nextId = String(get(db, 'SELECT conversation_id FROM conversation_aliases WHERE alias_id=?', [currentId])?.conversation_id || '').trim();
    if (!nextId || nextId === currentId) return currentId;
    if (visited.has(currentId)) throw new Error('conversation_alias_cycle: conversation alias cycle detected.');
    visited.add(currentId);
    currentId = nextId;
  }
  if (currentId) throw new Error('conversation_alias_depth_exceeded: conversation alias chain is too deep.');
  return '';
}

function applyV6CoreChange(db, localUserId, change = {}) {
  const row = change.payload || {};
  const type = change.entityType;
  const id = change.entityId || row.id || '';
  if (!id) return;
  if (type === 'project') {
    const accountWorkspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
    run(db, `INSERT INTO projects(id,user_id,account_workspace_id,title,workspace_root,status,created_at,updated_at)
      VALUES(?,?,?,?,'',?,?,?) ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,
      title=excluded.title,status=excluded.status,updated_at=excluded.updated_at`, [id, localUserId, accountWorkspaceId, v6Field(row, 'title') || 'Untitled project',
      v6Field(row, 'status') || (change.operation === 'delete' ? 'deleted' : 'active'), v6Timestamp(row, 'created'), v6Timestamp(row, 'updated')]);
    return;
  }
  if (type === 'conversation_alias') {
    applyLocalConversationAlias(db, localUserId, row, id);
    return;
  }
  if (type === 'conversation') {
    const existingSession = get(db, `SELECT interaction_mode,goal_objective,goal_status,goal_tokens_used,goal_token_budget,
      goal_time_used_seconds FROM sessions WHERE id=?`, [id]);
    const agentInstanceId = canonicalLocalAgentInstanceId(db, v6Field(row, 'agent_instance_id', 'agentInstanceId'));
    let conversationRole = v6Field(row, 'conversation_role', 'conversationRole') || (agentInstanceId ? 'primary' : 'standard');
    let writeState = v6Field(row, 'write_state', 'writeState') || 'writable';
    let supersededBySessionId = v6Field(row, 'superseded_by_session_id', 'supersededBySessionId');
    const status = v6Field(row, 'status') || (change.operation === 'delete' ? 'deleted' : 'active');
    if (agentInstanceId && conversationRole === 'primary' && writeState === 'writable' && status !== 'deleted') {
      const accountWorkspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
      const existingPrimary = get(db, `SELECT id FROM sessions WHERE user_id=? AND account_workspace_id=? AND agent_instance_id=? AND id<>?
        AND conversation_role='primary' AND write_state='writable' AND status!='deleted' ORDER BY updated_at DESC,id DESC LIMIT 1`, [
        localUserId, accountWorkspaceId, agentInstanceId, id,
      ]);
      if (existingPrimary) {
        conversationRole = 'history';
        writeState = 'read_only';
        supersededBySessionId = existingPrimary.id;
      }
    }
    const accountWorkspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
    const interactionMode = hasV6Field(row, 'interaction_mode', 'interactionMode')
      ? normalizeV6InteractionMode(v6Field(row, 'interaction_mode', 'interactionMode'))
      : normalizeV6InteractionMode(existingSession?.interaction_mode || '');
    const goalObjective = hasV6Field(row, 'goal_objective', 'goalObjective')
      ? v6Field(row, 'goal_objective', 'goalObjective').slice(0, 4000)
      : String(existingSession?.goal_objective || '');
    const goalStatus = hasV6Field(row, 'goal_status', 'goalStatus')
      ? normalizeV6GoalStatus(v6Field(row, 'goal_status', 'goalStatus'))
      : normalizeV6GoalStatus(existingSession?.goal_status || '');
    const goalTokensUsed = hasV6Field(row, 'goal_tokens_used', 'goalTokensUsed')
      ? normalizeV6GoalMetric(row.goal_tokens_used ?? row.goalTokensUsed)
      : normalizeV6GoalMetric(existingSession?.goal_tokens_used);
    const goalTokenBudget = 0;
    const goalTimeUsedSeconds = hasV6Field(row, 'goal_time_used_seconds', 'goalTimeUsedSeconds')
      ? normalizeV6GoalMetric(row.goal_time_used_seconds ?? row.goalTimeUsedSeconds)
      : normalizeV6GoalMetric(existingSession?.goal_time_used_seconds);
    run(db, `INSERT INTO sessions(id,conversation_id,user_id,account_workspace_id,title,department_id,agent_id,agent_instance_id,project_id,codex_thread_id,
      interaction_mode,goal_objective,goal_status,goal_tokens_used,goal_token_budget,goal_time_used_seconds,
      conversation_role,write_state,superseded_by_session_id,status,pinned_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,
      account_workspace_id=excluded.account_workspace_id,title=excluded.title,department_id=excluded.department_id,
      agent_id=excluded.agent_id,agent_instance_id=excluded.agent_instance_id,project_id=excluded.project_id,
      codex_thread_id=CASE WHEN sessions.codex_thread_id='' THEN excluded.codex_thread_id ELSE sessions.codex_thread_id END,
      interaction_mode=excluded.interaction_mode,goal_objective=excluded.goal_objective,goal_status=excluded.goal_status,
      goal_tokens_used=excluded.goal_tokens_used,goal_token_budget=excluded.goal_token_budget,
      goal_time_used_seconds=excluded.goal_time_used_seconds,
      conversation_role=excluded.conversation_role,write_state=excluded.write_state,superseded_by_session_id=excluded.superseded_by_session_id,
      status=excluded.status,pinned_at=excluded.pinned_at,updated_at=excluded.updated_at`, [
      id, id, localUserId, accountWorkspaceId, v6Field(row, 'title') || 'Untitled', v6Field(row, 'department_id', 'departmentId'),
      v6Field(row, 'agent_id', 'agentId'), agentInstanceId,
      v6Field(row, 'project_id', 'projectId'), v6Field(row, 'codex_thread_id', 'codexThreadId'),
      interactionMode,goalObjective,goalStatus,goalTokensUsed,goalTokenBudget,goalTimeUsedSeconds,
      conversationRole,writeState,supersededBySessionId,
      status, v6Field(row, 'pinned_at', 'pinnedAt'),
      v6Timestamp(row, 'created'), v6Timestamp(row, 'updated'),
    ]);
    if (agentInstanceId && conversationRole === 'primary' && writeState === 'writable' && status !== 'deleted') {
      run(db, 'DELETE FROM conversation_aliases WHERE alias_id=?', [id]);
    }
    run(db, `INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,agent_id,agent_instance_id,
      project_id,status,created_at,updated_at) VALUES(?,?,'direct',?,?,?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,agent_id=excluded.agent_id,agent_instance_id=excluded.agent_instance_id,project_id=excluded.project_id,
      updated_at=excluded.updated_at`, [id, accountWorkspaceId, localUserId, v6Field(row, 'title') || 'Untitled',
      v6Field(row, 'agent_id', 'agentId'), agentInstanceId, v6Field(row, 'project_id', 'projectId'),
      v6Timestamp(row, 'created'), v6Timestamp(row, 'updated')]);
    return;
  }
  if (type === 'message') {
    const requestedConversationId = v6Field(row, 'conversation_id', 'conversationId');
    const conversationId = stableAgentConversationId(db, requestedConversationId);
    const session = conversationId ? get(db, `SELECT * FROM sessions WHERE id=? OR conversation_id=?
      ORDER BY CASE WHEN id=? THEN 0 WHEN conversation_role='primary' THEN 1 ELSE 2 END LIMIT 1`, [conversationId, conversationId, conversationId]) : null;
    const agentId = v6Field(row, 'agent_id', 'agentId') || session?.agent_id || '';
    const agentInstanceId = canonicalLocalAgentInstanceId(db,
      v6Field(row, 'agent_instance_id', 'agentInstanceId') || session?.agent_instance_id || '');
    const requestedContextSpaceId = v6Field(row, 'context_space_id', 'contextSpaceId');
    let contextSpaceId = requestedContextSpaceId && agentInstanceId
      && get(db, 'SELECT id FROM agent_context_spaces WHERE id=? AND user_agent_instance_id=?', [requestedContextSpaceId, agentInstanceId])
      ? requestedContextSpaceId : '';
    if (conversationId && conversationId !== requestedConversationId) {
      const requestedContext = contextSpaceId
        ? get(db, 'SELECT context_kind FROM agent_context_spaces WHERE id=?', [contextSpaceId])
        : null;
      if (!requestedContext || requestedContext.context_kind !== 'general_memory') {
        contextSpaceId = activeGeneralConversationContextSpaceId(db, localUserId, agentInstanceId);
      }
    }
    const requestedMemoryId = v6Field(row, 'memory_id', 'memoryId');
    const memoryId = canonicalLocalMemoryDocumentId(db, requestedMemoryId) || (contextSpaceId
      ? get(db, 'SELECT memory_document_id FROM agent_context_spaces WHERE id=?', [contextSpaceId])?.memory_document_id || '' : '');
    run(db, `INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,memory_id,task_workspace_id,
      sender_user_id,source_event_id,source_message_id,task_run_id,task_node_id,role,content,agent_id,agent_instance_id,
      department_id,context_space_id,visible,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,conversation_id=excluded.conversation_id,
      session_id=excluded.session_id,memory_id=excluded.memory_id,task_workspace_id=excluded.task_workspace_id,
      sender_user_id=excluded.sender_user_id,source_event_id=excluded.source_event_id,source_message_id=excluded.source_message_id,
      task_run_id=excluded.task_run_id,
      task_node_id=excluded.task_node_id,role=excluded.role,content=excluded.content,agent_id=excluded.agent_id,
      agent_instance_id=excluded.agent_instance_id,department_id=excluded.department_id,
      context_space_id=excluded.context_space_id,visible=excluded.visible,metadata_json=excluded.metadata_json`, [
      id, session?.account_workspace_id || 'workspace_personal', conversationId,
      session?.id || v6Field(row, 'legacy_session_id', 'legacySessionId') || conversationId,
      memoryId, v6Field(row, 'task_workspace_id', 'taskWorkspaceId'),
      v6Field(row, 'sender_user_id', 'senderUserId') || localUserId,
      v6Field(row, 'source_event_id', 'sourceEventId'), v6Field(row, 'source_message_id', 'sourceMessageId'),
      v6Field(row, 'task_run_id', 'taskRunId'),
      v6Field(row, 'task_node_id', 'taskNodeId'), v6Field(row, 'role') || 'assistant', String(row.content || ''),
      agentId, agentInstanceId,
      v6Field(row, 'department_id', 'departmentId'),contextSpaceId,row.visible === false || row.visible === 0 ? 0 : 1,
      JSON.stringify(row.metadata || row.metadata_json || {}), v6Timestamp(row, 'created'),
    ]);
    return;
  }
  if (type === 'model_execution') {
    const conversationId = stableAgentConversationId(db, v6Field(row, 'conversation_id', 'conversationId'));
    const accountWorkspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId') || 'workspace_personal';
    run(db, `INSERT INTO model_executions(id,user_id,account_workspace_id,project_id,conversation_id,request_message_id,response_message_id,
      task_run_id,task_node_id,department_id,agent_id,agent_instance_id,agent_version_id,personal_skill_version_id,
      execution_kind,provider_id,requested_model,effective_model,reasoning_effort,status,error_text,metadata_json,
      started_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,account_workspace_id=excluded.account_workspace_id,project_id=excluded.project_id,
      conversation_id=excluded.conversation_id,request_message_id=excluded.request_message_id,
      response_message_id=excluded.response_message_id,task_run_id=excluded.task_run_id,
      task_node_id=excluded.task_node_id,department_id=excluded.department_id,agent_id=excluded.agent_id,
      agent_instance_id=excluded.agent_instance_id,agent_version_id=excluded.agent_version_id,
      personal_skill_version_id=excluded.personal_skill_version_id,execution_kind=excluded.execution_kind,
      provider_id=excluded.provider_id,requested_model=excluded.requested_model,effective_model=excluded.effective_model,
      reasoning_effort=excluded.reasoning_effort,status=excluded.status,error_text=excluded.error_text,
      metadata_json=excluded.metadata_json,started_at=excluded.started_at,
      completed_at=excluded.completed_at,updated_at=excluded.updated_at
      WHERE excluded.updated_at>model_executions.updated_at
        OR (excluded.updated_at=model_executions.updated_at
          AND excluded.conversation_id!=model_executions.conversation_id)`, [
      id, localUserId, accountWorkspaceId, v6Field(row, 'project_id', 'projectId'), conversationId,
      v6Field(row, 'request_message_id', 'requestMessageId'), v6Field(row, 'response_message_id', 'responseMessageId'),
      v6Field(row, 'task_run_id', 'taskRunId'), v6Field(row, 'task_node_id', 'taskNodeId'),
      v6Field(row, 'department_id', 'departmentId'), v6Field(row, 'agent_id', 'agentId'),
      canonicalLocalAgentInstanceId(db, v6Field(row, 'agent_instance_id', 'agentInstanceId')),
      v6Field(row, 'agent_version_id', 'agentVersionId'), v6Field(row, 'personal_skill_version_id', 'personalSkillVersionId'),
      v6Field(row, 'execution_kind', 'executionKind') || 'chat', v6Field(row, 'provider_id', 'providerId'),
      v6Field(row, 'requested_model', 'requestedModel'), v6Field(row, 'effective_model', 'effectiveModel'),
      v6Field(row, 'reasoning_effort', 'reasoningEffort'), v6Field(row, 'status') || 'completed',
      v6Field(row, 'error_text', 'errorText'), JSON.stringify(row.metadata || row.metadata_json || {}),
      v6Field(row, 'started_at', 'startedAt') || v6Timestamp(row, 'created'), v6Field(row, 'completed_at', 'completedAt'),
      v6Timestamp(row, 'updated'),
    ]);
    return;
  }
  if (type === 'file_ref') {
    if (change.operation === 'delete') {
      run(db, 'DELETE FROM cloud_file_refs WHERE id=?', [id]);
      return;
    }
    const conversationId = stableAgentConversationId(db, v6Field(row, 'conversation_id', 'conversationId'));
    run(db, `INSERT INTO cloud_file_refs(id,local_path,sha256,user_id,project_id,session_id,message_id,task_run_id,
      task_node_id,relation_type,source_kind,original_name,content_type,size_bytes,created_at,updated_at)
      VALUES(?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,
      project_id=excluded.project_id,session_id=excluded.session_id,message_id=excluded.message_id,
      task_run_id=excluded.task_run_id,task_node_id=excluded.task_node_id,updated_at=excluded.updated_at`, [
      id, v6Field(row, 'sha256'), localUserId, v6Field(row, 'project_id', 'projectId'),
      conversationId, v6Field(row, 'message_id', 'messageId'),
      v6Field(row, 'task_run_id', 'taskRunId'), v6Field(row, 'task_node_id', 'taskNodeId'),
      v6Field(row, 'relation_type', 'relationType') || 'intermediate', v6Field(row, 'source_kind', 'sourceKind'),
      v6Field(row, 'original_name', 'originalName'), v6Field(row, 'content_type', 'contentType'),
      Number(row.size_bytes ?? row.sizeBytes ?? 0), v6Timestamp(row, 'created'), v6Timestamp(row, 'updated'),
    ]);
    return;
  }
  if (type === 'task_run') {
    const accountWorkspaceId = v6Field(row, 'account_workspace_id', 'accountWorkspaceId')
      || v6Field(row, 'workspace_id', 'workspaceId') || 'workspace_personal';
    run(db, `INSERT INTO task_runs(id,account_workspace_id,owner_user_id,title,prompt,department_id,lead_agent_id,lead_agent_instance_id,
      status,summary,metadata_json,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary=excluded.summary,metadata_json=excluded.metadata_json,
      updated_at=excluded.updated_at,completed_at=excluded.completed_at
      WHERE excluded.updated_at>task_runs.updated_at`, [
      id, accountWorkspaceId, localUserId, v6Field(row, 'title') || 'Cloud task', v6Field(row, 'prompt'),
      v6Field(row, 'department_id', 'departmentId'), v6Field(row, 'lead_agent_id', 'leadAgentId'),
      canonicalLocalAgentInstanceId(db, v6Field(row, 'lead_agent_instance_id', 'leadAgentInstanceId')),
      v6Field(row, 'status') || 'pending', v6Field(row, 'summary'), JSON.stringify(row.metadata || row.metadata_json || {}),
      v6Timestamp(row, 'created'), v6Timestamp(row, 'updated'), v6Field(row, 'completed_at', 'completedAt'),
    ]);
    return;
  }
  if (type === 'task_node') {
    run(db, `INSERT INTO task_nodes(id,task_run_id,title,objective,department_id,agent_id,agent_instance_id,status,
      result_text,result_summary,error_text,created_at,updated_at,started_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET agent_instance_id=excluded.agent_instance_id,
      status=excluded.status,result_text=excluded.result_text,result_summary=excluded.result_summary,error_text=excluded.error_text,
      updated_at=excluded.updated_at,started_at=excluded.started_at,completed_at=excluded.completed_at
      WHERE excluded.updated_at>task_nodes.updated_at`, [
      id, v6Field(row, 'task_run_id', 'taskRunId'), v6Field(row, 'title') || 'Task node', v6Field(row, 'objective'),
      v6Field(row, 'department_id', 'departmentId'), v6Field(row, 'agent_id', 'agentId'),
      canonicalLocalAgentInstanceId(db, v6Field(row, 'agent_instance_id', 'agentInstanceId')),
      v6Field(row, 'status') || 'pending', v6Field(row, 'result_text', 'resultText'),
      v6Field(row, 'result_summary', 'resultSummary'), v6Field(row, 'error_text', 'errorText'),
      v6Timestamp(row, 'created'), v6Timestamp(row, 'updated'), v6Field(row, 'started_at', 'startedAt'),
      v6Field(row, 'completed_at', 'completedAt'),
    ]);
    return;
  }
  if (type === 'task_event') {
    run(db, `INSERT INTO task_events(id,task_run_id,task_node_id,event_type,actor_id,privacy_level,summary,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        event_type=excluded.event_type,actor_id=excluded.actor_id,privacy_level=excluded.privacy_level,
        summary=excluded.summary,payload_json=excluded.payload_json,updated_at=excluded.updated_at
      WHERE excluded.updated_at>task_events.updated_at`, [
      id, v6Field(row, 'task_run_id', 'taskRunId'), v6Field(row, 'task_node_id', 'taskNodeId'),
      v6Field(row, 'event_type', 'eventType'), v6Field(row, 'actor_id', 'actorId'),
      v6Field(row, 'privacy_level', 'privacyLevel') || 'owner_private', v6Field(row, 'summary'),
      JSON.stringify(row.payload || {}), row.created_at || row.createdAt || nowIso(), row.updated_at || row.updatedAt || row.created_at || row.createdAt || nowIso(),
    ]);
    return;
  }
  if (type === 'communication') {
    run(db, `INSERT OR IGNORE INTO communications(id,task_run_id,from_agent_id,to_agent_id,purpose,requested_info,
      priority,blocking,expected_format,context_summary,references_json,response_text,status,created_at,resolved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      id, v6Field(row, 'task_run_id', 'taskRunId'), v6Field(row, 'from_agent_id', 'fromAgentId'),
      v6Field(row, 'to_agent_id', 'toAgentId'), v6Field(row, 'purpose'), v6Field(row, 'requested_info', 'requestedInfo'),
      v6Field(row, 'priority') || 'normal', row.blocking ? 1 : 0, v6Field(row, 'expected_format', 'expectedFormat'),
      v6Field(row, 'context_summary', 'contextSummary'), JSON.stringify(row.references || row.references_json || []),
      v6Field(row, 'response_text', 'responseText'), v6Field(row, 'status') || 'open', v6Timestamp(row, 'created'),
      v6Field(row, 'resolved_at', 'resolvedAt'),
    ]);
  }
}

function hasV6Field(row, snake, camel = '') {
  return Boolean(row && (Object.prototype.hasOwnProperty.call(row, snake)
    || (camel && Object.prototype.hasOwnProperty.call(row, camel))));
}

function normalizeV6InteractionMode(value = '') {
  const mode = String(value || '').trim();
  return mode === 'goal' ? mode : '';
}

function normalizeV6GoalStatus(value = '') {
  const status = String(value || '').trim();
  return ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(status) ? status : '';
}

function normalizeV6GoalMetric(value = 0) {
  return Math.max(0, Math.floor(Number(value || 0) || 0));
}

function v6Field(row, snake, camel = '') { return String(row?.[snake] ?? (camel ? row?.[camel] : '') ?? '').trim(); }
function v6Timestamp(row, kind) {
  return v6Field(row, `${kind}_at`, `${kind}At`) || v6Field(row, 'updated_at', 'updatedAt')
    || v6Field(row, 'created_at', 'createdAt') || nowIso();
}

function upsertLocalAgentFamily(db, row = {}) {
  if (!row.id) return;
  if (LEGACY_PPT_AGENT_ID_SET.has(row.id) || isLegacyGeneralAgentId(row.id)) row = {
    ...row,
    ...(isLegacyGeneralAgentId(row.id) ? { name: 'Generalist' } : {}),
    status: 'retired',
    routable: false,
    instance_kind: 'unavailable',
    instanceKind: 'unavailable',
    recruitable: false,
    default_for_new_user: false,
    defaultForNewUser: false,
    quota_cost: 0,
    quotaCost: 0,
  };
  const familyName = canonicalAgentFamilyName(row.id, row.name || row.id);
  run(db, `INSERT INTO agent_families (
    id, department_id, name, role, status, routable, current_version_id,
    instance_kind,recruitable,default_for_new_user,quota_cost,classification_version,
    metadata_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET department_id = excluded.department_id, name = excluded.name,
    role = excluded.role, status = excluded.status, routable = excluded.routable,
    current_version_id = excluded.current_version_id,instance_kind=excluded.instance_kind,recruitable=excluded.recruitable,
    default_for_new_user=excluded.default_for_new_user,quota_cost=excluded.quota_cost,
    classification_version=excluded.classification_version,metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`, [
    row.id, row.department_id || row.departmentId || '', familyName, row.role || 'agent', row.status || 'active',
    row.routable ? 1 : 0, row.current_version_id || row.currentVersionId || '',
    row.instance_kind || row.instanceKind || 'unavailable', row.recruitable || row.recruitable === 1 ? 1 : 0,
    row.default_for_new_user || row.defaultForNewUser ? 1 : 0, Number(row.quota_cost ?? row.quotaCost ?? 0),
    row.classification_version || row.classificationVersion || EMPLOYEE_CLOUD_POLICY_VERSION,
    row.metadata_json || JSON.stringify(row.metadata || {}),
    row.created_at || row.createdAt || nowIso(), row.updated_at || row.updatedAt || nowIso(),
  ]);
}

function cloudPersonalEvolutionProposalPayload(db, row = {}) {
  const evidenceRefs = all(db, `SELECT id, source_kind, source_id, source_hash, occurred_at,
    context_key, privacy_level, included, rejection_reason, created_at
    FROM personal_evolution_proposal_evidence WHERE proposal_id = ? ORDER BY occurred_at, id`, [row.id]).map((item) => ({
    id: item.id, sourceKind: item.source_kind, sourceId: item.source_id, sourceHash: item.source_hash,
    occurredAt: item.occurred_at, contextKey: item.context_key, privacyLevel: item.privacy_level,
    included: Boolean(item.included), rejectionReason: item.rejection_reason, createdAt: item.created_at,
  }));
  return sanitizeCloudValue({ ...row, evidenceRefs });
}

function upsertLocalPersonalEvolutionProposal(db, store, localUserId, row = {}) {
  const rawInstanceId = row.user_agent_instance_id || row.agentInstanceId || '';
  const instanceId = canonicalLocalAgentInstanceId(db, rawInstanceId);
  if (!row.id || !instanceId) return;
  const instance = store.getUserAgentInstance(instanceId);
  if (!instance || instance.userId !== localUserId) return;
  let proposal = store.getPersonalEvolutionProposal(row.id);
  if (!proposal) {
    proposal = store.createPersonalEvolutionProposal({
      id: row.id, runId: row.run_id || row.runId || `cloud_${row.id}`, userId: localUserId,
      agentInstanceId: instanceId, agentFamilyId: canonicalEmployeeAgentFamilyId(row.agent_family_id || row.agentFamilyId || instance.agentFamilyId),
      status: row.status || 'ready', syncScope: 'cloud', originDeviceId: row.origin_device_id || row.originDeviceId || '',
      baseAgentVersionId: row.base_agent_version_id || row.baseAgentVersionId || '',
      basePersonalSkillVersionId: row.base_personal_skill_version_id || row.basePersonalSkillVersionId || '',
      baseEffectiveSkillHash: row.base_effective_skill_hash || row.baseEffectiveSkillHash || '',
      baseMemoryManifestHash: row.base_memory_manifest_hash || row.baseMemoryManifestHash || '',
      evidenceCursorFrom: safeJsonParse(row.evidence_cursor_from, row.evidenceCursorFrom || {}),
      evidenceCursorTo: safeJsonParse(row.evidence_cursor_to, row.evidenceCursorTo || {}),
      evidenceCount: row.evidence_count ?? row.evidenceCount ?? 0,
      distinctContextCount: row.distinct_context_count ?? row.distinctContextCount ?? 0,
    });
  }
  store.updatePersonalEvolutionProposal(row.id, {
    status: row.status || proposal.status, decision: row.decision || proposal.decision,
    skillActionStatus: row.skill_action_status || row.skillActionStatus || proposal.skillActionStatus,
    memoryActionStatus: row.memory_action_status || row.memoryActionStatus || proposal.memoryActionStatus,
    candidatePersonalSkillVersionId: row.candidate_personal_skill_version_id || row.candidatePersonalSkillVersionId || '',
    evidenceCursorTo: safeJsonParse(row.evidence_cursor_to, row.evidenceCursorTo || {}),
    evidenceCount: row.evidence_count ?? row.evidenceCount ?? 0,
    distinctContextCount: row.distinct_context_count ?? row.distinctContextCount ?? 0,
    proposalMarkdown: row.proposal_markdown || row.proposalMarkdown || '', proposalHash: row.proposal_hash || row.proposalHash || '',
    summary: row.summary || '', proposedOverlayText: row.proposed_overlay_text || row.proposedOverlayText || '',
    proposedOverlayHash: row.proposed_overlay_hash || row.proposedOverlayHash || '',
    diagnostics: safeJsonParse(row.diagnostics_json, row.diagnostics || {}), gate: safeJsonParse(row.gate_json, row.gate || {}),
    privacyReport: safeJsonParse(row.privacy_report_json, row.privacyReport || {}),
    evaluationSummary: safeJsonParse(row.evaluation_summary_json, row.evaluationSummary || {}),
    autoActivationEligible: Boolean(row.auto_activation_eligible ?? row.autoActivationEligible),
    expiresReason: row.expires_reason || row.expiresReason || '', expiresAt: row.expires_at || row.expiresAt || '',
    decidedAt: row.decided_at || row.decidedAt || '',
  });
}

function upsertLocalPersonalEvolutionOperation(db, store, row = {}) {
  const proposalId = row.proposal_id || row.proposalId || '';
  const documentId = canonicalLocalMemoryDocumentId(db, row.memory_document_id || row.memoryDocumentId || '');
  if (!row.id || !proposalId || !documentId || !store.getPersonalEvolutionProposal(proposalId)) return;
  const existing = get(db, 'SELECT id FROM personal_evolution_memory_operations WHERE id = ?', [row.id]);
  if (!existing) {
    store.addPersonalEvolutionMemoryOperations(proposalId, [{
      id: row.id, memoryDocumentId: documentId, sectionName: row.section_name || row.sectionName,
      operationType: row.operation_type || row.operationType, targetItemHash: row.target_item_hash || row.targetItemHash || '',
      proposedText: row.proposed_text || row.proposedText || '', rationale: row.rationale || '',
      baselineVersionId: row.baseline_version_id || row.baselineVersionId || '',
      baselineContentHash: row.baseline_content_hash || row.baselineContentHash || '', status: row.status || 'pending',
    }]);
  } else {
    run(db, 'UPDATE personal_evolution_memory_operations SET status = ?, updated_at = ? WHERE id = ?', [row.status || 'pending', row.updated_at || row.updatedAt || nowIso(), row.id]);
  }
}

function recomputePersonalProposalState(store, proposalId) {
  const proposal = store.getPersonalEvolutionProposal(proposalId);
  if (!proposal) return null;
  const skillTerminal = ['activated', 'rejected', 'none'].includes(proposal.skillActionStatus);
  const memoryTerminal = proposal.memoryOperations.every((item) => ['applied', 'rejected'].includes(item.status));
  if (!skillTerminal || !memoryTerminal) return store.updatePersonalEvolutionProposal(proposalId, { status: 'partially_applied' });
  const accepted = proposal.skillActionStatus === 'activated' || proposal.memoryOperations.some((item) => item.status === 'applied');
  const rejected = proposal.skillActionStatus === 'rejected' || proposal.memoryOperations.some((item) => item.status === 'rejected');
  return store.updatePersonalEvolutionProposal(proposalId, {
    status: accepted && rejected ? 'partially_applied' : accepted ? 'applied' : 'rejected',
    decision: accepted && rejected ? 'partial' : accepted ? 'accepted' : 'rejected', decidedAt: nowIso(),
    memoryActionStatus: proposal.memoryOperations.some((item) => item.status === 'applied') ? 'applied' : proposal.memoryOperations.length ? 'rejected' : 'none',
  });
}

function upsertLocalAgentVersion(db, row = {}) {
  const familyId = canonicalEmployeeAgentFamilyId(row.agent_family_id || row.agentFamilyId || '');
  if (!row.id || !familyId) return;
  run(db, `INSERT INTO agent_versions (
    id, agent_family_id, version_label, agent_config_json, base_skill_content, base_skill_hash,
    memory_template_content, memory_template_hash, source_bundle_id, content_hash, status, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO NOTHING`, [
    row.id, familyId, row.version_label || row.versionLabel || '', row.agent_config_json || JSON.stringify(row.agentConfig || {}),
    row.base_skill_content || row.baseSkillContent || '', row.base_skill_hash || row.baseSkillHash || '',
    row.memory_template_content || row.memoryTemplateContent || '', row.memory_template_hash || row.memoryTemplateHash || '',
    row.source_bundle_id || row.sourceBundleId || '', row.content_hash || row.contentHash || '', row.status || 'active',
    row.created_at || row.createdAt || nowIso(),
  ]);
}

function stableAgentConversationId(db, conversationId = '') {
  const cleanId = String(conversationId || '').trim();
  if (!cleanId) return '';
  const aliasedConversationId = resolveLocalConversationAliasTarget(db, cleanId);
  if (aliasedConversationId !== cleanId) return aliasedConversationId;
  const session = get(db, `SELECT id,conversation_role,write_state,superseded_by_session_id
    FROM sessions WHERE id=?`, [cleanId]);
  if (session?.conversation_role !== 'history' || session?.write_state !== 'read_only' || !session?.superseded_by_session_id) {
    return cleanId;
  }
  const primary = get(db, `SELECT id FROM sessions WHERE id=? AND conversation_role='primary'
    AND write_state='writable' AND status!='deleted'`, [session.superseded_by_session_id]);
  return primary?.id || cleanId;
}

function activeGeneralConversationContextSpaceId(db, userId = '', agentInstanceId = '') {
  if (!userId || !agentInstanceId) return '';
  return get(db, `SELECT c.id FROM agent_context_state state
    JOIN agent_context_spaces c ON c.user_id=state.user_id
      AND c.user_agent_instance_id=state.user_agent_instance_id
      AND c.context_kind='general_memory' AND c.memory_document_id=state.active_memory_document_id
    WHERE state.user_id=? AND state.account_workspace_id='workspace_personal'
      AND c.account_workspace_id=state.account_workspace_id AND state.user_agent_instance_id=? LIMIT 1`, [userId, agentInstanceId])?.id || '';
}

function resolveLocalImportedAgentSequence(db, {
  userId = '', familyId = '', instanceId = '', requestedSequence = 0,
} = {}) {
  const requested = Math.max(0, Math.floor(Number(requestedSequence) || 0));
  const existing = get(db, `SELECT family_instance_seq FROM user_agent_instances
    WHERE id=? AND user_id=?`, [instanceId, userId]);
  if (requested > 0) {
    const conflict = get(db, `SELECT 1 FROM user_agent_instances
      WHERE user_id=? AND agent_family_id=? AND family_instance_seq=? AND id<>? LIMIT 1`, [
      userId, familyId, requested, instanceId,
    ]);
    if (!conflict) return requested;
  }
  if (Number(existing?.family_instance_seq || 0) > 0) return Number(existing.family_instance_seq);
  return Number(get(db, `SELECT COALESCE(MAX(family_instance_seq),0)+1 AS sequence
    FROM user_agent_instances WHERE user_id=? AND agent_family_id=?`, [userId, familyId])?.sequence || 1);
}

function compactLocalAgentInstanceProfiles(db, userId = '') {
  if (!userId) return 0;
  const rows = all(db, `SELECT i.id,i.user_id,i.agent_family_id,i.family_instance_seq,i.display_name,
      i.recruited_at,i.created_at,COALESCE(f.name,i.agent_family_id,'Agent') AS family_name,
      EXISTS(SELECT 1 FROM user_agent_instance_aliases alias WHERE alias.alias_instance_id=i.id) AS is_alias
    FROM user_agent_instances i LEFT JOIN agent_families f ON f.id=i.agent_family_id
    WHERE i.user_id=? AND i.instance_kind='employee'
    ORDER BY i.agent_family_id,i.recruited_at,i.created_at,i.id`, [userId]);
  const compacted = compactAgentInstanceProfiles(rows.map((row) => ({
    id: row.id, userId: row.user_id, agentFamilyId: row.agent_family_id,
    familyInstanceSeq: row.family_instance_seq, displayName: row.display_name,
    familyName: row.family_name, recruitedAt: row.recruited_at, createdAt: row.created_at,
    isAlias: Boolean(row.is_alias),
  })));
  const changed = compacted.filter((profile) => profile.profileChanged);
  for (let index = 0; index < changed.length; index += 1) {
    const profile = changed[index];
    run(db, 'UPDATE user_agent_instances SET family_instance_seq=? WHERE id=? AND user_id=?', [
      profile.familyInstanceSeq > 0 ? -(index + 1) : 0, profile.id, userId,
    ]);
  }
  for (const profile of changed) {
    run(db, `UPDATE user_agent_instances SET family_instance_seq=?,display_name=?,updated_at=?
      WHERE id=? AND user_id=?`, [profile.familyInstanceSeq, profile.displayName, nowIso(), profile.id, userId]);
  }
  return changed.length;
}

function canonicalLocalAgentInstanceId(db, instanceId = '') {
  let currentId = String(instanceId || '').trim();
  if (!currentId) return '';
  const visited = new Set();
  while (currentId) {
    if (visited.has(currentId)) throw new Error('Agent instance alias cycle detected.');
    visited.add(currentId);
    const nextId = String(get(db, `SELECT canonical_instance_id FROM user_agent_instance_aliases
      WHERE alias_instance_id=?`, [currentId])?.canonical_instance_id || '').trim();
    if (!nextId || nextId === currentId) return currentId;
    currentId = nextId;
  }
  return '';
}

function normalizeIncomingAgentInstanceAliases(db, userId = '', incoming = []) {
  const edges = new Map(all(db, `SELECT alias_instance_id,canonical_instance_id,user_id,reason,created_at
    FROM user_agent_instance_aliases WHERE user_id=?`, [userId]).map((row) => [String(row.alias_instance_id || ''), { ...row }]));
  for (const row of incoming || []) {
    const aliasId = String(row.alias_instance_id || row.aliasInstanceId || '').trim();
    const canonicalId = String(row.canonical_instance_id || row.canonicalInstanceId || '').trim();
    if (!aliasId || !canonicalId || aliasId === canonicalId) continue;
    edges.set(aliasId, { ...row, alias_instance_id: aliasId, canonical_instance_id: canonicalId, user_id: userId });
  }
  const instances = new Map(all(db, `SELECT id,user_id,agent_family_id,employment_state,authority_state,state_revision,created_at
    FROM user_agent_instances WHERE user_id=?`, [userId]).map((row) => [String(row.id || ''), row]));
  const canonicalIds = new Set();
  const resolved = new Map();
  const resolve = (startId) => {
    if (resolved.has(startId)) return resolved.get(startId);
    const order = [];
    const positions = new Map();
    let current = startId;
    while (edges.has(current)) {
      if (positions.has(current)) {
        const cycle = order.slice(positions.get(current));
        const candidates = cycle.map((id) => instances.get(id)).filter(Boolean);
        if (!candidates.length) throw new Error('Agent instance alias cycle has no local canonical instance.');
        const users = new Set(candidates.map((item) => item.user_id));
        const families = new Set(candidates.map((item) => item.agent_family_id));
        if (users.size !== 1 || families.size !== 1 || !users.has(userId)) {
          throw new Error('Agent instance alias cycle crosses user or Agent family boundaries.');
        }
        candidates.sort((left, right) => Number(right.authority_state === 'cloud_confirmed') - Number(left.authority_state === 'cloud_confirmed')
          || Number(right.employment_state === 'active') - Number(left.employment_state === 'active')
          || Number(right.state_revision || 0) - Number(left.state_revision || 0)
          || String(left.created_at || '').localeCompare(String(right.created_at || ''))
          || String(left.id || '').localeCompare(String(right.id || '')));
        current = String(candidates[0].id || '');
        canonicalIds.add(current);
        for (const id of cycle) resolved.set(id, current);
        break;
      }
      positions.set(current, order.length);
      order.push(current);
      const next = String(edges.get(current)?.canonical_instance_id || '').trim();
      if (!next || next === current) break;
      current = next;
    }
    const terminal = resolved.get(current) || current;
    if (!instances.has(terminal)) throw new Error('Agent instance alias target is missing.');
    for (const id of order) resolved.set(id, terminal);
    return terminal;
  };
  for (const aliasId of edges.keys()) resolve(aliasId);
  const rows = [];
  for (const [aliasId, canonicalId] of resolved) {
    if (!aliasId || !canonicalId || aliasId === canonicalId) {
      if (aliasId === canonicalId) canonicalIds.add(aliasId);
      continue;
    }
    const source = edges.get(aliasId) || {};
    rows.push({ ...source, alias_instance_id: aliasId, canonical_instance_id: canonicalId, user_id: userId });
  }
  rows.sort((left, right) => String(left.alias_instance_id).localeCompare(String(right.alias_instance_id)));
  return { rows, canonicalIds: [...canonicalIds] };
}

function v6PayloadBelongsToAnotherLocalUser(db, localUserId, payload = {}) {
  const payloadUserId = v6Field(payload, 'user_id', 'userId') || v6Field(payload, 'owner_user_id', 'ownerUserId');
  if (payloadUserId && payloadUserId !== localUserId && get(db, 'SELECT id FROM auth_users WHERE id=?', [payloadUserId])) return true;
  const rawInstanceId = v6Field(payload, 'agent_instance_id', 'agentInstanceId')
    || v6Field(payload, 'lead_agent_instance_id', 'leadAgentInstanceId')
    || v6Field(payload, 'user_agent_instance_id', 'userAgentInstanceId');
  if (rawInstanceId) {
    const instanceId = canonicalLocalAgentInstanceId(db, rawInstanceId);
    const instance = get(db, 'SELECT user_id FROM user_agent_instances WHERE id=?', [instanceId]);
    if (instance && instance.user_id !== localUserId) return true;
  }
  const taskRunId = v6Field(payload, 'task_run_id', 'taskRunId');
  if (taskRunId) {
    const task = get(db, 'SELECT owner_user_id FROM task_runs WHERE id=?', [taskRunId]);
    if (task && task.owner_user_id !== localUserId) return true;
  }
  return false;
}

function canonicalLocalMemoryDocumentId(db, documentId = '') {
  let candidate = String(documentId || '').trim();
  const visited = new Set();
  while (candidate && !visited.has(candidate) && visited.size < 32) {
    visited.add(candidate);
    const direct = get(db, `SELECT id FROM memory_documents WHERE id=? OR cloud_key=?
      ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [candidate, candidate, candidate]);
    if (direct?.id) return direct.id;
    const mapped = get(db, `SELECT m.memory_document_id FROM memory_sync_mappings m
      JOIN memory_documents d ON d.id=m.memory_document_id
      WHERE m.cloud_key=? AND m.status='active' ORDER BY m.updated_at DESC LIMIT 1`, [candidate]);
    if (mapped?.memory_document_id) return mapped.memory_document_id;
    const alias = get(db, 'SELECT canonical_document_id FROM memory_document_aliases WHERE alias_document_id=?', [candidate])?.canonical_document_id || '';
    if (!alias || alias === candidate) return '';
    candidate = alias;
  }
  return '';
}

function upsertLocalSkillVersion(db, row = {}) {
  const instanceId = canonicalLocalAgentInstanceId(db, row.user_agent_instance_id || row.userAgentInstanceId || '');
  if (!row.id || !instanceId) return;
  run(db, `INSERT INTO user_agent_skill_versions (
    id, user_agent_instance_id, base_agent_version_id, parent_version_id, overlay_text,
    effective_skill_content, effective_skill_hash, compiler_version, authority, status,
    source_evolution_run_id, activated_at, archived_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET user_agent_instance_id = excluded.user_agent_instance_id,
    base_agent_version_id = excluded.base_agent_version_id, parent_version_id = excluded.parent_version_id,
    overlay_text = excluded.overlay_text, effective_skill_content = excluded.effective_skill_content,
    effective_skill_hash = excluded.effective_skill_hash, compiler_version = excluded.compiler_version,
    authority = excluded.authority,
    status = excluded.status, source_evolution_run_id = excluded.source_evolution_run_id,
    activated_at = excluded.activated_at, archived_at = excluded.archived_at, updated_at = excluded.updated_at`, [
    row.id, instanceId, row.base_agent_version_id || row.baseAgentVersionId || '', row.parent_version_id || row.parentVersionId || '',
    row.overlay_text || row.overlayText || '', row.effective_skill_content || row.effectiveSkillContent || '',
    row.effective_skill_hash || row.effectiveSkillHash || '', row.compiler_version || row.compilerVersion || 'overlay_concat_v1',
    row.authority || 'cloud', row.status || 'candidate', row.source_evolution_run_id || row.sourceEvolutionRunId || '', row.activated_at || row.activatedAt || '',
    row.archived_at || row.archivedAt || '', row.created_at || row.createdAt || nowIso(), row.updated_at || row.updatedAt || row.created_at || row.createdAt || nowIso(),
  ]);
}

function upsertLocalMemoryDocument(db, store, userId, row = {}) {
  const instanceId = canonicalLocalAgentInstanceId(db, row.user_agent_instance_id || row.userAgentInstanceId || '');
  if (!row.id || !instanceId) return;
  const cloudKey = row.cloud_key || row.cloudKey || row.id;
  const scope = row.scope || 'general';
  const slotNo = Number(row.slot_no ?? row.slotNo ?? 0);
  const mapped = get(db, `SELECT memory_document_id FROM memory_sync_mappings WHERE owner_user_id=? AND user_agent_instance_id=? AND cloud_key=?`, [userId, instanceId, cloudKey]);
  const existing = mapped || get(db, 'SELECT id AS memory_document_id FROM memory_documents WHERE user_id=? AND user_agent_instance_id=? AND cloud_key=?', [userId, instanceId, cloudKey])
    || get(db, `SELECT id AS memory_document_id FROM memory_documents WHERE user_agent_instance_id = ? AND scope = ? AND slot_no = ?
    AND task_run_id = ? AND project_id = ? AND relationship_id = ?`, [
    instanceId, scope, slotNo, row.task_run_id || row.taskRunId || '', row.project_id || row.projectId || '', row.relationship_id || row.relationshipId || '',
  ]);
  const localDocumentId = existing?.memory_document_id || newId('memdoc');
  const incomingLifecycle = row.lifecycle_state || row.lifecycleState || 'active';
  if (scope === 'general' && incomingLifecycle === 'active') {
    run(db, `UPDATE memory_documents SET lifecycle_state='inactive'
      WHERE user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state='active' AND id<>?`, [
      userId, instanceId, localDocumentId,
    ]);
  }
  const incomingContextSpaceId = scope === 'general' ? '' : row.context_space_id || row.contextSpaceId || '';
  run(db, `INSERT INTO memory_documents (
    id,user_id,user_agent_instance_id,agent_family_id,cloud_key,scope,slot_no,display_name,task_run_id,
    project_id,relationship_id,delegation_id,group_id,relationship_user_id,context_space_id,work_scope_id,lifecycle_state,visibility,
    sync_enabled,allow_personal_evolution,allow_cluster_evolution,source_conversation_cursor,
    encryption_key_id,consent_scope_json,current_version_id,content_hash,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, user_agent_instance_id = excluded.user_agent_instance_id,
    agent_family_id=excluded.agent_family_id,cloud_key=excluded.cloud_key,
    work_scope_id=excluded.work_scope_id,lifecycle_state = excluded.lifecycle_state, visibility = excluded.visibility, sync_enabled = excluded.sync_enabled,
    allow_personal_evolution = excluded.allow_personal_evolution, allow_cluster_evolution = excluded.allow_cluster_evolution,
    source_conversation_cursor=excluded.source_conversation_cursor,encryption_key_id=excluded.encryption_key_id,
    consent_scope_json=excluded.consent_scope_json,
    current_version_id = excluded.current_version_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at`, [
    localDocumentId,userId,instanceId,canonicalEmployeeAgentFamilyId(row.agent_family_id || row.agentFamilyId || ''),cloudKey,scope,slotNo,row.display_name || row.displayName || 'memory0',row.task_run_id || row.taskRunId || '',
    row.project_id || row.projectId || '',row.relationship_id || row.relationshipId || '',row.delegation_id || row.delegationId || '',
    row.group_id || row.groupId || '',row.relationship_user_id || row.relationshipUserId || '',incomingContextSpaceId,
    row.work_scope_id || row.workScopeId || (scope === 'task' ? `task:${row.task_run_id || row.taskRunId || ''}` : ''),
    incomingLifecycle, normalizeWorkMemoryVisibility(row.visibility), Number(row.sync_enabled ?? row.syncEnabled ?? 1),
    Number(row.allow_personal_evolution ?? row.allowPersonalEvolution ?? 0), Number(row.allow_cluster_evolution ?? row.allowClusterEvolution ?? 0),
    row.source_conversation_cursor || row.sourceConversationCursor || '', row.encryption_key_id || row.encryptionKeyId || '',
    typeof (row.consent_scope_json ?? row.consentScope) === 'string'
      ? (row.consent_scope_json ?? row.consentScope)
      : JSON.stringify(row.consent_scope_json ?? row.consentScope ?? {}),
    row.current_version_id || row.currentVersionId || '', row.content_hash || row.contentHash || '',
    row.created_at || row.createdAt || nowIso(), row.updated_at || row.updatedAt || nowIso(),
  ]);
  const remoteDocumentId = String(row.id || '').trim();
  if (remoteDocumentId && remoteDocumentId !== localDocumentId) {
    run(db, `INSERT INTO memory_document_aliases(alias_document_id,canonical_document_id,user_id,reason,created_at)
      VALUES(?,?,?,'cloud_document_identity',?) ON CONFLICT(alias_document_id) DO UPDATE SET
      canonical_document_id=excluded.canonical_document_id,user_id=excluded.user_id,reason=excluded.reason`, [
      remoteDocumentId, localDocumentId, userId, row.created_at || row.createdAt || nowIso(),
    ]);
  }
  upsertLocalMemorySyncMapping(db, store, userId, {
    userAgentInstanceId: instanceId, cloudKey, status: 'active',
    createdAt: row.created_at || row.createdAt || nowIso(), updatedAt: row.updated_at || row.updatedAt || nowIso(),
  });
}

function upsertLocalAgentContextSpace(db, userId, row = {}) {
  const workspaceId = 'workspace_personal';
  const instanceId = canonicalLocalAgentInstanceId(db, row.user_agent_instance_id || row.userAgentInstanceId || '');
  if (!row.id || !instanceId) return;
  const memoryCloudKey = row.memory_cloud_key || row.memoryCloudKey || '';
  const memoryDocumentId = memoryCloudKey ? get(db, `SELECT id FROM memory_documents
    WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND cloud_key=?`, [workspaceId, userId, instanceId, memoryCloudKey])?.id || '' : '';
  const contextKind = row.context_kind || row.contextKind || 'general_memory';
  const projectId = row.project_id || row.projectId || '';
  const taskRunId = row.task_run_id || row.taskRunId || '';
  const delegationId = row.delegation_id || row.delegationId || '';
  const groupId = row.group_id || row.groupId || '';
  const relationshipUserId = row.relationship_user_id || row.relationshipUserId || '';
  const legacySessionId = row.legacy_session_id || row.legacySessionId || '';
  const existing = get(db, `SELECT id FROM agent_context_spaces WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND context_kind=?
    AND memory_document_id=? AND project_id=? AND task_run_id=? AND delegation_id=? AND group_id=?
    AND relationship_user_id=? AND legacy_session_id=? LIMIT 1`, [
    workspaceId, userId, instanceId, contextKind, memoryDocumentId, projectId, taskRunId, delegationId, groupId, relationshipUserId, legacySessionId,
  ]);
  if (existing?.id && existing.id !== row.id) {
    const target = get(db, 'SELECT * FROM agent_context_spaces WHERE id=?', [row.id]);
    if (target) {
      const targetInstanceId = canonicalLocalAgentInstanceId(db, target.user_agent_instance_id || '');
      if (target.user_id !== userId || target.account_workspace_id !== workspaceId || targetInstanceId !== instanceId) {
        throw new Error('Cloud context space identity conflicts with another local owner.');
      }
      rebindAgentContextSpaceReferences(db, existing.id, row.id);
      run(db, 'DELETE FROM agent_context_spaces WHERE id=?', [existing.id]);
    } else {
      run(db, 'UPDATE agent_context_spaces SET id=? WHERE id=?', [row.id, existing.id]);
      rebindAgentContextSpaceReferences(db, existing.id, row.id);
    }
  }
  run(db, `INSERT INTO agent_context_spaces (
    id,account_workspace_id,user_id,user_agent_instance_id,context_kind,memory_document_id,project_id,task_run_id,delegation_id,group_id,
    relationship_user_id,legacy_session_id,lifecycle_state,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,user_id=excluded.user_id,
    user_agent_instance_id=excluded.user_agent_instance_id,context_kind=excluded.context_kind,memory_document_id=excluded.memory_document_id,
    project_id=excluded.project_id,task_run_id=excluded.task_run_id,delegation_id=excluded.delegation_id,group_id=excluded.group_id,
    relationship_user_id=excluded.relationship_user_id,legacy_session_id=excluded.legacy_session_id,lifecycle_state=excluded.lifecycle_state,
    updated_at=excluded.updated_at`, [
    row.id,workspaceId,userId,instanceId,contextKind,memoryDocumentId,
    projectId,taskRunId,delegationId,
    groupId,relationshipUserId,legacySessionId,
    row.lifecycle_state || row.lifecycleState || 'active',row.created_at || row.createdAt || nowIso(),row.updated_at || row.updatedAt || nowIso(),
  ]);
  if (memoryDocumentId) run(db, 'UPDATE memory_documents SET context_space_id=? WHERE id=?', [row.id, memoryDocumentId]);
}

export function rebindAgentContextSpaceReferences(db, sourceId = '', targetId = '') {
  if (!sourceId || !targetId || sourceId === targetId) return;
  run(db, 'UPDATE messages SET context_space_id=? WHERE context_space_id=?', [targetId, sourceId]);
  run(db, 'UPDATE memory_documents SET context_space_id=?,updated_at=? WHERE context_space_id=?', [targetId, nowIso(), sourceId]);
  run(db, 'UPDATE agent_device_context_state SET active_context_space_id=?,updated_at=? WHERE active_context_space_id=?', [targetId, nowIso(), sourceId]);
  run(db, 'UPDATE agent_context_state SET active_context_space_id=?,updated_at=? WHERE active_context_space_id=?', [targetId, nowIso(), sourceId]);
  rebindChatContextStates(db, sourceId, targetId);
  run(db, 'UPDATE evolution_evidence_outbox SET context_space_id=?,updated_at=? WHERE context_space_id=?', [targetId, nowIso(), sourceId]);
  run(db, 'UPDATE memory_access_audits SET context_space_id=? WHERE context_space_id=?', [targetId, sourceId]);
}

function rebindChatContextStates(db, sourceContextId = '', targetContextId = '') {
  const sourceRows = all(db, `SELECT * FROM chat_context_states
    WHERE context_space_id=? ORDER BY owner_user_id,session_id,id`, [sourceContextId]);
  for (const source of sourceRows) {
    const target = get(db, `SELECT * FROM chat_context_states
      WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [
      source.owner_user_id, source.session_id, targetContextId,
    ]);
    if (!target) {
      run(db, 'UPDATE chat_context_states SET context_space_id=?,updated_at=? WHERE id=?', [
        targetContextId, nowIso(), source.id,
      ]);
      continue;
    }
    const winner = compareChatContextStateFreshness(source, target) > 0 ? source : target;
    run(db, `UPDATE chat_context_states SET context_epoch=?,reset_after_message_id=?,reset_after_created_at=?,
      last_execution_id=?,last_input_tokens=?,context_window_tokens=?,provider_compaction_detected=?,state_revision=?,
      base_state_revision=?,last_command_id=?,source_device_id=?,sync_status=?,created_at=?,updated_at=? WHERE id=?`, [
      winner.context_epoch, winner.reset_after_message_id, winner.reset_after_created_at,
      winner.last_execution_id, winner.last_input_tokens, winner.context_window_tokens,
      winner.provider_compaction_detected, winner.state_revision, winner.base_state_revision,
      winner.last_command_id, winner.source_device_id, winner.sync_status,
      [source.created_at, target.created_at].filter(Boolean).sort()[0] || winner.created_at || nowIso(),
      winner.updated_at || nowIso(), target.id,
    ]);
    run(db, 'DELETE FROM chat_context_states WHERE id=?', [source.id]);
  }
}

function compareChatContextStateFreshness(left = {}, right = {}) {
  const revisionDelta = Number(left.state_revision || 1) - Number(right.state_revision || 1);
  if (revisionDelta) return revisionDelta;
  const updatedDelta = String(left.updated_at || '').localeCompare(String(right.updated_at || ''));
  if (updatedDelta) return updatedDelta;
  return String(left.id || '').localeCompare(String(right.id || ''));
}

export function reconcileLocalGeneralMemoryContextPointers(db, userId = '') {
  if (!userId) return;
  const memories = all(db, `SELECT * FROM memory_documents WHERE user_id=? AND scope='general'`, [userId]);
  for (const memory of memories) {
    const exact = all(db, `SELECT * FROM agent_context_spaces
      WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=?
        AND context_kind='general_memory' AND memory_document_id=?
      ORDER BY lifecycle_state='active' DESC,updated_at DESC,id LIMIT 2`, [
      memory.account_workspace_id || 'workspace_personal', userId, memory.user_agent_instance_id, memory.id,
    ]);
    if (exact.length !== 1) continue;
    const canonical = exact[0];
    const previous = memory.context_space_id
      ? get(db, `SELECT * FROM agent_context_spaces WHERE id=? AND account_workspace_id=? AND user_id=?
        AND user_agent_instance_id=? AND context_kind='general_memory'`, [
        memory.context_space_id, memory.account_workspace_id || 'workspace_personal', userId, memory.user_agent_instance_id,
      ])
      : null;
    if (previous?.memory_document_id && previous.memory_document_id !== memory.id) continue;
    run(db, 'UPDATE memory_documents SET context_space_id=? WHERE id=?', [canonical.id, memory.id]);
    if (!previous || previous.id === canonical.id) continue;
    const conflict = get(db, `SELECT id FROM messages WHERE context_space_id=? AND memory_id!='' AND memory_id!=? LIMIT 1`, [
      previous.id, memory.id,
    ]);
    if (conflict) continue;
    run(db, `UPDATE messages SET context_space_id=?,memory_id=CASE WHEN memory_id='' THEN ? ELSE memory_id END
      WHERE context_space_id=?`, [canonical.id, memory.id, previous.id]);
    run(db, `UPDATE agent_device_context_state SET active_context_space_id=?,active_memory_document_id=?,updated_at=?
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND active_context_space_id=?
        AND (active_memory_document_id='' OR active_memory_document_id=?)`, [
      canonical.id, memory.id, nowIso(), userId, memory.account_workspace_id || 'workspace_personal',
      memory.user_agent_instance_id, previous.id, memory.id,
    ]);
    const now = nowIso();
    run(db, `UPDATE agent_context_state SET active_context_space_id=?,active_memory_document_id=?,
      base_state_revision=CASE WHEN sync_status='synced' THEN state_revision ELSE base_state_revision END,
      state_revision=state_revision+1,last_command_id='memory_context_pointer_sync_repair',sync_status='pending',updated_at=?
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND active_context_space_id=?
        AND (active_memory_document_id='' OR active_memory_document_id=?)`, [
      canonical.id, memory.id, now, userId, memory.account_workspace_id || 'workspace_personal',
      memory.user_agent_instance_id, previous.id, memory.id,
    ]);
    // This is an identity repair for the same Memory, not a runtime context switch.
    // The existing Codex thread remains valid after all references move to the canonical ID.
    run(db, "UPDATE agent_context_spaces SET lifecycle_state='inactive' WHERE id=?", [previous.id]);
  }
}

export function upsertLocalAgentContextState(db, store, userId, row = {}) {
  const instanceId = canonicalLocalAgentInstanceId(db, row.user_agent_instance_id || row.userAgentInstanceId || row.id || '');
  if (!instanceId) return;
  const workspaceId = 'workspace_personal';
  const memoryCloudKey = row.active_memory_cloud_key || row.activeMemoryCloudKey
    || row.active_memory_document_id || row.activeMemoryDocumentId || '';
  const memoryDocumentId = memoryCloudKey ? localAgentContextMemoryDocumentId(db, {
    userId, workspaceId, instanceId, memoryCloudKey,
  }) : '';
  const requestedPrimarySessionId = row.primary_conversation_id || row.primaryConversationId
    || row.primary_session_id || row.primarySessionId || '';
  const localPrimary = store.getPrimaryAgentSession?.({ userId, agentInstanceId: instanceId, workspaceId }) || null;
  const requestedPrimary = requestedPrimarySessionId ? get(db, `SELECT * FROM sessions WHERE id=? AND user_id=?
    AND agent_instance_id=?`, [requestedPrimarySessionId, userId, instanceId]) : null;
  const requestedPrimaryValid = requestedPrimary
    && requestedPrimary.conversation_role === 'primary'
    && requestedPrimary.write_state === 'writable'
    && requestedPrimary.status !== 'deleted';
  const primarySessionId = localPrimary?.id || (requestedPrimaryValid ? requestedPrimarySessionId : '');
  const repairedPrimarySession = primarySessionId !== requestedPrimarySessionId;
  const activeContextSpaceId = localAgentContextSpaceId(db, {
    userId,
    workspaceId,
    instanceId,
    requestedContextSpaceId: row.active_context_space_id || row.activeContextSpaceId || '',
    memoryDocumentId,
  });
  const remoteRevision = Math.max(1, Number(row.state_revision ?? row.stateRevision ?? 1));
  const current = get(db, `SELECT * FROM agent_context_state
    WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [userId, workspaceId, instanceId]);
  if (current?.sync_status === 'pending' && remoteRevision < Number(current.base_state_revision || 0)) return;
  const runtimeContextChanged = agentRuntimeContextChanged(db, current, {
    activeContextSpaceId,
    activeMemoryDocumentId: memoryDocumentId,
  });
  const now = repairedPrimarySession ? nowIso() : row.updated_at || row.updatedAt || nowIso();
  const stateRevision = repairedPrimarySession ? remoteRevision + 1 : remoteRevision;
  const baseStateRevision = remoteRevision;
  const lastCommandId = repairedPrimarySession
    ? newId('context_primary_repair')
    : row.last_command_id || row.lastCommandId || '';
  const sourceDeviceId = repairedPrimarySession
    ? store.contextDeviceId?.() || 'local'
    : row.source_device_id || row.sourceDeviceId || '';
  const syncStatus = repairedPrimarySession ? 'pending' : 'synced';
  run(db, `INSERT INTO agent_context_state(
    user_id,account_workspace_id,user_agent_instance_id,primary_session_id,active_context_space_id,active_memory_document_id,
    state_revision,base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,account_workspace_id,user_agent_instance_id) DO UPDATE SET
    primary_session_id=excluded.primary_session_id,active_context_space_id=excluded.active_context_space_id,
    active_memory_document_id=excluded.active_memory_document_id,state_revision=excluded.state_revision,
    base_state_revision=excluded.base_state_revision,last_command_id=excluded.last_command_id,
    source_device_id=excluded.source_device_id,sync_status=excluded.sync_status,updated_at=excluded.updated_at`, [
    userId, workspaceId, instanceId, primarySessionId, activeContextSpaceId, memoryDocumentId,
    stateRevision, baseStateRevision, lastCommandId, sourceDeviceId, syncStatus,
    current?.created_at || row.created_at || row.createdAt || now, now,
  ]);
  run(db, `UPDATE agent_device_context_state SET primary_session_id=?,active_context_space_id=?,active_memory_document_id=?,updated_at=?
    WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [primarySessionId, activeContextSpaceId, memoryDocumentId, now, userId, workspaceId, instanceId]);
  if (runtimeContextChanged && primarySessionId) run(db, "UPDATE sessions SET codex_thread_id='',updated_at=? WHERE id=? AND user_id=? AND agent_instance_id=?", [
    nowIso(), primarySessionId, userId, instanceId,
  ]);
  if (memoryDocumentId) {
    run(db, `UPDATE memory_documents SET lifecycle_state=CASE WHEN id=? THEN 'active' ELSE 'inactive' END,
      updated_at=CASE WHEN id=? THEN ? ELSE updated_at END
      WHERE account_workspace_id=? AND user_id=? AND user_agent_instance_id=? AND scope='general' AND lifecycle_state!='archived'`, [
      memoryDocumentId, memoryDocumentId, now, workspaceId, userId, instanceId,
    ]);
  }
  store.ensureDeviceContextState?.({ deviceId: store.contextDeviceId?.() || 'local', userId, agentInstanceId: instanceId, workspaceId });
}

function agentRuntimeContextChanged(db, current = null, {
  activeContextSpaceId = '', activeMemoryDocumentId = '',
} = {}) {
  if (!current) return false;
  if (current.active_context_space_id === activeContextSpaceId
    && current.active_memory_document_id === activeMemoryDocumentId) return false;
  const currentContext = current.active_context_space_id
    ? get(db, 'SELECT context_kind,memory_document_id FROM agent_context_spaces WHERE id=?', [current.active_context_space_id])
    : null;
  const nextContext = activeContextSpaceId
    ? get(db, 'SELECT context_kind,memory_document_id FROM agent_context_spaces WHERE id=?', [activeContextSpaceId])
    : null;
  const currentMemoryDocumentId = current.active_memory_document_id || currentContext?.memory_document_id || '';
  const nextMemoryDocumentId = activeMemoryDocumentId || nextContext?.memory_document_id || '';
  return !(currentContext?.context_kind === 'general_memory'
    && nextContext?.context_kind === 'general_memory'
    && currentMemoryDocumentId
    && currentMemoryDocumentId === nextMemoryDocumentId);
}

function localAgentContextMemoryDocumentId(db, { userId = '', workspaceId = '', instanceId = '', memoryCloudKey = '' } = {}) {
  if (!userId || !workspaceId || !instanceId || !memoryCloudKey) return '';
  const direct = get(db, `SELECT id FROM memory_documents
    WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=? AND (id=? OR cloud_key=?)
    ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 1`, [
    userId, workspaceId, instanceId, memoryCloudKey, memoryCloudKey, memoryCloudKey,
  ]);
  if (direct?.id) return direct.id;
  return get(db, `SELECT document.id FROM memory_document_aliases alias
    JOIN memory_documents document ON document.id=alias.canonical_document_id
    WHERE alias.alias_document_id=? AND document.user_id=? AND document.account_workspace_id=?
      AND document.user_agent_instance_id=? LIMIT 1`, [
    memoryCloudKey, userId, workspaceId, instanceId,
  ])?.id || '';
}

function localAgentContextSpaceId(db, {
  userId = '', workspaceId = '', instanceId = '', requestedContextSpaceId = '', memoryDocumentId = '',
} = {}) {
  const ownedContextSpace = (contextSpaceId, { exactMemoryDocumentId = '' } = {}) => {
    if (!contextSpaceId) return '';
    const row = get(db, `SELECT id,user_agent_instance_id,context_kind,memory_document_id FROM agent_context_spaces
      WHERE id=? AND user_id=? AND account_workspace_id=?`, [contextSpaceId, userId, workspaceId]);
    if (!row || canonicalLocalAgentInstanceId(db, row.user_agent_instance_id || '') !== instanceId) return '';
    if (exactMemoryDocumentId && (row.context_kind !== 'general_memory' || row.memory_document_id !== exactMemoryDocumentId)) return '';
    return row.id;
  };
  const requested = ownedContextSpace(requestedContextSpaceId, { exactMemoryDocumentId: memoryDocumentId });
  if (requested) return requested;
  if (memoryDocumentId) {
    const documentContextId = get(db, `SELECT context_space_id FROM memory_documents
      WHERE id=? AND user_id=? AND account_workspace_id=? AND user_agent_instance_id=?`, [
      memoryDocumentId, userId, workspaceId, instanceId,
    ])?.context_space_id || '';
    const documentContext = ownedContextSpace(documentContextId, { exactMemoryDocumentId: memoryDocumentId });
    if (documentContext) return documentContext;
    const semantic = get(db, `SELECT id FROM agent_context_spaces
      WHERE user_id=? AND account_workspace_id=? AND user_agent_instance_id=?
        AND context_kind='general_memory' AND memory_document_id=?
      ORDER BY lifecycle_state='active' DESC,updated_at DESC,id LIMIT 1`, [
      userId, workspaceId, instanceId, memoryDocumentId,
    ]);
    if (semantic?.id) return semantic.id;
  }
  return '';
}

export function upsertLocalChatContextState(db, userId, row = {}) {
  const incomingId = String(row.id || '').trim();
  const sessionId = String(row.session_id || row.sessionId || '').trim();
  if (!incomingId || !sessionId) return;
  const contextSpaceId = String(row.context_space_id || row.contextSpaceId || '');
  const current = get(db, `SELECT * FROM chat_context_states
    WHERE owner_user_id=? AND session_id=? AND context_space_id=?`, [userId, sessionId, contextSpaceId]);
  const id = current?.id || collisionSafeChatContextStateId(db, {
    ownerUserId: userId, sessionId, contextSpaceId, preferredId: incomingId,
  });
  const remoteRevision = Math.max(1, Number(row.state_revision ?? row.stateRevision ?? 1));
  const contextEpoch = Math.max(1, Number(row.context_epoch ?? row.contextEpoch ?? 1));
  const resetAfterMessageId = row.reset_after_message_id || row.resetAfterMessageId || '';
  const resetAfterCreatedAt = row.reset_after_created_at || row.resetAfterCreatedAt || '';
  const boundaryChanged = current
    ? Number(current.context_epoch || 1) !== contextEpoch
      || current.reset_after_message_id !== resetAfterMessageId
      || current.reset_after_created_at !== resetAfterCreatedAt
    : contextEpoch > 1 || Boolean(resetAfterMessageId || resetAfterCreatedAt);
  if (current?.sync_status === 'pending') {
    const baseRevision = Math.max(0, Number(current.base_state_revision || 0));
    if (remoteRevision <= baseRevision) return;
    if (!boundaryChanged) {
      mergePendingChatContextUsage(db, current, row, remoteRevision);
      return;
    }
  }
  const now = row.updated_at || row.updatedAt || nowIso();
  run(db, `INSERT INTO chat_context_states(
    id,owner_user_id,session_id,context_space_id,context_epoch,reset_after_message_id,reset_after_created_at,
    last_execution_id,last_input_tokens,context_window_tokens,provider_compaction_detected,state_revision,
    base_state_revision,last_command_id,source_device_id,sync_status,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'synced',?,?) ON CONFLICT(id) DO UPDATE SET
    owner_user_id=excluded.owner_user_id,session_id=excluded.session_id,context_space_id=excluded.context_space_id,
    context_epoch=excluded.context_epoch,reset_after_message_id=excluded.reset_after_message_id,
    reset_after_created_at=excluded.reset_after_created_at,last_execution_id=excluded.last_execution_id,
    last_input_tokens=excluded.last_input_tokens,context_window_tokens=excluded.context_window_tokens,
    provider_compaction_detected=excluded.provider_compaction_detected,state_revision=excluded.state_revision,
    base_state_revision=excluded.base_state_revision,last_command_id=excluded.last_command_id,
    source_device_id=excluded.source_device_id,sync_status='synced',updated_at=excluded.updated_at`, [
    id,userId,sessionId,contextSpaceId,contextEpoch,resetAfterMessageId,resetAfterCreatedAt,
    row.last_execution_id || row.lastExecutionId || '',Math.max(0,Number(row.last_input_tokens ?? row.lastInputTokens ?? 0)),
    Math.max(0,Number(row.context_window_tokens ?? row.contextWindowTokens ?? 0)),
    row.provider_compaction_detected || row.providerCompactionDetected ? 1 : 0,remoteRevision,remoteRevision,
    row.last_command_id || row.lastCommandId || '',row.source_device_id || row.sourceDeviceId || '',
    current?.created_at || row.created_at || row.createdAt || now,now,
  ]);
  if (boundaryChanged) run(db, "UPDATE sessions SET codex_thread_id='',updated_at=? WHERE id=? AND user_id=?", [nowIso(), sessionId, userId]);
}

function mergePendingChatContextUsage(db, current = {}, row = {}, remoteRevision = 1) {
  const localHasMeasurement = Boolean(
    current.last_execution_id
      || Number(current.last_input_tokens || 0) > 0
      || Number(current.context_window_tokens || 0) > 0
  );
  const remoteLastExecutionId = row.last_execution_id || row.lastExecutionId || '';
  const remoteLastInputTokens = Math.max(0, Number(row.last_input_tokens ?? row.lastInputTokens ?? 0));
  const remoteContextWindowTokens = Math.max(0, Number(row.context_window_tokens ?? row.contextWindowTokens ?? 0));
  const providerCompactionDetected = Boolean(
    current.provider_compaction_detected || row.provider_compaction_detected || row.providerCompactionDetected
  );
  const now = nowIso();
  run(db, `UPDATE chat_context_states SET last_execution_id=?,last_input_tokens=?,context_window_tokens=?,
    provider_compaction_detected=?,state_revision=?,base_state_revision=?,sync_status='pending',updated_at=? WHERE id=?`, [
    localHasMeasurement ? current.last_execution_id : remoteLastExecutionId,
    localHasMeasurement ? Math.max(0, Number(current.last_input_tokens || 0)) : remoteLastInputTokens,
    localHasMeasurement ? Math.max(0, Number(current.context_window_tokens || 0)) : remoteContextWindowTokens,
    providerCompactionDetected ? 1 : 0,
    Math.max(Number(current.state_revision || 1), remoteRevision) + 1,
    remoteRevision,
    now,
    current.id,
  ]);
}

function upsertLocalMemorySyncMapping(db, store, userId, row = {}) {
  const instanceId = canonicalLocalAgentInstanceId(db,row.user_agent_instance_id || row.userAgentInstanceId || '');
  const cloudKey = row.cloud_key || row.cloudKey || '';
  if (!instanceId || !cloudKey) return;
  const document = get(db, 'SELECT * FROM memory_documents WHERE user_id=? AND user_agent_instance_id=? AND cloud_key=?', [userId,instanceId,cloudKey]);
  if (!document) return;
  const deviceId = store.contextDeviceId?.() || 'local';
  const existing = get(db, `SELECT * FROM memory_sync_mappings
    WHERE (device_id=? AND memory_document_id=?) OR (owner_user_id=? AND user_agent_instance_id=? AND cloud_key=?)
    ORDER BY CASE WHEN device_id=? AND memory_document_id=? THEN 0 ELSE 1 END LIMIT 1`, [
    deviceId,document.id,userId,instanceId,cloudKey,deviceId,document.id,
  ]);
  if (existing) {
    run(db, `UPDATE memory_sync_mappings SET status=?,updated_at=? WHERE device_id=? AND private_key=?`, [
      row.status || 'active',row.updated_at || row.updatedAt || nowIso(),existing.device_id,existing.private_key,
    ]);
    return;
  }
  run(db, `INSERT INTO memory_sync_mappings(device_id,private_key,cloud_key,owner_user_id,user_agent_instance_id,memory_document_id,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(device_id,memory_document_id) DO UPDATE SET cloud_key=excluded.cloud_key,
    owner_user_id=excluded.owner_user_id,user_agent_instance_id=excluded.user_agent_instance_id,status=excluded.status,updated_at=excluded.updated_at`, [
    deviceId,newId('memory_private'),cloudKey,userId,instanceId,document.id,row.status || 'active',
    row.created_at || row.createdAt || nowIso(),row.updated_at || row.updatedAt || nowIso(),
  ]);
}

function upsertLocalTaskSecurityContext(db, userId, row = {}) {
  const taskRunId = row.task_run_id || row.taskRunId || '';
  if (!taskRunId || !(row.local_key_id || row.localKeyId) || !(row.cloud_key_id || row.cloudKeyId)) return;
  run(db, `INSERT INTO task_security_contexts (
    task_run_id,owner_user_id,local_key_id,cloud_key_id,key_version,cloud_evolution_allowed,cloud_collaboration_allowed,cloud_sync_recovery_allowed,
    local_envelope_state,cloud_envelope_state,cloud_wrap_algorithm,cloud_wrapping_key_id,cloud_wrapped_key,
    status,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(task_run_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
    local_key_id=CASE WHEN task_security_contexts.local_wrapped_key!='' THEN task_security_contexts.local_key_id ELSE excluded.local_key_id END,
    cloud_key_id=excluded.cloud_key_id,
    key_version=CASE WHEN task_security_contexts.local_wrapped_key!='' THEN task_security_contexts.key_version ELSE MAX(task_security_contexts.key_version,excluded.key_version) END,
    cloud_evolution_allowed=excluded.cloud_evolution_allowed,
    cloud_collaboration_allowed=excluded.cloud_collaboration_allowed,
    cloud_sync_recovery_allowed=excluded.cloud_sync_recovery_allowed,
    cloud_envelope_state=excluded.cloud_envelope_state,cloud_wrap_algorithm=excluded.cloud_wrap_algorithm,
    cloud_wrapping_key_id=excluded.cloud_wrapping_key_id,cloud_wrapped_key=excluded.cloud_wrapped_key,
    status=excluded.status,updated_at=MAX(task_security_contexts.updated_at,excluded.updated_at)`, [
    taskRunId, row.owner_user_id || row.ownerUserId || userId,
    row.local_key_id || row.localKeyId, row.cloud_key_id || row.cloudKeyId,
    Number(row.key_version ?? row.keyVersion ?? 1), row.cloud_evolution_allowed || row.cloudEvolutionAllowed ? 1 : 0,
    row.cloud_collaboration_allowed || row.cloudCollaborationAllowed ? 1 : 0,
    row.cloud_sync_recovery_allowed === 0 || row.cloudSyncRecoveryAllowed === false ? 0 : 1,
    'reference_only', row.cloud_envelope_state || row.cloudEnvelopeState || 'disabled',
    row.cloud_wrap_algorithm || row.cloudWrapAlgorithm || '', row.cloud_wrapping_key_id || row.cloudWrappingKeyId || '',
    row.cloud_wrapped_key || row.cloudWrappedKey || '', row.status || 'active',
    row.created_at || row.createdAt || nowIso(), row.updated_at || row.updatedAt || nowIso(),
  ]);
}

function upsertLocalMemoryVersion(db, row = {}) {
  const remoteDocumentId = row.memory_document_id || row.memoryDocumentId || '';
  const documentId = get(db, 'SELECT id FROM memory_documents WHERE cloud_key=?', [remoteDocumentId])?.id
    || canonicalLocalMemoryDocumentId(db, remoteDocumentId);
  if (!row.id || !documentId) return;
  const versionNo = Number(row.version_no ?? row.versionNo ?? 1);
  const existingSlot = get(db, 'SELECT id FROM memory_document_versions WHERE memory_document_id=? AND version_no=?', [documentId, versionNo]);
  const versionId = existingSlot?.id || row.id;
  run(db, `INSERT INTO memory_document_versions (
    id, memory_document_id, version_no, content, content_hash, source_kind, source_id,
    privacy_level,review_status,created_by,origin_document_id,origin_version_no,base_version_id,parent_version_id,branch_id,conflict_state,
    visibility,published_at,published_by_agent_instance_id,source_cursor,
    encryption_algorithm,encryption_key_id,encryption_key_version,content_ciphertext,
    content_nonce,content_tag,content_aad,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET memory_document_id = excluded.memory_document_id,
    version_no = excluded.version_no, content = excluded.content, content_hash = excluded.content_hash,
    source_kind = excluded.source_kind, source_id = excluded.source_id, privacy_level = excluded.privacy_level,
    review_status = excluded.review_status, created_by = excluded.created_by,
    origin_document_id = excluded.origin_document_id, origin_version_no = excluded.origin_version_no,
    base_version_id=excluded.base_version_id,parent_version_id=excluded.parent_version_id,branch_id=excluded.branch_id,conflict_state=excluded.conflict_state,
    visibility=excluded.visibility,published_at=excluded.published_at,
    published_by_agent_instance_id=excluded.published_by_agent_instance_id,source_cursor=excluded.source_cursor,
    encryption_algorithm=excluded.encryption_algorithm,encryption_key_id=excluded.encryption_key_id,
    encryption_key_version=excluded.encryption_key_version,content_ciphertext=excluded.content_ciphertext,
    content_nonce=excluded.content_nonce,content_tag=excluded.content_tag,content_aad=excluded.content_aad`, [
    versionId, documentId, versionNo, row.content || '', row.content_hash || row.contentHash || '',
    row.source_kind || row.sourceKind || '', row.source_id || row.sourceId || '', row.privacy_level || row.privacyLevel || 'private',
    row.review_status || row.reviewStatus || 'unreviewed', row.created_by || row.createdBy || '',
    row.origin_document_id || row.originDocumentId || documentId, Number(row.origin_version_no ?? row.originVersionNo ?? row.version_no ?? row.versionNo ?? 1),
    row.base_version_id || row.baseVersionId || '',row.parent_version_id || row.parentVersionId || '',
    row.branch_id || row.branchId || 'main',row.conflict_state || row.conflictState || 'none',
    normalizeWorkMemoryVisibility(row.visibility), row.published_at || row.publishedAt || '',
    row.published_by_agent_instance_id || row.publishedByAgentInstanceId || '', row.source_cursor || row.sourceCursor || '',
    row.encryption_algorithm || row.encryptionAlgorithm || '', row.encryption_key_id || row.encryptionKeyId || '',
    Number(row.encryption_key_version ?? row.encryptionKeyVersion ?? 0), row.content_ciphertext || row.contentCiphertext || '',
    row.content_nonce || row.contentNonce || '', row.content_tag || row.contentTag || '', row.content_aad || row.contentAad || '',
    row.created_at || row.createdAt || nowIso(),
  ]);
  if ((row.conflict_state || row.conflictState || 'none') !== 'unresolved') {
    run(db, 'UPDATE memory_documents SET current_version_id=?,content_hash=?,updated_at=MAX(updated_at,?) WHERE id=?', [
      versionId,row.content_hash || row.contentHash || '',row.created_at || row.createdAt || nowIso(),documentId,
    ]);
  }
}

function cloudTaskSecurityContextPayload(row = {}) {
  return sanitizeCloudValue({
    task_run_id: row.task_run_id,
    owner_user_id: row.owner_user_id,
    local_key_id: row.local_key_id,
    cloud_key_id: row.cloud_key_id,
    key_version: row.key_version,
    cloud_evolution_allowed: row.cloud_evolution_allowed,
    cloud_collaboration_allowed: row.cloud_collaboration_allowed,
    cloud_sync_recovery_allowed: row.cloud_sync_recovery_allowed,
    local_envelope_state: 'device_local_only',
    cloud_envelope_state: row.cloud_envelope_state,
    cloud_wrap_algorithm: row.cloud_wrap_algorithm || '',
    cloud_wrapping_key_id: row.cloud_wrapping_key_id || '',
    cloud_wrapped_key: row.cloud_wrapped_key || '',
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function normalizeWorkMemoryVisibility(value) {
  const visibility = String(value || 'agent_private').trim().toLowerCase();
  return visibility === 'private' ? 'agent_private' : visibility;
}

function changedAfter(value, cursor) {
  return !cursor || String(value || '') >= cursor;
}

function cloudProjectPayload(row = {}) {
  return {
    id: row.id,
    userId: row.user_id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    title: row.title || 'Untitled project',
    status: row.status || 'active',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cloudConversationPayload(row = {}) {
  const projectId = String(row.project_id || '');
  return {
    id: row.id,
    userId: row.user_id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    conversationType: projectId ? 'project' : 'ordinary',
    projectId,
    title: row.title || 'Untitled',
    departmentId: row.department_id || '',
    agentId: row.agent_id || '',
    agentInstanceId: row.agent_instance_id || '',
    codexThreadId: row.codex_thread_id || '',
    interactionMode: normalizeV6InteractionMode(row.interaction_mode),
    goalObjective: String(row.goal_objective || ''),
    goalStatus: normalizeV6GoalStatus(row.goal_status),
    goalTokensUsed: normalizeV6GoalMetric(row.goal_tokens_used),
    goalTokenBudget: 0,
    goalTimeUsedSeconds: normalizeV6GoalMetric(row.goal_time_used_seconds),
    conversationRole: row.conversation_role || 'standard',
    writeState: row.write_state || 'writable',
    supersededBySessionId: row.superseded_by_session_id || '',
    status: row.status || 'active',
    pinnedAt: row.pinned_at || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cloudMessagePayload(row = {}, session = null, memoryCloudKeyById = new Map()) {
  return {
    id: row.id,
    userId: session?.user_id || '',
    accountWorkspaceId: row.account_workspace_id || session?.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || session?.account_workspace_id || 'workspace_personal',
    conversationId: row.conversation_id || row.session_id || '',
    legacySessionId: row.session_id || '',
    memoryId: memoryCloudKeyById.get(row.memory_id || '') || row.memory_id || '',
    taskWorkspaceId: row.task_workspace_id || '',
    senderUserId: row.sender_user_id || '',
    sourceEventId: row.source_event_id || '',
    sourceMessageId: row.source_message_id || '',
    taskRunId: row.task_run_id || '',
    taskNodeId: row.task_node_id || '',
    role: row.role || '',
    content: sanitizeMessageContent(row.content),
    agentId: row.agent_id || '',
    agentInstanceId: row.agent_instance_id || '',
    departmentId: row.department_id || '',
    contextSpaceId: row.context_space_id || '',
    visible: Boolean(row.visible),
    metadata: sanitizeCloudValue(safeJsonParse(row.metadata_json, {})),
    createdAt: row.created_at || '',
  };
}

function cloudModelExecutionPayload(row = {}) {
  return {
    id: row.id,
    userId: row.user_id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    projectId: row.project_id || '',
    conversationId: row.conversation_id || '',
    requestMessageId: row.request_message_id || '',
    responseMessageId: row.response_message_id || '',
    taskRunId: row.task_run_id || '',
    taskNodeId: row.task_node_id || '',
    departmentId: row.department_id || '',
    agentId: row.agent_id || '',
    agentInstanceId: row.agent_instance_id || '',
    agentVersionId: row.agent_version_id || '',
    personalSkillVersionId: row.personal_skill_version_id || '',
    agentRole: row.agent_role || 'agent',
    executionKind: row.execution_kind || '',
    providerId: row.provider_id || '',
    requestedModel: row.requested_model || '',
    effectiveModel: row.effective_model || '',
    reasoningEffort: row.reasoning_effort || '',
    modelSource: row.model_source || '',
    codexThreadId: row.codex_thread_id || '',
    codexTurnId: row.codex_turn_id || '',
    skillHash: row.skill_hash || '',
    memoryHash: row.memory_hash || '',
    memoryManifestHash: row.memory_manifest_hash || '',
    organizationVersion: row.organization_version || '',
    status: row.status || '',
    errorText: row.error_text || '',
    metadata: sanitizeCloudValue(safeJsonParse(row.metadata_json, {})),
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
    updatedAt: row.updated_at || '',
  };
}

function sanitizeMessageContent(content = '') {
  const artifact = parseArtifactMessage(content);
  if (!artifact) return String(content || '');
  return artifactMessage(artifact.kind, sanitizeCloudValue(artifact.data));
}

function sanitizeCloudValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeCloudValue(item));
  if (!value || typeof value !== 'object') return value;
  const excluded = new Set([
    'path', 'preview_url', 'previewUrl', 'download_url', 'downloadUrl', 'file_url', 'fileUrl',
    'render_url', 'renderUrl', 'office_pdf_url', 'officePdfUrl', 'workspace_root', 'workspaceRoot',
    'source_path', 'sourcePath',
  ]);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (excluded.has(key)) continue;
    output[key] = sanitizeCloudValue(item);
  }
  return output;
}

function sanitizeTaskEventForCloud(row = {}) {
  const payload = safeJsonParse(row.payload_json, {});
  const privacyLevel = String(row.privacy_level || 'owner_private');
  const cloudPayload = privacyLevel === 'local_private'
    ? Object.fromEntries(Object.entries(payload).filter(([key]) => [
        'activityId', 'activityType', 'title', 'status', 'exitCode', 'durationMs', 'startedAtMs',
        'completedAtMs', 'itemType', 'model', 'reasoningEffort', 'summaryIndex', 'usage',
      ].includes(key)))
    : payload;
  const sanitizedRow = redactDiagnosticValue(row, { maxLength: 16_000 });
  return {
    ...sanitizedRow,
    payload: sanitizeCloudValue(redactDiagnosticValue(cloudPayload, { maxLength: 16_000 })),
    payload_json: undefined,
  };
}

function buildFileRefs({ root, files = [], projects = [], sessions = [], messages = [] } = {}) {
  const fileByPath = new Map(files.map((item) => [item.localPath, item]));
  const fileBySourcePath = new Map(files.map((item) => [path.resolve(item.sourcePath || path.join(root, item.localPath)), item]));
  const sessionById = new Map(sessions.map((item) => [item.id, item]));
  const refs = new Map();
  const addRef = ({ file, message = null, attachment = null, relationType = 'intermediate', sourceKind = 'managed_file', session = null } = {}) => {
    if (!file) return;
    const resolvedSession = session || sessionById.get(message?.session_id || '') || null;
    const conversationId = resolvedSession?.id || message?.session_id || '';
    const projectId = resolvedSession?.project_id || '';
    const messageId = message?.id || '';
    const id = stableFileRefId({ file, conversationId, messageId, relationType, sourceKind });
    refs.set(id, {
      id,
      sha256: file.sha256,
      localPath: file.localPath,
      userId: resolvedSession?.user_id || attachment?.user_id || attachment?.userId || '',
      projectId,
      conversationId,
      messageId,
      taskRunId: message?.task_run_id || '',
      taskNodeId: message?.task_node_id || '',
      relationType,
      sourceKind,
      originalName: attachment?.name || attachment?.filename || file.originalName || path.basename(file.localPath),
      contentType: attachment?.content_type || attachment?.contentType || attachment?.type || file.contentType || '',
      sizeBytes: Number(file.sizeBytes || 0),
      createdAt: message?.created_at || new Date(Number(file.mtimeMs || Date.now())).toISOString(),
    });
  };

  for (const message of messages) {
    const metadata = safeJsonParse(message.metadata_json, {});
    const attachments = Array.isArray(metadata.attachments) ? metadata.attachments : [];
    for (const attachment of attachments) {
      const file = fileForAttachment(root, fileByPath, fileBySourcePath, attachment);
      addRef({
        file,
        message,
        attachment,
        relationType: message.role === 'user' ? 'input' : message.role === 'assistant' || message.role === 'system' ? 'output' : 'intermediate',
        sourceKind: 'attachment',
      });
    }
    for (const outputArtifact of Array.isArray(metadata.outputArtifacts) ? metadata.outputArtifacts : []) {
      addRef({
        file: fileForAttachment(root, fileByPath, fileBySourcePath, outputArtifact),
        message,
        attachment: outputArtifact,
        relationType: 'output',
        sourceKind: 'message_output',
      });
    }
    const artifact = parseArtifactMessage(message.content);
    if (artifact?.data) {
      addRef({
        file: fileForAttachment(root, fileByPath, fileBySourcePath, artifact.data),
        message,
        attachment: artifact.data,
        relationType: 'output',
        sourceKind: `artifact:${artifact.kind}`,
      });
    }
  }

  const referencedPaths = new Set([...refs.values()].map((item) => item.localPath));
  for (const file of files) {
    if (referencedPaths.has(file.localPath)) continue;
    const session = sessions.find((item) => file.localPath.split('/').includes(item.id)) || null;
    addRef({ file, session, relationType: 'intermediate', sourceKind: 'managed_file' });
  }
  return [...refs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function fileForAttachment(root, fileByPath, fileBySourcePath, attachment = {}) {
  const candidates = [
    attachment.workspace_relative_path,
    attachment.workspaceRelativePath,
    attachment.relative_path,
    attachment.relativePath,
    attachment.path,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(String(candidate || ''))) {
      const sourcePath = path.resolve(String(candidate));
      if (fileBySourcePath.has(sourcePath)) return fileBySourcePath.get(sourcePath);
    }
    const localPath = safeCloudLocalPath(root, candidate);
    if (localPath && fileByPath.has(localPath)) return fileByPath.get(localPath);
    const outputPath = localPath && !localPath.startsWith('outputs/') ? `outputs/${localPath}` : '';
    if (outputPath && fileByPath.has(outputPath)) return fileByPath.get(outputPath);
  }
  return null;
}

function referencedAttachmentFiles(root, attachment = {}) {
  const candidates = [
    attachment.path,
    attachment.workspace_relative_path,
    attachment.workspaceRelativePath,
    attachment.relative_path,
    attachment.relativePath,
  ].filter(Boolean);
  const results = [];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (!text) continue;
    const possible = path.isAbsolute(text)
      ? [path.resolve(text)]
      : [path.resolve(root, text), path.resolve(root, 'outputs', text)];
    for (const file of possible) {
      if (fs.existsSync(file) && fs.statSync(file).isFile() && !results.includes(file)) results.push(file);
    }
  }
  return results;
}

function safeCloudLocalPath(root, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (path.isAbsolute(text)) {
    const relative = relativeToRoot(root, text);
    return relative && !relative.startsWith('../') && relative !== '..' ? relative : '';
  }
  const normalized = text.replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('../') || normalized === '..' ? '' : normalized;
}

function stableFileRefId({ file, conversationId, messageId, relationType, sourceKind }) {
  const digest = crypto.createHash('sha256')
    .update([file.localPath, file.sha256, conversationId, messageId, relationType, sourceKind].join('\n'))
    .digest('hex');
  return `file_ref_${digest.slice(0, 40)}`;
}

function stableTranscriptId(conversationId, role, content, createdAt) {
  const digest = crypto.createHash('sha256').update([conversationId, role, createdAt, content].join('\n')).digest('hex');
  return `transcript_${digest.slice(0, 40)}`;
}

function compileProjectedSkill(baseSkill = '', overlayText = '') {
  const overlay = String(overlayText || '').trim();
  if (!overlay) return String(baseSkill || '');
  return `${String(baseSkill || '').trimEnd()}\n\n<!-- JANUS PERSONAL OVERLAY START -->\n${overlay}\n<!-- JANUS PERSONAL OVERLAY END -->\n`;
}

function v3CompatiblePayload(payload = {}) {
  const data = { ...(payload.data || {}) };
  delete data.personalEvolutionProposals;
  delete data.personalEvolutionMemoryOperations;
  delete data.chatContextStates;
  return { ...payload, schemaVersion: 3, data };
}

function syncContentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })[ext] || 'application/octet-stream';
}

function shouldSyncReferencedFile(file) {
  const name = path.basename(file);
  if (SENSITIVE_NAME_RE.test(name) || /^(\.env|id_rsa|id_ed25519|credentials?)(\.|$)/i.test(name)) return false;
  if (/\.(db|sqlite|sqlite3|wal|shm|log|tmp|env)$/i.test(file)) return false;
  return true;
}

function safeCloudFilename(value = '') {
  return String(value || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
}

function buildV6BatchPayload(db, payload = {}) {
  const collections = {
    projects: 'project', conversations: 'conversation', conversationAliases: 'conversation_alias', messages: 'message', codexTranscripts: 'transcript',
    modelExecutions: 'model_execution', fileRefs: 'file_ref', agentFamilies: 'agent_family',
    agentVersions: 'agent_version', userAgentInstances: 'user_agent_instance',
    userAgentSkillVersions: 'user_agent_skill_version', userAgentInstanceAliases: 'agent_instance_alias',
    memoryDocuments: 'memory_document', memoryDocumentVersions: 'memory_document_version',
    memoryDocumentAliases: 'memory_document_alias', agentContextSpaces: 'agent_context_space', agentContextStates: 'agent_context_state',
    chatContextStates: 'chat_context_state',
    memorySyncMappings: 'memory_sync_mapping', taskSecurityContexts: 'task_security_context',
    personalEvolutionProposals: 'personal_evolution_proposal',
    personalEvolutionMemoryOperations: 'personal_evolution_memory_operation', taskRuns: 'task_run',
    taskNodes: 'task_node', taskEvents: 'task_event', communications: 'communication',
  };
  const changes = [];
  for (const [collection, entityType] of Object.entries(collections)) {
    for (const row of Array.isArray(payload.data?.[collection]) ? payload.data[collection] : []) {
      const entityId = v6EntityId(entityType, row);
      if (!entityId) continue;
      const revision = get(db, `SELECT revision FROM cloud_sync_entity_revisions WHERE entity_type=? AND entity_id=?`, [entityType, entityId]);
      const contentHash = v6Field(row, 'content_hash', 'contentHash')
        || crypto.createHash('sha256').update(stableCloudJson(row)).digest('hex');
      const occurredAt = v6Field(row, 'updated_at', 'updatedAt') || v6Field(row, 'created_at', 'createdAt')
        || payload.batch?.generatedAt || nowIso();
      changes.push({
        changeId: `change_${crypto.createHash('sha256').update(`${payload.batch?.id}:${entityType}:${entityId}:${contentHash}`).digest('hex').slice(0, 40)}`,
        entityType, entityId,
        operation: ['project', 'conversation'].includes(entityType) && row.status === 'deleted' ? 'delete' : 'upsert',
        baseRevision: Number(revision?.revision || 0), occurredAt, contentHash, payload: row,
      });
    }
  }
  return {
    schemaVersion: 8,
    accountId: personalAccountId(payload.device?.userId || ''),
    batch: { ...payload.batch, itemCount: changes.length },
    device: payload.device,
    changes,
  };
}

function v6EntityId(entityType, row = {}) {
  if (entityType === 'task_security_context') return v6Field(row, 'task_run_id', 'taskRunId');
  if (entityType === 'conversation_alias') return v6Field(row, 'alias_conversation_id', 'aliasConversationId') || String(row.id || '').trim();
  if (entityType === 'agent_instance_alias') return v6Field(row, 'alias_instance_id', 'aliasInstanceId');
  if (entityType === 'memory_document_alias') return v6Field(row, 'alias_document_id', 'aliasDocumentId');
  if (entityType === 'memory_sync_mapping') return v6Field(row, 'cloud_key', 'cloudKey');
  if (entityType === 'agent_context_state') return v6Field(row, 'user_agent_instance_id', 'userAgentInstanceId') || String(row.id || '').trim();
  return String(row.id || '').trim();
}

function memoryDocumentCloudPayload(row = {}) {
  const cloudKey = row.cloud_key || row.cloudKey || row.id || '';
  return sanitizeCloudValue({
    ...row,
    id: cloudKey,
    cloud_key: cloudKey,
    local_document_id: undefined,
  });
}

function employeeCatalogBootstrapPayload(payload = {}) {
  const families = Array.isArray(payload.data?.agentFamilies) ? payload.data.agentFamilies : [];
  const versions = Array.isArray(payload.data?.agentVersions) ? payload.data.agentVersions : [];
  if (!families.length && !versions.length) return null;
  const generatedAt = payload.batch?.generatedAt || nowIso();
  return {
    schemaVersion: payload.schemaVersion || 5,
    batch: {
      ...(payload.batch || {}),
      id: `${payload.batch?.id || newId('batch')}:employee-catalog`,
      generatedAt,
      itemCount: families.length + versions.length,
    },
    device: payload.device,
    data: { agentFamilies: families, agentVersions: versions },
    files: [],
  };
}

function stableCloudJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCloudJson(item) ?? 'null').join(',')}]`;
  }
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const properties = [];
  for (const key of Object.keys(value).sort()) {
    const serialized = stableCloudJson(value[key]);
    if (serialized !== undefined) properties.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${properties.join(',')}}`;
}

export function packagedCloudSyncDefaults() {
  const envConfig = normalizeDefaultCloudConfig({
    serverUrl: process.env.JANUS_PACKAGED_CLOUD_URL,
    token: process.env.JANUS_PACKAGED_CLOUD_LEGACY_TOKEN,
    autoSync: true,
  });
  if (envConfig) return envConfig;
  try {
    const packaged = JSON.parse(fs.readFileSync(path.join(assetRoot, 'cloud-sync-defaults.json'), 'utf8'));
    return normalizeDefaultCloudConfig({
      ...packaged,
      token: packaged.legacyGlobalToken === true ? packaged.token : '',
    }) || {};
  } catch {
    return {};
  }
}

function multiMemoryCloudStatus(state = {}, capabilities = {}, configured = false) {
  if (!configured) return { enabled: false, readOnly: true, contractVersion: 0, code: 'cloud_not_configured' };
  if (!state.last_success_at) return { enabled: false, readOnly: true, contractVersion: 0, code: 'cloud_sync_pending' };
  const multiMemory = capabilities?.multiMemory || {};
  if (!multiMemory.enabled || Number(multiMemory.contractVersion || 0) < 2
    || multiMemory.contextSpaces !== true || multiMemory.cloudKeyMappings !== true
    || multiMemory.accountContextState !== true || multiMemory.offlineLocalWrites !== true) {
    return { enabled: false, readOnly: true, contractVersion: Number(multiMemory.contractVersion || 0), code: 'context_space_contract_unsupported' };
  }
  return { enabled: true, readOnly: false, contractVersion: Number(multiMemory.contractVersion), code: 'cloud_context_space_ready' };
}

function employeeCommandFailureStatus(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '');
  if (status === 401 || status === 403
    || /grant|auth|forbidden|unauthorized|device_approval|device_not_approved/i.test(code)) return 'blocked_auth';
  if (code === 'employee_cloud_contract_unsupported' || status === 404) return 'blocked_incompatible_cloud';
  if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) return 'failed_terminal';
  return 'failed';
}

function employeeCommandFailureMessage(error) {
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '').trim();
  const message = String(error?.message || error || 'Cloud employee synchronization failed.').trim();
  return code && !message.startsWith(`${code}:`) ? `${code}: ${message}` : message;
}

function employeeCommandDependencySettled(status = '') {
  return ['confirmed', 'rejected', 'conflict', 'failed_terminal'].includes(String(status || ''));
}

function employeeCommandExecutionOrder(commands = []) {
  const ordered = [];
  const byId = new Map(commands.map((command) => [command.commandId, command]));
  const visited = new Set();
  const visiting = new Set();
  const visit = (command) => {
    if (!command || visited.has(command.commandId)) return;
    if (visiting.has(command.commandId)) {
      ordered.push(command);
      visited.add(command.commandId);
      return;
    }
    visiting.add(command.commandId);
    const dependency = byId.get(command.dependsOnCommandId || command.payload?.dependsOnCommandId || '');
    if (dependency) visit(dependency);
    visiting.delete(command.commandId);
    if (!visited.has(command.commandId)) ordered.push(command);
    visited.add(command.commandId);
  };
  commands.forEach(visit);
  return ordered;
}

function employeeCommandSendingStaleMs(client = {}) {
  const requestTimeoutMs = Math.max(0, Number(
    client.employeeRequestTimeoutMs
      ?? process.env.JANUS_CLOUD_REQUEST_TIMEOUT_MS
      ?? 15_000,
  ));
  return Math.max(60_000, requestTimeoutMs + 30_000);
}

function isCloudGrantAuthorizationError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || error?.body?.error?.code || error?.body?.code || '');
  const message = String(error?.message || error?.body?.error?.message || error?.body?.error || '');
  return status === 401 || status === 403
    || /(?:device|evolution|employee).?grant.*(?:invalid|expired|revoked|unauthori[sz]ed)/i.test(`${code} ${message}`);
}

function normalizeDefaultCloudConfig(value = {}) {
  const serverUrl = normalizeServerUrl(value.serverUrl || value.server_url || '');
  const token = String(value.token || '').trim();
  if (!serverUrl) return null;
  return { serverUrl, token, autoSync: value.autoSync !== false };
}

function ensureCloudState(db, defaultConfig = {}) {
  const row = get(db, 'SELECT * FROM cloud_sync_state WHERE id = ?', [DEFAULT_STATE_ID]);
  const defaults = normalizeDefaultCloudConfig(defaultConfig);
  if (row) {
    if (defaults && (!row.server_url || !row.token)) {
      run(
        db,
        `UPDATE cloud_sync_state
         SET server_url = CASE WHEN server_url = '' THEN ? ELSE server_url END,
             token = CASE WHEN token = '' THEN ? ELSE token END,
             auto_sync = 1,
             updated_at = ?
         WHERE id = ?`,
        [defaults.serverUrl, defaults.token, nowIso(), DEFAULT_STATE_ID],
      );
    }
    return;
  }
  run(
    db,
    `INSERT INTO cloud_sync_state (id, user_id, device_id, server_url, token, auto_sync, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      DEFAULT_STATE_ID,
      newId('user'),
      newId('device'),
      defaults?.serverUrl || '',
      defaults?.token || '',
      defaults?.autoSync === false ? 0 : 1,
      nowIso(),
    ],
  );
}

function ensureCloudEvolutionCutover(db) {
  const existing = get(db, "SELECT value FROM app_settings WHERE key = 'evolution:cloud_cutover_at'");
  if (existing?.value) return existing.value;
  const cutoverAt = nowIso();
  run(db, `INSERT INTO app_settings (key, value, updated_at) VALUES ('evolution:cloud_cutover_at', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [cutoverAt, cutoverAt]);
  run(db, "DELETE FROM evolution_evidence_upload_queue WHERE status != 'uploaded'");
  return cutoverAt;
}

function evolutionEvidenceCursor(db, ownerUserId, sourceKind, cutoverAt = '') {
  const row = get(db, `SELECT cursor_at, cursor_id FROM evolution_evidence_cursors
    WHERE owner_user_id = ? AND source_kind = ?`, [ownerUserId, sourceKind]);
  const cursorAt = String(row?.cursor_at || '');
  return {
    cursorAt: cursorAt && cursorAt >= String(cutoverAt || '') ? cursorAt : String(cutoverAt || ''),
    cursorId: cursorAt && cursorAt >= String(cutoverAt || '') ? String(row?.cursor_id || '') : '',
  };
}

function advanceEvolutionEvidenceCursor(db, ownerUserId, sourceKind, cursorAt, cursorId) {
  if (!cursorAt || !cursorId) return;
  run(db, `INSERT INTO evolution_evidence_cursors (owner_user_id, source_kind, cursor_at, cursor_id, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_user_id, source_kind) DO UPDATE SET
      cursor_at = excluded.cursor_at, cursor_id = excluded.cursor_id, updated_at = excluded.updated_at`,
  [ownerUserId, sourceKind, cursorAt, cursorId, nowIso()]);
}

function ensureLegacyEvidenceBackfill(db,ownerUserId,sourceKind,cutoverAt,upperRow) {
  let row=get(db,'SELECT * FROM evolution_evidence_legacy_backfills WHERE owner_user_id=? AND source_kind=?',[ownerUserId,sourceKind]);
  if(!row){
    const upperBoundAt=String(upperRow?.at||''),upperBoundId=String(upperRow?.id||'');
    const status=upperBoundAt&&upperBoundId?'pending':'completed';
    run(db,`INSERT INTO evolution_evidence_legacy_backfills(owner_user_id,source_kind,upper_bound_at,upper_bound_id,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`,[ownerUserId,sourceKind,upperBoundAt||String(cutoverAt||''),upperBoundId,status,nowIso(),nowIso()]);
    row=get(db,'SELECT * FROM evolution_evidence_legacy_backfills WHERE owner_user_id=? AND source_kind=?',[ownerUserId,sourceKind]);
  }
  return {ownerUserId:row.owner_user_id,sourceKind:row.source_kind,upperBoundAt:row.upper_bound_at,upperBoundId:row.upper_bound_id,
    cursorAt:row.cursor_at,cursorId:row.cursor_id,status:row.status};
}

function advanceLegacyEvidenceBackfill(db,state,cursorAt,cursorId,completed=false) {
  if(!state||state.status==='completed')return;
  run(db,`UPDATE evolution_evidence_legacy_backfills SET cursor_at=?,cursor_id=?,status=?,updated_at=?
    WHERE owner_user_id=? AND source_kind=?`,[cursorAt||state.cursorAt,cursorId||state.cursorId,completed?'completed':'running',nowIso(),state.ownerUserId,state.sourceKind]);
}

function legacyTerminalTaskEvidenceSourceKind(status='') {
  return ({completed:'task_result',accepted:'task_acceptance',rework:'task_rework',failed:'task_failure',
    blocked:'task_blocked',cancelled:'task_cancelled'})[String(status||'')]||'task_result';
}

function legacyTaskLifecycleEvidenceSourceKind(eventType='') {
  if(eventType==='task_created')return 'task_created';
  if(eventType==='task_assigned')return 'task_assigned';
  if(eventType==='task_dependency_changed')return 'task_dependency_changed';
  if(String(eventType).startsWith('graph_'))return 'task_revision';
  return '';
}

function publicState(row) {
  return {
    userId: row.user_id,
    deviceId: row.device_id,
    serverUrl: row.server_url,
    hasToken: Boolean(row.token),
    hasDeviceGrant: Boolean(row.device_grant),
    syncSchemaVersion: Number(row.sync_schema_version || 5),
    autoSync: Boolean(row.auto_sync),
    evolutionEnabled: true,
    evolutionPolicyVersion: 'evolution_mandatory_upload_v1',
    evolutionStateRevision: Number(row.evolution_state_revision || 1),
    evolutionLastCommandId: row.evolution_last_command_id || '',
    evolutionLastCheckedAt: row.evolution_last_checked_at || '',
    evolutionLastCheckError: row.evolution_last_check_error || '',
    lastSyncCursor: row.last_sync_cursor,
    lastV6Cursor: row.last_v6_cursor || '',
    lastIdentityCursor: row.last_identity_cursor || '',
    lastPersonalEvolutionCursor: row.last_personal_evolution_cursor || '',
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function readDesktopPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function evolutionRouteUnavailable(error) {
  return Number(error?.status || 0) === 404
    && String(error?.code || error?.body?.error?.code || '') === 'evolution_route_not_found';
}

function cachedEvolutionPreference(state = {}, error = null) {
  return {
    authority: 'local-cache',
    available: false,
    code: 'evolution_route_not_found',
    message: error?.message || 'Cloud evolution preference is not available.',
    enabled: true,
    policyVersion: 'evolution_mandatory_upload_v1',
    stateRevision: Math.max(1, Number(state.evolution_state_revision || 1)),
    lastCommandId: state.evolution_last_command_id || '',
  };
}

function normalizeBatch(row) {
  return {
    id: row.id,
    reason: row.reason,
    status: row.status,
    cursorFrom: row.cursor_from,
    cursorTo: row.cursor_to,
    retryCount: Number(row.retry_count || 0),
    itemCount: Number(row.item_count || 0),
    fileCount: Number(row.file_count || 0),
    errorText: row.error_text || '',
    response: safeJsonParse(row.response_json, {}),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function normalizeV6Outbox(row = {}) {
  return {
    id: row.id,
    batchId: row.batch_id,
    payloadHash: row.payload_hash,
    serverUrl: row.server_url,
    userId: row.user_id,
    deviceId: row.device_id,
    cursorTo: row.cursor_to || '',
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at || '',
    lastError: row.last_error || '',
    response: safeJsonParse(row.response_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || '',
  };
}

function syncRetryDelayMs(attemptCount) {
  const attempt = Math.max(1, Number(attemptCount || 1));
  return Math.min(60 * 60_000, 5_000 * (2 ** Math.min(8, attempt - 1)));
}

function evolutionEvidenceRetryAt(row = {}, { status = 'failed_retryable', reason = '' } = {}) {
  const attempt = Math.max(1, Number(row.attemptCount || 1));
  const deferredBaseMs = {
    unbound_remote_user: 24 * 60 * 60_000,
    evolution_account_paused: 60 * 60_000,
    agent_instance_not_syncable: 6 * 60 * 60_000,
    memory_sync_disabled: 6 * 60 * 60_000,
    task_memory_local_key_unavailable: 15 * 60_000,
    cloud_source_not_ready: 15 * 60_000,
  }[String(reason || '')] || 15 * 60_000;
  const baseMs = status === 'deferred' ? deferredBaseMs : 60_000;
  const maximumMs = status === 'deferred' ? 24 * 60 * 60_000 : 60 * 60_000;
  const delayMs = Math.min(maximumMs, baseMs * (2 ** Math.min(8, attempt - 1)));
  return new Date(Date.now() + delayMs).toISOString();
}

function mergeReasons(current = '', next = '') {
  const reasons = new Set(
    [current, next]
      .flatMap((value) => String(value || '').split('+'))
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return [...reasons].join('+') || 'event';
}

async function walkIncludedFiles(root, visitor) {
  if (!fs.existsSync(root)) return;
  const walk = async (dir, depth = 0) => {
    if (depth > 10) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        await visitor(full);
      }
    }
  };
  await walk(root, 0);
}

function shouldSyncFile(root, file) {
  const relative = relativeToRoot(root, file);
  const parts = relative.split('/');
  if (!parts.some((part) => SYNC_INCLUDE_DIRS.has(part))) return false;
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return false;
  if (parts.some((part) => SENSITIVE_NAME_RE.test(part))) return false;
  if (/\.(db|sqlite|sqlite3|wal|shm|log|tmp|env)$/i.test(relative)) return false;
  return true;
}

function relativeToRoot(root, file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
