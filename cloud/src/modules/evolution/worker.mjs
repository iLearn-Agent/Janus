import crypto from 'node:crypto';

import {
  decryptEvolutionPayload,
  encryptEvolutionPayload,
  evidenceRejectionKindForReason,
  evolutionEncryptionReady,
  EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,
  evolutionEvidencePrivacyFindings,
  evolutionEvidencePrivacyPolicyUpgradeable,
  evolutionEnvelopePrivateKeyringFromEnv,
  evolutionEnvelopePublicKeyringFromEnv,
  evolutionKeyringFromEnv,
  evolutionWorkerDecryptionKeyringFromEnv,
  PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS,
  PERSONAL_EVOLUTION_RETRY_INTERVAL_MS,
  runPersonalEvolutionCore,
  rewrapEvolutionEnvelope,
  sanitizeEvolutionPayloadForStorage,
} from '../../../../src/shared/evolution/index.js';
import { scanDuePostgresPersonalEvolutionRuns } from './personalQueue.mjs';
import { createPostgresAuthoritativeEvidence } from './authoritativeEvidence.mjs';
import { createPostgresEvidenceUsageLedger } from './evidenceUsageLedger.mjs';
import { createEvolutionModelExecutor } from './modelProvider.mjs';

export function createPostgresEvolutionWorker({ pool, env = process.env, modelExecutor = null } = {}) {
  if (!pool) throw new Error('PostgreSQL evolution Worker requires a pool.');
  const keyring = evolutionWorkerDecryptionKeyringFromEnv(env);
  const rotationPrivateKeyring = evolutionEnvelopePrivateKeyringFromEnv(env);
  const rotationPublicKeyring = evolutionEnvelopePublicKeyringFromEnv(env);
  const executeModel = modelExecutor || createEvolutionModelExecutor({ env });
  const encryptionReady = evolutionEncryptionReady(keyring) || Boolean(keyring.allowPlaintextTestOnly);
  return {
    async tick({ workerId = `pg_${process.pid}`, limit = 1 } = {}) {
      const rotationReady = Boolean(rotationPublicKeyring.activeKeyId
        && rotationPublicKeyring.keys?.[rotationPublicKeyring.activeKeyId]
        && Object.keys(rotationPrivateKeyring.keys || {}).length);
      const rotation = rotationReady
        ? await rewrapPostgresEvolutionEvidence(pool, { env, workerId, limit: Number(env.JANUS_EVOLUTION_REWRAP_BATCH_SIZE || 100) })
        : { status: 'not_configured', targetKeyId: rotationPublicKeyring.activeKeyId || '', rewrapped: [], failed: [] };
      await requeuePostgresEvidenceForValidationPolicy(pool, { limit: 100 });
      await requeuePostgresEvidenceForAvailableKeys(pool, { keyring, limit: 100 });
      await validatePendingEvidence(pool,{workerId,limit:Math.max(5,Number(limit||1)*5),keyring});
      await createPostgresEvidenceUsageLedger(pool).releaseExpired();
      await reconcileLegacyProposedRuns(pool, { limit: Math.max(5, Number(limit || 1) * 5), keyring });
      const modelReady = typeof executeModel === 'function' && executeModel.available !== false;
      if (!modelReady || !encryptionReady) return { status: 'unavailable', authority: 'cloud', workerId, rotation,
        code: !encryptionReady ? 'evolution_encryption_key_unavailable' : 'evolution_model_unavailable', completed: [] };
      const scheduled = await scanDuePostgresPersonalEvolutionRuns(pool, { limit: Math.max(5, Number(limit || 1) * 5), keyring });
      const completed = [];
      for (let index = 0; index < Math.min(5, Math.max(1, Number(limit || 1))); index += 1) {
        const job = await claimJob(pool, workerId);
        if (!job) break;
        try { completed.push(await executeJob({ pool, job, executeModel, keyring })); }
        catch (error) { completed.push(await failJob(pool, job, error)); }
      }
      return { status: 'ok', authority: 'cloud', workerId, rotation, scheduled, completed };
    },
  };
}

export async function rewrapPostgresEvolutionEvidence(pool,{env=process.env,limit=100,workerId='evolution-key-rotator'}={}){
  if(!pool)throw new Error('PostgreSQL Evolution Evidence rewrap requires a pool.');
  const privateKeyring=evolutionEnvelopePrivateKeyringFromEnv(env);
  const publicKeyring=evolutionEnvelopePublicKeyringFromEnv(env);
  const targetKeyId=publicKeyring.activeKeyId;
  if(!targetKeyId||!publicKeyring.keys?.[targetKeyId])throw new Error('Evolution Worker target public key is not configured.');
  await pool.query(`INSERT INTO cloud_evolution_key_rotation_jobs(evidence_id,target_key_id,source_key_id,status)
    SELECT evidence_id,$1,key_id,'queued' FROM cloud_evolution_evidence
    WHERE encryption_algorithm='aes-256-gcm+rsa-oaep-sha256' AND key_id<>$1
    ON CONFLICT(evidence_id,target_key_id) DO NOTHING`,[targetKeyId]);
  const rows=(await pool.query(`SELECT e.*,j.status AS rotation_status FROM cloud_evolution_key_rotation_jobs j
    JOIN cloud_evolution_evidence e ON e.evidence_id=j.evidence_id
    WHERE j.target_key_id=$1 AND j.status IN ('queued','failed_retryable') AND j.available_at<=now()
    ORDER BY j.available_at,e.ingested_at,e.evidence_id LIMIT $2`,[targetKeyId,Math.min(1000,Math.max(1,Number(limit||100)))])).rows;
  const result={targetKeyId,rewrapped:[],failed:[]};
  for(const row of rows){
    try{
      const claimed=await pool.query(`UPDATE cloud_evolution_key_rotation_jobs SET status='claimed',claimed_by=$1,claimed_at=now(),
        lease_expires_at=now()+interval '15 minutes',attempt_count=attempt_count+1,updated_at=now()
        WHERE evidence_id=$2 AND target_key_id=$3 AND status IN ('queued','failed_retryable') RETURNING evidence_id`,[workerId,row.evidence_id,targetKeyId]);
      if(!claimed.rowCount)continue;
      const next=rewrapEvolutionEnvelope({algorithm:row.encryption_algorithm,keyId:row.key_id,keyVersion:row.key_version,
        wrappedDataKey:row.wrapped_data_key,ciphertext:row.content_ciphertext,nonce:row.content_nonce,tag:row.content_tag},
      {privateKeyring,publicKeyring,targetKeyId});
      await transaction(pool,async(client)=>{
        const updated=await client.query(`UPDATE cloud_evolution_evidence SET wrapped_data_key=$1,key_id=$2,key_version=$3,
          key_wrap_algorithm=$4,envelope_format=$5 WHERE evidence_id=$6 AND key_id=$7`,[next.wrappedDataKey,next.keyId,next.keyVersion,
          next.keyWrapAlgorithm,next.envelopeFormat,row.evidence_id,row.key_id]);
        if(!updated.rowCount)throw Object.assign(new Error('Evolution Evidence key changed during rotation.'),{code:'key_rotation_conflict'});
        await auditEvidenceAccess(client,{workerIdentity:workerId,evidenceId:row.evidence_id,purpose:'key_rotation',result:'allowed',
          resultCode:`${row.key_id}->${targetKeyId}`,keyId:targetKeyId});
        await client.query(`UPDATE cloud_evolution_key_rotation_jobs SET status='completed',completed_at=now(),lease_expires_at=NULL,
          error_code='',error_text='',updated_at=now() WHERE evidence_id=$1 AND target_key_id=$2`,[row.evidence_id,targetKeyId]);
      });
      result.rewrapped.push(row.evidence_id);
    }catch(error){
      await auditEvidenceAccess(pool,{workerIdentity:workerId,evidenceId:row.evidence_id,purpose:'key_rotation',result:'failed',
        resultCode:error.code||'key_rotation_failed',keyId:row.key_id,detail:{message:String(error.message||error).slice(0,500)}});
      await pool.query(`UPDATE cloud_evolution_key_rotation_jobs SET status='failed_retryable',available_at=now()+interval '5 minutes',
        lease_expires_at=NULL,error_code=$1,error_text=$2,updated_at=now() WHERE evidence_id=$3 AND target_key_id=$4`,
      [error.code||'key_rotation_failed',String(error.message||error).slice(0,2000),row.evidence_id,targetKeyId]);
      result.failed.push({evidenceId:row.evidence_id,code:error.code||'key_rotation_failed'});
    }
  }
  return result;
}

async function reconcileLegacyProposedRuns(pool, { limit = 25, keyring } = {}) {
  const rows = (await pool.query(`SELECT id FROM cloud_evolution_runs
    WHERE evolution_scope='personal' AND status='proposed'
    ORDER BY updated_at,id LIMIT $1`, [Math.min(100, Math.max(1, Number(limit || 25)))])).rows;
  for (const row of rows) {
    await transaction(pool, async (client) => {
      const run = (await client.query(`SELECT * FROM cloud_evolution_runs
        WHERE id=$1 AND evolution_scope='personal' AND status='proposed' FOR UPDATE`, [row.id])).rows[0];
      if (!run) return;
      const proposalRow = (await client.query(`SELECT * FROM cloud_personal_evolution_proposals_v4
        WHERE user_id=$1 AND id=$2 FOR UPDATE`, [run.owner_user_id, run.id])).rows[0];
      const candidateId = run.candidate_personal_skill_version_id || proposalRow?.payload_json?.candidatePersonalSkillVersionId || '';
      if (!proposalRow || !candidateId) return markLegacyProposalStale(client, { run, proposalRow, candidateId, reason: 'legacy_candidate_missing' });
      const action = (await client.query(`SELECT id FROM cloud_personal_evolution_actions_v4
        WHERE user_id=$1 AND proposal_id=$2 AND target_kind='skill' AND target_id=$3`, [run.owner_user_id, run.id, candidateId])).rows[0];
      if (action) return;
      const instance = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
        WHERE user_id=$1 AND id=$2 FOR UPDATE`, [run.owner_user_id, run.user_agent_instance_id])).rows[0];
      const baselineMatches = instance
        && instance.status === 'active'
        && instance.sync_enabled
        && instance.personal_evolution_consent
        && String(instance.base_agent_version_id || '') === String(run.base_agent_version_id || '')
        && String(instance.active_personal_skill_version_id || '') === String(run.base_personal_skill_version_id || '');
      if (!baselineMatches) return markLegacyProposalStale(client, { run, proposalRow, candidateId, reason: 'legacy_proposal_stale' });
      await decidePostgresPersonalRunWithClient(client, {
        userId: run.owner_user_id,
        runId: run.id,
        decisions: [{ targetKind: 'skill', targetId: candidateId, decision: 'accept' }],
        actorDeviceId: 'cloud-authority-legacy-convergence',
        automatic: true,
        keyring,
      });
    });
  }
}

async function markLegacyProposalStale(client, { run, proposalRow, candidateId, reason }) {
  if (candidateId) await client.query(`UPDATE cloud_personal_skill_overlay_versions
    SET status='archived',archived_at=now() WHERE user_id=$1 AND id=$2 AND status='candidate'`, [run.owner_user_id, candidateId]);
  if (proposalRow) {
    const payload = { ...(proposalRow.payload_json || {}), status: 'legacy_proposal_stale', decision: 'stale',
      legacyStaleReason: reason, updatedAt: new Date().toISOString() };
    await client.query(`UPDATE cloud_personal_evolution_proposals_v4 SET status='legacy_proposal_stale',
      payload_json=$1::jsonb,updated_at=now() WHERE user_id=$2 AND id=$3`, [JSON.stringify(payload), run.owner_user_id, run.id]);
  }
  await client.query(`UPDATE cloud_evolution_runs SET status='evaluated_rejected',error_code='legacy_proposal_stale',
    error_text=$1,completed_at=now(),updated_at=now() WHERE id=$2`, [reason, run.id]);
  await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'personal',consumerId:run.consumer_id||run.user_agent_instance_id,
    runId:run.id,toStatus:'released',transitionReason:'legacy_proposal_stale'});
  await client.query(`UPDATE cloud_personal_evolution_schedule_states SET last_status='legacy_proposal_stale',
    last_run_id=$1,updated_at=now() WHERE user_agent_instance_id=$2`, [run.id, run.user_agent_instance_id]);
}

export async function evaluatePostgresVersionHealth(pool, {
  userId = '', agentInstanceId = '', score = 0, failureRate = 0, completedTaskCount = 0, inputHash = '',
} = {}) {
  const instance = (await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = $1 AND id = $2', [userId, agentInstanceId])).rows[0];
  if (!instance) throw new Error('Agent instance was not found for version health evaluation.');
  if (!instance.active_personal_skill_version_id || Number(completedTaskCount || 0) < 10) return { status: 'collecting', minimumTasks: 10 };
  const versionId = instance.active_personal_skill_version_id;
  const existing = (await pool.query('SELECT * FROM cloud_personal_version_health WHERE personal_skill_version_id = $1', [versionId])).rows[0];
  const performanceInputHash = String(inputHash || `manual:${completedTaskCount}:${score}:${failureRate}`);
  if (existing?.last_performance_input_hash === performanceInputHash) {
    return { status: existing.status, consecutiveRegressionWindows: Number(existing.consecutive_regression_windows || 0), unchanged: true };
  }
  const baselineScore = existing ? Number(existing.baseline_score) : Number(score);
  const baselineFailureRate = existing ? Number(existing.baseline_failure_rate) : Number(failureRate);
  const regressed = baselineScore - Number(score) >= 10 && Number(failureRate) - baselineFailureRate >= 0.10;
  const windows = regressed ? Number(existing?.consecutive_regression_windows || 0) + 1 : 0;
  const status = windows >= 2 ? 'rollback_required' : regressed ? 'regressing' : 'healthy';
  await pool.query(`INSERT INTO cloud_personal_version_health (
    personal_skill_version_id,user_agent_instance_id,baseline_score,baseline_failure_rate,observed_task_count,
    latest_score,latest_failure_rate,consecutive_regression_windows,last_performance_input_hash,status,evaluated_at,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
  ON CONFLICT(personal_skill_version_id) DO UPDATE SET observed_task_count=excluded.observed_task_count,
    latest_score=excluded.latest_score,latest_failure_rate=excluded.latest_failure_rate,
    consecutive_regression_windows=excluded.consecutive_regression_windows,last_performance_input_hash=excluded.last_performance_input_hash,
    status=excluded.status,evaluated_at=now(),updated_at=now()`,
  [versionId, agentInstanceId, baselineScore, baselineFailureRate, completedTaskCount, score, failureRate, windows, performanceInputHash, status]);
  if (windows < 2) return { status, consecutiveRegressionWindows: windows };
  const current = (await pool.query('SELECT * FROM cloud_personal_skill_overlay_versions WHERE user_id = $1 AND id = $2', [userId, versionId])).rows[0];
  const previousId = current?.parent_version_id || '';
  let memoryRollbacks = [];
  await transaction(pool, async (client) => {
    await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='archived',archived_at=now() WHERE user_id=$1 AND id=$2", [userId, versionId]);
    if (previousId) await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='active',stability_status='stable',activated_at=now(),archived_at=NULL WHERE user_id=$1 AND id=$2", [userId, previousId]);
    await client.query('UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [previousId, userId, agentInstanceId]);
    memoryRollbacks = await rollbackPostgresRunMemoryOperations(client, {
      userId, instanceId: agentInstanceId, runId: current?.source_run_id || '',
    });
    await client.query("UPDATE cloud_personal_version_health SET status='rolled_back',updated_at=now() WHERE personal_skill_version_id=$1", [versionId]);
  });
  return { status: 'rolled_back', previousVersionId: previousId, memoryRollbacks };
}

async function rollbackPostgresRunMemoryOperations(client, { userId = '', instanceId = '', runId = '' } = {}) {
  if (!runId) return [];
  const rows = (await client.query(`SELECT * FROM cloud_personal_evolution_memory_operations_v4
    WHERE user_id=$1 AND proposal_id=$2 AND status='applied' ORDER BY created_at,id`, [userId, runId])).rows;
  const targets = new Map();
  for (const row of rows) {
    const operation = row.payload_json || {};
    if (operation.memoryDocumentId && operation.baselineVersionId && !targets.has(operation.memoryDocumentId)) {
      targets.set(operation.memoryDocumentId, operation.baselineVersionId);
    }
  }
  const results = [];
  for (const [memoryDocumentId, targetVersionId] of targets) {
    const document = (await client.query(`SELECT * FROM cloud_memory_documents_v3
      WHERE user_id=$1 AND id=$2 AND user_agent_instance_id=$3 FOR UPDATE`, [userId, memoryDocumentId, instanceId])).rows[0];
    const target = (await client.query(`SELECT * FROM cloud_memory_document_versions_v3
      WHERE user_id=$1 AND id=$2 AND memory_document_id=$3`, [userId, targetVersionId, memoryDocumentId])).rows[0];
    if (!document || !target) throw new Error('Memory rollback target does not belong to this Agent.');
    const payload = target.payload_json || {};
    const id = `memver_${crypto.randomUUID()}`;
    const versionNo = Number((await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS value
      FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND memory_document_id=$2`, [userId, memoryDocumentId])).rows[0].value);
    const next = { ...payload, id, memoryDocumentId, versionNo, sourceKind: 'cloud_personal_evolution_health_rollback',
      sourceId: runId, createdAt: new Date().toISOString() };
    await client.query(`INSERT INTO cloud_memory_document_versions_v3(user_id,id,memory_document_id,version_no,content_hash,payload_json)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [userId, id, memoryDocumentId, versionNo, target.content_hash, JSON.stringify(next)]);
    await client.query('UPDATE cloud_memory_documents_v3 SET current_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [id, userId, memoryDocumentId]);
    results.push({ memoryDocumentId, activeVersionId: id, sourceVersionId: targetVersionId });
  }
  return results;
}

async function claimJob(pool, workerId) {
  return transaction(pool, async (client) => {
    const usageLedger = createPostgresEvidenceUsageLedger(client);
    const { rows } = await client.query(`SELECT * FROM cloud_evolution_jobs WHERE
      ((status IN ('queued','failed_retryable') AND available_at <= now())
       OR (status IN ('claimed','running') AND lease_expires_at <= now()))
      AND attempt_count < max_attempts ORDER BY available_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!rows[0]) return null;
    const result = await client.query(`UPDATE cloud_evolution_jobs SET status = 'claimed', claimed_by = $1,
      lease_expires_at = now() + interval '15 minutes', attempt_count = attempt_count + 1, updated_at = now()
      WHERE id = $2 RETURNING *`, [workerId, rows[0].id]);
    const run=(await client.query('SELECT consumer_id,algorithm_version FROM cloud_evolution_runs WHERE id=$1',[rows[0].run_id])).rows[0];
    const released=(await client.query("SELECT evidence_id FROM cloud_evolution_evidence_usage WHERE run_id=$1 AND evolution_scope='personal' AND status='released'",[rows[0].run_id])).rows;
    await usageLedger.reserve({scope:'personal',consumerId:run?.consumer_id||'',runId:rows[0].run_id,algorithmVersion:run?.algorithm_version||'',
      evidenceIds:released.map((row)=>row.evidence_id),leaseMinutes:15,transitionReason:'retry_reserved'});
    await usageLedger.refreshRunLease({scope:'personal',runId:rows[0].run_id,leaseMinutes:15});
    await client.query("UPDATE cloud_evolution_runs SET status = 'claimed', updated_at = now() WHERE id = $1", [rows[0].run_id]);
    return result.rows[0];
  });
}

async function executeJob({ pool, job, executeModel, keyring }) {
  const runResult = await pool.query('SELECT * FROM cloud_evolution_runs WHERE id = $1', [job.run_id]);
  const run = runResult.rows[0];
  if (!run) throw terminalError('evolution_run_not_found', 'Evolution run is missing.');
  const instanceResult = await pool.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id = $1 AND id = $2', [run.owner_user_id, run.user_agent_instance_id]);
  const instance = instanceResult.rows[0];
  if (!instance) throw terminalError('agent_instance_not_found', 'Evolution Agent instance is missing.');
  await pool.query("UPDATE cloud_evolution_runs SET status = 'running', updated_at = now() WHERE id = $1", [run.id]);
  await pool.query("UPDATE cloud_evolution_jobs SET status = 'running', updated_at = now() WHERE id = $1", [job.id]);
  const evidenceResult = await pool.query(`SELECT e.* FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id = e.evidence_id
    WHERE u.run_id = $1 AND u.evolution_scope = 'personal' AND u.consumer_id = $2 AND u.status = 'reserved'
    ORDER BY e.occurred_at, e.evidence_id`, [run.id, instance.id]);
  if (evidenceResult.rows.length < 5) {
    await transitionEvidence(pool, run.id, instance.id, 'released', { transitionReason: 'insufficient_evidence' });
    await finishRejected(pool, run.id, job.id, 'skipped', 'insufficient_evidence');
    return { runId: run.id, status: 'skipped' };
  }
  const evidence = [];
  for (const row of evidenceResult.rows) {
    try {
      evidence.push({ evidenceId: row.evidence_id, sourceKind: row.source_kind, role: row.source_kind,
        content: decryptEvolutionPayload({ algorithm: row.encryption_algorithm, keyId: row.key_id,
          ciphertext: row.content_ciphertext, nonce: row.content_nonce, tag: row.content_tag,
          wrappedDataKey: row.wrapped_data_key }, keyring), occurredAt: row.occurred_at });
      await audit(pool, run, row.evidence_id, 'allowed');
      await auditEvidenceAccess(pool,{workerIdentity:job.claimed_by||'evolution-worker',runId:run.id,evidenceId:row.evidence_id,
        purpose:'personal_evolution',result:'allowed',keyId:row.key_id});
    } catch (error) { await audit(pool, run, row.evidence_id, `denied:${error.message}`);
      await auditEvidenceAccess(pool,{workerIdentity:job.claimed_by||'evolution-worker',runId:run.id,evidenceId:row.evidence_id,
        purpose:'personal_evolution',result:'denied',resultCode:error.code||'decrypt_failed',keyId:row.key_id});throw error; }
  }
  const family = (await pool.query('SELECT * FROM cloud_agent_families_v3 WHERE id = $1', [instance.agent_family_id])).rows[0] || {};
  const frozen=await loadPersonalRunSnapshot(pool,run.id,keyring);
  if(JSON.stringify([...frozen.evidenceIds].sort())!==JSON.stringify(evidence.map((item)=>item.evidenceId).sort()))
    throw terminalError('evolution_snapshot_evidence_mismatch','Reserved Evidence no longer matches the immutable run snapshot.');
  const {baseSkill,overlay,memoryDocuments}=frozen;
  const result = await runPersonalEvolutionCore({
    subject: { userId: run.owner_user_id, agentInstanceId: instance.id, agentFamilyId: instance.agent_family_id, departmentId: family.department_id || '' },
    evidenceSnapshot: evidence, baseSkill, personalOverlay: overlay, memoryDocuments,
    reviewerType: family.department_id ? 'department_hr' : 'general_agent_evaluator', modelExecutor: executeModel,
    algorithmVersion: run.algorithm_version,
  });
  await storeEvaluations(pool, run.id, result);
  if (result.status !== 'approved') {
    await transitionEvidence(pool, run.id, instance.id, 'evaluated_rejected', {
      rejectionKind: evidenceRejectionKindForReason(result.reason),
      transitionReason: result.reason || 'evaluated_rejected',
    });
    await finishRejected(pool, run.id, job.id, 'evaluated_rejected', result.reason || 'evaluated_rejected');
    return { runId: run.id, status: 'evaluated_rejected', reason: result.reason };
  }
  const versionId = `psv_${crypto.randomUUID()}`;
  const encrypted = encryptEvolutionPayload(result.candidateOverlay, keyring);
  const effectiveSkill = `${String(baseSkill).trimEnd()}\n\n<!-- JANUS PERSONAL OVERLAY START -->\n${result.candidateOverlay}\n<!-- JANUS PERSONAL OVERLAY END -->\n`;
  await transaction(pool, async (client) => {
    await client.query(`INSERT INTO cloud_personal_skill_overlay_versions (
      id,user_id,user_agent_instance_id,agent_family_id,base_agent_version_id,parent_version_id,source_run_id,
      authority,stability_status,status,overlay_hash,effective_skill_hash,compiler_version,content_ciphertext,
      content_nonce,content_tag,encryption_algorithm,key_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'cloud','stable','candidate',$8,$9,'overlay_concat_v1',$10,$11,$12,$13,$14)`, [
      versionId, run.owner_user_id, instance.id, instance.agent_family_id, instance.base_agent_version_id || '', instance.active_personal_skill_version_id || '', run.id,
      sha256(result.candidateOverlay), sha256(effectiveSkill), encrypted.ciphertext, encrypted.nonce, encrypted.tag, encrypted.algorithm, encrypted.keyId,
    ]);
    await persistProposal(client, { run, instance, versionId, result, evidenceRows: evidenceResult.rows });
    await client.query("UPDATE cloud_evolution_runs SET status = 'available', candidate_personal_skill_version_id = $1, summary = $2, completed_at = now(), updated_at = now() WHERE id = $3", [versionId, result.proposal?.summary || '', run.id]);
    await client.query("UPDATE cloud_evolution_jobs SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1", [job.id]);
    await createPostgresEvidenceUsageLedger(client).transitionRun({
      scope: 'personal', consumerId: instance.id, runId: run.id,
      toStatus: 'consumed', transitionReason: 'personal_version_available',
    });
    await client.query(`UPDATE cloud_personal_evolution_schedule_states SET
      last_status='available',last_run_id=$1,updated_at=now() WHERE user_agent_instance_id=$2`, [run.id, instance.id]);
  });
  return { runId: run.id, status: 'available', versionId, autoActivated: false };
}

async function persistProposal(client, { run, instance, versionId, result, evidenceRows }) {
  const safe = sanitizeEvolutionPayloadForStorage({
    summary: result.proposal?.summary || '',
    proposedOverlayText: result.candidateOverlay || '',
    diagnostics: result.diagnosis || {},
    gate: result.gate || {},
  });
  const memoryOperations = (result.memoryOperations || []).map((operation, index) => ({
    id: `pememop_${sha256(`${run.id}:${index}:${operation.memoryDocumentId}:${operation.sectionName}`).slice(0, 32)}`,
    proposalId: run.id,
    memoryDocumentId: operation.memoryDocumentId,
    sectionName: operation.sectionName,
    operationType: operation.operationType,
    targetItemHash: operation.targetItemHash || '',
    proposedText: sanitizeEvolutionPayloadForStorage(operation.proposedText || ''),
    rationale: sanitizeEvolutionPayloadForStorage(operation.rationale || ''),
    baselineVersionId: operation.baselineVersionId || '',
    baselineContentHash: operation.baselineContentHash || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const replay = result.evaluations?.results || [];
  const proposal = {
    id: run.id,
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
    candidatePersonalSkillVersionId: versionId,
    evidenceCount: Number(run.evidence_count || evidenceRows.length),
    evidenceRefs: evidenceRows.map((row) => ({ id: row.evidence_id, sourceKind: row.source_kind, sourceId: row.source_id,
      sourceHash: row.content_hash, occurredAt: row.occurred_at, privacyLevel: row.privacy_level || 'owner_private', included: true })),
    summary: safe.summary,
    proposedOverlayText: safe.proposedOverlayText,
    proposedOverlayHash: sha256(safe.proposedOverlayText),
    diagnostics: safe.diagnostics,
    gate: safe.gate,
    privacyReport: result.gate?.privacyReport || { flagCount: 0, flags: [] },
    evaluationSummary: { caseCount: replay.length, regressionCount: replay.filter((item) => item.regression).length },
    autoActivationEligible: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  proposal.proposalMarkdown = renderProposalMarkdown(proposal, memoryOperations);
  proposal.proposalHash = sha256(proposal.proposalMarkdown);
  await client.query(`INSERT INTO cloud_personal_evolution_proposals_v4 (
    user_id,id,user_agent_instance_id,agent_family_id,status,proposal_hash,origin_device_id,payload_json
  ) VALUES ($1,$2,$3,$4,'ready',$5,'cloud-authority',$6::jsonb)
  ON CONFLICT(user_id,id) DO UPDATE SET status='ready',proposal_hash=excluded.proposal_hash,payload_json=excluded.payload_json,updated_at=now()`,
  [run.owner_user_id, run.id, instance.id, instance.agent_family_id, proposal.proposalHash, JSON.stringify(proposal)]);
  for (const operation of memoryOperations) {
    await client.query(`INSERT INTO cloud_personal_evolution_memory_operations_v4 (
      user_id,id,proposal_id,memory_document_id,status,payload_json
    ) VALUES ($1,$2,$3,$4,'pending',$5::jsonb)
    ON CONFLICT(user_id,id) DO UPDATE SET status='pending',payload_json=excluded.payload_json,updated_at=now()`,
    [run.owner_user_id, operation.id, run.id, operation.memoryDocumentId, JSON.stringify(operation)]);
  }
}

export async function decidePostgresPersonalRun(pool, {
  userId = '', runId = '', decisions = [], actorDeviceId = '', automatic = false, keyring = evolutionKeyringFromEnv(),
} = {}) {
  return transaction(pool, (client) => decidePostgresPersonalRunWithClient(client, {
    userId, runId, decisions, actorDeviceId, automatic, keyring,
  }));
}

async function decidePostgresPersonalRunWithClient(client, {
  userId = '', runId = '', decisions = [], actorDeviceId = '', automatic = false, keyring,
} = {}) {
  const normalized = (Array.isArray(decisions) ? decisions : []).map((item) => ({
    targetKind: String(item.targetKind || item.target_kind || ''),
    targetId: String(item.targetId || item.target_id || ''),
    decision: String(item.decision || ''),
  }));
  if (!normalized.length) throw simpleApiError('evolution_decision_required', 'At least one personal evolution decision is required.', 400);
  const run = (await client.query('SELECT * FROM cloud_evolution_runs WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [runId, userId])).rows[0];
    if (!run) throw simpleApiError('evolution_run_not_found', 'Evolution run was not found.', 404);
    const proposalRow = (await client.query('SELECT * FROM cloud_personal_evolution_proposals_v4 WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, runId])).rows[0];
    if (!proposalRow) throw simpleApiError('evolution_proposal_not_found', 'Evolution Proposal was not found.', 404);
    const proposal = proposalRow.payload_json || {};
    const candidateId = run.candidate_personal_skill_version_id || proposal.candidatePersonalSkillVersionId || '';
    const instance = (await client.query('SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId, run.user_agent_instance_id])).rows[0];
    if (!instance) throw simpleApiError('agent_instance_not_found', 'Agent instance was not found.', 404);
    if (normalized.some((item) => item.decision === 'accept')
      && (instance.status !== 'active' || !instance.sync_enabled || !instance.personal_evolution_consent)) {
      throw simpleApiError('personal_evolution_not_allowed', 'Agent is not eligible for personal evolution.', 409);
    }
    const returnedActions = [];
    let conflict = false;
    for (const item of normalized) {
      if (!['skill', 'memory_operation'].includes(item.targetKind) || !['accept', 'reject'].includes(item.decision)) {
        throw simpleApiError('evolution_decision_invalid', 'Personal evolution decision is invalid.', 400);
      }
      if (item.targetKind === 'skill' && item.targetId !== candidateId) {
        throw simpleApiError('evolution_skill_target_invalid', 'Skill candidate does not belong to this Proposal.', 400);
      }
      const operationRow = item.targetKind === 'memory_operation'
        ? (await client.query('SELECT * FROM cloud_personal_evolution_memory_operations_v4 WHERE user_id=$1 AND proposal_id=$2 AND id=$3 FOR UPDATE', [userId, runId, item.targetId])).rows[0]
        : null;
      if (item.targetKind === 'memory_operation' && !operationRow) {
        throw simpleApiError('evolution_memory_target_invalid', 'Memory operation does not belong to this Proposal.', 400);
      }
      const existing = (await client.query(`SELECT * FROM cloud_personal_evolution_actions_v4
        WHERE user_id=$1 AND proposal_id=$2 AND target_kind=$3 AND target_id=$4`, [userId, runId, item.targetKind, item.targetId])).rows[0];
      if (existing) {
        if (existing.decision !== item.decision) conflict = true;
        returnedActions.push(existing.payload_json || existing);
        continue;
      }
      if (!['ready', 'partially_applied'].includes(proposalRow.status)) {
        throw simpleApiError('evolution_proposal_not_reviewable', `Evolution Proposal is not reviewable from status ${proposalRow.status}.`, 409);
      }
      if (item.targetKind === 'skill') {
        const candidate = (await client.query(`SELECT * FROM cloud_personal_skill_overlay_versions
          WHERE user_id=$1 AND user_agent_instance_id=$2 AND id=$3`, [userId, instance.id, candidateId])).rows[0];
        if (!candidate) throw simpleApiError('evolution_skill_candidate_missing', 'Skill candidate is unavailable.', 409);
        if (item.decision === 'accept') {
          await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='archived',archived_at=now() WHERE user_id=$1 AND user_agent_instance_id=$2 AND status='active'", [userId, instance.id]);
          await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='active',stability_status='stable',activated_at=now(),archived_at=NULL WHERE user_id=$1 AND id=$2", [userId, candidateId]);
          await client.query('UPDATE cloud_user_agent_instances_v3 SET active_personal_skill_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [candidateId, userId, instance.id]);
          await client.query(`INSERT INTO cloud_evolution_apply_journals (id,run_id,user_agent_instance_id,previous_skill_version_id,next_skill_version_id,status,error_text,completed_at)
            VALUES ($1,$2,$3,$4,$5,'completed',$6,now())`, [`evapply_${crypto.randomUUID()}`, runId, instance.id, instance.active_personal_skill_version_id || '', candidateId, automatic ? 'automatic_skill_accept' : 'manual_skill_accept']);
        } else {
          await client.query("UPDATE cloud_personal_skill_overlay_versions SET status='rejected',archived_at=now() WHERE user_id=$1 AND id=$2 AND status='candidate'", [userId, candidateId]);
        }
      } else if (item.decision === 'accept') {
          await applyOneMemoryOperation(client, { userId, run, operationRow, keyring });
      } else {
        await updateOperation(client, operationRow, 'rejected');
      }
      const action = { id: `peaction_${crypto.randomUUID()}`, proposalId: runId, targetKind: item.targetKind,
        targetId: item.targetId, decision: item.decision, revision: 1, actorDeviceId, automatic, receivedAt: new Date().toISOString() };
      await client.query(`INSERT INTO cloud_personal_evolution_actions_v4 (
        user_id,id,proposal_id,target_kind,target_id,decision,revision,actor_device_id,payload_json,received_at
      ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8::jsonb,$9)`,
      [userId, action.id, runId, action.targetKind, action.targetId, action.decision, actorDeviceId, JSON.stringify(action), action.receivedAt]);
      returnedActions.push(action);
    }
  const finalized = await finalizeProposal(client, { userId, run, proposal, candidateId });
  return { status: conflict ? 'conflict' : 'accepted', authority: 'cloud', run: finalized.run, proposal: finalized.proposal, actions: returnedActions };
}

async function applyOneMemoryOperation(client, { userId, run, operationRow, keyring }) {
  const operation = operationRow.payload_json || {};
  const document = (await client.query(`SELECT d.*,v.version_no,v.content_hash,v.payload_json AS version_payload_json
    FROM cloud_memory_documents_v3 d LEFT JOIN cloud_memory_document_versions_v3 v
      ON v.user_id=d.user_id AND v.id=d.current_version_id
    WHERE d.user_id=$1 AND d.id=$2 AND d.user_agent_instance_id=$3 AND d.allow_personal_evolution=true FOR UPDATE OF d`,
  [userId, operation.memoryDocumentId, run.user_agent_instance_id])).rows[0];
  if (!document) throw simpleApiError('evolution_memory_document_missing', 'Memory document is unavailable.', 409);
  const currentPayload = document.version_payload_json || {};
  const baselineMatches = document.current_version_id === operation.baselineVersionId
    && (!operation.baselineContentHash || document.content_hash === operation.baselineContentHash);
  const continued = currentPayload.sourceKind === 'cloud_personal_evolution'
    && Boolean((await client.query('SELECT id FROM cloud_personal_evolution_memory_operations_v4 WHERE user_id=$1 AND proposal_id=$2 AND id=$3', [userId, run.id, currentPayload.sourceId || ''])).rows[0]);
  if (!baselineMatches && !continued) throw simpleApiError('evolution_memory_baseline_changed', 'Memory baseline changed; reject this operation and request a new Proposal.', 409);
  const currentContent = String(currentPayload.content || '');
  const nextContent = applyMemorySection(currentContent, operation);
  if (nextContent !== currentContent) {
    const versionNo = Number((await client.query('SELECT COALESCE(MAX(version_no),0)+1 AS value FROM cloud_memory_document_versions_v3 WHERE user_id=$1 AND memory_document_id=$2', [userId, document.id])).rows[0].value);
    const id = `memver_${crypto.randomUUID()}`;
    const payload = { ...currentPayload, id, memoryDocumentId: document.id, versionNo, content: nextContent,
      contentHash: sha256(nextContent), sourceKind: 'cloud_personal_evolution', sourceId: operation.id,
      reviewStatus: 'approved', createdBy: userId, createdAt: new Date().toISOString() };
    await client.query(`INSERT INTO cloud_memory_document_versions_v3 (user_id,id,memory_document_id,version_no,content_hash,payload_json)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [userId, id, document.id, versionNo, payload.contentHash, JSON.stringify(payload)]);
    await client.query('UPDATE cloud_memory_documents_v3 SET current_version_id=$1,updated_at=now() WHERE user_id=$2 AND id=$3', [id, userId, document.id]);
    await createPostgresAuthoritativeEvidence(client,{keyring,ownerUserId:userId,userAgentInstanceId:run.user_agent_instance_id,
      agentFamilyId:document.agent_family_id,sourceKind:String(payload.visibility || document.visibility || '') === 'work_summary' ? 'task_shared_summary' : 'memory_version',
      sourceId:document.id,sourceVersionId:id,content:nextContent,contextSpaceId:document.context_space_id || '',taskId:document.task_run_id || '',
      delegationId:document.delegation_id || '',privacyLevel:'owner_private',occurredAt:payload.createdAt,
      metadata:{sourceKind:'cloud_personal_evolution',sourceOperationId:operation.id,memoryScope:document.scope}});
  }
  await updateOperation(client, operationRow, 'applied');
}

async function updateOperation(client, row, status) {
  const payload = { ...(row.payload_json || {}), status, updatedAt: new Date().toISOString() };
  await client.query(`UPDATE cloud_personal_evolution_memory_operations_v4 SET status=$1,payload_json=$2::jsonb,updated_at=now()
    WHERE user_id=$3 AND id=$4`, [status, JSON.stringify(payload), row.user_id, row.id]);
}

async function finalizeProposal(client, { userId, run, proposal, candidateId }) {
  const actions = (await client.query('SELECT * FROM cloud_personal_evolution_actions_v4 WHERE user_id=$1 AND proposal_id=$2', [userId, run.id])).rows;
  const memoryRows = (await client.query('SELECT * FROM cloud_personal_evolution_memory_operations_v4 WHERE user_id=$1 AND proposal_id=$2', [userId, run.id])).rows;
  const skillAction = actions.find((item) => item.target_kind === 'skill' && item.target_id === candidateId);
  const terminal = Boolean(skillAction) && memoryRows.every((item) => ['applied', 'rejected'].includes(item.status));
  const skillApplied = skillAction?.decision === 'accept';
  const accepted = actions.some((item) => item.decision === 'accept');
  const rejected = actions.some((item) => item.decision === 'reject');
  const status = skillApplied && !terminal ? 'partially_applied' : terminal ? accepted && rejected ? 'partially_applied' : accepted ? 'applied' : 'rejected'
    : actions.length ? 'partially_applied' : 'ready';
  const nextProposal = { ...proposal, status, decision: terminal ? accepted && rejected ? 'partial' : accepted ? 'accepted' : 'rejected' : 'pending',
    skillActionStatus: skillAction ? skillAction.decision === 'accept' ? 'activated' : 'rejected' : 'none',
    memoryActionStatus: memoryRows.every((item) => ['applied', 'rejected'].includes(item.status))
      ? memoryRows.some((item) => item.status === 'applied') ? 'applied' : memoryRows.length ? 'rejected' : 'none' : 'pending',
    decidedAt: terminal ? new Date().toISOString() : '', updatedAt: new Date().toISOString() };
  await client.query('UPDATE cloud_personal_evolution_proposals_v4 SET status=$1,payload_json=$2::jsonb,updated_at=now() WHERE user_id=$3 AND id=$4',
    [status, JSON.stringify(nextProposal), userId, run.id]);
  if (!skillAction) {
    await client.query("UPDATE cloud_evolution_runs SET status='available',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1", [run.id]);
    return { run: { id: run.id, status: 'available', agentInstanceId: run.user_agent_instance_id,
      candidatePersonalSkillVersionId: candidateId }, proposal: nextProposal };
  }
  const runStatus = accepted ? 'applied' : terminal ? 'evaluated_rejected' : 'proposed';
  if (accepted || terminal) {
    await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'personal',consumerId:run.consumer_id,runId:run.id,
      toStatus:accepted?'consumed':'evaluated_rejected',rejectionKind:accepted?'':'user_rejected',transitionReason:accepted?'applied':'user_rejected'});
    await client.query('UPDATE cloud_evolution_runs SET status=$1,completed_at=now(),updated_at=now() WHERE id=$2', [runStatus, run.id]);
    await client.query(`UPDATE cloud_personal_evolution_schedule_states SET last_status=$1,last_run_id=$2,updated_at=now()
      WHERE user_agent_instance_id=$3`, [runStatus, run.id, run.consumer_id]);
  } else {
    await client.query("UPDATE cloud_evolution_runs SET status='proposed',completed_at=NULL,updated_at=now() WHERE id=$1", [run.id]);
  }
  return { run: { id: run.id, status: runStatus, agentInstanceId: run.user_agent_instance_id,
    candidatePersonalSkillVersionId: candidateId }, proposal: nextProposal };
}

function renderProposalMarkdown(proposal, memoryOperations) {
  return `# Personal Evolution Proposal\n\n## Summary\n${proposal.summary || ''}\n\n## Evidence\n- ${proposal.evidenceCount} encrypted evidence items\n\n## Proposed Skill Overlay\n${proposal.proposedOverlayText || ''}\n\n## Proposed Memory Operations\n${memoryOperations.length ? memoryOperations.map((item) => `- ${item.operationType} ${item.sectionName}: ${item.proposedText}`).join('\n') : '- no-op'}\n\n## Evaluation\n- Gate: ${proposal.gate?.status || 'unknown'} (${proposal.gate?.score ?? 0})\n- Cases: ${proposal.evaluationSummary?.caseCount || 0}\n- Regressions: ${proposal.evaluationSummary?.regressionCount || 0}\n`;
}

async function failJob(pool, job, error) {
  const terminal = error.terminal || Number(job.attempt_count || 0) >= Number(job.max_attempts || 3);
  const status = terminal ? 'failed_terminal' : 'failed_retryable';
  const terminalNextEligibleAt = new Date(Date.now() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS);
  const retryAt = new Date(Date.now() + PERSONAL_EVOLUTION_RETRY_INTERVAL_MS);
  const run = (await pool.query('SELECT consumer_id FROM cloud_evolution_runs WHERE id = $1', [job.run_id])).rows[0];
  await transaction(pool, async (client) => {
    await client.query(`UPDATE cloud_evolution_jobs SET status = $1, error_code = $2, error_text = $3,
      available_at = CASE WHEN $4::boolean THEN available_at ELSE $5::timestamptz END,
      lease_expires_at = NULL, completed_at = CASE WHEN $4::boolean THEN now() ELSE NULL END, updated_at = now() WHERE id = $6`,
    [status, error.code || 'evolution_worker_failed', String(error.message || error).slice(0, 2000), terminal, retryAt, job.id]);
    await client.query('UPDATE cloud_evolution_runs SET status = $1, error_code = $2, error_text = $3, completed_at = CASE WHEN $4::boolean THEN now() ELSE NULL END, updated_at = now() WHERE id = $5',
      [status, error.code || 'evolution_worker_failed', String(error.message || error).slice(0, 2000), terminal, job.run_id]);
    await createPostgresEvidenceUsageLedger(client).transitionRun({scope:'personal',consumerId:run?.consumer_id||'',runId:job.run_id,
      toStatus:'released',transitionReason:'infrastructure_failure'});
    await client.query(`UPDATE cloud_personal_evolution_schedule_states SET next_eligible_at = CASE WHEN $1::boolean
      THEN $2::timestamptz ELSE $3::timestamptz END,
      last_status=$4,last_run_id=$5,updated_at=now() WHERE user_agent_instance_id=$6`,
    [terminal, terminalNextEligibleAt, retryAt, status, job.run_id, run?.consumer_id || '']);
  });
  return { runId: job.run_id, status, error: error.message || String(error) };
}

async function transitionEvidence(pool, runId, consumerId, status, { rejectionKind = '', transitionReason = '' } = {}) {
  return createPostgresEvidenceUsageLedger(pool).transitionRun({scope:'personal',consumerId,runId,toStatus:status,rejectionKind,transitionReason});
}

async function finishRejected(pool, runId, jobId, status, code) { await transaction(pool, async (client) => {
  await client.query('UPDATE cloud_evolution_runs SET status = $1, error_code = $2, completed_at = now(), updated_at = now() WHERE id = $3', [status, code, runId]);
  await client.query("UPDATE cloud_evolution_jobs SET status = 'completed', error_code = $1, completed_at = now(), updated_at = now() WHERE id = $2", [code, jobId]);
}); }
async function audit(pool, run, evidenceId, result) { await pool.query(`INSERT INTO cloud_memory_access_audits
  (id,requester_identity,owner_user_id,user_agent_instance_id,evidence_id,run_id,purpose,result)
  VALUES ($1,'evolution-worker',$2,$3,$4,$5,'personal_evolution',$6)`, [`memaudit_${crypto.randomUUID()}`, run.owner_user_id, run.user_agent_instance_id, evidenceId, run.id, result]); }

async function requeuePostgresEvidenceForValidationPolicy(pool,{limit=100}={}){
  const rows=(await pool.query(`SELECT e.evidence_id,e.source_kind FROM cloud_evolution_evidence e
    JOIN cloud_evolution_evidence_validation_jobs j ON j.evidence_id=e.evidence_id
    WHERE e.validation_status='quarantined' AND e.quarantine_reason='credential_like_content'
      AND e.validation_policy_version<>$1 ORDER BY e.ingested_at,e.evidence_id LIMIT $2`,
  [EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,Math.min(1000,Math.max(1,Number(limit||100)))])).rows
    .filter((row)=>evolutionEvidencePrivacyPolicyUpgradeable(row.source_kind));
  if(!rows.length)return [];
  return transaction(pool,async(client)=>{
    const requeued=[];
    for(const row of rows){
      const updated=await client.query(`UPDATE cloud_evolution_evidence SET validation_status='pending_validation',
        validation_policy_version=$1,validation_json='{}'::jsonb,validated_at=NULL,quarantine_reason=''
        WHERE evidence_id=$2 AND validation_status='quarantined' AND quarantine_reason='credential_like_content'
          AND validation_policy_version<>$1 RETURNING evidence_id`,[EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,row.evidence_id]);
      if(!updated.rowCount)continue;
      await client.query(`UPDATE cloud_evolution_evidence_validation_jobs SET status='queued',attempt_count=0,
        available_at=now(),claimed_by='',claimed_at=NULL,lease_expires_at=NULL,error_code='',error_text='',completed_at=NULL,updated_at=now()
        WHERE evidence_id=$1`,[row.evidence_id]);
      await client.query(`UPDATE cloud_evolution_evidence_quarantine SET resolution_status='released',
        resolution_note=$1,resolved_at=now(),updated_at=now() WHERE evidence_id=$2 AND resolution_status='pending'`,
      [EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,row.evidence_id]);
      requeued.push(row.evidence_id);
    }
    return requeued;
  });
}

async function requeuePostgresEvidenceForAvailableKeys(pool,{keyring,limit=100}={}){
  const availableKeyIds=new Set(Object.keys(keyring?.keys||{}).filter((keyId)=>keyring.keys[keyId]));
  if(!availableKeyIds.size)return [];
  const rows=(await pool.query(`SELECT j.evidence_id,e.key_id FROM cloud_evolution_evidence_validation_jobs j
    JOIN cloud_evolution_evidence e ON e.evidence_id=j.evidence_id WHERE j.status='failed_terminal'
      AND j.error_code='evolution_decryption_key_unavailable' ORDER BY j.updated_at,j.evidence_id LIMIT $1`,
  [Math.min(1000,Math.max(1,Number(limit||100)))])).rows.filter((row)=>availableKeyIds.has(row.key_id));
  if(!rows.length)return [];
  return transaction(pool,async(client)=>{
    const requeued=[];
    for(const row of rows){
      const updated=await client.query(`UPDATE cloud_evolution_evidence_validation_jobs SET status='queued',attempt_count=0,
        available_at=now(),claimed_by='',claimed_at=NULL,lease_expires_at=NULL,error_code='',error_text='',completed_at=NULL,updated_at=now()
        WHERE evidence_id=$1 AND status='failed_terminal' AND error_code='evolution_decryption_key_unavailable' RETURNING evidence_id`,
      [row.evidence_id]);
      if(updated.rowCount)requeued.push(row.evidence_id);
    }
    return requeued;
  });
}

async function validatePendingEvidence(pool,{workerId,limit=25,keyring}={}){
  const jobs=await transaction(pool,async(client)=>{
    const picked=(await client.query(`SELECT * FROM cloud_evolution_evidence_validation_jobs
      WHERE ((status IN ('queued','failed_retryable') AND available_at<=now())
        OR (status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=now()))
        AND attempt_count<max_attempts
      ORDER BY available_at,evidence_id LIMIT $1 FOR UPDATE SKIP LOCKED`,[Math.max(1,Number(limit||25))])).rows;
    const claimed=[];
    for(const row of picked){
      const updated=(await client.query(`UPDATE cloud_evolution_evidence_validation_jobs
        SET status='claimed',claimed_by=$1,claimed_at=now(),lease_expires_at=now()+interval '15 minutes',
          attempt_count=attempt_count+1,updated_at=now()
        WHERE evidence_id=$2 AND attempt_count=$3 AND ((status IN ('queued','failed_retryable') AND available_at<=now())
          OR (status='claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at<=now())) RETURNING *`,
      [workerId,row.evidence_id,row.attempt_count])).rows[0];
      if(updated)claimed.push(updated);
    }
    return claimed;
  });
  for(const job of jobs){
    const evidence=(await pool.query('SELECT * FROM cloud_evolution_evidence WHERE evidence_id=$1',[job.evidence_id])).rows[0];
    if(!evidence)continue;
    try{
      const content=decryptEvidenceForValidation(evidence,keyring);
      if(crypto.createHash('sha256').update(content).digest('hex')!==evidence.content_hash)throw codedError('evidence_hash_mismatch','Evidence plaintext hash mismatch.');
      const findings=evolutionEvidencePrivacyFindings(content,{sourceKind:evidence.source_kind});
      if(findings.length)throw codedError('credential_like_content','Evidence contains private credential or identity material.');
      const metadata=evidence.metadata_json||{};
      const validation={policyVersion:EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,sourceVerified:true,taskRelevance:Number(metadata.taskRelevance??.8),
        acceptanceQuality:Number(metadata.acceptanceQuality??.8),findingCount:0};
      await transaction(pool,async(client)=>{
        await client.query(`UPDATE cloud_evolution_evidence SET validation_status='validated',validation_policy_version=$1,
          validation_json=$2::jsonb,validated_at=now(),confidence=$3,quarantine_reason='' WHERE evidence_id=$4`,
        [EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,JSON.stringify(validation),
          Math.min(Number(evidence.confidence||1),validatedEvidenceConfidenceForWorker(evidence.source_kind)),evidence.evidence_id]);
        await client.query("UPDATE cloud_evolution_evidence_validation_jobs SET status='completed',completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE evidence_id=$1",[evidence.evidence_id]);
        if(!evidence.historical_inactive&&(metadata.allowedEvolutionScopes||[]).includes('personal'))await createPostgresEvidenceUsageLedger(client)
          .ensureAvailable({evidenceId:evidence.evidence_id,scope:'personal',consumerId:evidence.user_agent_instance_id,transitionReason:'worker_validated'});
        await auditEvidenceAccess(client,{workerIdentity:workerId,evidenceId:evidence.evidence_id,purpose:'ingest_validation',result:'allowed',keyId:evidence.key_id});
      });
    }catch(error){
      const terminal=['evidence_hash_mismatch','credential_like_content'].includes(error.code);
      const attemptsExhausted=Number(job.attempt_count||0)>=Number(job.max_attempts||5);
      const evidenceStatus=terminal?'quarantined':'failed_retryable';
      const jobStatus=terminal?'quarantined':attemptsExhausted?'failed_terminal':'failed_retryable';
      const nextAvailableAt=new Date(Date.now()+validationRetryDelayMs(job.attempt_count)).toISOString();
      await transaction(pool,async(client)=>{
        await client.query(`UPDATE cloud_evolution_evidence SET validation_status=$1,validation_policy_version=$2,
          quarantine_reason=CASE WHEN $1='quarantined' THEN $3 ELSE quarantine_reason END WHERE evidence_id=$4`,
        [evidenceStatus,EVOLUTION_EVIDENCE_VALIDATION_POLICY_VERSION,error.code||'decrypt_failed',evidence.evidence_id]);
        await client.query(`UPDATE cloud_evolution_evidence_validation_jobs SET status=$1,error_code=$2,error_text=$3,
          available_at=CASE WHEN $1='failed_retryable' THEN $4::timestamptz ELSE available_at END,
          claimed_by='',claimed_at=NULL,lease_expires_at=NULL,updated_at=now(),
          completed_at=CASE WHEN $1 IN ('quarantined','failed_terminal') THEN now() ELSE NULL END WHERE evidence_id=$5`,
        [jobStatus,error.code||'decrypt_failed',String(error.message||error).slice(0,2000),nextAvailableAt,evidence.evidence_id]);
        if(terminal)await client.query(`INSERT INTO cloud_evolution_evidence_quarantine
          (id,evidence_id,owner_user_id,user_agent_instance_id,source_kind,source_id,source_version_id,reason_code,reason_text,retryable)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,false) ON CONFLICT DO NOTHING`,[`evquar_${crypto.randomUUID()}`,evidence.evidence_id,
          evidence.owner_user_id,evidence.user_agent_instance_id,evidence.source_kind,evidence.source_id,evidence.source_version_id,error.code||'validation_failed',String(error.message||error).slice(0,2000)]);
        await auditEvidenceAccess(client,{workerIdentity:workerId,evidenceId:evidence.evidence_id,purpose:'ingest_validation',
          result:terminal?'denied':'failed',resultCode:error.code||'decrypt_failed',keyId:evidence.key_id});
      });
    }
  }
  return jobs.length;
}

function decryptEvidenceForValidation(evidence,keyring){
  const algorithm=String(evidence.encryption_algorithm||'');
  const keyId=String(evidence.key_id||'');
  if(algorithm!=='plain_test_only'&&(!keyId||!keyring?.keys?.[keyId])){
    throw codedError('evolution_decryption_key_unavailable',`Evolution Evidence decryption key is unavailable: ${keyId||'missing'}`);
  }
  try{return decryptEvolutionPayload({algorithm,keyId,ciphertext:evidence.content_ciphertext,
    nonce:evidence.content_nonce,tag:evidence.content_tag,wrappedDataKey:evidence.wrapped_data_key},keyring);}
  catch(error){if(error?.code)throw error;throw codedError('decrypt_failed','Evolution Evidence decryption failed.');}
}

function validationRetryDelayMs(attemptCount=1){
  return Math.min(6*60*60*1000,5*60*1000*(2**Math.max(0,Number(attemptCount||1)-1)));
}

async function auditEvidenceAccess(queryable,{workerIdentity='evolution-worker',runId='',evidenceId='',purpose,result,resultCode='',keyId='',detail={}}={}){
  await queryable.query(`INSERT INTO cloud_evolution_evidence_access_audits
    (id,worker_identity,run_id,evidence_id,purpose,result,result_code,key_id,detail_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,[`evaudit_${crypto.randomUUID()}`,workerIdentity,runId,evidenceId,purpose,result,resultCode,keyId,JSON.stringify(detail)]);
}
function validatedEvidenceConfidenceForWorker(sourceKind=''){return ({task_acceptance:1,task_result:.95,conversation_segment:.9,
  memory_version:.9,task_shared_summary:.95,model_execution:.9,model_execution_metric:.9,message:.8})[sourceKind]??.8;}
async function storeEvaluations(pool, runId, result) {
  const rows = [['diagnosis', 0, false, result.diagnosis || {}], ['gate', 0, result.gate?.status !== 'passed', result.gate || {}], ['review', 0, result.review?.decision !== 'full', result.review || {}]];
  for (const item of result.evaluations?.results || []) rows.push(['ab_replay', item.caseIndex, Boolean(item.regression), item]);
  for (const [kind, index, regression, payload] of rows) await pool.query(`INSERT INTO cloud_evolution_evaluations
    (id,run_id,evaluation_kind,case_index,status,regression,result_json) VALUES ($1,$2,$3,$4,'completed',$5,$6::jsonb)
    ON CONFLICT(run_id,evaluation_kind,case_index) DO UPDATE SET status='completed',regression=excluded.regression,result_json=excluded.result_json`,
  [`eveval_${sha256(`${runId}:${kind}:${index}`).slice(0, 32)}`, runId, kind, index, regression, JSON.stringify(sanitizeEvolutionPayloadForStorage(payload))]);
}
async function transaction(pool, callback) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
function codedError(code,message){const error=new Error(message);error.code=code;return error;}
function terminalError(code, message) { const error = new Error(message); error.code = code; error.terminal = true; return error; }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
async function loadPersonalRunSnapshot(queryable,runId,keyring) {
  const row=(await queryable.query('SELECT * FROM cloud_evolution_run_snapshots WHERE run_id=$1',[runId])).rows[0];
  if(!row)throw terminalError('evolution_snapshot_missing','Personal evolution snapshot is missing.');
  const encryption=row.encryption_json||{};
  return {evidenceIds:Array.isArray(row.evidence_ids_json)?row.evidence_ids_json:[],
    baseSkill:decryptEvolutionPayload(encryption.base||{},keyring),overlay:decryptEvolutionPayload(encryption.overlay||{},keyring),
    memoryDocuments:JSON.parse(decryptEvolutionPayload(encryption.memory||{},keyring)||'[]')};
}

async function applyMemoryOperations(client, run, operations, keyring) {
  for (const operation of operations) {
    const current = await client.query(`SELECT d.current_version_id, v.version_no, v.payload_json FROM cloud_memory_documents_v3 d
      JOIN cloud_memory_document_versions_v3 v ON v.user_id = d.user_id AND v.id = d.current_version_id
      WHERE d.user_id = $1 AND d.user_agent_instance_id = $2 AND d.id = $3 AND d.allow_personal_evolution = true`,
    [run.owner_user_id, run.user_agent_instance_id, operation.memoryDocumentId]);
    const row = current.rows[0];
    if (!row || row.current_version_id !== operation.baselineVersionId) continue;
    const content = String(row.payload_json?.content || '');
    const nextContent = applyMemorySection(content, operation);
    if (nextContent === content) continue;
    const id = `memver_${crypto.randomUUID()}`;
    const payload = { ...(row.payload_json || {}), id, memoryDocumentId: operation.memoryDocumentId,
      versionNo: Number(row.version_no || 0) + 1, content: nextContent, contentHash: sha256(nextContent),
      sourceKind: 'cloud_personal_evolution', sourceId: run.id, reviewStatus: 'approved', createdBy: 'evolution-worker' };
    await client.query(`INSERT INTO cloud_memory_document_versions_v3 (user_id,id,memory_document_id,version_no,content_hash,payload_json)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [run.owner_user_id, id, operation.memoryDocumentId, payload.versionNo, payload.contentHash, JSON.stringify(payload)]);
    await client.query('UPDATE cloud_memory_documents_v3 SET current_version_id = $1, updated_at = now() WHERE user_id = $2 AND id = $3', [id, run.owner_user_id, operation.memoryDocumentId]);
    const document=(await client.query('SELECT * FROM cloud_memory_documents_v3 WHERE user_id=$1 AND id=$2',[run.owner_user_id,operation.memoryDocumentId])).rows[0];
    await createPostgresAuthoritativeEvidence(client,{keyring,ownerUserId:run.owner_user_id,userAgentInstanceId:run.user_agent_instance_id,
      agentFamilyId:document.agent_family_id,sourceKind:String(payload.visibility || document.visibility || '') === 'work_summary' ? 'task_shared_summary' : 'memory_version',
      sourceId:document.id,sourceVersionId:id,content:nextContent,contextSpaceId:document.context_space_id || '',taskId:document.task_run_id || '',
      delegationId:document.delegation_id || '',privacyLevel:'owner_private',occurredAt:payload.createdAt || new Date(),
      metadata:{sourceKind:'cloud_personal_evolution',sourceRunId:run.id,memoryScope:document.scope}});
  }
}

function applyMemorySection(content, operation) {
  const heading = `## ${operation.sectionName}`;
  const escaped = String(operation.sectionName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^##\\s+${escaped}\\s*$)([\\s\\S]*?)(?=^##\\s+|$)`, 'm');
  const match = content.match(pattern);
  const proposed = String(operation.proposedText || '').trim();
  if (operation.operationType === 'add') return match
    ? content.replace(pattern, `${match[1]}${match[2].trimEnd()}\n- ${proposed}\n\n`)
    : `${content.trimEnd()}\n\n${heading}\n- ${proposed}\n`;
  if (!match) return content;
  if (operation.operationType === 'remove') return content.replace(pattern, `${match[1]}\n`);
  return content.replace(pattern, `${match[1]}\n${proposed}\n\n`);
}
