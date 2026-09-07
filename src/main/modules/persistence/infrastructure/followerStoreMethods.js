import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';
import {
  FOLLOWER_GRANT_CATEGORIES,
  FOLLOWER_REPORT_KINDS,
  FOLLOWER_RUN_STATUSES,
  FOLLOWER_WORK_SOURCE_CATEGORIES,
  normalizeFollowerPreferences,
} from '../../../../shared/follower/contracts.js';

export function installFollowerStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureFollowerWorkspaceState({ ownerUserId = '', workspaceId = 'workspace_personal' } = {}) {
      if (!ownerUserId || !workspaceId) throw followerStoreError('follower_owner_workspace_required');
      const now = nowIso();
      const insertedWorkspace = run(this.db, `INSERT INTO follower_workspace_state(
        owner_user_id,account_workspace_id,authorization_epoch,disclosure_confirmed,disclosure_version,
        provider_snapshot_json,preferences_json,preference_revision,preference_hash,report_sync_enabled,
        evolution_enabled,created_at,updated_at
      ) VALUES(?,?,1,1,'follower_default_work_sources_v1','{}','{}',1,'',1,CASE WHEN ?='workspace_personal' THEN 1 ELSE 0 END,?,?)
      ON CONFLICT(owner_user_id,account_workspace_id) DO NOTHING`, [ownerUserId, workspaceId, workspaceId, now, now]);
      const policyRows = all(this.db, `SELECT category,enabled FROM follower_access_grants
        WHERE owner_user_id=? AND account_workspace_id=? AND category IN (${FOLLOWER_WORK_SOURCE_CATEGORIES.map(() => '?').join(',')})`, [
        ownerUserId, workspaceId, ...FOLLOWER_WORK_SOURCE_CATEGORIES,
      ]);
      const policyByCategory = new Map(policyRows.map((row) => [row.category, Boolean(row.enabled)]));
      const workspace = get(this.db, `SELECT disclosure_confirmed,disclosure_version FROM follower_workspace_state
        WHERE owner_user_id=? AND account_workspace_id=?`, [ownerUserId, workspaceId]);
      const policyChanged = !insertedWorkspace.changes && (
        !Boolean(workspace?.disclosure_confirmed)
        || workspace?.disclosure_version !== 'follower_default_work_sources_v1'
        || FOLLOWER_WORK_SOURCE_CATEGORIES.some((category) => policyByCategory.get(category) !== true)
      );
      if (policyChanged) {
        run(this.db, `UPDATE follower_workspace_state SET authorization_epoch=authorization_epoch+1,
          disclosure_confirmed=1,disclosure_version='follower_default_work_sources_v1',updated_at=?
          WHERE owner_user_id=? AND account_workspace_id=?`, [now, ownerUserId, workspaceId]);
      }
      for (const category of FOLLOWER_WORK_SOURCE_CATEGORIES) {
        run(this.db, `INSERT INTO follower_access_grants(
          id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
        ) VALUES(?,?,?,?,1,1,?,'',?,?) ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET
          enabled=1,scope_version=follower_access_grants.scope_version+CASE WHEN follower_access_grants.enabled=0 THEN 1 ELSE 0 END,
          granted_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.granted_at END,
          revoked_at='',updated_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.updated_at END`, [
          newId('follower_grant'), ownerUserId, workspaceId, category, now, now, now,
        ]);
      }
      run(this.db, `INSERT INTO follower_access_grants(
        id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
      ) VALUES(?,?,?,'sync_sanitized_reports',1,1,?,'',?,?) ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET
        enabled=1,granted_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.granted_at END,
        revoked_at='',updated_at=CASE WHEN follower_access_grants.enabled=0 THEN excluded.updated_at ELSE follower_access_grants.updated_at END`, [
        newId('follower_grant'), ownerUserId, workspaceId, now, now, now,
      ]);
      return normalizeWorkspaceState(get(this.db, 'SELECT * FROM follower_workspace_state WHERE owner_user_id=? AND account_workspace_id=?', [ownerUserId, workspaceId]));
    },

    followerWorkspaceState({ ownerUserId = '', workspaceId = 'workspace_personal' } = {}) {
      return normalizeWorkspaceState(get(this.db, 'SELECT * FROM follower_workspace_state WHERE owner_user_id=? AND account_workspace_id=?', [ownerUserId, workspaceId]));
    },

    updateFollowerAccess({ ownerUserId = '', workspaceId = 'workspace_personal', disclosureConfirmed, disclosureVersion = '', providerSnapshot = null, grants = null } = {}) {
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId });
        const now = nowIso();
        let changed = false;
        void disclosureConfirmed; void disclosureVersion;
        if (providerSnapshot != null && JSON.stringify(providerSnapshot) !== JSON.stringify(current.providerSnapshot)) changed = true;
        const requested = grants && typeof grants === 'object' ? grants : {};
        for (const category of FOLLOWER_GRANT_CATEGORIES) {
          if (FOLLOWER_WORK_SOURCE_CATEGORIES.includes(category)) continue;
          if (!(category in requested)) continue;
          const existing = get(this.db, `SELECT * FROM follower_access_grants
            WHERE owner_user_id=? AND account_workspace_id=? AND category=?`, [ownerUserId, workspaceId, category]);
          const enabled = requested[category] === true ? 1 : 0;
          if (!existing || Number(existing.enabled) !== enabled) changed = true;
          const version = Math.max(1, Number(existing?.scope_version || 0) + (existing && Number(existing.enabled) === enabled ? 0 : 1));
          run(this.db, `INSERT INTO follower_access_grants(
            id,owner_user_id,account_workspace_id,category,enabled,scope_version,granted_at,revoked_at,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,account_workspace_id,category) DO UPDATE SET
            enabled=excluded.enabled,scope_version=excluded.scope_version,
            granted_at=CASE WHEN excluded.enabled=1 THEN excluded.updated_at ELSE follower_access_grants.granted_at END,
            revoked_at=CASE WHEN excluded.enabled=0 THEN excluded.updated_at ELSE '' END,updated_at=excluded.updated_at`, [
            existing?.id || newId('follower_grant'), ownerUserId, workspaceId, category, enabled, version,
            enabled ? now : existing?.granted_at || '', enabled ? '' : now, existing?.created_at || now, now,
          ]);
        }
        const nextEpoch = current.authorizationEpoch + (changed ? 1 : 0);
        run(this.db, `UPDATE follower_workspace_state SET authorization_epoch=?,
          disclosure_confirmed=?,disclosure_version=?,provider_snapshot_json=?,updated_at=?
          WHERE owner_user_id=? AND account_workspace_id=?`, [
          nextEpoch,
          1,
          'follower_default_work_sources_v1',
          providerSnapshot == null ? JSON.stringify(current.providerSnapshot) : JSON.stringify(providerSnapshot),
          now, ownerUserId, workspaceId,
        ]);
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.followerAccessSnapshot({ ownerUserId, workspaceId });
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    followerAccessSnapshot({ ownerUserId = '', workspaceId = 'workspace_personal' } = {}) {
      const state = this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId });
      const rows = all(this.db, `SELECT * FROM follower_access_grants
        WHERE owner_user_id=? AND account_workspace_id=? ORDER BY category`, [ownerUserId, workspaceId]);
      const grants = Object.fromEntries(FOLLOWER_GRANT_CATEGORIES.map((category) => [category, false]));
      const scopeVersions = {};
      for (const row of rows) {
        if (!FOLLOWER_GRANT_CATEGORIES.includes(row.category)) continue;
        grants[row.category] = Boolean(row.enabled);
        scopeVersions[row.category] = Number(row.scope_version || 1);
      }
      return { ...state, grants, scopeVersions };
    },

    updateFollowerPreferences({ ownerUserId = '', workspaceId = 'workspace_personal', preferences = {}, expectedRevision = 0 } = {}) {
      const current = this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId });
      if (expectedRevision && expectedRevision !== current.preferenceRevision) throw followerStoreError('follower_preference_revision_conflict');
      const normalized = normalizeFollowerPreferences(preferences);
      const json = JSON.stringify(normalized);
      const revision = current.preferenceRevision + 1;
      const hash = crypto.createHash('sha256').update(json).digest('hex');
      run(this.db, `UPDATE follower_workspace_state SET preferences_json=?,preference_revision=?,
        preference_hash=?,updated_at=? WHERE owner_user_id=? AND account_workspace_id=?`, [
        json, revision, hash, nowIso(), ownerUserId, workspaceId,
      ]);
      return this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId });
    },

    updateFollowerCloudSettings({ ownerUserId = '', workspaceId = 'workspace_personal', reportSyncEnabled, evolutionEnabled } = {}) {
      const current = this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId });
      const sync = true;
      const evolution = workspaceId === 'workspace_personal';
      const now = nowIso();
      run(this.db, `UPDATE follower_workspace_state SET report_sync_enabled=?,evolution_enabled=?,updated_at=?
        WHERE owner_user_id=? AND account_workspace_id=?`, [sync ? 1 : 0, evolution ? 1 : 0, now, ownerUserId, workspaceId]);
      const binding = this.upsertFollowerEvolutionBinding({ ownerUserId, workspaceId, patch: {
        reportSyncEnabled: sync, evolutionEnabled: evolution, state: evolution ? 'enable_pending' : 'disabled',
      } });
      if (sync) {
        const reports = all(this.db, `SELECT id,validated_content_hash FROM follower_reports
          WHERE owner_user_id=? AND account_workspace_id=? AND privacy_state='passed' AND validated_content_hash<>'' AND deleted_at=''`, [ownerUserId, workspaceId]);
        for (const report of reports) this.enqueueFollowerReportSync({ reportId: report.id, operation: 'upsert', validatedHash: report.validated_content_hash });
      }
      return { state: this.ensureFollowerWorkspaceState({ ownerUserId, workspaceId }), binding };
    },

    upsertFollowerEvolutionBinding({ ownerUserId = '', workspaceId = 'workspace_personal', patch = {} } = {}) {
      const existing = get(this.db, `SELECT * FROM follower_evolution_bindings
        WHERE owner_user_id=? AND account_workspace_id=?`, [ownerUserId, workspaceId]);
      const now = nowIso();
      const revision = Math.max(1, Number(patch.stateRevision || existing?.state_revision || 0) + (existing ? 1 : 0));
      const value = (key, column, fallback = '') => key in patch ? patch[key] : existing?.[column] ?? fallback;
      const preferenceMemory = 'preferenceMemory' in patch
        ? patch.preferenceMemory
        : safeJsonParse(existing?.preference_memory_json, {});
      run(this.db, `INSERT INTO follower_evolution_bindings(
        owner_user_id,account_workspace_id,remote_user_id,canonical_service_instance_id,subject_kind,state,state_revision,
        report_sync_enabled,evolution_enabled,personal_overlay_version,personal_overlay_text,personal_overlay_hash,
        preference_memory_version,preference_memory_json,preference_memory_hash,cluster_bundle_id,cluster_skill_version,last_error,created_at,updated_at
      ) VALUES(?,?,?,?,'system_service',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,account_workspace_id) DO UPDATE SET
        remote_user_id=excluded.remote_user_id,canonical_service_instance_id=excluded.canonical_service_instance_id,
        state=excluded.state,state_revision=excluded.state_revision,report_sync_enabled=excluded.report_sync_enabled,
        evolution_enabled=excluded.evolution_enabled,personal_overlay_version=excluded.personal_overlay_version,
        personal_overlay_text=excluded.personal_overlay_text,personal_overlay_hash=excluded.personal_overlay_hash,
        preference_memory_version=excluded.preference_memory_version,preference_memory_json=excluded.preference_memory_json,
        preference_memory_hash=excluded.preference_memory_hash,cluster_bundle_id=excluded.cluster_bundle_id,
        cluster_skill_version=excluded.cluster_skill_version,last_error=excluded.last_error,updated_at=excluded.updated_at`, [
        ownerUserId, workspaceId, value('remoteUserId', 'remote_user_id'), value('canonicalServiceInstanceId', 'canonical_service_instance_id'),
        value('state', 'state', 'disabled'), revision, value('reportSyncEnabled', 'report_sync_enabled', 0) ? 1 : 0,
        value('evolutionEnabled', 'evolution_enabled', 0) ? 1 : 0, value('personalOverlayVersion', 'personal_overlay_version'),
        value('personalOverlayText', 'personal_overlay_text'), value('personalOverlayHash', 'personal_overlay_hash'),
        value('preferenceMemoryVersion', 'preference_memory_version'), JSON.stringify(preferenceMemory || {}),
        value('preferenceMemoryHash', 'preference_memory_hash'), value('clusterBundleId', 'cluster_bundle_id'),
        value('clusterSkillVersion', 'cluster_skill_version'), value('lastError', 'last_error'), existing?.created_at || now, now,
      ]);
      return normalizeEvolutionBinding(get(this.db, `SELECT * FROM follower_evolution_bindings
        WHERE owner_user_id=? AND account_workspace_id=?`, [ownerUserId, workspaceId]));
    },

    followerEvolutionBinding({ ownerUserId = '', workspaceId = 'workspace_personal' } = {}) {
      return normalizeEvolutionBinding(get(this.db, `SELECT * FROM follower_evolution_bindings
        WHERE owner_user_id=? AND account_workspace_id=?`, [ownerUserId, workspaceId]));
    },

    enqueueFollowerReportSync({ reportId = '', operation = 'upsert', validatedHash = '' } = {}) {
      if (!reportId || !['upsert', 'delete'].includes(operation) || !validatedHash) throw followerStoreError('follower_sync_outbox_invalid');
      const existing = get(this.db, `SELECT * FROM follower_sync_outbox WHERE report_id=? AND operation=? AND validated_hash=?`, [reportId, operation, validatedHash]);
      const now = nowIso();
      run(this.db, `INSERT INTO follower_sync_outbox(id,report_id,operation,validated_hash,status,created_at,updated_at)
        VALUES(?,?,?,?, 'pending',?,?) ON CONFLICT(report_id,operation,validated_hash) DO UPDATE SET
        status=CASE WHEN follower_sync_outbox.status='completed' THEN follower_sync_outbox.status ELSE 'pending' END,
        last_error='',updated_at=excluded.updated_at`, [existing?.id || newId('follower_sync'), reportId, operation, validatedHash, existing?.created_at || now, now]);
      return normalizeSyncOutbox(get(this.db, `SELECT * FROM follower_sync_outbox WHERE report_id=? AND operation=? AND validated_hash=?`, [reportId, operation, validatedHash]));
    },

    claimFollowerSyncOutbox({ ownerUserId = '', workspaceId = '', leaseOwner = '', leaseExpiresAt = '', limit = 50 } = {}) {
      const rows = all(this.db, `SELECT outbox.id FROM follower_sync_outbox outbox JOIN follower_reports report ON report.id=outbox.report_id
        WHERE report.owner_user_id=? AND report.account_workspace_id=? AND outbox.status IN ('pending','failed')
          AND (outbox.lease_expires_at='' OR outbox.lease_expires_at<=?) ORDER BY outbox.created_at,outbox.id LIMIT ?`, [
        ownerUserId, workspaceId, nowIso(), Math.max(1, Math.min(100, Number(limit || 50))),
      ]);
      for (const row of rows) run(this.db, `UPDATE follower_sync_outbox SET status='sending',attempt_count=attempt_count+1,
        lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND status IN ('pending','failed')`, [leaseOwner, leaseExpiresAt, nowIso(), row.id]);
      return rows.map((row) => normalizeSyncOutbox(get(this.db, 'SELECT * FROM follower_sync_outbox WHERE id=?', [row.id]))).filter((row) => row?.status === 'sending');
    },

    settleFollowerSyncOutbox({ id = '', status = 'completed', projectionSessionId = '', projectionMessageId = '', error = '' } = {}) {
      const normalized = ['completed', 'failed', 'blocked_incompatible'].includes(status) ? status : 'failed';
      const now = nowIso();
      run(this.db, `UPDATE follower_sync_outbox SET status=?,projection_session_id=?,projection_message_id=?,last_error=?,
        lease_owner='',lease_expires_at='',completed_at=CASE WHEN ?='completed' THEN ? ELSE completed_at END,updated_at=? WHERE id=?`, [
        normalized, projectionSessionId, projectionMessageId, String(error || '').slice(0, 500), normalized, now, now, id,
      ]);
      return normalizeSyncOutbox(get(this.db, 'SELECT * FROM follower_sync_outbox WHERE id=?', [id]));
    },

    upsertFollowerReportProjection({ ownerUserId = '', workspaceId = 'workspace_personal', projection = {} } = {}) {
      if (!projection.projectionId || !projection.validatedHash) throw followerStoreError('follower_projection_invalid');
      const existing = get(this.db, `SELECT * FROM follower_report_projections WHERE owner_user_id=? AND account_workspace_id=? AND projection_id=?`, [ownerUserId, workspaceId, projection.projectionId]);
      if (existing && Number(existing.revision || 0) > Number(projection.revision || 1)) return normalizeProjection(existing);
      const now = nowIso();
      run(this.db, `INSERT INTO follower_report_projections(
        owner_user_id,account_workspace_id,projection_id,origin_device_id,report_kind,window_start,window_end,timezone,
        projection_json,sync_body,validated_hash,privacy_validator_version,revision,read_at,deleted_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'',?,?,?) ON CONFLICT(owner_user_id,account_workspace_id,projection_id) DO UPDATE SET
        origin_device_id=excluded.origin_device_id,report_kind=excluded.report_kind,window_start=excluded.window_start,
        window_end=excluded.window_end,timezone=excluded.timezone,projection_json=excluded.projection_json,sync_body=excluded.sync_body,
        validated_hash=excluded.validated_hash,privacy_validator_version=excluded.privacy_validator_version,revision=excluded.revision,
        deleted_at=excluded.deleted_at,updated_at=excluded.updated_at`, [
        ownerUserId, workspaceId, projection.projectionId, projection.originDeviceId || '', projection.reportKind || 'daily_brief',
        projection.window?.startAt || '', projection.window?.endAt || '', projection.window?.timezone || '', JSON.stringify(projection),
        projection.syncBody || '', projection.validatedHash, projection.privacyValidatorVersion || '', Number(projection.revision || 1),
        projection.deletedAt || '', existing?.created_at || projection.createdAt || now, projection.updatedAt || now,
      ]);
      return normalizeProjection(get(this.db, `SELECT * FROM follower_report_projections WHERE owner_user_id=? AND account_workspace_id=? AND projection_id=?`, [ownerUserId, workspaceId, projection.projectionId]));
    },

    listFollowerReportProjections({ ownerUserId = '', workspaceId = 'workspace_personal', limit = 100 } = {}) {
      return all(this.db, `SELECT * FROM follower_report_projections WHERE owner_user_id=? AND account_workspace_id=? AND deleted_at=''
        ORDER BY updated_at DESC,projection_id DESC LIMIT ?`, [ownerUserId, workspaceId, Math.max(1, Math.min(500, Number(limit || 100)))]).map(normalizeProjection);
    },

    getFollowerReportProjection({ ownerUserId = '', workspaceId = 'workspace_personal', projectionId = '' } = {}) {
      return normalizeProjection(get(this.db, `SELECT * FROM follower_report_projections WHERE owner_user_id=? AND account_workspace_id=?
        AND projection_id=? AND deleted_at=''`, [ownerUserId, workspaceId, projectionId]));
    },

    markFollowerReportProjectionRead({ ownerUserId = '', workspaceId = 'workspace_personal', projectionId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE follower_report_projections SET read_at=CASE WHEN read_at='' THEN ? ELSE read_at END,updated_at=?
        WHERE owner_user_id=? AND account_workspace_id=? AND projection_id=? AND deleted_at=''`, [now, now, ownerUserId, workspaceId, projectionId]);
      return this.getFollowerReportProjection({ ownerUserId, workspaceId, projectionId });
    },

    deleteFollowerReportProjection({ ownerUserId = '', workspaceId = 'workspace_personal', projectionId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE follower_report_projections SET deleted_at=?,updated_at=? WHERE owner_user_id=? AND account_workspace_id=?
        AND projection_id=? AND deleted_at=''`, [now, now, ownerUserId, workspaceId, projectionId]);
      return { ok: true, id: projectionId };
    },

    recordFollowerPreferenceSignal({ ownerUserId = '', workspaceId = 'workspace_personal', signal = {} } = {}) {
      const id = newId('follower_signal'); const now = nowIso();
      run(this.db, `INSERT INTO follower_preference_signals(
        id,owner_user_id,account_workspace_id,source_kind,source_id,source_version,signal_kind,normalized_json,signal_hash,
        lineage_key,explicit,confidence,personal_eligible,cluster_eligible,validation_state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'validated',?,?) ON CONFLICT(owner_user_id,account_workspace_id,lineage_key,signal_hash) DO NOTHING`, [
        id, ownerUserId, workspaceId, signal.sourceKind, signal.sourceId, signal.sourceVersion || '', signal.signalKind,
        JSON.stringify(signal.normalized || {}), signal.signalHash, signal.lineageKey, signal.explicit ? 1 : 0, Number(signal.confidence || 0),
        signal.personalEligible ? 1 : 0, signal.clusterEligible ? 1 : 0, now, now,
      ]);
      return normalizePreferenceSignal(get(this.db, `SELECT * FROM follower_preference_signals WHERE owner_user_id=? AND account_workspace_id=?
        AND lineage_key=? AND signal_hash=?`, [ownerUserId, workspaceId, signal.lineageKey, signal.signalHash]));
    },

    pendingFollowerPreferenceSignals({ ownerUserId = '', workspaceId = 'workspace_personal', limit = 100 } = {}) {
      return all(this.db, `SELECT * FROM follower_preference_signals WHERE owner_user_id=? AND account_workspace_id=?
        AND validation_state='validated' AND evolution_outbox_id='' ORDER BY created_at,id LIMIT ?`, [
        ownerUserId, workspaceId, Math.max(1, Math.min(500, Number(limit || 100))),
      ]).map(normalizePreferenceSignal);
    },

    settleFollowerPreferenceSignal({ id = '', evolutionOutboxId = '', evidenceId = '', state = 'uploaded' } = {}) {
      run(this.db, `UPDATE follower_preference_signals SET evolution_outbox_id=?,evidence_id=?,validation_state=?,updated_at=? WHERE id=?`, [
        evolutionOutboxId, evidenceId, state, nowIso(), id,
      ]);
      return normalizePreferenceSignal(get(this.db, 'SELECT * FROM follower_preference_signals WHERE id=?', [id]));
    },

    upsertFollowerSchedule({ ownerUserId = '', workspaceId = 'workspace_personal', schedule = {}, nextOccurrenceAt = '' } = {}) {
      if (!ownerUserId || !FOLLOWER_REPORT_KINDS.includes(schedule.kind)) throw followerStoreError('follower_schedule_invalid');
      const existing = get(this.db, `SELECT * FROM follower_schedules WHERE owner_user_id=? AND account_workspace_id=? AND kind=?`, [ownerUserId, workspaceId, schedule.kind]);
      const now = nowIso();
      const revision = Math.max(1, Number(existing?.revision || 0) + 1);
      run(this.db, `INSERT INTO follower_schedules(
        id,owner_user_id,account_workspace_id,kind,enabled,timezone,frequency,days_json,local_time,missed_run_policy,
        revision,next_occurrence_at,last_run_at,last_success_window_end,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'coalesce_once',?,?, '', '',?,?) ON CONFLICT(owner_user_id,account_workspace_id,kind) DO UPDATE SET
        enabled=excluded.enabled,timezone=excluded.timezone,frequency=excluded.frequency,days_json=excluded.days_json,
        local_time=excluded.local_time,revision=excluded.revision,next_occurrence_at=excluded.next_occurrence_at,updated_at=excluded.updated_at`, [
        existing?.id || newId('follower_schedule'), ownerUserId, workspaceId, schedule.kind, schedule.enabled ? 1 : 0,
        schedule.timezone, schedule.frequency, JSON.stringify(schedule.daysOfWeek || []), schedule.localTime, revision,
        nextOccurrenceAt, existing?.created_at || now, now,
      ]);
      return this.getFollowerSchedule({ ownerUserId, workspaceId, kind: schedule.kind });
    },

    getFollowerSchedule({ ownerUserId = '', workspaceId = '', kind = '', id = '' } = {}) {
      const row = id
        ? get(this.db, 'SELECT * FROM follower_schedules WHERE id=?', [id])
        : get(this.db, 'SELECT * FROM follower_schedules WHERE owner_user_id=? AND account_workspace_id=? AND kind=?', [ownerUserId, workspaceId, kind]);
      return normalizeSchedule(row);
    },

    listFollowerSchedules({ ownerUserId = '', workspaceId = '', enabledOnly = false } = {}) {
      const where = ['owner_user_id=?'];
      const params = [ownerUserId];
      if (workspaceId) { where.push('account_workspace_id=?'); params.push(workspaceId); }
      if (enabledOnly) where.push('enabled=1');
      return all(this.db, `SELECT * FROM follower_schedules WHERE ${where.join(' AND ')} ORDER BY kind`, params).map(normalizeSchedule);
    },

    advanceFollowerSchedule({ id = '', nextOccurrenceAt = '', lastRunAt, lastSuccessWindowEnd } = {}) {
      const fields = ['next_occurrence_at=?', 'updated_at=?'];
      const params = [nextOccurrenceAt, nowIso()];
      if (lastRunAt !== undefined) { fields.push('last_run_at=?'); params.push(lastRunAt); }
      if (lastSuccessWindowEnd !== undefined) { fields.push('last_success_window_end=?'); params.push(lastSuccessWindowEnd); }
      params.push(id);
      run(this.db, `UPDATE follower_schedules SET ${fields.join(',')} WHERE id=?`, params);
      return this.getFollowerSchedule({ id });
    },

    claimFollowerRun({ id = '', leaseOwner = '', leaseExpiresAt = '', expectedStatuses = ['queued', 'retry_wait'] } = {}) {
      const valid = expectedStatuses.filter((item) => FOLLOWER_RUN_STATUSES.includes(item));
      if (!id || !leaseOwner || !valid.length) return null;
      const now = nowIso();
      const result = run(this.db, `UPDATE follower_runs SET status='collecting',lease_owner=?,lease_expires_at=?,
        lease_generation=lease_generation+1,started_at=CASE WHEN started_at='' THEN ? ELSE started_at END,updated_at=?
        WHERE id=? AND status IN (${valid.map(() => '?').join(',')}) AND (lease_expires_at='' OR lease_expires_at<=?)`, [
        leaseOwner, leaseExpiresAt, now, now, id, ...valid, now,
      ]);
      return Number(result.changes || 0) ? this.getFollowerRun(id) : null;
    },

    recoverFollowerRuns({ ownerUserId = '', now = nowIso() } = {}) {
      const rows = all(this.db, `SELECT id FROM follower_runs WHERE owner_user_id=? AND status IN ('collecting','generating','validating','committing','retry_wait')
        AND (lease_expires_at='' OR lease_expires_at<=?) ORDER BY created_at`, [ownerUserId, now]);
      for (const row of rows) run(this.db, `UPDATE follower_runs SET status='queued',lease_owner='',lease_expires_at='',updated_at=? WHERE id=?`, [nowIso(), row.id]);
      return rows.map((row) => this.getFollowerRun(row.id));
    },

    listWorkNotificationIntents({ ownerUserId = '', statuses = ['pending'], limit = 100 } = {}) {
      const valid = (Array.isArray(statuses) ? statuses : []).filter(Boolean);
      const params = [ownerUserId, ...valid, Math.max(1, Math.min(500, Number(limit || 100)))];
      return all(this.db, `SELECT * FROM work_notification_intents WHERE owner_user_id=?${valid.length ? ` AND status IN (${valid.map(() => '?').join(',')})` : ''}
        ORDER BY created_at,id LIMIT ?`, params).map(normalizeNotificationIntent);
    },

    settleWorkNotificationIntent({ id = '', status = 'shown' } = {}) {
      const normalized = ['shown', 'suppressed', 'failed'].includes(status) ? status : 'failed';
      const now = nowIso();
      run(this.db, `UPDATE work_notification_intents SET status=?,shown_at=CASE WHEN ?='shown' THEN ? ELSE shown_at END,
        suppressed_at=CASE WHEN ?='suppressed' THEN ? ELSE suppressed_at END,updated_at=? WHERE id=?`, [normalized, normalized, now, normalized, now, now, id]);
      return normalizeNotificationIntent(get(this.db, 'SELECT * FROM work_notification_intents WHERE id=?', [id]));
    },

    recordFollowerQuarantine({ ownerUserId = '', workspaceId = 'workspace_personal', entityKind = '', identityKey = '',
      reasonCode = '', expectedHash = '', observedHash = '', metadata = {} } = {}) {
      const id = newId('follower_quarantine');
      run(this.db, `INSERT INTO follower_quarantine_events(
        id,owner_user_id,account_workspace_id,entity_kind,identity_key,reason_code,expected_hash,observed_hash,metadata_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, ownerUserId, workspaceId, String(entityKind || '').slice(0, 80),
        String(identityKey || '').slice(0, 300), String(reasonCode || '').slice(0, 120), String(expectedHash || '').slice(0, 128),
        String(observedHash || '').slice(0, 128), JSON.stringify(metadata || {}), nowIso()]);
      return get(this.db, 'SELECT * FROM follower_quarantine_events WHERE id=?', [id]);
    },

    createFollowerRun({ id = '', scheduleId = '', ownerUserId = '', workspaceId = 'workspace_personal', kind = '', trigger = 'manual', clientRequestId = '', occurrenceKey = '', window = {}, authorization = {}, versions = {}, originDeviceId = 'local' } = {}) {
      if (!ownerUserId || !FOLLOWER_REPORT_KINDS.includes(kind)) throw followerStoreError('follower_run_identity_invalid');
      if (clientRequestId) {
        const existing = get(this.db, `SELECT * FROM follower_runs WHERE owner_user_id=? AND account_workspace_id=? AND kind=? AND client_request_id=?`, [ownerUserId, workspaceId, kind, clientRequestId]);
        if (existing) return equivalentFollowerRun(existing, { scheduleId, ownerUserId, workspaceId, kind, trigger, clientRequestId, occurrenceKey, window, authorization })
          ? normalizeRun(existing)
          : rejectRunCollision(this, existing, { ownerUserId, workspaceId, kind, clientRequestId, occurrenceKey, window, authorization });
      }
      if (occurrenceKey) {
        const existing = get(this.db, 'SELECT * FROM follower_runs WHERE occurrence_key=?', [occurrenceKey]);
        if (existing) return equivalentFollowerRun(existing, { scheduleId, ownerUserId, workspaceId, kind, trigger, clientRequestId, occurrenceKey, window, authorization })
          ? normalizeRun(existing)
          : rejectRunCollision(this, existing, { ownerUserId, workspaceId, kind, clientRequestId, occurrenceKey, window, authorization });
      }
      const now = nowIso();
      const runId = id || newId('follower_run');
      run(this.db, `INSERT INTO follower_runs(
        id,schedule_id,owner_user_id,account_workspace_id,kind,trigger,client_request_id,occurrence_key,
        window_start,window_end,timezone,authorization_epoch,grant_snapshot_json,source_inventory_json,coverage_json,
        follower_asset_version,base_skill_version,cluster_skill_version,personal_overlay_version,effective_skill_hash,
        preference_memory_version,preference_memory_hash,report_contract_version,privacy_validator_version,
        status,attempt,lease_owner,lease_expires_at,lease_generation,error_code,error_text,report_id,origin_device_id,
        started_at,completed_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'[]','[]',?,?,?,?,?,?,?,?,?,'queued',0,'','',0,'','','',?,'','',?,?)`, [
        runId, scheduleId, ownerUserId, workspaceId, kind, trigger, clientRequestId, occurrenceKey,
        String(window.startAt || ''), String(window.endAt || ''), String(window.timezone || ''),
        Number(authorization.authorizationEpoch || 1), JSON.stringify(authorization),
        versions.followerAssetVersion || 'follower_agent_v1', versions.baseSkillVersion || 'follower_skill_v1',
        versions.clusterSkillVersion || '', versions.personalOverlayVersion || '', versions.effectiveSkillHash || '',
        versions.preferenceMemoryVersion || '', versions.preferenceMemoryHash || '', versions.reportContractVersion || 'follower_report_v2',
        versions.privacyValidatorVersion || 'follower_privacy_v1', originDeviceId, now, now,
      ]);
      return this.getFollowerRun(runId);
    },

    getFollowerRun(id = '') {
      return normalizeRun(get(this.db, 'SELECT * FROM follower_runs WHERE id=?', [id]));
    },

    listFollowerRuns({ ownerUserId = '', workspaceId = '', statuses = [], limit = 100 } = {}) {
      const where = ['owner_user_id=?'];
      const params = [ownerUserId];
      if (workspaceId) { where.push('account_workspace_id=?'); params.push(workspaceId); }
      const valid = (Array.isArray(statuses) ? statuses : []).filter((item) => FOLLOWER_RUN_STATUSES.includes(item));
      if (valid.length) { where.push(`status IN (${valid.map(() => '?').join(',')})`); params.push(...valid); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM follower_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, params).map(normalizeRun);
    },

    updateFollowerRun(id = '', patch = {}) {
      const current = this.getFollowerRun(id);
      if (!current) return null;
      const fields = ['updated_at=?'];
      const params = [nowIso()];
      const mappings = {
        status: 'status', sourceInventory: 'source_inventory_json', coverage: 'coverage_json',
        errorCode: 'error_code', errorText: 'error_text', reportId: 'report_id', startedAt: 'started_at', completedAt: 'completed_at',
        attempt: 'attempt', leaseOwner: 'lease_owner', leaseExpiresAt: 'lease_expires_at', leaseGeneration: 'lease_generation',
      };
      for (const [key, column] of Object.entries(mappings)) {
        if (!(key in patch)) continue;
        const value = ['sourceInventory', 'coverage'].includes(key) ? JSON.stringify(patch[key] ?? []) : patch[key];
        fields.push(`${column}=?`); params.push(value ?? '');
      }
      params.push(id);
      run(this.db, `UPDATE follower_runs SET ${fields.join(',')} WHERE id=?`, params);
      return this.getFollowerRun(id);
    },

    commitFollowerReport({ runId = '', reportId = '', report = {}, renderedBody = '', syncBody = '', sources = [], privacy = {} } = {}) {
      const followerRun = this.getFollowerRun(runId);
      if (!followerRun) throw followerStoreError('follower_run_missing');
      const id = reportId || `follower_report_${runId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const existing = get(this.db, 'SELECT * FROM follower_reports WHERE run_id=?', [runId]);
      if (existing) {
        const expectedHash = existingFollowerReportCommitHash(this.db, existing);
        const observedHash = requestedFollowerReportCommitHash({ id, runId, report, renderedBody, syncBody, sources, privacy });
        if (existing.id !== id || expectedHash !== observedHash) {
          this.recordFollowerQuarantine({ ownerUserId: followerRun.ownerUserId, workspaceId: followerRun.workspaceId,
            entityKind: 'report', identityKey: runId, reasonCode: 'follower_report_identity_collision', expectedHash, observedHash,
            metadata: { existingReportId: existing.id, requestedReportId: id } });
          throw followerStoreError('follower_report_identity_collision');
        }
        return normalizeReport(existing, this);
      }
      const current = this.followerAccessSnapshot({ ownerUserId: followerRun.ownerUserId, workspaceId: followerRun.workspaceId });
      if (current.authorizationEpoch !== followerRun.authorizationEpoch) throw followerStoreError('follower_authorization_changed');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const now = nowIso();
        run(this.db, `INSERT INTO follower_reports(
          id,run_id,owner_user_id,account_workspace_id,kind,window_start,window_end,timezone,report_json,rendered_body,sync_body,
          privacy_state,privacy_validator_version,validated_content_hash,redaction_count,validation_errors_json,
          read_at,deleted_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING`, [
          id, runId, followerRun.ownerUserId, followerRun.workspaceId, followerRun.kind,
          followerRun.window.startAt, followerRun.window.endAt, followerRun.window.timezone,
          JSON.stringify(report), String(renderedBody || ''), String(syncBody || ''), privacy.state || 'passed',
          privacy.validatorVersion || 'follower_privacy_v1', privacy.validatedHash || '', Number(privacy.redactionCount || 0),
          JSON.stringify(privacy.errors || []), '', '', now, now,
        ]);
        for (const source of normalizedReportSources(sources)) {
          run(this.db, `INSERT INTO follower_report_sources(
            report_id,ref_id,source_kind,source_id,source_version,content_hash,occurred_at,observed_at,local_reference_json,availability_state
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`, [
            id, source.refId, source.sourceKind || '', source.sourceId || '', source.sourceVersion || '', source.contentHash || '',
            source.occurredAt || '', source.observedAt || now, JSON.stringify(source.localReference || {}), source.availabilityState || 'available',
          ]);
        }
        run(this.db, `UPDATE follower_runs SET status='completed',report_id=?,completed_at=?,updated_at=? WHERE id=?`, [id, now, now, runId]);
        run(this.db, `INSERT INTO work_notification_intents(
          id,owner_user_id,account_workspace_id,category,correlation_id,episode_revision,target_type,target_id,title_key,body_key,status,attempt_count,lease_owner,lease_expires_at,shown_at,suppressed_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,1,'follower_report',?,'follower.notification.reportReady.title','follower.notification.reportReady.body','pending',0,'','','','',?,?)
        ON CONFLICT(owner_user_id,category,correlation_id,episode_revision) DO NOTHING`, [
          newId('notification_intent'), followerRun.ownerUserId, followerRun.workspaceId, 'follower_report_ready', runId, id, now, now,
        ]);
        if (current.reportSyncEnabled && current.grants.sync_sanitized_reports && privacy.state === 'passed' && privacy.validatedHash) {
          this.enqueueFollowerReportSync({ reportId: id, operation: 'upsert', validatedHash: privacy.validatedHash });
        }
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.getFollowerReport(id);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    getFollowerReport(id = '') {
      return normalizeReport(get(this.db, 'SELECT * FROM follower_reports WHERE id=? AND deleted_at=\'\'', [id]), this);
    },

    listFollowerReports({ ownerUserId = '', workspaceId = '', kind = '', unreadOnly = false, limit = 100, before = '' } = {}) {
      const where = ["owner_user_id=?", "deleted_at=''"];
      const params = [ownerUserId];
      if (workspaceId) { where.push('account_workspace_id=?'); params.push(workspaceId); }
      if (FOLLOWER_REPORT_KINDS.includes(kind)) { where.push('kind=?'); params.push(kind); }
      if (unreadOnly) where.push("read_at=''");
      if (before) { where.push('created_at<?'); params.push(before); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM follower_reports WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, params)
        .map((row) => normalizeReport(row));
    },

    markFollowerReportRead({ id = '', ownerUserId = '', workspaceId = '' } = {}) {
      const now = nowIso();
      run(this.db, `UPDATE follower_reports SET read_at=CASE WHEN read_at='' THEN ? ELSE read_at END,updated_at=?
        WHERE id=? AND owner_user_id=? AND account_workspace_id=? AND deleted_at=''`, [now, now, id, ownerUserId, workspaceId]);
      return this.getFollowerReport(id);
    },

    deleteFollowerReport({ id = '', ownerUserId = '', workspaceId = '' } = {}) {
      const report = get(this.db, `SELECT * FROM follower_reports WHERE id=? AND owner_user_id=? AND account_workspace_id=? AND deleted_at=''`, [id, ownerUserId, workspaceId]);
      const now = nowIso();
      run(this.db, `UPDATE follower_reports SET deleted_at=?,updated_at=? WHERE id=? AND owner_user_id=? AND account_workspace_id=? AND deleted_at=''`, [now, now, id, ownerUserId, workspaceId]);
      const access = this.followerAccessSnapshot({ ownerUserId, workspaceId });
      if (report && access.reportSyncEnabled && report.validated_content_hash) {
        this.enqueueFollowerReportSync({ reportId: id, operation: 'delete', validatedHash: report.validated_content_hash });
      }
      return { ok: true, id };
    },

    ensureFollowerFollowupThread({ ownerUserId = '', workspaceId = '', reportId = '', authorizationEpoch = 0 } = {}) {
      const report = this.getFollowerReport(reportId);
      if (!report || report.ownerUserId !== ownerUserId || report.workspaceId !== workspaceId) throw followerStoreError('follower_report_missing');
      const id = `follower_followup_${crypto.createHash('sha256').update(`${ownerUserId}:${workspaceId}:${reportId}`).digest('hex').slice(0, 32)}`;
      const now = nowIso();
      run(this.db, `INSERT INTO follower_followup_threads(id,owner_user_id,account_workspace_id,report_id,authorization_epoch,deleted_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'',?,?) ON CONFLICT(id) DO UPDATE SET authorization_epoch=excluded.authorization_epoch,deleted_at='',updated_at=excluded.updated_at`, [
        id, ownerUserId, workspaceId, reportId, Number(authorizationEpoch || 1), now, now,
      ]);
      return normalizeFollowupThread(get(this.db, 'SELECT * FROM follower_followup_threads WHERE id=?', [id]), this);
    },

    getFollowerFollowupThread({ id = '', reportId = '', ownerUserId = '', workspaceId = '' } = {}) {
      const row = id ? get(this.db, 'SELECT * FROM follower_followup_threads WHERE id=? AND deleted_at=\'\'', [id])
        : get(this.db, 'SELECT * FROM follower_followup_threads WHERE report_id=? AND owner_user_id=? AND account_workspace_id=? AND deleted_at=\'\' ORDER BY created_at LIMIT 1', [reportId, ownerUserId, workspaceId]);
      return normalizeFollowupThread(row, this);
    },

    addFollowerFollowupMessage({ threadId = '', role = '', content = '', sourceRefs = [] } = {}) {
      if (!['user', 'assistant'].includes(role) || !String(content || '').trim()) throw followerStoreError('follower_followup_message_invalid');
      const id = newId('follower_followup_message');
      run(this.db, `INSERT INTO follower_followup_messages(id,thread_id,role,content,source_refs_json,created_at) VALUES(?,?,?,?,?,?)`, [
        id, threadId, role, String(content).slice(0, 12_000), JSON.stringify(sourceRefs || []), nowIso(),
      ]);
      return normalizeFollowupMessage(get(this.db, 'SELECT * FROM follower_followup_messages WHERE id=?', [id]));
    },

    upsertFollowerFollowupMessage({ id = '', threadId = '', role = '', content = '', createdAt = '' } = {}) {
      if (!id || !threadId || !['user', 'assistant'].includes(role) || !String(content || '').trim()) throw followerStoreError('follower_followup_message_invalid');
      run(this.db, `INSERT INTO follower_followup_messages(id,thread_id,role,content,source_refs_json,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`, [id, threadId, role, String(content).slice(0, 12_000), '[]', createdAt || nowIso()]);
      return normalizeFollowupMessage(get(this.db, 'SELECT * FROM follower_followup_messages WHERE id=?', [id]));
    },

    deleteFollowerFollowupThread({ id = '', ownerUserId = '', workspaceId = '' } = {}) {
      run(this.db, `UPDATE follower_followup_threads SET deleted_at=?,updated_at=? WHERE id=? AND owner_user_id=? AND account_workspace_id=?`, [nowIso(), nowIso(), id, ownerUserId, workspaceId]);
      return { ok: true, id };
    },
  });
}

function normalizeWorkspaceState(row) {
  if (!row) return null;
  return {
    ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id,
    authorizationEpoch: Number(row.authorization_epoch || 1), disclosureConfirmed: Boolean(row.disclosure_confirmed),
    disclosureVersion: row.disclosure_version || '', providerSnapshot: safeJsonParse(row.provider_snapshot_json, {}),
    preferences: normalizeFollowerPreferences(safeJsonParse(row.preferences_json, {})),
    preferenceRevision: Number(row.preference_revision || 1), preferenceHash: row.preference_hash || '',
    reportSyncEnabled: Boolean(row.report_sync_enabled), evolutionEnabled: Boolean(row.evolution_enabled), updatedAt: row.updated_at,
  };
}

function normalizeRun(row) {
  if (!row) return null;
  return {
    id: row.id, scheduleId: row.schedule_id || '', ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id,
    kind: row.kind, trigger: row.trigger, clientRequestId: row.client_request_id || '', occurrenceKey: row.occurrence_key || '',
    window: { startAt: row.window_start, endAt: row.window_end, timezone: row.timezone },
    authorizationEpoch: Number(row.authorization_epoch || 1), authorization: safeJsonParse(row.grant_snapshot_json, {}),
    sourceInventory: safeJsonParse(row.source_inventory_json, []), coverage: safeJsonParse(row.coverage_json, []),
    versions: { followerAssetVersion: row.follower_asset_version, baseSkillVersion: row.base_skill_version,
      clusterSkillVersion: row.cluster_skill_version, personalOverlayVersion: row.personal_overlay_version,
      effectiveSkillHash: row.effective_skill_hash, preferenceMemoryVersion: row.preference_memory_version,
      preferenceMemoryHash: row.preference_memory_hash, reportContractVersion: row.report_contract_version,
      privacyValidatorVersion: row.privacy_validator_version },
    status: row.status, attempt: Number(row.attempt || 0), errorCode: row.error_code || '', errorText: row.error_text || '',
    reportId: row.report_id || '', originDeviceId: row.origin_device_id || '', startedAt: row.started_at || '', completedAt: row.completed_at || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function normalizeSchedule(row) {
  if (!row) return null;
  return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, kind: row.kind,
    enabled: Boolean(row.enabled), timezone: row.timezone, frequency: row.frequency, daysOfWeek: safeJsonParse(row.days_json, []),
    localTime: row.local_time, missedRunPolicy: row.missed_run_policy, revision: Number(row.revision || 1),
    nextOccurrenceAt: row.next_occurrence_at || '', lastRunAt: row.last_run_at || '', lastSuccessWindowEnd: row.last_success_window_end || '',
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function normalizeNotificationIntent(row) {
  if (!row) return null;
  return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, category: row.category,
    correlationId: row.correlation_id, episodeRevision: Number(row.episode_revision || 1), targetType: row.target_type,
    targetId: row.target_id, titleKey: row.title_key, bodyKey: row.body_key, status: row.status,
    attemptCount: Number(row.attempt_count || 0), createdAt: row.created_at, updatedAt: row.updated_at };
}

function normalizeFollowupThread(row, store = null) {
  if (!row) return null;
  const messages = store ? all(store.db, 'SELECT * FROM follower_followup_messages WHERE thread_id=? ORDER BY created_at,id', [row.id]).map(normalizeFollowupMessage) : [];
  return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, reportId: row.report_id,
    authorizationEpoch: Number(row.authorization_epoch || 1), deletedAt: row.deleted_at || '', createdAt: row.created_at, updatedAt: row.updated_at, messages };
}

function normalizeFollowupMessage(row) {
  if (!row) return null;
  return { id: row.id, threadId: row.thread_id, role: row.role, content: row.content, sourceRefs: safeJsonParse(row.source_refs_json, []), createdAt: row.created_at };
}

function normalizeReport(row, store = null) {
  if (!row) return null;
  const sources = store ? all(store.db, 'SELECT * FROM follower_report_sources WHERE report_id=? ORDER BY occurred_at,source_kind,source_id', [row.id]) : [];
  return {
    id: row.id, runId: row.run_id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, kind: row.kind,
    window: { startAt: row.window_start, endAt: row.window_end, timezone: row.timezone },
    report: safeJsonParse(row.report_json, {}), renderedBody: row.rendered_body || '', syncBody: row.sync_body || '', privacyState: row.privacy_state,
    privacyValidatorVersion: row.privacy_validator_version, validatedContentHash: row.validated_content_hash,
    redactionCount: Number(row.redaction_count || 0), validationErrors: safeJsonParse(row.validation_errors_json, []),
    readAt: row.read_at || '', deletedAt: row.deleted_at || '', createdAt: row.created_at, updatedAt: row.updated_at,
    sources: sources.map((source) => ({ reportId: source.report_id, refId: source.ref_id || '', sourceKind: source.source_kind, sourceId: source.source_id,
      sourceVersion: source.source_version, contentHash: source.content_hash, occurredAt: source.occurred_at,
      observedAt: source.observed_at, localReference: safeJsonParse(source.local_reference_json, {}), availabilityState: source.availability_state })),
  };
}

function normalizeEvolutionBinding(row) {
  if (!row) return null;
  return { ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, remoteUserId: row.remote_user_id || '',
    canonicalServiceInstanceId: row.canonical_service_instance_id || '', subjectKind: row.subject_kind, state: row.state,
    stateRevision: Number(row.state_revision || 1), reportSyncEnabled: Boolean(row.report_sync_enabled), evolutionEnabled: Boolean(row.evolution_enabled),
    personalOverlayVersion: row.personal_overlay_version || '', personalOverlayText: row.personal_overlay_text || '',
    personalOverlayHash: row.personal_overlay_hash || '', preferenceMemoryVersion: row.preference_memory_version || '',
    preferenceMemory: safeJsonParse(row.preference_memory_json, {}), preferenceMemoryHash: row.preference_memory_hash || '',
    clusterBundleId: row.cluster_bundle_id || '', clusterSkillVersion: row.cluster_skill_version || '', lastError: row.last_error || '',
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function normalizeSyncOutbox(row) {
  if (!row) return null;
  return { id: row.id, reportId: row.report_id, operation: row.operation, projectionSessionId: row.projection_session_id || '',
    projectionMessageId: row.projection_message_id || '', validatedHash: row.validated_hash, status: row.status,
    attemptCount: Number(row.attempt_count || 0), lastError: row.last_error || '', createdAt: row.created_at, updatedAt: row.updated_at };
}

function normalizeProjection(row) {
  if (!row) return null;
  const projection = safeJsonParse(row.projection_json, {});
  return { id: row.projection_id, projectionId: row.projection_id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id,
    originDeviceId: row.origin_device_id || '', kind: row.report_kind, window: { startAt: row.window_start, endAt: row.window_end, timezone: row.timezone },
    report: { schemaVersion: 'follower_report_projection_v1', kind: row.report_kind, window: projection.window || {}, coverage: projection.coverage || [],
      claims: projection.claims || [], suggestions: projection.suggestions || [], summary: projection.summary || '' },
    syncBody: row.sync_body || '', validatedContentHash: row.validated_hash, privacyValidatorVersion: row.privacy_validator_version || '',
    revision: Number(row.revision || 1), remoteProjection: true, readAt: row.read_at || '', deletedAt: row.deleted_at || '',
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function normalizePreferenceSignal(row) {
  if (!row) return null;
  return { id: row.id, ownerUserId: row.owner_user_id, workspaceId: row.account_workspace_id, sourceKind: row.source_kind,
    sourceId: row.source_id, sourceVersion: row.source_version || '', signalKind: row.signal_kind,
    normalized: safeJsonParse(row.normalized_json, {}), signalHash: row.signal_hash, lineageKey: row.lineage_key,
    explicit: Boolean(row.explicit), confidence: Number(row.confidence || 0), personalEligible: Boolean(row.personal_eligible),
    clusterEligible: Boolean(row.cluster_eligible), validationState: row.validation_state, evolutionOutboxId: row.evolution_outbox_id || '',
    evidenceId: row.evidence_id || '', createdAt: row.created_at, updatedAt: row.updated_at };
}

function followerStoreError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function equivalentFollowerRun(existing, requested) {
  return runIdentityHash({
    scheduleId: existing.schedule_id, ownerUserId: existing.owner_user_id, workspaceId: existing.account_workspace_id,
    kind: existing.kind, trigger: existing.trigger, clientRequestId: existing.client_request_id, occurrenceKey: existing.occurrence_key,
    window: { startAt: existing.window_start, endAt: existing.window_end, timezone: existing.timezone },
    authorizationEpoch: Number(existing.authorization_epoch || 1),
  }) === runIdentityHash({ ...requested, authorizationEpoch: Number(requested.authorization?.authorizationEpoch || 1) });
}

function rejectRunCollision(store, existing, requested) {
  const expectedHash = runIdentityHash({ scheduleId: existing.schedule_id, ownerUserId: existing.owner_user_id,
    workspaceId: existing.account_workspace_id, kind: existing.kind, trigger: existing.trigger,
    clientRequestId: existing.client_request_id, occurrenceKey: existing.occurrence_key,
    window: { startAt: existing.window_start, endAt: existing.window_end, timezone: existing.timezone },
    authorizationEpoch: Number(existing.authorization_epoch || 1) });
  const observedHash = runIdentityHash({ ...requested, authorizationEpoch: Number(requested.authorization?.authorizationEpoch || 1) });
  store.recordFollowerQuarantine({ ownerUserId: requested.ownerUserId, workspaceId: requested.workspaceId, entityKind: 'run',
    identityKey: requested.clientRequestId || requested.occurrenceKey, reasonCode: 'follower_run_identity_collision', expectedHash, observedHash,
    metadata: { existingRunId: existing.id, kind: requested.kind } });
  throw followerStoreError('follower_run_identity_collision');
}

function runIdentityHash(value = {}) {
  return stableHash({ scheduleId: value.scheduleId || '', ownerUserId: value.ownerUserId || '', workspaceId: value.workspaceId || '',
    kind: value.kind || '', trigger: value.trigger || '', clientRequestId: value.clientRequestId || '', occurrenceKey: value.occurrenceKey || '',
    window: { startAt: value.window?.startAt || '', endAt: value.window?.endAt || '', timezone: value.window?.timezone || '' },
    authorizationEpoch: Number(value.authorizationEpoch || 1) });
}

function normalizedReportSources(sources = []) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({ ...source,
    refId: String(source.refId || stableSourceRef(source)).slice(0, 200),
  })).sort((left, right) => left.refId.localeCompare(right.refId));
}

function stableSourceRef(source = {}) {
  return `source_${crypto.createHash('sha256').update(`${source.sourceKind || ''}:${source.sourceId || ''}:${source.sourceVersion || ''}`).digest('hex').slice(0, 32)}`;
}

function requestedFollowerReportCommitHash({ id, runId, report, renderedBody, syncBody, sources, privacy }) {
  return stableHash({ id, runId, report, renderedBody: String(renderedBody || ''), syncBody: String(syncBody || ''),
    privacy: { state: privacy.state || 'passed', validatorVersion: privacy.validatorVersion || 'follower_privacy_v1',
      validatedHash: privacy.validatedHash || '', redactionCount: Number(privacy.redactionCount || 0), errors: privacy.errors || [] },
    sources: normalizedReportSources(sources).map(sourceCommitDescriptor) });
}

function existingFollowerReportCommitHash(db, row) {
  const sources = all(db, 'SELECT * FROM follower_report_sources WHERE report_id=? ORDER BY ref_id,source_kind,source_id', [row.id]);
  return stableHash({ id: row.id, runId: row.run_id, report: safeJsonParse(row.report_json, {}), renderedBody: row.rendered_body || '',
    syncBody: row.sync_body || '', privacy: { state: row.privacy_state, validatorVersion: row.privacy_validator_version,
      validatedHash: row.validated_content_hash, redactionCount: Number(row.redaction_count || 0), errors: safeJsonParse(row.validation_errors_json, []) },
    sources: sources.map((source) => sourceCommitDescriptor({ refId: source.ref_id, sourceKind: source.source_kind,
      sourceId: source.source_id, sourceVersion: source.source_version, contentHash: source.content_hash,
      occurredAt: source.occurred_at, observedAt: source.observed_at, localReference: safeJsonParse(source.local_reference_json, {}),
      availabilityState: source.availability_state })) });
}

function sourceCommitDescriptor(source = {}) {
  return { refId: source.refId || stableSourceRef(source), sourceKind: source.sourceKind || '', sourceId: source.sourceId || '',
    sourceVersion: source.sourceVersion || '', contentHash: source.contentHash || '', occurredAt: source.occurredAt || '',
    observedAt: source.observedAt || '', localReference: source.localReference || {}, availabilityState: source.availabilityState || 'available' };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
