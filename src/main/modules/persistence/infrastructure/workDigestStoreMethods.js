import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso, safeJsonParse } from '../../../utils.js';

export const WORK_DIGEST_JOB_STATUSES = Object.freeze([
  'collecting', 'awaiting_owner_supplement', 'draft_ready', 'published', 'failed', 'cancelled',
]);

export function installWorkDigestStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureWorkDigestJob({ delegationId = '', ownerUserId = '', workspaceId = '', spec = {}, expiresAt = '' } = {}) {
      if (!delegationId || !ownerUserId) throw workDigestError('work_digest_identity_required');
      const existing = this.getWorkDigestJob({ delegationId });
      if (existing) return existing;
      const now = nowIso();
      run(this.db, `INSERT INTO work_digest_jobs(
        id,delegation_id,owner_user_id,account_workspace_id,status,spec_json,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?, 'collecting',?,?,?,?)`, [
        newId('work_digest'), delegationId, ownerUserId, workspaceId || 'workspace_personal',
        JSON.stringify(spec || {}), expiresAt, now, now,
      ]);
      return this.getWorkDigestJob({ delegationId });
    },

    getWorkDigestJob({ id = '', delegationId = '' } = {}) {
      if (!id && !delegationId) return null;
      const row = get(this.db, `SELECT * FROM work_digest_jobs WHERE ${id ? 'id=?' : 'delegation_id=?'}`, [id || delegationId]);
      return normalizeWorkDigestJob(row, this);
    },

    listWorkDigestJobs({ ownerUserId = '', statuses = [], dueBefore = '', limit = 100 } = {}) {
      const where = [];
      const params = [];
      if (ownerUserId) { where.push('owner_user_id=?'); params.push(ownerUserId); }
      const cleanStatuses = [...new Set((Array.isArray(statuses) ? statuses : []).filter((item) => WORK_DIGEST_JOB_STATUSES.includes(item)))];
      if (cleanStatuses.length) {
        where.push(`status IN (${cleanStatuses.map(() => '?').join(',')})`);
        params.push(...cleanStatuses);
      }
      if (dueBefore) { where.push("expires_at<>'' AND expires_at<=?"); params.push(dueBefore); }
      params.push(Math.max(1, Math.min(500, Number(limit || 100))));
      return all(this.db, `SELECT * FROM work_digest_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at ASC,id ASC LIMIT ?`, params).map((row) => normalizeWorkDigestJob(row, this));
    },

    updateWorkDigestJob({ id = '', status = '', coverage = null, expiresAt, publishedAt, lastError } = {}) {
      const current = this.getWorkDigestJob({ id });
      if (!current) return null;
      if (status && !WORK_DIGEST_JOB_STATUSES.includes(status)) throw workDigestError('work_digest_status_invalid');
      const fields = ['updated_at=?'];
      const params = [nowIso()];
      for (const [column, value] of [
        ['status', status], ['coverage_json', coverage == null ? undefined : JSON.stringify(coverage)],
        ['expires_at', expiresAt], ['published_at', publishedAt], ['last_error', lastError],
      ]) {
        if (value === undefined || value === '') continue;
        fields.push(`${column}=?`); params.push(String(value));
      }
      params.push(id);
      run(this.db, `UPDATE work_digest_jobs SET ${fields.join(',')} WHERE id=?`, params);
      return this.getWorkDigestJob({ id });
    },

    saveWorkDigestVersion({
      jobId = '', body = '', evidence = [], coverage = {}, state = 'draft', sourceKind = 'codex',
      updateJobStatus = true,
    } = {}) {
      const job = this.getWorkDigestJob({ id: jobId });
      if (!job) throw workDigestError('work_digest_job_missing');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        const nextRevision = Number(get(this.db, 'SELECT MAX(revision_no) AS value FROM work_digest_versions WHERE job_id=?', [jobId])?.value || 0) + 1;
        const now = nowIso();
        const versionId = newId('work_digest_version');
        const evidenceHash = stableEvidenceHash(evidence);
        run(this.db, `UPDATE work_digest_versions SET state='superseded' WHERE job_id=? AND state='draft'`, [jobId]);
        run(this.db, `INSERT INTO work_digest_versions(
          id,job_id,revision_no,state,body,evidence_hash,coverage_json,source_kind,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`, [
          versionId, jobId, nextRevision, state, String(body || '').slice(0, 12000), evidenceHash,
          JSON.stringify(coverage || {}), sourceKind, now, now,
        ]);
        for (const [index, item] of (Array.isArray(evidence) ? evidence : []).slice(0, 500).entries()) {
          run(this.db, `INSERT INTO work_digest_evidence_refs(
            id,version_id,source_kind,source_id,source_revision,included,position,evidence_json,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?)`, [
            newId('work_digest_evidence'), versionId, String(item.sourceKind || ''), String(item.sourceId || item.id || ''),
            String(item.sourceRevision || ''), item.included === false ? 0 : 1, index,
            JSON.stringify(publicEvidence(item)), now,
          ]);
        }
        if (updateJobStatus) {
          this.updateWorkDigestJob({ id: jobId, status: state === 'published' ? 'published' : 'draft_ready', coverage });
        }
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.getWorkDigestVersion(versionId);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },

    getWorkDigestVersion(id = '') {
      const row = get(this.db, 'SELECT * FROM work_digest_versions WHERE id=?', [id]);
      return normalizeWorkDigestVersion(row, this);
    },

    latestWorkDigestVersion({ jobId = '', states = [] } = {}) {
      const clean = (Array.isArray(states) ? states : []).filter(Boolean);
      const row = get(this.db, `SELECT * FROM work_digest_versions WHERE job_id=?${clean.length ? ` AND state IN (${clean.map(() => '?').join(',')})` : ''}
        ORDER BY revision_no DESC LIMIT 1`, [jobId, ...clean]);
      return normalizeWorkDigestVersion(row, this);
    },

    markWorkDigestPublished({ jobId = '', versionId = '' } = {}) {
      const now = nowIso();
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `UPDATE work_digest_versions SET state='published',published_at=?,updated_at=? WHERE id=? AND job_id=?`, [now, now, versionId, jobId]);
        this.updateWorkDigestJob({ id: jobId, status: 'published', publishedAt: now });
        if (ownsTransaction) this.db.exec('COMMIT');
        return this.getWorkDigestVersion(versionId);
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    },
  });
}

function normalizeWorkDigestJob(row, store) {
  if (!row) return null;
  return {
    id: row.id, delegationId: row.delegation_id, ownerUserId: row.owner_user_id,
    workspaceId: row.account_workspace_id, status: row.status, spec: safeJsonParse(row.spec_json, {}),
    coverage: safeJsonParse(row.coverage_json, {}), expiresAt: row.expires_at || '', lastError: row.last_error || '',
    createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at || '',
    latestVersion: store?.latestWorkDigestVersion ? store.latestWorkDigestVersion({ jobId: row.id }) : null,
  };
}

function normalizeWorkDigestVersion(row, store) {
  if (!row) return null;
  const evidence = store ? all(store.db, 'SELECT * FROM work_digest_evidence_refs WHERE version_id=? ORDER BY position,id', [row.id]) : [];
  return {
    id: row.id, jobId: row.job_id, revisionNo: Number(row.revision_no || 0), state: row.state,
    body: row.body || '', evidenceHash: row.evidence_hash || '', coverage: safeJsonParse(row.coverage_json, {}),
    sourceKind: row.source_kind || '', evidence: evidence.map((item) => ({
      id: item.id, sourceKind: item.source_kind, sourceId: item.source_id, sourceRevision: item.source_revision,
      included: Boolean(item.included), position: Number(item.position || 0), ...safeJsonParse(item.evidence_json, {}),
    })), createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at || '',
  };
}

function publicEvidence(value = {}) {
  return {
    title: String(value.title || '').slice(0, 300), status: String(value.status || '').slice(0, 80),
    summary: String(value.summary || '').slice(0, 1200), blocker: String(value.blocker || '').slice(0, 600),
    nextStep: String(value.nextStep || '').slice(0, 600), occurredAt: String(value.occurredAt || ''),
    workspaceId: String(value.workspaceId || ''), projectId: String(value.projectId || ''),
    agentId: String(value.agentId || ''), agentInstanceId: String(value.agentInstanceId || ''),
    artifacts: (Array.isArray(value.artifacts) ? value.artifacts : []).map(String).slice(0, 20),
  };
}

function stableEvidenceHash(evidence = []) {
  const canonical = JSON.stringify((Array.isArray(evidence) ? evidence : [])
    .map((item) => [item.sourceKind, item.sourceId || item.id, item.sourceRevision, item.included !== false]));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function workDigestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
