import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { nowIso } from '../../../utils.js';
import { normalizeEvolutionEvidenceSourceKind } from '../../../../shared/evolution/index.js';

const CLAIMABLE_OUTBOX_STATES = ['pending', 'deferred', 'failed_retryable'];

export function installEvolutionEvidenceOutboxStoreMethods(prototype) {
  Object.assign(prototype, {
    recordEvolutionEvidenceOutbox(input = {}, { withinTransaction = false } = {}) {
      const normalized = normalizeOutboxInput(input);
      const outboxId = stableOutboxId(normalized);
      const ownsTransaction = !withinTransaction && !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `INSERT OR IGNORE INTO evolution_evidence_outbox (
          outbox_id,local_user_id,user_agent_instance_id,agent_family_id,source_kind,source_id,source_version_id,
          lineage_key,content_hash,context_space_id,task_run_id,delegation_id,confidence,privacy_level,snapshot_json,status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, [
          outboxId,normalized.localUserId,normalized.userAgentInstanceId,normalized.agentFamilyId,normalized.sourceKind,
          normalized.sourceId,normalized.sourceVersionId,normalized.lineageKey,normalized.contentHash,normalized.contextSpaceId,
          normalized.taskRunId,normalized.delegationId,normalized.confidence,normalized.privacyLevel,
          JSON.stringify(normalized.snapshot),normalized.createdAt,normalized.createdAt,
        ]);
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return normalizeOutboxRow(get(this.db, 'SELECT * FROM evolution_evidence_outbox WHERE outbox_id=?', [outboxId]));
    },

    claimEvolutionEvidenceOutbox({
      localUserId = '', limit = 100, workerId = `desktop_${process.pid}`, leaseMs = 15 * 60 * 1000,
    } = {}) {
      const cleanLocalUserId = String(localUserId || '').trim();
      if (!cleanLocalUserId) throw new Error('Evolution Evidence outbox claim requires the active local user.');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const now = nowIso();
        const rows = all(this.db, `SELECT * FROM evolution_evidence_outbox
          WHERE local_user_id=? AND (
            status='pending'
            OR (status IN ('deferred','failed_retryable') AND (next_attempt_at='' OR next_attempt_at<=?))
            OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?)
          )
          ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed_retryable' THEN 1 WHEN 'deferred' THEN 2 ELSE 3 END,
            COALESCE(NULLIF(next_attempt_at,''),created_at),created_at,outbox_id LIMIT ?`, [
          cleanLocalUserId,now,now,Math.min(500, Math.max(1, Number(limit || 100))),
        ]);
        const leaseExpiresAt = new Date(Date.now() + Math.max(1000, Number(leaseMs || 0))).toISOString();
        const claimed = [];
        for (const row of rows) {
          const result = run(this.db, `UPDATE evolution_evidence_outbox SET status='claimed',claimed_by=?,claimed_at=?,lease_expires_at=?,
            attempt_count=attempt_count+1,updated_at=? WHERE outbox_id=? AND local_user_id=? AND (
              status='pending'
              OR (status IN ('deferred','failed_retryable') AND (next_attempt_at='' OR next_attempt_at<=?))
              OR (status='claimed' AND lease_expires_at<>'' AND lease_expires_at<=?)
            )`, [
            workerId,now,leaseExpiresAt,now,row.outbox_id,cleanLocalUserId,now,now,
          ]);
          if (result.changes) claimed.push(normalizeOutboxRow(get(this.db, 'SELECT * FROM evolution_evidence_outbox WHERE outbox_id=?', [row.outbox_id])));
        }
        if (ownsTransaction) this.db.exec('COMMIT');
        return claimed;
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    completeEvolutionEvidenceOutbox(outboxId = '', {
      status = 'uploaded', remoteEvidenceId = '', error = '', uploadedAt = '', preserveAttempt = false,
      deferReason = '', nextAttemptAt = '',
    } = {}) {
      if (!['pending','deferred','uploaded','failed_retryable','quarantined','rejected'].includes(status)) {
        throw new Error(`Invalid evolution Evidence outbox completion status: ${status}`);
      }
      const now = nowIso();
      const retryable = ['deferred', 'failed_retryable'].includes(status);
      run(this.db, `UPDATE evolution_evidence_outbox SET status=?,remote_evidence_id=?,last_error=?,uploaded_at=?,
        claimed_by='',claimed_at='',lease_expires_at='',attempt_count=CASE WHEN ? THEN MAX(0,attempt_count-1) ELSE attempt_count END,
        defer_reason=?,next_attempt_at=?,updated_at=? WHERE outbox_id=?`, [
        status,remoteEvidenceId || '',String(error || '').slice(0, 2000),uploadedAt || (status === 'uploaded' ? now : ''),
        preserveAttempt ? 1 : 0,retryable ? String(deferReason || error || status).slice(0, 200) : '',
        retryable ? String(nextAttemptAt || '') : '',now,outboxId,
      ]);
      if (status === 'quarantined') {
        const row = get(this.db, 'SELECT * FROM evolution_evidence_outbox WHERE outbox_id=?', [outboxId]);
        if (row) run(this.db, `INSERT OR IGNORE INTO evolution_evidence_quarantine (
          id,outbox_id,local_user_id,user_agent_instance_id,source_kind,source_id,source_version_id,
          reason_code,reason_text,retryable,resolution_status,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,0,'pending',?,?)`, [
          `evquar_${crypto.createHash('sha256').update(`${outboxId}\n${error || 'quarantined'}`).digest('hex').slice(0,32)}`,
          outboxId,row.local_user_id,row.user_agent_instance_id,row.source_kind,row.source_id,row.source_version_id,
          String(error || 'quarantined').split(':',1)[0],String(error || '').slice(0,2000),now,now,
        ]);
      }
      return normalizeOutboxRow(get(this.db, 'SELECT * FROM evolution_evidence_outbox WHERE outbox_id=?', [outboxId]));
    },

    canonicalizeDelegationEvidenceOutbox({ delegationId = '', provisionalTaskRunId = '', taskRunId = '' } = {}) {
      const cleanDelegationId = String(delegationId || '').trim();
      const cleanProvisionalTaskRunId = String(provisionalTaskRunId || cleanDelegationId).trim();
      const cleanTaskRunId = String(taskRunId || '').trim();
      if (!cleanDelegationId || !cleanTaskRunId || cleanProvisionalTaskRunId === cleanTaskRunId) return [];
      const rows = all(this.db, `SELECT * FROM evolution_evidence_outbox
        WHERE delegation_id=? AND task_run_id IN ('',?)
        AND status IN ('pending','claimed','deferred','failed_retryable')`, [cleanDelegationId, cleanProvisionalTaskRunId]);
      const updated = [];
      for (const row of rows) {
        let snapshot = {};
        try { snapshot = JSON.parse(row.snapshot_json || '{}'); } catch { snapshot = {}; }
        snapshot.taskRunId = cleanTaskRunId;
        snapshot.delegationId = cleanDelegationId;
        run(this.db, `UPDATE evolution_evidence_outbox SET task_run_id=?,snapshot_json=?,updated_at=? WHERE outbox_id=?`, [
          cleanTaskRunId,JSON.stringify(snapshot),nowIso(),row.outbox_id,
        ]);
        updated.push(normalizeOutboxRow(get(this.db, 'SELECT * FROM evolution_evidence_outbox WHERE outbox_id=?', [row.outbox_id])));
      }
      return updated;
    },

    evolutionEvidenceOutboxCounts() {
      return Object.fromEntries(all(this.db, 'SELECT status,COUNT(*) count FROM evolution_evidence_outbox GROUP BY status')
        .map((row) => [row.status, Number(row.count || 0)]));
    },

    evolutionEvidenceOutboxStatus({ localUserId = '' } = {}) {
      const cleanLocalUserId = String(localUserId || '').trim();
      const currentRows = cleanLocalUserId ? all(this.db, `SELECT status,COUNT(*) count
        FROM evolution_evidence_outbox WHERE local_user_id=? GROUP BY status`, [cleanLocalUserId]) : [];
      const currentAccount = Object.fromEntries(currentRows.map((row) => [row.status, Number(row.count || 0)]));
      const otherAccountsPending = Number(get(this.db, `SELECT COUNT(*) count FROM evolution_evidence_outbox
        WHERE local_user_id<>? AND status IN ('pending','claimed','deferred','failed_retryable')`, [cleanLocalUserId])?.count || 0);
      const permanentlyBlocked = Number(get(this.db, `SELECT COUNT(*) count FROM evolution_evidence_outbox
        WHERE (?='' OR local_user_id=?) AND status IN ('quarantined','rejected')`, [cleanLocalUserId, cleanLocalUserId])?.count || 0);
      const nextRetryAt = get(this.db, `SELECT MIN(next_attempt_at) value FROM evolution_evidence_outbox
        WHERE (?='' OR local_user_id=?) AND status IN ('deferred','failed_retryable') AND next_attempt_at<>''`, [
        cleanLocalUserId,cleanLocalUserId,
      ])?.value || '';
      const deferredReasons = Object.fromEntries(all(this.db, `SELECT defer_reason,COUNT(*) count FROM evolution_evidence_outbox
        WHERE (?='' OR local_user_id=?) AND status='deferred' AND defer_reason<>'' GROUP BY defer_reason`, [
        cleanLocalUserId,cleanLocalUserId,
      ]).map((row) => [row.defer_reason, Number(row.count || 0)]));
      return { currentAccount, otherAccountsPending, permanentlyBlocked, nextRetryAt, deferredReasons };
    },
  });
}

export function stableOutboxId(input = {}) {
  return `evout_${crypto.createHash('sha256').update([
    input.localUserId || '',input.userAgentInstanceId || '',input.sourceKind || '',input.sourceId || '',
    input.sourceVersionId || '',input.contentHash || '',
  ].join('\n')).digest('hex')}`;
}

export function recordMemoryVersionEvidenceOutbox(store, { documentId = '', versionId = '' } = {}) {
  const document = get(store.db, 'SELECT * FROM memory_documents WHERE id=?', [documentId]);
  const version = get(store.db, 'SELECT * FROM memory_document_versions WHERE id=? AND memory_document_id=?', [versionId, documentId]);
  if (!document || !version) throw new Error('Memory Evidence outbox source was not found.');
  const instance = store.getUserAgentInstance?.(document.user_agent_instance_id);
  if (!instance || instance.userId !== document.user_id || instance.agentFamilyId !== document.agent_family_id) {
    throw new Error('Memory Evidence outbox identity does not match its Agent instance.');
  }
  const encrypted = Boolean(version.encryption_algorithm);
  const visibility = version.visibility || document.visibility || 'agent_private';
  const sourceKind = visibility === 'work_summary' ? 'task_shared_summary' : 'memory_version';
  if (sourceKind === 'task_shared_summary' && (document.scope !== 'task' || !document.task_run_id)) {
    throw new Error('Task shared summary Evidence requires a task-scoped Memory document.');
  }
  return store.recordEvolutionEvidenceOutbox({
    localUserId: document.user_id,
    userAgentInstanceId: document.user_agent_instance_id,
    agentFamilyId: document.agent_family_id,
    sourceKind,
    sourceId: document.id,
    sourceVersionId: version.id,
    contentHash: version.content_hash,
    contextSpaceId: document.context_space_id || '',
    taskRunId: document.task_run_id || '',
    delegationId: document.delegation_id || '',
    confidence: 1,
    privacyLevel: !version.privacy_level || version.privacy_level === 'private' ? 'owner_private' : version.privacy_level,
    createdAt: version.created_at || nowIso(),
    snapshot: {
      memoryDocumentId: document.id,
      memoryDocumentVersionId: version.id,
      cloudKey: document.cloud_key || '',
      scope: document.scope,
      slotNo: Number(document.slot_no || 0),
      taskRunId: document.task_run_id || '',
      projectId: document.project_id || '',
      relationshipId: document.relationship_id || '',
      relationshipUserId: document.relationship_user_id || '',
      contextSpaceId: document.context_space_id || '',
      visibility,
      syncEnabled: Boolean(document.sync_enabled),
      allowPersonalEvolution: Boolean(document.allow_personal_evolution),
      allowClusterEvolution: Boolean(document.allow_cluster_evolution),
      versionNo: Number(version.version_no || 0),
      sourceKind: version.source_kind || '',
      sourceId: version.source_id || '',
      reviewStatus: version.review_status || '',
      createdBy: version.created_by || '',
      occurredAt: version.created_at || nowIso(),
      ...(encrypted ? {
        encryptedSource: {
          memoryDocumentId: document.id,
          memoryDocumentVersionId: version.id,
          algorithm: version.encryption_algorithm,
          keyId: version.encryption_key_id || '',
          keyVersion: Number(version.encryption_key_version || 0),
        },
      } : { content: version.content || '' }),
    },
  });
}

function normalizeOutboxInput(input = {}) {
  const sourceKind = normalizeEvolutionEvidenceSourceKind(input.sourceKind || input.source_kind);
  const normalized = {
    localUserId: String(input.localUserId || input.local_user_id || '').trim(),
    userAgentInstanceId: String(input.userAgentInstanceId || input.user_agent_instance_id || '').trim(),
    agentFamilyId: String(input.agentFamilyId || input.agent_family_id || '').trim(),
    sourceKind,
    sourceId: String(input.sourceId || input.source_id || '').trim(),
    sourceVersionId: String(input.sourceVersionId || input.source_version_id || '').trim(),
    lineageKey: String(input.lineageKey || input.lineage_key || `${sourceKind}:${input.sourceId || input.source_id || ''}:${input.sourceVersionId || input.source_version_id || ''}`).trim(),
    contentHash: String(input.contentHash || input.content_hash || '').trim(),
    contextSpaceId: String(input.contextSpaceId || input.context_space_id || ''),
    taskRunId: String(input.taskRunId || input.task_run_id || ''),
    delegationId: String(input.delegationId || input.delegation_id || ''),
    confidence: Math.min(1, Math.max(0, Number(input.confidence ?? 1))),
    privacyLevel: String(input.privacyLevel || input.privacy_level || 'owner_private'),
    snapshot: input.snapshot && typeof input.snapshot === 'object' ? input.snapshot : {},
    createdAt: String(input.createdAt || input.created_at || nowIso()),
  };
  if (!normalized.localUserId || !normalized.userAgentInstanceId || !normalized.agentFamilyId) throw new Error('Evolution Evidence outbox requires local user and Agent identity.');
  if (!normalized.sourceId || !normalized.contentHash) throw new Error('Evolution Evidence outbox requires source identity and content hash.');
  if (['memory_version', 'task_shared_summary'].includes(sourceKind) && !normalized.sourceVersionId) {
    throw new Error('Memory Evidence outbox requires a source version ID.');
  }
  return normalized;
}

function normalizeOutboxRow(row) {
  if (!row) return null;
  let snapshot = {};
  try { snapshot = JSON.parse(row.snapshot_json || '{}'); } catch { snapshot = {}; }
  return {
    outboxId: row.outbox_id,localUserId: row.local_user_id,userAgentInstanceId: row.user_agent_instance_id,
    agentFamilyId: row.agent_family_id,sourceKind: row.source_kind,sourceId: row.source_id,
    sourceVersionId: row.source_version_id,lineageKey: row.lineage_key || '',contentHash: row.content_hash,contextSpaceId: row.context_space_id,
    taskRunId: row.task_run_id,delegationId: row.delegation_id,confidence: Number(row.confidence || 0),
    privacyLevel: row.privacy_level,snapshot,status: row.status,attemptCount: Number(row.attempt_count || 0),
    claimedBy: row.claimed_by,leaseExpiresAt: row.lease_expires_at,nextAttemptAt: row.next_attempt_at || '',
    deferReason: row.defer_reason || '',remoteEvidenceId: row.remote_evidence_id,
    lastError: row.last_error,uploadedAt: row.uploaded_at,createdAt: row.created_at,updatedAt: row.updated_at,
  };
}

export { CLAIMABLE_OUTBOX_STATES };
