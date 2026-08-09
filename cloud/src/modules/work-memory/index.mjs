import crypto from 'node:crypto';
import { leadershipAssignmentEligibility } from '../../../../src/shared/evolution/leadership.js';

import {
  cloudTaskMemoryPrivateKeyringFromEnv,
  decryptTaskMemoryContent,
  unwrapTaskKeyFromCloud,
} from '../../../../src/shared/taskMemoryCrypto.js';

const WORK_VISIBILITIES = new Set(['work_collaborators', 'work_leadership', 'work_participants', 'work_summary']);
const LEADERSHIP_ROLES = new Set(['task_lead', 'team_lead', 'cross_team_lead']);

export function registerWorkMemoryRoutes({ app, pool, auth, route, apiError, env = process.env }) {
  const service = createPostgresWorkMemoryService({ pool, apiError, env });
  app.post('/api/work-memory/publications', auth, route(async (req, res) => {
    res.status(201).json(await service.publish({ userId: req.auth.user.id, payload: req.body || {} }));
  }));
  app.post('/api/work-memory/appointments', auth, route(async (req, res) => {
    res.status(201).json(await service.appoint({ userId: req.auth.user.id, payload: req.body || {} }));
  }));
  app.post('/api/work-memory/appointments/revoke', auth, route(async (req, res) => {
    res.json(await service.revoke({ userId: req.auth.user.id, payload: req.body || {} }));
  }));
  app.post('/api/work-memory/read', auth, route(async (req, res) => {
    res.json(await service.read({ userId: req.auth.user.id, payload: req.body || {} }));
  }));
  return service;
}

export function createPostgresWorkMemoryService({ pool, apiError = defaultApiError, env = process.env } = {}) {
  if (!pool) throw new Error('PostgreSQL Work Memory service requires a pool.');
  const keyring = cloudTaskMemoryPrivateKeyringFromEnv(env);

  return {
    async publish({ userId = '', payload = {} } = {}) {
      const federation = normalizeFederation(payload);
      const membership = await requireFederationMembership(pool, federation, userId, apiError);
      const version = normalizePublication(payload.version || payload);
      if (!membershipValidAt(membership, version.publishedAt)) {
        throw apiError('publisher_outside_membership_window', 'Publisher was not a work member when this version was published.', 403);
      }
      const agent = await requireOwnedAgent(pool, userId, version.agentInstanceId, apiError);
      const scope = await ensureScope(pool, federation, membership.ownerUserId);
      await upsertParticipant(pool, {
        workScopeId: scope.id,
        userId,
        agentInstanceId: agent.id,
        agentFamilyId: agent.agent_family_id || '',
        role: normalizeRole(payload.participant?.role || 'executor'),
        collaborationEdges: payload.participant?.collaborationAgentInstanceIds || [],
        validFrom: membership.validFrom,
        validUntil: membership.validUntil,
      });
      await pool.query(`INSERT INTO cloud_work_memory_versions (
        id,work_scope_id,owner_user_id,agent_instance_id,memory_document_id,memory_document_version_id,
        version_no,visibility,content_hash,source_cursor,encryption_algorithm,encryption_key_version,
        content_ciphertext,content_nonce,content_tag,content_aad,cloud_wrap_algorithm,
        cloud_wrapping_key_id,cloud_wrapped_key,published_at,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now())
      ON CONFLICT(owner_user_id,memory_document_version_id) DO UPDATE SET
        work_scope_id=excluded.work_scope_id,agent_instance_id=excluded.agent_instance_id,
        visibility=excluded.visibility,content_hash=excluded.content_hash,source_cursor=excluded.source_cursor,
        content_ciphertext=excluded.content_ciphertext,content_nonce=excluded.content_nonce,
        content_tag=excluded.content_tag,content_aad=excluded.content_aad,
        cloud_wrap_algorithm=excluded.cloud_wrap_algorithm,cloud_wrapping_key_id=excluded.cloud_wrapping_key_id,
        cloud_wrapped_key=excluded.cloud_wrapped_key,published_at=excluded.published_at`, [
        version.id, scope.id, userId, agent.id, version.memoryDocumentId, version.memoryDocumentVersionId,
        version.versionNo, version.visibility, version.contentHash, version.sourceCursor,
        version.encryptionAlgorithm, version.encryptionKeyVersion, version.contentCiphertext,
        version.contentNonce, version.contentTag, version.contentAad, version.cloudWrapAlgorithm,
        version.cloudWrappingKeyId, version.cloudWrappedKey, version.publishedAt,
      ]);
      return { status: 'published', workScopeId: scope.id, memoryDocumentVersionId: version.memoryDocumentVersionId, visibility: version.visibility };
    },

    async appoint({ userId = '', payload = {} } = {}) {
      const federation = normalizeFederation(payload);
      const membership = await requireFederationMembership(pool, federation, userId, apiError);
      if (membership.ownerUserId !== userId) throw apiError('work_leadership_appointment_forbidden', 'Only the federated work owner may appoint leaders.', 403);
      const scope = await ensureScope(pool, federation, membership.ownerUserId);
      const targetUserId = String(payload.targetUserId || '').trim();
      const targetAgentInstanceId = String(payload.targetAgentInstanceId || '').trim();
      const role = normalizeLeadershipRole(payload.role);
      const targetMembership = await requireFederationMembership(pool, federation, targetUserId, apiError);
      const targetAgent = await requireOwnedAgent(pool, targetUserId, targetAgentInstanceId, apiError);
      const leadership = (await pool.query('SELECT * FROM cloud_agent_leadership_levels WHERE owner_user_id=$1 AND user_agent_instance_id=$2', [targetUserId, targetAgent.id])).rows[0];
      let leadershipEligibility = null;
      if (leadership) {
        const performance = (await pool.query('SELECT * FROM cloud_agent_performance_levels WHERE user_agent_instance_id=$1', [targetAgent.id])).rows[0] || {};
        const approvedTrial = String(payload.assignmentMode || '') === 'trial'
          ? (await pool.query("SELECT id FROM cloud_leadership_promotion_actions WHERE id=$1 AND owner_user_id=$2 AND user_agent_instance_id=$3 AND action='trial_approved' AND status='approved' AND evidence_snapshot_json->>'role'=$4", [payload.assignmentId || '', targetUserId, targetAgent.id, role])).rows[0]
          : null;
        const activeTaskGroups = Number((await pool.query(`SELECT COUNT(DISTINCT a.work_scope_id)::int AS count FROM cloud_leadership_assignments a
          JOIN cloud_work_scopes s ON s.id=a.work_scope_id WHERE a.agent_instance_id=$1 AND a.status='active' AND s.status='active'
          AND (a.valid_until IS NULL OR a.valid_until>now())`, [targetAgent.id])).rows[0]?.count || 0);
        leadershipEligibility = leadershipAssignmentEligibility({ level: leadership.level, status: leadership.status, role,
          assignmentMode: payload.assignmentMode, participantCount: Number(payload.participantCount || 1), nodeCount: Number(payload.nodeCount || 1),
          taskGroupCount: Number(payload.taskGroupCount || 1), departmentCount: Number(payload.departmentCount || 1),
          activeTaskGroups, ownerApproved: String(payload.assignmentMode || '') !== 'trial' || Boolean(approvedTrial),
          governanceApproved: String(payload.assignmentMode || '') !== 'trial' || Boolean(approvedTrial), professionalLevel: performance.level || '', professionalProvisional: performance.provisional !== false });
        if (!leadershipEligibility.eligible) throw apiError('leadership_assignment_ineligible', `Leadership assignment is not eligible: ${leadershipEligibility.reasons.join(', ')}`, 409);
      }
      const now = new Date().toISOString();
      if (!membershipValidAt(targetMembership, payload.validFrom || now)) {
        throw apiError('leader_outside_membership_window', 'Leader appointment is outside the target work membership window.', 403);
      }
      await upsertParticipant(pool, {
        workScopeId: scope.id, userId: targetUserId, agentInstanceId: targetAgent.id,
        agentFamilyId: targetAgent.agent_family_id || '', role,
        validFrom: payload.validFrom || targetMembership.validFrom,
        validUntil: targetMembership.validUntil,
      });
      const id = String(payload.assignmentId || `worklead_${crypto.randomUUID()}`).trim().slice(0, 200);
      await pool.query(`UPDATE cloud_leadership_assignments SET status='revoked',
        valid_until=CASE WHEN valid_until IS NULL OR valid_until>$1 THEN $1 ELSE valid_until END,updated_at=now()
        WHERE work_scope_id=$2 AND user_id=$3 AND agent_instance_id=$4 AND status IN ('active','draining') AND id!=$5`, [now, scope.id, targetUserId, targetAgent.id, id]);
      await pool.query(`INSERT INTO cloud_leadership_assignments (
        id,work_scope_id,user_id,agent_instance_id,role,leadership_level_snapshot,
        assignment_mode,limit_snapshot_json,permission_snapshot_json,appointed_by_user_id,valid_from,valid_until,status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,'active')
      ON CONFLICT(id) DO UPDATE SET work_scope_id=excluded.work_scope_id,user_id=excluded.user_id,
        agent_instance_id=excluded.agent_instance_id,role=excluded.role,
        leadership_level_snapshot=excluded.leadership_level_snapshot,
        assignment_mode=excluded.assignment_mode,limit_snapshot_json=excluded.limit_snapshot_json,
        permission_snapshot_json=excluded.permission_snapshot_json,
        appointed_by_user_id=excluded.appointed_by_user_id,valid_from=excluded.valid_from,
        valid_until=excluded.valid_until,status='active',updated_at=now()`, [
        id, scope.id, targetUserId, targetAgent.id, role, String(leadership?.level || payload.leadershipLevelSnapshot || ''),
        String(payload.assignmentMode || '') === 'trial' ? 'trial' : 'normal', JSON.stringify(leadershipEligibility?.caps || payload.limitSnapshot || {}),
        JSON.stringify(payload.permissionSnapshot || {}), userId, payload.validFrom || now, payload.validUntil || null,
      ]);
      return { status: 'appointed', id, workScopeId: scope.id, targetUserId, targetAgentInstanceId: targetAgent.id, role,
        assignmentMode: String(payload.assignmentMode || '') === 'trial' ? 'trial' : 'normal' };
    },

    async revoke({ userId = '', payload = {} } = {}) {
      const federation = normalizeFederation(payload);
      const membership = await requireFederationMembership(pool, federation, userId, apiError);
      if (membership.ownerUserId !== userId) throw apiError('work_leadership_revocation_forbidden', 'Only the federated work owner may revoke leaders.', 403);
      const targetUserId = String(payload.targetUserId || '').trim();
      const targetAgentInstanceId = String(payload.targetAgentInstanceId || '').trim();
      await requireFederationMembership(pool, federation, targetUserId, apiError);
      const targetAgent = await requireOwnedAgent(pool, targetUserId, targetAgentInstanceId, apiError);
      const revokedAt = validTimestamp(payload.revokedAt) || new Date().toISOString();
      const scope = await ensureScope(pool, federation, membership.ownerUserId);
      const result = await pool.query(`UPDATE cloud_leadership_assignments SET status='revoked',
        valid_until=CASE WHEN valid_until IS NULL OR valid_until>$1 THEN $1 ELSE valid_until END,updated_at=now()
        WHERE work_scope_id=$2 AND user_id=$3 AND agent_instance_id=$4 AND status IN ('active','draining')`, [
        revokedAt, scope.id, targetUserId, targetAgent.id,
      ]);
      return {
        status: 'revoked',
        workScopeId: scope.id,
        targetUserId,
        targetAgentInstanceId: targetAgent.id,
        revokedAt,
        revokedCount: Number(result.rowCount || 0),
      };
    },

    async read({ userId = '', payload = {} } = {}) {
      const audit = {
        requesterUserId: userId,
        requesterAgentInstanceId: String(payload.requesterAgentInstanceId || ''),
        targetAgentInstanceId: String(payload.targetAgentInstanceId || ''),
        workScopeId: '',
        memoryDocumentVersionId: String(payload.memoryDocumentVersionId || ''),
        reason: String(payload.reason || ''),
      };
      try {
        const federation = normalizeFederation(payload);
        const membership = await requireFederationMembership(pool, federation, userId, apiError);
        const scope = await ensureScope(pool, federation, membership.ownerUserId);
        audit.workScopeId = scope.id;
        const requester = await requireOwnedAgent(pool, userId, audit.requesterAgentInstanceId, apiError);
        await upsertParticipant(pool, {
          workScopeId: scope.id, userId, agentInstanceId: requester.id,
          agentFamilyId: requester.agent_family_id || '', role: 'executor', validFrom: membership.validFrom,
          validUntil: membership.validUntil,
        });
        const memoryDocumentId = String(payload.memoryDocumentId || '');
        const versionResult = await pool.query(`SELECT * FROM cloud_work_memory_versions
          WHERE work_scope_id=$1 AND agent_instance_id=$2
            AND ($3='' OR memory_document_id=$3)
            AND ($4='' OR memory_document_version_id=$4)
          ORDER BY published_at DESC LIMIT 1`, [scope.id, audit.targetAgentInstanceId, memoryDocumentId, audit.memoryDocumentVersionId]);
        const version = versionResult.rows[0];
        if (!version) throw apiError('work_memory_version_not_found', 'Published work Memory version was not found.', 404);
        audit.memoryDocumentVersionId = version.memory_document_version_id;
        audit.targetUserId = version.owner_user_id;
        const requesterParticipant = (await pool.query(`SELECT * FROM cloud_work_participants
          WHERE work_scope_id=$1 AND user_id=$2 AND agent_instance_id=$3`, [scope.id, userId, requester.id])).rows[0];
        const targetParticipant = (await pool.query(`SELECT * FROM cloud_work_participants
          WHERE work_scope_id=$1 AND user_id=$2 AND agent_instance_id=$3`, [scope.id, version.owner_user_id, version.agent_instance_id])).rows[0];
        audit.requesterRoleSnapshot = requesterParticipant?.role || '';
        if (!participantValidAt(requesterParticipant, version.published_at)) throw apiError('requester_outside_membership_window', 'Requester was not a work participant when the version was published.', 403);
        if (!participantValidAt(targetParticipant, version.published_at)) throw apiError('target_outside_membership_window', 'Target was not a work participant when the version was published.', 403);
        const leadership = (await pool.query(`SELECT * FROM cloud_leadership_assignments
          WHERE work_scope_id=$1 AND user_id=$2 AND agent_instance_id=$3 AND valid_from<=$4
            AND (valid_until IS NULL OR valid_until>=$4) AND status IN ('active','draining','revoked')
          ORDER BY valid_from DESC,created_at DESC LIMIT 1`, [scope.id, userId, requester.id, version.published_at])).rows[0];
        if (leadership) {
          const currentLeadership = (await pool.query('SELECT status,level FROM cloud_agent_leadership_levels WHERE owner_user_id=$1 AND user_agent_instance_id=$2',
            [userId, requester.id])).rows[0];
          if (currentLeadership && currentLeadership.status !== 'active') throw apiError('leadership_not_active', 'Current Leadership authority is not active.', 403);
          if (currentLeadership && leadershipLevelNumber(currentLeadership.level) < leadershipLevelNumber(leadership.leadership_level_snapshot)
            && (leadership.status !== 'draining' || !leadership.valid_until || new Date(leadership.valid_until).getTime() < Date.now())) {
            throw apiError('leadership_draining_expired', 'Leadership draining window has expired.', 403);
          }
        }
        audit.leadership = leadership || null;
        authorizeCloudVisibility({
          visibility: version.visibility,
          federation,
          requesterParticipant,
          targetParticipant,
          leadership,
          reason: audit.reason,
          apiError,
        });
        const dataKey = unwrapTaskKeyFromCloud({
          algorithm: version.cloud_wrap_algorithm,
          keyId: version.cloud_wrapping_key_id,
          wrappedKey: version.cloud_wrapped_key,
        }, keyring);
        const content = decryptTaskMemoryContent({
          algorithm: version.encryption_algorithm,
          ciphertext: version.content_ciphertext,
          nonce: version.content_nonce,
          tag: version.content_tag,
          aad: version.content_aad,
        }, dataKey);
        await recordAudit(pool, { ...audit, result: 'allowed', resultCode: 'ALLOWED' });
        return {
          workScopeId: scope.id,
          targetUserId: version.owner_user_id,
          targetAgentInstanceId: version.agent_instance_id,
          memoryDocumentId: version.memory_document_id,
          memoryDocumentVersionId: version.memory_document_version_id,
          versionNo: Number(version.version_no || 0),
          visibility: version.visibility,
          content,
          contentHash: version.content_hash || '',
          sourceCursor: version.source_cursor || '',
          publishedAt: toIso(version.published_at),
        };
      } catch (error) {
        await recordAudit(pool, { ...audit, result: 'denied', resultCode: error?.code || 'work_memory_access_denied' });
        throw error;
      }
    },
  };
}

async function requireFederationMembership(pool, federation, userId, apiError) {
  if (!userId) throw apiError('unauthorized', 'Authentication is required.', 401);
  if (federation.type === 'delegation') {
    const row = (await pool.query('SELECT * FROM agent_delegations WHERE id=$1', [federation.id])).rows[0];
    if (!row || ![row.requester_user_id, row.recipient_user_id].includes(userId)) throw apiError('work_scope_not_found', 'Federated work was not found.', 404);
    return { ownerUserId: row.requester_user_id, validFrom: toIso(row.created_at) };
  }
  const group = (await pool.query('SELECT * FROM collaboration_groups WHERE id=$1', [federation.id])).rows[0];
  const member = (await pool.query(`SELECT * FROM collaboration_group_members WHERE group_id=$1 AND user_id=$2`, [federation.id, userId])).rows[0];
  if (!group || !member) throw apiError('work_scope_not_found', 'Federated work was not found.', 404);
  return { ownerUserId: group.owner_user_id, validFrom: toIso(member.joined_at), validUntil: member.left_at ? toIso(member.left_at) : '' };
}

async function requireOwnedAgent(pool, userId, agentInstanceId, apiError) {
  if (!agentInstanceId) throw apiError('agent_id_required', 'Agent instance ID is required.', 400);
  const row = (await pool.query(`SELECT * FROM cloud_user_agent_instances_v3 WHERE user_id=$1 AND id=$2`, [userId, agentInstanceId])).rows[0];
  if (!row) throw apiError('agent_ownership_required', 'Agent instance does not belong to the current user.', 403);
  return row;
}

async function ensureScope(pool, federation, ownerUserId) {
  const id = `work:${federation.type}:${federation.id}`;
  await pool.query(`INSERT INTO cloud_work_scopes (id,federation_type,federation_id,owner_user_id,status)
    VALUES ($1,$2,$3,$4,'active') ON CONFLICT(federation_type,federation_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,updated_at=now()`, [
    id, federation.type, federation.id, ownerUserId,
  ]);
  return (await pool.query('SELECT * FROM cloud_work_scopes WHERE federation_type=$1 AND federation_id=$2', [federation.type, federation.id])).rows[0];
}

async function upsertParticipant(pool, input) {
  const status = input.validUntil && new Date(input.validUntil).getTime() < Date.now() ? 'removed' : 'active';
  await pool.query(`INSERT INTO cloud_work_participants (
    work_scope_id,user_id,agent_instance_id,agent_family_id,role,collaboration_edges_json,
    valid_from,valid_until,status,created_at,updated_at
  ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,now(),now())
  ON CONFLICT(work_scope_id,user_id,agent_instance_id) DO UPDATE SET
    agent_family_id=excluded.agent_family_id,
    role=CASE WHEN cloud_work_participants.role IN ('task_lead','team_lead','cross_team_lead') THEN cloud_work_participants.role ELSE excluded.role END,
    collaboration_edges_json=CASE WHEN excluded.collaboration_edges_json='[]'::jsonb THEN cloud_work_participants.collaboration_edges_json ELSE excluded.collaboration_edges_json END,
    valid_until=excluded.valid_until,status=excluded.status,updated_at=now()`, [
    input.workScopeId, input.userId, input.agentInstanceId, input.agentFamilyId || '', input.role,
    JSON.stringify(normalizeIds(input.collaborationEdges)), input.validFrom || new Date().toISOString(), input.validUntil || null, status,
  ]);
}

function normalizeFederation(payload) {
  const type = String(payload.federationType || payload.federation_type || '').trim().toLowerCase();
  const id = String(payload.federationId || payload.federation_id || '').trim();
  if (!['delegation', 'collaboration_group'].includes(type) || !id) throw defaultApiError('work_federation_required', 'A delegation or collaboration-group federation key is required.', 400);
  return { type, id };
}

function validTimestamp(value) {
  const text = String(value || '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}

function normalizePublication(value) {
  const visibility = String(value.visibility || '').trim().toLowerCase();
  if (!WORK_VISIBILITIES.has(visibility)) throw defaultApiError('invalid_work_visibility', 'Only work-visible Memory versions may be published.', 400);
  const result = {
    id: String(value.id || `workmem_${crypto.randomUUID()}`),
    agentInstanceId: String(value.agentInstanceId || value.agent_instance_id || ''),
    memoryDocumentId: String(value.memoryDocumentId || value.memory_document_id || ''),
    memoryDocumentVersionId: String(value.memoryDocumentVersionId || value.memory_document_version_id || ''),
    versionNo: Number(value.versionNo || value.version_no || 1),
    visibility,
    contentHash: String(value.contentHash || value.content_hash || ''),
    sourceCursor: String(value.sourceCursor || value.source_cursor || ''),
    encryptionAlgorithm: String(value.encryptionAlgorithm || value.encryption_algorithm || ''),
    encryptionKeyVersion: Number(value.encryptionKeyVersion || value.encryption_key_version || 1),
    contentCiphertext: String(value.contentCiphertext || value.content_ciphertext || ''),
    contentNonce: String(value.contentNonce || value.content_nonce || ''),
    contentTag: String(value.contentTag || value.content_tag || ''),
    contentAad: String(value.contentAad || value.content_aad || ''),
    cloudWrapAlgorithm: String(value.cloudWrapAlgorithm || value.cloud_wrap_algorithm || ''),
    cloudWrappingKeyId: String(value.cloudWrappingKeyId || value.cloud_wrapping_key_id || ''),
    cloudWrappedKey: String(value.cloudWrappedKey || value.cloud_wrapped_key || ''),
    publishedAt: String(value.publishedAt || value.published_at || ''),
  };
  for (const key of ['agentInstanceId', 'memoryDocumentId', 'memoryDocumentVersionId', 'encryptionAlgorithm', 'contentCiphertext', 'contentNonce', 'contentTag', 'cloudWrapAlgorithm', 'cloudWrappingKeyId', 'cloudWrappedKey', 'publishedAt']) {
    if (!result[key]) throw defaultApiError('work_publication_incomplete', `Work Memory publication is missing ${key}.`, 400);
  }
  if (!Number.isFinite(new Date(result.publishedAt).getTime())) throw defaultApiError('work_publication_invalid_time', 'Work Memory publication time is invalid.', 400);
  return result;
}

function authorizeCloudVisibility({ visibility, federation, requesterParticipant, targetParticipant, leadership, reason, apiError }) {
  if (leadership) {
    if (leadership.role === 'cross_team_lead' && visibility !== 'work_summary' && !String(reason || '').trim()) throw apiError('access_reason_required', 'Cross-team detail reads require a reason.', 400);
    return;
  }
  if (visibility === 'work_leadership') throw apiError('leadership_appointment_required', 'A valid work leadership appointment is required.', 403);
  if (visibility === 'work_collaborators') {
    const edges = new Set(jsonArray(requesterParticipant?.collaboration_edges_json));
    const directDelegation = federation.type === 'delegation' && requesterParticipant?.user_id !== targetParticipant?.user_id;
    if (!directDelegation && !edges.has(targetParticipant?.agent_instance_id)) throw apiError('not_direct_collaborator', 'Requester is not a direct collaborator.', 403);
  }
}

function participantValidAt(row, at) {
  if (!row) return false;
  const time = new Date(at).getTime();
  const from = new Date(row.valid_from).getTime();
  const until = row.valid_until ? new Date(row.valid_until).getTime() : Infinity;
  return Number.isFinite(time) && from <= time && time <= until;
}

function membershipValidAt(row, at) {
  if (!row) return false;
  const time = new Date(at).getTime();
  const from = new Date(row.validFrom).getTime();
  const until = row.validUntil ? new Date(row.validUntil).getTime() : Infinity;
  return Number.isFinite(time) && Number.isFinite(from) && from <= time && time <= until;
}

async function recordAudit(pool, input) {
  try {
    await pool.query(`INSERT INTO cloud_work_memory_access_audits (
      id,requester_user_id,requester_agent_instance_id,target_user_id,target_agent_instance_id,
      work_scope_id,memory_document_version_id,requested_reason,requester_role_snapshot,
      leadership_assignment_snapshot_json,result,result_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [
      `workmemaudit_${crypto.randomUUID()}`, input.requesterUserId, input.requesterAgentInstanceId || '',
      input.targetUserId || '', input.targetAgentInstanceId || '', input.workScopeId || '',
      input.memoryDocumentVersionId || '', String(input.reason || '').slice(0, 1000),
      input.requesterRoleSnapshot || '', JSON.stringify(input.leadership || {}), input.result, input.resultCode,
    ]);
  } catch {}
}

function normalizeRole(value) {
  const role = String(value || 'executor').trim().toLowerCase();
  return ['executor', 'task_lead', 'team_lead', 'cross_team_lead', 'observer', 'auditor'].includes(role) ? role : 'executor';
}

function normalizeLeadershipRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!LEADERSHIP_ROLES.has(role)) throw defaultApiError('invalid_leadership_role', 'Invalid work leadership role.', 400);
  return role;
}
function leadershipLevelNumber(value = 'L0') { return Math.max(0, Math.min(3, Number(String(value || 'L0').replace(/^L/i, '')) || 0)); }

function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].sort();
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : String(value || '');
}

function defaultApiError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
