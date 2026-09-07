import crypto from 'node:crypto';

import {
  PERSONAL_EVOLUTION_ALGORITHM_VERSION,
  PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS,
  PERSONAL_MAXIMUM_EVIDENCE,
  PERSONAL_MINIMUM_EVIDENCE,
  PERSONAL_EVOLUTION_RETRY_INTERVAL_MS,
  decryptEvolutionPayload,
  disabledEvolutionCapability,
  encryptEvolutionPayload,
  evolutionEnvelopeCapability,
  evolutionEnvelopePublicKeyringFromEnv,
  evolutionEncryptionReady,
  EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,
  evolutionEvidencePrivacyFindings,
  evolutionEvidencePrivacyPolicyUpgradeable,
  evolutionKeyringFromEnv,
  evolutionWorkerDecryptionKeyringFromEnv,
  hashEvolutionSnapshot,
  evidenceRejectionKindForReason,
  evolutionEvidenceClusterScopeAutomatic,
  normalizeEvolutionEvidenceIdentity,
  normalizeEvolutionEvidenceSourceKind,
  personalEvolutionThresholdEligible,
  PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
  runPersonalEvolutionCore,
  sanitizeEvolutionPayloadForStorage,
  stableEvolutionEvidenceId,
} from '../../../shared/evolution/index.js';
import {
  cloudTaskMemoryEnvelopeCapability,
  cloudTaskMemoryPrivateKeyringFromEnv,
  cloudTaskMemoryPublicKeyringFromEnv,
  decryptTaskMemoryContent,
  unwrapTaskKeyFromCloud,
} from '../../../shared/taskMemoryCrypto.js';
import { normalizeCloudTriggerKind } from '../../../shared/cloudContracts.js';
import { createSqliteAuthoritativeEvidence } from './authoritativeEvidence.js';
import { createSqliteEvidenceUsageLedger } from './evidenceUsageLedger.js';

const ACTIVE_RUN_STATES = new Set(['queued', 'claimed', 'running', 'proposed', 'failed_retryable']);

export function createEvolutionAuthority({ db, env = process.env, modelExecutor = null, keyring = evolutionWorkerDecryptionKeyringFromEnv(env) } = {}) {
  if (!db) throw new Error('Evolution authority requires a cloud database.');
  const enabled = true;
  const databaseConfigured = Boolean(db);
  const encryptionConfigured = evolutionEncryptionReady(keyring) || Boolean(keyring.allowPlaintextTestOnly);
  const testExecutorInjected = typeof modelExecutor === 'function';
  const executeModel = modelExecutor || createPlatformEvolutionModelExecutor({ env });
  const usageLedger = createSqliteEvidenceUsageLedger(db);

  return {
    capabilities() {
      const modelConfigured = Boolean(testExecutorInjected || (env.JANUS_EVOLUTION_PROVIDER_BASE_URL && env.JANUS_EVOLUTION_PROVIDER_API_KEY && env.JANUS_EVOLUTION_MODEL));
      const executionAvailable = Boolean(databaseConfigured && modelConfigured && encryptionConfigured);
      return {
        authority: 'cloud',
        authorityLocked: true,
        enabled: true,
        evidenceEnvelope: evolutionEnvelopeCapability(evolutionEnvelopePublicKeyringFromEnv(env)),
        taskMemoryEncryption: cloudTaskMemoryEnvelopeCapability(cloudTaskMemoryPublicKeyringFromEnv(env)),
        personal: {
          authority: 'cloud',
          authorityLocked: true,
          enabled: true,
          mutationEnabled: executionAvailable,
          executionAvailable,
          readiness: { database: databaseConfigured, model: modelConfigured, encryption: encryptionConfigured },
          evaluationIntervalMs: PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS,
          retryIntervalMs: PERSONAL_EVOLUTION_RETRY_INTERVAL_MS,
          algorithmVersion: PERSONAL_EVOLUTION_ALGORITHM_VERSION,
          minimumEvidence: PERSONAL_MINIMUM_EVIDENCE,
          maximumEvidence: PERSONAL_MAXIMUM_EVIDENCE,
          code: executionAvailable ? 'ok' : !databaseConfigured ? 'evolution_database_unavailable'
            : !encryptionConfigured ? 'evolution_encryption_key_unavailable' : 'evolution_model_unavailable',
        },
        cluster: disabledEvolutionCapability('cluster'),
        market: { ...disabledEvolutionCapability('market'), code: 'market_evolution_not_enabled' },
      };
    },

    issueGrant({ userId = '', deviceId = '', scopes = ['evolution:read', 'evolution:write'], ttlDays = 30 } = {}) {
      const cleanUserId = String(userId || '').trim();
      const cleanDeviceId = String(deviceId || '').trim();
      if (!cleanUserId || !cleanDeviceId) throw apiError('evolution_grant_subject_required', 'Evolution grant requires user and device identity.', 400);
      const token = `evg_${crypto.randomBytes(32).toString('base64url')}`;
      const id = `grant_${crypto.randomUUID()}`;
      const now = nowIso();
      const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays || 30)) * 86400000).toISOString();
      db.prepare(`INSERT INTO cloud_sync_grants (id, user_id, device_id, token_hash, scopes_json, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET token_hash = excluded.token_hash, scopes_json = excluded.scopes_json,
          status = 'active', expires_at = excluded.expires_at, updated_at = excluded.updated_at`).run(
        id, cleanUserId, cleanDeviceId, sha256(token), JSON.stringify(uniqueStrings(scopes)), expiresAt, now, now,
      );
      return { token, userId: cleanUserId, deviceId: cleanDeviceId, scopes: uniqueStrings(scopes), expiresAt };
    },

    listGrants({ userId = '' } = {}) {
      const cleanUserId = String(userId || '').trim();
      return db.prepare(`SELECT id, user_id, device_id, scopes_json, status, expires_at, created_at, updated_at
        FROM cloud_sync_grants WHERE user_id = ? ORDER BY updated_at DESC`).all(cleanUserId).map((row) => ({
        id: row.id, userId: row.user_id, deviceId: row.device_id, scopes: parseArray(row.scopes_json),
        status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at,
      }));
    },

    revokeGrant({ userId = '', deviceId = '' } = {}) {
      const result = db.prepare(`UPDATE cloud_sync_grants SET status = 'revoked', token_hash = ?, updated_at = ?
        WHERE user_id = ? AND device_id = ? AND status != 'revoked'`).run(
        `revoked:${crypto.randomUUID()}`, nowIso(), String(userId || '').trim(), String(deviceId || '').trim(),
      );
      return { status: result.changes ? 'revoked' : 'not_found', deviceId: String(deviceId || '').trim() };
    },

    requireGrant(token = '', requiredScope = 'evolution:read') {
      const row = db.prepare('SELECT * FROM cloud_sync_grants WHERE token_hash = ?').get(sha256(String(token || '')));
      if (!row || row.status !== 'active' || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
        throw apiError('evolution_grant_invalid', 'Evolution device grant is invalid or expired.', 401);
      }
      const scopes = parseArray(row.scopes_json);
      const requiredScopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
      const allowed = requiredScopes.filter(Boolean).some((scope) => {
        if (scopes.includes(scope)) return true;
        const namespace = String(scope).split(':')[0];
        return scopes.includes(`${namespace}:*`);
      });
      if (requiredScopes.some(Boolean) && !allowed) {
        throw apiError('evolution_grant_scope_denied', 'Evolution device grant does not allow this operation.', 403);
      }
      return { id: row.id, userId: row.user_id, deviceId: row.device_id, scopes, expiresAt: row.expires_at };
    },

    preference(grant) {
      return readSqliteEvolutionPreference(db, grant.userId);
    },

    setPreference(grant, payload = {}) {
      return updateSqliteEvolutionPreference(db, { userId: grant.userId, deviceId: grant.deviceId, ...payload });
    },

    ingestEvidence(grant, items = []) {
      assertAuthorityEnabled(enabled);
      if (!encryptionConfigured) throw apiError('evolution_encryption_key_unavailable', 'Evolution evidence encryption is not configured.', 503);
      const accepted = [];
      const duplicates = [];
      const quarantined = [];
      const rejected = [];
      const results = [];
      transaction(db, () => {
        for (const input of Array.isArray(items) ? items.slice(0, 500) : []) {
          const clientRecordId = String(input?.clientRecordId || input?.client_record_id || '').trim();
          db.exec('SAVEPOINT evolution_evidence_ingest_item');
          try {
            const instanceId = String(input.userAgentInstanceId || input.user_agent_instance_id || '').trim();
            const instance = requireOwnedInstance(db, grant.userId, instanceId);
            const occurredAt = new Date(input.occurredAt || input.occurred_at || Date.now());
            const inactiveCutoff = instance.deactivated_at ? new Date(instance.deactivated_at) : null;
            const historicalInactive = instance.status === 'inactive' && inactiveCutoff && occurredAt <= inactiveCutoff;
            if ((!historicalInactive && instance.status !== 'active') || !Number(instance.sync_enabled)) {
              throw apiError('evolution_evidence_not_allowed', 'Agent is not active and synchronized, and the Evidence is not eligible inactive history.', 409);
            }
            const sourceKind = normalizeEvolutionEvidenceSourceKind(input.sourceKind || input.source_kind);
            let allowedEvolutionScopes = normalizeEvolutionScopes(
              input.allowedEvolutionScopes || input.allowed_evolution_scopes,
              instance,
              sourceKind,
            );
            if (historicalInactive) allowedEvolutionScopes = [];
            if (!historicalInactive && !allowedEvolutionScopes.length) throw apiError('evolution_evidence_not_allowed', 'No authorized evolution scope is available for this evidence.', 403);
            const evolutionEnvelope=normalizeSqliteEvolutionEnvelope(input.evolutionEnvelope||input.evolution_envelope);
            if(env.NODE_ENV==='production'&&!evolutionEnvelope)throw apiError('evolution_envelope_required',
              'Production evolution Evidence must use the Evolution Worker public-key envelope.',400);
            const content = evolutionEnvelope?'':resolveEvidenceContent(db, grant.userId, input, env);
            if (!evolutionEnvelope&&(!content.trim() || Buffer.byteLength(content, 'utf8') > 128 * 1024)) throw apiError('evidence_content_invalid', 'Evolution evidence content is empty or too large.', 400);
            const contentHash = String(input.contentHash || input.content_hash || (content?sha256(content):''));
            if (!contentHash||(!evolutionEnvelope&&contentHash !== sha256(content))) throw apiError('evidence_hash_mismatch', 'Evolution evidence content hash is invalid.', 400);
            const normalized = normalizeEvolutionEvidenceIdentity({
              ownerUserId: grant.userId,
              userAgentInstanceId: instance.id,
              sourceKind,
              sourceId: input.sourceId || input.source_id,
              sourceVersionId: input.sourceVersionId || input.source_version_id || '',
              contentHash,
            });
            const sourceValidationScopes = historicalInactive ? ['cluster'] : allowedEvolutionScopes;
            if (clientRecordId || taskEvidenceSourceKind(normalized.sourceKind)) {
              allowedEvolutionScopes = validateAuthoritativeEvidenceSource(
                db, grant.userId, instance, normalized, sourceValidationScopes,
                { requireTaskEvent: Boolean(clientRecordId) },
              );
            } else {
              allowedEvolutionScopes = validateEvidenceSourceAuthorization(db, grant.userId, instance, normalized, sourceValidationScopes);
            }
            if (historicalInactive) allowedEvolutionScopes = [];
            const evidenceId = stableEvolutionEvidenceId(normalized);
            if (input.evidenceId && input.evidenceId !== evidenceId) throw apiError('evidence_id_mismatch', 'Evolution evidence ID is not canonical.', 400);
            const encrypted = evolutionEnvelope||encryptEvolutionPayload(content, keyring);
            const quarantineReason = evolutionEnvelope?'':evidenceQuarantineReason(content, input.quarantineReason || input.quarantine_reason || '');
            const result = db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence (
              evidence_id, owner_user_id, user_agent_instance_id, agent_family_id, source_kind, source_id,
              source_version_id, context_space_id, task_id, delegation_id, content_hash, content_ciphertext,
              content_nonce, content_tag, encryption_algorithm, key_id, confidence, privacy_level,
              quarantine_reason, personal_threshold_eligible, eligibility_policy_version, occurred_at, metadata_json,
              lineage_key,validation_status,validation_policy_version,validation_json,validated_at,historical_inactive,
              wrapped_data_key,key_wrap_algorithm,key_version,envelope_format
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              evidenceId, grant.userId, instance.id, instance.agent_family_id, normalized.sourceKind, normalized.sourceId,
              normalized.sourceVersionId, input.contextSpaceId || input.context_space_id || '', input.taskId || input.task_id || '',
              input.delegationId || input.delegation_id || '', contentHash, encrypted.ciphertext, encrypted.nonce, encrypted.tag,
              encrypted.algorithm, encrypted.keyId, sqliteValidatedEvidenceConfidence(sourceKind,input), input.privacyLevel || input.privacy_level || 'owner_private',
              quarantineReason, personalEvolutionThresholdEligible(sourceKind) ? 1 : 0,
              PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION, occurredAt.toISOString(),
              JSON.stringify({ ...(input.metadata || {}), allowedEvolutionScopes, uploadedByDeviceId: grant.deviceId,
                claimedConfidence:Number(input.confidence??1),historicalInactive,sourceAuthority: clientRecordId ? 'authoritative' : 'legacy_compat' }),
              String(input.lineageKey || input.lineage_key || input.metadata?.lineageKey || `${sourceKind}:${normalized.sourceId}:${normalized.sourceVersionId}`),
              quarantineReason?'quarantined':evolutionEnvelope?'pending_validation':'validated','cloud_evidence_validation_v1',
              JSON.stringify(evolutionEnvelope?{}:sqliteValidatedEvidenceSummary(sourceKind,input)),
              quarantineReason||evolutionEnvelope?'':nowIso(),historicalInactive?1:0,encrypted.wrappedDataKey||'',encrypted.keyWrapAlgorithm||'',
              Number(encrypted.keyVersion||0),encrypted.envelopeFormat||'legacy_symmetric',
            );
            if(evolutionEnvelope&&result.changes)db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence_validation_jobs
              (evidence_id,status,available_at,created_at,updated_at) VALUES(?,'queued',?,?,?)`).run(evidenceId,nowIso(),nowIso(),nowIso());
            if (!evolutionEnvelope&&!quarantineReason && allowedEvolutionScopes.includes('personal')) {
              usageLedger.ensureAvailable({ evidenceId, scope: 'personal', consumerId: instance.id });
            }
            db.exec('RELEASE SAVEPOINT evolution_evidence_ingest_item');
            if (!result.changes) {
              duplicates.push(evidenceId);
              results.push(evidenceIngestResult({ clientRecordId, evidenceId, input, status: 'duplicate' }));
            } else if (quarantineReason) {
              quarantined.push({ evidenceId, reason: quarantineReason });
              results.push(evidenceIngestResult({ clientRecordId, evidenceId, input, status: 'quarantined', code: quarantineReason, message: quarantineReason }));
            } else {
              accepted.push(evidenceId);
              results.push(evidenceIngestResult({ clientRecordId, evidenceId, input, status: 'accepted' }));
            }
          } catch (error) {
            try { db.exec('ROLLBACK TO SAVEPOINT evolution_evidence_ingest_item'); } catch {}
            try { db.exec('RELEASE SAVEPOINT evolution_evidence_ingest_item'); } catch {}
            rejected.push({ sourceId: input?.sourceId || input?.source_id || '', code: error.code || 'evidence_rejected', message: error.message });
            results.push(evidenceIngestResult({ clientRecordId, input, status: error.retryable ? 'deferred' : 'rejected',
              code: error.code || 'evidence_rejected', message: error.message, retryable: Boolean(error.retryable) }));
          }
        }
      });
      return { status: rejected.length || quarantined.length || results.some((item) => item.status === 'deferred') ? 'partial' : 'accepted',
        accepted, duplicates, quarantined, rejected, results };
    },

    evidenceCounts(grant, { agentInstanceId = '' } = {}) {
      assertAuthorityEnabled(enabled);
      const instance = requireOwnedInstance(db, grant.userId, agentInstanceId);
      const counts = usageLedger.counts({ ownerUserId:grant.userId,agentInstanceId:instance.id });
      return { agentInstanceId: instance.id, available: counts.available || 0, counts };
    },

    listEvidenceUsage(grant, { agentInstanceId = '', scope = '', status = '', cursor = '', limit = 50 } = {}) {
      const instance = requireOwnedInstance(db, grant.userId, agentInstanceId);
      const decoded = decodeUsageCursor(cursor);
      const pageSize=Math.min(200,Math.max(1,Number(limit||50)));
      const rows=usageLedger.listUsage({ownerUserId:grant.userId,agentInstanceId:instance.id,scope,status,cursor:decoded,limit:pageSize+1});
      const page=rows.slice(0,pageSize);
      return {authority:'cloud',agentInstanceId:instance.id,items:page.map(evidenceUsageListPayload),
        nextCursor:rows.length>pageSize?encodeUsageCursor(page.at(-1)):''};
    },

    personalSchedule(grant, { agentInstanceId = '' } = {}) {
      const instance = requireOwnedInstance(db, grant.userId, agentInstanceId);
      ensurePersonalScheduleState(db, instance.id);
      return personalSchedulePayload(db, grant.userId, instance.id);
    },

    listPersonalSchedules(grant) {
      const instances = db.prepare('SELECT id FROM cloud_user_agent_instances_v3 WHERE user_id = ? ORDER BY id').all(grant.userId);
      for (const instance of instances) ensurePersonalScheduleState(db, instance.id);
      return instances.map((instance) => personalSchedulePayload(db, grant.userId, instance.id));
    },

    requestPersonalRun(grant, { agentInstanceId = '', triggerKind = 'manual', force = false } = {}) {
      const capability = this.capabilities().personal;
      if (!capability.executionAvailable) return { status: 'unavailable', authority: 'cloud', code: capability.code };
      const result = queuePersonalEvolutionRun({ db, userId: grant.userId, agentInstanceId, triggerKind, force, keyring });
      if (result.status !== 'queued') return result;
      const runId = result.run.id;
      return { status: 'queued', authority: 'cloud', run: this.getRun(grant, runId) };
    },

    listRuns(grant, { agentInstanceId = '', limit = 30 } = {}) {
      assertAuthorityEnabled(enabled);
      const params = [grant.userId];
      let filter = '';
      if (agentInstanceId) { requireOwnedInstance(db, grant.userId, agentInstanceId); filter = ' AND user_agent_instance_id = ?'; params.push(agentInstanceId); }
      params.push(Math.min(100, Math.max(1, Number(limit || 30))));
      return db.prepare(`SELECT * FROM cloud_evolution_runs WHERE owner_user_id = ?${filter} ORDER BY created_at DESC LIMIT ?`).all(...params).map(runPayload);
    },

    getRun(grant, runId = '') {
      assertAuthorityEnabled(enabled);
      const row = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ? AND owner_user_id = ?').get(runId, grant.userId);
      if (!row) throw apiError('evolution_run_not_found', 'Evolution run was not found.', 404);
      const evaluations = db.prepare('SELECT * FROM cloud_evolution_evaluations WHERE run_id = ? ORDER BY evaluation_kind, case_index').all(row.id)
        .map((item) => ({ ...item, regression: Boolean(item.regression), result: parseObject(item.result_json) }));
      const proposalRow = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id = ? AND id = ?').get(grant.userId, row.id);
      const memoryOperations = db.prepare(`SELECT * FROM cloud_personal_evolution_memory_operations_v4
        WHERE user_id = ? AND proposal_id = ? ORDER BY created_at, id`).all(grant.userId, row.id).map(evolutionPayload);
      const actions = db.prepare(`SELECT * FROM cloud_personal_evolution_actions_v4
        WHERE user_id = ? AND proposal_id = ? ORDER BY received_at, id`).all(grant.userId, row.id).map(evolutionPayload);
      const candidate = row.candidate_personal_skill_version_id
        ? db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND id = ?').get(grant.userId, row.candidate_personal_skill_version_id)
        : null;
      const evidenceUsage = usageLedger.runUsage({runId:row.id,scope:row.evolution_scope,consumerId:row.consumer_id}).map(evidenceUsagePayload);
      return {
        ...runPayload(row),
        evaluations,
        proposal: proposalRow ? evolutionPayload(proposalRow) : null,
        memoryOperations,
        actions,
        evidenceUsage,
        candidateVersion: candidate ? skillVersionPayload(candidate) : null,
      };
    },

    decidePersonalRun(grant, { runId = '', decisions = [], skillDecision = '', memoryDecisions = [] } = {}) {
      assertAuthorityEnabled(enabled);
      const normalized = normalizeRunDecisions({ runId, decisions, skillDecision, memoryDecisions });
      if (normalized.some((item) => item.targetKind === 'skill')) {
        throw apiError('personal_version_activation_required', 'Use the personal version activation endpoint to change the active Skill.', 409);
      }
      return applyPersonalDecisions(db, {
        userId: grant.userId,
        runId,
        decisions: normalized,
        actorDeviceId: grant.deviceId,
        automatic: false,
        keyring,
      });
    },

    listVersions(grant, { agentInstanceId = '' } = {}) {
      assertAuthorityEnabled(enabled);
      requireOwnedInstance(db, grant.userId, agentInstanceId);
      return db.prepare(`SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND user_agent_instance_id = ?
        ORDER BY created_at DESC, id DESC`).all(grant.userId, agentInstanceId).map(skillVersionPayload);
    },

    activatePersonalVersion(grant, payload = {}) {
      return changeSqlitePersonalVersion(db, { userId: grant.userId, deviceId: grant.deviceId, action: 'activate', ...payload });
    },

    rollbackPersonalVersion(grant, { agentInstanceId = '', targetVersionId = '', memoryDocumentId = '', targetMemoryVersionId = '',
      commandId = '', expectedActiveVersionId } = {}) {
      assertAuthorityEnabled(enabled);
      const instance = requireOwnedInstance(db, grant.userId, agentInstanceId);
      if (memoryDocumentId) return rollbackSqliteMemoryVersion(db, { userId: grant.userId, instance, memoryDocumentId,
        targetVersionId: targetMemoryVersionId || targetVersionId });
      return changeSqlitePersonalVersion(db, { userId: grant.userId, deviceId: grant.deviceId, agentInstanceId: instance.id,
        targetVersionId, commandId, expectedActiveVersionId, action: 'rollback' });
    },

    updates(grant, { stage8 } = {}) {
      return sqliteEvolutionUpdates(db, stage8, grant.userId);
    },

    clusterStatus() { return disabledEvolutionCapability('cluster'); },
    marketStatus() { return { ...disabledEvolutionCapability('market'), code: 'market_evolution_not_enabled' }; },
    mutateCluster() { throw apiError('cluster_evolution_not_enabled', 'Cluster evolution is not enabled.', 409); },
    mutateMarket() { throw apiError('market_evolution_not_enabled', 'Market evolution is not enabled.', 409); },

    async tickWorker({ workerId = `embedded_${process.pid}`, limit = 1 } = {}) {
      requeueSqliteEvidenceForValidationPolicy(db);
      requeueSqliteEvidenceForAvailableKeys(db,{keyring});
      validatePendingSqliteEvidence(db,{workerId,limit:Math.max(5,Number(limit||1)*5),keyring});
      usageLedger.releaseExpired();
      reconcileLegacyProposedRuns(db, { limit: Math.max(5, Number(limit || 1) * 5), keyring });
      const capability = this.capabilities().personal;
      if (!capability.executionAvailable) return { status: 'unavailable', authority: 'cloud', code: capability.code, completed: [] };
      const scheduled = scheduleDuePersonalEvolutionRuns(db, { limit: Math.max(5, Number(limit || 1) * 5), keyring });
      const completed = [];
      const safeLimit = Math.min(5, Math.max(1, Number(limit || 1)));
      for (let index = 0; index < safeLimit; index += 1) {
        const job = claimJob(db, workerId);
        if (!job) break;
        try {
          const result = await executePersonalJob({ db, job, executeModel, keyring });
          completed.push(result);
        } catch (error) {
          const failure = failJob(db, job, error);
          completed.push({ runId: job.run_id, status: failure.status, error: error.message || String(error) });
        }
      }
      return { status: 'ok', authority: 'cloud', workerId, scheduled, completed };
    },

    evaluateVersionHealth({ userId = '', agentInstanceId = '', score = 0, failureRate = 0, completedTaskCount = 0, inputHash = '' } = {}) {
      const instance = requireOwnedInstance(db, userId, agentInstanceId);
      if (!instance.active_personal_skill_version_id || Number(completedTaskCount || 0) < 10) return { status: 'collecting', minimumTasks: 10 };
      const versionId = instance.active_personal_skill_version_id;
      const existing = db.prepare('SELECT * FROM cloud_personal_version_health WHERE personal_skill_version_id = ?').get(versionId);
      const performanceInputHash = String(inputHash || `manual:${completedTaskCount}:${score}:${failureRate}`);
      if (existing?.last_performance_input_hash === performanceInputHash) {
        return { status: existing.status, consecutiveRegressionWindows: Number(existing.consecutive_regression_windows || 0), unchanged: true };
      }
      const baselineScore = existing ? Number(existing.baseline_score) : Number(score);
      const baselineFailure = existing ? Number(existing.baseline_failure_rate) : Number(failureRate);
      const regressed = baselineScore - Number(score) >= 10 && Number(failureRate) - baselineFailure >= 0.10;
      const windows = regressed ? Number(existing?.consecutive_regression_windows || 0) + 1 : 0;
      const status = windows >= 2 ? 'rollback_required' : regressed ? 'regressing' : 'healthy';
      db.prepare(`INSERT INTO cloud_personal_version_health (
        personal_skill_version_id, user_agent_instance_id, baseline_score, baseline_failure_rate, observed_task_count,
        latest_score, latest_failure_rate, consecutive_regression_windows, last_performance_input_hash, status, evaluated_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(personal_skill_version_id) DO UPDATE SET observed_task_count = excluded.observed_task_count,
        latest_score = excluded.latest_score, latest_failure_rate = excluded.latest_failure_rate,
        consecutive_regression_windows = excluded.consecutive_regression_windows,
        last_performance_input_hash = excluded.last_performance_input_hash, status = excluded.status,
        evaluated_at = excluded.evaluated_at, updated_at = excluded.updated_at`).run(
        versionId, instance.id, baselineScore, baselineFailure, completedTaskCount, score, failureRate, windows,
        performanceInputHash, status, nowIso(), nowIso(),
      );
      if (windows >= 2) {
        const current = db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND id = ?').get(userId, versionId);
        const previous = current?.parent_version_id
          ? db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND id = ?').get(userId, current.parent_version_id)
          : null;
        let memoryRollbacks = [];
        transaction(db, () => {
          activateVersion(db, { userId, instance, nextVersion: previous, runId: '', action: 'automatic_health_rollback', withinTransaction: true });
          memoryRollbacks = rollbackSqliteRunMemoryOperations(db, {
            userId, instance, runId: current?.source_evolution_run_id || '', withinTransaction: true,
          });
          db.prepare("UPDATE cloud_personal_version_health SET status = 'rolled_back', updated_at = ? WHERE personal_skill_version_id = ?").run(nowIso(), versionId);
        });
        return { status: 'rolled_back', previousVersionId: previous?.id || '', memoryRollbacks };
      }
      return { status, consecutiveRegressionWindows: windows };
    },
  };
}

function reconcileLegacyProposedRuns(db, { limit = 25, keyring } = {}) {
  const rows = db.prepare(`SELECT id FROM cloud_evolution_runs
    WHERE evolution_scope='personal' AND status='proposed'
    ORDER BY updated_at,id LIMIT ?`).all(Math.min(100, Math.max(1, Number(limit || 25))));
  for (const row of rows) {
    transaction(db, () => {
      const run = db.prepare("SELECT * FROM cloud_evolution_runs WHERE id=? AND evolution_scope='personal' AND status='proposed'").get(row.id);
      if (!run) return;
      const proposalRow = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id=? AND id=?').get(run.owner_user_id, run.id);
      const proposal = proposalRow ? evolutionPayload(proposalRow) : {};
      const candidateId = run.candidate_personal_skill_version_id || proposal.candidatePersonalSkillVersionId || '';
      if (!proposalRow || !candidateId) {
        markLegacyProposalStale(db, { run, proposalRow, candidateId, reason: 'legacy_candidate_missing' });
        return;
      }
      const action = db.prepare(`SELECT id FROM cloud_personal_evolution_actions_v4
        WHERE user_id=? AND proposal_id=? AND target_kind='skill' AND target_id=?`).get(run.owner_user_id, run.id, candidateId);
      if (action) return;
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(run.owner_user_id, run.user_agent_instance_id);
      const baselineMatches = instance
        && instance.status === 'active'
        && Number(instance.sync_enabled)
        && Number(instance.personal_evolution_consent)
        && String(instance.base_agent_version_id || '') === String(run.base_agent_version_id || '')
        && String(instance.active_personal_skill_version_id || '') === String(run.base_personal_skill_version_id || '');
      if (!baselineMatches) {
        markLegacyProposalStale(db, { run, proposalRow, candidateId, reason: 'legacy_proposal_stale' });
        return;
      }
      applyPersonalDecisions(db, {
        userId: run.owner_user_id,
        runId: run.id,
        decisions: [{ targetKind: 'skill', targetId: candidateId, decision: 'accept' }],
        actorDeviceId: 'cloud-authority-legacy-convergence',
        automatic: true,
        withinTransaction: true,
        keyring,
      });
    });
  }
}

function markLegacyProposalStale(db, { run, proposalRow, candidateId, reason }) {
  const now = nowIso();
  if (candidateId) db.prepare(`UPDATE cloud_user_agent_skill_versions_v3 SET status='archived',updated_at=?
    WHERE user_id=? AND id=? AND status='candidate'`).run(now, run.owner_user_id, candidateId);
  if (proposalRow) {
    const payload = { ...evolutionPayload(proposalRow), status: 'legacy_proposal_stale', decision: 'stale',
      legacyStaleReason: reason, updatedAt: now };
    db.prepare(`UPDATE cloud_personal_evolution_proposals_v4 SET status='legacy_proposal_stale',payload_json=?,updated_at=?
      WHERE user_id=? AND id=?`).run(JSON.stringify(payload), now, run.owner_user_id, run.id);
  }
  db.prepare(`UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code='legacy_proposal_stale',
    error_text=?,completed_at=?,updated_at=? WHERE id=?`).run(reason, now, now, run.id);
  createSqliteEvidenceUsageLedger(db).transitionRun({scope:'personal',consumerId:run.consumer_id||run.user_agent_instance_id,
    runId:run.id,toStatus:'released',transitionReason:'legacy_proposal_stale',now});
  db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET last_status='legacy_proposal_stale',last_run_id=?,updated_at=?
    WHERE user_agent_instance_id=?`).run(run.id, now, run.user_agent_instance_id);
}

function resolveEvidenceContent(db, userId, input = {}, env = process.env) {
  if (!input.encryptedContent && !input.encrypted_content) return String(input.content || '');
  const encrypted = input.encryptedContent || input.encrypted_content;
  const taskRunId = String(input.taskId || input.task_id || '');
  if ((input.sourceKind || input.source_kind) !== 'memory_version' || !taskRunId) {
    throw apiError('encrypted_evidence_source_invalid', 'Encrypted evidence must be a task Memory version.', 400);
  }
  const context = db.prepare(`SELECT * FROM cloud_task_security_contexts_v5
    WHERE user_id=? AND task_run_id=?`).get(userId, taskRunId);
  if (!context || !Number(context.cloud_evolution_allowed) || context.cloud_envelope_state !== 'active' || context.status !== 'active') {
    throw apiError('task_cloud_evolution_not_allowed', 'Task cloud evolution authorization is inactive.', 403);
  }
  const payload = parseObject(context.payload_json);
  const dataKey = unwrapTaskKeyFromCloud({
    algorithm: payload.cloud_wrap_algorithm || payload.cloudWrapAlgorithm || '',
    keyId: payload.cloud_wrapping_key_id || payload.cloudWrappingKeyId || '',
    wrappedKey: payload.cloud_wrapped_key || payload.cloudWrappedKey || '',
  }, cloudTaskMemoryPrivateKeyringFromEnv(env));
  return decryptTaskMemoryContent({
    algorithm: encrypted.algorithm,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    tag: encrypted.tag,
    aad: encrypted.aad,
  }, dataKey);
}

async function executePersonalJob({ db, job, executeModel, keyring }) {
  const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ?').get(job.run_id);
  if (!run) throw terminalError('evolution_run_not_found', 'Evolution run is missing.');
  const instance = requireOwnedInstance(db, run.owner_user_id, run.user_agent_instance_id);
  db.prepare("UPDATE cloud_evolution_runs SET status = 'running', updated_at = ? WHERE id = ?").run(nowIso(), run.id);
  db.prepare("UPDATE cloud_evolution_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(nowIso(), job.id);
  const evidenceRows = db.prepare(`SELECT e.* FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id = e.evidence_id
    WHERE u.run_id = ? AND u.evolution_scope = 'personal' AND u.consumer_id = ? AND u.status = 'reserved'
    ORDER BY e.occurred_at, e.evidence_id`).all(run.id, instance.id);
  if (evidenceRows.length < PERSONAL_MINIMUM_EVIDENCE) {
    releaseEvidence(db, run.id, instance.id, { transitionReason: 'insufficient_evidence' });
    finishRejected(db, run.id, job.id, 'insufficient_evidence', 'Reserved evidence fell below the required threshold.', 'skipped', false);
    return { runId: run.id, status: 'skipped' };
  }
  const evidence = evidenceRows.map((row) => {
    let content = '';
    try {
      content = decryptEvolutionPayload({
        algorithm: row.encryption_algorithm, keyId: row.key_id, ciphertext: row.content_ciphertext,
        nonce: row.content_nonce, tag: row.content_tag, wrappedDataKey: row.wrapped_data_key,
      }, keyring);
      auditMemoryRead(db, { run, evidenceId: row.evidence_id, result: 'allowed' });
    } catch (error) {
      auditMemoryRead(db, { run, evidenceId: row.evidence_id, result: `denied:${error.message}` });
      throw error;
    }
    return { evidenceId: row.evidence_id, sourceKind: row.source_kind, role: row.source_kind === 'message' ? 'conversation' : row.source_kind, content, occurredAt: row.occurred_at };
  });
  const family = payloadOf(db.prepare('SELECT * FROM cloud_agent_families_v3 WHERE id = ?').get(instance.agent_family_id));
  const frozen = loadPersonalRunSnapshot(db,run.id,keyring);
  if (JSON.stringify([...frozen.evidenceIds].sort()) !== JSON.stringify(evidence.map((item)=>item.evidenceId).sort())) {
    throw terminalError('evolution_snapshot_evidence_mismatch','Reserved Evidence no longer matches the immutable run snapshot.');
  }
  const result = await runPersonalEvolutionCore({
    subject: {
      userId: run.owner_user_id, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id,
      departmentId: family.department_id || family.departmentId || '',
    },
    evidenceSnapshot: evidence,
    baseSkill: frozen.baseSkill,
    personalOverlay: frozen.overlay,
    memoryDocuments: frozen.memoryDocuments,
    reviewerType: reviewerTypeForFamily(family, instance.agent_family_id),
    modelExecutor: executeModel,
    algorithmVersion: run.algorithm_version,
  });
  storeEvaluations(db, run.id, result);
  if (result.status !== 'approved') {
    finishRejected(db, run.id, job.id, result.reason || 'evaluated_rejected', result.reason || 'Evolution candidate was rejected.', 'evaluated_rejected', true);
    rejectEvidence(db, run.id, instance.id, {
      rejectionKind: evidenceRejectionKindForReason(result.reason),
      transitionReason: result.reason || 'evaluated_rejected',
    });
    return { runId: run.id, status: 'evaluated_rejected', reason: result.reason };
  }
  let version;
  transaction(db, () => {
    version = createCloudPersonalVersion(db, { run, instance, overlayText: result.candidateOverlay,
      baseSkill: frozen.baseSkill });
    const now = nowIso();
    persistCloudProposal(db, { run, instance, version, result, evidenceRows, withinTransaction: true });
    db.prepare(`UPDATE cloud_evolution_runs SET status = 'available', candidate_personal_skill_version_id = ?, summary = ?,
      completed_at = ?, updated_at = ? WHERE id = ?`).run(version.id, String(result.proposal?.summary || ''), now, now, run.id);
    db.prepare("UPDATE cloud_evolution_jobs SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, job.id);
    consumeEvidence(db, run.id, instance.id, { transitionReason: 'personal_version_available' });
    db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET last_status='available',last_run_id=?,updated_at=?
      WHERE user_agent_instance_id=?`).run(run.id, now, instance.id);
  });
  return { runId: run.id, status: 'available', versionId: version.id, autoActivated: false };
}

export function createPlatformEvolutionModelExecutor({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const baseUrl = String(env.JANUS_EVOLUTION_PROVIDER_BASE_URL || '').replace(/\/$/, '');
  const apiKey = String(env.JANUS_EVOLUTION_PROVIDER_API_KEY || '');
  const primaryModel = String(env.JANUS_EVOLUTION_MODEL || '');
  const reviewModel = String(env.JANUS_EVOLUTION_REVIEW_MODEL || primaryModel);
  const executor = async ({ prompt = '', modelRole = '' } = {}) => {
    if (!baseUrl || !apiKey || !primaryModel) throw apiError('evolution_worker_unavailable', 'Platform evolution model is not configured.', 503);
    const model = /review|judge|evaluator|hr/.test(modelRole) ? reviewModel : primaryModel;
    const response = await fetchImpl(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: prompt, store: false }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError('evolution_model_failed', payload?.error?.message || `Evolution model failed with HTTP ${response.status}.`, response.status >= 500 ? 503 : 502);
    const text = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || item.output_text || '').join('\n') || '';
    if (!text) throw apiError('evolution_model_empty', 'Evolution model returned no text.', 502);
    return text;
  };
  Object.defineProperty(executor, 'available', { value: Boolean(baseUrl && apiKey && primaryModel), enumerable: false });
  return executor;
}

export function queuePersonalEvolutionRun({
  db,
  userId = '',
  agentInstanceId = '',
  triggerKind = 'manual',
  force: _force = false,
  now = new Date(),
  keyring,
} = {}) {
  if (!db) throw new Error('Personal evolution queue requires a database.');
  const usageLedger = createSqliteEvidenceUsageLedger(db);
  const evaluatedAt = now.toISOString();
  const normalizedTriggerKind = normalizeCloudTriggerKind(triggerKind);
  return transaction(db, () => {
    const instance = requireEvolutionEligibleInstance(db, userId, agentInstanceId);
    ensurePersonalScheduleState(db, instance.id, evaluatedAt);
    const schedule = db.prepare('SELECT * FROM cloud_personal_evolution_schedule_states WHERE user_agent_instance_id = ?').get(instance.id);
    const active = db.prepare(`SELECT * FROM cloud_evolution_runs WHERE user_agent_instance_id = ?
      AND evolution_scope = 'personal' AND status IN ('queued','claimed','running','proposed','failed_retryable')
      ORDER BY created_at DESC LIMIT 1`).get(instance.id);
    if (active) return { status: 'deferred', authority: 'cloud', reason: 'personal_evolution_already_running', run: runPayload(active) };
    if (schedule?.next_eligible_at && Date.parse(schedule.next_eligible_at) > now.getTime()) {
      return { status: 'deferred', authority: 'cloud', reason: 'personal_evolution_not_due', nextEligibleAt: schedule.next_eligible_at };
    }
    const selection = usageLedger.selectPersonalCandidates({ownerUserId:userId,agentInstanceId:instance.id,
      minimum:PERSONAL_MINIMUM_EVIDENCE,limit:PERSONAL_MAXIMUM_EVIDENCE,algorithmVersion:PERSONAL_EVOLUTION_ALGORITHM_VERSION});
    const available = selection.rows;
    if (selection.thresholdEligibleCount < PERSONAL_MINIMUM_EVIDENCE) {
      const nextEligibleAt = new Date(now.getTime() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS).toISOString();
      db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET last_evaluated_at = ?, next_eligible_at = ?,
        last_status = 'insufficient_evidence', last_evidence_count = ?, updated_at = ? WHERE user_agent_instance_id = ?`).run(
        evaluatedAt, nextEligibleAt, selection.thresholdEligibleCount, evaluatedAt, instance.id,
      );
      return { status: 'insufficient_evidence', authority: 'cloud', availableEvidence: available.length,
        thresholdEligibleEvidence: selection.thresholdEligibleCount,
        minimumEvidence: PERSONAL_MINIMUM_EVIDENCE, nextEligibleAt };
    }
    const runId = `evrun_${crypto.randomUUID()}`;
    const jobId = `evjob_${crypto.randomUUID()}`;
    const nextEligibleAt = new Date(now.getTime() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS).toISOString();
    db.prepare(`INSERT INTO cloud_evolution_runs (
      id, evolution_scope, owner_user_id, user_agent_instance_id, agent_family_id, consumer_id,
      algorithm_version, trigger_kind, status, evidence_count, base_agent_version_id,
      base_personal_skill_version_id, created_at, updated_at
    ) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(
      runId, userId, instance.id, instance.agent_family_id, instance.id, PERSONAL_EVOLUTION_ALGORITHM_VERSION,
      normalizedTriggerKind, available.length, instance.base_agent_version_id || '', instance.active_personal_skill_version_id || '', evaluatedAt, evaluatedAt,
    );
    db.prepare(`INSERT INTO cloud_evolution_jobs (id, run_id, job_kind, status, available_at, created_at, updated_at)
      VALUES (?, ?, 'personal_evolution', 'queued', ?, ?, ?)`).run(jobId, runId, evaluatedAt, evaluatedAt, evaluatedAt);
    const frozen = personalRunSnapshotInput(db, { userId,instance,evidenceIds:available.map((item)=>item.evidence_id) });
    storeSnapshot(db,runId,frozen.snapshot,frozen.baseSkill,frozen.overlay,frozen.memoryDocuments,keyring);
    const reserved = usageLedger.reserve({ scope:'personal',consumerId:instance.id,runId,algorithmVersion:PERSONAL_EVOLUTION_ALGORITHM_VERSION,
      evidenceIds:available.map((item)=>item.evidence_id),nextBasisByEvidence:Object.fromEntries(available
        .filter((item)=>item.next_re_evaluation_basis_hash).map((item)=>[item.evidence_id,item.next_re_evaluation_basis_hash])),
      leaseExpiresAt:new Date(now.getTime()+30*60000).toISOString(),now:evaluatedAt });
    if (reserved.length !== available.length) throw new Error('Evidence reservation changed during personal run creation.');
    db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET last_evaluated_at = ?, next_eligible_at = ?,
      last_status = 'queued', last_evidence_count = ?, last_run_id = ?, updated_at = ? WHERE user_agent_instance_id = ?`).run(
      evaluatedAt, nextEligibleAt, available.length, runId, evaluatedAt, instance.id,
    );
    return { status: 'queued', authority: 'cloud', run: runPayload(db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ?').get(runId)) };
  });
}

function scheduleDuePersonalEvolutionRuns(db, { limit = 25, now = new Date(), keyring } = {}) {
  const evaluatedAt = now.toISOString();
  db.prepare(`INSERT OR IGNORE INTO cloud_personal_evolution_schedule_states (user_agent_instance_id, next_eligible_at, updated_at)
    SELECT id, ?, ? FROM cloud_user_agent_instances_v3
    WHERE status = 'active' AND sync_enabled = 1 AND personal_evolution_consent = 1`).run(evaluatedAt, evaluatedAt);
  const due = db.prepare(`SELECT s.user_agent_instance_id, i.user_id FROM cloud_personal_evolution_schedule_states s
    JOIN cloud_user_agent_instances_v3 i ON i.id = s.user_agent_instance_id
    WHERE i.status = 'active' AND i.sync_enabled = 1 AND i.personal_evolution_consent = 1
      AND (s.next_eligible_at = '' OR s.next_eligible_at <= ?)
    ORDER BY s.next_eligible_at, s.user_agent_instance_id LIMIT ?`).all(evaluatedAt, Math.min(100, Math.max(1, Number(limit || 25))));
  return due.map((item) => queuePersonalEvolutionRun({ db, userId: item.user_id, agentInstanceId: item.user_agent_instance_id,
    triggerKind: 'scheduled', now, keyring }));
}

function requeueSqliteEvidenceForValidationPolicy(db,{limit=100}={}){
  const rows=db.prepare(`SELECT e.evidence_id,e.source_kind FROM cloud_evolution_evidence e
    JOIN cloud_evolution_evidence_validation_jobs j ON j.evidence_id=e.evidence_id
    WHERE e.validation_status='quarantined' AND e.quarantine_reason='credential_like_content'
      AND e.validation_policy_version<>? ORDER BY e.ingested_at,e.evidence_id LIMIT ?`).all(
    EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,Math.min(1000,Math.max(1,Number(limit||100))))
    .filter((row)=>evolutionEvidencePrivacyPolicyUpgradeable(row.source_kind));
  return transaction(db,()=>{
    const requeued=[];const now=nowIso();
    for(const row of rows){
      const updated=db.prepare(`UPDATE cloud_evolution_evidence SET validation_status='pending_validation',
        validation_policy_version=?,validation_json='{}',validated_at='',quarantine_reason=''
        WHERE evidence_id=? AND validation_status='quarantined' AND quarantine_reason='credential_like_content'
          AND validation_policy_version<>?`).run(EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,row.evidence_id,
        EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION);
      if(!updated.changes)continue;
      db.prepare(`UPDATE cloud_evolution_evidence_validation_jobs SET status='queued',attempt_count=0,available_at=?,
        claimed_by='',claimed_at='',lease_expires_at='',error_code='',error_text='',completed_at='',updated_at=? WHERE evidence_id=?`).run(
        now,now,row.evidence_id);
      db.prepare(`UPDATE cloud_evolution_evidence_quarantine SET resolution_status='released',resolution_note=?,resolved_at=?,updated_at=?
        WHERE evidence_id=? AND resolution_status='pending'`).run(EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,now,now,row.evidence_id);
      requeued.push(row.evidence_id);
    }
    return requeued;
  });
}

function requeueSqliteEvidenceForAvailableKeys(db,{keyring,limit=100}={}){
  const availableKeyIds=new Set(Object.keys(keyring?.keys||{}).filter((keyId)=>keyring.keys[keyId]));
  if(!availableKeyIds.size)return [];
  const rows=db.prepare(`SELECT j.evidence_id,e.key_id FROM cloud_evolution_evidence_validation_jobs j
    JOIN cloud_evolution_evidence e ON e.evidence_id=j.evidence_id WHERE j.status='failed_terminal'
      AND j.error_code='evolution_decryption_key_unavailable' ORDER BY j.updated_at,j.evidence_id LIMIT ?`).all(
    Math.min(1000,Math.max(1,Number(limit||100)))).filter((row)=>availableKeyIds.has(row.key_id));
  const now=nowIso();const requeued=[];
  for(const row of rows){
    const updated=db.prepare(`UPDATE cloud_evolution_evidence_validation_jobs SET status='queued',attempt_count=0,available_at=?,
      claimed_by='',claimed_at='',lease_expires_at='',error_code='',error_text='',completed_at='',updated_at=?
      WHERE evidence_id=? AND status='failed_terminal' AND error_code='evolution_decryption_key_unavailable'`).run(now,now,row.evidence_id);
    if(updated.changes)requeued.push(row.evidence_id);
  }
  return requeued;
}

function validatePendingSqliteEvidence(db,{workerId='embedded-evolution-worker',limit=25,keyring}={}){
  const now=nowIso();
  const jobs=transaction(db,()=>{
    const rows=db.prepare(`SELECT * FROM cloud_evolution_evidence_validation_jobs WHERE
      ((status IN ('queued','failed_retryable') AND (available_at='' OR available_at<=?))
        OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?))
      AND attempt_count<max_attempts ORDER BY available_at,evidence_id LIMIT ?`).all(now,now,Math.min(100,Math.max(1,Number(limit||25))));
    const claimed=[];const lease=new Date(Date.now()+15*60000).toISOString();
    for(const row of rows){
      const result=db.prepare(`UPDATE cloud_evolution_evidence_validation_jobs SET status='claimed',claimed_by=?,claimed_at=?,
        lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE evidence_id=? AND attempt_count=?`).run(
        workerId,now,lease,now,row.evidence_id,row.attempt_count);
      if(result.changes)claimed.push(db.prepare('SELECT * FROM cloud_evolution_evidence_validation_jobs WHERE evidence_id=?').get(row.evidence_id));
    }
    return claimed;
  });
  for(const job of jobs){
    const evidence=db.prepare('SELECT * FROM cloud_evolution_evidence WHERE evidence_id=?').get(job.evidence_id);
    if(!evidence)continue;
    try{
      const content=decryptSqliteEvidenceForValidation(evidence,keyring);
      if(sha256(content)!==evidence.content_hash)throw codedEvidenceValidationError('evidence_hash_mismatch','Evidence plaintext hash mismatch.');
      if(evolutionEvidencePrivacyFindings(content,{sourceKind:evidence.source_kind}).length)
        throw codedEvidenceValidationError('credential_like_content','Evidence contains private credential or identity material.');
      const metadata=parseObject(evidence.metadata_json);
      const validation={policyVersion:EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,sourceVerified:true,
        taskRelevance:Number(metadata.taskRelevance??0.8),acceptanceQuality:Number(metadata.acceptanceQuality??0.8),findingCount:0};
      transaction(db,()=>{
        db.prepare(`UPDATE cloud_evolution_evidence SET validation_status='validated',validation_policy_version=?,
          validation_json=?,validated_at=?,confidence=MIN(confidence,?),quarantine_reason='' WHERE evidence_id=?`).run(
          EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,JSON.stringify(validation),now,
          validatedEvidenceConfidenceForWorker(evidence.source_kind),evidence.evidence_id);
        db.prepare(`UPDATE cloud_evolution_evidence_validation_jobs SET status='completed',completed_at=?,lease_expires_at='',updated_at=?
          WHERE evidence_id=?`).run(now,now,evidence.evidence_id);
        if(!Number(evidence.historical_inactive)&&(metadata.allowedEvolutionScopes||[]).includes('personal')){
          createSqliteEvidenceUsageLedger(db).ensureAvailable({evidenceId:evidence.evidence_id,scope:'personal',consumerId:evidence.user_agent_instance_id,
            transitionReason:'worker_validated',now});
        }
        auditSqliteEvidenceAccess(db,{workerIdentity:workerId,evidenceId:evidence.evidence_id,purpose:'ingest_validation',result:'allowed',keyId:evidence.key_id,now});
      });
    }catch(error){
      const terminal=['evidence_hash_mismatch','credential_like_content'].includes(error.code);
      const attemptsExhausted=Number(job.attempt_count||0)>=Number(job.max_attempts||5);
      const evidenceStatus=terminal?'quarantined':'failed_retryable';
      const jobStatus=terminal?'quarantined':attemptsExhausted?'failed_terminal':'failed_retryable';
      transaction(db,()=>{
        db.prepare(`UPDATE cloud_evolution_evidence SET validation_status=?,validation_policy_version=?,
          quarantine_reason=CASE WHEN ?='quarantined' THEN ? ELSE quarantine_reason END WHERE evidence_id=?`).run(
          evidenceStatus,EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,evidenceStatus,error.code||'decrypt_failed',evidence.evidence_id);
        db.prepare(`UPDATE cloud_evolution_evidence_validation_jobs SET status=?,error_code=?,error_text=?,available_at=?,lease_expires_at='',
          claimed_by='',claimed_at='',updated_at=?,completed_at=? WHERE evidence_id=?`).run(
          jobStatus,error.code||'decrypt_failed',String(error.message||error).slice(0,2000),
          jobStatus==='failed_retryable'?new Date(Date.now()+validationRetryDelayMs(job.attempt_count)).toISOString():job.available_at,
          now,['quarantined','failed_terminal'].includes(jobStatus)?now:'',evidence.evidence_id);
        if(terminal)db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence_quarantine
          (id,evidence_id,owner_user_id,user_agent_instance_id,source_kind,source_id,source_version_id,reason_code,reason_text,retryable,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`).run(`evquar_${crypto.randomUUID()}`,evidence.evidence_id,evidence.owner_user_id,
          evidence.user_agent_instance_id,evidence.source_kind,evidence.source_id,evidence.source_version_id,error.code||'validation_failed',
          String(error.message||error).slice(0,2000),now,now);
        auditSqliteEvidenceAccess(db,{workerIdentity:workerId,evidenceId:evidence.evidence_id,purpose:'ingest_validation',
          result:terminal?'denied':'failed',resultCode:error.code||'decrypt_failed',keyId:evidence.key_id,now});
      });
    }
  }
  return jobs.length;
}

function decryptSqliteEvidenceForValidation(evidence,keyring){
  const algorithm=String(evidence.encryption_algorithm||'');
  const keyId=String(evidence.key_id||'');
  if(algorithm!=='plain_test_only'&&(!keyId||!keyring?.keys?.[keyId])){
    throw codedEvidenceValidationError('evolution_decryption_key_unavailable',`Evolution Evidence decryption key is unavailable: ${keyId||'missing'}`);
  }
  try{return decryptEvolutionPayload({algorithm,keyId,ciphertext:evidence.content_ciphertext,
    nonce:evidence.content_nonce,tag:evidence.content_tag,wrappedDataKey:evidence.wrapped_data_key},keyring);}
  catch(error){if(error?.code)throw error;throw codedEvidenceValidationError('decrypt_failed','Evolution Evidence decryption failed.');}
}

function validationRetryDelayMs(attemptCount=1){
  return Math.min(6*60*60*1000,5*60*1000*(2**Math.max(0,Number(attemptCount||1)-1)));
}

function auditSqliteEvidenceAccess(db,{workerIdentity='embedded-evolution-worker',runId='',evidenceId='',purpose,result,
  resultCode='',keyId='',detail={},now=nowIso()}={}){
  db.prepare(`INSERT INTO cloud_evolution_evidence_access_audits
    (id,worker_identity,run_id,evidence_id,purpose,result,result_code,key_id,detail_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(`evaudit_${crypto.randomUUID()}`,workerIdentity,runId,evidenceId,purpose,result,resultCode,keyId,
    JSON.stringify(detail),now);
}

function validatedEvidenceConfidenceForWorker(sourceKind=''){return ({task_acceptance:1,task_result:.95,conversation_segment:.9,
  memory_version:.9,task_shared_summary:.95,model_execution:.9,model_execution_metric:.9,message:.8})[sourceKind]??.8;}
function codedEvidenceValidationError(code,message){const error=new Error(message);error.code=code;return error;}

function ensurePersonalScheduleState(db, agentInstanceId, now = nowIso()) {
  db.prepare(`INSERT OR IGNORE INTO cloud_personal_evolution_schedule_states
    (user_agent_instance_id, next_eligible_at, updated_at) VALUES (?, ?, ?)`).run(agentInstanceId, now, now);
}

function personalSchedulePayload(db, userId, agentInstanceId) {
  const row = db.prepare('SELECT * FROM cloud_personal_evolution_schedule_states WHERE user_agent_instance_id = ?').get(agentInstanceId) || {};
  const availableEvidence = Number(db.prepare(`SELECT COUNT(*) AS count FROM cloud_evolution_evidence_usage u
    JOIN cloud_evolution_evidence e ON e.evidence_id = u.evidence_id
    WHERE e.owner_user_id = ? AND e.user_agent_instance_id = ? AND e.quarantine_reason = ''
      AND e.validation_status='validated' AND e.historical_inactive=0
      AND u.evolution_scope = 'personal' AND u.consumer_id = ? AND u.status IN ('available','released')`).get(
    userId, agentInstanceId, agentInstanceId,
  )?.count || 0);
  return { authority: 'cloud', agentInstanceId, lastEvaluatedAt: row.last_evaluated_at || '',
    nextEligibleAt: row.next_eligible_at || '', lastStatus: row.last_status || 'never_evaluated',
    lastEvidenceCount: Number(row.last_evidence_count || 0), lastRunId: row.last_run_id || '', availableEvidence };
}

function claimJob(db, workerId) {
  const usageLedger = createSqliteEvidenceUsageLedger(db);
  return transaction(db, () => {
    const now = nowIso();
    const job = db.prepare(`SELECT * FROM cloud_evolution_jobs WHERE
      ((status IN ('queued','failed_retryable') AND (available_at = '' OR available_at <= ?))
        OR (status IN ('claimed','running') AND lease_expires_at <> '' AND lease_expires_at <= ?))
      AND attempt_count < max_attempts ORDER BY available_at, created_at LIMIT 1`).get(now, now);
    if (!job) return null;
    const lease = new Date(Date.now() + 15 * 60000).toISOString();
    const result = db.prepare(`UPDATE cloud_evolution_jobs SET status = 'claimed', claimed_by = ?, lease_expires_at = ?,
      attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND attempt_count = ?`).run(workerId, lease, now, job.id, job.attempt_count);
    if (!result.changes) return null;
    const run = db.prepare('SELECT consumer_id,algorithm_version FROM cloud_evolution_runs WHERE id=?').get(job.run_id);
    const released = db.prepare(`SELECT evidence_id FROM cloud_evolution_evidence_usage
      WHERE run_id=? AND evolution_scope='personal' AND status='released'`).all(job.run_id).map((row)=>row.evidence_id);
    usageLedger.reserve({ scope:'personal',consumerId:run?.consumer_id||'',runId:job.run_id,algorithmVersion:run?.algorithm_version||'',
      evidenceIds:released,leaseExpiresAt:lease,transitionReason:'retry_reserved',now });
    usageLedger.refreshRunLease({ scope:'personal',runId:job.run_id,leaseExpiresAt:lease,now });
    db.prepare("UPDATE cloud_evolution_runs SET status = 'claimed', updated_at = ? WHERE id = ?").run(now, job.run_id);
    return db.prepare('SELECT * FROM cloud_evolution_jobs WHERE id = ?').get(job.id);
  });
}

function failJob(db, job, error) {
  const terminal = Boolean(error?.terminal) || Number(job.attempt_count || 0) >= Number(job.max_attempts || 3);
  const jobStatus = terminal ? 'failed_terminal' : 'failed_retryable';
  const runStatus = terminal ? 'failed_terminal' : 'failed_retryable';
  const now = nowIso();
  const retryAt = terminal ? '' : new Date(Date.now() + PERSONAL_EVOLUTION_RETRY_INTERVAL_MS).toISOString();
  transaction(db, () => {
    db.prepare(`UPDATE cloud_evolution_jobs SET status = ?, error_code = ?, error_text = ?, available_at = ?,
      lease_expires_at = '', updated_at = ?, completed_at = ? WHERE id = ?`).run(
      jobStatus, error.code || 'evolution_worker_failed', String(error.message || error).slice(0, 2000),
      retryAt,
      now, terminal ? now : '', job.id,
    );
    db.prepare(`UPDATE cloud_evolution_runs SET status = ?, error_code = ?, error_text = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
      runStatus, error.code || 'evolution_worker_failed', String(error.message || error).slice(0, 2000), now, terminal ? now : '', job.run_id,
    );
    const consumerId = db.prepare('SELECT consumer_id FROM cloud_evolution_runs WHERE id = ?').get(job.run_id)?.consumer_id || '';
    releaseEvidence(db, job.run_id, consumerId, { transitionReason: 'infrastructure_failure' });
    db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET next_eligible_at = ?, last_status = ?,
      last_run_id = ?, updated_at = ? WHERE user_agent_instance_id = ?`).run(
      terminal ? new Date(Date.now() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS).toISOString() : retryAt,
      runStatus, job.run_id, now, consumerId,
    );
  });
  return { status: jobStatus, terminal, retryAt };
}

function createCloudPersonalVersion(db, { run, instance, overlayText, baseSkill }) {
  const id = `psv_${crypto.randomUUID()}`;
  const now = nowIso();
  const effectiveSkill = `${String(baseSkill || '').trimEnd()}\n\n<!-- JANUS PERSONAL OVERLAY START -->\n${String(overlayText || '').trim()}\n<!-- JANUS PERSONAL OVERLAY END -->\n`;
  const payload = {
    id, userAgentInstanceId: instance.id, baseAgentVersionId: instance.base_agent_version_id || '',
    parentVersionId: instance.active_personal_skill_version_id || '', overlayText,
    effectiveSkillContent: effectiveSkill, effectiveSkillHash: sha256(effectiveSkill), compilerVersion: 'overlay_concat_v1',
    status: 'candidate', authority: 'cloud', stabilityStatus: 'stable', sourceEvolutionRunId: run.id,
    activatedAt: '', createdAt: now, updatedAt: now,
  };
  db.prepare(`INSERT INTO cloud_user_agent_skill_versions_v3 (
    user_id, id, user_agent_instance_id, base_agent_version_id, parent_version_id, source_evolution_run_id,
    authority, stability_status, overlay_hash, effective_skill_hash, compiler_version, status,
    activated_at, updated_at, payload_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'cloud', 'stable', ?, ?, 'overlay_concat_v1', 'candidate', '', ?, ?, ?)`).run(
    run.owner_user_id, id, instance.id, instance.base_agent_version_id || '', instance.active_personal_skill_version_id || '', run.id,
    sha256(overlayText), sha256(effectiveSkill), now, JSON.stringify(payload), now,
  );
  return db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND id = ?').get(run.owner_user_id, id);
}

function activateVersion(db, { userId, instance, nextVersion, runId, action, withinTransaction = false }) {
  const previousId = instance.active_personal_skill_version_id || '';
  const nextId = nextVersion?.id || '';
  const now = nowIso();
  const apply = () => {
    db.prepare("UPDATE cloud_user_agent_skill_versions_v3 SET status = 'archived', stability_status = CASE WHEN stability_status = 'candidate' THEN 'stable' ELSE stability_status END, updated_at = ? WHERE user_id = ? AND user_agent_instance_id = ? AND status = 'active'").run(now, userId, instance.id);
    if (nextId) db.prepare("UPDATE cloud_user_agent_skill_versions_v3 SET status = 'active', stability_status = 'stable', activated_at = ?, updated_at = ? WHERE user_id = ? AND id = ?").run(now, now, userId, nextId);
    db.prepare('UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(nextId, now, userId, instance.id);
    if (runId) db.prepare(`INSERT INTO cloud_evolution_apply_journals (id, run_id, user_agent_instance_id, previous_skill_version_id,
      next_skill_version_id, status, error_text, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`).run(
      `evapply_${crypto.randomUUID()}`, runId, instance.id, previousId, nextId, action, now, now, now,
    );
  };
  if (withinTransaction) apply();
  else transaction(db, apply);
  instance.active_personal_skill_version_id = nextId;
}

function rollbackSqliteMemoryVersion(db,{userId,instance,memoryDocumentId,targetVersionId,withinTransaction=false}={}){
  const document=db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=? AND id=? AND user_agent_instance_id=?').get(userId,memoryDocumentId,instance.id);
  const target=db.prepare('SELECT * FROM cloud_memory_document_versions_v3 WHERE user_id=? AND id=? AND memory_document_id=?').get(userId,targetVersionId,memoryDocumentId);
  if(!document||!target)throw apiError('memory_version_not_found','Memory rollback target does not belong to this Agent.',404);
  const payload=evolutionPayload(target);const id=`memver_${crypto.randomUUID()}`;const now=nowIso();
  const versionNo=Number(db.prepare('SELECT COALESCE(MAX(version_no),0)+1 value FROM cloud_memory_document_versions_v3 WHERE user_id=? AND memory_document_id=?').get(userId,memoryDocumentId)?.value||1);
  const next={...payload,id,memoryDocumentId,versionNo,sourceKind:'cloud_personal_evolution_rollback',sourceId:targetVersionId,createdAt:now};
  const apply=()=>{db.prepare(`INSERT INTO cloud_memory_document_versions_v3(user_id,id,memory_document_id,version_no,content_hash,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?)`).run(userId,id,memoryDocumentId,versionNo,target.content_hash,JSON.stringify(next),now);
    db.prepare('UPDATE cloud_memory_documents_v3 SET current_version_id=?,updated_at=? WHERE user_id=? AND id=?').run(id,now,userId,memoryDocumentId);};
  if(withinTransaction)apply();else transaction(db,apply);
  return{status:'rolled_back',authority:'cloud',memoryDocumentId,activeVersionId:id,sourceVersionId:targetVersionId};
}

function rollbackSqliteRunMemoryOperations(db,{userId,instance,runId,withinTransaction=false}={}){
  if(!runId)return[];
  const rows=db.prepare(`SELECT * FROM cloud_personal_evolution_memory_operations_v4
    WHERE user_id=? AND proposal_id=? AND status='applied' ORDER BY created_at,id`).all(userId,runId);
  const targets=new Map();
  for(const row of rows){const operation=evolutionPayload(row);if(operation.memoryDocumentId&&operation.baselineVersionId&&!targets.has(operation.memoryDocumentId))targets.set(operation.memoryDocumentId,operation.baselineVersionId);}
  return[...targets].map(([memoryDocumentId,targetVersionId])=>rollbackSqliteMemoryVersion(db,{userId,instance,memoryDocumentId,targetVersionId,withinTransaction}));
}

function persistCloudProposal(db, { run, instance, version, result, evidenceRows = [], withinTransaction = false }) {
  const now = nowIso();
  const proposalId = run.id;
  const safeResult = sanitizeEvolutionPayloadForStorage({
    summary: result.proposal?.summary || '',
    candidateOverlay: result.candidateOverlay || '',
    diagnosis: result.diagnosis || {},
    gate: result.gate || {},
  });
  const memoryOperations = (result.memoryOperations || []).map((operation, index) => ({
    id: `pememop_${sha256(`${run.id}:${index}:${operation.memoryDocumentId}:${operation.sectionName}`).slice(0, 32)}`,
    proposalId,
    memoryDocumentId: operation.memoryDocumentId,
    sectionName: operation.sectionName,
    operationType: operation.operationType,
    targetItemHash: operation.targetItemHash || '',
    proposedText: sanitizeEvolutionPayloadForStorage(operation.proposedText || ''),
    rationale: sanitizeEvolutionPayloadForStorage(operation.rationale || ''),
    baselineVersionId: operation.baselineVersionId || '',
    baselineContentHash: operation.baselineContentHash || '',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }));
  const replayResults = result.evaluations?.results || [];
  const proposal = {
    id: proposalId,
    runId: run.id,
    userId: run.owner_user_id,
    agentInstanceId: instance.id,
    agentFamilyId: instance.agent_family_id,
    status: 'ready',
    decision: 'pending',
    skillActionStatus: 'none',
    memoryActionStatus: memoryOperations.length ? 'pending' : 'none',
    syncScope: 'cloud',
    originDeviceId: 'cloud-authority',
    baseAgentVersionId: run.base_agent_version_id || '',
    basePersonalSkillVersionId: run.base_personal_skill_version_id || '',
    candidatePersonalSkillVersionId: version.id,
    evidenceCount: Number(run.evidence_count || evidenceRows.length),
    evidenceRefs: evidenceRows.map((row) => ({
      id: row.evidence_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      sourceHash: row.content_hash,
      occurredAt: row.occurred_at,
      privacyLevel: row.privacy_level || 'owner_private',
      included: true,
    })),
    summary: String(safeResult.summary || ''),
    proposedOverlayText: safeResult.candidateOverlay || '',
    proposedOverlayHash: sha256(safeResult.candidateOverlay || ''),
    diagnostics: safeResult.diagnosis || {},
    gate: safeResult.gate || {},
    privacyReport: result.gate?.privacyReport || { flagCount: 0, flags: [] },
    evaluationSummary: {
      caseCount: replayResults.length,
      regressionCount: replayResults.filter((item) => item.regression).length,
    },
    autoActivationEligible: false,
    createdAt: now,
    updatedAt: now,
  };
  proposal.proposalMarkdown = renderCloudProposalMarkdown(proposal, memoryOperations);
  proposal.proposalHash = sha256(proposal.proposalMarkdown);
  const persist = () => {
    db.prepare(`INSERT OR REPLACE INTO cloud_personal_evolution_proposals_v4 (
      user_id, id, user_agent_instance_id, agent_family_id, status, proposal_hash,
      origin_device_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'ready', ?, 'cloud-authority', ?, ?, ?)`).run(
      run.owner_user_id, proposalId, instance.id, instance.agent_family_id, proposal.proposalHash,
      JSON.stringify(proposal), now, now,
    );
    for (const operation of memoryOperations) {
      db.prepare(`INSERT OR REPLACE INTO cloud_personal_evolution_memory_operations_v4 (
        user_id, id, proposal_id, memory_document_id, status, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
        run.owner_user_id, operation.id, proposalId, operation.memoryDocumentId,
        JSON.stringify(operation), now, now,
      );
    }
  };
  if (withinTransaction) persist();
  else transaction(db, persist);
}

function normalizeRunDecisions({ decisions = [], skillDecision = '', memoryDecisions = [] } = {}) {
  const normalized = Array.isArray(decisions) ? decisions.map((item) => ({
    targetKind: item.targetKind || item.target_kind || '',
    targetId: item.targetId || item.target_id || '',
    decision: item.decision || '',
  })) : [];
  if (skillDecision) normalized.push({ targetKind: 'skill', targetId: '', decision: skillDecision });
  for (const item of Array.isArray(memoryDecisions) ? memoryDecisions : []) {
    normalized.push({ targetKind: 'memory_operation', targetId: item.operationId || item.targetId || '', decision: item.decision || '' });
  }
  if (!normalized.length) throw apiError('evolution_decision_required', 'At least one personal evolution decision is required.', 400);
  return normalized;
}

function applyPersonalDecisions(db, {
  userId, runId, decisions, actorDeviceId = '', automatic = false, withinTransaction = false, keyring,
}) {
  const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ? AND owner_user_id = ?').get(runId, userId);
  if (!run) throw apiError('evolution_run_not_found', 'Evolution run was not found.', 404);
  const proposalRow = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id = ? AND id = ?').get(userId, runId);
  if (!proposalRow) throw apiError('evolution_proposal_not_found', 'Evolution Proposal was not found.', 404);
  const proposal = evolutionPayload(proposalRow);
  const candidateId = run.candidate_personal_skill_version_id || proposal.candidatePersonalSkillVersionId || '';
  const normalized = decisions.map((item) => ({
    targetKind: String(item.targetKind || item.target_kind || ''),
    targetId: String(item.targetId || item.target_id || (item.targetKind === 'skill' ? candidateId : '')),
    decision: String(item.decision || ''),
  }));
  for (const item of normalized) {
    if (!['skill', 'memory_operation'].includes(item.targetKind) || !['accept', 'reject'].includes(item.decision)) {
      throw apiError('evolution_decision_invalid', 'Personal evolution decision target or value is invalid.', 400);
    }
  }
  const instance = normalized.some((item) => item.decision === 'accept')
    ? requireEvolutionEligibleInstance(db, userId, run.user_agent_instance_id)
    : requireOwnedInstance(db, userId, run.user_agent_instance_id);
  const actionPayloads = [];
  let conflict = false;
  const apply = () => {
    for (const item of normalized) {
      if (item.targetKind === 'skill' && (!candidateId || item.targetId !== candidateId)) {
        throw apiError('evolution_skill_target_invalid', 'Skill candidate does not belong to this Proposal.', 400);
      }
      const memoryRow = item.targetKind === 'memory_operation'
        ? db.prepare(`SELECT * FROM cloud_personal_evolution_memory_operations_v4
          WHERE user_id = ? AND proposal_id = ? AND id = ?`).get(userId, runId, item.targetId)
        : null;
      if (item.targetKind === 'memory_operation' && !memoryRow) {
        throw apiError('evolution_memory_target_invalid', 'Memory operation does not belong to this Proposal.', 400);
      }
      const existing = db.prepare(`SELECT * FROM cloud_personal_evolution_actions_v4
        WHERE user_id = ? AND proposal_id = ? AND target_kind = ? AND target_id = ?`).get(
        userId, runId, item.targetKind, item.targetId,
      );
      if (existing) {
        if (existing.decision !== item.decision) conflict = true;
        actionPayloads.push(evolutionPayload(existing));
        continue;
      }
      if (!['ready', 'partially_applied'].includes(proposalRow.status)) {
        throw apiError('evolution_proposal_not_reviewable', `Evolution Proposal is not reviewable from status ${proposalRow.status}.`, 409);
      }
      if (item.targetKind === 'skill') {
        const candidate = db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id = ? AND user_agent_instance_id = ? AND id = ?').get(
          userId, instance.id, candidateId,
        );
        if (!candidate) throw apiError('evolution_skill_candidate_missing', 'Skill candidate is unavailable.', 409);
        if (item.decision === 'accept') {
          activateVersion(db, { userId, instance, nextVersion: candidate, runId, action: automatic ? 'automatic_skill_accept' : 'manual_skill_accept', withinTransaction: true });
        } else {
          db.prepare("UPDATE cloud_user_agent_skill_versions_v3 SET status = 'rejected', updated_at = ? WHERE user_id = ? AND id = ? AND status = 'candidate'").run(nowIso(), userId, candidateId);
        }
      } else if (item.decision === 'accept') {
        applyCloudMemoryDecision(db, { userId, runId, operationRow: memoryRow, keyring });
      } else {
        updateMemoryOperationState(db, memoryRow, 'rejected');
      }
      const receivedAt = nowIso();
      const action = {
        id: `peaction_${crypto.randomUUID()}`,
        proposalId: runId,
        targetKind: item.targetKind,
        targetId: item.targetId,
        decision: item.decision,
        revision: 1,
        actorDeviceId,
        automatic,
        receivedAt,
      };
      db.prepare(`INSERT INTO cloud_personal_evolution_actions_v4 (
        user_id, id, proposal_id, target_kind, target_id, decision, revision,
        actor_device_id, payload_json, received_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(
        userId, action.id, runId, action.targetKind, action.targetId, action.decision,
        actorDeviceId, JSON.stringify(action), receivedAt,
      );
      actionPayloads.push(action);
    }
    finalizeCloudProposal(db, { userId, runId, candidateId });
  };
  if (withinTransaction) apply();
  else transaction(db, apply);
  const updatedRun = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ?').get(runId);
  const updatedProposal = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id = ? AND id = ?').get(userId, runId);
  return {
    status: conflict ? 'conflict' : 'accepted',
    authority: 'cloud',
    run: runPayload(updatedRun),
    proposal: evolutionPayload(updatedProposal),
    actions: actionPayloads,
  };
}

function applyCloudMemoryDecision(db, { userId, runId, operationRow, keyring }) {
  const operation = evolutionPayload(operationRow);
  const document = db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id = ? AND id = ?').get(userId, operation.memoryDocumentId);
  if (!document) throw apiError('evolution_memory_document_missing', 'Memory document is unavailable.', 409);
  const currentVersion = document.current_version_id
    ? db.prepare('SELECT * FROM cloud_memory_document_versions_v3 WHERE user_id = ? AND id = ?').get(userId, document.current_version_id)
    : null;
  const currentPayload = payloadOf(currentVersion);
  const baselineMatches = document.current_version_id === operation.baselineVersionId
    && (!operation.baselineContentHash || currentVersion?.content_hash === operation.baselineContentHash);
  const continuedProposal = currentPayload.sourceKind === 'cloud_personal_evolution'
    && Boolean(db.prepare(`SELECT id FROM cloud_personal_evolution_memory_operations_v4
      WHERE user_id = ? AND proposal_id = ? AND id = ?`).get(userId, runId, currentPayload.sourceId || ''));
  if (!baselineMatches && !continuedProposal) {
    throw apiError('evolution_memory_baseline_changed', 'Memory baseline changed; reject this operation and request a new Proposal.', 409);
  }
  const currentContent = String(currentPayload.content || '');
  const nextContent = applyMemoryOperation(currentContent, operation);
  if (nextContent !== currentContent) {
    const versionNo = Number(db.prepare('SELECT MAX(version_no) AS value FROM cloud_memory_document_versions_v3 WHERE user_id = ? AND memory_document_id = ?').get(userId, document.id)?.value || 0) + 1;
    const id = `memver_${crypto.randomUUID()}`;
    const now = nowIso();
    const payload = {
      ...currentPayload,
      id,
      memoryDocumentId: document.id,
      versionNo,
      content: nextContent,
      contentHash: sha256(nextContent),
      sourceKind: 'cloud_personal_evolution',
      sourceId: operation.id,
      reviewStatus: 'approved',
      createdBy: userId,
      createdAt: now,
    };
    db.prepare(`INSERT INTO cloud_memory_document_versions_v3 (user_id, id, memory_document_id, version_no, content_hash, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, id, document.id, versionNo, sha256(nextContent), JSON.stringify(payload), now);
    db.prepare('UPDATE cloud_memory_documents_v3 SET current_version_id = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(id, now, userId, document.id);
    createSqliteAuthoritativeEvidence(db,{keyring,ownerUserId:userId,userAgentInstanceId:document.user_agent_instance_id,
      agentFamilyId:document.agent_family_id,sourceKind:String(payload.visibility || document.visibility || '') === 'work_summary' ? 'task_shared_summary' : 'memory_version',
      sourceId:document.id,sourceVersionId:id,content:nextContent,contextSpaceId:document.context_space_id || '',taskId:document.task_run_id || '',
      delegationId:document.delegation_id || '',privacyLevel:'owner_private',occurredAt:now,
      metadata:{sourceKind:'cloud_personal_evolution',sourceOperationId:operation.id,memoryScope:document.scope}});
  }
  updateMemoryOperationState(db, operationRow, 'applied');
}

function updateMemoryOperationState(db, row, status) {
  const payload = { ...evolutionPayload(row), status, updatedAt: nowIso() };
  db.prepare(`UPDATE cloud_personal_evolution_memory_operations_v4 SET status = ?, payload_json = ?, updated_at = ?
    WHERE user_id = ? AND id = ?`).run(status, JSON.stringify(payload), payload.updatedAt, row.user_id, row.id);
}

function finalizeCloudProposal(db, { userId, runId, candidateId }) {
  const proposalRow = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id = ? AND id = ?').get(userId, runId);
  const proposal = evolutionPayload(proposalRow);
  const actions = db.prepare('SELECT * FROM cloud_personal_evolution_actions_v4 WHERE user_id = ? AND proposal_id = ?').all(userId, runId);
  const skillAction = actions.find((item) => item.target_kind === 'skill' && item.target_id === candidateId);
  const memoryRows = db.prepare('SELECT * FROM cloud_personal_evolution_memory_operations_v4 WHERE user_id = ? AND proposal_id = ?').all(userId, runId);
  const memoryTerminal = memoryRows.every((item) => ['applied', 'rejected'].includes(item.status));
  const skillTerminal = Boolean(skillAction);
  const terminal = skillTerminal && memoryTerminal;
  const skillApplied = skillAction?.decision === 'accept';
  const accepted = actions.some((item) => item.decision === 'accept');
  const rejected = actions.some((item) => item.decision === 'reject');
  const proposalStatus = skillApplied && !memoryTerminal ? 'partially_applied' : terminal
    ? accepted && rejected ? 'partially_applied' : accepted ? 'applied' : 'rejected'
    : actions.length ? 'partially_applied' : 'ready';
  const now = nowIso();
  const nextProposal = {
    ...proposal,
    status: proposalStatus,
    decision: terminal ? accepted && rejected ? 'partial' : accepted ? 'accepted' : 'rejected' : 'pending',
    skillActionStatus: skillAction ? (skillAction.decision === 'accept' ? 'activated' : 'rejected') : 'none',
    memoryActionStatus: memoryTerminal
      ? memoryRows.some((item) => item.status === 'applied') ? 'applied' : memoryRows.length ? 'rejected' : 'none'
      : 'pending',
    decidedAt: terminal ? now : '',
    updatedAt: now,
  };
  db.prepare(`UPDATE cloud_personal_evolution_proposals_v4 SET status = ?, payload_json = ?, updated_at = ?
    WHERE user_id = ? AND id = ?`).run(proposalStatus, JSON.stringify(nextProposal), now, userId, runId);
  if (!skillAction) {
    db.prepare("UPDATE cloud_evolution_runs SET status='available',completed_at=CASE WHEN completed_at='' THEN ? ELSE completed_at END,updated_at=? WHERE id=?")
      .run(now, now, runId);
    return;
  }
  if (accepted || terminal) {
    const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id = ?').get(runId);
    if (accepted) consumeEvidence(db, runId, run.consumer_id, { transitionReason: 'applied' });
    else rejectEvidence(db, runId, run.consumer_id, { rejectionKind: 'user_rejected', transitionReason: 'user_rejected' });
    db.prepare(`UPDATE cloud_evolution_runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(
      accepted ? 'applied' : 'evaluated_rejected', now, now, runId,
    );
    db.prepare(`UPDATE cloud_personal_evolution_schedule_states SET last_status = ?, last_run_id = ?, updated_at = ?
      WHERE user_agent_instance_id = ?`).run(accepted ? 'applied' : 'evaluated_rejected', runId, now, run.consumer_id);
  } else {
    db.prepare("UPDATE cloud_evolution_runs SET status = 'proposed', completed_at = '', updated_at = ? WHERE id = ?").run(now, runId);
  }
}

function renderCloudProposalMarkdown(proposal, memoryOperations) {
  return `# Personal Evolution Proposal\n\n## Summary\n${proposal.summary || ''}\n\n## Evidence\n- ${proposal.evidenceCount} encrypted evidence items\n\n## Proposed Skill Overlay\n${proposal.proposedOverlayText || ''}\n\n## Proposed Memory Operations\n${memoryOperations.length ? memoryOperations.map((item) => `- ${item.operationType} ${item.sectionName}: ${item.proposedText}`).join('\n') : '- no-op'}\n\n## Evaluation\n- Gate: ${proposal.gate?.status || 'unknown'} (${proposal.gate?.score ?? 0})\n- Cases: ${proposal.evaluationSummary?.caseCount || 0}\n- Regressions: ${proposal.evaluationSummary?.regressionCount || 0}\n`;
}

function applyMemoryOperation(content, operation) {
  const heading = `## ${operation.sectionName}`;
  const escaped = operation.sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^##\\s+${escaped}\\s*$)([\\s\\S]*?)(?=^##\\s+|$)`, 'm');
  const match = content.match(pattern);
  const proposed = String(operation.proposedText || '').trim();
  if (operation.operationType === 'add') {
    if (match) return content.replace(pattern, `${match[1]}${match[2].trimEnd()}\n- ${proposed}\n\n`);
    return `${content.trimEnd()}\n\n${heading}\n- ${proposed}\n`;
  }
  if (!match) return content;
  if (operation.operationType === 'remove') return content.replace(pattern, `${match[1]}\n`);
  return content.replace(pattern, `${match[1]}\n${proposed}\n\n`);
}

function storeSnapshot(db, runId, snapshot, baseSkill, overlay, memory, keyring) {
  const baseEncrypted = encryptEvolutionPayload(baseSkill, keyring);
  const overlayEncrypted = encryptEvolutionPayload(overlay, keyring);
  const memoryEncrypted = encryptEvolutionPayload(memory, keyring);
  db.prepare(`INSERT OR REPLACE INTO cloud_evolution_run_snapshots (
    run_id, snapshot_hash, evidence_ids_json, base_skill_ciphertext, personal_overlay_ciphertext,
    memory_manifest_ciphertext, encryption_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    runId, hashEvolutionSnapshot(snapshot), JSON.stringify(snapshot.evidenceIds), baseEncrypted.ciphertext,
    overlayEncrypted.ciphertext, memoryEncrypted.ciphertext,
    JSON.stringify({ base: baseEncrypted, overlay: overlayEncrypted, memory: memoryEncrypted, keyId: baseEncrypted.keyId, algorithm: baseEncrypted.algorithm }), nowIso(),
  );
}

function personalRunSnapshotInput(db,{userId,instance,evidenceIds}) {
  const basePayload=payloadOf(db.prepare('SELECT * FROM cloud_agent_versions_v3 WHERE id=?').get(instance.base_agent_version_id));
  const overlayPayload=instance.active_personal_skill_version_id
    ? payloadOf(db.prepare('SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id=? AND id=?').get(userId,instance.active_personal_skill_version_id)) : {};
  const memoryDocuments=db.prepare(`SELECT d.*,v.payload_json AS version_payload_json,v.content_hash FROM cloud_memory_documents_v3 d
    LEFT JOIN cloud_memory_document_versions_v3 v ON v.user_id=d.user_id AND v.id=d.current_version_id
    WHERE d.user_id=? AND d.user_agent_instance_id=? AND d.lifecycle_state='active' AND d.allow_personal_evolution=1
    ORDER BY d.id`).all(userId,instance.id).map((row)=>{const payload=parseObject(row.version_payload_json);return {
      id:row.id,currentVersionId:row.current_version_id,contentHash:row.content_hash||'',content:payload.content||'',
    };});
  return { baseSkill:basePayload.base_skill_content||basePayload.baseSkillContent||'',
    overlay:overlayPayload.overlay_text||overlayPayload.overlayText||'',memoryDocuments,
    snapshot:{evidenceIds:[...evidenceIds],baseAgentVersionId:instance.base_agent_version_id||'',
      basePersonalSkillVersionId:instance.active_personal_skill_version_id||'',
      memory:memoryDocuments.map((item)=>({id:item.id,versionId:item.currentVersionId,contentHash:item.contentHash}))} };
}

function loadPersonalRunSnapshot(db,runId,keyring) {
  const row=db.prepare('SELECT * FROM cloud_evolution_run_snapshots WHERE run_id=?').get(runId);
  if(!row)throw terminalError('evolution_snapshot_missing','Personal evolution snapshot is missing.');
  const encryption=parseObject(row.encryption_json);
  return { evidenceIds:parseArray(row.evidence_ids_json),
    baseSkill:decryptEvolutionPayload(encryption.base||{},keyring),overlay:decryptEvolutionPayload(encryption.overlay||{},keyring),
    memoryDocuments:JSON.parse(decryptEvolutionPayload(encryption.memory||{},keyring)||'[]') };
}

function storeEvaluations(db, runId, result) {
  const rows = [
    ['diagnosis', 0, false, result.diagnosis || {}],
    ['gate', 0, result.gate?.status !== 'passed', result.gate || {}],
    ['review', 0, result.review?.decision !== 'full', result.review || {}],
  ];
  for (const item of result.evaluations?.results || []) rows.push(['ab_replay', item.caseIndex, Boolean(item.regression), item]);
  for (const [kind, index, regression, payload] of rows) {
    const storedPayload = sanitizeEvolutionPayloadForStorage(payload);
    db.prepare(`INSERT OR REPLACE INTO cloud_evolution_evaluations (id, run_id, evaluation_kind, case_index, status, regression, result_json, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`).run(`eveval_${sha256(`${runId}:${kind}:${index}`).slice(0, 32)}`, runId, kind, index, regression ? 1 : 0, JSON.stringify(storedPayload), nowIso());
  }
}

function finishRejected(db, runId, jobId, code, text, status, terminal) {
  const now = nowIso();
  db.prepare('UPDATE cloud_evolution_runs SET status = ?, error_code = ?, error_text = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(status, code, text, now, now, runId);
  db.prepare("UPDATE cloud_evolution_jobs SET status = 'completed', error_code = ?, error_text = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(code, text, now, now, jobId);
  if (terminal) return;
}

function consumeEvidence(db, runId, consumerId, options = {}) { transitionEvidence(db, runId, consumerId, 'consumed', options); }
function rejectEvidence(db, runId, consumerId, options = {}) { transitionEvidence(db, runId, consumerId, 'evaluated_rejected', options); }
function releaseEvidence(db, runId, consumerId, options = {}) { transitionEvidence(db, runId, consumerId, 'released', options); }
function transitionEvidence(db, runId, consumerId, status, { rejectionKind = '', transitionReason = '' } = {}) {
  return createSqliteEvidenceUsageLedger(db).transitionRun({ scope:'personal',consumerId,runId,toStatus:status,rejectionKind,transitionReason });
}

function auditMemoryRead(db, { run, evidenceId, result }) {
  db.prepare(`INSERT INTO cloud_memory_access_audits (id, requester_identity, owner_user_id, user_agent_instance_id,
    evidence_id, run_id, purpose, result, created_at) VALUES (?, 'evolution-worker', ?, ?, ?, ?, 'personal_evolution', ?, ?)`).run(
    `memaudit_${crypto.randomUUID()}`, run.owner_user_id, run.user_agent_instance_id, evidenceId, run.id, result, nowIso(),
  );
}

function requireOwnedInstance(db, userId, instanceId) {
  const row = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = ? AND id = ?').get(userId, instanceId);
  if (!row) throw apiError('agent_instance_not_found', 'Agent instance does not belong to the granted user.', 404);
  return row;
}

function requireEvolutionEligibleInstance(db, userId, instanceId) {
  const row = requireOwnedInstance(db, userId, instanceId);
  if (row.status !== 'active' || !Number(row.sync_enabled) || !Number(row.personal_evolution_consent)) {
    throw apiError('personal_evolution_not_allowed', 'Agent is not active, synchronized, and authorized for personal evolution.', 409);
  }
  return row;
}

function validateEvidenceSourceAuthorization(db, userId, instance, evidence, allowedEvolutionScopes = []) {
  if (!['memory_version', 'task_shared_summary'].includes(evidence.sourceKind)) return allowedEvolutionScopes;
  const document = db.prepare(`SELECT * FROM cloud_memory_documents_v3
    WHERE user_id = ? AND id = ? AND user_agent_instance_id = ?`).get(userId, evidence.sourceId, instance.id);
  const personalAllowed = allowedEvolutionScopes.includes('personal') && Number(document?.allow_personal_evolution);
  const clusterAllowed = allowedEvolutionScopes.includes('cluster');
  if (!document || !Number(document.sync_enabled) || (!personalAllowed && !clusterAllowed)) {
    throw apiError('memory_evolution_not_allowed', 'Memory document is not authorized for the requested evolution scopes.', 403);
  }
  const version = db.prepare(`SELECT * FROM cloud_memory_document_versions_v3
    WHERE user_id = ? AND memory_document_id = ? AND id = ?`).get(userId, document.id, evidence.sourceVersionId);
  if (!version) throw apiError('memory_version_not_found', 'Memory evidence version does not belong to the authorized document.', 404);
  if (evidence.sourceKind === 'task_shared_summary') {
    const payload = parseObject(version.payload_json);
    if (document.scope !== 'task' || !document.task_run_id || String(payload.visibility || document.visibility || '') !== 'work_summary') {
      throw apiError('task_shared_summary_invalid', 'Task shared summary Evidence must reference a task-scoped work_summary version.', 403);
    }
    const task=db.prepare('SELECT * FROM cloud_task_runs WHERE id=?').get(document.task_run_id);
    if(!task)throw retryableEvidenceError('evidence_source_not_ready','Task shared summary task has not synchronized yet.');
    const taskPayload=parseObject(task.payload_json);
    if(String(task.owner_user_id || taskPayload.ownerUserId || taskPayload.owner_user_id || '')!==userId) {
      throw apiError('evidence_source_identity_mismatch','Task shared summary task does not belong to this user.',403);
    }
    const member=db.prepare('SELECT payload_json FROM cloud_task_nodes WHERE task_run_id=?').all(document.task_run_id)
      .some((row)=>evidencePayloadAgentInstance(parseObject(row.payload_json))===instance.id);
    if(!member && evidencePayloadAgentInstance(taskPayload)!==instance.id) {
      throw apiError('evidence_source_identity_mismatch','Task shared summary Agent is not a task participant.',403);
    }
  }
  return [personalAllowed ? 'personal' : '', clusterAllowed ? 'cluster' : ''].filter(Boolean);
}

function validateAuthoritativeEvidenceSource(db, userId, instance, evidence, allowedEvolutionScopes = [], { requireTaskEvent = false } = {}) {
  if (['memory_version', 'task_shared_summary'].includes(evidence.sourceKind)) {
    const document = db.prepare('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=? AND id=?').get(userId, evidence.sourceId);
    if (!document) {
      const foreignDocument = db.prepare('SELECT user_id FROM cloud_memory_documents_v3 WHERE id=? LIMIT 1').get(evidence.sourceId);
      if (foreignDocument) throw apiError('evidence_source_identity_mismatch', 'Memory document does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Memory document source has not synchronized yet.');
    }
    if (document.user_agent_instance_id !== instance.id) {
      throw apiError('evidence_source_identity_mismatch', 'Memory document does not belong to this Agent instance.', 403);
    }
    const version = db.prepare('SELECT * FROM cloud_memory_document_versions_v3 WHERE user_id=? AND id=?').get(userId, evidence.sourceVersionId);
    if (!version) {
      const foreignVersion = db.prepare('SELECT user_id FROM cloud_memory_document_versions_v3 WHERE id=? LIMIT 1').get(evidence.sourceVersionId);
      if (foreignVersion) throw apiError('evidence_source_identity_mismatch', 'Memory version does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Memory version source has not synchronized yet.');
    }
    if (version.memory_document_id !== evidence.sourceId) {
      throw apiError('evidence_source_identity_mismatch', 'Memory version does not belong to the referenced document.', 403);
    }
    if (version.content_hash && version.content_hash !== evidence.contentHash) {
      throw apiError('evidence_source_hash_mismatch', 'Memory Evidence content hash does not match the synchronized version.', 403);
    }
    return validateEvidenceSourceAuthorization(db, userId, instance, evidence, allowedEvolutionScopes);
  }
  if (['message', 'conversation_segment'].includes(evidence.sourceKind)) {
    const rows = db.prepare('SELECT payload_json FROM cloud_messages_v2 WHERE user_id=? AND id=? ORDER BY created_at DESC').all(userId, evidence.sourceId);
    if (!rows.length) {
      const foreignSource = db.prepare('SELECT user_id FROM cloud_messages_v2 WHERE id=? LIMIT 1').get(evidence.sourceId);
      if (foreignSource) throw apiError('evidence_source_identity_mismatch', 'Message source does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Message source has not synchronized yet.');
    }
    const owned = rows.some((row) => evidencePayloadAgentInstance(parseObject(row.payload_json)) === instance.id);
    if (!owned) throw apiError('evidence_source_identity_mismatch', 'Message source does not belong to this Agent instance.', 403);
    return allowedEvolutionScopes;
  }
  if (evidence.sourceKind === 'collaboration_message') {
    const message=db.prepare('SELECT * FROM collaboration_group_messages WHERE id=?').get(evidence.sourceId);
    if (!message) throw retryableEvidenceError('evidence_source_not_ready','Collaboration message source has not synchronized yet.');
    if (message.sender_user_id !== userId || instance.agent_family_id !== 'secretary_agent') {
      throw apiError('evidence_source_identity_mismatch','Collaboration message does not belong to this user and uBuddy instance.',403);
    }
    const membership=db.prepare('SELECT 1 FROM collaboration_group_members WHERE group_id=? AND user_id=?').get(message.group_id,userId);
    if (!membership) throw apiError('evidence_source_identity_mismatch','Collaboration message sender was not a group member.',403);
    if (sha256(String(message.content || '')) !== evidence.contentHash) throw apiError('evidence_source_hash_mismatch','Collaboration message Evidence hash is invalid.',403);
    return allowedEvolutionScopes;
  }
  if (evidence.sourceKind === 'delegation_event') {
    const revision=evidence.sourceVersionId?db.prepare('SELECT * FROM agent_delegation_revisions WHERE id=?').get(evidence.sourceVersionId):null;
    if (!revision) throw retryableEvidenceError('evidence_source_not_ready','Delegation event source has not synchronized yet.');
    const delegation=db.prepare('SELECT * FROM agent_delegations WHERE id=?').get(evidence.sourceId);
    if (!delegation) throw retryableEvidenceError('evidence_source_not_ready','Delegation source has not synchronized yet.');
    if (revision.delegation_id !== delegation.id || revision.author_user_id !== userId || instance.agent_family_id !== 'secretary_agent'
      || ![delegation.requester_user_id,delegation.recipient_user_id].includes(userId)) {
      throw apiError('evidence_source_identity_mismatch','Delegation event does not belong to this user and uBuddy instance.',403);
    }
    return allowedEvolutionScopes;
  }
  if (['model_execution', 'model_execution_metric'].includes(evidence.sourceKind)) {
    const rows = db.prepare('SELECT payload_json FROM cloud_model_executions_v2 WHERE user_id=? AND id=? ORDER BY updated_at DESC').all(userId, evidence.sourceId);
    if (!rows.length) {
      const foreignSource = db.prepare('SELECT user_id FROM cloud_model_executions_v2 WHERE id=? LIMIT 1').get(evidence.sourceId);
      if (foreignSource) throw apiError('evidence_source_identity_mismatch', 'Model execution source does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Model execution source has not synchronized yet.');
    }
    const owned = rows.some((row) => evidencePayloadAgentInstance(parseObject(row.payload_json)) === instance.id);
    if (!owned) throw apiError('evidence_source_identity_mismatch', 'Model execution source does not belong to this Agent instance.', 403);
    return allowedEvolutionScopes;
  }
  if (taskEvidenceSourceKind(evidence.sourceKind)) {
    const nodeScoped=taskNodeScopedEvidenceSourceKind(evidence.sourceKind);
    const node=nodeScoped?db.prepare('SELECT * FROM cloud_task_nodes WHERE id=?').get(evidence.sourceId):null;
    if(nodeScoped&&!node)throw retryableEvidenceError('evidence_source_not_ready','Task node source has not synchronized yet.');
    const nodePayload=parseObject(node?.payload_json);
    if(nodeScoped&&evidencePayloadAgentInstance(nodePayload)!==instance.id)throw apiError('evidence_source_identity_mismatch','Task node source does not belong to this Agent instance.',403);
    const taskRunId=nodeScoped?(node.task_run_id||nodePayload.taskRunId||nodePayload.task_run_id||''):evidence.sourceId;
    const task = db.prepare('SELECT payload_json FROM cloud_task_runs WHERE id=?').get(taskRunId);
    if (!task) throw retryableEvidenceError('evidence_source_not_ready', 'Task source has not synchronized yet.');
    const taskPayload = parseObject(task.payload_json);
    if (String(taskPayload.ownerUserId || taskPayload.owner_user_id || '') !== userId) {
      throw apiError('evidence_source_identity_mismatch', 'Task source does not belong to this user.', 403);
    }
    if(!nodeScoped&&evidencePayloadAgentInstance(taskPayload)!==instance.id)throw apiError('evidence_source_identity_mismatch','Task source does not belong to this Agent instance.',403);
    if (requireTaskEvent && !evidence.sourceVersionId) {
      throw apiError('evidence_source_version_required', 'New task Evidence must reference its synchronized task event.', 400);
    }
    if (evidence.sourceVersionId) {
      const event = db.prepare('SELECT * FROM cloud_task_events WHERE id=?').get(evidence.sourceVersionId);
      if (!event) throw retryableEvidenceError('evidence_source_not_ready', 'Task event source has not synchronized yet.');
      if (event.task_run_id !== taskRunId) {
        throw apiError('evidence_source_event_mismatch', 'Task event does not belong to the referenced task run.', 403);
      }
      const eventPayload = parseObject(event.payload_json);
      const eventNodeId = event.task_node_id || eventPayload.taskNodeId || eventPayload.task_node_id || '';
      const eventType = event.event_type || eventPayload.eventType || eventPayload.event_type || '';
      if ((nodeScoped && eventNodeId !== evidence.sourceId) || taskEvidenceSourceKindForEvent(eventType) !== evidence.sourceKind) {
        throw apiError('evidence_source_event_mismatch', 'Task event does not match the Evidence source kind.', 403);
      }
    }
    return allowedEvolutionScopes;
  }
  throw apiError('evidence_source_not_supported', `Authoritative source validation is not available for ${evidence.sourceKind}.`, 400);
}

function normalizeEvolutionScopes(value, instance, sourceKind = '') {
  const requested = new Set((Array.isArray(value) ? value : []).map(String));
  const scopes = [];
  if (requested.has('personal') && Number(instance.personal_evolution_consent)) scopes.push('personal');
  if (requested.has('cluster') || evolutionEvidenceClusterScopeAutomatic(sourceKind)) scopes.push('cluster');
  return scopes;
}

function evidencePayloadAgentInstance(payload = {}) {
  return String(payload.agentInstanceId || payload.agent_instance_id || payload.userAgentInstanceId || payload.user_agent_instance_id
    || payload.leadAgentInstanceId || payload.lead_agent_instance_id || '');
}

function taskEvidenceSourceKind(sourceKind = '') {
  return ['task_created','task_assigned','task_revision','task_dependency_changed','task_result','task_acceptance','task_rework','task_failure','task_blocked','task_cancelled'].includes(sourceKind);
}
function taskNodeScopedEvidenceSourceKind(sourceKind=''){return !['task_created','task_revision'].includes(sourceKind);}

function taskEvidenceSourceKindForEvent(eventType = '') {
  if(String(eventType||'').startsWith('graph_'))return 'task_revision';
  return ({task_created:'task_created',task_assigned:'task_assigned',task_dependency_changed:'task_dependency_changed',
    node_completed:'task_result',node_accepted:'task_acceptance',node_rework:'task_rework',node_failed:'task_failure',
    node_blocked:'task_blocked',node_cancelled:'task_cancelled'})[String(eventType||'')]||'';
}

function retryableEvidenceError(code, message) {
  const error = apiError(code, message, 409);
  error.retryable = true;
  return error;
}

function evidenceIngestResult({ clientRecordId = '', evidenceId = '', input = {}, status, code = '', message = '', retryable = false } = {}) {
  return { clientRecordId, evidenceId, sourceKind: input.sourceKind || input.source_kind || '', sourceId: input.sourceId || input.source_id || '',
    sourceVersionId: input.sourceVersionId || input.source_version_id || '', status, code, message, retryable: Boolean(retryable) };
}

function evidenceQuarantineReason(content, requestedReason = '') {
  if (requestedReason) return String(requestedReason).slice(0, 200);
  if (/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|私钥|密码|密钥)\s*[:=]/i.test(content)
    || /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/.test(content)) return 'credential_like_content';
  return '';
}

function reviewerTypeForFamily(family, familyId) {
  if (family.lifecycle_role === 'ubuddy' || /ubuddy|secretary/i.test(familyId)) return 'ubuddy_evaluator';
  return family.department_id || family.departmentId ? 'department_hr' : 'general_agent_evaluator';
}

function readSqliteEvolutionPreference(db, userId = '') {
  const row = db.prepare('SELECT * FROM cloud_user_evolution_preferences WHERE user_id=?').get(userId);
  return sqlitePreferencePayload(row || { user_id: userId, enabled: 1, policy_version: 'evolution_mandatory_upload_v1', state_revision: 1 });
}

function updateSqliteEvolutionPreference(db, { userId = '', deviceId = '', enabled = true, commandId = '', expectedStateRevision } = {}) {
  if (enabled === false) {
    throw apiError('evolution_preference_managed', 'Registered accounts must keep evolution evidence upload enabled.', 409);
  }
  if (!commandId) throw apiError('evolution_preference_command_required', 'Evolution preference commandId is required.', 400);
  if (expectedStateRevision === undefined || !Number.isFinite(Number(expectedStateRevision))) {
    throw apiError('evolution_preference_revision_required', 'Evolution preference expectedStateRevision is required.', 400);
  }
  return transaction(db, () => {
    db.prepare(`INSERT OR IGNORE INTO cloud_user_evolution_preferences(user_id,enabled,policy_version)
      VALUES(?,1,'evolution_mandatory_upload_v1')`).run(userId);
    const current = db.prepare('SELECT * FROM cloud_user_evolution_preferences WHERE user_id=?').get(userId);
    if (current.last_command_id === commandId) return { ...sqlitePreferencePayload(current), status: 'confirmed', idempotent: true };
    if (Number(current.state_revision) !== Number(expectedStateRevision)) {
      return { ...sqlitePreferencePayload(current), status: 'conflict', code: 'evolution_preference_conflict' };
    }
    const now = nowIso();
    db.prepare(`UPDATE cloud_user_evolution_preferences SET enabled=1,policy_version='evolution_mandatory_upload_v1',
      state_revision=state_revision+1,last_command_id=?,paused_at='',updated_at=? WHERE user_id=?`).run(commandId, now, userId);
    db.prepare(`UPDATE cloud_user_agent_instances_v3 SET
      personal_evolution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      cluster_contribution_consent=CASE WHEN sync_enabled=1 AND status='active' THEN 1 ELSE 0 END,
      personal_skill_auto_activate=0,updated_at=? WHERE user_id=?`).run(now, userId);
    db.prepare(`UPDATE cloud_memory_documents_v3 SET
      allow_personal_evolution=CASE WHEN sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END,
      allow_cluster_evolution=CASE WHEN sync_enabled=1 AND lifecycle_state='active' THEN 1 ELSE 0 END,
      updated_at=? WHERE user_id=?`).run(now, userId);
    return { ...readSqliteEvolutionPreference(db, userId), status: 'confirmed', actorDeviceId: deviceId };
  });
}

function changeSqlitePersonalVersion(db, { userId = '', deviceId = '', agentInstanceId = '', targetVersionId = '',
  commandId = '', expectedActiveVersionId, action = 'activate' } = {}) {
  if (!commandId) throw apiError('personal_version_command_required', 'Personal version commandId is required.', 400);
  if (expectedActiveVersionId === undefined) throw apiError('personal_version_revision_required', 'expectedActiveVersionId is required.', 400);
  return transaction(db, () => {
    const existing = db.prepare('SELECT payload_json FROM cloud_personal_version_commands WHERE user_id=? AND command_id=?').get(userId, commandId);
    if (existing) return { ...parseObject(existing.payload_json), idempotent: true };
    const instance = requireOwnedInstance(db, userId, agentInstanceId);
    const previousId = String(instance.active_personal_skill_version_id || '');
    if (previousId !== String(expectedActiveVersionId || '')) {
      const result = { authority: 'cloud', status: 'conflict', code: 'personal_version_conflict', activeVersionId: previousId };
      insertSqlitePersonalVersionCommand(db, { userId, commandId, agentInstanceId, action, targetVersionId,
        expectedActiveVersionId: String(expectedActiveVersionId || ''), previousId, resultId: previousId, deviceId,
        status: 'rejected', errorCode: result.code, result });
      return result;
    }
    const previous = previousId ? db.prepare(`SELECT * FROM cloud_user_agent_skill_versions_v3
      WHERE user_id=? AND user_agent_instance_id=? AND id=?`).get(userId, agentInstanceId, previousId) : null;
    let resolvedTargetId = String(targetVersionId || '');
    if (action === 'activate' && !resolvedTargetId) throw apiError('personal_version_target_required', 'A personal version is required for activation.', 400);
    const target = resolvedTargetId ? db.prepare(`SELECT * FROM cloud_user_agent_skill_versions_v3
      WHERE user_id=? AND user_agent_instance_id=? AND id=?`).get(userId, agentInstanceId, resolvedTargetId) : null;
    if (resolvedTargetId && (!target || target.stability_status !== 'stable' || target.status === 'rejected')) {
      throw apiError('personal_version_not_found', 'Stable personal version does not belong to this Agent.', 404);
    }
    if (previousId !== resolvedTargetId) activateVersion(db, { userId, instance, nextVersion: target,
      runId: target?.source_evolution_run_id || '', action: action === 'rollback' ? 'manual_skill_rollback' : 'manual_skill_activate', withinTransaction: true });
    if (target?.source_evolution_run_id) {
      const proposalRow = db.prepare('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id=? AND id=?').get(userId, target.source_evolution_run_id);
      if (proposalRow) {
        const pendingMemory = Number(db.prepare(`SELECT COUNT(*) count FROM cloud_personal_evolution_memory_operations_v4
          WHERE user_id=? AND proposal_id=? AND status='pending'`).get(userId, target.source_evolution_run_id)?.count || 0);
        const now = nowIso();
        const proposal = { ...evolutionPayload(proposalRow), status: pendingMemory ? 'partially_applied' : 'applied', decision: 'accepted',
          skillActionStatus: 'activated', decidedAt: now, updatedAt: now };
        db.prepare('UPDATE cloud_personal_evolution_proposals_v4 SET status=?,payload_json=?,updated_at=? WHERE user_id=? AND id=?')
          .run(proposal.status, JSON.stringify(proposal), now, userId, target.source_evolution_run_id);
        const actionId = `peaction_${crypto.randomUUID()}`;
        const actionPayload = { id: actionId, proposalId: target.source_evolution_run_id, targetKind: 'skill', targetId: target.id,
          decision: 'accept', revision: 1, actorDeviceId: deviceId, automatic: false, receivedAt: now };
        db.prepare(`INSERT OR IGNORE INTO cloud_personal_evolution_actions_v4
          (user_id,id,proposal_id,target_kind,target_id,decision,revision,actor_device_id,payload_json,received_at)
          VALUES(?,?,?,'skill',?,'accept',1,?,?,?)`).run(userId, actionId, target.source_evolution_run_id, target.id,
          deviceId, JSON.stringify(actionPayload), now);
        db.prepare("UPDATE cloud_evolution_runs SET status='applied',completed_at=CASE WHEN completed_at='' THEN ? ELSE completed_at END,updated_at=? WHERE id=?")
          .run(now, now, target.source_evolution_run_id);
      }
    }
    if (action === 'rollback' && previous?.source_evolution_run_id && previous.source_evolution_run_id !== target?.source_evolution_run_id) {
      db.prepare("UPDATE cloud_evolution_runs SET status='rolled_back',updated_at=? WHERE id=? AND status='applied'").run(nowIso(), previous.source_evolution_run_id);
    }
    const result = { authority: 'cloud', status: action === 'rollback' ? 'rolled_back' : 'activated', agentInstanceId,
      previousActiveVersionId: previousId, activeVersionId: resolvedTargetId, targetVersionId: resolvedTargetId };
    insertSqlitePersonalVersionCommand(db, { userId, commandId, agentInstanceId, action, targetVersionId: resolvedTargetId,
      expectedActiveVersionId: String(expectedActiveVersionId || ''), previousId, resultId: resolvedTargetId, deviceId, result });
    return result;
  });
}

function insertSqlitePersonalVersionCommand(db, { userId, commandId, agentInstanceId, action, targetVersionId = '',
  expectedActiveVersionId = '', previousId = '', resultId = '', deviceId = '', status = 'confirmed', errorCode = '', result = {} } = {}) {
  db.prepare(`INSERT INTO cloud_personal_version_commands
    (user_id,command_id,user_agent_instance_id,action,target_version_id,expected_active_version_id,previous_active_version_id,
     result_active_version_id,actor_device_id,status,error_code,payload_json,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(userId, commandId, agentInstanceId, action, targetVersionId,
    expectedActiveVersionId, previousId, resultId, deviceId, status, errorCode, JSON.stringify(result), nowIso());
}

function sqliteEvolutionUpdates(db, stage8, userId = '') {
  const instances = db.prepare(`SELECT i.*,f.name family_name FROM cloud_user_agent_instances_v3 i
    LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id WHERE i.user_id=? ORDER BY i.created_at,i.id`).all(userId);
  const personal = instances.map((instance) => {
    const versions = db.prepare(`SELECT * FROM cloud_user_agent_skill_versions_v3 WHERE user_id=? AND user_agent_instance_id=?
      ORDER BY created_at DESC,id DESC`).all(userId, instance.id).map(skillVersionPayload);
    const available = versions.filter((item) => item.available);
    return { agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id, agentName: instance.family_name || instance.agent_family_id,
      currentVersionId: instance.active_personal_skill_version_id || '', availableCount: available.length,
      latestAvailableVersion: available[0] || null, versions };
  });
  const instanceByFamily = new Map(instances.map((item) => [item.agent_family_id, item]));
  const market = db.prepare(`SELECT * FROM cloud_agent_families_v3 WHERE instance_kind='employee' AND recruitable=1 AND status='active'
    ORDER BY department_id,name,id`).all().map((family) => {
      const instance = instanceByFamily.get(family.id);
      const versions = stage8?.marketVersions?.({ familyId: family.id, userId, agentInstanceId: instance?.id || '' }) || [];
      const effectiveSkill = instance ? stage8?.effectiveSkill?.({ userId, agentInstanceId: instance.id }) || null : null;
      const currentMarketVersionId = effectiveSkill?.marketVersionId || '';
      const availableVersionCount = marketAvailableVersionCount(versions, currentMarketVersionId, Boolean(instance));
      const latestVersion = versions[0] || null;
      return { agentFamilyId: family.id, name: family.name || family.id, departmentId: family.department_id || '',
        recruited: Boolean(instance), agentInstanceId: instance?.id || '',
        updateStatus: marketUpdateStatus({ latestVersion, recruited: Boolean(instance), availableVersionCount }),
        releasedVersionCount: versions.length, availableVersionCount, currentMarketVersionId,
        latestVersion: latestVersion ? marketUpdateVersionSummary(latestVersion) : null };
    });
  return { authority: 'cloud', checkedAt: nowIso(), preference: readSqliteEvolutionPreference(db, userId), personal, market };
}

function marketAvailableVersionCount(versions = [], currentMarketVersionId = '', recruited = false) {
  if (!recruited) return versions.filter((item) => item.status === 'released').length;
  const currentIndex = currentMarketVersionId ? versions.findIndex((item) => item.id === currentMarketVersionId) : -1;
  const relevant = currentIndex >= 0 ? versions.slice(0, currentIndex + 1) : versions;
  return relevant.filter((item) => item.status === 'released' && !marketVersionFullyAdopted(item)).length;
}

function marketVersionFullyAdopted(version = {}) {
  if (version.adoption?.full === 'adopted') return true;
  const sections = Array.isArray(version.sections) ? version.sections : [];
  return Boolean(sections.length) && sections.every((section) => version.adoption?.sections?.[section.sectionId] === 'adopted');
}

function marketUpdateStatus({ latestVersion = null, recruited = false, availableVersionCount = 0 } = {}) {
  if (!latestVersion) return 'no_published_version';
  if (!recruited) return 'view_only_available';
  if (latestVersion.status === 'suspended') return 'suspended';
  if (availableVersionCount > 0) return 'available';
  return 'current';
}

function marketUpdateVersionSummary(version = {}) {
  const sections = Array.isArray(version.sections) ? version.sections : [];
  return {
    id: version.id || '', agentFamilyId: version.agentFamilyId || '', parentVersionId: version.parentVersionId || '',
    versionKind: version.versionKind || '', baseAgentVersionId: version.baseAgentVersionId || '', status: version.status || '',
    statusReason: version.statusReason || '', suspendedAt: version.suspendedAt || '', createdAt: version.createdAt || '',
    algorithmVersion: version.algorithmVersion || '', health: version.health || null, adoption: version.adoption || { full: '', sections: {} },
    sectionCount: sections.length,
    sections: sections.map((section) => ({ sectionId: section.sectionId || '', title: section.title || section.sectionId || '',
      contentHash: section.contentHash || '', supportCount: Number(section.supportCount || 0) })),
  };
}

function sqlitePreferencePayload(row = {}) {
  return { authority: 'cloud', enabled: true, mutable: false,
    policyVersion: 'evolution_mandatory_upload_v1', stateRevision: Number(row.state_revision || 1),
    lastCommandId: row.last_command_id || '', pausedAt: '', updatedAt: row.updated_at || '' };
}

function runPayload(row) {
  return {
    id: row.id, scope: row.evolution_scope, authority: 'cloud', userId: row.owner_user_id,
    agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id, status: row.status,
    evidenceCount: Number(row.evidence_count || 0), algorithmVersion: row.algorithm_version,
    candidatePersonalSkillVersionId: row.candidate_personal_skill_version_id || '', summary: row.summary || '',
    errorCode: row.error_code || '', errorText: row.error_text || '', createdAt: row.created_at,
    updatedAt: row.updated_at, completedAt: row.completed_at || '',
  };
}

function evidenceUsagePayload(row) {
  return {
    evidenceId: row.evidence_id,
    status: row.status,
    rejectionKind: row.rejection_kind || '',
    transitionReason: row.transition_reason || '',
    reEvaluationBasisHash: row.re_evaluation_basis_hash || '',
  };
}

function evidenceUsageListPayload(row) {
  return { evidenceId:row.evidence_id,sourceKind:row.source_kind,sourceId:row.source_id,sourceVersionId:row.source_version_id||'',
    contentHash:row.content_hash||'',scope:row.evolution_scope,consumerId:row.consumer_id,status:row.status,runId:row.run_id||'',
    algorithmVersion:row.algorithm_version||'',rejectionKind:row.rejection_kind||'',transitionReason:row.transition_reason||'',
    reEvaluationBasisHash:row.re_evaluation_basis_hash||'',personalThresholdEligible:Boolean(row.personal_threshold_eligible),
    eligibilityPolicyVersion:row.eligibility_policy_version||'',reservedAt:row.reserved_at||'',leaseExpiresAt:row.lease_expires_at||'',
    terminalAt:row.terminal_at||'',occurredAt:row.occurred_at||'',updatedAt:row.updated_at||'' };
}

function encodeUsageCursor(row={}) { return Buffer.from(JSON.stringify({updatedAt:row.updated_at||row.updatedAt||'',evidenceId:row.evidence_id||row.evidenceId||''})).toString('base64url'); }
function decodeUsageCursor(value='') { if(!value)return {};try{return JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'))||{};}catch{return {};} }

function skillVersionPayload(row) {
  return { ...payloadOf(row), id: row.id, userAgentInstanceId: row.user_agent_instance_id, authority: row.authority,
    stabilityStatus: row.stability_status, status: row.status, sourceEvolutionRunId: row.source_evolution_run_id,
    parentVersionId: row.parent_version_id, available: row.status === 'candidate' && row.stability_status === 'stable',
    activatedAt: row.activated_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function evolutionPayload(row = {}) {
  return { ...parseObject(row?.payload_json), ...Object.fromEntries(Object.entries(row || {}).filter(([key]) => key !== 'payload_json')) };
}

function payloadOf(row) { return parseObject(row?.payload_json); }
function parseObject(value) { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function parseArray(value) { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function uniqueStrings(values) { return [...new Set((values || []).map(String).filter(Boolean))]; }
function normalizeSqliteEvolutionEnvelope(value){
  if(!value)return null;
  if(value.algorithm!=='aes-256-gcm+rsa-oaep-sha256'||value.keyWrapAlgorithm!=='rsa-oaep-sha256'||!value.keyId
    ||!value.wrappedDataKey||!value.ciphertext||!value.nonce||!value.tag)throw apiError('evolution_envelope_invalid','Evolution Evidence envelope is invalid.',400);
  return {algorithm:value.algorithm,keyId:String(value.keyId),keyVersion:Number(value.keyVersion||1),keyWrapAlgorithm:value.keyWrapAlgorithm,
    wrappedDataKey:String(value.wrappedDataKey),ciphertext:String(value.ciphertext),nonce:String(value.nonce),tag:String(value.tag),
    envelopeFormat:String(value.envelopeFormat||'evolution_envelope_v1')};
}
function sqliteValidatedEvidenceConfidence(sourceKind,input={}) {
  const base=({task_acceptance:1,task_result:.95,task_rework:.9,task_failure:.9,task_blocked:.85,task_cancelled:.8,
    memory_version:.9,task_shared_summary:.95,model_execution:.9,model_execution_metric:.9,message:.8,
    conversation_segment:.9,collaboration_message:.8,delegation_event:.9,market_adoption:1,market_rejection:1,market_rollback:1})[sourceKind]??.75;
  return Math.min(base,Math.max(0,Number(input.confidence??1)));
}
function sqliteValidatedEvidenceSummary(sourceKind,input={}) {
  const terminalTask=sourceKind.startsWith('task_')&&!['task_created','task_assigned','task_dependency_changed'].includes(sourceKind);
  return {policyVersion:'cloud_evidence_validation_v1',sourceVerified:true,taskRelevance:terminalTask?1:.8,
    acceptanceQuality:sourceKind==='task_acceptance'?1:sourceKind==='task_failure'?0.25:terminalTask?0.75:0.8,
    claimedConfidence:Number(input.confidence??1)};
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value))); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function nowIso() { return new Date().toISOString(); }
function apiError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }
function assertAuthorityEnabled(_enabled) {}
function terminalError(code, message) { const error = apiError(code, message, 500); error.terminal = true; return error; }
function transaction(db, callback) { db.exec('BEGIN IMMEDIATE'); try { const value = callback(); db.exec('COMMIT'); return value; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } }

export const evolutionServiceContracts = Object.freeze({
  PerformanceLevelService: ['status', 'calculate'],
  ClusterEvolutionService: ['status', 'requestRun'],
  MarketVersionService: ['status', 'listVersions', 'adoptSections', 'rollbackSections'],
});
