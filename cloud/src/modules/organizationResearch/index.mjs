import crypto from 'node:crypto';

import { apiError } from '../../errors.mjs';
import { inTransaction } from '../../db.mjs';
import { route } from '../../../../network/server/express.js';

export const ORGANIZATION_RESEARCH_CAPABILITY = 'organization-message-research-v1';
export const ORGANIZATION_RESEARCH_MINIMUM_CLIENT_VERSION = '1.0.0';
export const ORGANIZATION_RESEARCH_LEASE_MS = 24 * 60 * 60 * 1000;
const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

export function registerOrganizationResearchRoutes({ app, pool, auth } = {}) {
  app.get('/api/organizations/:organizationId/research/policy', auth, route(async (req, res) => {
    const membership = await requireMembership(pool, req.params.organizationId, req.auth.user.id);
    const policy = await one(pool, 'SELECT * FROM organization_research_policies WHERE organization_id=$1', [membership.organization_id]);
    res.json({ capability: ORGANIZATION_RESEARCH_CAPABILITY, policy: policy ? policyPayload(policy) : null });
  }));

  app.put('/api/organizations/:organizationId/research/policy', auth, route(async (req, res) => {
    requireCapability(req);
    const membership = await requireMembership(pool, req.params.organizationId, req.auth.user.id);
    if (membership.role !== 'owner') throw apiError('organization_owner_required', '只有组织 Owner 可以启用组织消息调查。', 403);
    if (req.body?.confirmed !== true) {
      throw apiError('organization_research_confirmation_required', '启用前必须确认组织消息调查政策。', 400);
    }
    const confirmationHash = crypto.createHash('sha256').update(JSON.stringify({
      capability: ORGANIZATION_RESEARCH_CAPABILITY,
      policyVersion: ORGANIZATION_RESEARCH_CAPABILITY,
      organizationId: membership.organization_id,
      confirmedBy: req.auth.user.id,
      confirmationTextVersion: String(req.body?.confirmationTextVersion || 'v1'),
    })).digest('hex');
    const policy = await inTransaction(pool, async (client) => {
      await client.query('SELECT id FROM contact_organizations WHERE id=$1 FOR UPDATE', [membership.organization_id]);
      const inserted = await client.query(`INSERT INTO organization_research_policies(
          organization_id,status,enabled_at,enabled_by_user_id,policy_version,confirmation_hash,created_at,updated_at
        ) VALUES($1,'enabled',now(),$2,$3,$4,now(),now())
        ON CONFLICT(organization_id) DO NOTHING RETURNING *`, [
        membership.organization_id, req.auth.user.id, ORGANIZATION_RESEARCH_CAPABILITY, confirmationHash,
      ]);
      if (inserted.rows[0]) {
        await client.query(`INSERT INTO contact_organization_notices(
            id,user_id,organization_id,organization_name,type,title,content,created_at
          ) SELECT 'org_research_notice_' || organization.id || '_' || member.user_id,member.user_id,
            organization.id,organization.name,'organization_research_enabled','组织消息调查已启用',
            '组织 Owner 已启用消息调查；仅索引启用后的组织消息，不回填历史，成员不能单独退出索引。',now()
          FROM contact_organizations organization
          JOIN contact_organization_members member ON member.organization_id=organization.id
          WHERE organization.id=$1 ON CONFLICT(id) DO NOTHING`, [membership.organization_id]);
      }
      return inserted.rows[0] || await one(client, 'SELECT * FROM organization_research_policies WHERE organization_id=$1', [membership.organization_id]);
    });
    res.json({ ok: true, policy: policyPayload(policy), historicalBackfill: false });
  }));

  app.post('/api/organizations/:organizationId/research/lease', auth, route(async (req, res) => {
    requireCapability(req);
    assertSupportedClient(req.body?.appVersion);
    const membership = await requireMembership(pool, req.params.organizationId, req.auth.user.id);
    const policy = await requireEnabledPolicy(pool, membership.organization_id);
    const deviceId = String(req.body?.deviceId || '').trim().slice(0, 200);
    if (!deviceId) throw apiError('organization_research_device_required', '缺少设备标识。', 400);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const leaseId = `org_research_lease_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + ORGANIZATION_RESEARCH_LEASE_MS);
    const result = await pool.query(`INSERT INTO organization_research_device_leases(
        id,organization_id,user_id,device_id,lease_token_hash,status,issued_at,expires_at,last_renewed_at
      ) VALUES($1,$2,$3,$4,$5,'active',now(),$6,now())
      ON CONFLICT(organization_id,user_id,device_id) DO UPDATE SET
        id=excluded.id,lease_token_hash=excluded.lease_token_hash,status='active',issued_at=now(),
        expires_at=excluded.expires_at,last_renewed_at=now(),revoked_at=NULL
      RETURNING *`, [leaseId, membership.organization_id, req.auth.user.id, deviceId, tokenHash, expiresAt]);
    res.json({ capability: ORGANIZATION_RESEARCH_CAPABILITY, lease: leasePayload(result.rows[0], token), policy: policyPayload(policy) });
  }));

  app.get('/api/organizations/:organizationId/research/changes', auth, route(async (req, res) => {
    requireCapability(req);
    const access = await requireLease(pool, req, req.params.organizationId);
    const cursor = Math.max(0, Number.parseInt(String(req.query?.cursor || '0'), 10) || 0);
    const limit = Math.max(1, Math.min(500, Number.parseInt(String(req.query?.limit || '200'), 10) || 200));
    const rows = (await pool.query(`SELECT change.sequence_id,change.operation,change.revision,change.occurred_at,
        document.organization_id,document.account_workspace_id,document.source_kind,document.source_message_id,
        document.conversation_id,document.conversation_title,document.sender_user_id,document.sender_display_name,
        document.body,document.attachment_names_json,document.source_created_at,document.source_updated_at,
        document.tombstone,document.tombstone_reason
      FROM organization_research_changes change
      JOIN organization_research_documents document ON document.organization_id=change.organization_id
        AND document.source_kind=change.source_kind AND document.source_message_id=change.source_message_id
      WHERE change.organization_id=$1 AND change.sequence_id>$2
      ORDER BY change.sequence_id LIMIT $3`, [access.organization_id, cursor, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const nextCursor = page.length ? Number(page.at(-1).sequence_id) : cursor;
    res.json({
      capability: ORGANIZATION_RESEARCH_CAPABILITY,
      cursor: nextCursor,
      hasMore: rows.length > limit,
      leaseExpiresAt: new Date(access.expires_at).toISOString(),
      changes: page.map(changePayload),
    });
  }));

  app.get('/api/organizations/:organizationId/research/context/:sourceKind/:messageId', auth, route(async (req, res) => {
    const access = await requireLease(pool, req, req.params.organizationId);
    const source = await one(pool, `SELECT * FROM organization_research_documents
      WHERE organization_id=$1 AND source_kind=$2 AND source_message_id=$3 AND tombstone=false`,
    [access.organization_id, req.params.sourceKind, req.params.messageId]);
    if (!source) throw apiError('organization_research_source_unavailable', '来源已撤回或不可访问。', 404);
    const before = (await pool.query(`SELECT * FROM organization_research_documents
      WHERE organization_id=$1 AND conversation_id=$2 AND tombstone=false
        AND (source_created_at,source_message_id)<($3,$4)
      ORDER BY source_created_at DESC,source_message_id DESC LIMIT 10`,
    [access.organization_id, source.conversation_id, source.source_created_at, source.source_message_id])).rows.reverse();
    const after = (await pool.query(`SELECT * FROM organization_research_documents
      WHERE organization_id=$1 AND conversation_id=$2 AND tombstone=false
        AND (source_created_at,source_message_id)>($3,$4)
      ORDER BY source_created_at,source_message_id LIMIT 10`,
    [access.organization_id, source.conversation_id, source.source_created_at, source.source_message_id])).rows;
    res.json({ source: documentPayload(source), messages: [...before, source, ...after].map(documentPayload), bounded: true });
  }));

  app.post('/api/organizations/:organizationId/research/audits', auth, route(async (req, res) => {
    const access = await requireLease(pool, req, req.params.organizationId);
    await pool.query("DELETE FROM organization_research_audits WHERE created_at < now() - interval '180 days'");
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim().slice(0, 240);
    if (!idempotencyKey) throw apiError('organization_research_audit_key_required', '缺少调查审计幂等键。', 400);
    const clientCreatedAt = validDate(req.body?.createdAt) || new Date();
    const mode = ['online', 'offline', 'fallback'].includes(req.body?.mode) ? req.body.mode : 'online';
    const citationIds = Array.isArray(req.body?.citationIds) ? req.body.citationIds.map(String).slice(0, 24) : [];
    const auditId = `org_research_audit_${crypto.randomUUID()}`;
    const result = await pool.query(`INSERT INTO organization_research_audits(
        id,idempotency_key,organization_id,querying_user_id,device_id,mode,query_hash,filters_json,
        result_count,citation_ids_json,client_created_at,created_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
      ON CONFLICT(organization_id,querying_user_id,idempotency_key) DO UPDATE
        SET idempotency_key=organization_research_audits.idempotency_key RETURNING *`, [
      auditId, idempotencyKey, access.organization_id, req.auth.user.id, access.device_id, mode,
      String(req.body?.queryHash || '').slice(0, 128), req.body?.filters || {},
      Math.max(0, Math.min(24, Number(req.body?.resultCount || 0))), JSON.stringify(citationIds), clientCreatedAt,
    ]);
    res.status(201).json({ audit: auditPayload(result.rows[0]) });
  }));

  app.get('/api/organizations/:organizationId/research/audits', auth, route(async (req, res) => {
    const membership = await requireMembership(pool, req.params.organizationId, req.auth.user.id);
    const organizationWide = String(req.query?.scope || '') === 'organization';
    if (organizationWide && !['owner', 'admin'].includes(membership.role)) {
      throw apiError('organization_admin_required', '只有组织 Owner 或管理员可以查看全组织调查记录。', 403);
    }
    const before = validDate(req.query?.before) || new Date(Date.now() + 1000);
    const retentionStart = new Date(Date.now() - AUDIT_RETENTION_MS);
    const params = [membership.organization_id, retentionStart, before, Math.max(1, Math.min(200, Number(req.query?.limit || 50)))];
    let viewer = '';
    if (!organizationWide) {
      viewer = req.auth.user.id;
      params.push(viewer);
    }
    const rows = (await pool.query(`SELECT * FROM organization_research_audits
      WHERE organization_id=$1 AND created_at>=$2 AND created_at<$3
        ${viewer ? 'AND querying_user_id=$5' : ''}
      ORDER BY created_at DESC,id DESC LIMIT $4`, params)).rows;
    res.json({ scope: organizationWide ? 'organization' : 'self', retentionDays: 180, audits: rows.map(auditPayload) });
  }));
}

async function requireMembership(db, organizationId, userId) {
  const row = await one(db, `SELECT membership.organization_id,membership.user_id,membership.role
    FROM contact_organization_members membership
    JOIN contact_organizations organization ON organization.id=membership.organization_id
    WHERE membership.organization_id=$1 AND membership.user_id=$2`, [String(organizationId || ''), userId]);
  if (!row) throw apiError('organization_research_forbidden', '你不是该组织的当前成员。', 403);
  return row;
}

async function requireEnabledPolicy(db, organizationId) {
  const policy = await one(db, `SELECT * FROM organization_research_policies
    WHERE organization_id=$1 AND status='enabled'`, [organizationId]);
  if (!policy) throw apiError('organization_research_disabled', '组织消息调查尚未启用。', 409);
  return policy;
}

async function requireLease(db, req, organizationId) {
  await requireMembership(db, organizationId, req.auth.user.id);
  await requireEnabledPolicy(db, organizationId);
  const deviceId = String(req.query?.deviceId || req.body?.deviceId || req.headers['x-janus-device-id'] || '').trim();
  const token = String(req.query?.leaseToken || req.body?.leaseToken || req.headers['x-janus-research-lease'] || '').trim();
  const lease = await one(db, `SELECT * FROM organization_research_device_leases
    WHERE organization_id=$1 AND user_id=$2 AND device_id=$3 AND status='active'`,
  [organizationId, req.auth.user.id, deviceId]);
  if (!lease || new Date(lease.expires_at).getTime() <= Date.now() || !token || !timingSafeEqual(lease.lease_token_hash, sha256(token))) {
    if (lease && new Date(lease.expires_at).getTime() <= Date.now()) {
      await db.query("UPDATE organization_research_device_leases SET status='expired' WHERE id=$1", [lease.id]);
    }
    throw apiError('organization_research_lease_invalid', '调查租约无效或已过期。', 423);
  }
  return lease;
}

function requireCapability(req) {
  const capability = String(req.body?.socialCapability || req.query?.capability || req.headers['x-janus-social-capability'] || '');
  if (capability !== ORGANIZATION_RESEARCH_CAPABILITY) {
    throw apiError('organization_research_capability_required', '客户端不支持组织消息调查能力。', 426);
  }
}

function assertSupportedClient(version) {
  const parts = (value) => String(value || '').replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
  const actual = parts(version);
  const minimum = parts(ORGANIZATION_RESEARCH_MINIMUM_CLIENT_VERSION);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) throw apiError('organization_research_client_upgrade_required', '请升级客户端后使用组织消息调查。', 426);
  }
}

function policyPayload(row) {
  return { organizationId: row.organization_id, status: row.status, enabledAt: iso(row.enabled_at), enabledByUserId: row.enabled_by_user_id, policyVersion: row.policy_version };
}

function leasePayload(row, token = '') {
  return { id: row.id, organizationId: row.organization_id, userId: row.user_id, deviceId: row.device_id, status: row.status, issuedAt: iso(row.issued_at), expiresAt: iso(row.expires_at), ...(token ? { token } : {}) };
}

function citationId(row) {
  return `orgmsg:${row.organization_id}:${row.source_kind}:${row.source_message_id}:${row.revision}`;
}

function documentPayload(row) {
  return {
    organizationId: row.organization_id,
    accountWorkspaceId: row.account_workspace_id,
    sourceKind: row.source_kind,
    sourceMessageId: row.source_message_id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    senderUserId: row.sender_user_id,
    senderDisplayName: row.sender_display_name,
    body: row.tombstone ? '' : row.body,
    attachmentNames: Array.isArray(row.attachment_names_json) ? row.attachment_names_json : [],
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    revision: Number(row.revision),
    tombstone: Boolean(row.tombstone),
    tombstoneReason: row.tombstone_reason,
    citation: {
      id: citationId(row), organizationId: row.organization_id,
      sourceKind: row.source_kind, conversationId: row.conversation_id,
      messageId: row.source_message_id, author: row.sender_display_name || row.sender_user_id,
      timestamp: iso(row.source_created_at), attachmentNames: Array.isArray(row.attachment_names_json) ? row.attachment_names_json : [],
    },
  };
}

function changePayload(row) {
  return { sequenceId: Number(row.sequence_id), operation: row.operation, occurredAt: iso(row.occurred_at), document: documentPayload(row) };
}

function auditPayload(row) {
  return { id: row.id, organizationId: row.organization_id, queryingUserId: row.querying_user_id, deviceId: row.device_id, mode: row.mode, queryHash: row.query_hash, filters: row.filters_json || {}, resultCount: Number(row.result_count), citationIds: row.citation_ids_json || [], createdAt: iso(row.created_at), clientCreatedAt: iso(row.client_created_at) };
}

async function one(db, sql, params = []) {
  return (await db.query(sql, params)).rows[0] || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
