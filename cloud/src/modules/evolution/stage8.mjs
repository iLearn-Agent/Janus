import crypto from 'node:crypto';

import {
  buildCohortEligibility,
  calculatePerformanceSnapshot,
  capClusterEvidenceWeights,
  CLUSTER_MIN_USERS,
  CLUSTER_USER_WEIGHT_CAP,
  clusterEvidenceBreakdown,
  clusterEvidenceThresholdReasons,
  clusterEvidenceWeight,
  compileMarketEffectiveSkill,
  deriveAuthoritativeTaskPerformanceEvent,
  deriveOverlayConflictIndex,
  enrichPerformanceEventsWithPeerBaselines,
  evaluateRealUserCanary,
  PERFORMANCE_ALGORITHM_VERSION,
  PHASE8_ALGORITHM_VERSION,
  runClusterShadowEvaluation,
  runClusterEvolutionCore,
  selectClusterEligibleEvidence,
  selectClusterEvidenceWindow,
} from '../../../../src/shared/evolution/phase8.js';
import {
  decryptEvolutionPayload,
  encryptEvolutionPayload,
  evolutionEnvelopePublicKeyringFromEnv,
  evolutionEncryptionReady,
  evolutionWorkerDecryptionKeyringFromEnv,
} from '../../../../src/shared/evolution/crypto.js';
import {
  CLUSTER_COHORT_IDENTITY_VERSION,
  CLUSTER_PARTICIPATION_POLICY_VERSION,
  CLUSTER_RE_EVALUATION_POLICY_VERSION,
  EVIDENCE_CONTRACT_POLICY_VERSION,
  MARKET_CANARY_MODE,
  MARKET_CANARY_POLICY_VERSION,
  clusterEvidenceCategory,
  clusterEvidenceThresholdsFromEnv,
  clusterReEvaluationBasisHash,
  evidenceRejectionKindForReason,
  stableClusterCohortId,
} from '../../../../src/shared/evolution/contracts.js';
import { normalizeCloudTriggerKind } from '../../../../src/shared/cloudContracts.js';
import { createPostgresAuthoritativeEvidence } from './authoritativeEvidence.mjs';
import { createPostgresEvidenceUsageLedger } from './evidenceUsageLedger.mjs';
import { createEvolutionModelExecutor, evolutionModelDelegatedToWorker } from './modelProvider.mjs';

export function createPostgresStage8Authority({
  pool,
  env = process.env,
  modelExecutor = null,
  keyring = evolutionWorkerDecryptionKeyringFromEnv(env),
} = {}) {
  const enabled = true;
  const databaseAvailable = Boolean(pool);
  const executeModel = modelExecutor || createEvolutionModelExecutor({ env });
  const modelAvailable = (typeof executeModel === 'function' && executeModel.available !== false)
    || evolutionModelDelegatedToWorker(env);
  const encryptionAvailable = evolutionEncryptionReady(keyring) || Boolean(keyring.allowPlaintextTestOnly);
  const clusterAvailable = databaseAvailable && modelAvailable && encryptionAvailable;
  const evidenceThresholds = clusterEvidenceThresholdsFromEnv(env);
  const envelopeKeyring = evolutionEnvelopePublicKeyringFromEnv(env);
  const evaluationIntervalMs = nonnegativeInteger(env.JANUS_PHASE8_CLUSTER_EVALUATION_INTERVAL_MS, 86400000);
  const retryIntervalMs = nonnegativeInteger(env.JANUS_PHASE8_CLUSTER_RETRY_INTERVAL_MS, 900000);
  const shadowDelayMs = nonnegativeInteger(env.JANUS_PHASE8_SHADOW_DELAY_MS, 0);
  const canaryMinimumUsers = Math.max(CLUSTER_MIN_USERS, nonnegativeInteger(env.JANUS_PHASE8_CANARY_MIN_USERS, CLUSTER_MIN_USERS));
  const canaryMinimumCases = Math.max(CLUSTER_MIN_USERS, nonnegativeInteger(env.JANUS_PHASE8_CANARY_MIN_CASES, CLUSTER_MIN_USERS));
  const canaryMinimumDurationMs = nonnegativeInteger(env.JANUS_MARKET_CANARY_MIN_DURATION_MS, 86400000);
  const canaryMaximumDurationMs = Math.max(canaryMinimumDurationMs, nonnegativeInteger(env.JANUS_MARKET_CANARY_MAX_DURATION_MS, 7 * 86400000));
  return {
    capabilities: () => ({
      performance: { authority: 'cloud', authorityLocked: true, enabled: true, mutationEnabled: databaseAvailable,
        executionAvailable: databaseAvailable, readiness: { database: databaseAvailable, model: modelAvailable, encryption: encryptionAvailable },
        algorithmVersion: PERFORMANCE_ALGORITHM_VERSION, code: databaseAvailable ? 'ok' : 'evolution_database_unavailable' },
      cluster: { authority: 'cloud', authorityLocked: true, enabled: true, mutationEnabled: clusterAvailable,
        executionAvailable: clusterAvailable, readiness: { database: databaseAvailable, model: modelAvailable, encryption: encryptionAvailable },
        algorithmVersion: PHASE8_ALGORITHM_VERSION, canaryMode: MARKET_CANARY_MODE, evaluationIntervalMs, retryIntervalMs, evidenceThresholds,
        shadowEvaluationAvailable: clusterAvailable, realCanaryAvailable: databaseAvailable,
        publishingBlockedReason: '',
        canary: { policyVersion: MARKET_CANARY_POLICY_VERSION, optInRequired: false, defaultEnrollment: true,
          optOutAvailable: true, minimumUsers: canaryMinimumUsers, minimumCases: canaryMinimumCases },
        minimumUsers: CLUSTER_MIN_USERS, maximumUserWeightShare: CLUSTER_USER_WEIGHT_CAP,
        cohortIdentityVersion: CLUSTER_COHORT_IDENTITY_VERSION, participationPolicyVersion: CLUSTER_PARTICIPATION_POLICY_VERSION,
        reEvaluationPolicyVersion: CLUSTER_RE_EVALUATION_POLICY_VERSION,
        code: clusterAvailable ? 'ok' : !databaseAvailable ? 'evolution_database_unavailable'
          : !encryptionAvailable ? 'evolution_encryption_key_unavailable' : 'evolution_model_unavailable' },
      market: { authority: 'cloud', authorityLocked: true, enabled: true, mutationEnabled: clusterAvailable,
        executionAvailable: clusterAvailable, queryAvailable: databaseAvailable,
        adoptionAvailable: databaseAvailable && encryptionAvailable,
        rollbackAvailable: databaseAvailable && encryptionAvailable,
        candidateGenerationAvailable: clusterAvailable, publishingAvailable: databaseAvailable,
        readiness: { database: databaseAvailable, model: modelAvailable, encryption: encryptionAvailable }, autoPublish: true,
        sectionIdentity: 'stable_section_id', code: databaseAvailable ? (clusterAvailable ? 'ok' : 'market_generation_paused') : 'evolution_database_unavailable' },
    }),

    async backfillHistoricalEvidence({limit=100}={}) {
      return backfillPostgresHistoricalEvolutionEvidence({pool,env,keyring,envelopeKeyring,limit});
    },

    async recordPerformanceEvents(items = []) {
      assertEnabled(enabled);
      const accepted = [];
      const deferred = [];
      const rejected = [];
      let inserted = 0;
      for (const item of items) {
        const sourceId=String(item.sourceId||item.source_id||'');
        if((item.sourceKind||item.source_kind)!=='task_node'||!sourceId){rejected.push({sourceId,code:'performance_source_reference_required'});continue;}
        try{const resolved=await postgresTaskPerformanceSource(pool,{ownerUserId:item.ownerUserId,agentInstanceId:item.agentInstanceId,sourceId});
          if(!resolved){deferred.push({sourceId,code:'performance_source_not_ready'});continue;}
          const changes=await persistPostgresPerformanceEvent(pool,resolved,{keyring,envelopeKeyring,requireEnvelope:env.NODE_ENV==='production'});
          inserted+=changes;accepted.push({sourceId,sourceVersionId:resolved.sourceVersionId,status:changes?'accepted':'duplicate'});
        }catch(error){rejected.push({sourceId,code:error.code||'performance_source_rejected'});}
      }
      return {status:deferred.length||rejected.length?'partial':'recorded',inserted,accepted,deferred,rejected};
    },

    async refreshPerformanceEvents({limit=500}={}) {
      assertEnabled(enabled);
      const maximum=Math.min(2000,Math.max(1,Number(limit||500)));
      const cursor=(await pool.query("SELECT * FROM cloud_performance_backfill_cursors WHERE cursor_key='task_nodes'")).rows[0]
        ||{last_updated_at:null,last_source_id:''};
      const rows=(await pool.query(`SELECT n.id,n.task_run_id,n.user_agent_instance_id,n.payload_json,n.updated_at
        FROM cloud_task_nodes n WHERE ($1::timestamptz IS NULL OR n.updated_at>$1 OR (n.updated_at=$1 AND n.id>$2))
        ORDER BY n.updated_at,n.id LIMIT $3`,[cursor.last_updated_at||null,cursor.last_source_id||'',maximum])).rows;
      let inserted=0;
      for(const row of rows){const resolved=await postgresTaskPerformanceSource(pool,{sourceId:row.id});
        if(resolved)inserted+=await persistPostgresPerformanceEvent(pool,resolved,{keyring,envelopeKeyring,requireEnvelope:env.NODE_ENV==='production'});}
      if(rows.length)await pool.query(`UPDATE cloud_performance_backfill_cursors SET last_updated_at=$1,last_source_id=$2,status=$3,updated_at=now()
        WHERE cursor_key='task_nodes'`,[rows.at(-1).updated_at,rows.at(-1).id,rows.length<maximum?'completed':'active']);
      return {status:rows.length<maximum?'completed':'active',scanned:rows.length,inserted};
    },

    async calculatePerformance({ agentInstanceId = '', now = new Date() } = {}) {
      assertEnabled(enabled);
      const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=$1', [agentInstanceId])).rows[0];
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance was not found.', 404);
      const rows=(await pool.query(`SELECT * FROM cloud_agent_performance_events WHERE authority='cloud' AND validation_status='validated'
        AND occurred_at >= $1 ORDER BY occurred_at DESC LIMIT 10000`,[new Date(now.getTime()-90*86400000)])).rows;
      const population=rows.map(postgresPerformanceEventPayload);
      const events=enrichPerformanceEventsWithPeerBaselines(population.filter((item)=>item.agentInstanceId===agentInstanceId),population);
      const snapshot = calculatePerformanceSnapshot(events, { now });
      const id = stableId('plevel', instance.id, snapshot.algorithmVersion, snapshot.inputHash);
      await transaction(pool, async (client) => {
        await client.query(`INSERT INTO cloud_agent_performance_history (id,user_agent_instance_id,algorithm_version,window_started_at,window_ended_at,input_hash,score,level,provisional,payload_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`, [id, instance.id, snapshot.algorithmVersion, snapshot.windowStartedAt, snapshot.windowEndedAt, snapshot.inputHash, snapshot.score, snapshot.level, snapshot.provisional, JSON.stringify(snapshot)]);
        await client.query(`INSERT INTO cloud_agent_performance_levels (user_agent_instance_id,agent_family_id,score,level,provisional,completed_task_count,payload_json,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now()) ON CONFLICT(user_agent_instance_id) DO UPDATE SET agent_family_id=excluded.agent_family_id,score=excluded.score,level=excluded.level,provisional=excluded.provisional,completed_task_count=excluded.completed_task_count,payload_json=excluded.payload_json,updated_at=now()`,
        [instance.id, instance.agent_family_id, snapshot.score, snapshot.level, snapshot.provisional, snapshot.completedTaskCount, JSON.stringify(snapshot)]);
      });
      return { ...snapshot, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id };
    },

    async calculateAllPerformance() {
      assertEnabled(enabled);
      await this.refreshPerformanceEvents();
      const rows = (await pool.query("SELECT id FROM cloud_user_agent_instances_v3 WHERE status='active' AND sync_enabled=true")).rows;
      const results = [];
      for (const row of rows) results.push(await this.calculatePerformance({ agentInstanceId: row.id }));
      return results;
    },

    async performance({ agentInstanceId = '' } = {}) {
      const row = (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=$1', [agentInstanceId])).rows[0];
      return row ? { agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id, score: Number(row.score), level: row.level, provisional: row.provisional, completedTaskCount: row.completed_task_count, ...row.payload_json } : null;
    },

    async performanceHistory({ agentInstanceId = '', limit = 30 } = {}) {
      const rows = (await pool.query('SELECT * FROM cloud_agent_performance_history WHERE user_agent_instance_id=$1 ORDER BY created_at DESC LIMIT $2', [agentInstanceId, Math.min(100, Number(limit || 30))])).rows;
      return rows.map((row) => ({ id: row.id, ...row.payload_json, createdAt: row.created_at }));
    },

    async refreshCohorts({ refreshPerformance = true } = {}) {
      assertEnabled(enabled);
      if (refreshPerformance) await this.calculateAllPerformance();
      const instances = (await pool.query(`SELECT i.*,f.department_id,f.payload_json AS family_payload,l.payload_json AS level_payload
        FROM cloud_user_agent_instances_v3 i LEFT JOIN cloud_agent_families_v3 f ON f.id=i.agent_family_id
        LEFT JOIN cloud_agent_performance_levels l ON l.user_agent_instance_id=i.id
        WHERE i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true`)).rows.map((row) => ({
          ownerUserId: row.user_id, agentInstanceId: row.id, agentFamilyId: row.agent_family_id, departmentId: row.department_id || '', status: row.status,
          syncEnabled: row.sync_enabled, capabilityTags: uniqueStrings(row.family_payload?.capabilityTags || row.family_payload?.capability_tags || []), performance: row.level_payload,
        }));
      const evidence = (await pool.query("SELECT * FROM cloud_evolution_evidence WHERE quarantine_reason='' AND validation_status='validated' AND historical_inactive=false AND metadata_json::text LIKE '%\"cluster\"%'" )).rows;
      const usages = (await pool.query("SELECT * FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster'")).rows;
      const claims = (await pool.query('SELECT * FROM cloud_cluster_evidence_claims')).rows;
      const consumedClaimIds = new Set(claims.filter((row) => row.claim_state === 'consumed').map((row) => row.evidence_id));
      const existingCohorts = (await pool.query('SELECT * FROM cloud_agent_cohorts')).rows;
      const cohortsByKey = new Map(existingCohorts.map((row) => [row.cohort_key || row.payload_json?.cohortKey || '', row]));
      const evidenceForCohort = ({ key, members }) => {
        const cohortId = cohortsByKey.get(key)?.id || stableClusterCohortId(key);
        const memberIds = new Set(members.map((member) => member.agentInstanceId));
        return selectClusterEligibleEvidence({
          cohortKey: key,
          evidence: evidence.filter((row) => memberIds.has(row.user_agent_instance_id)).map(clusterEvidenceRecord),
          usage: usages.filter((row) => row.consumer_id === cohortId),
          claims,
          algorithmVersion: PHASE8_ALGORITHM_VERSION,
          policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION,
        }).filter((row) => row.eligibilityKind !== 'reconsiderable');
      };
      const eligibility = buildCohortEligibility({ instances, evidenceForCohort, evidenceThresholds });
      const resolvedIds = new Map();
      await transaction(pool, async (client) => {
        const usageLedger=createPostgresEvidenceUsageLedger(client);
        await client.query("UPDATE cloud_agent_cohorts SET status='inactive',updated_at=now() WHERE status='active'");
        for (const item of eligibility) {
          const id = cohortsByKey.get(item.cohortKey)?.id || stableClusterCohortId(item.cohortKey);
          resolvedIds.set(item.cohortKey, id);
          await client.query(`INSERT INTO cloud_agent_cohorts (id,cohort_key,identity_version,agent_family_id,department_id,capability_tags_json,
            minimum_user_count,maximum_user_weight_share,participation_policy_version,status,payload_json,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,now(),now()) ON CONFLICT(id) DO UPDATE SET
              cohort_key=excluded.cohort_key,identity_version=excluded.identity_version,agent_family_id=excluded.agent_family_id,
              department_id=excluded.department_id,status=excluded.status,capability_tags_json=excluded.capability_tags_json,
              minimum_user_count=excluded.minimum_user_count,maximum_user_weight_share=excluded.maximum_user_weight_share,
              participation_policy_version=excluded.participation_policy_version,payload_json=excluded.payload_json,updated_at=now()`,
          [id, item.cohortKey, CLUSTER_COHORT_IDENTITY_VERSION, item.familyId || '', item.departmentId || '', JSON.stringify(item.capabilityTags),
            CLUSTER_MIN_USERS,CLUSTER_USER_WEIGHT_CAP,CLUSTER_PARTICIPATION_POLICY_VERSION,item.eligible ? 'active' : 'ineligible',
            JSON.stringify({ ...item, id, identityVersion: CLUSTER_COHORT_IDENTITY_VERSION,minimumUserCount:CLUSTER_MIN_USERS,
              maximumUserWeightShare:CLUSTER_USER_WEIGHT_CAP,participationPolicyVersion:CLUSTER_PARTICIPATION_POLICY_VERSION })]);
          await client.query('DELETE FROM cloud_agent_cohort_members WHERE cohort_id=$1', [id]);
          if (item.eligible || item.type === 'family') {
            for (const member of item.members) {
              for (const row of evidence.filter((entry) => entry.user_agent_instance_id === member.agentInstanceId && !consumedClaimIds.has(entry.evidence_id))) {
                await usageLedger.ensureAvailable({evidenceId:row.evidence_id,scope:'cluster',consumerId:id});
              }
            }
          }
          if (!item.eligible) continue;
          for (const member of item.members) {
            const performance = member.performance || { level: 'P1', contributionWeight: 0.5 };
            await client.query(`INSERT INTO cloud_agent_cohort_members (cohort_id,user_agent_instance_id,owner_user_id,agent_family_id,performance_level,raw_weight,effective_weight,payload_json)
              VALUES ($1,$2,$3,$4,$5,$6,$6,$7::jsonb)`, [id, member.agentInstanceId, member.ownerUserId, member.agentFamilyId, performance.level || 'P1', Number(performance.contributionWeight || 0.5), JSON.stringify({ performance, capabilityTags: member.capabilityTags })]);
          }
        }
      });
      return eligibility.map((item) => ({ ...item, id: resolvedIds.get(item.cohortKey) || stableClusterCohortId(item.cohortKey), identityVersion: CLUSTER_COHORT_IDENTITY_VERSION }));
    },

    async cohorts({ includeIneligible = false } = {}) {
      const rows = (await pool.query(includeIneligible ? "SELECT * FROM cloud_agent_cohorts WHERE status IN ('active','ineligible') ORDER BY updated_at DESC" : "SELECT * FROM cloud_agent_cohorts WHERE status='active' ORDER BY updated_at DESC")).rows;
      return rows.map((row) => ({ ...row.payload_json, id: row.id, cohortKey: row.cohort_key || row.payload_json?.cohortKey || '', identityVersion: row.identity_version || '', status: row.status }));
    },

    async requestClusterRun({ cohortId = '', triggerKind = 'scheduled' } = {}) {
      assertClusterReady({ enabled, modelAvailable, encryptionAvailable });
      const normalizedTriggerKind = normalizeCloudTriggerKind(triggerKind);
      const cohort = (await pool.query("SELECT * FROM cloud_agent_cohorts WHERE id=$1 AND status='active'", [cohortId])).rows[0];
      if (!cohort) throw codedError('cohort_not_eligible', 'Cohort is not active.', 409);
      const active = (await pool.query("SELECT id,status FROM cloud_evolution_runs WHERE evolution_scope='cluster' AND cohort_id=$1 AND status IN ('queued','claimed','running','proposed','canary') LIMIT 1", [cohortId])).rows[0];
      if (active) return { status: 'deferred', runId: active.id };
      const latest = (await pool.query("SELECT * FROM cloud_evolution_runs WHERE evolution_scope='cluster' AND cohort_id=$1 AND algorithm_version=$2 ORDER BY created_at DESC LIMIT 1", [cohortId, PHASE8_ALGORITHM_VERSION])).rows[0];
      const cadence = clusterCadence(latest, { evaluationIntervalMs, retryIntervalMs });
      if (cadence.deferred) return { status: 'deferred', reason: 'cluster_evaluation_cadence', runId: latest.id, nextEligibleAt: cadence.nextEligibleAt };
      const members = (await pool.query(`SELECT m.* FROM cloud_agent_cohort_members m
        JOIN cloud_user_agent_instances_v3 i ON i.user_id=m.owner_user_id AND i.id=m.user_agent_instance_id
        WHERE m.cohort_id=$1 AND i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true`, [cohortId])).rows;
      const memberUserCount = distinctWeightUserCount(members.map((row) => ({ ownerUserId: row.owner_user_id, rawWeight: row.raw_weight })));
      if (memberUserCount < CLUSTER_MIN_USERS) return skipClusterRunForWeightCap(pool, { cohort, cohortId, triggerKind: normalizedTriggerKind, evidenceCount: 0, userCount: memberUserCount, evaluationIntervalMs });
      const memberById = new Map(members.map((row) => [row.user_agent_instance_id, row]));
      const memberIds = members.map((row) => row.user_agent_instance_id);
      const evidenceRows = memberIds.length ? (await pool.query(`SELECT * FROM cloud_evolution_evidence
        WHERE user_agent_instance_id=ANY($1::text[]) AND quarantine_reason='' AND validation_status='validated' AND historical_inactive=false AND metadata_json::text LIKE '%"cluster"%'
        ORDER BY occurred_at DESC LIMIT 2000`, [memberIds])).rows : [];
      const eligibleEvidence = selectClusterEligibleEvidence({
        cohortKey: cohort.cohort_key || cohort.payload_json?.cohortKey || `legacy:${cohort.id}`,
        evidence: evidenceRows.map(clusterEvidenceRecord),
        usage: (await pool.query("SELECT * FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND consumer_id=$1", [cohortId])).rows,
        claims: (await pool.query('SELECT * FROM cloud_cluster_evidence_claims')).rows,
        algorithmVersion: PHASE8_ALGORITHM_VERSION,
        policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION,
      }).slice(0, 500).map((row) => {
        const member = memberById.get(row.user_agent_instance_id);
        return { ...row, ownerUserId: row.owner_user_id, rawWeight: clusterEvidenceWeight({ performanceWeight: Number(member?.raw_weight || 0.5), confidence: row.confidence, occurredAt: row.occurred_at, relevance: row.metadata_json?.taskRelevance ?? 1, acceptanceQuality: row.metadata_json?.acceptanceQuality ?? 1 }) };
      });
      const selectedCandidates = selectClusterEvidenceWindow(eligibleEvidence, { limit: 180, thresholds: evidenceThresholds });
      const selectedUserCount = distinctWeightUserCount(selectedCandidates);
      if (selectedUserCount < CLUSTER_MIN_USERS) return skipClusterRunForWeightCap(pool, { cohort, cohortId, triggerKind: normalizedTriggerKind, evidenceCount: selectedCandidates.length, userCount: selectedUserCount, evaluationIntervalMs });
      const thresholdReasons = clusterEvidenceThresholdReasons(selectedCandidates.filter((row)=>row.eligibilityKind!=='reconsiderable'), evidenceThresholds);
      const selected = capClusterEvidenceWeights(selectedCandidates);
      if (thresholdReasons.length) {
        const runId = `clrun_${crypto.randomUUID()}`;
        await pool.query(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count,summary,completed_at)
          VALUES ($1,'cluster',$2,$3,$3,$4,$5,'insufficient_evidence',$6,$7,now())`, [runId, cohort.agent_family_id || '', cohortId,
          PHASE8_ALGORITHM_VERSION, normalizedTriggerKind, selected.length, `Evidence thresholds were not met: ${thresholdReasons.join(',')}.`]);
        return { status: 'insufficient_evidence', runId, evidenceCount: selected.length,
          evidenceBreakdown: clusterEvidenceBreakdown(selectedCandidates), eligibilityReasons: thresholdReasons,
          userCount: distinctWeightUserCount(selected.map((row) => ({ ownerUserId: row.owner_user_id, rawWeight: row.effectiveWeight }))),
          evidenceThresholds, nextEligibleAt: new Date(Date.now() + evaluationIntervalMs).toISOString() };
      }
      const runId = `clrun_${crypto.randomUUID()}`;
      const jobId = `cljob_${crypto.randomUUID()}`;
      const cohortSnapshot = {
        cohortId, cohortKey: cohort.cohort_key || cohort.payload_json?.cohortKey || '',
        identityVersion: cohort.identity_version || CLUSTER_COHORT_IDENTITY_VERSION,
        algorithmVersion: PHASE8_ALGORITHM_VERSION, policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION,
        reEvaluationPolicyVersion: CLUSTER_RE_EVALUATION_POLICY_VERSION, evidenceThresholds,
        evidenceBreakdown: clusterEvidenceBreakdown(selectedCandidates),
        newEvidenceCount: selectedCandidates.filter((row) => row.eligibilityKind !== 'reconsiderable').length,
        reconsiderableEvidenceCount: selectedCandidates.filter((row) => row.eligibilityKind === 'reconsiderable').length,
        members: members.map((row) => ({ ownerUserId: row.owner_user_id, agentInstanceId: row.user_agent_instance_id,
          agentFamilyId: row.agent_family_id, performanceLevel: row.performance_level })),
        evidence: selected.map(clusterEvidenceSnapshot),
      };
      try {
        await transaction(pool, async (client) => {
          const usageLedger=createPostgresEvidenceUsageLedger(client);
          await client.query(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count)
            VALUES ($1,'cluster',$2,$3,$3,$4,$5,'queued',$6)`, [runId, cohort.agent_family_id || '', cohortId, PHASE8_ALGORITHM_VERSION, normalizedTriggerKind, selected.length]);
          await client.query("INSERT INTO cloud_evolution_jobs (id,run_id,job_kind,status,available_at) VALUES ($1,$2,'cluster_evolution','queued',now())", [jobId, runId]);
          await client.query(`INSERT INTO cloud_evolution_run_snapshots (run_id,snapshot_hash,evidence_ids_json,cohort_snapshot_json)
            VALUES ($1,$2,$3::jsonb,$4::jsonb)`, [runId, sha256(JSON.stringify(cohortSnapshot)), JSON.stringify(selected.map((row) => row.evidence_id)), JSON.stringify(cohortSnapshot)]);
          for (const row of selected) {
            await client.query(`INSERT INTO cloud_cluster_run_evidence (run_id,evidence_id,raw_weight,effective_weight,cohort_raw_total,user_cap)
              VALUES ($1,$2,$3,$4,$5,$6)`, [runId, row.evidence_id, row.rawWeight, row.effectiveWeight, row.cohortRawTotal, row.userCap]);
          }
          const reserved=await usageLedger.reserve({scope:'cluster',consumerId:cohortId,runId,algorithmVersion:PHASE8_ALGORITHM_VERSION,
            evidenceIds:selected.map((row)=>row.evidence_id),nextBasisByEvidence:Object.fromEntries(selected
              .filter((row)=>row.nextReEvaluationBasisHash).map((row)=>[row.evidence_id,row.nextReEvaluationBasisHash])),
            leaseMinutes:30,clusterClaims:true,transitionReason:selected.some((row)=>row.eligibilityKind==='reconsiderable')
              ?'reserved_with_reconsideration':'reserved_for_run'});
          if(reserved.length!==selected.length) throw codedError('cluster_evidence_usage_conflict','Cluster evidence usage changed before reservation.',409);
        });
      } catch (error) {
        if (['cluster_evidence_claim_conflict', 'cluster_evidence_usage_conflict'].includes(error.code)) {
          return { status: 'deferred', reason: error.code, nextEligibleAt: new Date(Date.now() + retryIntervalMs).toISOString() };
        }
        throw error;
      }
      return { status: 'queued', runId };
    },

    async tickClusterWorker({ workerId = `cluster_${process.pid}`, limit = 1 } = {}) {
      const completed=await this.reconcileMarketCanaries();
      assertClusterReady({ enabled, modelAvailable, encryptionAvailable });
      for (let index = 0; index < Math.max(1, Number(limit || 1)); index += 1) {
        const job = await claimJob(pool, workerId);
        if (!job) break;
        try { completed.push(job.job_kind === 'cluster_shadow'
          ? await executeClusterShadow({ pool, job, modelExecutor: executeModel, keyring, canaryMinimumUsers, canaryMinimumCases })
          : await executeCluster({ pool, job, modelExecutor: executeModel, keyring, shadowDelayMs })); }
        catch (error) { completed.push(await failJob(pool, job, error)); }
      }
      return { status: 'ok', completed };
    },

    async reconcileMarketCanaries() {
      assertEnabled(enabled);
      return reconcilePostgresCanaries({pool,keyring,canaryMinimumUsers,canaryMinimumCases,
        canaryMinimumDurationMs,canaryMaximumDurationMs});
    },

    async setCanaryOptIn({ userId = '', agentInstanceId = '', enabled: optIn = true, commandId = '' } = {}) {
      assertEnabled(enabled);
      const instance=(await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2',[userId,agentInstanceId])).rows[0];
      if(!instance)throw codedError('agent_instance_not_found','Agent instance does not belong to user.',404);
      if(optIn&&(instance.status!=='active'||!instance.sync_enabled||!instance.cluster_contribution_consent))throw codedError('canary_agent_unavailable','Only evolution-enabled active synchronized Agents may join Canary.',409);
      await transaction(pool,async(client)=>{
        await client.query(`INSERT INTO cloud_market_canary_opt_ins
          (user_id,user_agent_instance_id,agent_family_id,policy_version,status,command_id,payload_json,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now()) ON CONFLICT(user_id,user_agent_instance_id) DO UPDATE SET
            agent_family_id=excluded.agent_family_id,policy_version=excluded.policy_version,status=excluded.status,
            command_id=excluded.command_id,payload_json=excluded.payload_json,updated_at=now()`,[userId,agentInstanceId,instance.agent_family_id,
            MARKET_CANARY_POLICY_VERSION,optIn?'active':'withdrawn',String(commandId||''),JSON.stringify({
              enrollment: optIn ? 'manual_rejoin' : 'explicit_opt_out', explicitOptOut: !optIn,
            })]);
        if(!optIn)await client.query("UPDATE cloud_market_canary_assignments SET status='withdrawn',completed_at=now() WHERE user_id=$1 AND user_agent_instance_id=$2 AND status='enrolled'",[userId,agentInstanceId]);
      });
      return this.canaryStatus({userId,agentInstanceId});
    },

    async canaryStatus({ userId = '', agentInstanceId = '' } = {}) {
      const instance=(await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2',[userId,agentInstanceId])).rows[0];
      const eligible=Boolean(instance&&instance.status==='active'&&instance.sync_enabled&&instance.cluster_contribution_consent
        &&await userEvolutionEnabled(pool,userId));
      if(eligible)await ensurePostgresDefaultCanaryEnrollments(pool,{userId,agentInstanceId});
      const optIn=(await pool.query('SELECT * FROM cloud_market_canary_opt_ins WHERE user_id=$1 AND user_agent_instance_id=$2',[userId,agentInstanceId])).rows[0];
      const assignments=(await pool.query(`SELECT a.*,c.status candidate_status,c.status_reason FROM cloud_market_canary_assignments a
        JOIN cloud_market_agent_candidates c ON c.id=a.candidate_id WHERE a.user_id=$1 AND a.user_agent_instance_id=$2 ORDER BY a.started_at DESC`,[userId,agentInstanceId])).rows;
      return {authority:'cloud',policyVersion:MARKET_CANARY_POLICY_VERSION,optedIn:optIn?.status==='active',
        eligible,defaultEnrolled:optIn?.status==='active'&&optIn?.payload_json?.enrollment==='default',
        explicitlyOptedOut:optIn?.status==='withdrawn',canOptOut:true,
        assignments:assignments.map(postgresCanaryAssignmentPayload)};
    },

    async candidates({ familyId = '', limit = 50 } = {}) {
      const rows = familyId ? (await pool.query('SELECT * FROM cloud_market_agent_candidates WHERE agent_family_id=$1 ORDER BY created_at DESC LIMIT $2', [familyId, limit])).rows : (await pool.query('SELECT * FROM cloud_market_agent_candidates ORDER BY created_at DESC LIMIT $1', [limit])).rows;
      const result = [];
      for (const row of rows) result.push(await postgresMarketCandidatePayload(pool, row));
      return result;
    },

    async abandonShadowCandidate({ candidateId = '', reason = 'shadow_candidate_abandoned' } = {}) {
      const candidate = (await pool.query("SELECT * FROM cloud_market_agent_candidates WHERE id=$1 AND status='shadow_passed'", [candidateId])).rows[0];
      if (!candidate) throw codedError('shadow_candidate_not_found', 'Shadow-passed candidate was not found.', 404);
      const run = (await pool.query('SELECT * FROM cloud_evolution_runs WHERE id=$1', [candidate.run_id])).rows[0];
      await transaction(pool, async (client) => {
        await client.query("UPDATE cloud_market_agent_candidates SET status='archived',status_reason=$1,updated_at=now() WHERE id=$2", [reason, candidate.id]);
        await client.query("UPDATE cloud_market_candidate_family_sections SET status='archived' WHERE candidate_id=$1", [candidate.id]);
        await client.query("UPDATE cloud_evolution_runs SET status='rolled_back',error_code=$1,completed_at=now(),updated_at=now() WHERE id=$2", [reason, run.id]);
        await client.query("UPDATE cloud_evolution_jobs SET status='cancelled',error_code=$1,completed_at=now(),updated_at=now() WHERE run_id=$2", [reason, run.id]);
        await createPostgresEvidenceUsageLedger(client).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
          toStatus: 'released', transitionReason: reason, clusterClaims: true });
      });
      return { candidateId: candidate.id, runId: run.id, status: 'archived', evidenceStatus: 'released' };
    },

    async marketVersions({ familyId = '', userId = '', agentInstanceId = '', limit = 50 } = {}) {
      const rows = familyId ? (await pool.query("SELECT * FROM cloud_market_agent_versions WHERE agent_family_id=$1 AND status IN ('released','suspended') ORDER BY created_at DESC LIMIT $2", [familyId, limit])).rows : (await pool.query("SELECT * FROM cloud_market_agent_versions WHERE status IN ('released','suspended') ORDER BY created_at DESC LIMIT $1", [limit])).rows;
      const result = [];
      for (const row of rows) result.push(await versionPayload(pool, row, { userId, agentInstanceId }));
      return result;
    },

    async adopt({ userId = '', agentInstanceId = '', marketVersionId = '', sectionIds = [], conflictResolutions = {}, action = 'adopt', mode = '', commandId = '', expectedEffectiveSkillHash } = {}) {
      assertMarketReady({ enabled, encryptionAvailable });
      if (!['adopt', 'rollback', 'ignore'].includes(action)) throw codedError('market_adoption_action_invalid', 'Market adoption action is invalid.', 400);
      const adoptionMode = normalizeAdoptionMode(mode || (sectionIds.length ? 'sections' : 'full'));
      const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, agentInstanceId])).rows[0];
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance was not found.', 404);
      const version = (await pool.query("SELECT * FROM cloud_market_agent_versions WHERE id=$1 AND agent_family_id=$2 AND status IN ('released','suspended')", [marketVersionId, instance.agent_family_id])).rows[0];
      if (!version) throw codedError('market_version_not_found', 'Market version was not found.', 404);
      if (action === 'adopt' && version.status === 'suspended') throw codedError('market_version_suspended', 'This market version is suspended and cannot accept new adoptions.', 409);
      const sections = (await pool.query('SELECT * FROM cloud_market_version_sections WHERE market_version_id=$1 ORDER BY ordinal', [marketVersionId])).rows.map(sectionPayload);
      const requested = adoptionMode === 'full' ? new Set(sections.map((item) => item.sectionId)) : new Set(sectionIds.map(String).filter(Boolean));
      if (adoptionMode === 'sections' && !requested.size) throw codedError('market_section_required', 'At least one market section is required for section adoption.', 400);
      const selectedSections = sections.filter((item) => requested.has(item.sectionId));
      if (selectedSections.length !== requested.size) throw codedError('market_section_not_found', 'One or more market sections were not found in this version.', 404);
      const targetIds = adoptionMode === 'full' ? ['*'] : selectedSections.map((section) => section.sectionId);
      const cleanCommandId = String(commandId || '').trim();
      if (cleanCommandId) {
        const existing = Number((await pool.query('SELECT COUNT(*)::int count FROM cloud_market_adoption_actions WHERE user_id=$1 AND command_id=$2 AND section_id=ANY($3::text[])', [userId, cleanCommandId, targetIds])).rows[0]?.count || 0);
        if (existing === targetIds.length) return { ...(await projectSkill(pool, { userId, instance, marketVersionId, keyring })), idempotent: true };
      }
      const currentSkill = await projectSkill(pool, { userId, instance, marketVersionId: '', keyring });
      if (expectedEffectiveSkillHash !== undefined && String(expectedEffectiveSkillHash || '') !== String(currentSkill.effectiveSkillHash || '')) {
        throw codedError('market_skill_conflict', 'The effective Market Skill changed on another device.', 409, {
          expectedEffectiveSkillHash: String(expectedEffectiveSkillHash || ''),
          currentEffectiveSkillHash: String(currentSkill.effectiveSkillHash || ''),
        });
      }
      const overlay = await postgresOverlayText(pool, instance, keyring);
      const conflictIds = deriveOverlayConflictIndex(overlay, selectedSections);
      const unresolved = action === 'adopt' ? conflictIds.filter((sectionId) => !Object.hasOwn(conflictResolutions, sectionId)) : [];
      if (unresolved.length) return marketConflictPreview({ userId, instance, marketVersionId, overlay, sections: selectedSections, conflictIds: unresolved });
      for (const resolution of Object.values(conflictResolutions)) if (!['personal', 'market'].includes(resolution)) throw codedError('market_conflict_resolution_invalid', 'Conflict resolution must be personal or market.', 400);
      await transaction(pool, async (client) => {
        for (const targetId of targetIds) {
          const previous = (await client.query('SELECT status FROM cloud_user_market_adoptions WHERE user_id=$1 AND user_agent_instance_id=$2 AND market_version_id=$3 AND section_id=$4', [userId, agentInstanceId, marketVersionId, targetId])).rows[0]?.status || '';
          const status = action === 'rollback' ? 'rolled_back' : action === 'ignore' ? 'ignored' : 'adopted';
          const resolution = targetId === '*' ? 'none' : conflictResolutions[targetId] || 'none';
          if (action === 'adopt') await client.query(`UPDATE cloud_user_market_adoptions SET status='superseded',updated_at=now()
            WHERE user_id=$1 AND user_agent_instance_id=$2 AND section_id=$3 AND market_version_id<>$4 AND status='adopted'`, [userId, agentInstanceId, targetId, marketVersionId]);
          await client.query(`INSERT INTO cloud_user_market_adoptions (user_id,user_agent_instance_id,market_version_id,section_id,adoption_mode,status,payload_json,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now()) ON CONFLICT(user_id,user_agent_instance_id,market_version_id,section_id) DO UPDATE SET adoption_mode=excluded.adoption_mode,status=excluded.status,payload_json=excluded.payload_json,updated_at=now()`, [userId, agentInstanceId, marketVersionId, targetId, adoptionMode, status, JSON.stringify({ conflictResolution: resolution, conflictResolutions: adoptionMode === 'full' ? conflictResolutions : undefined, selectedSectionIds: adoptionMode === 'full' ? selectedSections.map((item) => item.sectionId) : undefined })]);
          if (action === 'rollback') {
            const restore = (await client.query(`SELECT a.market_version_id FROM cloud_user_market_adoptions a JOIN cloud_market_agent_versions v ON v.id=a.market_version_id
              WHERE a.user_id=$1 AND a.user_agent_instance_id=$2 AND a.section_id=$3 AND a.status='superseded'
              ORDER BY v.created_at DESC LIMIT 1`, [userId, agentInstanceId, targetId])).rows[0];
            if (restore) await client.query("UPDATE cloud_user_market_adoptions SET status='adopted',updated_at=now() WHERE user_id=$1 AND user_agent_instance_id=$2 AND market_version_id=$3 AND section_id=$4", [userId, agentInstanceId, restore.market_version_id, targetId]);
          }
          const actionId=`adopt_${crypto.randomUUID()}`;
          const actionPayload={mode:adoptionMode,action,marketVersionId,sectionId:targetId,previousStatus:previous,nextStatus:status,conflictResolution:resolution || 'none'};
          await client.query(`INSERT INTO cloud_market_adoption_actions (id,user_id,user_agent_instance_id,market_version_id,section_id,action,conflict_resolution,previous_status,next_status,command_id,payload_json)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[actionId,userId,agentInstanceId,marketVersionId,targetId,action,resolution || 'none',previous,status,cleanCommandId,JSON.stringify({ mode: adoptionMode })]);
          await createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,requireEnvelope:env.NODE_ENV==='production',ownerUserId:userId,userAgentInstanceId:agentInstanceId,
            agentFamilyId:instance.agent_family_id,sourceKind:marketEvidenceSourceKind(action),sourceId:actionId,sourceVersionId:marketVersionId,
            content:actionPayload,occurredAt:new Date(),confidence:1,metadata:{marketVersionId,sectionId:targetId},cluster:true});
        }
      });
      return { ...(await projectSkill(pool, { userId, instance, marketVersionId, keyring })), status: action === 'rollback' ? 'rolled_back' : action === 'ignore' ? 'ignored' : 'applied', mode: adoptionMode, commandId: cleanCommandId };
    },

    async evaluateMarketHealth({ now = new Date() } = {}) {
      const versions = (await pool.query("SELECT * FROM cloud_market_agent_versions WHERE status IN ('released','suspended') ORDER BY created_at")).rows;
      const result = [];
      for (const version of versions) result.push(await evaluatePostgresMarketVersionHealth(pool, version, now));
      return result;
    },

    async effectiveSkill({ userId = '', agentInstanceId = '' } = {}) {
      const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2', [userId, agentInstanceId])).rows[0];
      if (instance && enabled && encryptionAvailable) return projectSkill(pool, { userId, instance, marketVersionId: '', keyring });
      const row = (await pool.query('SELECT * FROM cloud_effective_skill_projections WHERE user_id=$1 AND user_agent_instance_id=$2', [userId, agentInstanceId])).rows[0];
      return row ? { ...row.payload_json, effectiveSkillHash: row.effective_skill_hash, updatedAt: row.updated_at } : null;
    },
  };
}

async function backfillPostgresHistoricalEvolutionEvidence({pool,env,keyring,envelopeKeyring,limit=100}){
  const maximum=Math.min(500,Math.max(1,Number(limit||100)));const counts={marketActions:0,collaborationMessages:0,delegationEvents:0,quarantined:0};
  const marketRows=(await pool.query(`SELECT a.*,i.agent_family_id,i.status instance_status,i.deactivated_at
    FROM cloud_market_adoption_actions a JOIN cloud_user_agent_instances_v3 i ON i.user_id=a.user_id AND i.id=a.user_agent_instance_id
    LEFT JOIN cloud_evolution_evidence e ON e.source_id=a.id AND e.source_kind IN ('market_adoption','market_rejection','market_rollback')
    WHERE e.evidence_id IS NULL AND a.created_at>COALESCE((SELECT collect_after FROM cloud_evolution_collection_boundaries
      WHERE source_kind='market_action'),'1970-01-01T00:00:00Z'::timestamptz) ORDER BY a.created_at,a.id LIMIT $1`,[maximum])).rows;
  for(const row of marketRows){
    const historical=historicalInactiveRow(row.instance_status,row.deactivated_at,row.created_at);
    if(row.instance_status!=='active'&&!historical)continue;
    const sourceKind=marketEvidenceSourceKind(row.action);
    const content={action:row.action,marketVersionId:row.market_version_id,sectionId:row.section_id,
      previousStatus:row.previous_status,nextStatus:row.next_status,conflictResolution:row.conflict_resolution};
    const created=await transaction(pool,(client)=>createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,
      requireEnvelope:env.NODE_ENV==='production',ownerUserId:row.user_id,userAgentInstanceId:row.user_agent_instance_id,
      agentFamilyId:row.agent_family_id,sourceKind,sourceId:row.id,sourceVersionId:row.market_version_id,content,
      occurredAt:row.created_at,confidence:1,metadata:{marketVersionId:row.market_version_id,sectionId:row.section_id,
        historicalBackfill:true},cluster:!historical,personal:!historical,historicalInactive:historical}));
    if(created.inserted)counts.marketActions+=1;
  }
  const collaborationRows=(await pool.query(`SELECT m.* FROM collaboration_group_messages m
    LEFT JOIN cloud_evolution_evidence e ON e.source_kind='collaboration_message' AND e.source_id=m.id
    WHERE e.evidence_id IS NULL AND m.created_at>COALESCE((SELECT collect_after FROM cloud_evolution_collection_boundaries
      WHERE source_kind='collaboration_message'),'1970-01-01T00:00:00Z'::timestamptz) ORDER BY m.created_at,m.id LIMIT $1`,[maximum])).rows;
  for(const row of collaborationRows){
    const instance=await secretaryInstanceForHistoricalEvidence(pool,row.sender_user_id,row.created_at);
    if(!instance){await quarantinePostgresHistoricalEvidence(pool,{ownerUserId:row.sender_user_id,sourceKind:'collaboration_message',sourceId:row.id,
      sourceVersionId:row.source_event_id||'',reasonCode:'agent_instance_not_attributable'});counts.quarantined+=1;continue;}
    const metadata=row.metadata_json||{};
    const created=await transaction(pool,(client)=>createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,
      requireEnvelope:env.NODE_ENV==='production',ownerUserId:row.sender_user_id,userAgentInstanceId:instance.id,
      agentFamilyId:instance.agent_family_id,sourceKind:'collaboration_message',sourceId:row.id,sourceVersionId:row.source_event_id||'',
      content:row.content,delegationId:String(metadata.delegationId||metadata.delegation_id||''),occurredAt:row.created_at,confidence:.8,
      metadata:{groupId:row.group_id,kind:row.kind,historicalBackfill:true},historicalInactive:instance.historicalInactive,
      personal:!instance.historicalInactive,cluster:!instance.historicalInactive}));
    if(created.inserted)counts.collaborationMessages+=1;
  }
  const delegationRows=(await pool.query(`SELECT r.*,d.status delegation_status,d.group_id FROM agent_delegation_revisions r
    LEFT JOIN agent_delegations d ON d.id=r.delegation_id LEFT JOIN cloud_evolution_evidence e
      ON e.source_kind='delegation_event' AND e.source_id=r.delegation_id AND e.source_version_id=r.id
    WHERE e.evidence_id IS NULL AND r.created_at>COALESCE((SELECT collect_after FROM cloud_evolution_collection_boundaries
      WHERE source_kind='delegation_event'),'1970-01-01T00:00:00Z'::timestamptz) ORDER BY r.created_at,r.id LIMIT $1`,[maximum])).rows;
  for(const row of delegationRows){
    const instance=await secretaryInstanceForHistoricalEvidence(pool,row.author_user_id,row.created_at);
    if(!instance){await quarantinePostgresHistoricalEvidence(pool,{ownerUserId:row.author_user_id,sourceKind:'delegation_event',
      sourceId:row.delegation_id,sourceVersionId:row.id,reasonCode:'agent_instance_not_attributable'});counts.quarantined+=1;continue;}
    const content=String(row.content||'').trim()||JSON.stringify({action:row.action,status:row.delegation_status,revisionNo:row.revision_no});
    const created=await transaction(pool,(client)=>createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,
      requireEnvelope:env.NODE_ENV==='production',ownerUserId:row.author_user_id,userAgentInstanceId:instance.id,
      agentFamilyId:instance.agent_family_id,sourceKind:'delegation_event',sourceId:row.delegation_id,sourceVersionId:row.id,
      content,delegationId:row.delegation_id,occurredAt:row.created_at,confidence:.8,
      metadata:{action:row.action,status:row.delegation_status||'',revisionNo:Number(row.revision_no||0),groupId:row.group_id||'',historicalBackfill:true},
      historicalInactive:instance.historicalInactive,personal:!instance.historicalInactive,cluster:!instance.historicalInactive}));
    if(created.inserted)counts.delegationEvents+=1;
  }
  return counts;
}

async function secretaryInstanceForHistoricalEvidence(pool,userId,occurredAt){
  const rows=(await pool.query(`SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND agent_family_id='secretary_agent'
    ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,updated_at DESC`,[userId])).rows;
  for(const row of rows){if(row.status==='active')return {...row,historicalInactive:false};
    if(historicalInactiveRow(row.status,row.deactivated_at,occurredAt))return {...row,historicalInactive:true};}
  return null;
}
function historicalInactiveRow(status,deactivatedAt,occurredAt){return status==='inactive'&&Boolean(deactivatedAt)
  &&Date.parse(occurredAt||'')<=Date.parse(deactivatedAt);}
async function quarantinePostgresHistoricalEvidence(pool,{ownerUserId,sourceKind,sourceId,sourceVersionId,reasonCode}){
  const id=stableId('evquar',ownerUserId,sourceKind,sourceId,sourceVersionId,reasonCode);
  await pool.query(`INSERT INTO cloud_evolution_evidence_quarantine
    (id,owner_user_id,source_kind,source_id,source_version_id,reason_code,reason_text,retryable)
    VALUES($1,$2,$3,$4,$5,$6,'Historical Evidence could not be attributed to a synchronized Agent instance.',false)
    ON CONFLICT(id) DO NOTHING`,[id,ownerUserId,sourceKind,sourceId,sourceVersionId,reasonCode]);
}

async function executeCluster({ pool, job, modelExecutor, keyring, shadowDelayMs }) {
  if (typeof modelExecutor !== 'function') throw codedError('evolution_worker_unavailable', 'Cluster model executor is unavailable.', 503);
  const run = (await pool.query('SELECT * FROM cloud_evolution_runs WHERE id=$1', [job.run_id])).rows[0];
  const cohortRow = (await pool.query('SELECT * FROM cloud_agent_cohorts WHERE id=$1', [run.cohort_id])).rows[0];
  const snapshotRow=(await pool.query('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=$1',[run.id])).rows[0];
  const frozenMembers=snapshotRow?.cohort_snapshot_json?.members;
  const members=Array.isArray(frozenMembers)&&frozenMembers.length?frozenMembers:(await pool.query('SELECT * FROM cloud_agent_cohort_members WHERE cohort_id=$1',[run.cohort_id])).rows
    .map((row)=>({ownerUserId:row.owner_user_id,agentInstanceId:row.user_agent_instance_id,agentFamilyId:row.agent_family_id}));
  const rows = (await pool.query(`SELECT e.*,w.effective_weight FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    JOIN cloud_cluster_run_evidence w ON w.run_id=u.run_id AND w.evidence_id=e.evidence_id
    WHERE u.run_id=$1 AND u.evolution_scope='cluster' AND u.status='reserved' ORDER BY e.occurred_at`, [run.id])).rows;
  const evidence = [];
  for (const row of rows) {
    try {
      const content = decryptEvolutionPayload({
        algorithm: row.encryption_algorithm,
        keyId: row.key_id,
        ciphertext: row.content_ciphertext,
        nonce: row.content_nonce,
        tag: row.content_tag,
        wrappedDataKey: row.wrapped_data_key,
      }, keyring);
      evidence.push({
        evidenceId: row.evidence_id,
        ownerUserId: row.owner_user_id,
        agentInstanceId: row.user_agent_instance_id,
        effectiveWeight: Number(row.effective_weight || 0.5),
        content,
      });
      await auditClusterEvidenceAccess(pool, {
        runId: run.id,
        evidenceId: row.evidence_id,
        result: 'allowed',
        keyId: row.key_id,
      });
    } catch (error) {
      await auditClusterEvidenceAccess(pool, {
        runId: run.id,
        evidenceId: row.evidence_id,
        result: 'denied',
        resultCode: error.code || 'decrypt_failed',
        keyId: row.key_id,
        detail: { message: String(error.message || error).slice(0, 500) },
      });
      throw error;
    }
  }
  const familyIds = uniqueStrings(members.map((item) => item.agentFamilyId));
  const releaseFamilyIds = run.agent_family_id ? [run.agent_family_id] : familyIds;
  const current = [];
  for (const familyId of releaseFamilyIds) current.push(...(await latestSections(pool, familyId)).map((section) => ({ ...section, agentFamilyId: familyId })));
  const identityRows=(await pool.query(`SELECT id,display_name,username FROM users WHERE id=ANY($1::text[])`,
    [uniqueStrings(members.map((item)=>item.ownerUserId))])).rows;
  const result = await runClusterEvolutionCore({ cohort: { ...cohortRow.payload_json, id: cohortRow.id, members }, evidence,
    currentMarketSections: current, modelExecutor,privacyContext:{knownIdentityTerms:identityRows.flatMap((item)=>[item.display_name,item.username])} });
  if (result.status !== 'approved') {
    await transaction(pool, async (client) => {
      const basisByEvidence = await clusterReEvaluationBasisByEvidence(client, run.id);
      await client.query("UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code=$1,completed_at=now(),updated_at=now() WHERE id=$2", [result.reason, run.id]);
      await client.query("UPDATE cloud_evolution_jobs SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
      await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'cluster',consumerId:run.cohort_id,runId:run.id,
        toStatus:'evaluated_rejected',rejectionKind:evidenceRejectionKindForReason(result.reason),
        transitionReason:result.reason||'evaluated_rejected',basisByEvidence:Object.fromEntries(basisByEvidence),clusterClaims:true});
    });
    return { runId: run.id, status: 'evaluated_rejected', reason: result.reason, gate: result.gate || null, reviews: result.reviews || [] };
  }
  const candidateId = `candidate_${crypto.randomUUID()}`;
  const approvedFamilyIds = result.approvedFamilyIds || result.familyResults?.filter((item) => item.status === 'approved').map((item) => item.familyId) || releaseFamilyIds;
  const familyId = approvedFamilyIds[0] || run.agent_family_id || members[0]?.agentFamilyId || '';
  const now = new Date();
  const shadowAvailableAt = new Date(now.getTime() + shadowDelayMs);
  const encryptedCases = encryptEvolutionPayload(JSON.stringify(result.shadowCases || []), keyring);
  const publicFamilyResults = (result.familyResults || []).map((item) => ({ familyId: item.familyId, status: item.status,
    revisionCount: item.revisionCount || 0, review: item.review, gate: item.gate,finalPrivacyReview:item.finalPrivacyReview,
    sectionIds: (item.sections || []).map((section) => section.sectionId), evaluationCount: (item.evaluations || []).length }));
  const payload = { id: candidateId, runId: run.id, cohortId: run.cohort_id, agentFamilyId: familyId, approvedFamilyIds,
    status: 'governance_approved', summary: result.proposal.summary || '', diagnosis: result.diagnosis, gate: result.gate,
    familyResults: publicFamilyResults, shadow: { ...result.shadow, availableAt: shadowAvailableAt.toISOString() } };
  await transaction(pool, async (client) => {
    await client.query(`INSERT INTO cloud_market_agent_candidates (
      id,cohort_id,agent_family_id,run_id,revision_no,diagnosis_json,gate_json,governance_json,status,
      shadow_started_at,payload_json
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,'governance_approved',now(),$9::jsonb)`, [candidateId, run.cohort_id,
      familyId, run.id, Math.max(0, ...publicFamilyResults.map((item) => item.revisionCount)), JSON.stringify(result.diagnosis || {}),
      JSON.stringify(result.gate || {}), JSON.stringify(publicFamilyResults), JSON.stringify(payload)]);
    for (const family of result.familyResults || []) {
      for (const section of family.sections || []) {
        const support=supportProofForSection(family,section.sectionId);
        await client.query(`INSERT INTO cloud_market_candidate_family_sections (
          candidate_id,agent_family_id,section_id,title,content_hash,content_json,support_count,status
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'governance_approved')`, [candidateId, family.familyId, section.sectionId, section.title,
          section.contentHash, JSON.stringify(section), support.supportCount]);
        for(const item of support.items||[])await client.query(`INSERT INTO cloud_market_candidate_section_supports (
          candidate_id,agent_family_id,section_id,evidence_id,user_agent_instance_id,contributor_id,evidence_handle,
          support_confidence,deterministic_pass,reviewer_pass,review_stage
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,true,$9)`,[candidateId,family.familyId,section.sectionId,item.evidenceId,
          item.agentInstanceId,item.contributorId,item.evidenceHandle,item.confidence,support.reviewStage||'initial_gate']);
      }
      if(family.finalPrivacyReview)await client.query(`INSERT INTO cloud_market_candidate_privacy_reviews (
        id,candidate_id,agent_family_id,review_stage,deterministic_status,reviewer_status,finding_codes_json,review_json
      ) VALUES($1,$2,$3,'final_pre_shadow',$4,$5,$6::jsonb,$7::jsonb)`,[stableId('privacy',candidateId,family.familyId,'final_pre_shadow'),
        candidateId,family.familyId,family.finalPrivacyReview.deterministicStatus||'failed',family.finalPrivacyReview.reviewerStatus||'not_run',
        JSON.stringify(family.finalPrivacyReview.findingCodes||[]),JSON.stringify(family.finalPrivacyReview)]);
    }
    await client.query(`INSERT INTO cloud_market_candidate_privacy_reviews (
      id,candidate_id,agent_family_id,review_stage,deterministic_status,reviewer_status,finding_codes_json,review_json
    ) VALUES($1,$2,'','initial_gate',$3,$4,$5::jsonb,$6::jsonb)`,[stableId('privacy',candidateId,'initial_gate'),candidateId,
      Number(result.gate?.privacyReport?.flagCount||0)?'failed':'passed',result.gate?.independentPrivacyReview?.status||'not_run',
      JSON.stringify(result.gate?.privacyReport?.flags||[]),JSON.stringify(result.gate?.independentPrivacyReview||{})]);
    for (const [index, item] of (result.evaluations || []).entries()) await client.query(`INSERT INTO cloud_market_evaluations (
      id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json
    ) VALUES ($1,$2,'pre_shadow_replay',$3,'completed',$4,$5,$6,$7::jsonb)`, [stableId('meval', candidateId, 'pre', index),
      candidateId, index, item.regression, item.privacyViolation, item.roleViolation, JSON.stringify(item)]);
    await client.query(`UPDATE cloud_evolution_run_snapshots SET shadow_cases_ciphertext=$1,shadow_cases_nonce=$2,
      shadow_cases_tag=$3,shadow_cases_algorithm=$4,shadow_cases_key_id=$5 WHERE run_id=$6`, [encryptedCases.ciphertext,
      encryptedCases.nonce, encryptedCases.tag, encryptedCases.algorithm, encryptedCases.keyId, run.id]);
    await client.query("UPDATE cloud_evolution_runs SET status='proposed',summary=$1,updated_at=now() WHERE id=$2", [result.proposal.summary || '', run.id]);
    await client.query(`UPDATE cloud_evolution_jobs SET job_kind='cluster_shadow',status='queued',attempt_count=0,
      available_at=$1,claimed_by='',lease_expires_at=NULL,error_code='',error_text='',updated_at=now(),completed_at=NULL WHERE id=$2`, [shadowAvailableAt, job.id]);
    await createPostgresEvidenceUsageLedger(client).refreshRunLease({ scope: 'cluster', runId: run.id,
      leaseMinutes: Math.max(30, Math.ceil(shadowDelayMs / 60000) + 30) });
  });
  return { runId: run.id, status: 'governance_approved', candidateId, approvedFamilyIds, shadowAvailableAt: shadowAvailableAt.toISOString() };
}

async function executeClusterShadow({ pool, job, modelExecutor, keyring, canaryMinimumUsers, canaryMinimumCases }) {
  const run = (await pool.query('SELECT * FROM cloud_evolution_runs WHERE id=$1', [job.run_id])).rows[0];
  const candidate = (await pool.query("SELECT * FROM cloud_market_agent_candidates WHERE run_id=$1 AND status='governance_approved'", [run.id])).rows[0];
  if (!candidate) throw codedError('cluster_shadow_candidate_missing', 'Cluster Shadow candidate is missing.', 500);
  const snapshot = (await pool.query('SELECT * FROM cloud_evolution_run_snapshots WHERE run_id=$1', [run.id])).rows[0];
  const shadowCases = JSON.parse(decryptEvolutionPayload({ algorithm: snapshot.shadow_cases_algorithm, keyId: snapshot.shadow_cases_key_id,
    ciphertext: snapshot.shadow_cases_ciphertext, nonce: snapshot.shadow_cases_nonce, tag: snapshot.shadow_cases_tag }, keyring) || '[]');
  const frozenMembers=snapshot.cohort_snapshot_json?.members;
  const members=Array.isArray(frozenMembers)&&frozenMembers.length?frozenMembers:(await pool.query('SELECT * FROM cloud_agent_cohort_members WHERE cohort_id=$1',[run.cohort_id])).rows
    .map((row)=>({ownerUserId:row.owner_user_id,agentInstanceId:row.user_agent_instance_id,agentFamilyId:row.agent_family_id}));
  const sectionRows = (await pool.query('SELECT * FROM cloud_market_candidate_family_sections WHERE candidate_id=$1 ORDER BY agent_family_id,section_id', [candidate.id])).rows;
  const grouped = new Map();
  for (const row of sectionRows) { const sections = grouped.get(row.agent_family_id) || []; sections.push(sectionPayload(row)); grouped.set(row.agent_family_id, sections); }
  const familyResults = [...grouped].map(([familyId, sections]) => ({ familyId, status: 'approved', sections }));
  const current = [];
  for (const family of familyResults) current.push(...(await latestSections(pool, family.familyId)).map((section) => ({ ...section, agentFamilyId: family.familyId })));
  const result = await runClusterShadowEvaluation({ familyResults, currentMarketSections: current, shadowCases, modelExecutor,
    minimumUsers: canaryMinimumUsers, minimumCases: canaryMinimumCases });
  if (result.status === 'insufficient') {
    await transaction(pool, async (client) => {
      await client.query("UPDATE cloud_market_agent_candidates SET status='archived',status_reason='shadow_insufficient',updated_at=now() WHERE id=$1", [candidate.id]);
      await client.query("UPDATE cloud_evolution_runs SET status='failed_retryable',error_code='shadow_insufficient',completed_at=now(),updated_at=now() WHERE id=$1", [run.id]);
      await client.query("UPDATE cloud_evolution_jobs SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
      await createPostgresEvidenceUsageLedger(client).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
        toStatus: 'released', transitionReason: 'shadow_insufficient', clusterClaims: true });
    });
    return { runId: run.id, candidateId: candidate.id, status: 'shadow_insufficient', ...result };
  }
  if (result.status !== 'approved') {
    await transaction(pool, async (client) => {
      await persistPostgresShadowEvaluations(client, candidate.id, result.evaluations);
      const basisByEvidence = await clusterReEvaluationBasisByEvidence(client, run.id);
      await client.query('UPDATE cloud_market_agent_candidates SET status=$1,status_reason=$2,updated_at=now() WHERE id=$3', [candidateRejectionStatus(result.reason), result.reason, candidate.id]);
      await client.query("UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code=$1,completed_at=now(),updated_at=now() WHERE id=$2", [result.reason, run.id]);
      await client.query("UPDATE cloud_evolution_jobs SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
      await createPostgresEvidenceUsageLedger(client).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
        toStatus: 'evaluated_rejected', rejectionKind: evidenceRejectionKindForReason(result.reason), transitionReason: result.reason,
        basisByEvidence: Object.fromEntries(basisByEvidence), clusterClaims: true });
    });
    return { runId: run.id, candidateId: candidate.id, status: 'evaluated_rejected', reason: result.reason };
  }
  await transaction(pool, async (client) => {
    await persistPostgresShadowEvaluations(client, candidate.id, result.evaluations);
    await client.query("UPDATE cloud_market_agent_candidates SET status='shadow_passed',shadow_completed_at=now(),status_reason='',payload_json=$1::jsonb,updated_at=now() WHERE id=$2", [JSON.stringify({ ...(candidate.payload_json || {}), shadow: result.shadow }), candidate.id]);
    await client.query("UPDATE cloud_market_candidate_family_sections SET status='shadow_passed' WHERE candidate_id=$1", [candidate.id]);
    await client.query("UPDATE cloud_evolution_runs SET status='proposed',summary=$1,updated_at=now() WHERE id=$2", ['Shadow passed; waiting for default real-user Canary.', run.id]);
    await client.query(`UPDATE cloud_evolution_jobs SET job_kind='cluster_canary',status='waiting_canary',
      claimed_by='',lease_expires_at=NULL,error_code='',error_text='',updated_at=now(),completed_at=NULL WHERE id=$1`, [job.id]);
    await createPostgresEvidenceUsageLedger(client).clearRunLease({scope:'cluster',runId:run.id});
  });
  return { runId: run.id, candidateId: candidate.id, status: 'shadow_passed', realCanaryAvailable: true };
}

async function ensurePostgresDefaultCanaryEnrollments(queryable, { userId = '', agentInstanceId = '' } = {}) {
  const filters=[];const values=[MARKET_CANARY_POLICY_VERSION];
  if(userId){values.push(userId);filters.push(`i.user_id=$${values.length}`);}
  if(agentInstanceId){values.push(agentInstanceId);filters.push(`i.id=$${values.length}`);}
  const where=filters.length?` AND ${filters.join(' AND ')}`:'';
  return (await queryable.query(`INSERT INTO cloud_market_canary_opt_ins (
      user_id,user_agent_instance_id,agent_family_id,policy_version,status,command_id,payload_json,created_at,updated_at)
    SELECT i.user_id,i.id,i.agent_family_id,$1,'active','',
      '{"enrollment":"default","explicitOptOut":false}'::jsonb,now(),now()
    FROM cloud_user_agent_instances_v3 i
    WHERE i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true${where}
    ON CONFLICT(user_id,user_agent_instance_id) DO UPDATE SET
      agent_family_id=excluded.agent_family_id,policy_version=excluded.policy_version,
      status=CASE WHEN cloud_market_canary_opt_ins.status='withdrawn' THEN 'withdrawn' ELSE 'active' END,
      payload_json=CASE WHEN cloud_market_canary_opt_ins.status='withdrawn'
        THEN cloud_market_canary_opt_ins.payload_json ELSE excluded.payload_json END,
      updated_at=CASE WHEN cloud_market_canary_opt_ins.status='withdrawn'
        THEN cloud_market_canary_opt_ins.updated_at ELSE now() END
    RETURNING *`,values)).rows;
}

async function reconcilePostgresCanaries({ pool, canaryMinimumUsers, canaryMinimumCases, canaryMinimumDurationMs, canaryMaximumDurationMs }) {
  const results=[];
  await ensurePostgresDefaultCanaryEnrollments(pool);
  const candidates=(await pool.query("SELECT * FROM cloud_market_agent_candidates WHERE status IN ('shadow_passed','canary_running') ORDER BY updated_at")).rows;
  for(const candidate of candidates){
    const run=(await pool.query('SELECT * FROM cloud_evolution_runs WHERE id=$1',[candidate.run_id])).rows[0];
    const job=(await pool.query("SELECT * FROM cloud_evolution_jobs WHERE run_id=$1 AND job_kind='cluster_canary'",[candidate.run_id])).rows[0];
    if(!run||!job)continue;
    if(candidate.status==='shadow_passed'){
      const familyIds=(await pool.query('SELECT DISTINCT agent_family_id FROM cloud_market_candidate_family_sections WHERE candidate_id=$1',[candidate.id])).rows.map((row)=>row.agent_family_id);
      const optIns=familyIds.length?(await pool.query(`SELECT o.* FROM cloud_market_canary_opt_ins o
        JOIN cloud_user_agent_instances_v3 i ON i.user_id=o.user_id AND i.id=o.user_agent_instance_id
        WHERE o.status='active' AND o.policy_version=$1 AND o.agent_family_id=ANY($2::text[])
          AND i.status='active' AND i.sync_enabled=true AND i.cluster_contribution_consent=true ORDER BY o.updated_at`,[MARKET_CANARY_POLICY_VERSION,familyIds])).rows:[];
      const userCount=new Set(optIns.map((row)=>row.user_id)).size;
      if(userCount<canaryMinimumUsers){results.push({candidateId:candidate.id,status:'waiting_canary',userCount});continue;}
      const baseline=await postgresMarketHealthBaseline(pool,run.cohort_id,optIns.map((row)=>row.user_agent_instance_id));const now=new Date();
      await transaction(pool,async(client)=>{
        for(const item of optIns)await client.query(`INSERT INTO cloud_market_canary_assignments
          (candidate_id,user_id,user_agent_instance_id,agent_family_id,policy_version,status,baseline_score,baseline_failure_rate,started_at,payload_json)
          VALUES($1,$2,$3,$4,$5,'enrolled',$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`,[candidate.id,item.user_id,item.user_agent_instance_id,
          item.agent_family_id,MARKET_CANARY_POLICY_VERSION,baseline.score,baseline.failureRate,now,JSON.stringify({defaultEnrollment:true})]);
        await client.query("UPDATE cloud_market_agent_candidates SET status='canary_running',canary_started_at=$1,canary_deadline_at=$2,status_reason='',updated_at=now() WHERE id=$3",[now,new Date(now.getTime()+canaryMaximumDurationMs),candidate.id]);
        await client.query("UPDATE cloud_market_candidate_family_sections SET status='canary_running' WHERE candidate_id=$1",[candidate.id]);
        await client.query("UPDATE cloud_evolution_runs SET status='canary',summary='Real-user Canary is running.',updated_at=now() WHERE id=$1",[run.id]);
      });
      results.push({candidateId:candidate.id,status:'canary_running',userCount});continue;
    }
    const assignments=(await pool.query("SELECT * FROM cloud_market_canary_assignments WHERE candidate_id=$1 AND status='enrolled'",[candidate.id])).rows;
    const instanceIds=assignments.map((row)=>row.user_agent_instance_id);
    const events=instanceIds.length?(await pool.query(`SELECT * FROM cloud_agent_performance_events WHERE authority='cloud' AND validation_status='validated'
      AND user_agent_instance_id=ANY($1::text[])`,[instanceIds])).rows:[];
    const startedByInstance=new Map(assignments.map((row)=>[row.user_agent_instance_id,new Date(row.started_at).getTime()]));
    const observed=events.filter((row)=>new Date(row.occurred_at).getTime()>=startedByInstance.get(row.user_agent_instance_id)).map(postgresPerformanceEventPayload);
    const evaluation=evaluateRealUserCanary({assignments:assignments.map(postgresCanaryAssignmentPayload),events:observed,
      minimumUsers:canaryMinimumUsers,minimumCases:canaryMinimumCases});
    await persistPostgresCanaryEvaluation(pool,candidate.id,evaluation);const now=new Date();
    if(evaluation.status==='insufficient'||now.getTime()-new Date(candidate.canary_started_at).getTime()<canaryMinimumDurationMs){
      if(candidate.canary_deadline_at&&now>new Date(candidate.canary_deadline_at))results.push(await rejectPostgresCanary(pool,{candidate,run,job,evaluation:{...evaluation,status:'insufficient',reason:'canary_insufficient'},terminal:false}));
      else results.push({candidateId:candidate.id,status:'canary_running',...evaluation});
      continue;
    }
    if(evaluation.status==='rejected'){results.push(await rejectPostgresCanary(pool,{candidate,run,job,evaluation,terminal:true}));continue;}
    const familyResults=await postgresCandidateFamilyResults(pool,candidate.id);
    const frozen=(await pool.query('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=$1',[run.id])).rows[0]?.cohort_snapshot_json?.members;
    const members=Array.isArray(frozen)?frozen:[];
    await transaction(pool,async(client)=>{
      await client.query("UPDATE cloud_market_agent_candidates SET status='canary_passed',status_reason='',updated_at=now() WHERE id=$1",[candidate.id]);
      await client.query("UPDATE cloud_market_candidate_family_sections SET status='canary_passed' WHERE candidate_id=$1",[candidate.id]);
      await client.query("UPDATE cloud_market_canary_assignments SET status='completed',completed_at=now() WHERE candidate_id=$1 AND status='enrolled'",[candidate.id]);
    });
    results.push(await publishPostgresMarketCandidate({pool,run,job,candidate:{...candidate,status:'canary_passed'},familyResults,members,canary:{canary:evaluation,evaluations:[]}}));
  }
  return results;
}

async function persistPostgresCanaryEvaluation(pool,candidateId,evaluation){
  await transaction(pool,async(client)=>{
    await client.query(`INSERT INTO cloud_market_canary_evaluations
      (id,candidate_id,policy_version,status,user_count,case_count,baseline_score,candidate_score,baseline_failure_rate,candidate_failure_rate,result_json,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now(),now()) ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status,
        user_count=excluded.user_count,case_count=excluded.case_count,baseline_score=excluded.baseline_score,candidate_score=excluded.candidate_score,
        baseline_failure_rate=excluded.baseline_failure_rate,candidate_failure_rate=excluded.candidate_failure_rate,result_json=excluded.result_json,updated_at=now()`,[
      stableId('canaryeval',candidateId),candidateId,MARKET_CANARY_POLICY_VERSION,evaluation.status,Number(evaluation.userCount||0),Number(evaluation.caseCount||0),
      Number(evaluation.baselineScore||0),Number(evaluation.candidateScore||0),Number(evaluation.baselineFailureRate||0),Number(evaluation.candidateFailureRate||0),JSON.stringify(evaluation)]);
    await client.query(`INSERT INTO cloud_market_evaluations
      (id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json)
      VALUES($1,$2,'real_user_canary',0,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO UPDATE SET status=excluded.status,
        regression=excluded.regression,privacy_violation=excluded.privacy_violation,role_violation=excluded.role_violation,result_json=excluded.result_json`,[
      stableId('meval',candidateId,'real_user_canary'),candidateId,evaluation.status,evaluation.status==='rejected',Boolean(evaluation.privacyViolation),Boolean(evaluation.roleViolation),JSON.stringify(evaluation)]);
  });
}

async function rejectPostgresCanary(pool,{candidate,run,job,evaluation,terminal}){
  const basisByEvidence=terminal?await clusterReEvaluationBasisByEvidence(pool,run.id):new Map();
  await transaction(pool,async(client)=>{
    await client.query('UPDATE cloud_market_agent_candidates SET status=$1,status_reason=$2,updated_at=now() WHERE id=$3',[terminal?'canary_rejected':'archived',evaluation.reason,candidate.id]);
    await client.query('UPDATE cloud_market_candidate_family_sections SET status=$1 WHERE candidate_id=$2',[terminal?'canary_rejected':'archived',candidate.id]);
    await client.query("UPDATE cloud_market_canary_assignments SET status=$1,completed_at=now() WHERE candidate_id=$2 AND status='enrolled'",[terminal?'rejected':'withdrawn',candidate.id]);
    await client.query('UPDATE cloud_evolution_runs SET status=$1,error_code=$2,completed_at=now(),updated_at=now() WHERE id=$3',[terminal?'evaluated_rejected':'failed_retryable',evaluation.reason,run.id]);
    await client.query("UPDATE cloud_evolution_jobs SET status='completed',error_code=$1,completed_at=now(),updated_at=now() WHERE id=$2",[evaluation.reason,job.id]);
    await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'cluster',consumerId:run.cohort_id,runId:run.id,
      toStatus:terminal?'evaluated_rejected':'released',rejectionKind:terminal?evidenceRejectionKindForReason(evaluation.reason):'',
      transitionReason:evaluation.reason,basisByEvidence:Object.fromEntries(basisByEvidence),clusterClaims:true});
  });
  return {candidateId:candidate.id,runId:run.id,status:terminal?'canary_rejected':'canary_insufficient',reason:evaluation.reason,evidenceStatus:terminal?'evaluated_rejected':'released'};
}

async function postgresCandidateFamilyResults(pool,candidateId){
  const grouped=new Map();
  for(const row of (await pool.query('SELECT * FROM cloud_market_candidate_family_sections WHERE candidate_id=$1 ORDER BY agent_family_id,section_id',[candidateId])).rows){
    const sections=grouped.get(row.agent_family_id)||[];sections.push(sectionPayload(row));grouped.set(row.agent_family_id,sections);
  }
  return [...grouped].map(([familyId,sections])=>({familyId,status:'approved',sections}));
}

function postgresCanaryAssignmentPayload(row){return {candidateId:row.candidate_id,ownerUserId:row.user_id,agentInstanceId:row.user_agent_instance_id,
  agentFamilyId:row.agent_family_id,status:row.status,baselineScore:Number(row.baseline_score||0),baselineFailureRate:Number(row.baseline_failure_rate||0),
  startedAt:row.started_at,completedAt:row.completed_at||'',candidateStatus:row.candidate_status||'',statusReason:row.status_reason||''};}

async function publishPostgresMarketCandidate({ pool, run, job, candidate, familyResults, members, canary }) {
  const releasedVersions = [];
  await transaction(pool, async (client) => {
    await persistPostgresShadowEvaluations(client, candidate.id, canary.evaluations);
    const measuredBaseline=await postgresMarketHealthBaseline(client,run.cohort_id);
    const baseline={score:measuredBaseline.score||Number(canary.canary?.baselineScore||0),
      failureRate:measuredBaseline.failureRate||Number(canary.canary?.baselineFailureRate||0)};
    for (const family of familyResults) {
      const versionId = `market_${crypto.randomUUID()}`;
      const parent = (await client.query("SELECT id FROM cloud_market_agent_versions WHERE agent_family_id=$1 AND status='released' ORDER BY created_at DESC LIMIT 1", [family.familyId])).rows[0]?.id || '';
      const publicSections = family.sections.map((section) => publicMarketSection(section, members));
      const sourceBase=await postgresMarketBaseSource(client,family.familyId);
      const baseSkillContent=[sourceBase.content.trim(),compileMarketEffectiveSkill({baseSections:publicSections})].filter(Boolean).join('\n\n');
      await client.query(`INSERT INTO cloud_market_agent_versions (
        id,agent_family_id,parent_version_id,version_kind,base_agent_version_id,status,sections_json,health_baseline_json,payload_json
      ) VALUES ($1,$2,$3,'market_base',$4,'released',$5::jsonb,$6::jsonb,$7::jsonb)`,[versionId,family.familyId,parent,sourceBase.versionId,
        JSON.stringify(publicSections.map((item)=>item.sectionId)),JSON.stringify(baseline),JSON.stringify({candidateId:candidate.id,
          canary:canary.canary,algorithmVersion:PHASE8_ALGORITHM_VERSION,sourceBaseSkillContent:sourceBase.content,baseSkillContent})]);
      for (const [ordinal, section] of publicSections.entries()) await client.query(`INSERT INTO cloud_market_version_sections
        (market_version_id,section_id,title,content_hash,content_json,ordinal) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [versionId, section.sectionId, section.title, section.contentHash, JSON.stringify(section), ordinal]);
      await client.query(`INSERT INTO cloud_market_version_health (market_version_id,baseline_score,baseline_failure_rate,status)
        VALUES ($1,$2,$3,'collecting')`, [versionId, baseline.score, baseline.failureRate]);
      releasedVersions.push({ familyId: family.familyId, versionId });
    }
    await client.query("UPDATE cloud_market_agent_candidates SET status='released',released_at=now(),status_reason='',updated_at=now() WHERE id=$1", [candidate.id]);
    await client.query("UPDATE cloud_market_candidate_family_sections SET status='released' WHERE candidate_id=$1", [candidate.id]);
    await client.query("UPDATE cloud_evolution_runs SET status='applied',completed_at=now(),updated_at=now() WHERE id=$1", [run.id]);
    await client.query("UPDATE cloud_evolution_jobs SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1", [job.id]);
    await createPostgresEvidenceUsageLedger(client).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
      toStatus: 'consumed', transitionReason: 'market_released', clusterClaims: true });
  });
  return { runId: run.id, candidateId: candidate.id, status: 'released', marketVersionId: releasedVersions[0]?.versionId || '', marketVersions: releasedVersions };
}

async function persistPostgresShadowEvaluations(client, candidateId, evaluations = []) {
  for (const [index, item] of evaluations.entries()) await client.query(`INSERT INTO cloud_market_evaluations (
    id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json
  ) VALUES ($1,$2,'async_cross_user_shadow',$3,'completed',$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`,
  [stableId('meval', candidateId, 'shadow', index), candidateId, index, item.regression, item.privacyViolation, item.roleViolation,
    JSON.stringify({ ...item, ownerUserId: undefined })]);
}

async function postgresMarketHealthBaseline(queryable,cohortId,instanceIds=[]) {
  let rows=(await queryable.query('SELECT payload_json FROM cloud_agent_cohort_members WHERE cohort_id=$1',[cohortId])).rows.map((row)=>row.payload_json?.performance||{});
  if(!rows.length&&instanceIds.length)rows=(await queryable.query('SELECT payload_json FROM cloud_agent_performance_levels WHERE user_agent_instance_id=ANY($1::text[])',[instanceIds])).rows.map((row)=>row.payload_json||{});
  const scores = rows.map((row) => Number(row.score || 0)).filter(Number.isFinite);
  const failures = rows.map((row) => Number(row.failureRate || 0)).filter(Number.isFinite);
  return { score: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0,
    failureRate: failures.length ? failures.reduce((sum, value) => sum + value, 0) / failures.length : 0 };
}

async function postgresMarketBaseSource(queryable,familyId){
  const member=(await queryable.query("SELECT base_agent_version_id FROM cloud_user_agent_instances_v3 WHERE agent_family_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1",[familyId])).rows[0];
  const versionId=member?.base_agent_version_id||'';
  const version=(await queryable.query('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=$1 AND agent_family_id=$2',[versionId,familyId])).rows[0];
  return {versionId,content:String(version?.payload_json?.baseSkillContent||version?.payload_json?.base_skill_content||version?.payload_json?.skill||'')};
}

async function projectSkill(pool, { userId, instance, marketVersionId, keyring }) {
  const adopted = (await pool.query(`SELECT a.*,v.created_at version_created_at FROM cloud_user_market_adoptions a
    JOIN cloud_market_agent_versions v ON v.id=a.market_version_id
    WHERE a.user_id=$1 AND a.user_agent_instance_id=$2 AND a.status='adopted' ORDER BY v.created_at,a.updated_at`, [userId, instance.id])).rows;
  const fullAdoption = adopted.filter((row) => row.section_id === '*').at(-1) || null;
  const fullVersion=fullAdoption?(await pool.query('SELECT * FROM cloud_market_agent_versions WHERE id=$1',[fullAdoption.market_version_id])).rows[0]:null;
  const baseSections = fullAdoption ? (await pool.query('SELECT * FROM cloud_market_version_sections WHERE market_version_id=$1 ORDER BY ordinal', [fullAdoption.market_version_id])).rows.map(sectionPayload) : [];
  const sectionRows = adopted.filter((row) => row.section_id !== '*');
  const sections = [];
  for (const row of sectionRows) {
    const section = (await pool.query('SELECT * FROM cloud_market_version_sections WHERE market_version_id=$1 AND section_id=$2', [row.market_version_id, row.section_id])).rows[0];
    if (section) sections.push(sectionPayload(section));
  }
  const canaryAssignment=(await pool.query(`SELECT a.candidate_id FROM cloud_market_canary_assignments a
    JOIN cloud_market_agent_candidates c ON c.id=a.candidate_id
    WHERE a.user_id=$1 AND a.user_agent_instance_id=$2 AND a.status='enrolled' AND c.status='canary_running'
    ORDER BY a.started_at DESC LIMIT 1`,[userId,instance.id])).rows[0];
  const canarySections=canaryAssignment?(await pool.query(`SELECT * FROM cloud_market_candidate_family_sections
    WHERE candidate_id=$1 AND agent_family_id=$2 ORDER BY section_id`,[canaryAssignment.candidate_id,instance.agent_family_id])).rows.map(sectionPayload):[];
  const overlay = await postgresOverlayText(pool, instance, keyring);
  const version = (await pool.query('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=$1 AND agent_family_id=$2', [instance.base_agent_version_id, instance.agent_family_id])).rows[0];
  const instanceBaseSkill=String(version?.payload_json?.baseSkillContent||version?.payload_json?.base_skill_content||version?.payload_json?.skill||'');
  const baseSkill=fullVersion?.version_kind==='market_base'
    ?String(fullVersion.payload_json?.sourceBaseSkillContent||fullVersion.payload_json?.baseSkillContent||instanceBaseSkill):instanceBaseSkill;
  const compiledSections = [...baseSections, ...sections, ...canarySections];
  const conflicts = deriveOverlayConflictIndex(overlay, compiledSections);
  const resolutions = { ...(fullAdoption?.payload_json?.conflictResolutions || {}),
    ...Object.fromEntries(sectionRows.map((row) => [row.section_id, row.payload_json?.conflictResolution || (conflicts.includes(row.section_id) ? 'personal' : 'none')])) };
  for (const sectionId of conflicts) if (!Object.hasOwn(resolutions, sectionId)) resolutions[sectionId] = 'personal';
  const marketSkill=compileMarketEffectiveSkill({baseSections,adoptedSections:[...sections,...canarySections],personalOverlay:overlay,conflictResolutions:resolutions});
  const effectiveSkill = [baseSkill.trim(), marketSkill.trim()].filter(Boolean).join('\n\n');
  const activeMarketVersionId = fullAdoption?.market_version_id || sectionRows.at(-1)?.market_version_id || marketVersionId || '';
  const payload = { userId, agentInstanceId: instance.id, marketVersionId: activeMarketVersionId,
    fullMarketVersionId: fullAdoption?.market_version_id || '', adoptedSections: sections.map((item) => item.sectionId),
    canaryCandidateId:canaryAssignment?.candidate_id||'',canarySections:canarySections.map((item)=>item.sectionId),
    conflicts: conflicts.map((sectionId) => ({ sectionId, resolution: resolutions[sectionId] || 'personal' })), effectiveSkill };
  await pool.query(`INSERT INTO cloud_effective_skill_projections (user_id,user_agent_instance_id,market_version_id,adopted_sections_json,conflicts_json,effective_skill_hash,payload_json,updated_at)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,now()) ON CONFLICT(user_id,user_agent_instance_id) DO UPDATE SET market_version_id=excluded.market_version_id,adopted_sections_json=excluded.adopted_sections_json,conflicts_json=excluded.conflicts_json,effective_skill_hash=excluded.effective_skill_hash,payload_json=excluded.payload_json,updated_at=now()`, [userId, instance.id, activeMarketVersionId, JSON.stringify(payload.adoptedSections), JSON.stringify(payload.conflicts), sha256(effectiveSkill), JSON.stringify(payload)]);
  return { status: 'applied', authority: 'cloud', ...payload, effectiveSkillHash: sha256(effectiveSkill) };
}

function normalizeAdoptionMode(mode) {
  const value = String(mode || 'sections').trim().toLowerCase();
  if (!['full', 'sections'].includes(value)) throw codedError('market_adoption_mode_invalid', 'Market adoption mode must be full or sections.', 400);
  return value;
}

async function evaluatePostgresMarketVersionHealth(pool, version, now = new Date()) {
  const health = (await pool.query('SELECT * FROM cloud_market_version_health WHERE market_version_id=$1', [version.id])).rows[0] || {};
  if (version.status === 'suspended') return marketHealthPayload(version, health);
  const adoptions = (await pool.query(`SELECT user_id,user_agent_instance_id,MIN(updated_at) adopted_at FROM cloud_user_market_adoptions
    WHERE market_version_id=$1 AND status='adopted' GROUP BY user_id,user_agent_instance_id`, [version.id])).rows;
  const userCount = new Set(adoptions.map((row) => row.user_id)).size;
  const instanceIds = [...new Set(adoptions.map((row) => row.user_agent_instance_id))];
  const levels = instanceIds.length ? (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=ANY($1::text[])', [instanceIds])).rows : [];
  const events = instanceIds.length ? (await pool.query('SELECT * FROM cloud_agent_performance_events WHERE user_agent_instance_id=ANY($1::text[]) ORDER BY occurred_at', [instanceIds])).rows : [];
  const scores = levels.map((row) => Number(row.score)).filter(Number.isFinite);
  const taskMap = new Map();
  let confirmedViolation = '';
  for (const row of events) {
    const payload = row.payload_json || {};
    taskMap.set(`${row.user_agent_instance_id}:${row.task_id || row.id}`, payload);
    if (payload.confirmedPrivacyViolation || payload.privacyViolationConfirmed) confirmedViolation = 'confirmed_privacy_violation';
    if (payload.confirmedRoleViolation || payload.roleViolationConfirmed) confirmedViolation ||= 'confirmed_role_violation';
  }
  const tasks = [...taskMap.values()];
  const observedTaskCount = tasks.length;
  const failureRate = observedTaskCount ? tasks.filter((item) => item.failed || item.blocked).length / observedTaskCount : 0;
  const latestScore = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const inputHash = sha256(JSON.stringify({ day: now.toISOString().slice(0, 10), versionId: version.id,
    users: adoptions.map((row) => row.user_id).sort(), levels: levels.map((row) => [row.user_agent_instance_id, row.score, row.completed_task_count, row.updated_at]),
    tasks: events.map((row) => [row.id, row.event_kind, row.occurred_at]) }));
  if (confirmedViolation) return suspendPostgresMarketVersion(pool, version, {
    reason: confirmedViolation, userCount, observedTaskCount, latestScore, failureRate, inputHash, now,
  });
  if (userCount < 3 || observedTaskCount < 10) {
    await pool.query(`UPDATE cloud_market_version_health SET user_count=$1,observed_task_count=$2,latest_score=$3,latest_failure_rate=$4,
      status='collecting',status_reason='insufficient_observations',updated_at=$5 WHERE market_version_id=$6`,
    [userCount, observedTaskCount, latestScore, failureRate, now, version.id]);
    return marketHealthPayload(version, (await pool.query('SELECT * FROM cloud_market_version_health WHERE market_version_id=$1', [version.id])).rows[0]);
  }
  if (health.last_input_hash === inputHash) return marketHealthPayload(version, health);
  const scoreRegression = Number(health.baseline_score || 0) - latestScore >= 10;
  const failureRegression = failureRate - Number(health.baseline_failure_rate || 0) >= 0.10;
  const regressing = scoreRegression || failureRegression;
  const windows = regressing ? Number(health.consecutive_regression_windows || 0) + 1 : 0;
  if (windows >= 2) return suspendPostgresMarketVersion(pool, version, { reason: scoreRegression ? 'score_regression_two_windows' : 'failure_regression_two_windows',
    userCount, observedTaskCount, latestScore, failureRate, inputHash, now, windows });
  await pool.query(`UPDATE cloud_market_version_health SET user_count=$1,observed_task_count=$2,latest_score=$3,latest_failure_rate=$4,
    consecutive_regression_windows=$5,last_input_hash=$6,status=$7,status_reason=$8,evaluated_at=$9,updated_at=$9 WHERE market_version_id=$10`,
  [userCount, observedTaskCount, latestScore, failureRate, windows, inputHash, regressing ? 'regressing' : 'healthy',
    regressing ? (scoreRegression ? 'score_regression' : 'failure_regression') : '', now, version.id]);
  return marketHealthPayload(version, (await pool.query('SELECT * FROM cloud_market_version_health WHERE market_version_id=$1', [version.id])).rows[0]);
}

async function suspendPostgresMarketVersion(pool, version, { reason, userCount, observedTaskCount, latestScore, failureRate, inputHash, now, windows = 2 }) {
  await transaction(pool, async (client) => {
    await client.query("UPDATE cloud_market_agent_versions SET status='suspended',suspended_at=$1,status_reason=$2 WHERE id=$3 AND status='released'", [now, reason, version.id]);
    await client.query(`UPDATE cloud_market_version_health SET user_count=$1,observed_task_count=$2,latest_score=$3,latest_failure_rate=$4,
      consecutive_regression_windows=$5,last_input_hash=$6,status='suspended',status_reason=$7,evaluated_at=$8,updated_at=$8 WHERE market_version_id=$9`,
    [userCount, observedTaskCount, latestScore, failureRate, windows, inputHash, reason, now, version.id]);
  });
  return marketHealthPayload({ ...version, status: 'suspended', suspended_at: now, status_reason: reason },
    (await pool.query('SELECT * FROM cloud_market_version_health WHERE market_version_id=$1', [version.id])).rows[0]);
}

function marketHealthPayload(version, row = {}) {
  return { marketVersionId: version.id, status: row.status || 'collecting', versionStatus: version.status,
    statusReason: row.status_reason || version.status_reason || '', userCount: Number(row.user_count || 0),
    observedTaskCount: Number(row.observed_task_count || 0), baselineScore: Number(row.baseline_score || 0), latestScore: Number(row.latest_score || 0),
    baselineFailureRate: Number(row.baseline_failure_rate || 0), latestFailureRate: Number(row.latest_failure_rate || 0),
    consecutiveRegressionWindows: Number(row.consecutive_regression_windows || 0), evaluatedAt: row.evaluated_at || '', suspendedAt: version.suspended_at || '' };
}

async function postgresOverlayText(pool, instance, keyring) {
  const overlayRow = instance.active_personal_skill_version_id ? (await pool.query('SELECT * FROM cloud_personal_skill_overlay_versions WHERE user_id=$1 AND id=$2', [instance.user_id, instance.active_personal_skill_version_id])).rows[0] : null;
  return overlayRow ? decryptEvolutionPayload({ algorithm: overlayRow.encryption_algorithm, keyId: overlayRow.key_id, ciphertext: overlayRow.content_ciphertext, nonce: overlayRow.content_nonce, tag: overlayRow.content_tag }, keyring) : '';
}

function marketConflictPreview({ userId, instance, marketVersionId, overlay, sections, conflictIds }) {
  return {
    status: 'conflict_required', authority: 'cloud', userId, agentInstanceId: instance.id, marketVersionId,
    conflicts: sections.filter((section) => conflictIds.includes(section.sectionId)).map((section) => ({
      sectionId: section.sectionId, title: section.title, marketContent: section.content, personalOverlay: overlay,
    })),
  };
}

async function claimJob(pool, workerId) {
  return transaction(pool, async (client) => {
    const rows = (await client.query(`UPDATE cloud_evolution_jobs
      SET status='claimed',claimed_by=$1,lease_expires_at=now()+interval '15 minutes',attempt_count=attempt_count+1,updated_at=now()
      WHERE id=(
        SELECT id FROM cloud_evolution_jobs
        WHERE job_kind IN ('cluster_evolution','cluster_shadow') AND
          ((status IN ('queued','failed_retryable') AND available_at<=now())
            OR (status IN ('claimed','running') AND lease_expires_at<=now()))
          AND attempt_count<max_attempts
        ORDER BY created_at LIMIT 1
      )
        AND job_kind IN ('cluster_evolution','cluster_shadow') AND
          ((status IN ('queued','failed_retryable') AND available_at<=now())
            OR (status IN ('claimed','running') AND lease_expires_at<=now()))
        AND attempt_count<max_attempts
      RETURNING *`, [workerId])).rows;
    if (rows[0]) await createPostgresEvidenceUsageLedger(client).refreshRunLease({scope:'cluster',runId:rows[0].run_id,leaseMinutes:15});
    return rows[0] || null;
  });
}
async function failJob(pool,job,error) { const terminal=Number(job.attempt_count||0)>=Number(job.max_attempts||3); await transaction(pool,async(client)=>{
  if(job.job_kind==='cluster_shadow') await client.query("UPDATE cloud_market_agent_candidates SET status='archived',status_reason=$1,updated_at=now() WHERE run_id=$2 AND status='governance_approved'",[error.code||'cluster_worker_failed',job.run_id]);
  await client.query('UPDATE cloud_evolution_jobs SET status=$1,error_code=$2,error_text=$3,lease_expires_at=NULL,updated_at=now(),completed_at=now() WHERE id=$4',[terminal?'failed_terminal':'completed',error.code||'cluster_worker_failed',String(error.message||error).slice(0,2000),job.id]);
  const run=(await client.query('SELECT * FROM cloud_evolution_runs WHERE id=$1',[job.run_id])).rows[0];
  await client.query('UPDATE cloud_evolution_runs SET status=$1,error_code=$2,error_text=$3,updated_at=now(),completed_at=now() WHERE id=$4',[terminal?'failed_terminal':'failed_retryable',error.code||'cluster_worker_failed',String(error.message||error).slice(0,2000),job.run_id]);
  await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'cluster',consumerId:run?.cohort_id||'',runId:job.run_id,toStatus:'released',transitionReason:'infrastructure_failure',clusterClaims:true});
}); return {runId:job.run_id,status:terminal?'failed_terminal':'failed_retryable',error:error.message||String(error)}; }
async function clusterReEvaluationBasisByEvidence(queryable, runId) {
  const run = (await queryable.query('SELECT * FROM cloud_evolution_runs WHERE id=$1', [runId])).rows[0];
  const cohort = (await queryable.query('SELECT * FROM cloud_agent_cohorts WHERE id=$1', [run?.cohort_id || ''])).rows[0];
  const snapshot=(await queryable.query('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=$1',[runId])).rows[0];
  const frozen=snapshot?.cohort_snapshot_json?.members;
  const memberIds=Array.isArray(frozen)&&frozen.length?frozen.map((row)=>row.agentInstanceId):(await queryable.query('SELECT user_agent_instance_id FROM cloud_agent_cohort_members WHERE cohort_id=$1',[run?.cohort_id||''])).rows.map((row)=>row.user_agent_instance_id);
  const evidence = memberIds.length ? (await queryable.query(`SELECT * FROM cloud_evolution_evidence
    WHERE user_agent_instance_id=ANY($1::text[]) AND quarantine_reason='' AND validation_status='validated' AND historical_inactive=false AND metadata_json::text LIKE '%"cluster"%'`, [memberIds])).rows : [];
  const relatedByCategory = new Map();
  for (const row of evidence) {
    const category = clusterEvidenceCategory(row.source_kind);
    if (!relatedByCategory.has(category)) relatedByCategory.set(category, []);
    relatedByCategory.get(category).push(row.evidence_id);
  }
  const basisByCategory = new Map([...relatedByCategory].map(([category, ids]) => [category, clusterReEvaluationBasisHash({
    cohortKey: cohort?.cohort_key || cohort?.payload_json?.cohortKey || `legacy:${run?.cohort_id || ''}`,
    evidenceCategory: category, algorithmVersion: run?.algorithm_version || PHASE8_ALGORITHM_VERSION,
    policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION, relatedEvidenceIds: ids,
  })]));
  const rows = (await queryable.query(`SELECT e.evidence_id,e.source_kind FROM cloud_evolution_evidence e
    JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    WHERE u.run_id=$1 AND u.evolution_scope='cluster'`, [runId])).rows;
  return new Map(rows.map((row) => [row.evidence_id, basisByCategory.get(clusterEvidenceCategory(row.source_kind)) || '']));
}
async function postgresTaskPerformanceSource(queryable,{ownerUserId='',agentInstanceId='',sourceId=''}={}){
  const row=(await queryable.query(`SELECT n.*,r.owner_user_id,r.payload_json AS run_payload,
      i.user_id AS instance_user_id,i.agent_family_id
    FROM cloud_task_nodes n JOIN cloud_task_runs r ON r.id=n.task_run_id
    JOIN cloud_user_agent_instances_v3 i ON i.id=n.user_agent_instance_id WHERE n.id=$1`,[sourceId])).rows[0];
  if(!row)return null;
  if((ownerUserId&&row.owner_user_id!==ownerUserId)||(agentInstanceId&&row.user_agent_instance_id!==agentInstanceId)
    ||row.instance_user_id!==row.owner_user_id)throw codedError('performance_source_identity_mismatch',
      'Performance source does not belong to the granted Agent instance.',403);
  const node={...(row.payload_json||{}),id:row.id,task_run_id:row.task_run_id,
    user_agent_instance_id:row.user_agent_instance_id,updated_at:row.updated_at};
  const run={...(row.run_payload||{}),id:row.task_run_id,owner_user_id:row.owner_user_id};
  const instance={id:row.user_agent_instance_id,user_id:row.instance_user_id,agent_family_id:row.agent_family_id};
  const event=deriveAuthoritativeTaskPerformanceEvent({node,run,instance,sourceVersionId:new Date(row.updated_at).toISOString()});
  if(!event)return null;
  event.occurredAt=new Date(row.updated_at).toISOString();
  event.id=stableId('pevent',event.ownerUserId,event.agentInstanceId,event.sourceKind,event.sourceId,event.sourceVersionId);
  return event;
}
async function persistPostgresPerformanceEvent(pool,event,{keyring,envelopeKeyring,requireEnvelope=false}={}){
  return transaction(pool,async(client)=>{
    const inserted=await client.query(`INSERT INTO cloud_agent_performance_events (
      id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,task_type_key,event_kind,occurred_at,
      source_kind,source_id,source_version_id,source_hash,authority,validation_status,payload_json
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'cloud','validated',$13::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[
      event.id,event.ownerUserId,event.agentInstanceId,event.agentFamilyId,event.taskId,event.taskTypeKey,event.eventKind,event.occurredAt,
      event.sourceKind,event.sourceId,event.sourceVersionId,event.sourceHash,JSON.stringify(event),
    ]);
    if(inserted.rows.length)await createPostgresAuthoritativeEvidence(client,{keyring,envelopeKeyring,requireEnvelope,
      ownerUserId:event.ownerUserId,userAgentInstanceId:event.agentInstanceId,agentFamilyId:event.agentFamilyId,
      sourceKind:'model_execution_metric',sourceId:event.id,sourceVersionId:event.sourceVersionId,content:event,taskId:event.taskId,
      occurredAt:event.occurredAt,confidence:1,metadata:{performanceEventKind:event.eventKind,sourceKind:event.sourceKind,sourceId:event.sourceId}});
    return inserted.rowCount;
  });
}
function postgresPerformanceEventPayload(row){return {...(row.payload_json||{}),agentInstanceId:row.user_agent_instance_id,
  agentFamilyId:row.agent_family_id,sourceKind:row.source_kind,sourceId:row.source_id,sourceVersionId:row.source_version_id,
  authority:row.authority,validationStatus:row.validation_status};}
async function skipClusterRunForWeightCap(pool, { cohort, cohortId, triggerKind, evidenceCount, userCount, evaluationIntervalMs }) {
  const runId = `clrun_${crypto.randomUUID()}`;
  const summary = `At least ${CLUSTER_MIN_USERS} positive-weight users are required to enforce the ${CLUSTER_USER_WEIGHT_CAP} user weight cap.`;
  await pool.query(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count,summary,error_code,completed_at)
    VALUES ($1,'cluster',$2,$3,$3,$4,$5,'skipped',$6,$7,'insufficient_users_for_weight_cap',now())`,
  [runId, cohort.agent_family_id || '', cohortId, PHASE8_ALGORITHM_VERSION, triggerKind, evidenceCount, summary]);
  return {
    status: 'insufficient_users_for_weight_cap', runId, evidenceCount, userCount,
    minimumUsers: CLUSTER_MIN_USERS, maximumUserWeightShare: CLUSTER_USER_WEIGHT_CAP,
    nextEligibleAt: new Date(Date.now() + evaluationIntervalMs).toISOString(),
  };
}
function distinctWeightUserCount(items) { return new Set(items.filter((item) => Number(item.rawWeight || 0) > 0).map((item) => String(item.ownerUserId || '')).filter(Boolean)).size; }
async function latestSections(pool, familyId) { const row = (await pool.query("SELECT id FROM cloud_market_agent_versions WHERE agent_family_id=$1 AND status='released' ORDER BY created_at DESC LIMIT 1", [familyId])).rows[0]; return row ? (await pool.query('SELECT * FROM cloud_market_version_sections WHERE market_version_id=$1 ORDER BY ordinal', [row.id])).rows.map(sectionPayload) : []; }
async function postgresMarketCandidatePayload(pool, row) {
  const sections = (await pool.query(`SELECT agent_family_id,section_id,title,content_hash,support_count,status
    FROM cloud_market_candidate_family_sections WHERE candidate_id=$1 ORDER BY agent_family_id,section_id`, [row.id])).rows;
  const evaluations = (await pool.query(`SELECT evaluation_kind,case_index,status,regression,privacy_violation,role_violation
    FROM cloud_market_evaluations WHERE candidate_id=$1 ORDER BY evaluation_kind,case_index`, [row.id])).rows;
  return { ...row.payload_json, id: row.id, status: row.status, statusReason: row.status_reason || '', revisionNo: Number(row.revision_no || 0),
    diagnosis: row.diagnosis_json || {}, gate: row.gate_json || {}, governance: row.governance_json || [],
    shadowStartedAt: row.shadow_started_at || '', shadowCompletedAt: row.shadow_completed_at || '',
    canaryStartedAt: row.canary_started_at || '', canaryDeadlineAt: row.canary_deadline_at || '', releasedAt: row.released_at || '',
    familySections: sections.map((item) => ({ agentFamilyId: item.agent_family_id, sectionId: item.section_id, title: item.title,
      contentHash: item.content_hash, supportCount: Number(item.support_count || 0), status: item.status })),
    evaluations: evaluations.map((item) => ({ evaluationKind: item.evaluation_kind, caseIndex: Number(item.case_index || 0), status: item.status,
      regression: Boolean(item.regression), privacyViolation: Boolean(item.privacy_violation), roleViolation: Boolean(item.role_violation) })),
    createdAt: row.created_at, updatedAt: row.updated_at };
}
async function versionPayload(pool, row, { userId = '', agentInstanceId = '' } = {}) {
  const adoptions = userId && agentInstanceId ? (await pool.query(`SELECT section_id,adoption_mode,status,payload_json,updated_at
    FROM cloud_user_market_adoptions WHERE user_id=$1 AND user_agent_instance_id=$2 AND market_version_id=$3 ORDER BY section_id`, [userId, agentInstanceId, row.id])).rows : [];
  const health = (await pool.query('SELECT * FROM cloud_market_version_health WHERE market_version_id=$1', [row.id])).rows[0];
  return { id: row.id, agentFamilyId: row.agent_family_id, parentVersionId: row.parent_version_id,
    versionKind: row.version_kind || 'legacy_sections', baseAgentVersionId: row.base_agent_version_id || '', status: row.status,
    suspendedAt: row.suspended_at || '', statusReason: row.status_reason || '',
    sections: (await pool.query('SELECT * FROM cloud_market_version_sections WHERE market_version_id=$1 ORDER BY ordinal', [row.id])).rows.map(sectionPayload),
    adoption: { full: adoptions.find((item) => item.section_id === '*')?.status || '', sections: Object.fromEntries(adoptions.filter((item) => item.section_id !== '*').map((item) => [item.section_id, item.status])) },
    health: health ? marketHealthPayload(row, health) : null, ...row.payload_json, createdAt: row.created_at };
}
function sectionPayload(row) { return { ...row.content_json, sectionId: row.content_json?.sectionId || row.section_id, title: row.content_json?.title || row.title, contentHash: row.content_json?.contentHash || row.content_hash, supportCount:Number((row.support_count??row.content_json?.supportCount)||0) }; }
function publicMarketSection(section) { return { ...section, supportCount: Number(section.supportCount || 0) }; }
function supportProofForSection(family,sectionId){return (family.supportProofs||[]).find((item)=>item.sectionId===sectionId)
  ||{sectionId,supportCount:0,items:[],reviewStage:'unknown'};}
function candidateRejectionStatus(reason = '') {
  const kind = evidenceRejectionKindForReason(reason);
  if (kind === 'privacy') return 'privacy_rejected';
  if (kind === 'regression') return 'regression_rejected';
  if (kind === 'hr_review' || kind === 'mixed') return 'governance_rejected';
  return 'gate_rejected';
}
async function auditClusterEvidenceAccess(queryable, {
  workerIdentity = 'evolution-worker',
  runId = '',
  evidenceId = '',
  result,
  resultCode = '',
  keyId = '',
  detail = {},
} = {}) {
  await queryable.query(`INSERT INTO cloud_evolution_evidence_access_audits
    (id,worker_identity,run_id,evidence_id,purpose,result,result_code,key_id,detail_json)
    VALUES($1,$2,$3,$4,'cluster_evolution',$5,$6,$7,$8::jsonb)`, [
    `evaudit_${crypto.randomUUID()}`,
    workerIdentity,
    runId,
    evidenceId,
    result,
    resultCode,
    keyId,
    JSON.stringify(detail),
  ]);
}
async function transaction(pool, callback) { const client = await pool.connect(); try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }

function marketEvidenceSourceKind(action='') {
  return action === 'adopt' ? 'market_adoption' : action === 'rollback' ? 'market_rollback' : 'market_rejection';
}
function stableId(prefix, ...parts) { return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`; }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function uniqueStrings(values = []) { return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]; }
function assertEnabled(enabled) { if (!enabled) throw codedError('phase8_not_enabled', 'Stage 8 evolution is not enabled.', 409); }
function assertClusterReady({ enabled, modelAvailable, encryptionAvailable }) { assertEnabled(enabled); if (!encryptionAvailable) throw codedError('evolution_encryption_key_unavailable', 'Evolution evidence encryption is not configured.', 503); if (!modelAvailable) throw codedError('evolution_worker_unavailable', 'Cluster evolution model is not configured.', 503); }
function assertMarketReady({ enabled, encryptionAvailable }) { assertEnabled(enabled); if (!encryptionAvailable) throw codedError('evolution_encryption_key_unavailable', 'Evolution overlay encryption is not configured.', 503); }
function clusterEvidenceSnapshot(row) { return { evidenceId: row.evidence_id, evidenceCategory: row.evidenceCategory || clusterEvidenceCategory(row.source_kind), eligibilityKind: row.eligibilityKind || 'new', rawWeight: row.rawWeight, effectiveWeight: row.effectiveWeight, cohortRawTotal: row.cohortRawTotal, userCap: row.userCap }; }
function clusterEvidenceRecord(row) { return { ...row, evidenceId: row.evidence_id, agentInstanceId: row.user_agent_instance_id, ownerUserId: row.owner_user_id, sourceKind: row.source_kind }; }
function nonnegativeInteger(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback; }
function clusterCadence(run, { evaluationIntervalMs, retryIntervalMs }) { if (!run?.created_at) return { deferred: false, nextEligibleAt: '' }; const interval = run.status === 'failed_retryable' ? retryIntervalMs : evaluationIntervalMs; const next = new Date(run.created_at).getTime() + interval; return { deferred: Date.now() < next, nextEligibleAt: new Date(next).toISOString() }; }
async function userEvolutionEnabled(pool, userId = '') {
  return true;
}
function codedError(code, message, status = 400, details = {}) { const error = new Error(message); error.code = code; error.status = status; error.details = details; return error; }
