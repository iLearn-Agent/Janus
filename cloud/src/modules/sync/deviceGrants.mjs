import crypto from 'node:crypto';
import { deviceGrantProofMessage } from '../../../../src/shared/taskMemoryCrypto.js';

const VALID_SCOPES = new Set([
  'sync:read', 'sync:write', 'sync:files', 'sync:keys', 'sync:*',
  'devices:approve', 'evolution:read', 'evolution:write', 'evolution:*',
  'employees:read', 'employees:write', 'employees:*',
]);

export function createDeviceGrantService({ pool, apiError, approvalMode = 'automatic' }) {
  const crossDeviceApproval = approvalMode === 'cross_device';
  return {
    async register({ userId, input = {} }) {
      const deviceId = requiredDeviceId(input.deviceId, apiError);
      const publicKey = normalizePublicKey(input.publicKey || input.publicKeyPem || '', apiError);
      const fingerprint = publicKey ? publicKeyFingerprint(publicKey) : '';
      return withTransaction(pool, async (client) => {
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
        const existing = (await client.query(
          'SELECT * FROM cloud_devices_v6 WHERE user_id=$1 AND device_id=$2 FOR UPDATE',
          [userId, deviceId],
        )).rows[0];
        const approvedCount = Number((await client.query(
          "SELECT COUNT(*)::int AS count FROM cloud_devices_v6 WHERE user_id=$1 AND status='approved'",
          [userId],
        )).rows[0]?.count || 0);
        const status = !crossDeviceApproval
          ? 'approved'
          : existing?.status === 'revoked'
            ? 'revoked'
            : existing?.status === 'pending' && approvedCount === 0
              ? 'approved'
              : existing?.status || (approvedCount === 0 ? 'approved' : 'pending');
        const approvalSource = approvedCount === 0 ? 'first_device_bootstrap' : 'authenticated_registration';
        const newlyApproved = status === 'approved' && existing?.status !== 'approved';
        const approvedBy = status === 'approved'
          ? (newlyApproved ? approvalSource : existing?.approved_by_device_id || approvalSource)
          : existing?.approved_by_device_id || '';
        const approvedAt = status === 'approved'
          ? (newlyApproved ? new Date() : existing?.approved_at || new Date())
          : existing?.approved_at || null;
        const row = (await client.query(`INSERT INTO cloud_devices_v6 (
          user_id,device_id,display_name,hostname,platform,arch,status,public_key_pem,public_key_fingerprint,
          approved_by_device_id,approved_at,last_seen_at,metadata_json,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12::jsonb,now(),now())
        ON CONFLICT(user_id,device_id) DO UPDATE SET
          display_name=excluded.display_name,hostname=excluded.hostname,platform=excluded.platform,arch=excluded.arch,
          status=excluded.status,approved_by_device_id=excluded.approved_by_device_id,approved_at=excluded.approved_at,
          revoked_at=CASE WHEN excluded.status='approved' THEN NULL ELSE cloud_devices_v6.revoked_at END,
          public_key_pem=CASE WHEN excluded.public_key_pem='' THEN cloud_devices_v6.public_key_pem ELSE excluded.public_key_pem END,
          public_key_fingerprint=CASE WHEN excluded.public_key_fingerprint='' THEN cloud_devices_v6.public_key_fingerprint ELSE excluded.public_key_fingerprint END,
          last_seen_at=now(),metadata_json=excluded.metadata_json,updated_at=now()
        RETURNING *`, [
          userId, deviceId, text(input.displayName || deviceId, 200), text(input.hostname, 255), text(input.platform, 100),
          text(input.arch, 100), status, publicKey, fingerprint, approvedBy, approvedAt, JSON.stringify(input.metadata || {}),
        ])).rows[0];
        return devicePayload(row);
      });
    },

    async list({ userId }) {
      const { rows } = await pool.query(`SELECT d.*,g.scopes_json AS grant_scopes,g.status AS grant_status,g.expires_at AS grant_expires_at
        FROM cloud_devices_v6 d LEFT JOIN cloud_sync_grants g ON g.user_id=d.user_id AND g.device_id=d.device_id
        WHERE d.user_id=$1 ORDER BY d.created_at,d.device_id`, [userId]);
      return rows.map(devicePayload);
    },

    async approve({ userId, actorDeviceId, targetDeviceId }) {
      if (actorDeviceId === targetDeviceId) throw apiError('device_self_approval_forbidden', 'A pending device cannot approve itself.', 403);
      const row = (await pool.query(`UPDATE cloud_devices_v6 SET status='approved',approved_by_device_id=$1,
        approved_at=now(),revoked_at=NULL,updated_at=now() WHERE user_id=$2 AND device_id=$3 AND status='pending' RETURNING *`,
      [actorDeviceId, userId, targetDeviceId])).rows[0];
      if (!row) throw apiError('pending_device_not_found', 'Pending device was not found.', 404);
      return devicePayload(row);
    },

    async revoke({ userId, actorDeviceId, targetDeviceId }) {
      if (!targetDeviceId) throw apiError('device_id_required', 'Device identity is required.', 400);
      const row = (await pool.query(`UPDATE cloud_devices_v6 SET status='revoked',revoked_at=now(),updated_at=now()
        WHERE user_id=$1 AND device_id=$2 AND status!='revoked' RETURNING *`, [userId, targetDeviceId])).rows[0];
      if (!row) return { status: 'not_found', deviceId: targetDeviceId };
      await pool.query(`UPDATE cloud_sync_grants SET status='revoked',token_hash=$1,updated_at=now()
        WHERE user_id=$2 AND device_id=$3`, [`revoked:${crypto.randomUUID()}`, userId, targetDeviceId]);
      await pool.query(`UPDATE cloud_task_key_device_envelopes_v6 SET status='revoked',updated_at=now()
        WHERE user_id=$1 AND device_id=$2 AND status='active'`, [userId, targetDeviceId]);
      return { ...devicePayload(row), revokedByDeviceId: actorDeviceId };
    },

    async issueToken({ userId, deviceId, requestedScopes = [], ttlDays = 30, proof = null, allowLegacyNoKey = false }) {
      const device = (await pool.query(
        "SELECT * FROM cloud_devices_v6 WHERE user_id=$1 AND device_id=$2 AND status='approved'",
        [userId, deviceId],
      )).rows[0];
      if (!device) throw apiError('device_not_approved', 'Device approval is required before a Sync Grant can be issued.', 409);
      const scopes = normalizeScopes(requestedScopes, apiError);
      await verifyDeviceProof(pool, apiError, device, { userId, deviceId, scopes, proof, allowLegacyNoKey });
      const existing = (await pool.query('SELECT scopes_json FROM cloud_sync_grants WHERE user_id=$1 AND device_id=$2', [userId, deviceId])).rows[0];
      const merged = [...new Set([...(Array.isArray(existing?.scopes_json) ? existing.scopes_json : []), ...scopes])];
      const token = `dgr_${crypto.randomBytes(32).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + Math.max(1, Math.min(90, Number(ttlDays || 30))) * 86400000);
      await pool.query(`INSERT INTO cloud_sync_grants (
        id,user_id,device_id,token_hash,scopes_json,status,expires_at,grant_version,issued_at,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5::jsonb,'active',$6,6,now(),now(),now())
      ON CONFLICT(user_id,device_id) DO UPDATE SET token_hash=excluded.token_hash,scopes_json=excluded.scopes_json,
        status='active',expires_at=excluded.expires_at,grant_version=6,issued_at=now(),updated_at=now()`, [
        `grant_${crypto.randomUUID()}`, userId, deviceId, sha256(token), JSON.stringify(merged), expiresAt,
      ]);
      return { token, userId, deviceId, scopes: merged, status: 'approved', expiresAt: expiresAt.toISOString() };
    },
  };
}

export function routeWithDeviceGrant(pool, apiError, scope, handler, { property = 'deviceGrant' } = {}) {
  return async (req, res, next) => {
    try {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) throw apiError('device_grant_invalid', 'Device Grant is required.', 401);
      const row = (await pool.query(`SELECT g.*,d.status AS device_status FROM cloud_sync_grants g
        JOIN cloud_devices_v6 d ON d.user_id=g.user_id AND d.device_id=g.device_id
        WHERE g.token_hash=$1 AND g.status='active' AND d.status='approved'
          AND (g.expires_at IS NULL OR g.expires_at>now())`, [sha256(token)])).rows[0];
      if (!row) throw apiError('device_grant_invalid', 'Device Grant is invalid, expired, pending, or revoked.', 401);
      const scopes = Array.isArray(row.scopes_json) ? row.scopes_json : [];
      if (!scopeAllowed(scopes, scope)) throw apiError('device_grant_scope_denied', 'Device Grant scope is insufficient.', 403);
      await pool.query('UPDATE cloud_sync_grants SET last_used_at=now(),updated_at=now() WHERE id=$1', [row.id]);
      req[property] = { id: row.id, userId: row.user_id, deviceId: row.device_id, scopes };
      await handler(req, res, next);
    } catch (error) { next(error); }
  };
}

export function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function normalizePublicKey(value, apiError) {
  const pem = String(value || '').trim();
  if (!pem) return '';
  try {
    const key = crypto.createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not_rsa');
    return String(key.export({ type: 'spki', format: 'pem' }));
  } catch {
    throw apiError('device_public_key_invalid', 'Device public key must be a valid RSA public key.', 400);
  }
}

function normalizeScopes(requested, apiError) {
  const defaults = ['sync:read', 'sync:write', 'sync:files', 'sync:keys', 'devices:approve'];
  const input = Array.isArray(requested) && requested.length ? requested.map(String) : defaults;
  const scopes = [...new Set(input.filter((scope) => VALID_SCOPES.has(scope)))];
  if (!scopes.length) throw apiError('device_grant_scope_required', 'At least one valid Device Grant scope is required.', 400);
  return scopes;
}

function scopeAllowed(scopes, required) {
  if (Array.isArray(required)) return required.some((scope) => scopeAllowed(scopes, scope));
  if (scopes.includes(required)) return true;
  const namespace = String(required).split(':')[0];
  return scopes.includes(`${namespace}:*`);
}

async function verifyDeviceProof(pool, apiError, device, { userId, deviceId, scopes, proof, allowLegacyNoKey }) {
  if (!device.public_key_pem) {
    if (allowLegacyNoKey) return;
    throw apiError('device_public_key_required', 'Device public key is required before a Device Grant can be issued.', 409);
  }
  const timestamp = String(proof?.timestamp || '');
  const nonce = String(proof?.nonce || '').trim();
  const signature = String(proof?.signature || '');
  const fingerprint = String(proof?.publicKeyFingerprint || '');
  const time = Date.parse(timestamp);
  if (!nonce || nonce.length > 200 || !signature || !Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) {
    throw apiError('device_proof_invalid', 'Device Grant proof is missing, expired, or invalid.', 401);
  }
  if (fingerprint && fingerprint !== device.public_key_fingerprint) {
    throw apiError('device_proof_invalid', 'Device Grant proof fingerprint does not match the registered device.', 401);
  }
  const message = deviceGrantProofMessage({ userId, deviceId, scopes, timestamp, nonce });
  let verified = false;
  try { verified = crypto.verify('sha256', Buffer.from(message, 'utf8'), device.public_key_pem, Buffer.from(signature, 'base64')); } catch { verified = false; }
  if (!verified) throw apiError('device_proof_invalid', 'Device Grant proof signature is invalid.', 401);
  try {
    await pool.query(`INSERT INTO cloud_device_token_nonces_v6(user_id,device_id,nonce,proof_timestamp,consumed_at)
      VALUES($1,$2,$3,$4,now())`, [userId, deviceId, nonce, timestamp]);
  } catch (error) {
    if (error?.code === '23505') throw apiError('device_proof_replayed', 'Device Grant proof nonce has already been used.', 409);
    throw error;
  }
}

function requiredDeviceId(value, apiError) {
  const deviceId = text(value, 255);
  if (!deviceId) throw apiError('device_id_required', 'Device identity is required.', 400);
  return deviceId;
}

function devicePayload(row = {}) {
  return {
    userId: row.user_id, deviceId: row.device_id, displayName: row.display_name || '', hostname: row.hostname || '',
    platform: row.platform || '', arch: row.arch || '', status: row.status, publicKeyFingerprint: row.public_key_fingerprint || '',
    approvedByDeviceId: row.approved_by_device_id || '', approvedAt: row.approved_at, revokedAt: row.revoked_at,
    scopes: Array.isArray(row.grant_scopes) ? row.grant_scopes : [], grantStatus: row.grant_status || '',
    grantExpiresAt: row.grant_expires_at || null, lastSeenAt: row.last_seen_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function text(value, max = 255) { return String(value || '').trim().slice(0, max); }
function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await callback(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
