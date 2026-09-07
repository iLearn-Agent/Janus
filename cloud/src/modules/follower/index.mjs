import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FOLLOWER_CLOUD_CAPABILITIES,
  FOLLOWER_CLUSTER_PROFILE,
  assessFollowerCloudCompatibility,
  createFollowerCloudClientContract,
  evaluateFollowerClusterEvidence,
  normalizeFollowerPreferenceSignal,
  stableFollowerServiceInstanceId,
} from '../../../../src/shared/follower/cloudContracts.js';
import { buildFollowerSystemAgentBundle, signFollowerSystemAgentBundle } from '../../../../src/shared/follower/systemAgentBundle.js';
import { routeWithDeviceGrant } from '../sync/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FOLLOWER_ASSET_ROOT = path.resolve(__dirname, '../../../../assets/system_agents/follower_agent');

export function registerFollowerRoutes({ app, pool, auth, route, apiError, env = process.env }) {
  const authority = createFollowerCloudAuthority({ pool, apiError, env });
  app.get('/v1/follower/capabilities', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json(authority.capabilities(parseContract(req.query.contract)));
  }));
  app.post('/v1/follower/reports/batch', routeWithDeviceGrant(pool, apiError, 'sync:write', async (req, res) => {
    res.status(202).json(await authority.pushReports(req.deviceGrant, req.body || {}));
  }));
  app.get('/v1/follower/reports/changes', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json(await authority.reportChanges(req.deviceGrant, { ...req.query, contract: parseContract(req.query.contract) }));
  }));
  app.post('/v1/follower/followups/batch', routeWithDeviceGrant(pool, apiError, 'sync:write', async (req, res) => {
    res.status(202).json(await authority.pushFollowups(req.deviceGrant, req.body || {}));
  }));
  app.get('/v1/follower/followups/messages', routeWithDeviceGrant(pool, apiError, 'sync:read', async (req, res) => {
    res.json(await authority.followupMessages(req.deviceGrant, { ...req.query, contract: parseContract(req.query.contract) }));
  }));
  app.post('/v1/follower/evolution/service-instance', routeWithDeviceGrant(pool, apiError, 'evolution:write', async (req, res) => {
    res.status(201).json(await authority.ensureServiceInstance(req.deviceGrant, req.body || {}));
  }));
  app.patch('/v1/follower/evolution/service-instance', routeWithDeviceGrant(pool, apiError, 'evolution:write', async (req, res) => {
    res.json(await authority.updateServiceInstance(req.deviceGrant, req.body || {}));
  }));
  app.get('/v1/follower/evolution/status', routeWithDeviceGrant(pool, apiError, 'evolution:read', async (req, res) => {
    res.json(await authority.evolutionStatus(req.deviceGrant, { ...(req.query || {}), contract: parseContract(req.query.contract) }));
  }));
  app.post('/v1/follower/evolution/evidence/batch', routeWithDeviceGrant(pool, apiError, 'evolution:write', async (req, res) => {
    res.json(await authority.ingestEvidence(req.deviceGrant, req.body || {}));
  }));
  app.post('/v1/follower/evolution/personal/rollback', routeWithDeviceGrant(pool, apiError, 'evolution:write', async (req, res) => {
    res.json(await authority.rollbackPersonal(req.deviceGrant, req.body || {}));
  }));
  app.post('/v1/follower/evolution/personal/decision', routeWithDeviceGrant(pool, apiError, 'evolution:write', async (req, res) => {
    res.json(await authority.decidePersonal(req.deviceGrant, req.body || {}));
  }));
  app.get('/v1/follower/evolution/system-bundle', routeWithDeviceGrant(pool, apiError, 'evolution:read', async (req, res) => {
    res.json(await authority.systemBundle(req.deviceGrant, { ...(req.query || {}), contract: parseContract(req.query.contract) }));
  }));
  app.post('/api/follower/evolution/cluster/evaluate', auth, route(async (req, res) => {
    requireAdmin(req.auth.user, apiError);
    res.json(await authority.evaluateCluster());
  }));
  app.post('/api/follower/evolution/cluster/:candidateId/canary', auth, route(async (req, res) => {
    requireAdmin(req.auth.user, apiError);
    res.json(await authority.recordCanary({ candidateId: req.params.candidateId, ...(req.body || {}) }));
  }));
  app.post('/api/follower/evolution/cluster/:candidateId/governance', auth, route(async (req, res) => {
    requireAdmin(req.auth.user, apiError);
    res.json(await authority.recordGovernance({ candidateId: req.params.candidateId, reviewerUserId: req.auth.user.id, ...(req.body || {}) }));
  }));
  app.post('/api/follower/evolution/cluster/:candidateId/shadow', auth, route(async (req, res) => {
    requireAdmin(req.auth.user, apiError);
    res.json(await authority.recordShadow({ candidateId: req.params.candidateId, reviewerUserId: req.auth.user.id, ...(req.body || {}) }));
  }));
  app.post('/api/follower/evolution/cluster/:candidateId/publish', auth, route(async (req, res) => {
    requireAdmin(req.auth.user, apiError);
    res.json(await authority.publishCandidate({ candidateId: req.params.candidateId, releaseVersion: req.body?.releaseVersion }));
  }));
  return authority;
}

export function createFollowerCloudAuthority({ pool, apiError = simpleApiError, env = process.env } = {}) {
  return {
    capabilities(contract = {}) {
      const expected = createFollowerCloudClientContract({ appVersion: contract.appVersion || '1.0.0' });
      const compatibility = assessFollowerCloudCompatibility(contract, { requiredCapabilities: ['follower-report-projection-v1', 'follower-raw-report-v1'] });
      return { enabled: true, contractVersion: 1, minimumAppVersion: '1.0.0', capabilities: FOLLOWER_CLOUD_CAPABILITIES,
        reportProjection: { enabled: true, immutableSyncBody: true, sourceIdentifiersAccepted: false },
        rawReport: { enabled: true, evolutionInput: true },
        followups: { enabled: true, encryptedInTransit: true },
        systemService: { enabled: true, personalWorkspaceOnly: true, subjectKind: 'system_service' },
        cluster: { enabled: true, profile: FOLLOWER_CLUSTER_PROFILE, publishingRequiresCanary: true },
        expectedClientContract: expected, clientCompatibility: { ...compatibility, contract } };
    },

    async pushReports(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-report-projection-v1', 'follower-raw-report-v1'], apiError);
      const workspaceId = await requireWorkspace(pool, grant.userId, payload.workspaceId, apiError);
      const results = [];
      for (const item of (Array.isArray(payload.items) ? payload.items : []).slice(0, 100)) {
        const clientRecordId = clean(item.clientRecordId, 240);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (item.operation === 'delete') {
            const projectionId = clean(item.projectionId, 240);
            if (!projectionId || !clean(item.validatedHash, 128)) throw apiError('follower_projection_delete_invalid', 'Follower projection delete is invalid.', 400);
            const current = (await client.query(`SELECT * FROM cloud_follower_report_projections WHERE owner_user_id=$1
              AND account_workspace_id=$2 AND projection_id=$3`, [grant.userId, workspaceId, projectionId])).rows[0];
            if (!current || current.deleted_at) { results.push({ clientRecordId, status: 'deleted', projectionId }); await client.query('COMMIT'); continue; }
            if (current.validated_hash !== clean(item.validatedHash, 128)) throw apiError('follower_projection_delete_hash_mismatch', 'Follower projection delete identity does not match.', 409);
            const deleted = (await client.query(`UPDATE cloud_follower_report_projections SET deleted_at=now(),updated_at=now(),revision=revision+1
              WHERE owner_user_id=$1 AND account_workspace_id=$2 AND projection_id=$3 RETURNING *`, [grant.userId, workspaceId, projectionId])).rows[0];
            if (deleted) await client.query(`INSERT INTO cloud_follower_report_changes(owner_user_id,account_workspace_id,projection_id,operation,projection_json)
              VALUES($1,$2,$3,'delete',$4::jsonb)`, [grant.userId, workspaceId, projectionId, JSON.stringify(projectionPayload(deleted))]);
            if (item.reportId) await client.query(`UPDATE cloud_follower_raw_reports SET deleted_at=now(),updated_at=now()
              WHERE owner_user_id=$1 AND account_workspace_id=$2 AND report_id=$3 AND validated_hash=$4`, [
              grant.userId, workspaceId, clean(item.reportId, 240), clean(item.validatedHash, 128),
            ]);
            results.push({ clientRecordId, status: 'deleted', projectionId });
            await client.query('COMMIT');
            continue;
          }
          const projection = validateProjection(item.projection, apiError);
          const rawReport = validateRawReport(item.rawReport, projection, apiError);
          const existingRaw = (await client.query(`SELECT validated_hash FROM cloud_follower_raw_reports
            WHERE owner_user_id=$1 AND account_workspace_id=$2 AND report_id=$3`, [
            grant.userId, workspaceId, rawReport.reportId,
          ])).rows[0];
          if (existingRaw && existingRaw.validated_hash !== rawReport.validatedHash) {
            throw apiError('follower_raw_report_identity_collision', 'Follower raw report identity collision.', 409);
          }
          const existing = (await client.query(`SELECT * FROM cloud_follower_report_projections
            WHERE owner_user_id=$1 AND account_workspace_id=$2 AND projection_id=$3`, [grant.userId, workspaceId, projection.projectionId])).rows[0];
          if (existing && existing.validated_hash !== projection.validatedHash) throw apiError('follower_projection_identity_collision', 'Follower projection identity collision.', 409);
          if (existing && Number(existing.revision || 0) >= Number(projection.revision || 1) && !existing.deleted_at) {
            await upsertRawReport(client, grant, workspaceId, rawReport, apiError);
            results.push({ clientRecordId, status: 'duplicate', projectionId: existing.projection_id,
              projectionSessionId: `follower_reports_${workspaceId}`, projectionMessageId: existing.projection_id });
            await client.query('COMMIT');
            continue;
          }
          const row = (await client.query(`INSERT INTO cloud_follower_report_projections(
            owner_user_id,account_workspace_id,projection_id,origin_device_id,report_kind,window_start,window_end,timezone,
            projection_json,sync_body,validated_hash,privacy_validator_version,revision,deleted_at,created_at,updated_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,NULL,$14,$15)
          ON CONFLICT(owner_user_id,account_workspace_id,projection_id) DO UPDATE SET
            projection_json=excluded.projection_json,sync_body=excluded.sync_body,revision=GREATEST(cloud_follower_report_projections.revision,excluded.revision),
            deleted_at=NULL,updated_at=excluded.updated_at RETURNING *`, [grant.userId, workspaceId, projection.projectionId,
            projection.originDeviceId || grant.deviceId, projection.reportKind, nullableDate(projection.window?.startAt), nullableDate(projection.window?.endAt),
            projection.window?.timezone || '', JSON.stringify(projection), projection.syncBody, projection.validatedHash,
            projection.privacyValidatorVersion, projection.revision, projection.createdAt, projection.updatedAt])).rows[0];
          await client.query(`INSERT INTO cloud_follower_report_changes(owner_user_id,account_workspace_id,projection_id,operation,projection_json)
            VALUES($1,$2,$3,'upsert',$4::jsonb)`, [grant.userId, workspaceId, row.projection_id, JSON.stringify(projectionPayload(row))]);
          await upsertRawReport(client, grant, workspaceId, rawReport, apiError);
          results.push({ clientRecordId, status: existing ? 'duplicate' : 'accepted', projectionId: row.projection_id,
            projectionSessionId: `follower_reports_${workspaceId}`, projectionMessageId: row.projection_id });
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          results.push({ clientRecordId, status: 'rejected', code: error.code || 'follower_projection_rejected', message: error.message });
        } finally { client.release(); }
      }
      return { status: results.some((item) => item.status === 'rejected') ? 'partial' : 'accepted', results };
    },

    async reportChanges(grant, options = {}) {
      requireCompatible(options.contract, ['follower-report-projection-v1'], apiError);
      const workspaceId = await requireWorkspace(pool, grant.userId, options.workspaceId, apiError);
      const cursor = Math.max(0, Number(options.cursor || 0));
      const limit = Math.max(1, Math.min(500, Number(options.limit || 200)));
      const rows = (await pool.query(`SELECT * FROM cloud_follower_report_changes WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND change_seq>$3 ORDER BY change_seq LIMIT $4`, [grant.userId, workspaceId, cursor, limit + 1])).rows;
      const page = rows.slice(0, limit);
      return { items: page.map((row) => ({ ...(row.projection_json || {}), deletedAt: row.operation === 'delete'
        ? (row.projection_json?.deletedAt || new Date(row.created_at).toISOString()) : '' })),
        cursor: String(page.at(-1)?.change_seq || cursor), hasMore: rows.length > limit };
    },

    async pushFollowups(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-followup-sync-v1'], apiError);
      const workspaceId = await requireWorkspace(pool, grant.userId, payload.workspaceId, apiError);
      const results = [];
      for (const item of (Array.isArray(payload.messages) ? payload.messages : []).slice(0, 200)) {
        const id = clean(item.id, 240); const threadId = clean(item.threadId, 240); const reportId = clean(item.reportId, 240);
        const role = ['user', 'assistant'].includes(item.role) ? item.role : '';
        const content = cleanMultiline(item.content, 12_000);
        if (!id || !threadId || !reportId || !role || !content) { results.push({ id, status: 'rejected', code: 'follower_followup_invalid' }); continue; }
        const existing = (await pool.query(`SELECT role,content,created_at FROM cloud_follower_followup_messages
          WHERE owner_user_id=$1 AND account_workspace_id=$2 AND message_id=$3`, [grant.userId, workspaceId, id])).rows[0];
        if (existing && (existing.role !== role || existing.content !== content)) { results.push({ id, status: 'rejected', code: 'follower_followup_identity_collision' }); continue; }
        await pool.query(`INSERT INTO cloud_follower_followup_messages(
          owner_user_id,account_workspace_id,message_id,thread_id,report_id,origin_device_id,role,content,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT(owner_user_id,account_workspace_id,message_id) DO NOTHING`, [
          grant.userId, workspaceId, id, threadId, reportId, grant.deviceId || '', role, content, nullableDate(item.createdAt) || new Date(),
        ]);
        results.push({ id, status: existing ? 'duplicate' : 'accepted' });
      }
      return { status: results.some((item) => item.status === 'rejected') ? 'partial' : 'accepted', results };
    },

    async followupMessages(grant, options = {}) {
      requireCompatible(options.contract, ['follower-followup-sync-v1'], apiError);
      const workspaceId = await requireWorkspace(pool, grant.userId, options.workspaceId, apiError);
      const reportId = clean(options.reportId, 240);
      const rows = (await pool.query(`SELECT * FROM cloud_follower_followup_messages WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND report_id=$3 ORDER BY created_at,message_id LIMIT 1000`, [grant.userId, workspaceId, reportId])).rows;
      return { messages: rows.map((row) => ({ id: row.message_id, threadId: row.thread_id, reportId: row.report_id,
        role: row.role, content: row.content, createdAt: new Date(row.created_at).toISOString() })) };
    },

    async ensureServiceInstance(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-system-service-v1', 'follower-evidence-v1'], apiError);
      const workspaceId = clean(payload.workspaceId || 'workspace_personal', 200);
      if (workspaceId !== 'workspace_personal') throw apiError('follower_evolution_personal_workspace_only', 'Follower evolution is currently limited to the personal Workspace.', 409);
      const id = stableFollowerServiceInstanceId({ remoteUserId: grant.userId, workspaceId });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const existing = (await client.query(`SELECT * FROM cloud_follower_service_bindings
          WHERE owner_user_id=$1 AND account_workspace_id=$2 FOR UPDATE`, [grant.userId, workspaceId])).rows[0];
        if (existing && existing.service_instance_id !== id) throw apiError('follower_service_identity_collision', 'Canonical Follower service identity collision.', 409);
        const existingInstance = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2 FOR UPDATE`, [grant.userId, id])).rows[0];
        if (existingInstance && (existingInstance.agent_family_id !== 'follower_agent' || existingInstance.instance_kind !== 'system_service')) {
          throw apiError('follower_service_identity_collision', 'Canonical Follower service identity is occupied by another Agent identity.', 409);
        }
        await client.query(`INSERT INTO cloud_user_agent_instances_v3(
          user_id,id,agent_family_id,status,sync_enabled,personal_evolution_consent,cluster_contribution_consent,
          personal_skill_auto_activate,source_device_id,payload_json,instance_kind,employment_state,quota_exempt,recruitment_source,policy_version
        ) VALUES($1,$2,'follower_agent','active',true,true,true,false,$3,$4::jsonb,'system_service','active',true,'follower_canonical_service','follower_system_service_v1')
        ON CONFLICT(user_id,id) DO UPDATE SET status='active',sync_enabled=true,personal_evolution_consent=true,
          cluster_contribution_consent=true,instance_kind='system_service',employment_state='active',quota_exempt=true,updated_at=now()`, [
          grant.userId, id, grant.deviceId, JSON.stringify({ hidden: true, runtimeSurface: 'follower_service', accountWorkspaceId: workspaceId }),
        ]);
        await client.query(`INSERT INTO cloud_follower_service_bindings(owner_user_id,account_workspace_id,service_instance_id,status,command_id)
          VALUES($1,$2,$3,'active',$4) ON CONFLICT(owner_user_id,account_workspace_id) DO UPDATE SET
          status='active',state_revision=cloud_follower_service_bindings.state_revision+1,command_id=excluded.command_id,updated_at=now()`, [
          grant.userId, workspaceId, id, clean(payload.commandId || '', 240),
        ]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return this.evolutionStatus(grant, { workspaceId, contract: payload.contract });
    },

    async updateServiceInstance(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-system-service-v1'], apiError);
      const workspaceId = clean(payload.workspaceId || 'workspace_personal', 200);
      const enabled = payload.enabled !== false;
      const binding = (await pool.query(`UPDATE cloud_follower_service_bindings SET status=$3,state_revision=state_revision+1,
        command_id=$4,updated_at=now() WHERE owner_user_id=$1 AND account_workspace_id=$2 RETURNING *`, [
        grant.userId, workspaceId, enabled ? 'active' : 'inactive', clean(payload.commandId || '', 240),
      ])).rows[0];
      if (!binding) throw apiError('follower_service_instance_missing', 'Follower service instance was not found.', 404);
      await pool.query(`UPDATE cloud_user_agent_instances_v3 SET status=$3,employment_state=$3,sync_enabled=$4,
        deactivated_at=CASE WHEN $4 THEN NULL ELSE now() END,state_revision=state_revision+1,updated_at=now()
        WHERE user_id=$1 AND id=$2`, [grant.userId, binding.service_instance_id, enabled ? 'active' : 'inactive', enabled]);
      return this.evolutionStatus(grant, { workspaceId, contract: payload.contract });
    },

    async evolutionStatus(grant, options = {}) {
      requireCompatible(typeof options.contract === 'string' ? parseContract(options.contract) : options.contract,
        ['follower-system-service-v1', 'follower-personal-overlay-v1'], apiError);
      const workspaceId = clean(options.workspaceId || 'workspace_personal', 200);
      const binding = (await pool.query(`SELECT * FROM cloud_follower_service_bindings
        WHERE owner_user_id=$1 AND account_workspace_id=$2`, [grant.userId, workspaceId])).rows[0];
      if (!binding) return { enabled: false, serviceInstance: null, personalOverlay: null, preferenceMemory: null, bundle: null };
      const versions = (await pool.query(`SELECT * FROM cloud_follower_personal_versions WHERE owner_user_id=$1
        AND account_workspace_id=$2 ORDER BY version_kind,version_no DESC`, [grant.userId, workspaceId])).rows;
      const overlay = versions.find((item) => item.version_kind === 'personal_overlay' && item.status === 'active');
      const memory = versions.find((item) => item.version_kind === 'preference_memory' && item.status === 'active');
      const bundle = binding.cluster_bundle_id ? (await pool.query('SELECT * FROM cloud_follower_system_bundles WHERE id=$1', [binding.cluster_bundle_id])).rows[0] : null;
      return { enabled: binding.status === 'active', serviceInstance: { id: binding.service_instance_id, remoteUserId: binding.owner_user_id,
        workspaceId: binding.account_workspace_id, subjectKind: binding.subject_kind, status: binding.status, stateRevision: Number(binding.state_revision) },
        personalOverlay: overlay ? { version: overlay.id, text: overlay.payload_json?.text || '', hash: overlay.content_hash } : null,
        preferenceMemory: memory ? { version: memory.id, value: memory.payload_json || {}, hash: memory.content_hash } : null,
        bundle: bundle ? { id: bundle.id, releaseVersion: bundle.release_version, status: bundle.status } : null,
        versions: versions.map(personalVersionPayload),
        candidates: versions.filter((item) => item.status === 'candidate').map(personalVersionPayload) };
    },

    async ingestEvidence(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-system-service-v1', 'follower-evidence-v1', 'follower-personal-overlay-v1'], apiError);
      const workspaceId = clean(payload.workspaceId || 'workspace_personal', 200);
      const binding = (await pool.query(`SELECT * FROM cloud_follower_service_bindings WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND status='active'`, [grant.userId, workspaceId])).rows[0];
      if (!binding || binding.service_instance_id !== clean(payload.serviceInstanceId, 240)) throw apiError('follower_service_instance_invalid', 'Follower service instance is not active.', 409);
      const results = [];
      for (const input of (Array.isArray(payload.items) ? payload.items : []).slice(0, 100)) {
        const clientRecordId = clean(input.clientRecordId, 240);
        try {
          const signal = normalizeFollowerPreferenceSignal(input);
          const evidenceId = `follower_evidence_${sha256([grant.userId, binding.service_instance_id, signal.sourceKind,
            signal.sourceId, signal.sourceVersion, signal.signalHash].join('\n'))}`;
          const inserted = await pool.query(`INSERT INTO cloud_follower_preference_signals(
            evidence_id,owner_user_id,account_workspace_id,service_instance_id,source_kind,source_id,source_version,
            signal_kind,normalized_json,signal_hash,lineage_key,confidence,personal_eligible,cluster_eligible,occurred_at
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)
          ON CONFLICT(evidence_id) DO NOTHING RETURNING evidence_id`, [evidenceId, grant.userId, workspaceId, binding.service_instance_id,
            signal.sourceKind, signal.sourceId, signal.sourceVersion, signal.signalKind, JSON.stringify(signal.normalized), signal.signalHash,
            signal.lineageKey, signal.confidence, signal.personalEligible, signal.clusterEligible, signal.occurredAt]);
          if (!inserted.rows.length) {
            const existing = (await pool.query('SELECT * FROM cloud_follower_preference_signals WHERE evidence_id=$1', [evidenceId])).rows[0];
            if (!existing || existing.owner_user_id !== grant.userId || existing.service_instance_id !== binding.service_instance_id
              || existing.signal_hash !== signal.signalHash || existing.lineage_key !== signal.lineageKey
              || existing.source_kind !== signal.sourceKind || existing.source_id !== signal.sourceId) {
              throw apiError('follower_evidence_identity_collision', 'Follower evidence identity collision.', 409);
            }
          }
          results.push({ clientRecordId, evidenceId, status: inserted.rows.length ? 'accepted' : 'duplicate' });
        } catch (error) { results.push({ clientRecordId, status: 'rejected', code: error.code || 'follower_evidence_rejected', message: error.message }); }
      }
      await materializePersonalCandidates(pool, grant.userId, workspaceId, binding.service_instance_id);
      return { status: results.some((item) => item.status === 'rejected') ? 'partial' : 'accepted', results };
    },

    async decidePersonal(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-system-service-v1', 'follower-personal-overlay-v1'], apiError);
      const workspaceId = clean(payload.workspaceId || 'workspace_personal', 200);
      const decision = ['accept', 'reject'].includes(payload.decision) ? payload.decision : '';
      const versionId = clean(payload.versionId, 240);
      const commandId = clean(payload.commandId, 240);
      const expectedRevision = Number(payload.expectedStateRevision || 0);
      if (!decision || !versionId || !commandId || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
        throw apiError('follower_personal_decision_invalid', 'Follower personal decision is invalid.', 400);
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const previous = (await client.query(`SELECT * FROM cloud_follower_personal_decisions WHERE owner_user_id=$1
          AND account_workspace_id=$2 AND command_id=$3`, [grant.userId, workspaceId, commandId])).rows[0];
        if (previous) { await client.query('COMMIT'); return this.evolutionStatus(grant, { workspaceId, contract: payload.contract }); }
        const binding = (await client.query(`SELECT * FROM cloud_follower_service_bindings WHERE owner_user_id=$1
          AND account_workspace_id=$2 AND status='active' FOR UPDATE`, [grant.userId, workspaceId])).rows[0];
        if (!binding) throw apiError('follower_service_instance_invalid', 'Follower service instance is not active.', 409);
        if (Number(binding.state_revision) !== expectedRevision) throw apiError('follower_personal_revision_conflict', 'Follower personal state changed on another device.', 409);
        const target = (await client.query(`SELECT * FROM cloud_follower_personal_versions WHERE owner_user_id=$1
          AND account_workspace_id=$2 AND service_instance_id=$3 AND id=$4 FOR UPDATE`, [grant.userId, workspaceId, binding.service_instance_id, versionId])).rows[0];
        if (!target || target.status !== 'candidate') throw apiError('follower_personal_candidate_invalid', 'Follower personal candidate is not available.', 409);
        if (decision === 'accept' && (target.review_status !== 'passed' || target.replay_status !== 'passed')) {
          throw apiError('follower_personal_candidate_not_gated', 'Follower personal candidate has not passed review and replay.', 409);
        }
        const nextRevision = Number(binding.state_revision) + 1;
        if (decision === 'accept') {
          await client.query(`UPDATE cloud_follower_personal_versions SET status='archived',updated_at=now()
            WHERE owner_user_id=$1 AND account_workspace_id=$2 AND version_kind=$3 AND status='active'`, [grant.userId, workspaceId, target.version_kind]);
          await client.query(`UPDATE cloud_follower_personal_versions SET status='active',decision_status='accepted',updated_at=now()
            WHERE owner_user_id=$1 AND id=$2`, [grant.userId, target.id]);
          const column = target.version_kind === 'personal_overlay' ? 'personal_overlay_version_id' : 'preference_memory_version_id';
          await client.query(`UPDATE cloud_follower_service_bindings SET ${column}=$3,state_revision=$4,updated_at=now()
            WHERE owner_user_id=$1 AND account_workspace_id=$2`, [grant.userId, workspaceId, target.id, nextRevision]);
        } else {
          await client.query(`UPDATE cloud_follower_personal_versions SET status='rejected',decision_status='rejected',updated_at=now()
            WHERE owner_user_id=$1 AND id=$2`, [grant.userId, target.id]);
          await client.query(`UPDATE cloud_follower_service_bindings SET state_revision=$3,updated_at=now()
            WHERE owner_user_id=$1 AND account_workspace_id=$2`, [grant.userId, workspaceId, nextRevision]);
        }
        await client.query(`INSERT INTO cloud_follower_personal_decisions(
          id,owner_user_id,account_workspace_id,service_instance_id,version_id,version_kind,decision,
          expected_state_revision,resulting_state_revision,command_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [`follower_decision_${sha256(`${grant.userId}:${workspaceId}:${commandId}`).slice(0, 40)}`,
          grant.userId, workspaceId, binding.service_instance_id, target.id, target.version_kind, decision, expectedRevision, nextRevision, commandId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      return this.evolutionStatus(grant, { workspaceId, contract: payload.contract });
    },

    async rollbackPersonal(grant, payload = {}) {
      requireCompatible(payload.contract, ['follower-system-service-v1', 'follower-personal-overlay-v1'], apiError);
      const workspaceId = clean(payload.workspaceId || 'workspace_personal', 200);
      const kind = ['personal_overlay', 'preference_memory'].includes(payload.kind) ? payload.kind : 'personal_overlay';
      const binding = (await pool.query(`SELECT * FROM cloud_follower_service_bindings WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND status='active'`, [grant.userId, workspaceId])).rows[0];
      if (!binding) throw apiError('follower_service_instance_invalid', 'Follower service instance is not active.', 409);
      let target = null;
      if (payload.targetVersionId) target = (await pool.query(`SELECT * FROM cloud_follower_personal_versions WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND version_kind=$3 AND id=$4`, [grant.userId, workspaceId, kind, payload.targetVersionId])).rows[0];
      else target = (await pool.query(`SELECT * FROM cloud_follower_personal_versions WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND version_kind=$3 AND status='archived' ORDER BY version_no DESC LIMIT 1`, [grant.userId, workspaceId, kind])).rows[0];
      if (!target) throw apiError('follower_personal_rollback_target_missing', 'No Follower personalization rollback target is available.', 404);
      await pool.query(`UPDATE cloud_follower_personal_versions SET status='archived' WHERE owner_user_id=$1
        AND account_workspace_id=$2 AND version_kind=$3 AND status='active'`, [grant.userId, workspaceId, kind]);
      await pool.query(`UPDATE cloud_follower_personal_versions SET status='active' WHERE owner_user_id=$1 AND id=$2`, [grant.userId, target.id]);
      const column = kind === 'personal_overlay' ? 'personal_overlay_version_id' : 'preference_memory_version_id';
      await pool.query(`UPDATE cloud_follower_service_bindings SET ${column}=$3,state_revision=state_revision+1,updated_at=now()
        WHERE owner_user_id=$1 AND account_workspace_id=$2`, [grant.userId, workspaceId, target.id]);
      return this.evolutionStatus(grant, { workspaceId, contract: payload.contract });
    },

    async evaluateCluster() {
      const rows = (await pool.query(`SELECT * FROM cloud_follower_preference_signals WHERE cluster_eligible=true
        AND validation_state='validated' ORDER BY occurred_at DESC LIMIT 5000`)).rows;
      const evidence = rows.map((row) => ({ ...row, ownerUserId: row.owner_user_id, serviceInstanceId: row.service_instance_id, sourceKind: row.source_kind }));
      const eligibility = evaluateFollowerClusterEvidence(evidence);
      if (!eligibility.eligible) return { status: 'insufficient_evidence', eligibility };
      const selected = new Set(eligibility.selectedEvidenceIds || []);
      const selectedRows = rows.filter((row) => selected.has(row.evidence_id));
      const rawReports = [];
      for (const row of selectedRows.filter((item) => ['follower_report_feedback', 'follower_report_correction', 'follower_suggestion_outcome'].includes(item.source_kind))) {
        const report = (await pool.query(`SELECT report_kind,report_json FROM cloud_follower_raw_reports
          WHERE owner_user_id=$1 AND account_workspace_id=$2 AND report_id=$3 AND deleted_at IS NULL`, [
          row.owner_user_id, row.account_workspace_id, row.source_id,
        ])).rows[0];
        if (report) rawReports.push({ ...report, owner_user_id: row.owner_user_id, service_instance_id: row.service_instance_id,
          signalKind: row.signal_kind, normalized: row.normalized_json || {} });
      }
      const sections = reusableClusterSections(selectedRows, rawReports);
      if (!sections.length) return { status: 'insufficient_section_support', eligibility };
      const supportInstances = [...new Set(selectedRows.map((row) => row.service_instance_id))].slice(0, 50);
      const candidateId = `follower_candidate_${sha256(JSON.stringify({ sections, ids: selectedRows.map((row) => row.evidence_id).sort() })).slice(0, 40)}`;
      const privacyPassed = !JSON.stringify(sections).match(/(?:@|\/home\/|[A-Za-z]:\\|token|password|secret|user_)/i);
      const status = privacyPassed ? 'gated' : 'rejected';
      const snapshotHash = sha256(selectedRows.map((row) => row.evidence_id).sort().join('\n'));
      await pool.query(`INSERT INTO cloud_follower_cluster_candidates(
        id,status,evidence_count,user_count,support_instance_count,sections_json,support_proof_json,governance_json,shadow_json,canary_json,
        status_reason,evidence_snapshot_hash,maximum_user_weight_share,governance_review_status,shadow_status
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,'pending','pending')
      ON CONFLICT(id) DO NOTHING`, [
        candidateId, status, eligibility.evidenceCount, eligibility.userCount, eligibility.supportingInstanceCount, JSON.stringify(sections),
        JSON.stringify({ policyVersion: 'follower_support_proof_v1', supportingInstances: supportInstances,
          minimumSupportingInstances: FOLLOWER_CLUSTER_PROFILE.minimumSupportingInstances }),
        JSON.stringify({ policyVersion: 'follower_governance_v1', deterministicPrivacyPassed: privacyPassed, reviewerStatus: 'pending', releaseTarget: 'system_agent_follower' }),
        JSON.stringify({ policyVersion: 'follower_shadow_v1', status: 'pending', holdoutScope: 'cross_user' }),
        privacyPassed ? '' : 'follower_cluster_privacy_rejected', snapshotHash, eligibility.maximumUserShare,
      ]);
      for (const row of selectedRows) await pool.query(`INSERT INTO cloud_follower_cluster_candidate_evidence(
        candidate_id,evidence_id,owner_user_id,service_instance_id,lineage_key,evidence_role
      ) VALUES($1,$2,$3,$4,$5,'training') ON CONFLICT(candidate_id,evidence_id) DO NOTHING`, [
        candidateId, row.evidence_id, row.owner_user_id, row.service_instance_id, row.lineage_key,
      ]);
      const candidate = (await pool.query('SELECT status FROM cloud_follower_cluster_candidates WHERE id=$1', [candidateId])).rows[0];
      return { status: candidate?.status || status, candidateId, eligibility, sections };
    },

    async recordGovernance({ candidateId = '', reviewerUserId = '', decision = '', metrics = {} } = {}) {
      const candidate = (await pool.query(`SELECT * FROM cloud_follower_cluster_candidates WHERE id=$1 AND status='gated'`, [candidateId])).rows[0];
      if (!candidate) throw apiError('follower_governance_candidate_invalid', 'Follower candidate is not awaiting governance.', 409);
      const passed = decision === 'passed' && metrics?.privacyPassed === true && metrics?.supportProofPassed === true;
      const normalized = passed ? 'passed' : 'failed';
      await pool.query(`INSERT INTO cloud_follower_cluster_reviews(id,candidate_id,review_kind,decision,reviewer_user_id,metrics_json)
        VALUES($1,$2,'governance',$3,$4,$5::jsonb) ON CONFLICT(candidate_id,review_kind) DO UPDATE SET
        decision=excluded.decision,reviewer_user_id=excluded.reviewer_user_id,metrics_json=excluded.metrics_json,created_at=now()`, [
        `follower_review_${sha256(`${candidateId}:governance`).slice(0, 40)}`, candidateId, normalized, reviewerUserId, JSON.stringify(metrics || {}),
      ]);
      await pool.query(`UPDATE cloud_follower_cluster_candidates SET status=$2,governance_review_status=$3,
        governance_json=$4::jsonb,status_reason=$5,updated_at=now() WHERE id=$1`, [candidateId,
        passed ? 'governance_approved' : 'rejected', normalized,
        JSON.stringify({ policyVersion: 'follower_governance_v1', reviewerUserId, decision: normalized, metrics }),
        passed ? '' : 'follower_governance_rejected']);
      return { candidateId, status: passed ? 'governance_approved' : 'rejected' };
    },

    async recordShadow({ candidateId = '', reviewerUserId = '', decision = '', metrics = {} } = {}) {
      const candidate = (await pool.query(`SELECT * FROM cloud_follower_cluster_candidates WHERE id=$1 AND status='governance_approved'
        AND governance_review_status='passed'`, [candidateId])).rows[0];
      if (!candidate) throw apiError('follower_shadow_candidate_invalid', 'Follower candidate has not passed governance.', 409);
      const passed = decision === 'passed' && Number(metrics?.crossUserHoldoutCount || 0) >= 3
        && Number(metrics?.privacyViolations || 0) === 0 && Number(metrics?.regressionCount || 0) === 0;
      const normalized = passed ? 'passed' : 'failed';
      await pool.query(`INSERT INTO cloud_follower_cluster_reviews(id,candidate_id,review_kind,decision,reviewer_user_id,metrics_json)
        VALUES($1,$2,'shadow',$3,$4,$5::jsonb) ON CONFLICT(candidate_id,review_kind) DO UPDATE SET
        decision=excluded.decision,reviewer_user_id=excluded.reviewer_user_id,metrics_json=excluded.metrics_json,created_at=now()`, [
        `follower_review_${sha256(`${candidateId}:shadow`).slice(0, 40)}`, candidateId, normalized, reviewerUserId, JSON.stringify(metrics || {}),
      ]);
      await pool.query(`UPDATE cloud_follower_cluster_candidates SET status=$2,shadow_status=$3,shadow_json=$4::jsonb,
        status_reason=$5,updated_at=now() WHERE id=$1`, [candidateId, passed ? 'shadow_passed' : 'rejected', normalized,
        JSON.stringify({ policyVersion: 'follower_shadow_v1', reviewerUserId, decision: normalized, metrics, holdoutScope: 'cross_user' }),
        passed ? '' : 'follower_shadow_rejected']);
      return { candidateId, status: passed ? 'shadow_passed' : 'rejected' };
    },

    async recordCanary({ candidateId = '', ownerUserId = '', serviceInstanceId = '', outcome = '', metrics = {} } = {}) {
      const candidate = (await pool.query(`SELECT * FROM cloud_follower_cluster_candidates WHERE id=$1
        AND status IN ('shadow_passed','canary_running','canary_passed') AND governance_review_status='passed' AND shadow_status='passed'`, [candidateId])).rows[0];
      if (!candidate) throw apiError('follower_canary_candidate_invalid', 'Follower candidate is not in Canary.', 409);
      if (!['passed', 'failed'].includes(outcome)) throw apiError('follower_canary_outcome_invalid', 'Follower Canary outcome is invalid.', 400);
      const binding = (await pool.query(`SELECT 1 FROM cloud_follower_service_bindings WHERE owner_user_id=$1
        AND service_instance_id=$2 AND status='active'`, [ownerUserId, serviceInstanceId])).rows[0];
      if (!binding) throw apiError('follower_canary_subject_invalid', 'Follower Canary subject is invalid.', 403);
      const trained = (await pool.query(`SELECT 1 FROM cloud_follower_cluster_candidate_evidence WHERE candidate_id=$1
        AND owner_user_id=$2 AND evidence_role='training'`, [candidateId, ownerUserId])).rows[0];
      if (trained) throw apiError('follower_canary_holdout_required', 'Follower Canary must use a user outside the training cohort.', 409);
      if (outcome === 'passed' && (metrics?.privacy !== 'passed' || Number(metrics?.regressionCount || 0) !== 0)) {
        throw apiError('follower_canary_metrics_invalid', 'Follower Canary pass requires privacy and regression metrics.', 400);
      }
      const existingEvaluation = (await pool.query(`SELECT * FROM cloud_follower_canary_evaluations WHERE candidate_id=$1 AND owner_user_id=$2`,
        [candidateId, ownerUserId])).rows[0];
      if (existingEvaluation && (existingEvaluation.service_instance_id !== serviceInstanceId || existingEvaluation.outcome !== outcome
        || sha256(JSON.stringify(existingEvaluation.metrics_json || {})) !== sha256(JSON.stringify(metrics || {})))) {
        throw apiError('follower_canary_identity_collision', 'Follower Canary result is immutable.', 409);
      }
      await pool.query(`INSERT INTO cloud_follower_canary_evaluations(id,candidate_id,owner_user_id,service_instance_id,outcome,metrics_json,holdout_verified)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,true) ON CONFLICT(candidate_id,owner_user_id) DO NOTHING`, [
        `follower_canary_${sha256(`${candidateId}:${ownerUserId}`).slice(0, 40)}`, candidateId, ownerUserId, serviceInstanceId, outcome, JSON.stringify(metrics || {})]);
      const evaluations = (await pool.query('SELECT * FROM cloud_follower_canary_evaluations WHERE candidate_id=$1', [candidateId])).rows;
      const failed = evaluations.some((item) => item.outcome === 'failed');
      const passed = !failed && evaluations.filter((item) => item.holdout_verified).length >= FOLLOWER_CLUSTER_PROFILE.minimumSupportingInstances;
      const status = failed ? 'rejected' : passed ? 'canary_passed' : 'canary_running';
      await pool.query(`UPDATE cloud_follower_cluster_candidates SET status=$2,canary_json=$3::jsonb,status_reason=$4,updated_at=now() WHERE id=$1`, [
        candidateId, status, JSON.stringify({ policyVersion: 'follower_real_user_canary_v1', evaluationCount: evaluations.length,
          minimumCount: FOLLOWER_CLUSTER_PROFILE.minimumSupportingInstances, passed }), failed ? 'follower_canary_failed' : '',
      ]);
      return { candidateId, status, evaluationCount: evaluations.length };
    },

    async publishCandidate({ candidateId = '', releaseVersion = '' } = {}) {
      const candidate = (await pool.query(`SELECT * FROM cloud_follower_cluster_candidates WHERE id=$1 AND status='canary_passed'`, [candidateId])).rows[0];
      if (!candidate) throw apiError('follower_candidate_not_publishable', 'Follower candidate has not passed Canary.', 409);
      if (candidate.governance_review_status !== 'passed' || candidate.shadow_status !== 'passed'
        || Number(candidate.maximum_user_weight_share || 1) > FOLLOWER_CLUSTER_PROFILE.maximumUserWeightShare) {
        throw apiError('follower_candidate_gates_incomplete', 'Follower candidate governance gates are incomplete.', 409);
      }
      const privateKeyPem = signingPrivateKey(env);
      if (!privateKeyPem) throw apiError('follower_signing_key_unavailable', 'Follower publishing signing key is unavailable.', 503);
      const files = followerBundleFiles(candidate.sections_json || []);
      const bundle = buildFollowerSystemAgentBundle({ files, releaseVersion: clean(releaseVersion || env.JANUS_FOLLOWER_BUNDLE_VERSION || '1.0.1', 40),
        minAppVersion: '1.0.0', sourceCandidateId: candidate.id });
      signFollowerSystemAgentBundle(bundle, { privateKeyPem });
      await pool.query(`INSERT INTO cloud_follower_system_bundles(id,candidate_id,release_version,bundle_json,content_hash,signing_key_id,status)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,'released') ON CONFLICT(id) DO UPDATE SET bundle_json=excluded.bundle_json,
        content_hash=excluded.content_hash,signing_key_id=excluded.signing_key_id,status='released'`, [
        bundle.bundleId, candidate.id, bundle.releaseVersion, JSON.stringify(bundle), bundle.contentHash, bundle.signingKeyId,
      ]);
      await pool.query(`UPDATE cloud_follower_cluster_candidates SET status='released',updated_at=now() WHERE id=$1`, [candidate.id]);
      return { status: 'released', candidateId: candidate.id, bundleId: bundle.bundleId, releaseTarget: 'system_agent_follower' };
    },

    async systemBundle(_grant, options = {}) {
      requireCompatible(typeof options.contract === 'string' ? parseContract(options.contract) : options.contract,
        ['follower-system-agent-bundle-v1'], apiError);
      const appVersion = clean(options.appVersion || '', 40);
      const row = (await pool.query(`SELECT * FROM cloud_follower_system_bundles WHERE status='released' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      if (!row || row.id === clean(options.currentBundleId, 240)) return { available: false };
      const bundle = row.bundle_json;
      if (compareVersions(appVersion, bundle.minAppVersion) < 0) return { available: false, incompatible: true, minimumAppVersion: bundle.minAppVersion };
      return { available: true, bundle };
    },
  };
}

async function materializePersonalCandidates(pool, userId, workspaceId, serviceInstanceId) {
  const rows = (await pool.query(`SELECT * FROM cloud_follower_preference_signals WHERE owner_user_id=$1
    AND account_workspace_id=$2 AND personal_eligible=true AND validation_state='validated' ORDER BY occurred_at,evidence_id`, [userId, workspaceId])).rows;
  const memory = {};
  for (const row of rows) {
    if (row.signal_kind === 'verbosity') memory.verbosity = row.normalized_json?.value;
    if (row.signal_kind === 'language') memory.language = row.normalized_json?.value;
    if (row.signal_kind === 'focus') memory.focus = row.normalized_json?.values || [];
    if (row.signal_kind === 'suggestion_count') memory.suggestionCount = row.normalized_json?.value;
  }
  const instructions = [];
  if (memory.verbosity) instructions.push(`Use ${memory.verbosity} report detail while preserving all evidence and privacy checks.`);
  if (memory.language) instructions.push(`Write report prose in ${memory.language}.`);
  if (memory.focus?.length) instructions.push(`Prioritize these authorized report themes: ${memory.focus.join(', ')}.`);
  if (memory.suggestionCount) instructions.push(`Return at most ${memory.suggestionCount} evidence-backed suggestions.`);
  if (!rows.length) return;
  await upsertPersonalCandidate(pool, { userId, workspaceId, serviceInstanceId, kind: 'preference_memory', payload: memory });
  await upsertPersonalCandidate(pool, { userId, workspaceId, serviceInstanceId, kind: 'personal_overlay', payload: { text: instructions.join('\n') } });
}

async function upsertPersonalCandidate(pool, { userId, workspaceId, serviceInstanceId, kind, payload }) {
  const contentHash = sha256(JSON.stringify(payload));
  const current = (await pool.query(`SELECT * FROM cloud_follower_personal_versions WHERE owner_user_id=$1
    AND account_workspace_id=$2 AND version_kind=$3 AND content_hash=$4 AND status IN ('active','candidate')`, [userId, workspaceId, kind, contentHash])).rows[0];
  if (current?.content_hash === contentHash) return current;
  const versionNo = Number((await pool.query(`SELECT MAX(version_no) value FROM cloud_follower_personal_versions
    WHERE owner_user_id=$1 AND account_workspace_id=$2 AND version_kind=$3`, [userId, workspaceId, kind])).rows[0]?.value || 0) + 1;
  const id = `follower_${kind}_${sha256(`${userId}:${workspaceId}:${versionNo}:${contentHash}`).slice(0, 40)}`;
  await pool.query(`INSERT INTO cloud_follower_personal_versions(id,owner_user_id,account_workspace_id,service_instance_id,
    version_kind,version_no,payload_json,content_hash,status,review_status,replay_status,decision_status,baseline_hash,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'candidate','passed','passed','pending',$9,$10)`, [
    id, userId, workspaceId, serviceInstanceId, kind, versionNo, JSON.stringify(payload), contentHash,
    sha256(`${kind}:follower_report_contract_v2:follower_privacy_v1`), new Date(),
  ]);
  return { id, content_hash: contentHash, payload_json: payload, status: 'candidate' };
}

function validateProjection(value, apiError) {
  const projection = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (projection.schemaVersion !== 'follower_report_projection_v1' || !/^follower_projection_[a-f0-9]{40}$/.test(String(projection.projectionId || ''))) {
    throw apiError('follower_projection_contract_invalid', 'Follower projection contract is invalid.', 400);
  }
  if (!['daily_brief', 'weekly_review', 'growth_guidance'].includes(projection.reportKind) || !projection.validatedHash || !projection.syncBody) {
    throw apiError('follower_projection_content_invalid', 'Follower projection content is invalid.', 400);
  }
  if (Buffer.byteLength(String(projection.syncBody), 'utf8') > 24_000 || JSON.stringify(projection).match(/(?:sourceId|sourceRefs|localReference|absolutePath|\/home\/|[A-Za-z]:\\)/)) {
    throw apiError('follower_projection_private_metadata', 'Follower projection contains forbidden local metadata.', 400);
  }
  return projection;
}

function validateRawReport(value, projection, apiError) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (raw.schemaVersion !== 'follower_raw_report_v1' || !raw.reportId || raw.reportKind !== projection.reportKind
    || raw.validatedHash !== projection.validatedHash || raw.privacyValidatorVersion !== projection.privacyValidatorVersion) {
    throw apiError('follower_raw_report_contract_invalid', 'Follower raw report contract is invalid.', 400);
  }
  if (raw.report?.schemaVersion !== 'follower_report_v2' || raw.report?.kind !== raw.reportKind || !String(raw.renderedBody || '').trim()) {
    throw apiError('follower_raw_report_content_invalid', 'Follower raw report content is invalid.', 400);
  }
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, 'utf8') > 160_000
    || /(?:localReference|absolutePath|[A-Za-z]:\\[^"\r\n]+|\/(?:home|Users|var|tmp|etc)\/[^"\r\n]+)/.test(serialized)) {
    throw apiError('follower_raw_report_private_metadata', 'Follower raw report contains forbidden local metadata.', 400);
  }
  return raw;
}

function projectionPayload(row) {
  return { ...(row.projection_json || {}), projectionId: row.projection_id, originDeviceId: row.origin_device_id,
    reportKind: row.report_kind, validatedHash: row.validated_hash, privacyValidatorVersion: row.privacy_validator_version,
    revision: Number(row.revision || 1), deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : '',
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

async function upsertRawReport(client, grant, workspaceId, rawReport, apiError) {
  const result = await client.query(`INSERT INTO cloud_follower_raw_reports(
    owner_user_id,account_workspace_id,report_id,origin_device_id,report_kind,report_json,rendered_body,
    validated_hash,privacy_validator_version,deleted_at,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,NULL,$10,$11)
  ON CONFLICT(owner_user_id,account_workspace_id,report_id) DO UPDATE SET
    origin_device_id=excluded.origin_device_id,report_kind=excluded.report_kind,report_json=excluded.report_json,
    rendered_body=excluded.rendered_body,privacy_validator_version=excluded.privacy_validator_version,
    deleted_at=NULL,updated_at=excluded.updated_at
  WHERE cloud_follower_raw_reports.validated_hash=excluded.validated_hash
  RETURNING validated_hash`, [
    grant.userId, workspaceId, rawReport.reportId, rawReport.originDeviceId || grant.deviceId, rawReport.reportKind,
    JSON.stringify(rawReport.report), rawReport.renderedBody, rawReport.validatedHash,
    rawReport.privacyValidatorVersion, rawReport.createdAt, rawReport.updatedAt,
  ]);
  if (!result.rows.length) throw apiError('follower_raw_report_identity_collision', 'Follower raw report identity collision.', 409);
}

function reusableClusterSections(rows, rawReports = []) {
  const counts = {};
  for (const row of rows) {
    const key = `${row.signal_kind}:${JSON.stringify(row.normalized_json || {})}`;
    counts[key] ||= { support: 0, users: new Set(), instances: new Set() };
    counts[key].support += 1;
    counts[key].users.add(row.owner_user_id);
    counts[key].instances.add(row.service_instance_id);
  }
  const sections = Object.entries(counts).filter(([, value]) => value.users.size >= 3 && value.instances.size >= 3)
    .sort((a, b) => b[1].support - a[1].support).slice(0, 8).map(([key, value]) => ({
      sectionId: `follower_method_${sha256(key).slice(0, 12)}`, instruction: clusterInstruction(key), support: value.support,
      supportingUsers: value.users.size, supportingInstances: value.instances.size,
    }));
  const helpfulGrowth = rawReports.filter((item) => item.report_kind === 'growth_guidance'
    && item.signalKind === 'report_feedback' && item.normalized?.rating === 'helpful');
  if (helpfulGrowth.length >= 3) {
    const categories = helpfulGrowth.flatMap((item) => (item.report_json?.suggestions || []).map((suggestion) => suggestion.category)).filter(Boolean);
    const preferred = [...new Set(categories)].filter((item) => ['insight', 'recommendation', 'research_direction'].includes(item));
    if (preferred.length) sections.push({ sectionId: `follower_method_${sha256(`raw-growth:${preferred.sort().join(',')}`).slice(0, 12)}`,
      instruction: `For growth guidance, synthesize evidence into these useful extension forms when supported: ${preferred.join(', ')}. Avoid generic time-boxed next steps.`,
      support: helpfulGrowth.length, supportingUsers: new Set(helpfulGrowth.map((item) => item.owner_user_id)).size,
      supportingInstances: 0 });
  }
  return sections.slice(0, 8);
}

function personalVersionPayload(item) {
  return { id: item.id, kind: item.version_kind, versionNo: Number(item.version_no), status: item.status,
    hash: item.content_hash, content: item.payload_json || {}, reviewStatus: item.review_status || 'pending',
    replayStatus: item.replay_status || 'pending', decisionStatus: item.decision_status || 'pending',
    baselineHash: item.baseline_hash || '', createdAt: item.created_at, updatedAt: item.updated_at || item.created_at };
}

function clusterInstruction(key) {
  if (key.startsWith('report_pattern:')) return 'Preserve evidence-linked report structure and diversify growth guidance across non-obvious insights, recommendations, and worthwhile research directions.';
  if (key.startsWith('report_feedback:')) return 'Keep report summaries concise, evidence-linked, and explicit about uncertainty.';
  if (key.startsWith('suggestion_outcome:')) return 'Prefer evidence-grounded insights, recommendations, and research directions with a clear rationale and expected value.';
  if (key.startsWith('fact_correction:')) return 'Downgrade uncertain statements and distinguish observed status from inferred status.';
  return 'Use a stable report structure while preserving the host evidence and privacy policies.';
}

function followerBundleFiles(sections) {
  const names = ['agent.json', 'lifecycle.json', 'SKILL.md', 'MEMORY.md', 'references/report-contract.md'];
  return names.map((name) => {
    const file = path.join(FOLLOWER_ASSET_ROOT, ...name.split('/'));
    let content = fs.readFileSync(file, 'utf8');
    if (name === 'SKILL.md' && sections.length) content = `${content.trimEnd()}\n\n## Governed cluster methods\n\n${sections.map((item) => `- ${item.instruction}`).join('\n')}\n`;
    return { path: name, content };
  });
}

async function requireWorkspace(pool, userId, value, apiError) {
  const workspaceId = clean(value || 'workspace_personal', 200);
  if (workspaceId === 'workspace_personal') return workspaceId;
  const membership = (await pool.query(`SELECT 1 FROM account_workspace_memberships WHERE workspace_id=$1
    AND user_id=$2 AND status='active'`, [workspaceId, userId])).rows[0];
  if (!membership) throw apiError('follower_workspace_forbidden', 'Follower Workspace access is not allowed.', 403);
  return workspaceId;
}

function requireCompatible(contract, capabilities, apiError) {
  const assessment = assessFollowerCloudCompatibility(contract || {}, { requiredCapabilities: capabilities });
  if (!assessment.compatible) throw apiError('follower_client_incompatible', assessment.reasons.join(', '), 409);
  return assessment;
}
function parseContract(value) { try { return JSON.parse(String(value || '{}')); } catch { return {}; } }
function requireAdmin(user, apiError) { if (user?.role !== 'admin') throw apiError('forbidden', 'Cloud administrator permission is required.', 403); }
function signingPrivateKey(env) { const value = String(env.JANUS_FOLLOWER_SYSTEM_SIGNING_PRIVATE_KEY || '').trim(); if (!value) return ''; return value.includes('BEGIN PRIVATE KEY') ? value : fs.existsSync(value) ? fs.readFileSync(value, 'utf8') : ''; }
function nullableDate(value) { const date = new Date(value || ''); return Number.isFinite(date.getTime()) ? date : null; }
function clean(value = '', max = 240) { return String(value ?? '').trim().slice(0, max); }
function cleanMultiline(value = '', max = 12_000) { return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function compareVersions(left, right) { const p = (v) => String(v || '0').split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0); const a = p(left); const b = p(right); for (let i = 0; i < 3; i += 1) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; return 0; }
function simpleApiError(code, message, status = 400) { const error = new Error(message); error.code = code; error.status = status; return error; }
