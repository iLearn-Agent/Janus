import crypto from 'node:crypto';

import { EVIDENCE_CONTRACT_POLICY_VERSION, evolutionReEvaluationBasisHash } from '../../../../src/shared/evolution/index.js';

export function createPostgresEvidenceUsageLedger(queryable) {
  if (!queryable?.query) throw new Error('Evidence usage Ledger requires a PostgreSQL queryable.');
  return {
    ensureAvailable(input = {}) {
      return atomic(queryable, (client) => ensureAvailable(client, input));
    },
    reserve(input = {}) {
      return atomic(queryable, (client) => reserve(client, input));
    },
    transitionRun(input = {}) {
      return atomic(queryable, (client) => transitionRun(client, input));
    },
    refreshRunLease(input = {}) {
      return atomic(queryable, (client) => refreshRunLease(client, input));
    },
    clearRunLease(input = {}) {
      return atomic(queryable,(client)=>clearRunLease(client,input));
    },
    releaseExpired() {
      return atomic(queryable, async (client) => {
        const rows = (await client.query(`SELECT u.* FROM cloud_evolution_evidence_usage u
          LEFT JOIN cloud_evolution_runs r ON r.id=u.run_id LEFT JOIN cloud_evolution_jobs j ON j.run_id=u.run_id
          WHERE u.status='reserved' AND (u.lease_expires_at IS NULL OR u.lease_expires_at<=now())
            AND (r.id IS NULL OR r.status NOT IN ('queued','claimed','running','proposed','failed_retryable')
              OR j.id IS NULL OR j.status NOT IN ('queued','claimed','running','waiting_canary','failed_retryable'))`)).rows;
        for (const row of rows) await transitionRun(client, { scope:row.evolution_scope,consumerId:row.consumer_id,runId:row.run_id,
          toStatus:'released',transitionReason:'expired_or_orphaned_reservation',clusterClaims:row.evolution_scope==='cluster' });
        return rows.length;
      });
    },
    selectPersonalCandidates(input = {}) {
      return atomic(queryable,(client)=>selectPersonalCandidates(client,input));
    },
    async counts({ ownerUserId,agentInstanceId,scope='personal',consumerId=agentInstanceId } = {}) {
      const rows=(await queryable.query(`SELECT u.status,COUNT(*)::int AS count FROM cloud_evolution_evidence_usage u
        JOIN cloud_evolution_evidence e ON e.evidence_id=u.evidence_id
        WHERE e.owner_user_id=$1 AND e.user_agent_instance_id=$2 AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=false
          AND u.evolution_scope=$3 AND u.consumer_id=$4 GROUP BY u.status`,[ownerUserId,agentInstanceId,scope,consumerId])).rows;
      return Object.fromEntries(rows.map((row)=>[row.status,Number(row.count||0)]));
    },
    async listUsage({ ownerUserId,agentInstanceId,scope='',status='',cursor={},limit=50 } = {}) {
      const values=[ownerUserId,agentInstanceId];const filters=[];
      if(scope){values.push(scope);filters.push(`u.evolution_scope=$${values.length}`);}
      if(status){values.push(status);filters.push(`u.status=$${values.length}`);}
      if(cursor.updatedAt){values.push(cursor.updatedAt);const atIndex=values.length;values.push(cursor.evidenceId||'');
        filters.push(`(u.updated_at<$${atIndex}::timestamptz OR (u.updated_at=$${atIndex}::timestamptz AND u.evidence_id<$${values.length}))`);}
      values.push(Math.min(201,Math.max(1,Number(limit||50))));
      return (await queryable.query(`SELECT u.*,e.source_kind,e.source_id,e.source_version_id,e.occurred_at,e.content_hash,
          e.personal_threshold_eligible,e.eligibility_policy_version
        FROM cloud_evolution_evidence_usage u JOIN cloud_evolution_evidence e ON e.evidence_id=u.evidence_id
        WHERE e.owner_user_id=$1 AND e.user_agent_instance_id=$2 ${filters.length?`AND ${filters.join(' AND ')}`:''}
        ORDER BY u.updated_at DESC,u.evidence_id DESC LIMIT $${values.length}`,values)).rows;
    },
    async runUsage({ runId,scope,consumerId } = {}) {
      return (await queryable.query(`SELECT evidence_id,status,rejection_kind,transition_reason,re_evaluation_basis_hash
        FROM cloud_evolution_evidence_usage WHERE run_id=$1 AND evolution_scope=$2 AND consumer_id=$3 ORDER BY evidence_id`,
      [runId,scope,consumerId])).rows;
    },
  };
}

async function ensureAvailable(client, { evidenceId,scope,consumerId,transitionReason='evidence_ingested' } = {}) {
  const inserted = await client.query(`INSERT INTO cloud_evolution_evidence_usage
    (evidence_id,evolution_scope,consumer_id,status,transition_reason,updated_at)
    VALUES($1,$2,$3,'available',$4,now()) ON CONFLICT DO NOTHING RETURNING evidence_id`, [evidenceId,scope,consumerId,transitionReason]);
  if (inserted.rows.length) await recordEvent(client, { evidenceId,scope,consumerId,fromStatus:'',toStatus:'available',transitionReason });
  return Boolean(inserted.rows.length);
}

async function selectPersonalCandidates(client,{ownerUserId,agentInstanceId,consumerId=agentInstanceId,minimum=5,limit=60,
  algorithmVersion,policyVersion=EVIDENCE_CONTRACT_POLICY_VERSION}={}) {
  const eligible=(await client.query(`SELECT e.* FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    WHERE e.owner_user_id=$1 AND e.user_agent_instance_id=$2 AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=false AND e.personal_threshold_eligible=true
      AND u.evolution_scope='personal' AND u.consumer_id=$3 AND u.status IN ('available','released')
    ORDER BY e.occurred_at,e.evidence_id LIMIT $4 FOR UPDATE SKIP LOCKED`,[ownerUserId,agentInstanceId,consumerId,limit])).rows;
  if(eligible.length<minimum)return {rows:eligible,thresholdEligibleCount:eligible.length};
  const mandatory=new Set(eligible.slice(0,minimum).map((row)=>row.evidence_id));
  const fresh=(await client.query(`SELECT e.* FROM cloud_evolution_evidence e JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
    WHERE e.owner_user_id=$1 AND e.user_agent_instance_id=$2 AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=false
      AND u.evolution_scope='personal' AND u.consumer_id=$3 AND u.status IN ('available','released')
    ORDER BY e.occurred_at,e.evidence_id LIMIT $4 FOR UPDATE SKIP LOCKED`,[ownerUserId,agentInstanceId,consumerId,limit])).rows;
  const byId=new Map([...eligible.slice(0,minimum),...fresh].map((row)=>[row.evidence_id,row]));
  let rows=[...byId.values()].sort(evidenceOrder);
  if(rows.length>limit)rows=[...rows.filter((row)=>mandatory.has(row.evidence_id)),...rows.filter((row)=>!mandatory.has(row.evidence_id))]
    .slice(0,limit).sort(evidenceOrder);
  if(rows.length<limit){
    const freshIds=rows.map((row)=>row.evidence_id);
    const rejected=(await client.query(`SELECT e.*,u.re_evaluation_basis_hash FROM cloud_evolution_evidence e
      JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
      WHERE e.owner_user_id=$1 AND e.user_agent_instance_id=$2 AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=false
        AND u.evolution_scope='personal' AND u.consumer_id=$3 AND u.status='evaluated_rejected'
      ORDER BY e.occurred_at,e.evidence_id LIMIT $4 FOR UPDATE SKIP LOCKED`,[ownerUserId,agentInstanceId,consumerId,limit-rows.length])).rows;
    rows.push(...rejected.map((row)=>({...row,nextReEvaluationBasisHash:evolutionReEvaluationBasisHash({algorithmVersion,policyVersion,
      relatedEvidenceIds:[...freshIds,row.evidence_id]})})).filter((row)=>row.nextReEvaluationBasisHash!==row.re_evaluation_basis_hash));
  }
  return {rows,thresholdEligibleCount:eligible.length};
}

async function reserve(client, { scope,consumerId,runId,algorithmVersion,evidenceIds=[],nextBasisByEvidence={},leaseMinutes=30,
  transitionReason='reserved_for_run',clusterClaims=false } = {}) {
  const reserved=[];
  for (const evidenceId of [...new Set(evidenceIds.map(String).filter(Boolean))]) {
    const current=(await client.query(`SELECT * FROM cloud_evolution_evidence_usage
      WHERE evidence_id=$1 AND evolution_scope=$2 AND consumer_id=$3 FOR UPDATE`,[evidenceId,scope,consumerId])).rows[0];
    if (!current || !reservationAllowed(current,{runId,nextBasisHash:nextBasisByEvidence[evidenceId]||''})) continue;
    if (clusterClaims) {
      const claim=await client.query(`INSERT INTO cloud_cluster_evidence_claims
        (evidence_id,consumer_id,run_id,claim_state,claimed_at,payload_json,updated_at)
        VALUES($1,$2,$3,'reserved',now(),'{}'::jsonb,now()) ON CONFLICT DO NOTHING RETURNING evidence_id`,[evidenceId,consumerId,runId]);
      if (!claim.rows.length) {
        const existing=(await client.query('SELECT * FROM cloud_cluster_evidence_claims WHERE evidence_id=$1 FOR UPDATE',[evidenceId])).rows[0];
        if (existing?.consumer_id!==consumerId || existing?.run_id!==runId || existing?.claim_state!=='reserved') continue;
      }
    }
    const nextBasisHash=nextBasisByEvidence[evidenceId]||current.re_evaluation_basis_hash||'';
    const updated=await client.query(`UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id=$1,algorithm_version=$2,
      rejection_kind='',transition_reason=$3,re_evaluation_basis_hash=$4,reserved_at=now(),
      lease_expires_at=now()+($5::text||' minutes')::interval,terminal_at=NULL,updated_at=now()
      WHERE evidence_id=$6 AND evolution_scope=$7 AND consumer_id=$8 AND status=$9 RETURNING evidence_id`,[
      runId,algorithmVersion,transitionReason,nextBasisHash,String(Math.max(1,Number(leaseMinutes||30))),evidenceId,scope,consumerId,current.status,
    ]);
    if (!updated.rows.length) continue;
    await recordEvent(client,{evidenceId,scope,consumerId,fromStatus:current.status,toStatus:'reserved',runId,algorithmVersion,
      transitionReason,reEvaluationBasisHash:nextBasisHash});
    reserved.push(evidenceId);
  }
  return reserved;
}

async function transitionRun(client, { scope,consumerId,runId,toStatus,rejectionKind='',transitionReason='',basisByEvidence={},clusterClaims=false } = {}) {
  const rows=(await client.query(`SELECT * FROM cloud_evolution_evidence_usage
    WHERE run_id=$1 AND evolution_scope=$2 AND consumer_id=$3 AND status='reserved' ORDER BY evidence_id FOR UPDATE`,[runId,scope,consumerId])).rows;
  const evidenceIds=rows.map((row)=>row.evidence_id);
  const basisHash=toStatus==='evaluated_rejected'?evolutionReEvaluationBasisHash({algorithmVersion:rows[0]?.algorithm_version||'',
    policyVersion:EVIDENCE_CONTRACT_POLICY_VERSION,relatedEvidenceIds:evidenceIds}):'';
  for (const row of rows) {
    const rowBasisHash=basisByEvidence[row.evidence_id]||basisHash;
    await client.query(`UPDATE cloud_evolution_evidence_usage SET status=$1,rejection_kind=$2,transition_reason=$3,
      re_evaluation_basis_hash=CASE WHEN $1='evaluated_rejected' THEN $4 ELSE re_evaluation_basis_hash END,
      lease_expires_at=NULL,terminal_at=CASE WHEN $1 IN ('consumed','evaluated_rejected') THEN now() ELSE NULL END,updated_at=now()
      WHERE evidence_id=$5 AND evolution_scope=$6 AND consumer_id=$7 AND status='reserved'`,[
      toStatus,toStatus==='evaluated_rejected'?rejectionKind:'',transitionReason,rowBasisHash,row.evidence_id,scope,consumerId,
    ]);
    if (clusterClaims) {
      if (toStatus==='consumed') await client.query(`UPDATE cloud_cluster_evidence_claims SET claim_state='consumed',terminal_at=now(),updated_at=now()
        WHERE evidence_id=$1 AND run_id=$2 AND claim_state='reserved'`,[row.evidence_id,runId]);
      else await client.query("DELETE FROM cloud_cluster_evidence_claims WHERE evidence_id=$1 AND run_id=$2 AND claim_state='reserved'",[row.evidence_id,runId]);
    }
    await recordEvent(client,{evidenceId:row.evidence_id,scope,consumerId,fromStatus:'reserved',toStatus,runId,
      algorithmVersion:row.algorithm_version,rejectionKind:toStatus==='evaluated_rejected'?rejectionKind:'',transitionReason,reEvaluationBasisHash:rowBasisHash});
  }
  return evidenceIds;
}

async function refreshRunLease(client, { scope,runId,leaseMinutes=15 } = {}) {
  const result=await client.query(`UPDATE cloud_evolution_evidence_usage
    SET lease_expires_at=now()+($1::text||' minutes')::interval,updated_at=now()
    WHERE run_id=$2 AND evolution_scope=$3 AND status='reserved'`,[String(Math.max(1,Number(leaseMinutes||15))),runId,scope]);
  return result.rowCount||0;
}

async function clearRunLease(client,{scope,runId}={}) {
  const result=await client.query(`UPDATE cloud_evolution_evidence_usage SET lease_expires_at=NULL,updated_at=now()
    WHERE run_id=$1 AND evolution_scope=$2 AND status='reserved'`,[runId,scope]);
  return result.rowCount||0;
}

function reservationAllowed(row,{runId,nextBasisHash}) {
  if(['available','released'].includes(row.status)) return true;
  return row.status==='evaluated_rejected'&&runId&&runId!==row.run_id&&nextBasisHash&&nextBasisHash!==row.re_evaluation_basis_hash;
}

async function recordEvent(client,input) {
  await client.query(`INSERT INTO cloud_evolution_evidence_usage_events (
    id,evidence_id,evolution_scope,consumer_id,from_status,to_status,run_id,algorithm_version,rejection_kind,transition_reason,re_evaluation_basis_hash,occurred_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,[`usage_event_${crypto.randomUUID()}`,input.evidenceId,input.scope,input.consumerId,
    input.fromStatus||'',input.toStatus,input.runId||'',input.algorithmVersion||'',input.rejectionKind||'',input.transitionReason||'',input.reEvaluationBasisHash||'']);
}

async function atomic(queryable, callback) {
  if (typeof queryable.connect !== 'function' || typeof queryable.release === 'function') return callback(queryable);
  const client=await queryable.connect();
  try {
    await client.query('BEGIN');
    const result=await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

function evidenceOrder(a,b){return new Date(a.occurred_at||0)-new Date(b.occurred_at||0)||String(a.evidence_id||'').localeCompare(String(b.evidence_id||''));}
