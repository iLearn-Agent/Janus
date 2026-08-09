import crypto from 'node:crypto';

import {
  decryptEvolutionPayload,
  encryptEvolutionPayload,
  PERSONAL_EVOLUTION_ALGORITHM_VERSION,
  PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS,
  PERSONAL_MAXIMUM_EVIDENCE,
  PERSONAL_MINIMUM_EVIDENCE,
} from '../../../../src/shared/evolution/index.js';
import { normalizeCloudTriggerKind } from '../../../../src/shared/cloudContracts.js';
import { createPostgresEvidenceUsageLedger } from './evidenceUsageLedger.mjs';

export async function queuePostgresPersonalEvolutionRun(pool, {
  userId = '', agentInstanceId = '', triggerKind = 'manual', force: _force = false, now = new Date(), keyring,
} = {}) {
  const normalizedTriggerKind = normalizeCloudTriggerKind(triggerKind);
  return transaction(pool, async (client) => {
    const usageLedger = createPostgresEvidenceUsageLedger(client);
    const instance = (await client.query(`SELECT * FROM cloud_user_agent_instances_v3
      WHERE user_id=$1 AND id=$2 FOR UPDATE`, [userId, agentInstanceId])).rows[0];
    if (!instance) throw codedError('agent_instance_not_found', 'Agent instance does not belong to this user.', 404);
    if (instance.status !== 'active' || !instance.sync_enabled || !instance.personal_evolution_consent) {
      throw codedError('personal_evolution_not_allowed', 'Agent is not eligible for personal evolution.', 409);
    }
    await client.query(`INSERT INTO cloud_personal_evolution_schedule_states
      (user_agent_instance_id,next_eligible_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`, [instance.id, now]);
    const schedule = (await client.query(`SELECT * FROM cloud_personal_evolution_schedule_states
      WHERE user_agent_instance_id=$1 FOR UPDATE`, [instance.id])).rows[0];
    const active = (await client.query(`SELECT * FROM cloud_evolution_runs WHERE user_agent_instance_id=$1
      AND evolution_scope='personal' AND status IN ('queued','claimed','running','proposed','failed_retryable')
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [instance.id])).rows[0];
    if (active) return { status: 'deferred', authority: 'cloud', reason: 'personal_evolution_already_running', run: runPayload(active) };
    if (schedule?.next_eligible_at && new Date(schedule.next_eligible_at).getTime() > now.getTime()) {
      return { status: 'deferred', authority: 'cloud', reason: 'personal_evolution_not_due',
        nextEligibleAt: new Date(schedule.next_eligible_at).toISOString() };
    }
    const selection=await usageLedger.selectPersonalCandidates({ownerUserId:userId,agentInstanceId:instance.id,
      minimum:PERSONAL_MINIMUM_EVIDENCE,limit:PERSONAL_MAXIMUM_EVIDENCE,algorithmVersion:PERSONAL_EVOLUTION_ALGORITHM_VERSION});
    if (selection.thresholdEligibleCount < PERSONAL_MINIMUM_EVIDENCE) {
      await client.query(`UPDATE cloud_personal_evolution_schedule_states SET last_evaluated_at=$1,
        next_eligible_at=$2,last_status='insufficient_evidence',last_evidence_count=$3,updated_at=$1
        WHERE user_agent_instance_id=$4`, [now, new Date(now.getTime() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS), selection.thresholdEligibleCount, instance.id]);
      return { status: 'insufficient_evidence', authority: 'cloud', availableEvidence: selection.rows.length,
        thresholdEligibleEvidence: selection.thresholdEligibleCount,
        minimumEvidence: PERSONAL_MINIMUM_EVIDENCE,
        nextEligibleAt: new Date(now.getTime() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS).toISOString() };
    }
    const evidence=selection.rows;
    const runId = `evrun_${crypto.randomUUID()}`;
    const jobId = `evjob_${crypto.randomUUID()}`;
    await client.query(`INSERT INTO cloud_evolution_runs (id,evolution_scope,owner_user_id,user_agent_instance_id,agent_family_id,consumer_id,
      algorithm_version,trigger_kind,status,evidence_count,base_agent_version_id,base_personal_skill_version_id,created_at,updated_at)
      VALUES ($1,'personal',$2,$3,$4,$3,$5,$6,'queued',$7,$8,$9,$10,$10)`, [runId, userId, instance.id,
      instance.agent_family_id, PERSONAL_EVOLUTION_ALGORITHM_VERSION, normalizedTriggerKind, evidence.length,
      instance.base_agent_version_id || '', instance.active_personal_skill_version_id || '', now]);
    await client.query(`INSERT INTO cloud_evolution_jobs (id,run_id,job_kind,status,available_at,created_at,updated_at)
      VALUES ($1,$2,'personal_evolution','queued',$3,$3,$3)`, [jobId, runId, now]);
    await storePersonalRunSnapshot(client,{runId,userId,instance,evidenceIds:evidence.map((row)=>row.evidence_id),keyring});
    const reserved = await usageLedger.reserve({ scope:'personal',consumerId:instance.id,runId,
      algorithmVersion:PERSONAL_EVOLUTION_ALGORITHM_VERSION,evidenceIds:evidence.map((row)=>row.evidence_id),leaseMinutes:30,
      nextBasisByEvidence:Object.fromEntries(evidence.filter((row)=>row.nextReEvaluationBasisHash)
        .map((row)=>[row.evidence_id,row.nextReEvaluationBasisHash])) });
    if (reserved.length !== evidence.length) throw new Error('Evidence reservation changed during personal run creation.');
    await client.query(`UPDATE cloud_personal_evolution_schedule_states SET last_evaluated_at=$1,next_eligible_at=$2,
      last_status='queued',last_evidence_count=$3,last_run_id=$4,updated_at=$1 WHERE user_agent_instance_id=$5`,
    [now, new Date(now.getTime() + PERSONAL_EVOLUTION_EVALUATION_INTERVAL_MS), evidence.length, runId, instance.id]);
    return { status: 'queued', authority: 'cloud', run: { id: runId, status: 'queued', agentInstanceId: instance.id,
      evidenceCount: evidence.length, triggerKind: normalizedTriggerKind } };
  });
}

export async function scanDuePostgresPersonalEvolutionRuns(pool, { limit = 25, now = new Date(), keyring } = {}) {
  const due = await transaction(pool, async (client) => {
    await client.query(`INSERT INTO cloud_personal_evolution_schedule_states (user_agent_instance_id,next_eligible_at,updated_at)
      SELECT id,$1::timestamptz,$1::timestamptz FROM cloud_user_agent_instances_v3
      WHERE status='active' AND sync_enabled=true AND personal_evolution_consent=true ON CONFLICT DO NOTHING`, [now]);
    return (await client.query(`SELECT s.user_agent_instance_id,i.user_id FROM cloud_personal_evolution_schedule_states s
      JOIN cloud_user_agent_instances_v3 i ON i.id=s.user_agent_instance_id
      WHERE i.status='active' AND i.sync_enabled=true AND i.personal_evolution_consent=true AND s.next_eligible_at <= $1
      ORDER BY s.next_eligible_at,s.user_agent_instance_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
    [now, Math.min(100, Math.max(1, Number(limit || 25)))])).rows;
  });
  const results = [];
  for (const item of due) results.push(await queuePostgresPersonalEvolutionRun(pool, {
    userId: item.user_id, agentInstanceId: item.user_agent_instance_id, triggerKind: 'scheduled', now, keyring,
  }));
  return results;
}

export async function postgresPersonalEvolutionSchedules(pool, { userId = '', agentInstanceId = '' } = {}) {
  return transaction(pool, async (client) => {
    const values = [userId];
    let filter = '';
    if (agentInstanceId) { values.push(agentInstanceId); filter = ' AND id=$2'; }
    await client.query(`INSERT INTO cloud_personal_evolution_schedule_states (user_agent_instance_id,next_eligible_at,updated_at)
      SELECT id,now(),now() FROM cloud_user_agent_instances_v3 WHERE user_id=$1${filter} ON CONFLICT DO NOTHING`, values);
    const rows = (await client.query(`SELECT
      s.user_agent_instance_id,s.last_evaluated_at,s.next_eligible_at,s.last_status,
      s.last_evidence_count,s.last_run_id,s.updated_at,COALESCE(ec.available_evidence,0)::int AS available_evidence
      FROM cloud_user_agent_instances_v3 i JOIN cloud_personal_evolution_schedule_states s ON s.user_agent_instance_id=i.id
      LEFT JOIN (SELECT e.owner_user_id,e.user_agent_instance_id,u.consumer_id,COUNT(*)::int AS available_evidence
        FROM cloud_evolution_evidence_usage u JOIN cloud_evolution_evidence e ON e.evidence_id=u.evidence_id
        WHERE e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=false
          AND u.evolution_scope='personal' AND u.status IN ('available','released')
        GROUP BY e.owner_user_id,e.user_agent_instance_id,u.consumer_id) ec
        ON ec.owner_user_id=i.user_id AND ec.user_agent_instance_id=i.id AND ec.consumer_id=i.id
      WHERE i.user_id=$1${filter} ORDER BY i.id`, values)).rows;
    if (agentInstanceId && !rows[0]) throw codedError('agent_instance_not_found', 'Agent instance does not belong to this user.', 404);
    return rows.map(schedulePayload);
  });
}

function schedulePayload(row) {
  return { authority: 'cloud', agentInstanceId: row.user_agent_instance_id,
    lastEvaluatedAt: row.last_evaluated_at ? new Date(row.last_evaluated_at).toISOString() : '',
    nextEligibleAt: row.next_eligible_at ? new Date(row.next_eligible_at).toISOString() : '',
    lastStatus: row.last_status || 'never_evaluated', lastEvidenceCount: Number(row.last_evidence_count || 0),
    lastRunId: row.last_run_id || '', availableEvidence: Number(row.available_evidence || 0) };
}

function runPayload(row) {
  return { id: row.id, status: row.status, agentInstanceId: row.user_agent_instance_id,
    evidenceCount: Number(row.evidence_count || 0), triggerKind: row.trigger_kind };
}

function codedError(code, message, status) { const error = new Error(message); error.code = code; error.status = status; return error; }
async function storePersonalRunSnapshot(client,{runId,userId,instance,evidenceIds,keyring}) {
  if(!keyring)throw codedError('evolution_encryption_key_unavailable','Personal evolution snapshot encryption is unavailable.',503);
  const base=(await client.query('SELECT payload_json FROM cloud_agent_versions_v3 WHERE id=$1',[instance.base_agent_version_id])).rows[0]?.payload_json||{};
  const active=instance.active_personal_skill_version_id
    ?(await client.query('SELECT * FROM cloud_personal_skill_overlay_versions WHERE user_id=$1 AND id=$2',[userId,instance.active_personal_skill_version_id])).rows[0]:null;
  const overlay=active?decryptEvolutionPayload({algorithm:active.encryption_algorithm,keyId:active.key_id,ciphertext:active.content_ciphertext,
    nonce:active.content_nonce,tag:active.content_tag},keyring):'';
  const memory=(await client.query(`SELECT d.id,d.current_version_id,v.content_hash,v.payload_json FROM cloud_memory_documents_v3 d
    LEFT JOIN cloud_memory_document_versions_v3 v ON v.user_id=d.user_id AND v.id=d.current_version_id
    WHERE d.user_id=$1 AND d.user_agent_instance_id=$2 AND d.lifecycle_state='active' AND d.allow_personal_evolution=true ORDER BY d.id`,
  [userId,instance.id])).rows.map((row)=>({id:row.id,currentVersionId:row.current_version_id,contentHash:row.content_hash||'',content:row.payload_json?.content||''}));
  const baseSkill=base.base_skill_content||base.baseSkillContent||'';
  const baseEncrypted=encryptEvolutionPayload(baseSkill,keyring),overlayEncrypted=encryptEvolutionPayload(overlay,keyring),memoryEncrypted=encryptEvolutionPayload(memory,keyring);
  const snapshot={evidenceIds:[...evidenceIds],baseAgentVersionId:instance.base_agent_version_id||'',basePersonalSkillVersionId:instance.active_personal_skill_version_id||'',
    memory:memory.map((item)=>[item.id,item.currentVersionId,item.contentHash])};
  await client.query(`INSERT INTO cloud_evolution_run_snapshots(run_id,snapshot_hash,evidence_ids_json,base_skill_ciphertext,
    personal_overlay_ciphertext,memory_manifest_ciphertext,encryption_json) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb)`,[
    runId,crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),JSON.stringify(evidenceIds),baseEncrypted.ciphertext,
    overlayEncrypted.ciphertext,memoryEncrypted.ciphertext,JSON.stringify({base:baseEncrypted,overlay:overlayEncrypted,memory:memoryEncrypted}),
  ]);
}
async function transaction(pool, callback) { const client = await pool.connect(); try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
