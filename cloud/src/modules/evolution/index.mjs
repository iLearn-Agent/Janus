import crypto from 'node:crypto';

import {
  PERSONAL_EVOLUTION_ALGORITHM_VERSION,
  PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS,
  PERSONAL_MAXIMUM_EVIDENCE,
  PERSONAL_MINIMUM_EVIDENCE,
  PERSONAL_EVOLUTION_RETRY_INTERVAL_MS,
  disabledEvolutionCapability,
  decryptEvolutionPayload,
  evolutionEnvelopeCapability,
  evolutionEnvelopePublicKeyringFromEnv,
  encryptEvolutionPayload,
  evolutionEncryptionReady,
  evolutionEvidenceClusterScopeAutomatic,
  evolutionKeyringFromEnv,
  normalizeEvolutionEvidenceIdentity,
  normalizeEvolutionEvidenceSourceKind,
  personalEvolutionThresholdEligible,
  PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
  stableEvolutionEvidenceId,
} from '../../../../src/shared/evolution/index.js';
import {
  cloudTaskMemoryEnvelopeCapability,
  cloudTaskMemoryPrivateKeyringFromEnv,
  cloudTaskMemoryPublicKeyringFromEnv,
  decryptTaskMemoryContent,
  unwrapTaskKeyFromCloud,
} from '../../../../src/shared/taskMemoryCrypto.js';
import { decidePostgresPersonalRun } from './worker.mjs';
import { createPostgresStage8Authority } from './stage8.mjs';
import { createPostgresLeadershipAuthority } from './leadership.mjs';
import { routeWithDeviceGrant } from '../sync/index.mjs';
import { postgresPersonalEvolutionSchedules, queuePostgresPersonalEvolutionRun } from './personalQueue.mjs';
import { createPostgresEvidenceUsageLedger } from './evidenceUsageLedger.mjs';
import { evolutionModelDelegatedToWorker, evolutionModelProviderStatus } from './modelProvider.mjs';
export { createPostgresLeadershipAuthority } from './leadership.mjs';
export { createEvolutionModelExecutor, evolutionModelDelegatedToWorker, evolutionModelProviderStatus } from './modelProvider.mjs';
export { postgresPersonalEvolutionSchedules, queuePostgresPersonalEvolutionRun } from './personalQueue.mjs';
export { createPostgresEvolutionWorker, decidePostgresPersonalRun, evaluatePostgresVersionHealth, rewrapPostgresEvolutionEvidence } from './worker.mjs';
export { createPostgresStage8Authority } from './stage8.mjs';

export function registerEvolutionRoutes({ app, pool, auth, route, apiError, deviceGrants, env = process.env }) {
  const stage8 = createPostgresStage8Authority({ pool, env });
  const leadership = createPostgresLeadershipAuthority({ pool, env });
  const issueGrant = route(async (req, res) => {
    const deviceId = String(req.body?.deviceId || '').trim();
    if (!deviceId) throw apiError('evolution_grant_subject_required', 'Device identity is required.', 400);
    const requestedScopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : ['evolution:read', 'evolution:write'];
    const scopes = [...new Set(requestedScopes.filter((scope) => ['evolution:read', 'evolution:write', 'evolution:*'].includes(scope)))];
    if (!scopes.length) throw apiError('evolution_grant_scope_required', 'At least one valid evolution scope is required.', 400);
    await deviceGrants.register({ userId: req.auth.user.id, input: req.body || {} });
    res.status(201).json(await deviceGrants.issueToken({
      userId: req.auth.user.id, deviceId, requestedScopes: scopes, proof: req.body?.proof, allowLegacyNoKey: true,
    }));
  });
  app.post('/v1/evolution/grants', auth, issueGrant);
  app.post('/api/evolution/grants', auth, issueGrant);
  app.get('/api/evolution/grants', auth, route(async (req, res) => {
    const { rows } = await pool.query(`SELECT id,user_id,device_id,scopes_json,status,expires_at,created_at,updated_at
      FROM cloud_sync_grants WHERE user_id = $1 ORDER BY updated_at DESC`, [req.auth.user.id]);
    res.json({ items: rows.map((row) => ({ id: row.id, userId: row.user_id, deviceId: row.device_id,
      scopes: row.scopes_json, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at })) });
  }));
  app.delete('/api/evolution/grants/:deviceId', auth, route(async (req, res) => {
    res.json(await deviceGrants.revoke({
      userId: req.auth.user.id, actorDeviceId: 'legacy_access_token', targetDeviceId: req.params.deviceId,
    }));
  }));

  app.get('/v1/evolution/capabilities', routeWithGrant(pool, apiError, 'evolution:read', async (_req, res) => {
    res.json({ ...evolutionCapabilities(env), ...stage8.capabilities(), leadership: leadership.capabilities() });
  }));

  app.get('/v1/evolution/preferences', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    res.json(await readPostgresEvolutionPreference(pool, req.evolutionGrant.userId));
  }));

  app.patch('/v1/evolution/preferences', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const result = await updatePostgresEvolutionPreference(pool, {
      userId: req.evolutionGrant.userId,
      deviceId: req.evolutionGrant.deviceId,
      enabled: req.body?.enabled !== false,
      commandId: String(req.body?.commandId || ''),
      expectedStateRevision: req.body?.expectedStateRevision,
      apiError,
    });
    res.status(result.status === 'conflict' ? 409 : 200).json(result);
  }));

  app.post('/v1/evolution/evidence/batch', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const result = await ingestEvidence(pool, req.evolutionGrant, req.body?.items || [], env);
    res.json(result);
  }));

  app.get('/v1/evolution/evidence/counts', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError);
    const counts = await createPostgresEvidenceUsageLedger(pool).counts({ownerUserId:req.evolutionGrant.userId,agentInstanceId:instanceId});
    res.json({ agentInstanceId: instanceId, available: counts.available || 0, counts });
  }));

  app.get('/v1/evolution/evidence/usage', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId=await requireOwnedInstance(pool,req.evolutionGrant.userId,req.query.agentInstanceId,apiError);
    const cursor=decodeUsageCursor(req.query.cursor||'');
    const pageSize=Math.min(200,Math.max(1,Number(req.query.limit||50)));
    const rows=await createPostgresEvidenceUsageLedger(pool).listUsage({ownerUserId:req.evolutionGrant.userId,agentInstanceId:instanceId,
      scope:String(req.query.scope||''),status:String(req.query.status||''),cursor,limit:pageSize+1});
    const page=rows.slice(0,pageSize);res.json({authority:'cloud',agentInstanceId:instanceId,items:page.map(evidenceUsageListPayload),
      nextCursor:rows.length>pageSize?encodeUsageCursor(page.at(-1)):''});
  }));

  app.get('/v1/evolution/personal/schedule', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const agentInstanceId = req.query.agentInstanceId
      ? await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError)
      : '';
    const items = await postgresPersonalEvolutionSchedules(pool, {
      userId: req.evolutionGrant.userId, agentInstanceId,
    });
    res.json(req.query.agentInstanceId ? items[0] : { authority: 'cloud', items });
  }));

  app.post('/v1/evolution/personal/runs', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const agentInstanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    const result = await requestPersonalRun(pool, req.evolutionGrant, { ...(req.body || {}), agentInstanceId }, apiError, env);
    res.status(result.status === 'unavailable' ? 503 : 202).json(result);
  }));

  app.get('/v1/evolution/personal/runs', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const values = [req.evolutionGrant.userId];
    let filter = '';
    if (req.query.agentInstanceId) {
      values.push(await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError));
      filter = ` AND user_agent_instance_id = $${values.length}`;
    }
    values.push(Math.min(100, Math.max(1, Number(req.query.limit || 30))));
    const { rows } = await pool.query(`SELECT * FROM cloud_evolution_runs WHERE owner_user_id = $1${filter}
      ORDER BY created_at DESC LIMIT $${values.length}`, values);
    res.json({ authority: 'cloud', items: rows.map(runPayload) });
  }));

  app.get('/v1/evolution/personal/runs/:runId', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM cloud_evolution_runs WHERE id = $1 AND owner_user_id = $2', [req.params.runId, req.evolutionGrant.userId]);
    if (!rows[0]) throw apiError('evolution_run_not_found', 'Evolution run was not found.', 404);
    const evaluations = await pool.query('SELECT * FROM cloud_evolution_evaluations WHERE run_id = $1 ORDER BY evaluation_kind, case_index', [req.params.runId]);
    const proposal = (await pool.query('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id=$1 AND id=$2', [req.evolutionGrant.userId, req.params.runId])).rows[0];
    const memoryOperations = (await pool.query('SELECT * FROM cloud_personal_evolution_memory_operations_v4 WHERE user_id=$1 AND proposal_id=$2 ORDER BY created_at,id', [req.evolutionGrant.userId, req.params.runId])).rows;
    const actions = (await pool.query('SELECT * FROM cloud_personal_evolution_actions_v4 WHERE user_id=$1 AND proposal_id=$2 ORDER BY received_at,id', [req.evolutionGrant.userId, req.params.runId])).rows;
    const candidate = rows[0].candidate_personal_skill_version_id
      ? (await pool.query('SELECT * FROM cloud_personal_skill_overlay_versions WHERE user_id=$1 AND id=$2', [req.evolutionGrant.userId, rows[0].candidate_personal_skill_version_id])).rows[0]
      : null;
    const usage = await createPostgresEvidenceUsageLedger(pool).runUsage({runId:rows[0].id,scope:rows[0].evolution_scope,consumerId:rows[0].consumer_id});
    const keyring = evolutionKeyringFromEnv(env);
    res.json({ ...runPayload(rows[0]), evaluations: evaluations.rows.map((row) => ({ ...row, result: row.result_json })),
      proposal: proposal?.payload_json || null, memoryOperations: memoryOperations.map((row) => ({ ...row.payload_json, status: row.status })),
      actions: actions.map((row) => row.payload_json), evidenceUsage: usage.map((row) => ({ evidenceId: row.evidence_id,
        status: row.status, rejectionKind: row.rejection_kind || '', transitionReason: row.transition_reason || '',
        reEvaluationBasisHash: row.re_evaluation_basis_hash || '' })), candidateVersion: candidate ? versionPayload(candidate, keyring) : null });
  }));

  app.post('/v1/evolution/personal/runs/:runId/decisions', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const candidate = (await pool.query('SELECT candidate_personal_skill_version_id FROM cloud_evolution_runs WHERE id=$1 AND owner_user_id=$2', [req.params.runId, req.evolutionGrant.userId])).rows[0];
    if (!candidate) throw apiError('evolution_run_not_found', 'Evolution run was not found.', 404);
    const decisions = Array.isArray(req.body?.decisions) ? [...req.body.decisions] : [];
    if (req.body?.skillDecision) decisions.push({ targetKind: 'skill', targetId: candidate.candidate_personal_skill_version_id, decision: req.body.skillDecision });
    for (const item of Array.isArray(req.body?.memoryDecisions) ? req.body.memoryDecisions : []) {
      decisions.push({ targetKind: 'memory_operation', targetId: item.operationId || item.targetId || '', decision: item.decision });
    }
    if (decisions.some((item) => String(item.targetKind || item.target_kind || '') === 'skill')) {
      throw apiError('personal_version_activation_required', 'Use the personal version activation endpoint to change the active Skill.', 409);
    }
    const result = await decidePostgresPersonalRun(pool, { userId: req.evolutionGrant.userId, runId: req.params.runId,
      decisions, actorDeviceId: req.evolutionGrant.deviceId, keyring: evolutionKeyringFromEnv(env) });
    res.status(result.status === 'conflict' ? 409 : 200).json(result);
  }));

  app.get('/v1/evolution/personal/versions', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError);
    const { rows } = await pool.query(`SELECT * FROM cloud_personal_skill_overlay_versions WHERE user_id = $1 AND user_agent_instance_id = $2
      ORDER BY created_at DESC`, [req.evolutionGrant.userId, instanceId]);
    const keyring = evolutionKeyringFromEnv(env);
    res.json({ authority: 'cloud', items: rows.map((row) => versionPayload(row, keyring)) });
  }));

  app.post('/v1/evolution/personal/versions/:versionId/activate', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    const result = await changePostgresPersonalVersion(pool, {
      userId: req.evolutionGrant.userId,
      deviceId: req.evolutionGrant.deviceId,
      agentInstanceId: instanceId,
      targetVersionId: String(req.params.versionId || ''),
      commandId: String(req.body?.commandId || ''),
      expectedActiveVersionId: req.body?.expectedActiveVersionId,
      action: 'activate', apiError,
    });
    res.status(result.status === 'conflict' ? 409 : 200).json(result);
  }));

  app.post('/v1/evolution/personal/rollback', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    const targetId = String(req.body?.targetVersionId || '');
    const memoryDocumentId = String(req.body?.memoryDocumentId || '');
    if (memoryDocumentId) {
      const result = await rollbackPostgresMemoryVersion(pool, { userId: req.evolutionGrant.userId, instanceId,
        memoryDocumentId, targetVersionId: String(req.body?.targetMemoryVersionId || targetId), apiError });
      res.json(result);
      return;
    }
    const result = await changePostgresPersonalVersion(pool, {
      userId: req.evolutionGrant.userId,
      deviceId: req.evolutionGrant.deviceId,
      agentInstanceId: instanceId,
      targetVersionId: targetId,
      commandId: String(req.body?.commandId || ''),
      expectedActiveVersionId: req.body?.expectedActiveVersionId,
      action: 'rollback', apiError,
    });
    res.status(result.status === 'conflict' ? 409 : 200).json(result);
  }));

  app.get('/v1/evolution/updates', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    res.json(await postgresEvolutionUpdates(pool, stage8, {
      userId: req.evolutionGrant.userId,
      keyring: evolutionKeyringFromEnv(env),
    }));
  }));

  app.post('/v1/evolution/performance/events', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const items = [];
    for (const item of Array.isArray(req.body?.items) ? req.body.items : []) {
      const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, item.agentInstanceId, apiError);
      const instance = (await pool.query('SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [req.evolutionGrant.userId, instanceId])).rows[0];
      items.push({ ...item, ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId, agentFamilyId: instance.agent_family_id });
    }
    const result = await stage8.recordPerformanceEvents(items);
    const levels = [];
    for (const agentInstanceId of new Set(items.map((item) => item.agentInstanceId))) levels.push(await stage8.calculatePerformance({ agentInstanceId }));
    res.json({ ...result, levels });
  }));
  app.get('/v1/evolution/performance/:instanceId', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', item: await stage8.performance({ agentInstanceId: instanceId }) });
  }));
  app.get('/v1/evolution/performance/:instanceId/history', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', items: await stage8.performanceHistory({ agentInstanceId: instanceId, limit: req.query.limit || 30 }) });
  }));
  app.post('/v1/evolution/performance/:instanceId', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', item: await stage8.calculatePerformance({ agentInstanceId: instanceId }) });
  }));
  app.post('/v1/evolution/leadership/events', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const items = [];
    for (const item of Array.isArray(req.body?.items) ? req.body.items : []) {
      const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, item.agentInstanceId, apiError);
      const instance = (await pool.query('SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [req.evolutionGrant.userId, instanceId])).rows[0];
      items.push({ ...item, ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId, agentFamilyId: instance.agent_family_id });
    }
    res.json(await leadership.recordEvents(items));
  }));
  app.post('/v1/evolution/leadership/evaluations', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    const evaluation = await leadership.evaluateTask({ ...req.body, governanceReview: undefined, trustedGovernanceReview: false,
      ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId });
    const level = await leadership.calculate({ agentInstanceId: instanceId });
    res.json({ authority: 'cloud', evaluation, level });
  }));
  app.get('/v1/evolution/leadership/actions', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const actor = await leadershipActor(pool, req.evolutionGrant.userId);
    const instanceId = req.query.agentInstanceId ? await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError) : '';
    res.json({ authority: 'cloud', items: await leadership.actions({ ownerUserId: req.evolutionGrant.userId, actorRole: actor.role,
      agentInstanceId: instanceId, status: req.query.status || '', limit: req.query.limit || 50 }) });
  }));
  app.post('/v1/evolution/leadership/trials', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    res.json(await leadership.requestTrial({ ...req.body, ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId }));
  }));
  app.post('/v1/evolution/leadership/actions/:actionId/decisions', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const actor = await requireLeadershipGovernanceActor(pool, req.evolutionGrant.userId, apiError);
    res.json(await leadership.decideAction({ ...req.body, actorUserId: actor.id, actorRole: actor.role, actionId: req.params.actionId }));
  }));
  app.post('/v1/evolution/leadership/:instanceId/restore', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json(await leadership.restore({ ...req.body, ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId }));
  }));
  app.get('/v1/evolution/leadership/appeals', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const actor = await leadershipActor(pool, req.evolutionGrant.userId);
    const instanceId = req.query.agentInstanceId ? await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError) : '';
    res.json({ authority: 'cloud', items: await leadership.appeals({ ownerUserId: req.evolutionGrant.userId, actorRole: actor.role,
      agentInstanceId: instanceId, status: req.query.status || '', limit: req.query.limit || 50 }) });
  }));
  app.post('/v1/evolution/leadership/appeals', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    res.json(await leadership.submitAppeal({ ...req.body, ownerUserId: req.evolutionGrant.userId, agentInstanceId: instanceId }));
  }));
  app.post('/v1/evolution/leadership/appeals/:appealId/decisions', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const actor = await requireLeadershipGovernanceActor(pool, req.evolutionGrant.userId, apiError);
    res.json(await leadership.decideAppeal({ ...req.body, actorUserId: actor.id, actorRole: actor.role, appealId: req.params.appealId }));
  }));
  app.get('/v1/evolution/leadership/:instanceId/history', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', items: await leadership.history({ agentInstanceId: instanceId, limit: req.query.limit || 30 }) });
  }));
  app.get('/v1/evolution/leadership/:instanceId', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', item: await leadership.status({ agentInstanceId: instanceId }) || await leadership.calculate({ agentInstanceId: instanceId }) });
  }));
  app.post('/v1/evolution/leadership/:instanceId', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', item: await leadership.calculate({ agentInstanceId: instanceId }) });
  }));
  app.get('/v1/evolution/cluster/status', routeWithGrant(pool, apiError, 'evolution:read', async (_req, res) => res.json(stage8.capabilities().cluster)));
  app.get('/v1/evolution/cluster/cohorts', routeWithGrant(pool, apiError, 'evolution:read', async (_req, res) => {
    const items = await stage8.cohorts({ includeIneligible: _req.query.includeIneligible === '1' });
    res.json({ authority: 'cloud', items: items.map((item) => ({ id: item.id, cohortKey: item.cohortKey || '', identityVersion: item.identityVersion || '', type: item.type, familyId: item.familyId || '', departmentId: item.departmentId || '', capabilityTags: item.capabilityTags || [], userCount: item.userCount || 0, evidenceCount: item.evidenceCount || 0, newEvidenceCount: item.newEvidenceCount || 0, reconsiderableEvidenceCount: item.reconsiderableEvidenceCount || 0, evidenceBreakdown: item.evidenceBreakdown || {}, evidenceThresholds: item.evidenceThresholds || {}, fallbackReason: item.fallbackReason || '', eligibilityReasons: item.eligibilityReasons || [], eligible: Boolean(item.eligible), status: item.status })) });
  }));
  app.get('/v1/evolution/cluster/runs', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const rows = (await pool.query("SELECT * FROM cloud_evolution_runs WHERE evolution_scope='cluster' ORDER BY created_at DESC LIMIT $1", [Math.min(100, Number(req.query.limit || 30))])).rows;
    res.json({ authority: 'cloud', items: rows.map(runPayload) });
  }));
  app.post('/v1/evolution/cluster/*path', routeWithGrant(pool, apiError, 'evolution:write', async () => { throw apiError('cluster_run_admin_only', 'Cluster mutation is performed only by the cloud scheduler.', 403); }));
  app.get('/v1/evolution/market/status', routeWithGrant(pool, apiError, 'evolution:read', async (_req, res) => res.json(stage8.capabilities().market)));
  app.get('/v1/evolution/market/candidates', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => res.json({ authority: 'cloud', items: await stage8.candidates({ familyId: req.query.familyId || '' }) })));
  app.get('/v1/evolution/market/versions', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const agentInstanceId = req.query.agentInstanceId ? await requireOwnedInstance(pool, req.evolutionGrant.userId, req.query.agentInstanceId, apiError) : '';
    res.json({ authority: 'cloud', items: await stage8.marketVersions({ familyId: req.query.familyId || '', userId: req.evolutionGrant.userId, agentInstanceId }) });
  }));
  app.get('/v1/evolution/market/canary', routeWithGrant(pool, apiError, 'evolution:read', async (req,res)=>{
    const agentInstanceId=await requireOwnedInstance(pool,req.evolutionGrant.userId,req.query.agentInstanceId,apiError);
    res.json(await stage8.canaryStatus({userId:req.evolutionGrant.userId,agentInstanceId}));
  }));
  app.post('/v1/evolution/market/canary/opt-in', routeWithGrant(pool, apiError, 'evolution:write', async (req,res)=>{
    const agentInstanceId=await requireOwnedInstance(pool,req.evolutionGrant.userId,req.body?.agentInstanceId,apiError);
    res.json(await stage8.setCanaryOptIn({userId:req.evolutionGrant.userId,agentInstanceId,
      enabled:req.body?.enabled!==false,commandId:req.body?.commandId||''}));
  }));
  app.post('/v1/evolution/market/adoptions', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const agentInstanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    res.json(await stage8.adopt({ ...req.body, userId: req.evolutionGrant.userId, agentInstanceId, action: 'adopt' }));
  }));
  app.post('/v1/evolution/market/adoptions/rollback', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const agentInstanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    res.json(await stage8.adopt({ ...req.body, userId: req.evolutionGrant.userId, agentInstanceId, action: 'rollback' }));
  }));
  app.post('/v1/evolution/market/adoptions/ignore', routeWithGrant(pool, apiError, 'evolution:write', async (req, res) => {
    const agentInstanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.body?.agentInstanceId, apiError);
    res.json(await stage8.adopt({ ...req.body, userId: req.evolutionGrant.userId, agentInstanceId, action: 'ignore' }));
  }));
  app.get('/v1/evolution/market/effective-skill/:instanceId', routeWithGrant(pool, apiError, 'evolution:read', async (req, res) => {
    const instanceId = await requireOwnedInstance(pool, req.evolutionGrant.userId, req.params.instanceId, apiError);
    res.json({ authority: 'cloud', item: await stage8.effectiveSkill({ userId: req.evolutionGrant.userId, agentInstanceId: instanceId }) });
  }));
}

export function evolutionCapabilities(env = process.env) {
  const keyring = evolutionKeyringFromEnv(env);
  const databaseAvailable = true;
  const encryptionAvailable = evolutionEnvelopeCapability(evolutionEnvelopePublicKeyringFromEnv(env)).available
    || evolutionEncryptionReady(keyring) || Boolean(keyring.allowPlaintextTestOnly);
  const modelAvailable = evolutionModelProviderStatus({ env }).available || evolutionModelDelegatedToWorker(env);
  const available = databaseAvailable && modelAvailable && encryptionAvailable;
  return {
    authority: 'cloud',
    authorityLocked: true,
    enabled: true,
    taskMemoryEncryption: cloudTaskMemoryEnvelopeCapability(cloudTaskMemoryPublicKeyringFromEnv(env)),
    evidenceEnvelope: evolutionEnvelopeCapability(evolutionEnvelopePublicKeyringFromEnv(env)),
    personal: { authority: 'cloud', authorityLocked: true, enabled: true, mutationEnabled: available, executionAvailable: available,
      readiness: { database: databaseAvailable, model: modelAvailable, encryption: encryptionAvailable },
      evaluationIntervalMs: PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS, retryIntervalMs: PERSONAL_EVOLUTION_RETRY_INTERVAL_MS,
      algorithmVersion: PERSONAL_EVOLUTION_ALGORITHM_VERSION,
      minimumEvidence: PERSONAL_MINIMUM_EVIDENCE, maximumEvidence: PERSONAL_MAXIMUM_EVIDENCE,
      code: available ? 'ok' : !databaseAvailable ? 'evolution_database_unavailable'
        : !encryptionAvailable ? 'evolution_encryption_key_unavailable' : 'evolution_model_unavailable' },
    cluster: disabledEvolutionCapability('cluster'),
    market: { ...disabledEvolutionCapability('market'), queryAvailable: databaseAvailable,
      adoptionAvailable: databaseAvailable, rollbackAvailable: databaseAvailable },
  };
}

async function ingestEvidence(pool, grant, items, env = process.env) {
  const keyring = evolutionKeyringFromEnv(env);
  const envelopeAvailable=evolutionEnvelopeCapability(evolutionEnvelopePublicKeyringFromEnv(env)).available;
  if (!envelopeAvailable&&!evolutionEncryptionReady(keyring) && !keyring.allowPlaintextTestOnly) throw simpleApiError('evolution_encryption_key_unavailable', 'Evolution evidence encryption is not configured.', 503);
  const accepted = [];
  const duplicates = [];
  const quarantined = [];
  const rejected = [];
  const results = [];
  for (const input of Array.isArray(items) ? items.slice(0, 500) : []) {
    const clientRecordId = String(input?.clientRecordId || input?.client_record_id || '').trim();
    let client = null;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const instanceId = await requireOwnedInstance(client, grant.userId, input.userAgentInstanceId || input.user_agent_instance_id, simpleApiError);
      const instanceResult = await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = $1 AND id = $2', [grant.userId, instanceId]);
      const instance = instanceResult.rows[0];
      const occurredAt = new Date(input.occurredAt || input.occurred_at || Date.now());
      const inactiveCutoff = instance.deactivated_at ? new Date(instance.deactivated_at) : null;
      const historicalInactive = instance.status === 'inactive' && inactiveCutoff && occurredAt <= inactiveCutoff;
      if ((!historicalInactive && instance.status !== 'active') || !instance.sync_enabled) throw simpleApiError('evolution_evidence_not_allowed', 'Agent is not active and synchronized, and the Evidence is not eligible inactive history.', 409);
      const sourceKind = normalizeEvolutionEvidenceSourceKind(input.sourceKind || input.source_kind);
      const requestedScopes = new Set((Array.isArray(input.allowedEvolutionScopes) ? input.allowedEvolutionScopes : []).map(String));
      let allowedEvolutionScopes = [
        requestedScopes.has('personal') && instance.personal_evolution_consent ? 'personal' : '',
        requestedScopes.has('cluster') || evolutionEvidenceClusterScopeAutomatic(sourceKind) ? 'cluster' : '',
      ].filter(Boolean);
      if (historicalInactive) allowedEvolutionScopes = [];
      if (!historicalInactive && !allowedEvolutionScopes.length) throw simpleApiError('evolution_evidence_not_allowed', 'No authorized evolution scope is available for this evidence.', 403);
      const evolutionEnvelope=normalizeEvolutionEnvelope(input.evolutionEnvelope||input.evolution_envelope);
      if(env.NODE_ENV==='production'&&!evolutionEnvelope)throw simpleApiError('evolution_envelope_required',
        'Production evolution Evidence must use the Evolution Worker public-key envelope.',400);
      const content = evolutionEnvelope?'':await resolveEvidenceContent(client, grant.userId, input, env);
      if (!evolutionEnvelope&&(!content.trim() || Buffer.byteLength(content, 'utf8') > 128 * 1024)) throw simpleApiError('evidence_content_invalid', 'Evolution evidence content is empty or too large.', 400);
      const contentHash = String(input.contentHash || input.content_hash || (content?sha256(content):''));
      if (!contentHash||(!evolutionEnvelope&&sha256(content) !== contentHash)) throw simpleApiError('evidence_hash_mismatch', 'Evidence hash is invalid.', 400);
      const identity = normalizeEvolutionEvidenceIdentity({ ownerUserId: grant.userId, userAgentInstanceId: instanceId, sourceKind,
        sourceId: input.sourceId || input.source_id, sourceVersionId: input.sourceVersionId || input.source_version_id || '', contentHash });
      const evidenceId = stableEvolutionEvidenceId(identity);
      if (input.evidenceId && input.evidenceId !== evidenceId) throw simpleApiError('evidence_id_mismatch', 'Evidence ID is not canonical.', 400);
      const encrypted = evolutionEnvelope||encryptEvolutionPayload(content, keyring);
      const quarantineReason = evolutionEnvelope?'':evidenceQuarantineReason(content, input.quarantineReason || input.quarantine_reason || '');
      const sourceValidationScopes = historicalInactive ? ['cluster'] : allowedEvolutionScopes;
      if (clientRecordId || taskEvidenceSourceKind(identity.sourceKind)) {
        allowedEvolutionScopes = await validateAuthoritativeEvidenceSource(
          client, grant.userId, instanceId, identity, sourceValidationScopes,
          { requireTaskEvent: Boolean(clientRecordId) },
        );
      } else if (['memory_version', 'task_shared_summary'].includes(identity.sourceKind)) {
        allowedEvolutionScopes = await validateMemoryEvidence(client, grant.userId, instanceId, identity, sourceValidationScopes);
      }
      if (historicalInactive) allowedEvolutionScopes = [];
      const existingEvidence = (await client.query('SELECT evidence_id FROM cloud_evolution_evidence WHERE evidence_id=$1', [evidenceId])).rows[0];
      const inserted = existingEvidence ? { rows: [] } : await client.query(`INSERT INTO cloud_evolution_evidence (
        evidence_id, owner_user_id, user_agent_instance_id, agent_family_id, source_kind, source_id, source_version_id,
        context_space_id, task_id, delegation_id, content_hash, content_ciphertext, content_nonce, content_tag,
        encryption_algorithm, key_id, confidence, privacy_level, quarantine_reason, occurred_at, metadata_json,
        personal_threshold_eligible,eligibility_policy_version,lineage_key,validation_status,validation_policy_version,
        validation_json,validated_at,historical_inactive,wrapped_data_key,key_wrap_algorithm,key_version,envelope_format
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24,$25,$26,$27::jsonb,$28,$29,$30,$31,$32,$33)
      ON CONFLICT(evidence_id) DO NOTHING RETURNING evidence_id`, [
        evidenceId, grant.userId, instanceId, instance.agent_family_id, identity.sourceKind, identity.sourceId,
        identity.sourceVersionId, input.contextSpaceId || '', input.taskId || '', input.delegationId || '', contentHash,
        encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId, validatedEvidenceConfidence(sourceKind,input),
        input.privacyLevel || 'owner_private', quarantineReason, occurredAt, JSON.stringify({ ...(input.metadata || {}), allowedEvolutionScopes,
          claimedConfidence:Number(input.confidence ?? 1),historicalInactive,uploadedByDeviceId: grant.deviceId, sourceAuthority: clientRecordId ? 'authoritative' : 'legacy_compat' }),
        personalEvolutionThresholdEligible(sourceKind), PERSONAL_THRESHOLD_ELIGIBILITY_POLICY_VERSION,
        String(input.lineageKey || input.lineage_key || input.metadata?.lineageKey || `${sourceKind}:${identity.sourceId}:${identity.sourceVersionId}`),
        quarantineReason?'quarantined':evolutionEnvelope?'pending_validation':'validated','cloud_evidence_validation_v1',JSON.stringify(evolutionEnvelope?{}:validatedEvidenceSummary(sourceKind,input)),
        quarantineReason||evolutionEnvelope?null:new Date(),historicalInactive,encrypted.wrappedDataKey||'',encrypted.keyWrapAlgorithm||'',Number(encrypted.keyVersion||0),encrypted.envelopeFormat||'legacy_symmetric',
      ]);
      if(evolutionEnvelope&&inserted.rows.length)await client.query(`INSERT INTO cloud_evolution_evidence_validation_jobs
        (evidence_id,status,available_at,created_at,updated_at) VALUES($1,'queued',now(),now(),now()) ON CONFLICT DO NOTHING`,[evidenceId]);
      if (!evolutionEnvelope&&!quarantineReason && allowedEvolutionScopes.includes('personal')) await createPostgresEvidenceUsageLedger(client)
        .ensureAvailable({ evidenceId, scope: 'personal', consumerId: instanceId });
      await client.query('COMMIT');
      client.release();
      client = null;
      if (!inserted.rows.length) {
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
      if (client) {
        try { await client.query('ROLLBACK'); } catch {}
        client.release();
      }
      rejected.push({ sourceId: input?.sourceId || '', code: error.code || 'evidence_rejected', message: error.message });
      results.push(evidenceIngestResult({ clientRecordId, input, status: error.retryable ? 'deferred' : 'rejected',
        code: error.code || 'evidence_rejected', message: error.message, retryable: Boolean(error.retryable) }));
    }
  }
  return { status: rejected.length || quarantined.length || results.some((item) => item.status === 'deferred') ? 'partial' : 'accepted',
    accepted, duplicates, quarantined, rejected, results };
}

function normalizeEvolutionEnvelope(value){
  if(!value)return null;
  if(value.algorithm!=='aes-256-gcm+rsa-oaep-sha256'||value.keyWrapAlgorithm!=='rsa-oaep-sha256'||!value.keyId
    ||!value.wrappedDataKey||!value.ciphertext||!value.nonce||!value.tag)throw simpleApiError('evolution_envelope_invalid','Evolution Evidence envelope is invalid.',400);
  return {algorithm:value.algorithm,keyId:String(value.keyId),keyVersion:Number(value.keyVersion||1),keyWrapAlgorithm:value.keyWrapAlgorithm,
    wrappedDataKey:String(value.wrappedDataKey),ciphertext:String(value.ciphertext),nonce:String(value.nonce),tag:String(value.tag),
    envelopeFormat:String(value.envelopeFormat||'evolution_envelope_v1')};
}

function validatedEvidenceConfidence(sourceKind,input={}) {
  const base=({task_acceptance:1,task_result:.95,task_rework:.9,task_failure:.9,task_blocked:.85,task_cancelled:.8,
    memory_version:.9,task_shared_summary:.95,model_execution:.9,model_execution_metric:.9,message:.8,
    conversation_segment:.9,collaboration_message:.8,delegation_event:.9,market_adoption:1,market_rejection:1,market_rollback:1})[sourceKind]??.75;
  return Math.min(base,Math.max(0,Number(input.confidence??1)));
}

function validatedEvidenceSummary(sourceKind,input={}) {
  const terminalTask=sourceKind.startsWith('task_')&&!['task_created','task_assigned','task_dependency_changed'].includes(sourceKind);
  return {policyVersion:'cloud_evidence_validation_v1',sourceVerified:true,taskRelevance:terminalTask?1:.8,
    acceptanceQuality:sourceKind==='task_acceptance'?1:sourceKind==='task_failure'?0.25:terminalTask?0.75:0.8,
    claimedConfidence:Number(input.confidence??1)};
}

async function resolveEvidenceContent(pool, userId, input = {}, env = process.env) {
  if (!input.encryptedContent && !input.encrypted_content) return String(input.content || '');
  const encrypted = input.encryptedContent || input.encrypted_content;
  const taskRunId = String(input.taskId || input.task_id || '');
  if ((input.sourceKind || input.source_kind) !== 'memory_version' || !taskRunId) {
    throw simpleApiError('encrypted_evidence_source_invalid', 'Encrypted evidence must be a task Memory version.', 400);
  }
  const context = (await pool.query(`SELECT * FROM cloud_task_security_contexts_v5
    WHERE user_id=$1 AND task_run_id=$2`, [userId, taskRunId])).rows[0];
  if (!context || !context.cloud_evolution_allowed || context.cloud_envelope_state !== 'active' || context.status !== 'active') {
    throw simpleApiError('task_cloud_evolution_not_allowed', 'Task cloud evolution authorization is inactive.', 403);
  }
  const payload = context.payload_json || {};
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

async function requestPersonalRun(pool, grant, payload, apiError, env = process.env) {
  const capability = evolutionCapabilities(env).personal;
  if (!capability.executionAvailable) return { status: 'unavailable', authority: 'cloud', code: capability.code };
  return queuePostgresPersonalEvolutionRun(pool, { userId: grant.userId, agentInstanceId: payload.agentInstanceId,
    triggerKind: payload.triggerKind || payload.trigger || 'manual', force: payload.force, keyring:evolutionKeyringFromEnv(env) });
}

function routeWithGrant(pool, apiError, scope, handler) {
  return routeWithDeviceGrant(pool, apiError, scope, handler, { property: 'evolutionGrant' });
}

export { routeWithGrant as routeWithEvolutionGrant };

export async function requireOwnedInstance(pool, userId, value, apiError) {
  let instanceId = String(value || '').trim();
  const visited = new Set();
  while (instanceId) {
    if (visited.has(instanceId)) break;
    visited.add(instanceId);
    const alias = (await pool.query(`SELECT canonical_instance_id FROM cloud_user_agent_instance_aliases_v3
      WHERE user_id=$1 AND alias_instance_id=$2`, [userId, instanceId])).rows[0];
    if (alias?.canonical_instance_id) {
      instanceId = String(alias.canonical_instance_id).trim();
      continue;
    }
    const instance = (await pool.query(`SELECT id FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND id=$2`, [userId, instanceId])).rows[0];
    if (instance) return instance.id;
    break;
  }
  throw apiError('agent_instance_not_found', 'Agent instance does not belong to this user.', 404);
}

async function validateMemoryEvidence(pool, userId, instanceId, evidence, allowedEvolutionScopes = []) {
  const document = (await pool.query(`SELECT * FROM cloud_memory_documents_v3
    WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3`, [userId, evidence.sourceId, instanceId])).rows[0];
  const personalAllowed = allowedEvolutionScopes.includes('personal') && document?.allow_personal_evolution;
  const clusterAllowed = allowedEvolutionScopes.includes('cluster');
  if (!document || !document.sync_enabled || (!personalAllowed && !clusterAllowed)) {
    throw simpleApiError('memory_evolution_not_allowed', 'Memory document is not authorized for the requested evolution scopes.', 403);
  }
  const version = (await pool.query(`SELECT * FROM cloud_memory_document_versions_v3
    WHERE user_id=$1 AND memory_document_id=$2 AND id=$3`, [userId, document.id, evidence.sourceVersionId])).rows[0];
  if (!version) throw simpleApiError('memory_version_not_found', 'Memory evidence version does not belong to the authorized document.', 404);
  if (evidence.sourceKind === 'task_shared_summary') {
    const payload = version.payload_json || {};
    if (document.scope !== 'task' || !document.task_run_id || String(payload.visibility || document.visibility || '') !== 'work_summary') {
      throw simpleApiError('task_shared_summary_invalid', 'Task shared summary Evidence must reference a task-scoped work_summary version.', 403);
    }
    const task=(await pool.query('SELECT * FROM cloud_task_runs WHERE id=$1',[document.task_run_id])).rows[0];
    if(!task)throw retryableEvidenceError('evidence_source_not_ready','Task shared summary task has not synchronized yet.');
    if(task.owner_user_id!==userId)throw simpleApiError('evidence_source_identity_mismatch','Task shared summary task does not belong to this user.',403);
    const member=(await pool.query(`SELECT 1 FROM cloud_task_nodes WHERE task_run_id=$1
      AND (user_agent_instance_id=$2 OR payload_json->>'agentInstanceId'=$2 OR payload_json->>'agent_instance_id'=$2) LIMIT 1`,
    [document.task_run_id,instanceId])).rows[0];
    if(!member&&evidencePayloadAgentInstance(task.payload_json||{})!==instanceId) {
      throw simpleApiError('evidence_source_identity_mismatch','Task shared summary Agent is not a task participant.',403);
    }
  }
  return [personalAllowed ? 'personal' : '', clusterAllowed ? 'cluster' : ''].filter(Boolean);
}

async function validateAuthoritativeEvidenceSource(pool, userId, instanceId, evidence, allowedEvolutionScopes = [], { requireTaskEvent = false } = {}) {
  if (['memory_version', 'task_shared_summary'].includes(evidence.sourceKind)) {
    const document = (await pool.query('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2', [userId, evidence.sourceId])).rows[0];
    if (!document) {
      const foreignDocument = (await pool.query('SELECT user_id FROM cloud_memory_documents_v3 WHERE id=$1 LIMIT 1', [evidence.sourceId])).rows[0];
      if (foreignDocument) throw simpleApiError('evidence_source_identity_mismatch', 'Memory document does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Memory document source has not synchronized yet.');
    }
    if (document.user_agent_instance_id !== instanceId) {
      throw simpleApiError('evidence_source_identity_mismatch', 'Memory document does not belong to this Agent instance.', 403);
    }
    const version = (await pool.query('SELECT * FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND id=$2', [userId, evidence.sourceVersionId])).rows[0];
    if (!version) {
      const foreignVersion = (await pool.query('SELECT user_id FROM cloud_memory_document_versions_v3 WHERE id=$1 LIMIT 1', [evidence.sourceVersionId])).rows[0];
      if (foreignVersion) throw simpleApiError('evidence_source_identity_mismatch', 'Memory version does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Memory version source has not synchronized yet.');
    }
    if (version.memory_document_id !== evidence.sourceId) {
      throw simpleApiError('evidence_source_identity_mismatch', 'Memory version does not belong to the referenced document.', 403);
    }
    if (version.content_hash && version.content_hash !== evidence.contentHash) {
      throw simpleApiError('evidence_source_hash_mismatch', 'Memory Evidence content hash does not match the synchronized version.', 403);
    }
    return validateMemoryEvidence(pool, userId, instanceId, evidence, allowedEvolutionScopes);
  }
  if (['message', 'conversation_segment'].includes(evidence.sourceKind)) {
    const source = (await pool.query('SELECT payload_json FROM cloud_messages_v6 WHERE user_id=$1 AND id=$2', [userId, evidence.sourceId])).rows[0];
    if (!source) {
      const foreignSource = (await pool.query('SELECT user_id FROM cloud_messages_v6 WHERE id=$1 LIMIT 1', [evidence.sourceId])).rows[0];
      if (foreignSource) throw simpleApiError('evidence_source_identity_mismatch', 'Message source does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Message source has not synchronized yet.');
    }
    if (evidencePayloadAgentInstance(source.payload_json || {}) !== instanceId) throw simpleApiError('evidence_source_identity_mismatch', 'Message source does not belong to this Agent instance.', 403);
    return allowedEvolutionScopes;
  }
  if (evidence.sourceKind === 'collaboration_message') {
    const message=(await pool.query('SELECT * FROM collaboration_group_messages WHERE id=$1',[evidence.sourceId])).rows[0];
    if (!message) throw retryableEvidenceError('evidence_source_not_ready','Collaboration message source has not synchronized yet.');
    if (message.sender_user_id!==userId) throw simpleApiError('evidence_source_identity_mismatch','Collaboration message does not belong to this user.',403);
    const instance=(await pool.query('SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2',[userId,instanceId])).rows[0];
    if (instance?.agent_family_id!=='secretary_agent') throw simpleApiError('evidence_source_identity_mismatch','Collaboration message does not belong to this uBuddy instance.',403);
    const membership=(await pool.query('SELECT 1 FROM collaboration_group_members WHERE group_id=$1 AND user_id=$2',[message.group_id,userId])).rows[0];
    if (!membership) throw simpleApiError('evidence_source_identity_mismatch','Collaboration message sender was not a group member.',403);
    if (sha256(String(message.content || ''))!==evidence.contentHash) throw simpleApiError('evidence_source_hash_mismatch','Collaboration message Evidence hash is invalid.',403);
    return allowedEvolutionScopes;
  }
  if (evidence.sourceKind === 'delegation_event') {
    const revision=evidence.sourceVersionId?(await pool.query('SELECT * FROM agent_delegation_revisions WHERE id=$1',[evidence.sourceVersionId])).rows[0]:null;
    if (!revision) throw retryableEvidenceError('evidence_source_not_ready','Delegation event source has not synchronized yet.');
    const delegation=(await pool.query('SELECT * FROM agent_delegations WHERE id=$1',[evidence.sourceId])).rows[0];
    if (!delegation) throw retryableEvidenceError('evidence_source_not_ready','Delegation source has not synchronized yet.');
    const instance=(await pool.query('SELECT agent_family_id FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2',[userId,instanceId])).rows[0];
    if (revision.delegation_id!==delegation.id || revision.author_user_id!==userId || instance?.agent_family_id!=='secretary_agent'
      || ![delegation.requester_user_id,delegation.recipient_user_id].includes(userId)) {
      throw simpleApiError('evidence_source_identity_mismatch','Delegation event does not belong to this user and uBuddy instance.',403);
    }
    return allowedEvolutionScopes;
  }
  if (['model_execution', 'model_execution_metric'].includes(evidence.sourceKind)) {
    const source = (await pool.query('SELECT payload_json FROM cloud_model_executions_v6 WHERE user_id=$1 AND id=$2', [userId, evidence.sourceId])).rows[0];
    if (!source) {
      const foreignSource = (await pool.query('SELECT user_id FROM cloud_model_executions_v6 WHERE id=$1 LIMIT 1', [evidence.sourceId])).rows[0];
      if (foreignSource) throw simpleApiError('evidence_source_identity_mismatch', 'Model execution source does not belong to this user.', 403);
      throw retryableEvidenceError('evidence_source_not_ready', 'Model execution source has not synchronized yet.');
    }
    if (evidencePayloadAgentInstance(source.payload_json || {}) !== instanceId) throw simpleApiError('evidence_source_identity_mismatch', 'Model execution source does not belong to this Agent instance.', 403);
    return allowedEvolutionScopes;
  }
  if (taskEvidenceSourceKind(evidence.sourceKind)) {
    const nodeScoped=taskNodeScopedEvidenceSourceKind(evidence.sourceKind);
    const node=nodeScoped?(await pool.query('SELECT * FROM cloud_task_nodes WHERE id=$1',[evidence.sourceId])).rows[0]:null;
    if(nodeScoped&&!node)throw retryableEvidenceError('evidence_source_not_ready','Task node source has not synchronized yet.');
    if(nodeScoped&&String(node.user_agent_instance_id||evidencePayloadAgentInstance(node.payload_json||{}))!==instanceId) {
      throw simpleApiError('evidence_source_identity_mismatch', 'Task node source does not belong to this Agent instance.', 403);
    }
    const taskRunId=nodeScoped?node.task_run_id:evidence.sourceId;
    const task = (await pool.query('SELECT * FROM cloud_task_runs WHERE id=$1', [taskRunId])).rows[0];
    if (!task) throw retryableEvidenceError('evidence_source_not_ready', 'Task source has not synchronized yet.');
    if (task.owner_user_id !== userId) {
      throw simpleApiError('evidence_source_identity_mismatch', 'Task source does not belong to this user.', 403);
    }
    if(!nodeScoped&&evidencePayloadAgentInstance(task.payload_json||{})!==instanceId)throw simpleApiError('evidence_source_identity_mismatch','Task source does not belong to this Agent instance.',403);
    if (requireTaskEvent && !evidence.sourceVersionId) {
      throw simpleApiError('evidence_source_version_required', 'New task Evidence must reference its synchronized task event.', 400);
    }
    if (evidence.sourceVersionId) {
      const event = (await pool.query('SELECT * FROM cloud_task_events WHERE id=$1', [evidence.sourceVersionId])).rows[0];
      if (!event) throw retryableEvidenceError('evidence_source_not_ready', 'Task event source has not synchronized yet.');
      if (event.owner_user_id !== userId || event.task_run_id !== taskRunId) {
        throw simpleApiError('evidence_source_event_mismatch', 'Task event does not belong to the referenced user and task run.', 403);
      }
      if ((nodeScoped&&event.task_node_id !== evidence.sourceId) || taskEvidenceSourceKindForEvent(event.event_type) !== evidence.sourceKind) {
        throw simpleApiError('evidence_source_event_mismatch', 'Task event does not match the Evidence source kind.', 403);
      }
    }
    return allowedEvolutionScopes;
  }
  throw simpleApiError('evidence_source_not_supported', `Authoritative source validation is not available for ${evidence.sourceKind}.`, 400);
}

function evidencePayloadAgentInstance(payload = {}) { return String(payload.agentInstanceId||payload.agent_instance_id||payload.userAgentInstanceId||payload.user_agent_instance_id||payload.leadAgentInstanceId||payload.lead_agent_instance_id||''); }
function taskEvidenceSourceKind(sourceKind = '') { return ['task_created','task_assigned','task_revision','task_dependency_changed','task_result','task_acceptance','task_rework','task_failure','task_blocked','task_cancelled'].includes(sourceKind); }
function taskNodeScopedEvidenceSourceKind(sourceKind=''){return !['task_created','task_revision'].includes(sourceKind);}
function taskEvidenceSourceKindForEvent(eventType = '') { if(String(eventType||'').startsWith('graph_'))return 'task_revision';return ({task_created:'task_created',task_assigned:'task_assigned',task_dependency_changed:'task_dependency_changed',node_completed:'task_result',node_accepted:'task_acceptance',node_rework:'task_rework',node_failed:'task_failure',node_blocked:'task_blocked',node_cancelled:'task_cancelled'})[String(eventType || '')] || ''; }
function retryableEvidenceError(code, message) { const error = simpleApiError(code, message, 409); error.retryable = true; return error; }
function evidenceIngestResult({ clientRecordId='',evidenceId='',input={},status,code='',message='',retryable=false }={}) { return {
  clientRecordId,evidenceId,sourceKind:input.sourceKind||input.source_kind||'',sourceId:input.sourceId||input.source_id||'',
  sourceVersionId:input.sourceVersionId||input.source_version_id||'',status,code,message,retryable:Boolean(retryable),
}; }

function evidenceQuarantineReason(content, requestedReason = '') {
  if (requestedReason) return String(requestedReason).slice(0, 200);
  if (/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|私钥|密码|密钥)\s*[:=]/i.test(content)
    || /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/.test(content)) return 'credential_like_content';
  return '';
}

async function rollbackPostgresMemoryVersion(pool,{userId,instanceId,memoryDocumentId,targetVersionId,apiError}={}){
  return withTransaction(pool,async(client)=>{
    const document=(await client.query(`SELECT * FROM cloud_memory_documents_v3
      WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3 FOR UPDATE`,[userId,memoryDocumentId,instanceId])).rows[0];
    const target=(await client.query(`SELECT * FROM cloud_memory_document_versions_v3
      WHERE user_id=$1 AND id=$2 AND memory_document_id=$3`,[userId,targetVersionId,memoryDocumentId])).rows[0];
    if(!document||!target)throw apiError('memory_version_not_found','Memory rollback target does not belong to this Agent.',404);
    const payload=target.payload_json||{};const id=`memver_${crypto.randomUUID()}`;
    const versionNo=Number((await client.query(`SELECT COALESCE(MAX(version_no),0)+1 value FROM cloud_memory_document_versions_v3
      WHERE user_id=$1 AND memory_document_id=$2`,[userId,memoryDocumentId])).rows[0].value);
    const next={...payload,id,memoryDocumentId,versionNo,sourceKind:'cloud_personal_evolution_rollback',sourceId:targetVersionId,createdAt:new Date().toISOString()};
    await client.query(`INSERT INTO cloud_memory_document_versions_v3(user_id,id,memory_document_id,version_no,content_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[userId,id,memoryDocumentId,versionNo,target.content_hash,JSON.stringify(next)]);
    await client.query('UPDATE cloud_memory_documents_v3 SET current_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3',[id,userId,memoryDocumentId]);
    return{status:'rolled_back',authority:'cloud',memoryDocumentId,activeVersionId:id,sourceVersionId:targetVersionId};
  });
}

function runPayload(row) { return { id: row.id, scope: row.evolution_scope, authority: 'cloud', userId: row.owner_user_id,
  agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id, status: row.status,
  evidenceCount: Number(row.evidence_count || 0), algorithmVersion: row.algorithm_version,
  candidatePersonalSkillVersionId: row.candidate_personal_skill_version_id || '', summary: row.summary || '',
  errorCode: row.error_code || '', errorText: row.error_text || '', createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at }; }
function evidenceUsageListPayload(row) { return { evidenceId:row.evidence_id,sourceKind:row.source_kind,sourceId:row.source_id,
  sourceVersionId:row.source_version_id||'',contentHash:row.content_hash||'',scope:row.evolution_scope,consumerId:row.consumer_id,
  status:row.status,runId:row.run_id||'',algorithmVersion:row.algorithm_version||'',rejectionKind:row.rejection_kind||'',
  transitionReason:row.transition_reason||'',reEvaluationBasisHash:row.re_evaluation_basis_hash||'',
  personalThresholdEligible:Boolean(row.personal_threshold_eligible),eligibilityPolicyVersion:row.eligibility_policy_version||'',reservedAt:iso(row.reserved_at),
  leaseExpiresAt:iso(row.lease_expires_at),terminalAt:iso(row.terminal_at),occurredAt:iso(row.occurred_at),updatedAt:iso(row.updated_at) }; }
function encodeUsageCursor(row={}) { return Buffer.from(JSON.stringify({updatedAt:iso(row.updated_at||row.updatedAt),evidenceId:row.evidence_id||row.evidenceId||''})).toString('base64url'); }
function decodeUsageCursor(value='') { if(!value)return {};try{return JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'))||{};}catch{return {};} }
async function readPostgresEvolutionPreference(pool, userId = '') {
  const row = (await pool.query('SELECT * FROM cloud_user_evolution_preferences WHERE user_id=$1', [userId])).rows[0];
  return preferencePayload(row || { user_id: userId, enabled: true, policy_version: 'evolution_mandatory_upload_v1', state_revision: 1 });
}

async function updatePostgresEvolutionPreference(pool, {
  userId = '', deviceId = '', enabled = true, commandId = '', expectedStateRevision, apiError,
} = {}) {
  if (enabled === false) {
    throw apiError('evolution_preference_managed', 'Registered accounts must keep evolution evidence upload enabled.', 409);
  }
  if (!commandId) throw apiError('evolution_preference_command_required', 'Evolution preference commandId is required.', 400);
  if (expectedStateRevision === undefined || !Number.isFinite(Number(expectedStateRevision))) {
    throw apiError('evolution_preference_revision_required', 'Evolution preference expectedStateRevision is required.', 400);
  }
  return withTransaction(pool, async (client) => {
    await client.query(`INSERT INTO cloud_user_evolution_preferences(user_id,enabled,policy_version)
      VALUES($1,true,'evolution_mandatory_upload_v1') ON CONFLICT(user_id) DO NOTHING`, [userId]);
    const current = (await client.query('SELECT * FROM cloud_user_evolution_preferences WHERE user_id=$1 FOR UPDATE', [userId])).rows[0];
    if (current.last_command_id === commandId) return { ...preferencePayload(current), status: 'confirmed', idempotent: true };
    if (Number(current.state_revision) !== Number(expectedStateRevision)) {
      return { ...preferencePayload(current), status: 'conflict', code: 'evolution_preference_conflict' };
    }
    const next = (await client.query(`UPDATE cloud_user_evolution_preferences SET enabled=true,
      policy_version='evolution_mandatory_upload_v1',state_revision=state_revision+1,last_command_id=$1,
      paused_at=NULL,updated_at=now() WHERE user_id=$2 RETURNING *`, [commandId, userId])).rows[0];
    await client.query(`UPDATE cloud_user_agent_instances_v3 SET
      personal_evolution_consent=(sync_enabled AND status='active'),
      cluster_contribution_consent=(sync_enabled AND status='active'),personal_skill_auto_activate=false,updated_at=now()
      WHERE user_id=$1`, [userId]);
    await client.query(`UPDATE cloud_memory_documents_v3 d SET
      allow_personal_evolution=(i.sync_enabled AND i.status='active' AND d.lifecycle_state='active'),
      allow_cluster_evolution=(i.sync_enabled AND i.status='active' AND d.lifecycle_state='active'),updated_at=now()
      FROM cloud_user_agent_instances_v3 i WHERE d.user_id=$1 AND i.user_id=d.user_id AND i.id=d.user_agent_instance_id`, [userId]);
    return { ...preferencePayload(next), status: 'confirmed', actorDeviceId: deviceId };
  });
}

async function changePostgresPersonalVersion(pool, {
  userId = '', deviceId = '', agentInstanceId = '', targetVersionId = '', commandId = '',
  expectedActiveVersionId, action = 'activate', apiError,
} = {}) {
  if (!commandId) throw apiError('personal_version_command_required', 'Personal version commandId is required.', 400);
  if (expectedActiveVersionId === undefined) throw apiError('personal_version_revision_required', 'expectedActiveVersionId is required.', 400);
  if (!['activate', 'rollback'].includes(action)) throw apiError('personal_version_action_invalid', 'Personal version action is invalid.', 400);
  return withTransaction(pool, async (client) => {
    const existing = (await client.query('SELECT * FROM cloud_personal_version_commands WHERE user_id=$1 AND command_id=$2', [userId, commandId])).rows[0];
    if (existing) return { ...(existing.payload_json || {}), idempotent: true };
    const instance = (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, agentInstanceId])).rows[0];
    if (!instance) throw apiError('agent_instance_not_found', 'Agent instance does not belong to this user.', 404);
    const previousId = String(instance.active_personal_skill_version_id || '');
    if (previousId !== String(expectedActiveVersionId || '')) {
      const result = { authority: 'cloud', status: 'conflict', code: 'personal_version_conflict', activeVersionId: previousId };
      await insertPostgresPersonalVersionCommand(client, { userId, commandId, agentInstanceId, action, targetVersionId,
        expectedActiveVersionId: String(expectedActiveVersionId || ''), previousId, resultId: previousId,
        deviceId, status: 'rejected', errorCode: result.code, result });
      return result;
    }
    let resolvedTargetId = String(targetVersionId || '');
    const previous = previousId ? (await client.query(`SELECT * FROM cloud_personal_skill_overlay_versions
      WHERE user_id=$1 AND user_agent_instance_id=$2 AND id=$3`, [userId, agentInstanceId, previousId])).rows[0] : null;
    if (action === 'activate' && !resolvedTargetId) throw apiError('personal_version_target_required', 'A personal version is required for activation.', 400);
    const target = resolvedTargetId ? (await client.query(`SELECT * FROM cloud_personal_skill_overlay_versions
      WHERE user_id=$1 AND user_agent_instance_id=$2 AND id=$3`, [userId, agentInstanceId, resolvedTargetId])).rows[0] : null;
    if (resolvedTargetId && (!target || target.stability_status !== 'stable' || target.status === 'rejected')) {
      throw apiError('personal_version_not_found', 'Stable personal version does not belong to this Agent.', 404);
    }
    if (previousId !== resolvedTargetId) {
      await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='archived',archived_at=now() WHERE user_id=$1 AND user_agent_instance_id=$2 AND status='active'", [userId, agentInstanceId]);
      if (target) await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='active',stability_status='stable',activated_at=now(),archived_at=NULL WHERE user_id=$1 AND id=$2", [userId, target.id]);
      await client.query('UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [resolvedTargetId, userId, agentInstanceId]);
    }
    if (target?.source_run_id) {
      await client.query(`INSERT INTO cloud_evolution_apply_journals
        (id,run_id,user_agent_instance_id,previous_skill_version_id,next_skill_version_id,status,error_text,completed_at)
        VALUES($1,$2,$3,$4,$5,'completed',$6,now())`, [`evapply_${crypto.randomUUID()}`, target.source_run_id,
        agentInstanceId, previousId, resolvedTargetId, action === 'rollback' ? 'manual_skill_rollback' : 'manual_skill_activate']);
      const proposalRow = (await client.query('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, target.source_run_id])).rows[0];
      if (proposalRow) {
        const pendingMemory = Number((await client.query(`SELECT COUNT(*)::int count FROM cloud_personal_evolution_memory_operations_v4
          WHERE user_id=$1 AND proposal_id=$2 AND status='pending'`, [userId, target.source_run_id])).rows[0]?.count || 0);
        const proposal = { ...(proposalRow.payload_json || {}), status: pendingMemory ? 'partially_applied' : 'applied',
          decision: 'accepted', skillActionStatus: 'activated', decidedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await client.query('UPDATE cloud_personal_evolution_proposals_v4 SET status=$1,payload_json=$2::jsonb,updated_at=now() WHERE user_id=$3 AND id=$4',
          [proposal.status, JSON.stringify(proposal), userId, target.source_run_id]);
        const actionPayload = { id: `peaction_${crypto.randomUUID()}`, proposalId: target.source_run_id, targetKind: 'skill',
          targetId: target.id, decision: 'accept', revision: 1, actorDeviceId: deviceId, automatic: false, receivedAt: new Date().toISOString() };
        await client.query(`INSERT INTO cloud_personal_evolution_actions_v4
          (user_id,id,proposal_id,target_kind,target_id,decision,revision,actor_device_id,payload_json,received_at)
          VALUES($1,$2,$3,'skill',$4,'accept',1,$5,$6::jsonb,$7) ON CONFLICT(user_id,proposal_id,target_kind,target_id) DO NOTHING`,
        [userId, actionPayload.id, target.source_run_id, target.id, deviceId, JSON.stringify(actionPayload), actionPayload.receivedAt]);
        await client.query("UPDATE cloud_evolution_runs SET status='applied',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1 AND status IN ('available','proposed','applied','rolled_back')", [target.source_run_id]);
      }
    }
    if (action === 'rollback' && previous?.source_run_id && previous.source_run_id !== target?.source_run_id) {
      await client.query("UPDATE cloud_evolution_runs SET status='rolled_back',updated_at=now() WHERE id=$1 AND status='applied'", [previous.source_run_id]);
    }
    const result = { authority: 'cloud', status: action === 'rollback' ? 'rolled_back' : 'activated',
      agentInstanceId, previousActiveVersionId: previousId, activeVersionId: resolvedTargetId, targetVersionId: resolvedTargetId };
    await insertPostgresPersonalVersionCommand(client, { userId, commandId, agentInstanceId, action,
      targetVersionId: resolvedTargetId, expectedActiveVersionId: String(expectedActiveVersionId || ''), previousId,
      resultId: resolvedTargetId, deviceId, status: 'confirmed', result });
    return result;
  });
}

async function insertPostgresPersonalVersionCommand(client, { userId, commandId, agentInstanceId, action,
  targetVersionId = '', expectedActiveVersionId = '', previousId = '', resultId = '', deviceId = '',
  status = 'confirmed', errorCode = '', result = {} } = {}) {
  await client.query(`INSERT INTO cloud_personal_version_commands
    (user_id,command_id,user_agent_instance_id,action,target_version_id,expected_active_version_id,
     previous_active_version_id,result_active_version_id,actor_device_id,status,error_code,payload_json,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now())`, [userId, commandId, agentInstanceId,
    action, targetVersionId, expectedActiveVersionId, previousId, resultId, deviceId, status, errorCode, JSON.stringify(result)]);
}

async function postgresEvolutionUpdates(pool, stage8, { userId = '', keyring } = {}) {
  const preference = await readPostgresEvolutionPreference(pool, userId);
  const instances = (await pool.query(`SELECT i.*,f.name family_name FROM cloud_user_agent_instances_v3 i
    LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id WHERE i.user_id=$1 ORDER BY i.created_at,i.id`, [userId])).rows;
  const personal = [];
  for (const instance of instances) {
    const versions = (await pool.query(`SELECT * FROM cloud_personal_skill_overlay_versions
      WHERE user_id=$1 AND user_agent_instance_id=$2 ORDER BY created_at DESC`, [userId, instance.id])).rows;
    const available = versions.filter((row) => row.status === 'candidate' && row.stability_status === 'stable');
    personal.push({ agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id, agentName: instance.family_name || instance.agent_family_id,
      currentVersionId: instance.active_personal_skill_version_id || '', availableCount: available.length,
      latestAvailableVersion: available[0] ? versionMetadataPayload(available[0]) : null,
      versions: versions.map(versionMetadataPayload) });
  }
  const families = (await pool.query(`SELECT * FROM cloud_agent_families_v3
    WHERE instance_kind='employee' AND recruitable=true AND status='active' ORDER BY department_id,name,id`)).rows;
  const instanceByFamily = new Map(instances.map((item) => [item.agent_family_id, item]));
  const market = [];
  for (const family of families) {
    const instance = instanceByFamily.get(family.id);
    const versions = await stage8.marketVersions({ familyId: family.id, userId, agentInstanceId: instance?.id || '' });
    const effectiveSkill = instance ? await stage8.effectiveSkill({ userId, agentInstanceId: instance.id }) : null;
    const currentMarketVersionId = effectiveSkill?.marketVersionId || '';
    const availableVersionCount = marketAvailableVersionCount(versions, currentMarketVersionId, Boolean(instance));
    const latestVersion = versions[0] || null;
    market.push({ agentFamilyId: family.id, name: family.name || family.id, departmentId: family.department_id || '',
      recruited: Boolean(instance), agentInstanceId: instance?.id || '',
      updateStatus: marketUpdateStatus({ latestVersion, recruited: Boolean(instance), availableVersionCount }),
      releasedVersionCount: versions.length, availableVersionCount, currentMarketVersionId,
      latestVersion: latestVersion ? marketUpdateVersionSummary(latestVersion) : null });
  }
  return { authority: 'cloud', checkedAt: new Date().toISOString(), preference, personal, market };
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

function preferencePayload(row = {}) {
  return { authority: 'cloud', enabled: true, mutable: false,
    policyVersion: 'evolution_mandatory_upload_v1', stateRevision: Number(row.state_revision || 1),
    lastCommandId: row.last_command_id || '', pausedAt: '', updatedAt: iso(row.updated_at) };
}

function versionMetadataPayload(row = {}) {
  return { id: row.id, userAgentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id,
    baseAgentVersionId: row.base_agent_version_id || '', parentVersionId: row.parent_version_id || '',
    sourceEvolutionRunId: row.source_run_id || '', authority: row.authority || 'cloud', stabilityStatus: row.stability_status || '',
    status: row.status || '', available: row.status === 'candidate' && row.stability_status === 'stable',
    overlayHash: row.overlay_hash || '', effectiveSkillHash: row.effective_skill_hash || '', compilerVersion: row.compiler_version || '',
    createdAt: iso(row.created_at), activatedAt: iso(row.activated_at), archivedAt: iso(row.archived_at) };
}

function iso(value) { return value?new Date(value).toISOString():''; }
function versionPayload(row, keyring) { return { ...versionMetadataPayload(row),
  baseAgentVersionId: row.base_agent_version_id, parentVersionId: row.parent_version_id, sourceEvolutionRunId: row.source_run_id,
  authority: row.authority, stabilityStatus: row.stability_status, status: row.status, overlayHash: row.overlay_hash,
  effectiveSkillHash: row.effective_skill_hash, compilerVersion: row.compiler_version,
  overlayText: decryptEvolutionPayload({ algorithm: row.encryption_algorithm, keyId: row.key_id, ciphertext: row.content_ciphertext,
    nonce: row.content_nonce, tag: row.content_tag }, keyring) }; }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
async function leadershipActor(pool, userId = '') {
  return (await pool.query('SELECT id,role FROM users WHERE id=$1', [userId])).rows[0] || { id: userId, role: 'member' };
}
async function requireLeadershipGovernanceActor(pool, userId, apiError) {
  const actor = await leadershipActor(pool, userId);
  if (String(actor.role || '').toLowerCase() !== 'admin') throw apiError('leadership_governance_required', 'Cloud governance approval is required.', 403);
  return actor;
}
function simpleApiError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export const evolutionServiceContracts = Object.freeze({
  PerformanceLevelService: ['status', 'calculate'],
  LeadershipLevelService: ['status', 'history', 'requestTrial', 'submitAppeal'],
  LeadershipGovernanceService: ['actions', 'decideAction', 'appeals', 'decideAppeal'],
  ClusterEvolutionService: ['status', 'requestRun'],
  MarketVersionService: ['status', 'listVersions', 'adoptSections', 'rollbackSections'],
});
