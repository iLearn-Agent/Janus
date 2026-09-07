import crypto from 'node:crypto';

import { evolutionReEvaluationBasisHash, EVIDENCE_CONTRACT_POLICY_VERSION } from '../../../shared/evolution/index.js';

export function createSqliteEvidenceUsageLedger(db) {
  if (!db) throw new Error('Evidence usage Ledger requires a database.');
  const ledger = {
    ensureAvailable({ evidenceId, scope, consumerId, transitionReason = 'evidence_ingested', now = nowIso() } = {}) {
      return atomic(db, () => {
        const result = db.prepare(`INSERT OR IGNORE INTO cloud_evolution_evidence_usage
          (evidence_id,evolution_scope,consumer_id,status,transition_reason,updated_at)
          VALUES (?,?,?,'available',?,?)`).run(evidenceId, scope, consumerId, transitionReason, now);
        if (result.changes) recordEvent(db, { evidenceId, scope, consumerId, fromStatus: '', toStatus: 'available', transitionReason, occurredAt: now });
        return Boolean(result.changes);
      });
    },

    reserve({ scope, consumerId, runId, algorithmVersion, evidenceIds = [], nextBasisByEvidence = {}, leaseExpiresAt, transitionReason = 'reserved_for_run', now = nowIso(), clusterClaims = false } = {}) {
      return atomic(db, () => {
        const reserved = [];
        for (const evidenceId of [...new Set(evidenceIds.map(String).filter(Boolean))]) {
          const current = db.prepare(`SELECT * FROM cloud_evolution_evidence_usage
            WHERE evidence_id=? AND evolution_scope=? AND consumer_id=?`).get(evidenceId, scope, consumerId);
          if (!current || !reservationAllowed(current, { runId, nextBasisHash: nextBasisByEvidence[evidenceId] || '' })) continue;
          if (clusterClaims) {
            const claim = db.prepare(`INSERT OR IGNORE INTO cloud_cluster_evidence_claims
              (evidence_id,consumer_id,run_id,claim_state,claimed_at,payload_json,updated_at)
              VALUES (?,?,?,'reserved',?,'{}',?)`).run(evidenceId, consumerId, runId, now, now);
            const existing = db.prepare('SELECT * FROM cloud_cluster_evidence_claims WHERE evidence_id=?').get(evidenceId);
            if (!claim.changes && (existing?.consumer_id !== consumerId || existing?.run_id !== runId || existing?.claim_state !== 'reserved')) continue;
          }
          const nextBasisHash = nextBasisByEvidence[evidenceId] || current.re_evaluation_basis_hash || '';
          const result = db.prepare(`UPDATE cloud_evolution_evidence_usage SET status='reserved',run_id=?,algorithm_version=?,
            rejection_kind='',transition_reason=?,re_evaluation_basis_hash=?,reserved_at=?,lease_expires_at=?,terminal_at='',updated_at=?
            WHERE evidence_id=? AND evolution_scope=? AND consumer_id=? AND status=?`).run(
            runId,algorithmVersion,transitionReason,nextBasisHash,now,leaseExpiresAt || '',now,evidenceId,scope,consumerId,current.status,
          );
          if (!result.changes) continue;
          recordEvent(db, { evidenceId,scope,consumerId,fromStatus:current.status,toStatus:'reserved',runId,algorithmVersion,
            transitionReason,reEvaluationBasisHash:nextBasisHash,occurredAt:now });
          reserved.push(evidenceId);
        }
        return reserved;
      });
    },

    transitionRun({ scope, consumerId, runId, toStatus, rejectionKind = '', transitionReason = '', basisByEvidence = {}, now = nowIso(), clusterClaims = false } = {}) {
      return atomic(db, () => transitionRun(db, { scope,consumerId,runId,toStatus,rejectionKind,transitionReason,basisByEvidence,now,clusterClaims }));
    },

    refreshRunLease({ scope, runId, leaseExpiresAt, now = nowIso() } = {}) {
      return Number(db.prepare(`UPDATE cloud_evolution_evidence_usage SET lease_expires_at=?,updated_at=?
        WHERE run_id=? AND evolution_scope=? AND status='reserved'`).run(leaseExpiresAt,now,runId,scope).changes || 0);
    },

    clearRunLease({scope,runId,now=nowIso()}={}) {
      return Number(db.prepare(`UPDATE cloud_evolution_evidence_usage SET lease_expires_at='',updated_at=?
        WHERE run_id=? AND evolution_scope=? AND status='reserved'`).run(now,runId,scope).changes||0);
    },

    releaseExpired({ now = nowIso() } = {}) {
      return atomic(db, () => {
        const rows = db.prepare(`SELECT u.* FROM cloud_evolution_evidence_usage u
          LEFT JOIN cloud_evolution_runs r ON r.id=u.run_id LEFT JOIN cloud_evolution_jobs j ON j.run_id=u.run_id
          WHERE u.status='reserved' AND (u.lease_expires_at='' OR u.lease_expires_at<=?)
            AND (r.id IS NULL OR r.status NOT IN ('queued','claimed','running','proposed','failed_retryable')
              OR j.id IS NULL OR j.status NOT IN ('queued','claimed','running','waiting_canary','failed_retryable'))`).all(now);
        for (const row of rows) transitionRun(db, { scope:row.evolution_scope,consumerId:row.consumer_id,runId:row.run_id,
          toStatus:'released',transitionReason:'expired_or_orphaned_reservation',now,clusterClaims:row.evolution_scope === 'cluster' });
        return rows.length;
      });
    },

    selectPersonalCandidates({ ownerUserId,agentInstanceId,consumerId=agentInstanceId,minimum=5,limit=60,
      algorithmVersion,policyVersion=EVIDENCE_CONTRACT_POLICY_VERSION } = {}) {
      const eligible=db.prepare(`SELECT e.* FROM cloud_evolution_evidence e
        JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
        WHERE e.owner_user_id=? AND e.user_agent_instance_id=? AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=0
          AND e.personal_threshold_eligible=1 AND u.evolution_scope='personal' AND u.consumer_id=?
          AND u.status IN ('available','released') ORDER BY e.occurred_at,e.evidence_id LIMIT ?`)
        .all(ownerUserId,agentInstanceId,consumerId,limit);
      if (eligible.length<minimum) return {rows:eligible,thresholdEligibleCount:eligible.length};
      const mandatory=new Set(eligible.slice(0,minimum).map((row)=>row.evidence_id));
      const fresh=db.prepare(`SELECT e.* FROM cloud_evolution_evidence e
        JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
        WHERE e.owner_user_id=? AND e.user_agent_instance_id=? AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=0
          AND u.evolution_scope='personal' AND u.consumer_id=? AND u.status IN ('available','released')
        ORDER BY e.occurred_at,e.evidence_id LIMIT ?`).all(ownerUserId,agentInstanceId,consumerId,limit);
      const byId=new Map([...eligible.slice(0,minimum),...fresh].map((row)=>[row.evidence_id,row]));
      let rows=[...byId.values()].sort(evidenceOrder);
      if(rows.length>limit)rows=[...rows.filter((row)=>mandatory.has(row.evidence_id)),...rows.filter((row)=>!mandatory.has(row.evidence_id))]
        .slice(0,limit).sort(evidenceOrder);
      if(rows.length<limit){
        const freshIds=rows.map((row)=>row.evidence_id);
        const rejected=db.prepare(`SELECT e.*,u.re_evaluation_basis_hash FROM cloud_evolution_evidence e
          JOIN cloud_evolution_evidence_usage u ON u.evidence_id=e.evidence_id
          WHERE e.owner_user_id=? AND e.user_agent_instance_id=? AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=0
            AND u.evolution_scope='personal' AND u.consumer_id=? AND u.status='evaluated_rejected'
          ORDER BY e.occurred_at,e.evidence_id LIMIT ?`).all(ownerUserId,agentInstanceId,consumerId,limit-rows.length);
        rows.push(...rejected.map((row)=>({...row,next_re_evaluation_basis_hash:evolutionReEvaluationBasisHash({algorithmVersion,policyVersion,
          relatedEvidenceIds:[...freshIds,row.evidence_id]})})).filter((row)=>row.next_re_evaluation_basis_hash!==row.re_evaluation_basis_hash));
      }
      return {rows,thresholdEligibleCount:eligible.length};
    },

    counts({ ownerUserId, agentInstanceId, scope = 'personal', consumerId = agentInstanceId } = {}) {
      const rows = db.prepare(`SELECT u.status,COUNT(*) AS count FROM cloud_evolution_evidence_usage u
        JOIN cloud_evolution_evidence e ON e.evidence_id=u.evidence_id
        WHERE e.owner_user_id=? AND e.user_agent_instance_id=? AND e.quarantine_reason='' AND e.validation_status='validated' AND e.historical_inactive=0
          AND u.evolution_scope=? AND u.consumer_id=? GROUP BY u.status`).all(ownerUserId,agentInstanceId,scope,consumerId);
      return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
    },

    listUsage({ ownerUserId, agentInstanceId, scope = '', status = '', cursor = {}, limit = 50 } = {}) {
      const where = ['e.owner_user_id=?','e.user_agent_instance_id=?'];
      const params = [ownerUserId,agentInstanceId];
      if (scope) { where.push('u.evolution_scope=?'); params.push(scope); }
      if (status) { where.push('u.status=?'); params.push(status); }
      if (cursor.updatedAt) {
        where.push('(u.updated_at<? OR (u.updated_at=? AND u.evidence_id<?))');
        params.push(cursor.updatedAt,cursor.updatedAt,cursor.evidenceId || '');
      }
      params.push(Math.min(201,Math.max(1,Number(limit || 50))));
      return db.prepare(`SELECT u.*,e.source_kind,e.source_id,e.source_version_id,e.occurred_at,e.content_hash,
          e.personal_threshold_eligible,e.eligibility_policy_version
        FROM cloud_evolution_evidence_usage u JOIN cloud_evolution_evidence e ON e.evidence_id=u.evidence_id
        WHERE ${where.join(' AND ')} ORDER BY u.updated_at DESC,u.evidence_id DESC LIMIT ?`).all(...params);
    },

    runUsage({ runId, scope, consumerId } = {}) {
      return db.prepare(`SELECT evidence_id,status,rejection_kind,transition_reason,re_evaluation_basis_hash
        FROM cloud_evolution_evidence_usage WHERE run_id=? AND evolution_scope=? AND consumer_id=? ORDER BY evidence_id`)
        .all(runId,scope,consumerId);
    },
  };
  return ledger;
}

function transitionRun(db, { scope,consumerId,runId,toStatus,rejectionKind='',transitionReason='',basisByEvidence={},now,clusterClaims=false }) {
  const rows = db.prepare(`SELECT * FROM cloud_evolution_evidence_usage
    WHERE run_id=? AND evolution_scope=? AND consumer_id=? AND status='reserved' ORDER BY evidence_id`).all(runId,scope,consumerId);
  const evidenceIds = rows.map((row) => row.evidence_id);
  const basisHash = toStatus === 'evaluated_rejected' ? evolutionReEvaluationBasisHash({
    algorithmVersion: rows[0]?.algorithm_version || '', policyVersion: EVIDENCE_CONTRACT_POLICY_VERSION, relatedEvidenceIds: evidenceIds,
  }) : '';
  for (const row of rows) {
    const rowBasisHash = basisByEvidence[row.evidence_id] || basisHash;
    db.prepare(`UPDATE cloud_evolution_evidence_usage SET status=?,rejection_kind=?,transition_reason=?,
      re_evaluation_basis_hash=CASE WHEN ?='evaluated_rejected' THEN ? ELSE re_evaluation_basis_hash END,
      lease_expires_at='',terminal_at=?,updated_at=? WHERE evidence_id=? AND evolution_scope=? AND consumer_id=? AND status='reserved'`).run(
      toStatus,toStatus === 'evaluated_rejected' ? rejectionKind : '',transitionReason,toStatus,rowBasisHash,
      ['consumed','evaluated_rejected'].includes(toStatus) ? now : '',now,row.evidence_id,scope,consumerId,
    );
    if (clusterClaims) {
      if (toStatus === 'consumed') db.prepare(`UPDATE cloud_cluster_evidence_claims SET claim_state='consumed',terminal_at=?,updated_at=?
        WHERE evidence_id=? AND run_id=? AND claim_state='reserved'`).run(now,now,row.evidence_id,runId);
      else db.prepare("DELETE FROM cloud_cluster_evidence_claims WHERE evidence_id=? AND run_id=? AND claim_state='reserved'").run(row.evidence_id,runId);
    }
    recordEvent(db, { evidenceId:row.evidence_id,scope,consumerId,fromStatus:'reserved',toStatus,runId,
      algorithmVersion:row.algorithm_version,rejectionKind:toStatus === 'evaluated_rejected' ? rejectionKind : '',transitionReason,
      reEvaluationBasisHash:rowBasisHash,occurredAt:now });
  }
  return evidenceIds;
}

function atomic(db, callback) {
  const savepoint = `evidence_usage_${crypto.randomUUID().replaceAll('-', '')}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = callback();
    db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); } catch {}
    try { db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch {}
    throw error;
  }
}

function reservationAllowed(row, { runId, nextBasisHash }) {
  if (['available','released'].includes(row.status)) return true;
  return row.status === 'evaluated_rejected' && runId && runId !== row.run_id && nextBasisHash
    && nextBasisHash !== row.re_evaluation_basis_hash;
}

function recordEvent(db, input) {
  db.prepare(`INSERT INTO cloud_evolution_evidence_usage_events (
    id,evidence_id,evolution_scope,consumer_id,from_status,to_status,run_id,algorithm_version,rejection_kind,
    transition_reason,re_evaluation_basis_hash,occurred_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(`usage_event_${crypto.randomUUID()}`,input.evidenceId,input.scope,input.consumerId,
    input.fromStatus || '',input.toStatus,input.runId || '',input.algorithmVersion || '',input.rejectionKind || '',
    input.transitionReason || '',input.reEvaluationBasisHash || '',input.occurredAt || nowIso());
}

function nowIso() { return new Date().toISOString(); }
function evidenceOrder(a,b) { return String(a.occurred_at||'').localeCompare(String(b.occurred_at||''))||String(a.evidence_id||'').localeCompare(String(b.evidence_id||'')); }
