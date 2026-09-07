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
} from '../../../shared/evolution/phase8.js';
import { decryptEvolutionPayload, encryptEvolutionPayload, evolutionEncryptionReady, evolutionWorkerDecryptionKeyringFromEnv } from '../../../shared/evolution/crypto.js';
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
} from '../../../shared/evolution/contracts.js';
import { normalizeCloudTriggerKind } from '../../../shared/cloudContracts.js';
import { createSqliteAuthoritativeEvidence } from './authoritativeEvidence.js';
import { createSqliteEvidenceUsageLedger } from './evidenceUsageLedger.js';

export function createStage8Authority({ db, env = process.env, modelExecutor, keyring } = {}) {
  if (!db) throw new Error('Stage 8 authority requires a database.');
  const enabled = true;
  const databaseAvailable = Boolean(db);
  const usageLedger = createSqliteEvidenceUsageLedger(db);
  const resolvedKeyring = keyring || evolutionWorkerDecryptionKeyringFromEnv(env);
  const modelAvailable = typeof modelExecutor === 'function' && modelExecutor.available !== false;
  const encryptionAvailable = evolutionEncryptionReady(resolvedKeyring) || Boolean(resolvedKeyring.allowPlaintextTestOnly);
  const clusterAvailable = databaseAvailable && modelAvailable && encryptionAvailable;
  const evidenceThresholds = clusterEvidenceThresholdsFromEnv(env);
  const evaluationIntervalMs = nonnegativeInteger(env.JANUS_PHASE8_CLUSTER_EVALUATION_INTERVAL_MS, 86400000);
  const retryIntervalMs = nonnegativeInteger(env.JANUS_PHASE8_CLUSTER_RETRY_INTERVAL_MS, 900000);
  const shadowDelayMs = nonnegativeInteger(env.JANUS_PHASE8_SHADOW_DELAY_MS, 0);
  const canaryMinimumUsers = Math.max(CLUSTER_MIN_USERS, nonnegativeInteger(env.JANUS_PHASE8_CANARY_MIN_USERS, CLUSTER_MIN_USERS));
  const canaryMinimumCases = Math.max(CLUSTER_MIN_USERS, nonnegativeInteger(env.JANUS_PHASE8_CANARY_MIN_CASES, CLUSTER_MIN_USERS));
  const canaryMinimumDurationMs = nonnegativeInteger(env.JANUS_MARKET_CANARY_MIN_DURATION_MS, 86400000);
  const canaryMaximumDurationMs = Math.max(canaryMinimumDurationMs, nonnegativeInteger(env.JANUS_MARKET_CANARY_MAX_DURATION_MS, 7 * 86400000));
  return {
    capabilities() {
      return {
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
      };
    },

    recordPerformanceEvents(items = []) {
      assertEnabled(enabled);
      const accepted = [];
      const deferred = [];
      const rejected = [];
      let inserted = 0;
      for (const item of items) {
        const sourceId = String(item.sourceId || item.source_id || '');
        if ((item.sourceKind || item.source_kind) !== 'task_node' || !sourceId) {
          rejected.push({ sourceId, code: 'performance_source_reference_required' });
          continue;
        }
        try {
          const resolved = sqliteTaskPerformanceSource(db, { ownerUserId: item.ownerUserId, agentInstanceId: item.agentInstanceId, sourceId });
          if (!resolved) { deferred.push({ sourceId, code: 'performance_source_not_ready' }); continue; }
          const changes = persistSqlitePerformanceEvent(db, resolved, resolvedKeyring);
          inserted += changes;
          accepted.push({ sourceId, sourceVersionId: resolved.sourceVersionId, status: changes ? 'accepted' : 'duplicate' });
        } catch(error) { rejected.push({sourceId,code:error.code||'performance_source_rejected'}); }
      }
      return { status: deferred.length || rejected.length ? 'partial' : 'recorded', inserted, accepted, deferred, rejected };
    },

    refreshPerformanceEvents({ limit = 500 } = {}) {
      assertEnabled(enabled);
      const maximum = Math.min(2000, Math.max(1, Number(limit || 500)));
      const cursor = db.prepare("SELECT * FROM cloud_performance_backfill_cursors WHERE cursor_key='task_nodes'").get()
        || { last_updated_at: '', last_source_id: '' };
      const rows = db.prepare(`SELECT * FROM cloud_task_nodes WHERE
        (updated_at>? OR (updated_at=? AND id>?)) ORDER BY updated_at,id LIMIT ?`).all(
        cursor.last_updated_at || '', cursor.last_updated_at || '', cursor.last_source_id || '', maximum,
      );
      let inserted = 0;
      for (const row of rows) {
        const resolved = sqliteTaskPerformanceSource(db, { sourceId: row.id });
        if (resolved) inserted += persistSqlitePerformanceEvent(db, resolved, resolvedKeyring);
      }
      if (rows.length) db.prepare(`UPDATE cloud_performance_backfill_cursors SET last_updated_at=?,last_source_id=?,status=?,updated_at=?
        WHERE cursor_key='task_nodes'`).run(rows.at(-1).updated_at, rows.at(-1).id, rows.length < maximum ? 'completed' : 'active', new Date().toISOString());
      return { status: rows.length < maximum ? 'completed' : 'active', scanned: rows.length, inserted };
    },

    calculatePerformance({ agentInstanceId = '', now = new Date() } = {}) {
      assertEnabled(enabled);
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE id = ?').get(agentInstanceId);
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance was not found.', 404);
      const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
      const population = db.prepare(`SELECT * FROM cloud_agent_performance_events WHERE authority='cloud' AND validation_status='validated'
        AND occurred_at>=? ORDER BY occurred_at DESC LIMIT 10000`).all(cutoff).map(sqlitePerformanceEventPayload);
      const events = enrichPerformanceEventsWithPeerBaselines(population.filter((item) => item.agentInstanceId === agentInstanceId), population);
      const snapshot = calculatePerformanceSnapshot(events, { now });
      const id = stableId('plevel', instance.id, snapshot.algorithmVersion, snapshot.inputHash);
      const nowIso = now.toISOString();
      transaction(db, () => {
        db.prepare(`INSERT OR IGNORE INTO cloud_agent_performance_history (
          id,user_agent_instance_id,algorithm_version,window_started_at,window_ended_at,input_hash,score,level,provisional,payload_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, instance.id, snapshot.algorithmVersion, snapshot.windowStartedAt, snapshot.windowEndedAt, snapshot.inputHash, snapshot.score, snapshot.level, snapshot.provisional ? 1 : 0, JSON.stringify(snapshot), nowIso);
        db.prepare(`INSERT INTO cloud_agent_performance_levels (
          user_agent_instance_id,agent_family_id,score,level,provisional,completed_task_count,payload_json,updated_at
        ) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_agent_instance_id) DO UPDATE SET
          agent_family_id=excluded.agent_family_id,score=excluded.score,level=excluded.level,provisional=excluded.provisional,
          completed_task_count=excluded.completed_task_count,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
          instance.id, instance.agent_family_id, snapshot.score, snapshot.level, snapshot.provisional ? 1 : 0, snapshot.completedTaskCount, JSON.stringify(snapshot), nowIso,
        );
      });
      return { ...snapshot, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id };
    },

    calculateAllPerformance() {
      assertEnabled(enabled);
      this.refreshPerformanceEvents();
      return db.prepare("SELECT id FROM cloud_user_agent_instances_v3 WHERE status='active' AND sync_enabled=1").all().map((row) => this.calculatePerformance({ agentInstanceId: row.id }));
    },

    performance({ agentInstanceId = '' } = {}) {
      const row = db.prepare('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(agentInstanceId);
      if (!row) return null;
      return { agentInstanceId: row.user_agent_instance_id, agentFamilyId: row.agent_family_id, score: Number(row.score), level: row.level, provisional: Boolean(row.provisional), completedTaskCount: Number(row.completed_task_count), ...parseObject(row.payload_json) };
    },

    performanceHistory({ agentInstanceId = '', limit = 30 } = {}) {
      return db.prepare('SELECT * FROM cloud_agent_performance_history WHERE user_agent_instance_id=? ORDER BY created_at DESC LIMIT ?').all(agentInstanceId, Math.min(100, Number(limit || 30))).map((row) => ({ id: row.id, ...parseObject(row.payload_json), createdAt: row.created_at }));
    },

    refreshCohorts({ refreshPerformance = true } = {}) {
      assertEnabled(enabled);
      if (refreshPerformance) this.calculateAllPerformance();
      const levels = new Map(db.prepare('SELECT * FROM cloud_agent_performance_levels').all().map((row) => [row.user_agent_instance_id, row]));
      const families = new Map(db.prepare('SELECT * FROM cloud_agent_families_v3').all().map((row) => [row.id, { ...row, payload: parseObject(row.payload_json) }]));
      const instances = db.prepare("SELECT * FROM cloud_user_agent_instances_v3 WHERE status='active' AND sync_enabled=1 AND cluster_contribution_consent=1").all().map((row) => {
        const family = families.get(row.agent_family_id) || {};
        const payload = parseObject(row.payload_json);
        return { ownerUserId: row.user_id, agentInstanceId: row.id, agentFamilyId: row.agent_family_id, departmentId: family.department_id || payload.departmentId || '', status: row.status, syncEnabled: Boolean(row.sync_enabled), capabilityTags: uniqueStrings(family.payload?.capabilityTags || family.payload?.capability_tags || payload.capabilityTags || []), performance: levels.get(row.id) };
      });
      const evidence = db.prepare("SELECT * FROM cloud_evolution_evidence WHERE quarantine_reason='' AND validation_status='validated' AND historical_inactive=0 AND json_extract(metadata_json,'$.allowedEvolutionScopes') LIKE '%cluster%'").all();
      const usages = db.prepare("SELECT * FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster'").all();
      const claims = db.prepare('SELECT * FROM cloud_cluster_evidence_claims').all();
      const cohortsByKey = new Map(db.prepare('SELECT * FROM cloud_agent_cohorts').all().map((row) => [row.cohort_key || parseObject(row.payload_json).cohortKey || '', row]));
      const evidenceForCohort = ({ key, members }) => {
        const cohortId = cohortsByKey.get(key)?.id || stableClusterCohortId(key);
        const memberIds = new Set(members.map((member) => member.agentInstanceId));
        const scopedEvidence = evidence.filter((row) => memberIds.has(row.user_agent_instance_id)).map(clusterEvidenceRecord);
        return selectClusterEligibleEvidence({
          cohortKey: key,
          evidence: scopedEvidence,
          usage: usages.filter((row) => row.consumer_id === cohortId),
          claims,
          algorithmVersion: PHASE8_ALGORITHM_VERSION,
          policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION,
        }).filter((row) => row.eligibilityKind !== 'reconsiderable');
      };
      const eligibility = buildCohortEligibility({ instances, evidenceForCohort, evidenceThresholds });
      const now = new Date().toISOString();
      const resolvedIds = new Map();
      transaction(db, () => {
        db.prepare("UPDATE cloud_agent_cohorts SET status='inactive',updated_at=? WHERE status='active'").run(now);
        for (const item of eligibility) {
          const id = cohortsByKey.get(item.cohortKey)?.id || stableClusterCohortId(item.cohortKey);
          resolvedIds.set(item.cohortKey, id);
          const payload = { ...item, id, identityVersion: CLUSTER_COHORT_IDENTITY_VERSION,
            minimumUserCount: CLUSTER_MIN_USERS, maximumUserWeightShare: CLUSTER_USER_WEIGHT_CAP,
            participationPolicyVersion: CLUSTER_PARTICIPATION_POLICY_VERSION, updatedAt: now };
          db.prepare(`INSERT INTO cloud_agent_cohorts (id,cohort_key,identity_version,agent_family_id,department_id,capability_tags_json,
            minimum_user_count,maximum_user_weight_share,participation_policy_version,status,payload_json,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cohort_key=excluded.cohort_key,identity_version=excluded.identity_version,
              agent_family_id=excluded.agent_family_id,department_id=excluded.department_id,status=excluded.status,
              capability_tags_json=excluded.capability_tags_json,minimum_user_count=excluded.minimum_user_count,
              maximum_user_weight_share=excluded.maximum_user_weight_share,participation_policy_version=excluded.participation_policy_version,
              payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
            id, item.cohortKey, CLUSTER_COHORT_IDENTITY_VERSION, item.familyId || '', item.departmentId || '', JSON.stringify(item.capabilityTags),
            CLUSTER_MIN_USERS,CLUSTER_USER_WEIGHT_CAP,CLUSTER_PARTICIPATION_POLICY_VERSION,
            item.eligible ? 'active' : 'ineligible', JSON.stringify(payload), now, now,
          );
          db.prepare('DELETE FROM cloud_agent_cohort_members WHERE cohort_id=?').run(id);
          if (item.eligible || item.type === 'family') {
            for (const member of item.members) {
              const memberEvidence=db.prepare(`SELECT evidence_id FROM cloud_evolution_evidence WHERE user_agent_instance_id=? AND quarantine_reason='' AND validation_status='validated' AND historical_inactive=0
                AND json_extract(metadata_json,'$.allowedEvolutionScopes') LIKE '%cluster%'
                AND NOT EXISTS (SELECT 1 FROM cloud_cluster_evidence_claims c
                  WHERE c.evidence_id=cloud_evolution_evidence.evidence_id AND c.claim_state='consumed')`).all(member.agentInstanceId);
              for (const evidence of memberEvidence) usageLedger.ensureAvailable({evidenceId:evidence.evidence_id,scope:'cluster',consumerId:id,now});
            }
          }
          if (!item.eligible) continue;
          for (const member of item.members) {
            const performance = member.performance ? parseObject(member.performance.payload_json) : { level: 'P1', contributionWeight: 0.5, provisional: true };
            db.prepare(`INSERT INTO cloud_agent_cohort_members (cohort_id,user_agent_instance_id,owner_user_id,agent_family_id,performance_level,raw_weight,effective_weight,payload_json,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(id, member.agentInstanceId, member.ownerUserId, member.agentFamilyId, performance.level || 'P1', Number(performance.contributionWeight || 0.5), Number(performance.contributionWeight || 0.5), JSON.stringify({ performance, capabilityTags: member.capabilityTags }), now);
          }
        }
      });
      return eligibility.map((item) => ({ ...item, id: resolvedIds.get(item.cohortKey) || stableClusterCohortId(item.cohortKey), identityVersion: CLUSTER_COHORT_IDENTITY_VERSION }));
    },

    cohorts({ includeIneligible = false } = {}) {
      const active = db.prepare("SELECT * FROM cloud_agent_cohorts WHERE status='active' ORDER BY updated_at DESC").all().map(cohortPayload);
      return includeIneligible ? db.prepare("SELECT * FROM cloud_agent_cohorts WHERE status IN ('active','ineligible') ORDER BY updated_at DESC").all().map(cohortPayload) : active;
    },

    requestClusterRun({ cohortId = '', triggerKind = 'scheduled' } = {}) {
      assertClusterReady({ enabled, modelAvailable, encryptionAvailable });
      const normalizedTriggerKind = normalizeCloudTriggerKind(triggerKind);
      const cohort = db.prepare("SELECT * FROM cloud_agent_cohorts WHERE id=? AND status='active'").get(cohortId);
      if (!cohort) throw codedError('cohort_not_eligible', 'Cohort is not active or eligible.', 409);
      const active = db.prepare("SELECT * FROM cloud_evolution_runs WHERE evolution_scope='cluster' AND cohort_id=? AND status IN ('queued','claimed','running','proposed','canary') LIMIT 1").get(cohortId);
      if (active) return { status: 'deferred', run: runPayload(active) };
      const latest = db.prepare("SELECT * FROM cloud_evolution_runs WHERE evolution_scope='cluster' AND cohort_id=? AND algorithm_version=? ORDER BY created_at DESC LIMIT 1").get(cohortId, PHASE8_ALGORITHM_VERSION);
      const cadence = clusterCadence(latest, { evaluationIntervalMs, retryIntervalMs });
      if (cadence.deferred) return { status: 'deferred', reason: 'cluster_evaluation_cadence', run: runPayload(latest), nextEligibleAt: cadence.nextEligibleAt };
      const members = db.prepare(`SELECT m.* FROM cloud_agent_cohort_members m
        JOIN cloud_user_agent_instances_v3 i ON i.id=m.user_agent_instance_id AND i.user_id=m.owner_user_id
        WHERE m.cohort_id=? AND i.status='active' AND i.sync_enabled=1 AND i.cluster_contribution_consent=1`).all(cohortId);
      const memberUserCount = distinctWeightUserCount(members.map((row) => ({ ownerUserId: row.owner_user_id, rawWeight: row.raw_weight })));
      if (memberUserCount < CLUSTER_MIN_USERS) return skipClusterRunForWeightCap(db, { cohort, cohortId, triggerKind: normalizedTriggerKind, evidenceCount: 0, userCount: memberUserCount, evaluationIntervalMs });
      const levels = new Map(members.map((row) => [row.user_agent_instance_id, row]));
      const memberIds = new Set(members.map((row) => row.user_agent_instance_id));
      const evidenceRows = db.prepare("SELECT * FROM cloud_evolution_evidence WHERE quarantine_reason='' AND validation_status='validated' AND historical_inactive=0 AND json_extract(metadata_json,'$.allowedEvolutionScopes') LIKE '%cluster%' ORDER BY occurred_at DESC LIMIT 2000").all()
        .filter((row) => memberIds.has(row.user_agent_instance_id));
      const eligibleEvidence = selectClusterEligibleEvidence({
        cohortKey: cohort.cohort_key || parseObject(cohort.payload_json).cohortKey || `legacy:${cohort.id}`,
        evidence: evidenceRows.map(clusterEvidenceRecord),
        usage: db.prepare("SELECT * FROM cloud_evolution_evidence_usage WHERE evolution_scope='cluster' AND consumer_id=?").all(cohortId),
        claims: db.prepare('SELECT * FROM cloud_cluster_evidence_claims').all(),
        algorithmVersion: PHASE8_ALGORITHM_VERSION,
        policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION,
      }).slice(0, 500).map((row) => {
          const metadata = parseObject(row.metadata_json);
          const member = levels.get(row.user_agent_instance_id);
          return { ...row, ownerUserId: row.owner_user_id, rawWeight: clusterEvidenceWeight({ performanceWeight: Number(member?.raw_weight || 0.5), confidence: row.confidence, occurredAt: row.occurred_at, relevance: metadata.taskRelevance ?? 1, acceptanceQuality: metadata.acceptanceQuality ?? 1 }) };
        });
      const selectedCandidates = selectClusterEvidenceWindow(eligibleEvidence, { limit: 180, thresholds: evidenceThresholds });
      const selectedUserCount = distinctWeightUserCount(selectedCandidates);
      if (selectedUserCount < CLUSTER_MIN_USERS) return skipClusterRunForWeightCap(db, { cohort, cohortId, triggerKind: normalizedTriggerKind, evidenceCount: selectedCandidates.length, userCount: selectedUserCount, evaluationIntervalMs });
      const thresholdReasons = clusterEvidenceThresholdReasons(selectedCandidates.filter((row)=>row.eligibilityKind!=='reconsiderable'), evidenceThresholds);
      const selected = capClusterEvidenceWeights(selectedCandidates);
      if (thresholdReasons.length) {
        const runId = `clrun_${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count,summary,created_at,updated_at,completed_at)
          VALUES (?,'cluster',?,?,?,?,?,'insufficient_evidence',?,?,?,?,?)`).run(runId, cohort.agent_family_id || '', cohortId, cohortId,
          PHASE8_ALGORITHM_VERSION, normalizedTriggerKind, selected.length, `Evidence thresholds were not met: ${thresholdReasons.join(',')}.`, now, now, now);
        return { status: 'insufficient_evidence', runId, evidenceCount: selected.length,
          evidenceBreakdown: clusterEvidenceBreakdown(selectedCandidates), eligibilityReasons: thresholdReasons,
          userCount: distinctWeightUserCount(selected.map((row) => ({ ownerUserId: row.owner_user_id, rawWeight: row.effectiveWeight }))),
          evidenceThresholds, nextEligibleAt: new Date(Date.now() + evaluationIntervalMs).toISOString() };
      }
      const runId = `clrun_${crypto.randomUUID()}`;
      const jobId = `cljob_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const cohortSnapshot = {
        cohortId, cohortKey: cohort.cohort_key || parseObject(cohort.payload_json).cohortKey || '',
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
        transaction(db, () => {
          db.prepare(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count,created_at,updated_at)
            VALUES (?,'cluster',?,?,?,?,?,'queued',?,?,?)`).run(runId, cohort.agent_family_id || '', cohortId, cohortId, PHASE8_ALGORITHM_VERSION, normalizedTriggerKind, selected.length, now, now);
          db.prepare(`INSERT INTO cloud_evolution_jobs (id,run_id,job_kind,status,available_at,created_at,updated_at) VALUES (?,?,'cluster_evolution','queued',?,?,?)`).run(jobId, runId, now, now, now);
          db.prepare(`INSERT INTO cloud_evolution_run_snapshots (run_id,snapshot_hash,evidence_ids_json,cohort_snapshot_json,created_at)
            VALUES (?,?,?,?,?)`).run(runId, sha256(JSON.stringify(cohortSnapshot)), JSON.stringify(selected.map((row) => row.evidence_id)), JSON.stringify(cohortSnapshot), now);
          for (const row of selected) {
          db.prepare(`INSERT INTO cloud_cluster_run_evidence (run_id,evidence_id,raw_weight,effective_weight,cohort_raw_total,user_cap,created_at)
            VALUES (?,?,?,?,?,?,?)`).run(runId, row.evidence_id, row.rawWeight, row.effectiveWeight, row.cohortRawTotal, row.userCap, now);
          }
          const reserved=usageLedger.reserve({scope:'cluster',consumerId:cohortId,runId,algorithmVersion:PHASE8_ALGORITHM_VERSION,
            evidenceIds:selected.map((row)=>row.evidence_id),nextBasisByEvidence:Object.fromEntries(selected
              .filter((row)=>row.nextReEvaluationBasisHash).map((row)=>[row.evidence_id,row.nextReEvaluationBasisHash])),
            leaseExpiresAt:new Date(Date.now()+30*60000).toISOString(),now,clusterClaims:true,
            transitionReason:selected.some((row)=>row.eligibilityKind==='reconsiderable')?'reserved_with_reconsideration':'reserved_for_run'});
          if(reserved.length!==selected.length) throw codedError('cluster_evidence_usage_conflict','Cluster evidence usage changed before reservation.',409);
        });
      } catch (error) {
        if (['cluster_evidence_claim_conflict', 'cluster_evidence_usage_conflict'].includes(error.code)) {
          return { status: 'deferred', reason: error.code, nextEligibleAt: new Date(Date.now() + retryIntervalMs).toISOString() };
        }
        throw error;
      }
      return { status: 'queued', run: runPayload(db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(runId)) };
    },

    async tickClusterWorker({ workerId = `cluster_${process.pid}`, limit = 1 } = {}) {
      const completed = this.reconcileMarketCanaries();
      assertClusterReady({ enabled, modelAvailable, encryptionAvailable });
      for (let index = 0; index < Math.max(1, Number(limit || 1)); index += 1) {
        const job = claimClusterJob(db, workerId);
        if (!job) break;
        try { completed.push(job.job_kind === 'cluster_shadow'
          ? await executeClusterShadowJob({ db, job, modelExecutor, keyring: resolvedKeyring, canaryMinimumUsers, canaryMinimumCases })
          : await executeClusterJob({ db, job, modelExecutor, keyring: resolvedKeyring, shadowDelayMs })); }
        catch (error) { completed.push(failClusterJob(db, job, error)); }
      }
      return { status: 'ok', completed };
    },

    reconcileMarketCanaries() {
      assertEnabled(enabled);
      return reconcileSqliteCanaries({db,keyring:resolvedKeyring,canaryMinimumUsers,canaryMinimumCases,
        canaryMinimumDurationMs,canaryMaximumDurationMs});
    },

    setCanaryOptIn({ userId = '', agentInstanceId = '', enabled: optIn = true, commandId = '' } = {}) {
      assertEnabled(enabled);
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, agentInstanceId);
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance does not belong to user.', 404);
      if (optIn && (instance.status !== 'active' || !Number(instance.sync_enabled) || !Number(instance.cluster_contribution_consent))) throw codedError('canary_agent_unavailable', 'Only evolution-enabled active synchronized Agents may join Canary.', 409);
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO cloud_market_canary_opt_ins
        (user_id,user_agent_instance_id,agent_family_id,policy_version,status,command_id,payload_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, ?,?) ON CONFLICT(user_id,user_agent_instance_id) DO UPDATE SET
          agent_family_id=excluded.agent_family_id,policy_version=excluded.policy_version,status=excluded.status,
          command_id=excluded.command_id,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
        userId,agentInstanceId,instance.agent_family_id,MARKET_CANARY_POLICY_VERSION,optIn?'active':'withdrawn',String(commandId||''),
        JSON.stringify({enrollment:optIn?'manual_rejoin':'explicit_opt_out',explicitOptOut:!optIn}),now,now);
      if (!optIn) db.prepare("UPDATE cloud_market_canary_assignments SET status='withdrawn',completed_at=? WHERE user_id=? AND user_agent_instance_id=? AND status='enrolled'").run(now,userId,agentInstanceId);
      return this.canaryStatus({ userId, agentInstanceId });
    },

    canaryStatus({ userId = '', agentInstanceId = '' } = {}) {
      const instance=db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId,agentInstanceId);
      const eligible=Boolean(instance&&instance.status==='active'&&Number(instance.sync_enabled)
        &&Number(instance.cluster_contribution_consent)&&userEvolutionEnabled(db,userId));
      if(eligible)ensureSqliteDefaultCanaryEnrollments(db,{userId,agentInstanceId});
      const optIn = db.prepare('SELECT * FROM cloud_market_canary_opt_ins WHERE user_id=? AND user_agent_instance_id=?').get(userId,agentInstanceId);
      const assignments = db.prepare(`SELECT a.*,c.status candidate_status,c.status_reason FROM cloud_market_canary_assignments a
        JOIN cloud_market_agent_candidates c ON c.id=a.candidate_id WHERE a.user_id=? AND a.user_agent_instance_id=? ORDER BY a.started_at DESC`).all(userId,agentInstanceId);
      const payload=parseObject(optIn?.payload_json);
      return { authority:'cloud',policyVersion:MARKET_CANARY_POLICY_VERSION,optedIn:optIn?.status==='active',
        eligible,defaultEnrolled:optIn?.status==='active'&&payload.enrollment==='default',
        explicitlyOptedOut:optIn?.status==='withdrawn',canOptOut:true,
        assignments:assignments.map(sqliteCanaryAssignmentPayload) };
    },

    candidates({ familyId = '', limit = 50 } = {}) {
      const rows = familyId ? db.prepare('SELECT * FROM cloud_market_agent_candidates WHERE agent_family_id=? ORDER BY created_at DESC LIMIT ?').all(familyId, limit) : db.prepare('SELECT * FROM cloud_market_agent_candidates ORDER BY created_at DESC LIMIT ?').all(limit);
      return rows.map((row) => marketCandidatePayload(db, row));
    },

    abandonShadowCandidate({ candidateId = '', reason = 'shadow_candidate_abandoned' } = {}) {
      const candidate = db.prepare("SELECT * FROM cloud_market_agent_candidates WHERE id=? AND status='shadow_passed'").get(candidateId);
      if (!candidate) throw codedError('shadow_candidate_not_found', 'Shadow-passed candidate was not found.', 404);
      const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(candidate.run_id);
      const now = new Date().toISOString();
      transaction(db, () => {
        db.prepare("UPDATE cloud_market_agent_candidates SET status='archived',status_reason=?,updated_at=? WHERE id=?").run(reason,now,candidate.id);
        db.prepare("UPDATE cloud_market_candidate_family_sections SET status='archived' WHERE candidate_id=?").run(candidate.id);
        db.prepare("UPDATE cloud_evolution_runs SET status='rolled_back',error_code=?,completed_at=?,updated_at=? WHERE id=?").run(reason,now,now,run.id);
        db.prepare("UPDATE cloud_evolution_jobs SET status='cancelled',error_code=?,completed_at=?,updated_at=? WHERE run_id=?").run(reason,now,now,run.id);
        createSqliteEvidenceUsageLedger(db).transitionRun({ scope:'cluster',consumerId:run.cohort_id,runId:run.id,
          toStatus:'released',transitionReason:reason,now,clusterClaims:true });
      });
      return { candidateId:candidate.id,runId:run.id,status:'archived',evidenceStatus:'released' };
    },

    marketVersions({ familyId = '', userId = '', agentInstanceId = '', limit = 50 } = {}) {
      const rows = familyId ? db.prepare("SELECT * FROM cloud_market_agent_versions WHERE agent_family_id=? AND status IN ('released','suspended') ORDER BY created_at DESC LIMIT ?").all(familyId, limit) : db.prepare("SELECT * FROM cloud_market_agent_versions WHERE status IN ('released','suspended') ORDER BY created_at DESC LIMIT ?").all(limit);
      return rows.map((row) => marketVersionPayload(db, row, { userId, agentInstanceId }));
    },

    adopt({ userId = '', agentInstanceId = '', marketVersionId = '', sectionIds = [], conflictResolutions = {}, action = 'adopt', mode = '', commandId = '', expectedEffectiveSkillHash } = {}) {
      assertMarketReady({ enabled, encryptionAvailable });
      if (!['adopt', 'rollback', 'ignore'].includes(action)) throw codedError('market_adoption_action_invalid', 'Market adoption action is invalid.', 400);
      const adoptionMode = normalizeAdoptionMode(mode || (sectionIds.length ? 'sections' : 'full'));
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, agentInstanceId);
      if (!instance) throw codedError('agent_instance_not_found', 'Agent instance does not belong to user.', 404);
      const version = db.prepare("SELECT * FROM cloud_market_agent_versions WHERE id=? AND agent_family_id=? AND status IN ('released','suspended')").get(marketVersionId, instance.agent_family_id);
      if (!version) throw codedError('market_version_not_found', 'Market version was not found for this Agent family.', 404);
      if (action === 'adopt' && version.status === 'suspended') throw codedError('market_version_suspended', 'This market version is suspended and cannot accept new adoptions.', 409);
      const sections = db.prepare('SELECT * FROM cloud_market_version_sections WHERE market_version_id=? ORDER BY ordinal').all(marketVersionId).map(sectionPayload);
      const requested = adoptionMode === 'full' ? new Set(sections.map((item) => item.sectionId)) : new Set(sectionIds.map(String).filter(Boolean));
      if (adoptionMode === 'sections' && !requested.size) throw codedError('market_section_required', 'At least one market section is required for section adoption.', 400);
      const selectedSections = sections.filter((item) => requested.has(item.sectionId));
      if (selectedSections.length !== requested.size) throw codedError('market_section_not_found', 'One or more market sections were not found in this version.', 404);
      const targetIds = adoptionMode === 'full' ? ['*'] : selectedSections.map((section) => section.sectionId);
      const cleanCommandId = String(commandId || '').trim();
      if (cleanCommandId) {
        const existing = db.prepare(`SELECT COUNT(*) count FROM cloud_market_adoption_actions
          WHERE user_id=? AND command_id=? AND section_id IN (${targetIds.map(() => '?').join(',')})`).get(userId, cleanCommandId, ...targetIds);
        if (Number(existing?.count || 0) === targetIds.length) return { ...projectEffectiveSkill(db, { userId, instance, marketVersionId }), idempotent: true };
      }
      const currentSkill = projectEffectiveSkill(db, { userId, instance, marketVersionId: '' });
      if (expectedEffectiveSkillHash !== undefined && String(expectedEffectiveSkillHash || '') !== String(currentSkill.effectiveSkillHash || '')) {
        throw codedError('market_skill_conflict', 'The effective Market Skill changed on another device.', 409, {
          expectedEffectiveSkillHash: String(expectedEffectiveSkillHash || ''),
          currentEffectiveSkillHash: String(currentSkill.effectiveSkillHash || ''),
        });
      }
      const overlay = cloudOverlayText(db, instance);
      const conflictIds = deriveOverlayConflictIndex(overlay, selectedSections);
      const unresolved = action === 'adopt' ? conflictIds.filter((sectionId) => !Object.hasOwn(conflictResolutions, sectionId)) : [];
      if (unresolved.length) return marketConflictPreview({ userId, instance, marketVersionId, overlay, sections: selectedSections, conflictIds: unresolved });
      for (const resolution of Object.values(conflictResolutions)) if (!['personal', 'market'].includes(resolution)) throw codedError('market_conflict_resolution_invalid', 'Conflict resolution must be personal or market.', 400);
      const now = new Date().toISOString();
      transaction(db, () => {
        for (const targetId of targetIds) {
          const previous = db.prepare('SELECT status FROM cloud_user_market_adoptions WHERE user_id=? AND user_agent_instance_id=? AND market_version_id=? AND section_id=?').get(userId, agentInstanceId, marketVersionId, targetId)?.status || '';
          const nextStatus = action === 'rollback' ? 'rolled_back' : action === 'ignore' ? 'ignored' : 'adopted';
          const resolution = targetId === '*' ? 'none' : conflictResolutions[targetId] || 'none';
          if (action === 'adopt') db.prepare(`UPDATE cloud_user_market_adoptions SET status='superseded',updated_at=?
            WHERE user_id=? AND user_agent_instance_id=? AND section_id=? AND market_version_id<>? AND status='adopted'`).run(now, userId, agentInstanceId, targetId, marketVersionId);
          db.prepare(`INSERT INTO cloud_user_market_adoptions (user_id,user_agent_instance_id,market_version_id,section_id,adoption_mode,status,payload_json,updated_at)
            VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,user_agent_instance_id,market_version_id,section_id) DO UPDATE SET adoption_mode=excluded.adoption_mode,status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
            userId, agentInstanceId, marketVersionId, targetId, adoptionMode, nextStatus, JSON.stringify({
              conflictResolution: resolution,
              conflictResolutions: adoptionMode === 'full' ? conflictResolutions : undefined,
              selectedSectionIds: adoptionMode === 'full' ? selectedSections.map((item) => item.sectionId) : undefined,
            }), now,
          );
          if (action === 'rollback') {
            const restore = db.prepare(`SELECT a.market_version_id FROM cloud_user_market_adoptions a JOIN cloud_market_agent_versions v ON v.id=a.market_version_id
              WHERE a.user_id=? AND a.user_agent_instance_id=? AND a.section_id=? AND a.status='superseded'
              ORDER BY v.created_at DESC LIMIT 1`).get(userId, agentInstanceId, targetId);
            if (restore) db.prepare("UPDATE cloud_user_market_adoptions SET status='adopted',updated_at=? WHERE user_id=? AND user_agent_instance_id=? AND market_version_id=? AND section_id=?").run(now, userId, agentInstanceId, restore.market_version_id, targetId);
          }
          const actionId = `adopt_${crypto.randomUUID()}`;
          const actionPayload = { mode:adoptionMode,action,marketVersionId,sectionId:targetId,previousStatus:previous,nextStatus,conflictResolution:resolution || 'none' };
          db.prepare(`INSERT INTO cloud_market_adoption_actions (id,user_id,user_agent_instance_id,market_version_id,section_id,action,conflict_resolution,previous_status,next_status,command_id,payload_json,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(actionId,userId,agentInstanceId,marketVersionId,targetId,action,resolution || 'none',previous,nextStatus,cleanCommandId,JSON.stringify({ mode: adoptionMode }),now);
          createSqliteAuthoritativeEvidence(db,{keyring:resolvedKeyring,ownerUserId:userId,userAgentInstanceId:agentInstanceId,
            agentFamilyId:instance.agent_family_id,sourceKind:marketEvidenceSourceKind(action),sourceId:actionId,sourceVersionId:marketVersionId,
            content:actionPayload,occurredAt:now,confidence:1,metadata:{marketVersionId,sectionId:targetId},cluster:true});
        }
      });
      return { ...projectEffectiveSkill(db, { userId, instance, marketVersionId }), status: action === 'rollback' ? 'rolled_back' : action === 'ignore' ? 'ignored' : 'applied', mode: adoptionMode, commandId: cleanCommandId };
    },

    evaluateMarketHealth({ now = new Date() } = {}) {
      return db.prepare("SELECT * FROM cloud_market_agent_versions WHERE status IN ('released','suspended') ORDER BY created_at").all()
        .map((version) => evaluateSqliteMarketVersionHealth(db, version, now));
    },

    effectiveSkill({ userId = '', agentInstanceId = '' } = {}) {
      const instance = db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=? AND id=?').get(userId, agentInstanceId);
      if (instance && enabled && encryptionAvailable) return projectEffectiveSkill(db, { userId, instance, marketVersionId: '' });
      const row = db.prepare('SELECT * FROM cloud_effective_skill_projections WHERE user_id=? AND user_agent_instance_id=?').get(userId, agentInstanceId);
      return row ? { ...parseObject(row.payload_json), effectiveSkillHash: row.effective_skill_hash, updatedAt: row.updated_at } : null;
    },
  };
}

async function executeClusterJob({ db, job, modelExecutor, keyring, shadowDelayMs }) {
  if (typeof modelExecutor !== 'function') throw codedError('evolution_worker_unavailable', 'Cluster model executor is unavailable.', 503);
  const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(job.run_id);
  const cohortRow = db.prepare('SELECT * FROM cloud_agent_cohorts WHERE id=?').get(run.cohort_id);
  const snapshotRow=db.prepare('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=?').get(run.id);
  const frozenMembers=parseObject(snapshotRow?.cohort_snapshot_json).members;
  const members=Array.isArray(frozenMembers)&&frozenMembers.length?frozenMembers:db.prepare('SELECT * FROM cloud_agent_cohort_members WHERE cohort_id=?').all(run.cohort_id)
    .map((row)=>({ownerUserId:row.owner_user_id,agentInstanceId:row.user_agent_instance_id,agentFamilyId:row.agent_family_id,performanceLevel:row.performance_level}));
  const cohort = { ...cohortPayload(cohortRow), members };
  db.prepare("UPDATE cloud_evolution_runs SET status='running',updated_at=? WHERE id=?").run(new Date().toISOString(), run.id);
  const rows = db.prepare(`SELECT e.*,w.effective_weight FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    JOIN cloud_cluster_run_evidence w ON w.run_id=u.run_id AND w.evidence_id=e.evidence_id
    WHERE u.run_id=? AND u.evolution_scope='cluster' AND u.consumer_id=? AND u.status='reserved' ORDER BY e.occurred_at`).all(run.id, run.cohort_id);
  const evidence = [];
  for(const row of rows){
    try{
      const content=decryptEvolutionPayload({algorithm:row.encryption_algorithm,keyId:row.key_id,ciphertext:row.content_ciphertext,
        nonce:row.content_nonce,tag:row.content_tag,wrappedDataKey:row.wrapped_data_key},keyring);
      evidence.push({evidenceId:row.evidence_id,ownerUserId:row.owner_user_id,agentInstanceId:row.user_agent_instance_id,
        content,effectiveWeight:Number(row.effective_weight||0.5)});
      auditClusterEvidenceAccess(db,{runId:run.id,evidenceId:row.evidence_id,result:'allowed',keyId:row.key_id});
    }catch(error){
      auditClusterEvidenceAccess(db,{runId:run.id,evidenceId:row.evidence_id,result:'denied',resultCode:error.code||'decrypt_failed',
        keyId:row.key_id,detail:{message:String(error.message||error).slice(0,500)}});
      throw error;
    }
  }
  const familyIds = uniqueStrings(members.map((item) => item.agentFamilyId));
  const releaseFamilyIds = run.agent_family_id ? [run.agent_family_id] : familyIds;
  const currentSections = releaseFamilyIds.flatMap((familyId) => latestMarketSections(db, familyId).map((section) => ({ ...section, agentFamilyId: familyId })));
  const ownerUserIds=uniqueStrings(members.map((item)=>item.ownerUserId));
  const identityRows=ownerUserIds.length?db.prepare(`SELECT id,display_name,username FROM users WHERE id IN (${ownerUserIds.map(()=>'?').join(',')})`)
    .all(...ownerUserIds):[];
  const result = await runClusterEvolutionCore({ cohort, evidence, currentMarketSections: currentSections, modelExecutor,
    privacyContext:{knownIdentityTerms:identityRows.flatMap((item)=>[item.display_name,item.username])} });
  const now = new Date().toISOString();
  if (result.status !== 'approved') {
    transaction(db, () => {
      const basisByEvidence = clusterReEvaluationBasisByEvidence(db, run.id);
      db.prepare("UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code=?,completed_at=?,updated_at=? WHERE id=?").run(result.reason, now, now, run.id);
      db.prepare("UPDATE cloud_evolution_jobs SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now, now, job.id);
      createSqliteEvidenceUsageLedger(db).transitionRun({scope:'cluster',consumerId:run.cohort_id,runId:run.id,
        toStatus:'evaluated_rejected',rejectionKind:evidenceRejectionKindForReason(result.reason),
        transitionReason:result.reason||'evaluated_rejected',basisByEvidence:Object.fromEntries(basisByEvidence),now,clusterClaims:true});
    });
    return { runId: run.id, status: 'evaluated_rejected', reason: result.reason, gate: result.gate || null, reviews: result.reviews || [] };
  }
  const candidateId = `candidate_${crypto.randomUUID()}`;
  const approvedFamilyIds = result.approvedFamilyIds || result.familyResults?.filter((item) => item.status === 'approved').map((item) => item.familyId) || releaseFamilyIds;
  const primaryFamilyId = approvedFamilyIds[0] || run.agent_family_id || familyIds[0] || '';
  const shadowAvailableAt = new Date(Date.parse(now) + shadowDelayMs).toISOString();
  const encryptedCases = encryptEvolutionPayload(JSON.stringify(result.shadowCases || []), keyring);
  const publicFamilyResults = (result.familyResults || []).map((item) => ({ familyId: item.familyId, status: item.status,
    revisionCount: item.revisionCount || 0, review: item.review, gate: item.gate,finalPrivacyReview:item.finalPrivacyReview,
    sectionIds: (item.sections || []).map((section) => section.sectionId), evaluationCount: (item.evaluations || []).length }));
  const candidatePayload = { id: candidateId, cohortId: run.cohort_id, runId: run.id, agentFamilyId: primaryFamilyId,
    approvedFamilyIds, status: 'governance_approved', summary: result.proposal.summary || '', diagnosis: result.diagnosis,
    gate: result.gate, familyResults: publicFamilyResults, shadow: { ...result.shadow, availableAt: shadowAvailableAt }, createdAt: now };
  transaction(db, () => {
    db.prepare(`INSERT INTO cloud_market_agent_candidates (
      id,cohort_id,agent_family_id,run_id,revision_no,diagnosis_json,gate_json,governance_json,status,
      shadow_started_at,payload_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?, 'governance_approved',?,?,?,?)`).run(candidateId, run.cohort_id, primaryFamilyId, run.id,
      Math.max(0, ...publicFamilyResults.map((item) => item.revisionCount)), JSON.stringify(result.diagnosis || {}),
      JSON.stringify(result.gate || {}), JSON.stringify(publicFamilyResults), now, JSON.stringify(candidatePayload), now, now);
    for (const family of result.familyResults || []) {
      for (const section of family.sections || []) {
        const support=supportProofForSection(family,section.sectionId);
        db.prepare(`INSERT INTO cloud_market_candidate_family_sections (
          candidate_id,agent_family_id,section_id,title,content_hash,content_json,support_count,status,created_at
        ) VALUES (?,?,?,?,?,?,?,'governance_approved',?)`).run(candidateId, family.familyId, section.sectionId, section.title, section.contentHash,
          JSON.stringify(section),support.supportCount,now);
        for(const item of support.items||[])db.prepare(`INSERT INTO cloud_market_candidate_section_supports (
          candidate_id,agent_family_id,section_id,evidence_id,user_agent_instance_id,contributor_id,evidence_handle,
          support_confidence,deterministic_pass,reviewer_pass,review_stage,created_at
        ) VALUES(?,?,?,?,?,?,?,?,1,1,?,?)`).run(candidateId,family.familyId,section.sectionId,item.evidenceId,item.agentInstanceId,
          item.contributorId,item.evidenceHandle,item.confidence,support.reviewStage||'initial_gate',now);
      }
      if(family.finalPrivacyReview)db.prepare(`INSERT INTO cloud_market_candidate_privacy_reviews (
        id,candidate_id,agent_family_id,review_stage,deterministic_status,reviewer_status,finding_codes_json,review_json,created_at
      ) VALUES(?,?,?,'final_pre_shadow',?,?,?,?,?)`).run(stableId('privacy',candidateId,family.familyId,'final_pre_shadow'),candidateId,
        family.familyId,family.finalPrivacyReview.deterministicStatus||'failed',family.finalPrivacyReview.reviewerStatus||'not_run',
        JSON.stringify(family.finalPrivacyReview.findingCodes||[]),JSON.stringify(family.finalPrivacyReview),now);
    }
    db.prepare(`INSERT INTO cloud_market_candidate_privacy_reviews (
      id,candidate_id,agent_family_id,review_stage,deterministic_status,reviewer_status,finding_codes_json,review_json,created_at
    ) VALUES(?,?,'','initial_gate',?,?,?,?,?)`).run(stableId('privacy',candidateId,'initial_gate'),candidateId,
      Number(result.gate?.privacyReport?.flagCount||0)?'failed':'passed',result.gate?.independentPrivacyReview?.status||'not_run',
      JSON.stringify(result.gate?.privacyReport?.flags||[]),JSON.stringify(result.gate?.independentPrivacyReview||{}),now);
    for (const [evaluationIndex, item] of (result.evaluations || []).entries()) db.prepare(`INSERT INTO cloud_market_evaluations (
      id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json,created_at
    ) VALUES (?,?,'pre_shadow_replay',?,'completed',?,?,?,?,?)`).run(stableId('meval', candidateId, 'pre', evaluationIndex), candidateId,
      evaluationIndex, item.regression ? 1 : 0, item.privacyViolation ? 1 : 0, item.roleViolation ? 1 : 0, JSON.stringify(item), now);
    db.prepare(`UPDATE cloud_evolution_run_snapshots SET shadow_cases_ciphertext=?,shadow_cases_nonce=?,shadow_cases_tag=?,
      shadow_cases_algorithm=?,shadow_cases_key_id=? WHERE run_id=?`).run(encryptedCases.ciphertext, encryptedCases.nonce,
      encryptedCases.tag, encryptedCases.algorithm, encryptedCases.keyId, run.id);
    db.prepare("UPDATE cloud_evolution_runs SET status='proposed',summary=?,updated_at=? WHERE id=?").run(result.proposal.summary || '', now, run.id);
    db.prepare(`UPDATE cloud_evolution_jobs SET job_kind='cluster_shadow',status='queued',attempt_count=0,available_at=?,
      claimed_by='',lease_expires_at='',error_code='',error_text='',updated_at=?,completed_at='' WHERE id=?`).run(shadowAvailableAt, now, job.id);
    createSqliteEvidenceUsageLedger(db).refreshRunLease({ scope: 'cluster', runId: run.id,
      leaseExpiresAt: new Date(Date.parse(shadowAvailableAt) + 30 * 60000).toISOString(), now });
  });
  return { runId: run.id, status: 'governance_approved', candidateId, approvedFamilyIds, shadowAvailableAt };
}

async function executeClusterShadowJob({ db, job, modelExecutor, keyring, canaryMinimumUsers, canaryMinimumCases }) {
  const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(job.run_id);
  const candidate = db.prepare("SELECT * FROM cloud_market_agent_candidates WHERE run_id=? AND status='governance_approved'").get(run.id);
  if (!candidate) throw codedError('cluster_shadow_candidate_missing', 'Cluster Shadow candidate is missing.', 500);
  const snapshot = db.prepare('SELECT * FROM cloud_evolution_run_snapshots WHERE run_id=?').get(run.id);
  const shadowCases = JSON.parse(decryptEvolutionPayload({ algorithm: snapshot.shadow_cases_algorithm, keyId: snapshot.shadow_cases_key_id,
    ciphertext: snapshot.shadow_cases_ciphertext, nonce: snapshot.shadow_cases_nonce, tag: snapshot.shadow_cases_tag }, keyring) || '[]');
  const frozenMembers=parseObject(snapshot.cohort_snapshot_json).members;
  const members=Array.isArray(frozenMembers)&&frozenMembers.length?frozenMembers:db.prepare('SELECT * FROM cloud_agent_cohort_members WHERE cohort_id=?').all(run.cohort_id)
    .map((row)=>({ownerUserId:row.owner_user_id,agentInstanceId:row.user_agent_instance_id,agentFamilyId:row.agent_family_id}));
  const grouped = new Map();
  for (const row of db.prepare('SELECT * FROM cloud_market_candidate_family_sections WHERE candidate_id=? ORDER BY agent_family_id,section_id').all(candidate.id)) {
    const sections = grouped.get(row.agent_family_id) || [];
    sections.push(sectionPayload(row));
    grouped.set(row.agent_family_id, sections);
  }
  const familyResults = [...grouped].map(([familyId, sections]) => ({ familyId, status: 'approved', sections }));
  const currentSections = familyResults.flatMap((family) => latestMarketSections(db, family.familyId).map((section) => ({ ...section, agentFamilyId: family.familyId })));
  const result = await runClusterShadowEvaluation({ familyResults, currentMarketSections: currentSections, shadowCases, modelExecutor,
    minimumUsers: canaryMinimumUsers, minimumCases: canaryMinimumCases });
  const now = new Date().toISOString();
  if (result.status === 'insufficient') {
    transaction(db, () => {
      db.prepare("UPDATE cloud_market_agent_candidates SET status='archived',status_reason='shadow_insufficient',updated_at=? WHERE id=?").run(now, candidate.id);
      db.prepare("UPDATE cloud_evolution_runs SET status='failed_retryable',error_code='shadow_insufficient',completed_at=?,updated_at=? WHERE id=?").run(now, now, run.id);
      db.prepare("UPDATE cloud_evolution_jobs SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now, now, job.id);
      createSqliteEvidenceUsageLedger(db).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
        toStatus: 'released', transitionReason: 'shadow_insufficient', now, clusterClaims: true });
    });
    return { runId: run.id, candidateId: candidate.id, status: 'shadow_insufficient', ...result };
  }
  if (result.status !== 'approved') {
    transaction(db, () => {
      persistSqliteShadowEvaluations(db, candidate.id, result.evaluations, now);
      const basisByEvidence = clusterReEvaluationBasisByEvidence(db, run.id);
      db.prepare('UPDATE cloud_market_agent_candidates SET status=?,status_reason=?,updated_at=? WHERE id=?').run(candidateRejectionStatus(result.reason), result.reason, now, candidate.id);
      db.prepare("UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code=?,completed_at=?,updated_at=? WHERE id=?").run(result.reason, now, now, run.id);
      db.prepare("UPDATE cloud_evolution_jobs SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now, now, job.id);
      createSqliteEvidenceUsageLedger(db).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
        toStatus: 'evaluated_rejected', rejectionKind: evidenceRejectionKindForReason(result.reason), transitionReason: result.reason,
        basisByEvidence: Object.fromEntries(basisByEvidence), now, clusterClaims: true });
    });
    return { runId: run.id, candidateId: candidate.id, status: 'evaluated_rejected', reason: result.reason };
  }
  transaction(db, () => {
    persistSqliteShadowEvaluations(db, candidate.id, result.evaluations, now);
    const payload = { ...parseObject(candidate.payload_json), shadow: result.shadow };
    db.prepare("UPDATE cloud_market_agent_candidates SET status='shadow_passed',shadow_completed_at=?,status_reason='',payload_json=?,updated_at=? WHERE id=?").run(now, JSON.stringify(payload), now, candidate.id);
    db.prepare("UPDATE cloud_market_candidate_family_sections SET status='shadow_passed' WHERE candidate_id=?").run(candidate.id);
    db.prepare("UPDATE cloud_evolution_runs SET status='proposed',summary=?,updated_at=? WHERE id=?").run('Shadow passed; waiting for default real-user Canary.', now, run.id);
    db.prepare(`UPDATE cloud_evolution_jobs SET job_kind='cluster_canary',status='waiting_canary',claimed_by='',
      lease_expires_at='',error_code='',error_text='',updated_at=?,completed_at='' WHERE id=?`).run(now, job.id);
    createSqliteEvidenceUsageLedger(db).clearRunLease({scope:'cluster',runId:run.id,now});
  });
  return { runId: run.id, candidateId: candidate.id, status: 'shadow_passed', realCanaryAvailable: true };
}

function ensureSqliteDefaultCanaryEnrollments(db, { userId = '', agentInstanceId = '' } = {}) {
  const rows=db.prepare(`SELECT i.* FROM cloud_user_agent_instances_v3 i
    WHERE i.status='active' AND i.sync_enabled=1 AND i.cluster_contribution_consent=1
    ORDER BY i.user_id,i.id`).all()
    .filter((row)=>(!userId||row.user_id===userId)&&(!agentInstanceId||row.id===agentInstanceId));
  const now=new Date().toISOString();const enrolled=[];
  for(const instance of rows){
    const existing=db.prepare('SELECT * FROM cloud_market_canary_opt_ins WHERE user_id=? AND user_agent_instance_id=?')
      .get(instance.user_id,instance.id);
    if(!existing){
      db.prepare(`INSERT INTO cloud_market_canary_opt_ins
        (user_id,user_agent_instance_id,agent_family_id,policy_version,status,command_id,payload_json,created_at,updated_at)
        VALUES (?,?,?,?, 'active','',?,?,?)`).run(instance.user_id,instance.id,instance.agent_family_id,
        MARKET_CANARY_POLICY_VERSION,JSON.stringify({enrollment:'default',explicitOptOut:false}),now,now);
    }else{
      db.prepare(`UPDATE cloud_market_canary_opt_ins SET agent_family_id=?,policy_version=?,
        status=CASE WHEN status='withdrawn' THEN 'withdrawn' ELSE 'active' END,
        payload_json=CASE WHEN status='withdrawn' THEN payload_json ELSE ? END,
        updated_at=CASE WHEN status='withdrawn' THEN updated_at ELSE ? END
        WHERE user_id=? AND user_agent_instance_id=?`).run(instance.agent_family_id,MARKET_CANARY_POLICY_VERSION,
        JSON.stringify({enrollment:'default',explicitOptOut:false}),now,instance.user_id,instance.id);
    }
    enrolled.push(db.prepare('SELECT * FROM cloud_market_canary_opt_ins WHERE user_id=? AND user_agent_instance_id=?')
      .get(instance.user_id,instance.id));
  }
  return enrolled;
}

function reconcileSqliteCanaries({ db, canaryMinimumUsers, canaryMinimumCases, canaryMinimumDurationMs, canaryMaximumDurationMs }) {
  const results = [];
  ensureSqliteDefaultCanaryEnrollments(db);
  const candidates = db.prepare("SELECT * FROM cloud_market_agent_candidates WHERE status IN ('shadow_passed','canary_running') ORDER BY updated_at").all();
  for (const candidate of candidates) {
    const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(candidate.run_id);
    const job = db.prepare("SELECT * FROM cloud_evolution_jobs WHERE run_id=? AND job_kind='cluster_canary'").get(candidate.run_id);
    if (!run || !job) continue;
    if (candidate.status === 'shadow_passed') {
      const familyIds = db.prepare('SELECT DISTINCT agent_family_id FROM cloud_market_candidate_family_sections WHERE candidate_id=?').all(candidate.id).map((row) => row.agent_family_id);
      const optIns = familyIds.length ? db.prepare(`SELECT o.*,i.status instance_status,i.sync_enabled FROM cloud_market_canary_opt_ins o
        JOIN cloud_user_agent_instances_v3 i ON i.user_id=o.user_id AND i.id=o.user_agent_instance_id
        WHERE o.status='active' AND o.policy_version=? AND o.agent_family_id IN (${familyIds.map(() => '?').join(',')})
          AND i.status='active' AND i.sync_enabled=1 AND i.cluster_contribution_consent=1 ORDER BY o.updated_at`).all(MARKET_CANARY_POLICY_VERSION,...familyIds) : [];
      if (new Set(optIns.map((row) => row.user_id)).size < canaryMinimumUsers) {
        results.push({candidateId:candidate.id,status:'waiting_canary',userCount:new Set(optIns.map((row)=>row.user_id)).size});
        continue;
      }
      const baseline = marketHealthBaseline(db,run.cohort_id,optIns.map((row)=>row.user_agent_instance_id));
      const now = new Date();
      transaction(db, () => {
        for (const item of optIns) db.prepare(`INSERT OR IGNORE INTO cloud_market_canary_assignments
          (candidate_id,user_id,user_agent_instance_id,agent_family_id,policy_version,status,baseline_score,baseline_failure_rate,started_at,payload_json)
          VALUES (?,?,?,?,?,'enrolled',?,?,?,?)`).run(candidate.id,item.user_id,item.user_agent_instance_id,item.agent_family_id,
          MARKET_CANARY_POLICY_VERSION,baseline.score,baseline.failureRate,now.toISOString(),JSON.stringify({defaultEnrollment:true}));
        db.prepare("UPDATE cloud_market_agent_candidates SET status='canary_running',canary_started_at=?,canary_deadline_at=?,status_reason='',updated_at=? WHERE id=?").run(
          now.toISOString(),new Date(now.getTime()+canaryMaximumDurationMs).toISOString(),now.toISOString(),candidate.id);
        db.prepare("UPDATE cloud_market_candidate_family_sections SET status='canary_running' WHERE candidate_id=?").run(candidate.id);
        db.prepare("UPDATE cloud_evolution_runs SET status='canary',summary='Real-user Canary is running.',updated_at=? WHERE id=?").run(now.toISOString(),run.id);
      });
      results.push({candidateId:candidate.id,status:'canary_running',userCount:new Set(optIns.map((row)=>row.user_id)).size});
      continue;
    }
    const assignments = db.prepare("SELECT * FROM cloud_market_canary_assignments WHERE candidate_id=? AND status='enrolled'").all(candidate.id);
    const assignmentByInstance = new Map(assignments.map((row) => [row.user_agent_instance_id,row]));
    const events = db.prepare("SELECT * FROM cloud_agent_performance_events WHERE authority='cloud' AND validation_status='validated'").all()
      .filter((row) => assignmentByInstance.has(row.user_agent_instance_id) && row.occurred_at >= assignmentByInstance.get(row.user_agent_instance_id).started_at)
      .map(sqlitePerformanceEventPayload);
    const evaluation = evaluateRealUserCanary({assignments:assignments.map(sqliteCanaryAssignmentPayload),events,
      minimumUsers:canaryMinimumUsers,minimumCases:canaryMinimumCases});
    persistSqliteCanaryEvaluation(db,candidate.id,evaluation);
    const now = new Date();
    if (evaluation.status === 'insufficient' || now.getTime() - Date.parse(candidate.canary_started_at || now.toISOString()) < canaryMinimumDurationMs) {
      if (candidate.canary_deadline_at && now > new Date(candidate.canary_deadline_at)) {
        results.push(rejectSqliteCanary(db,{candidate,run,job,evaluation:{...evaluation,status:'insufficient',reason:'canary_insufficient'},terminal:false,now:now.toISOString()}));
      } else results.push({candidateId:candidate.id,status:'canary_running',...evaluation});
      continue;
    }
    if (evaluation.status === 'rejected') {
      results.push(rejectSqliteCanary(db,{candidate,run,job,evaluation,terminal:true,now:now.toISOString()}));
      continue;
    }
    const familyResults = sqliteCandidateFamilyResults(db,candidate.id);
    const frozen=parseObject(db.prepare('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=?').get(run.id)?.cohort_snapshot_json).members;
    const members=Array.isArray(frozen)?frozen:[];
    transaction(db,()=>{
      db.prepare("UPDATE cloud_market_agent_candidates SET status='canary_passed',status_reason='',updated_at=? WHERE id=?").run(now.toISOString(),candidate.id);
      db.prepare("UPDATE cloud_market_candidate_family_sections SET status='canary_passed' WHERE candidate_id=?").run(candidate.id);
      db.prepare("UPDATE cloud_market_canary_assignments SET status='completed',completed_at=? WHERE candidate_id=? AND status='enrolled'").run(now.toISOString(),candidate.id);
    });
    results.push(publishSqliteMarketCandidate({db,run,job,candidate:{...candidate,status:'canary_passed'},familyResults,members,
      canary:{canary:evaluation,evaluations:[]},now:now.toISOString()}));
  }
  return results;
}

function persistSqliteCanaryEvaluation(db,candidateId,evaluation){
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO cloud_market_canary_evaluations
    (id,candidate_id,policy_version,status,user_count,case_count,baseline_score,candidate_score,baseline_failure_rate,candidate_failure_rate,result_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET status=excluded.status,user_count=excluded.user_count,
      case_count=excluded.case_count,baseline_score=excluded.baseline_score,candidate_score=excluded.candidate_score,
      baseline_failure_rate=excluded.baseline_failure_rate,candidate_failure_rate=excluded.candidate_failure_rate,result_json=excluded.result_json,updated_at=excluded.updated_at`).run(
    stableId('canaryeval',candidateId),candidateId,MARKET_CANARY_POLICY_VERSION,evaluation.status,Number(evaluation.userCount||0),Number(evaluation.caseCount||0),
    Number(evaluation.baselineScore||0),Number(evaluation.candidateScore||0),Number(evaluation.baselineFailureRate||0),Number(evaluation.candidateFailureRate||0),JSON.stringify(evaluation),now,now);
  db.prepare(`INSERT OR REPLACE INTO cloud_market_evaluations
    (id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json,created_at)
    VALUES (?,?,'real_user_canary',0,?,?,?,?,?,?)`).run(stableId('meval',candidateId,'real_user_canary'),candidateId,evaluation.status,
    evaluation.status==='rejected'?1:0,evaluation.privacyViolation?1:0,evaluation.roleViolation?1:0,JSON.stringify(evaluation),now);
}

function rejectSqliteCanary(db,{candidate,run,job,evaluation,terminal,now}){
  const basisByEvidence=terminal?clusterReEvaluationBasisByEvidence(db,run.id):new Map();
  transaction(db,()=>{
    db.prepare("UPDATE cloud_market_agent_candidates SET status=?,status_reason=?,updated_at=? WHERE id=?").run(terminal?'canary_rejected':'archived',evaluation.reason,now,candidate.id);
    db.prepare("UPDATE cloud_market_candidate_family_sections SET status=? WHERE candidate_id=?").run(terminal?'canary_rejected':'archived',candidate.id);
    db.prepare("UPDATE cloud_market_canary_assignments SET status=?,completed_at=? WHERE candidate_id=? AND status='enrolled'").run(terminal?'rejected':'withdrawn',now,candidate.id);
    db.prepare("UPDATE cloud_evolution_runs SET status=?,error_code=?,completed_at=?,updated_at=? WHERE id=?").run(terminal?'evaluated_rejected':'failed_retryable',evaluation.reason,now,now,run.id);
    db.prepare("UPDATE cloud_evolution_jobs SET status='completed',error_code=?,completed_at=?,updated_at=? WHERE id=?").run(evaluation.reason,now,now,job.id);
    createSqliteEvidenceUsageLedger(db).transitionRun({scope:'cluster',consumerId:run.cohort_id,runId:run.id,
      toStatus:terminal?'evaluated_rejected':'released',rejectionKind:terminal?evidenceRejectionKindForReason(evaluation.reason):'',
      transitionReason:evaluation.reason,basisByEvidence:Object.fromEntries(basisByEvidence),now,clusterClaims:true});
  });
  return {candidateId:candidate.id,runId:run.id,status:terminal?'canary_rejected':'canary_insufficient',reason:evaluation.reason,evidenceStatus:terminal?'evaluated_rejected':'released'};
}

function sqliteCandidateFamilyResults(db,candidateId){
  const grouped=new Map();
  for(const row of db.prepare('SELECT * FROM cloud_market_candidate_family_sections WHERE candidate_id=? ORDER BY agent_family_id,section_id').all(candidateId)){
    const sections=grouped.get(row.agent_family_id)||[];sections.push(sectionPayload(row));grouped.set(row.agent_family_id,sections);
  }
  return [...grouped].map(([familyId,sections])=>({familyId,status:'approved',sections}));
}

function sqliteCanaryAssignmentPayload(row){return {candidateId:row.candidate_id,ownerUserId:row.user_id,agentInstanceId:row.user_agent_instance_id,
  agentFamilyId:row.agent_family_id,status:row.status,baselineScore:Number(row.baseline_score||0),baselineFailureRate:Number(row.baseline_failure_rate||0),
  startedAt:row.started_at,completedAt:row.completed_at||'',candidateStatus:row.candidate_status||'',statusReason:row.status_reason||''};}

function publishSqliteMarketCandidate({ db, run, job, candidate, familyResults, members, canary, now }) {
  const releasedVersions = [];
  transaction(db, () => {
    persistSqliteShadowEvaluations(db, candidate.id, canary.evaluations, now);
    for (const family of familyResults) {
      const versionId = `market_${crypto.randomUUID()}`;
      const parent = db.prepare("SELECT id FROM cloud_market_agent_versions WHERE agent_family_id=? AND status='released' ORDER BY created_at DESC LIMIT 1").get(family.familyId)?.id || '';
      const publicSections = family.sections.map((section) => publicMarketSection(section, members));
      const measuredBaseline=marketHealthBaseline(db,run.cohort_id);
      const baseline={score:measuredBaseline.score||Number(canary.canary?.baselineScore||0),
        failureRate:measuredBaseline.failureRate||Number(canary.canary?.baselineFailureRate||0)};
      const sourceBase=sqliteMarketBaseSource(db,family.familyId);
      const baseSkillContent=[sourceBase.content.trim(),compileMarketEffectiveSkill({baseSections:publicSections})].filter(Boolean).join('\n\n');
      db.prepare(`INSERT INTO cloud_market_agent_versions
        (id,agent_family_id,parent_version_id,version_kind,base_agent_version_id,status,sections_json,health_baseline_json,payload_json,created_at)
        VALUES (?,?,?,'market_base',?,'released',?,?,?,?)`).run(versionId,family.familyId,parent,sourceBase.versionId,
        JSON.stringify(publicSections.map((item)=>item.sectionId)),JSON.stringify(baseline),JSON.stringify({candidateId:candidate.id,
          canary:canary.canary,algorithmVersion:PHASE8_ALGORITHM_VERSION,sourceBaseSkillContent:sourceBase.content,baseSkillContent}),now);
      for (const [ordinal, section] of publicSections.entries()) db.prepare(`INSERT INTO cloud_market_version_sections
        (market_version_id,section_id,title,content_hash,content_json,ordinal,created_at) VALUES (?,?,?,?,?,?,?)`).run(
        versionId, section.sectionId, section.title, section.contentHash, JSON.stringify(section), ordinal, now);
      db.prepare(`INSERT INTO cloud_market_version_health (market_version_id,baseline_score,baseline_failure_rate,status,updated_at)
        VALUES (?,?,?,'collecting',?)`).run(versionId, baseline.score, baseline.failureRate, now);
      releasedVersions.push({ familyId: family.familyId, versionId });
    }
    db.prepare("UPDATE cloud_market_agent_candidates SET status='released',released_at=?,status_reason='',updated_at=? WHERE id=?").run(now, now, candidate.id);
    db.prepare("UPDATE cloud_market_candidate_family_sections SET status='released' WHERE candidate_id=?").run(candidate.id);
    db.prepare("UPDATE cloud_evolution_runs SET status='applied',completed_at=?,updated_at=? WHERE id=?").run(now, now, run.id);
    db.prepare("UPDATE cloud_evolution_jobs SET status='completed',completed_at=?,updated_at=? WHERE id=?").run(now, now, job.id);
    createSqliteEvidenceUsageLedger(db).transitionRun({ scope: 'cluster', consumerId: run.cohort_id, runId: run.id,
      toStatus: 'consumed', transitionReason: 'market_released', now, clusterClaims: true });
  });
  return { runId: run.id, candidateId: candidate.id, status: 'released', marketVersionId: releasedVersions[0]?.versionId || '', marketVersions: releasedVersions };
}

function persistSqliteShadowEvaluations(db, candidateId, evaluations = [], now) {
  for (const [index, item] of evaluations.entries()) db.prepare(`INSERT OR REPLACE INTO cloud_market_evaluations (
    id,candidate_id,evaluation_kind,case_index,status,regression,privacy_violation,role_violation,result_json,created_at
  ) VALUES (?,?,'async_cross_user_shadow',?,'completed',?,?,?,?,?)`).run(stableId('meval', candidateId, 'shadow', index), candidateId,
    index, item.regression ? 1 : 0, item.privacyViolation ? 1 : 0, item.roleViolation ? 1 : 0, JSON.stringify({ ...item, ownerUserId: undefined }), now);
}

function marketHealthBaseline(db,cohortId,instanceIds=[]) {
  let rows=db.prepare('SELECT payload_json FROM cloud_agent_cohort_members WHERE cohort_id=?').all(cohortId).map((row)=>parseObject(row.payload_json).performance||{});
  if(!rows.length&&instanceIds.length)rows=instanceIds.map((id)=>db.prepare('SELECT payload_json FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(id)).filter(Boolean).map((row)=>parseObject(row.payload_json));
  const scores = rows.map((row) => Number(row.score || 0)).filter(Number.isFinite);
  const failures = rows.map((row) => Number(row.failureRate || 0)).filter(Number.isFinite);
  return { score: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0,
    failureRate: failures.length ? failures.reduce((sum, value) => sum + value, 0) / failures.length : 0 };
}

function projectEffectiveSkill(db, { userId, instance, marketVersionId }) {
  const adoptedRows = db.prepare(`SELECT a.*,v.created_at version_created_at FROM cloud_user_market_adoptions a
    JOIN cloud_market_agent_versions v ON v.id=a.market_version_id
    WHERE a.user_id=? AND a.user_agent_instance_id=? AND a.status='adopted' ORDER BY v.created_at,a.updated_at`).all(userId, instance.id);
  const fullAdoption = adoptedRows.filter((row) => row.section_id === '*').at(-1) || null;
  const fullVersion=fullAdoption?db.prepare('SELECT * FROM cloud_market_agent_versions WHERE id=?').get(fullAdoption.market_version_id):null;
  const baseSections = fullAdoption ? db.prepare('SELECT * FROM cloud_market_version_sections WHERE market_version_id=? ORDER BY ordinal').all(fullAdoption.market_version_id).map(sectionPayload) : [];
  const sectionRows = adoptedRows.filter((row) => row.section_id !== '*');
  const sections = sectionRows.map((row) => sectionPayload(db.prepare('SELECT * FROM cloud_market_version_sections WHERE market_version_id=? AND section_id=?').get(row.market_version_id, row.section_id) || {}));
  const canaryAssignment=db.prepare(`SELECT a.candidate_id FROM cloud_market_canary_assignments a
    JOIN cloud_market_agent_candidates c ON c.id=a.candidate_id
    WHERE a.user_id=? AND a.user_agent_instance_id=? AND a.status='enrolled' AND c.status='canary_running'
    ORDER BY a.started_at DESC LIMIT 1`).get(userId,instance.id);
  const canarySections=canaryAssignment?db.prepare(`SELECT * FROM cloud_market_candidate_family_sections
    WHERE candidate_id=? AND agent_family_id=? ORDER BY section_id`).all(canaryAssignment.candidate_id,instance.agent_family_id).map(sectionPayload):[];
  const overlay = cloudOverlayText(db, instance);
  const fullVersionPayload=parseObject(fullVersion?.payload_json);
  const baseSkill=fullVersion?.version_kind==='market_base'
    ?String(fullVersionPayload.sourceBaseSkillContent||fullVersionPayload.baseSkillContent||cloudBaseSkillText(db,instance))
    :cloudBaseSkillText(db, instance);
  const compiledSections = [...baseSections, ...sections, ...canarySections];
  const conflictIds = deriveOverlayConflictIndex(overlay, compiledSections);
  const resolutions = {
    ...parseObject(fullAdoption?.payload_json).conflictResolutions,
    ...Object.fromEntries(sectionRows.map((row) => [row.section_id, parseObject(row.payload_json).conflictResolution || (conflictIds.includes(row.section_id) ? 'personal' : 'none')])),
  };
  for (const sectionId of conflictIds) if (!Object.hasOwn(resolutions, sectionId)) resolutions[sectionId] = 'personal';
  const marketSkill = compileMarketEffectiveSkill({ baseSections, adoptedSections:[...sections,...canarySections],personalOverlay:overlay,conflictResolutions:resolutions });
  const effectiveSkill = [baseSkill.trim(), marketSkill.trim()].filter(Boolean).join('\n\n');
  const activeMarketVersionId = fullAdoption?.market_version_id || sectionRows.at(-1)?.market_version_id || marketVersionId || '';
  const payload = { userId, agentInstanceId: instance.id, marketVersionId: activeMarketVersionId,
    fullMarketVersionId: fullAdoption?.market_version_id || '', adoptedSections: sections.map((item) => item.sectionId),
    canaryCandidateId:canaryAssignment?.candidate_id||'',canarySections:canarySections.map((item)=>item.sectionId),
    conflicts: conflictIds.map((sectionId) => ({ sectionId, resolution: resolutions[sectionId] || 'personal' })), effectiveSkill };
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cloud_effective_skill_projections (user_id,user_agent_instance_id,market_version_id,adopted_sections_json,conflicts_json,effective_skill_hash,payload_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,user_agent_instance_id) DO UPDATE SET market_version_id=excluded.market_version_id,adopted_sections_json=excluded.adopted_sections_json,conflicts_json=excluded.conflicts_json,effective_skill_hash=excluded.effective_skill_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(
    userId, instance.id, activeMarketVersionId, JSON.stringify(payload.adoptedSections), JSON.stringify(payload.conflicts), sha256(effectiveSkill), JSON.stringify(payload), now,
  );
  return { status: 'applied', authority: 'cloud', ...payload, effectiveSkillHash: sha256(effectiveSkill), updatedAt: now };
}

function cloudOverlayText(db, instance) {
  const activeOverlay = instance.active_personal_skill_version_id ? db.prepare('SELECT payload_json FROM cloud_user_agent_skill_versions_v3 WHERE user_id=? AND id=?').get(instance.user_id, instance.active_personal_skill_version_id) : null;
  const payload = parseObject(activeOverlay?.payload_json);
  return String(payload.overlayText || payload.overlay_text || '');
}

function cloudBaseSkillText(db, instance) {
  const version = db.prepare('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=? AND agent_family_id=?').get(instance.base_agent_version_id, instance.agent_family_id);
  const payload = parseObject(version?.payload_json);
  return String(payload.baseSkillContent || payload.base_skill_content || payload.skill || '');
}

function sqliteMarketBaseSource(db,familyId){
  const member=db.prepare("SELECT base_agent_version_id FROM cloud_user_agent_instances_v3 WHERE agent_family_id=? AND status='active' ORDER BY updated_at DESC LIMIT 1").get(familyId);
  const versionId=member?.base_agent_version_id||'';
  const payload=parseObject(db.prepare('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=? AND agent_family_id=?').get(versionId,familyId)?.payload_json);
  return {versionId,content:String(payload.baseSkillContent||payload.base_skill_content||payload.skill||'')};
}

function marketConflictPreview({ userId, instance, marketVersionId, overlay, sections, conflictIds }) {
  return {
    status: 'conflict_required', authority: 'cloud', userId, agentInstanceId: instance.id, marketVersionId,
    conflicts: sections.filter((section) => conflictIds.includes(section.sectionId)).map((section) => ({
      sectionId: section.sectionId, title: section.title, marketContent: section.content, personalOverlay: overlay,
    })),
  };
}

function normalizeAdoptionMode(mode) {
  const value = String(mode || 'sections').trim().toLowerCase();
  if (!['full', 'sections'].includes(value)) throw codedError('market_adoption_mode_invalid', 'Market adoption mode must be full or sections.', 400);
  return value;
}

function evaluateSqliteMarketVersionHealth(db, version, now = new Date()) {
  const health = db.prepare('SELECT * FROM cloud_market_version_health WHERE market_version_id=?').get(version.id) || {};
  if (version.status === 'suspended') return marketHealthPayload(version, health);
  const adoptions = db.prepare(`SELECT user_id,user_agent_instance_id,MIN(updated_at) adopted_at FROM cloud_user_market_adoptions
    WHERE market_version_id=? AND status='adopted' GROUP BY user_id,user_agent_instance_id`).all(version.id);
  const userCount = new Set(adoptions.map((row) => row.user_id)).size;
  const instanceIds = [...new Set(adoptions.map((row) => row.user_agent_instance_id))];
  const levels = instanceIds.map((id) => db.prepare('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=?').get(id)).filter(Boolean);
  const scores = levels.map((row) => Number(row.score)).filter(Number.isFinite);
  const events = instanceIds.flatMap((id) => db.prepare('SELECT * FROM cloud_agent_performance_events WHERE user_agent_instance_id=? ORDER BY occurred_at').all(id));
  const taskMap = new Map();
  let confirmedViolation = '';
  for (const row of events) {
    const payload = parseObject(row.payload_json);
    const key = `${row.user_agent_instance_id}:${row.task_id || row.id}`;
    taskMap.set(key, payload);
    if (payload.confirmedPrivacyViolation || payload.privacyViolationConfirmed) confirmedViolation = 'confirmed_privacy_violation';
    if (payload.confirmedRoleViolation || payload.roleViolationConfirmed) confirmedViolation ||= 'confirmed_role_violation';
  }
  const tasks = [...taskMap.values()];
  const observedTaskCount = tasks.length;
  const failureRate = observedTaskCount ? tasks.filter((item) => item.failed || item.blocked).length / observedTaskCount : 0;
  const latestScore = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const day = now.toISOString().slice(0, 10);
  const inputHash = sha256(JSON.stringify({ day, versionId: version.id, users: adoptions.map((row) => row.user_id).sort(),
    levels: levels.map((row) => [row.user_agent_instance_id, row.score, row.completed_task_count, row.updated_at]),
    tasks: events.map((row) => [row.id, row.event_kind, row.occurred_at]) }));
  if (confirmedViolation) return suspendSqliteMarketVersion(db, version, health, {
    reason: confirmedViolation, userCount, observedTaskCount, latestScore, failureRate, inputHash, now,
  });
  if (userCount < 3 || observedTaskCount < 10) {
    db.prepare(`UPDATE cloud_market_version_health SET user_count=?,observed_task_count=?,latest_score=?,latest_failure_rate=?,status='collecting',status_reason='insufficient_observations',updated_at=? WHERE market_version_id=?`)
      .run(userCount, observedTaskCount, latestScore, failureRate, now.toISOString(), version.id);
    return marketHealthPayload(version, db.prepare('SELECT * FROM cloud_market_version_health WHERE market_version_id=?').get(version.id));
  }
  if (health.last_input_hash === inputHash) return marketHealthPayload(version, health);
  const scoreRegression = Number(health.baseline_score || 0) - latestScore >= 10;
  const failureRegression = failureRate - Number(health.baseline_failure_rate || 0) >= 0.10;
  const regressing = scoreRegression || failureRegression;
  const windows = regressing ? Number(health.consecutive_regression_windows || 0) + 1 : 0;
  if (windows >= 2) return suspendSqliteMarketVersion(db, version, health, {
    reason: scoreRegression ? 'score_regression_two_windows' : 'failure_regression_two_windows', userCount,
    observedTaskCount, latestScore, failureRate, inputHash, now, windows,
  });
  db.prepare(`UPDATE cloud_market_version_health SET user_count=?,observed_task_count=?,latest_score=?,latest_failure_rate=?,
    consecutive_regression_windows=?,last_input_hash=?,status=?,status_reason=?,evaluated_at=?,updated_at=? WHERE market_version_id=?`).run(
    userCount, observedTaskCount, latestScore, failureRate, windows, inputHash, regressing ? 'regressing' : 'healthy',
    regressing ? (scoreRegression ? 'score_regression' : 'failure_regression') : '', now.toISOString(), now.toISOString(), version.id,
  );
  return marketHealthPayload(version, db.prepare('SELECT * FROM cloud_market_version_health WHERE market_version_id=?').get(version.id));
}

function suspendSqliteMarketVersion(db, version, health, { reason, userCount, observedTaskCount, latestScore, failureRate, inputHash, now, windows = 2 }) {
  transaction(db, () => {
    db.prepare("UPDATE cloud_market_agent_versions SET status='suspended',suspended_at=?,status_reason=? WHERE id=? AND status='released'").run(now.toISOString(), reason, version.id);
    db.prepare(`UPDATE cloud_market_version_health SET user_count=?,observed_task_count=?,latest_score=?,latest_failure_rate=?,
      consecutive_regression_windows=?,last_input_hash=?,status='suspended',status_reason=?,evaluated_at=?,updated_at=? WHERE market_version_id=?`).run(
      userCount, observedTaskCount, latestScore, failureRate, windows, inputHash, reason, now.toISOString(), now.toISOString(), version.id,
    );
  });
  return marketHealthPayload({ ...version, status: 'suspended', suspended_at: now.toISOString(), status_reason: reason },
    db.prepare('SELECT * FROM cloud_market_version_health WHERE market_version_id=?').get(version.id));
}

function marketHealthPayload(version, row = {}) {
  return { marketVersionId: version.id, status: row.status || 'collecting', versionStatus: version.status,
    statusReason: row.status_reason || version.status_reason || '', userCount: Number(row.user_count || 0),
    observedTaskCount: Number(row.observed_task_count || 0), baselineScore: Number(row.baseline_score || 0),
    latestScore: Number(row.latest_score || 0), baselineFailureRate: Number(row.baseline_failure_rate || 0),
    latestFailureRate: Number(row.latest_failure_rate || 0), consecutiveRegressionWindows: Number(row.consecutive_regression_windows || 0),
    evaluatedAt: row.evaluated_at || '', suspendedAt: version.suspended_at || '' };
}

function skipClusterRunForWeightCap(db, { cohort, cohortId, triggerKind, evidenceCount, userCount, evaluationIntervalMs }) {
  const runId = `clrun_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const summary = `At least ${CLUSTER_MIN_USERS} positive-weight users are required to enforce the ${CLUSTER_USER_WEIGHT_CAP} user weight cap.`;
  db.prepare(`INSERT INTO cloud_evolution_runs (id,evolution_scope,agent_family_id,cohort_id,consumer_id,algorithm_version,trigger_kind,status,evidence_count,summary,error_code,created_at,updated_at,completed_at)
    VALUES (?,'cluster',?,?,?,?,?,'skipped',?,?,'insufficient_users_for_weight_cap',?,?,?)`).run(
    runId, cohort.agent_family_id || '', cohortId, cohortId, PHASE8_ALGORITHM_VERSION, triggerKind, evidenceCount, summary, now, now, now,
  );
  return {
    status: 'insufficient_users_for_weight_cap', runId, evidenceCount, userCount,
    minimumUsers: CLUSTER_MIN_USERS, maximumUserWeightShare: CLUSTER_USER_WEIGHT_CAP,
    nextEligibleAt: new Date(Date.now() + evaluationIntervalMs).toISOString(),
  };
}

function distinctWeightUserCount(items) {
  return new Set(items.filter((item) => Number(item.rawWeight || 0) > 0).map((item) => String(item.ownerUserId || '')).filter(Boolean)).size;
}

function latestMarketSections(db, familyId) { const version = db.prepare("SELECT id FROM cloud_market_agent_versions WHERE agent_family_id=? AND status='released' ORDER BY created_at DESC LIMIT 1").get(familyId); return version ? db.prepare('SELECT * FROM cloud_market_version_sections WHERE market_version_id=? ORDER BY ordinal').all(version.id).map(sectionPayload) : []; }
function marketCandidatePayload(db, row) {
  const payload = parseObject(row.payload_json);
  const sections = db.prepare('SELECT * FROM cloud_market_candidate_family_sections WHERE candidate_id=? ORDER BY agent_family_id,section_id').all(row.id)
    .map((item) => ({ agentFamilyId: item.agent_family_id, sectionId: item.section_id, title: item.title,
      contentHash: item.content_hash, supportCount: Number(item.support_count || 0), status: item.status }));
  const evaluations = db.prepare('SELECT * FROM cloud_market_evaluations WHERE candidate_id=? ORDER BY evaluation_kind,case_index').all(row.id)
    .map((item) => ({ evaluationKind: item.evaluation_kind, caseIndex: Number(item.case_index || 0), status: item.status,
      regression: Boolean(item.regression), privacyViolation: Boolean(item.privacy_violation), roleViolation: Boolean(item.role_violation) }));
  return { ...payload, id: row.id, status: row.status, statusReason: row.status_reason || '', revisionNo: Number(row.revision_no || 0),
    diagnosis: parseObject(row.diagnosis_json), gate: parseObject(row.gate_json), governance: parseArray(row.governance_json),
    canaryStartedAt: row.canary_started_at || '', canaryDeadlineAt: row.canary_deadline_at || '', releasedAt: row.released_at || '',
    familySections: sections, evaluations, createdAt: row.created_at, updatedAt: row.updated_at };
}
function marketVersionPayload(db, row, { userId = '', agentInstanceId = '' } = {}) {
  const adoptions = userId && agentInstanceId ? db.prepare(`SELECT section_id,adoption_mode,status,payload_json,updated_at
    FROM cloud_user_market_adoptions WHERE user_id=? AND user_agent_instance_id=? AND market_version_id=? ORDER BY section_id`).all(userId, agentInstanceId, row.id) : [];
  const health = db.prepare('SELECT * FROM cloud_market_version_health WHERE market_version_id=?').get(row.id);
  return { id: row.id, agentFamilyId: row.agent_family_id, parentVersionId: row.parent_version_id,
    versionKind: row.version_kind || 'legacy_sections', baseAgentVersionId: row.base_agent_version_id || '', status: row.status,
    suspendedAt: row.suspended_at || '', statusReason: row.status_reason || '',
    sections: db.prepare('SELECT * FROM cloud_market_version_sections WHERE market_version_id=? ORDER BY ordinal').all(row.id).map(sectionPayload),
    adoption: { full: adoptions.find((item) => item.section_id === '*')?.status || '', sections: Object.fromEntries(adoptions.filter((item) => item.section_id !== '*').map((item) => [item.section_id, item.status])) },
    health: health ? marketHealthPayload(row, health) : null, ...parseObject(row.payload_json), createdAt: row.created_at };
}
function sectionPayload(row) { const content=parseObject(row.content_json);return { ...content, sectionId: content.sectionId || row.section_id, title: content.title || row.title, contentHash: content.contentHash || row.content_hash,supportCount:Number((row.support_count??content.supportCount)||0) }; }
function publicMarketSection(section) { return { ...section,supportCount:Number(section.supportCount||0) }; }
function supportProofForSection(family,sectionId){return (family.supportProofs||[]).find((item)=>item.sectionId===sectionId)
  ||{sectionId,supportCount:0,items:[],reviewStage:'unknown'};}
function candidateRejectionStatus(reason = '') {
  const kind = evidenceRejectionKindForReason(reason);
  if (kind === 'privacy') return 'privacy_rejected';
  if (kind === 'regression') return 'regression_rejected';
  if (kind === 'hr_review' || kind === 'mixed') return 'governance_rejected';
  return 'gate_rejected';
}
function cohortPayload(row) { return { ...parseObject(row?.payload_json), id: row?.id, cohortKey: row?.cohort_key || parseObject(row?.payload_json).cohortKey || '', identityVersion: row?.identity_version || '', agentFamilyId: row?.agent_family_id || '', departmentId: row?.department_id || '', status: row?.status }; }
function runPayload(row) { return { id: row.id, scope: row.evolution_scope, cohortId: row.cohort_id || '', agentFamilyId: row.agent_family_id || '', status: row.status, evidenceCount: Number(row.evidence_count || 0), summary: row.summary || '', errorCode: row.error_code || '', createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || '' }; }
function claimClusterJob(db, workerId) {
  const now=new Date().toISOString();
  const row=db.prepare(`SELECT * FROM cloud_evolution_jobs WHERE job_kind IN ('cluster_evolution','cluster_shadow') AND
    ((status IN ('queued','failed_retryable') AND (available_at='' OR available_at<=?))
      OR (status IN ('claimed','running') AND lease_expires_at<>'' AND lease_expires_at<=?))
    AND attempt_count<max_attempts ORDER BY available_at,created_at LIMIT 1`).get(now,now);
  if(!row)return null;
  const lease=new Date(Date.now()+15*60000).toISOString();
  const result=db.prepare("UPDATE cloud_evolution_jobs SET status='claimed',claimed_by=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE id=? AND attempt_count=?").run(workerId,lease,now,row.id,row.attempt_count);
  if(!result.changes)return null;
  createSqliteEvidenceUsageLedger(db).refreshRunLease({scope:'cluster',runId:row.run_id,leaseExpiresAt:lease,now});
  return db.prepare('SELECT * FROM cloud_evolution_jobs WHERE id=?').get(row.id);
}
function failClusterJob(db,job,error) {
  const terminal=Number(job.attempt_count||0)>=Number(job.max_attempts||3);const now=new Date().toISOString();
  const run=db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(job.run_id);
  transaction(db,()=>{
    if(job.job_kind==='cluster_shadow') db.prepare("UPDATE cloud_market_agent_candidates SET status='archived',status_reason=?,updated_at=? WHERE run_id=? AND status='governance_approved'").run(error.code||'cluster_worker_failed',now,run.id);
    db.prepare('UPDATE cloud_evolution_jobs SET status=?,error_code=?,error_text=?,lease_expires_at=\'\',updated_at=?,completed_at=? WHERE id=?').run(terminal?'failed_terminal':'completed',error.code||'cluster_worker_failed',String(error.message||error).slice(0,2000),now,now,job.id);
    db.prepare('UPDATE cloud_evolution_runs SET status=?,error_code=?,error_text=?,updated_at=?,completed_at=? WHERE id=?').run(terminal?'failed_terminal':'failed_retryable',error.code||'cluster_worker_failed',String(error.message||error).slice(0,2000),now,now,run.id);
    createSqliteEvidenceUsageLedger(db).transitionRun({scope:'cluster',consumerId:run.cohort_id,runId:run.id,toStatus:'released',transitionReason:'infrastructure_failure',now,clusterClaims:true});
  });
  return {runId:run.id,status:terminal?'failed_terminal':'failed_retryable',error:error.message||String(error)};
}
function clusterReEvaluationBasisByEvidence(db, runId) {
  const run = db.prepare('SELECT * FROM cloud_evolution_runs WHERE id=?').get(runId);
  const cohort = db.prepare('SELECT * FROM cloud_agent_cohorts WHERE id=?').get(run?.cohort_id || '');
  const frozen=parseObject(db.prepare('SELECT cohort_snapshot_json FROM cloud_evolution_run_snapshots WHERE run_id=?').get(runId)?.cohort_snapshot_json).members;
  const memberIds=new Set(Array.isArray(frozen)&&frozen.length?frozen.map((row)=>row.agentInstanceId):db.prepare('SELECT user_agent_instance_id FROM cloud_agent_cohort_members WHERE cohort_id=?').all(run?.cohort_id||'').map((row)=>row.user_agent_instance_id));
  const evidence = db.prepare("SELECT * FROM cloud_evolution_evidence WHERE quarantine_reason='' AND validation_status='validated' AND historical_inactive=0 AND json_extract(metadata_json,'$.allowedEvolutionScopes') LIKE '%cluster%'").all()
    .filter((row) => memberIds.has(row.user_agent_instance_id));
  const relatedByCategory = new Map();
  for (const row of evidence) {
    const category = clusterEvidenceCategory(row.source_kind);
    if (!relatedByCategory.has(category)) relatedByCategory.set(category, []);
    relatedByCategory.get(category).push(row.evidence_id);
  }
  const basisByCategory = new Map([...relatedByCategory].map(([category, ids]) => [category, clusterReEvaluationBasisHash({
    cohortKey: cohort?.cohort_key || parseObject(cohort?.payload_json).cohortKey || `legacy:${run?.cohort_id || ''}`,
    evidenceCategory: category, algorithmVersion: run?.algorithm_version || PHASE8_ALGORITHM_VERSION,
    policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION, relatedEvidenceIds: ids,
  })]));
  return new Map(db.prepare(`SELECT e.evidence_id,e.source_kind FROM cloud_evolution_evidence e
    JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    WHERE u.run_id=? AND u.evolution_scope='cluster'`).all(runId).map((row) => [row.evidence_id, basisByCategory.get(clusterEvidenceCategory(row.source_kind)) || '']));
}
function sqliteTaskPerformanceSource(db,{ownerUserId='',agentInstanceId='',sourceId=''}={}){
  const row=db.prepare('SELECT * FROM cloud_task_nodes WHERE id=?').get(sourceId);if(!row)return null;
  const node={...parseObject(row.payload_json),id:row.id,task_run_id:row.task_run_id,
    user_agent_instance_id:row.user_agent_instance_id,updated_at:row.updated_at};
  const instanceId=String(row.user_agent_instance_id||node.agentInstanceId||node.agent_instance_id||'');
  const runRow=db.prepare('SELECT * FROM cloud_task_runs WHERE id=?').get(row.task_run_id||node.taskRunId||node.task_run_id||'');
  const instance=db.prepare('SELECT * FROM cloud_user_agent_instances_v3 WHERE id=?').get(instanceId);
  if(!runRow||!instance)return null;
  const run={...parseObject(runRow.payload_json),id:runRow.id,owner_user_id:runRow.owner_user_id};
  const resolvedOwner=String(runRow.owner_user_id||run.ownerUserId||run.owner_user_id||'');
  if((ownerUserId&&resolvedOwner!==ownerUserId)||(agentInstanceId&&instance.id!==agentInstanceId)||instance.user_id!==resolvedOwner)
    throw codedError('performance_source_identity_mismatch','Performance source does not belong to the granted Agent instance.',403);
  const event=deriveAuthoritativeTaskPerformanceEvent({node,run,instance,sourceVersionId:row.updated_at});
  if(!event)return null;
  event.occurredAt=row.updated_at||event.occurredAt;
  event.id=stableId('pevent',event.ownerUserId,event.agentInstanceId,event.sourceKind,event.sourceId,event.sourceVersionId);
  return event;
}
function persistSqlitePerformanceEvent(db,event,keyring){
  return transaction(db,()=>{
    const changes=db.prepare(`INSERT OR IGNORE INTO cloud_agent_performance_events (
      id,owner_user_id,user_agent_instance_id,agent_family_id,task_id,task_type_key,event_kind,occurred_at,
      source_kind,source_id,source_version_id,source_hash,authority,validation_status,payload_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(event.id,event.ownerUserId,event.agentInstanceId,event.agentFamilyId,
      event.taskId,event.taskTypeKey,event.eventKind,event.occurredAt,event.sourceKind,event.sourceId,event.sourceVersionId,
      event.sourceHash,'cloud','validated',JSON.stringify(event)).changes;
    if(changes)createSqliteAuthoritativeEvidence(db,{keyring,ownerUserId:event.ownerUserId,userAgentInstanceId:event.agentInstanceId,
      agentFamilyId:event.agentFamilyId,sourceKind:'model_execution_metric',sourceId:event.id,sourceVersionId:event.sourceVersionId,
      content:event,taskId:event.taskId,occurredAt:event.occurredAt,confidence:1,
      metadata:{performanceEventKind:event.eventKind,sourceKind:event.sourceKind,sourceId:event.sourceId}});
    return changes;
  });
}
function sqlitePerformanceEventPayload(row){return {...parseObject(row.payload_json),agentInstanceId:row.user_agent_instance_id,
  agentFamilyId:row.agent_family_id,sourceKind:row.source_kind,sourceId:row.source_id,sourceVersionId:row.source_version_id,
  authority:row.authority,validationStatus:row.validation_status};}
function auditClusterEvidenceAccess(db,{workerIdentity='embedded-evolution-worker',runId='',evidenceId='',result,resultCode='',keyId='',detail={}}={}){
  db.prepare(`INSERT INTO cloud_evolution_evidence_access_audits
    (id,worker_identity,run_id,evidence_id,purpose,result,result_code,key_id,detail_json,created_at)
    VALUES(?,?,?,?,'cluster_evolution',?,?,?,?,?)`).run(`evaudit_${crypto.randomUUID()}`,workerIdentity,runId,evidenceId,result,
    resultCode,keyId,JSON.stringify(detail),new Date().toISOString());
}
function transaction(db, callback) { db.exec('BEGIN IMMEDIATE'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; } }

function marketEvidenceSourceKind(action='') {
  return action === 'adopt' ? 'market_adoption' : action === 'rollback' ? 'market_rollback' : 'market_rejection';
}
function parseObject(value) { if (value && typeof value === 'object' && !Array.isArray(value)) return value; try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } }
function parseArray(value) { if (Array.isArray(value)) return value; try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function objectValue(value) { return parseObject(typeof value === 'string' ? value : JSON.stringify(value || {})); }
function uniqueStrings(values = []) { return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]; }
function stableId(prefix, ...parts) { return `${prefix}_${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32)}`; }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function assertEnabled(enabled) { if (!enabled) throw codedError('phase8_not_enabled', 'Stage 8 evolution is not enabled.', 409); }
function assertClusterReady({ enabled, modelAvailable, encryptionAvailable }) { assertEnabled(enabled); if (!encryptionAvailable) throw codedError('evolution_encryption_key_unavailable', 'Evolution evidence encryption is not configured.', 503); if (!modelAvailable) throw codedError('evolution_worker_unavailable', 'Cluster evolution model is not configured.', 503); }
function assertMarketReady({ enabled, encryptionAvailable }) { assertEnabled(enabled); if (!encryptionAvailable) throw codedError('evolution_encryption_key_unavailable', 'Evolution overlay encryption is not configured.', 503); }
function clusterEvidenceSnapshot(row) { return { evidenceId: row.evidence_id, evidenceCategory: row.evidenceCategory || clusterEvidenceCategory(row.source_kind), eligibilityKind: row.eligibilityKind || 'new', rawWeight: row.rawWeight, effectiveWeight: row.effectiveWeight, cohortRawTotal: row.cohortRawTotal, userCap: row.userCap }; }
function clusterEvidenceRecord(row) { return { ...row, evidenceId: row.evidence_id, agentInstanceId: row.user_agent_instance_id, ownerUserId: row.owner_user_id, sourceKind: row.source_kind }; }
function nonnegativeInteger(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback; }
function clusterCadence(run, { evaluationIntervalMs, retryIntervalMs }) { if (!run?.created_at) return { deferred: false, nextEligibleAt: '' }; const interval = run.status === 'failed_retryable' ? retryIntervalMs : evaluationIntervalMs; const next = Date.parse(run.created_at) + interval; return { deferred: Date.now() < next, nextEligibleAt: new Date(next).toISOString() }; }
function userEvolutionEnabled(db, userId = '') {
  return true;
}
function codedError(code, message, status = 400, details = {}) { const error = new Error(message); error.code = code; error.status = status; error.details = details; return error; }
