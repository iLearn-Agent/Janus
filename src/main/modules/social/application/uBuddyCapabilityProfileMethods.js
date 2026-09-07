import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import {
  normalizeUBuddyCapabilityProfile,
  validateUBuddyCapabilityProfile,
} from '../../../../shared/contracts/uBuddyCapabilityProfile.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function installUBuddyCapabilityProfileMethods(prototype) {
  Object.assign(prototype, {
    uBuddyCapabilityProfiles({ userIds = [], serverOriginHash = '', includeExpired = false } = {}) {
      const viewer = this.requireUser();
      const ids = cleanIds(userIds);
      if (!ids.length || !serverOriginHash) return [];
      const placeholders = ids.map(() => '?').join(',');
      const rows = all(this.db, `SELECT * FROM ubuddy_capability_profile_cache
        WHERE viewer_user_id=? AND server_origin_hash=? AND owner_local_user_id IN (${placeholders})
        ${includeExpired ? '' : "AND expires_at<>'' AND expires_at>?"}
        ORDER BY updated_at DESC`, [viewer.id, serverOriginHash, ...ids, ...(includeExpired ? [] : [nowIso()])]);
      const profiles = [];
      for (const row of rows) {
        const cached = normalizeCacheRow(row);
        if (validateUBuddyCapabilityProfile(cached.profile).valid) profiles.push(cached);
        else run(this.db, `DELETE FROM ubuddy_capability_profile_cache
          WHERE viewer_user_id=? AND server_origin_hash=? AND owner_remote_user_id=?`, [
          viewer.id, row.server_origin_hash || serverOriginHash, row.owner_remote_user_id || '',
        ]);
      }
      return profiles;
    },

    importCloudUBuddyCapabilityProfiles({ profiles = [], unavailableUserIds = [], requestedRemoteUserIds = [], serverOriginHash = '' } = {}) {
      const viewer = this.requireUser();
      if (!serverOriginHash) return [];
      const now = nowIso();
      const expiresAt = new Date(Date.now() + CACHE_TTL_MS).toISOString();
      const returned = new Set();
      for (const item of Array.isArray(profiles) ? profiles : []) {
        const profileSource = item?.profile || item;
        const validation = validateUBuddyCapabilityProfile(profileSource);
        if (!validation.valid) continue;
        const profile = validation.value;
        const remoteUserId = String(item.ownerUserId || profile.ownerUserId || '').trim();
        if (!remoteUserId) continue;
        returned.add(remoteUserId);
        const localUserId = get(this.db, 'SELECT id FROM auth_users WHERE remote_id=? OR id=? ORDER BY CASE WHEN remote_id=? THEN 0 ELSE 1 END LIMIT 1', [
          remoteUserId, remoteUserId, remoteUserId,
        ])?.id || '';
        run(this.db, `INSERT INTO ubuddy_capability_profile_cache(
          viewer_user_id,server_origin_hash,owner_remote_user_id,owner_local_user_id,ubuddy_agent_instance_id,
          profile_revision,profile_version,visibility,content_hash,profile_json,access_scope,fetched_at,expires_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(viewer_user_id,server_origin_hash,owner_remote_user_id) DO UPDATE SET
          owner_local_user_id=excluded.owner_local_user_id,ubuddy_agent_instance_id=excluded.ubuddy_agent_instance_id,
          profile_revision=excluded.profile_revision,profile_version=excluded.profile_version,visibility=excluded.visibility,
          content_hash=excluded.content_hash,profile_json=excluded.profile_json,access_scope=excluded.access_scope,
          fetched_at=excluded.fetched_at,expires_at=excluded.expires_at,updated_at=excluded.updated_at`, [
          viewer.id, serverOriginHash, remoteUserId, localUserId, profile.uBuddyAgentInstanceId,
          profile.profileRevision, profile.version, profile.visibility, String(item.contentHash || ''), JSON.stringify(profile),
          String(item.accessScope || profile.visibility || 'friends'), now, expiresAt, now,
        ]);
      }
      const unavailable = new Set([...cleanIds(unavailableUserIds), ...cleanIds(requestedRemoteUserIds).filter((id) => !returned.has(id))]);
      for (const remoteUserId of unavailable) {
        run(this.db, `DELETE FROM ubuddy_capability_profile_cache
          WHERE viewer_user_id=? AND server_origin_hash=? AND owner_remote_user_id=?`, [viewer.id, serverOriginHash, remoteUserId]);
      }
      return this.uBuddyCapabilityProfiles({
        userIds: all(this.db, `SELECT owner_local_user_id FROM ubuddy_capability_profile_cache
          WHERE viewer_user_id=? AND server_origin_hash=?`, [viewer.id, serverOriginHash]).map((row) => row.owner_local_user_id).filter(Boolean),
        serverOriginHash,
      });
    },

    purgeUBuddyCapabilityProfileCache({ userIds = [], remoteUserIds = [], serverOriginHash = '', allForServer = false } = {}) {
      const viewer = this.requireUser();
      const localIds = cleanIds(userIds);
      const remoteIds = cleanIds(remoteUserIds);
      if (!allForServer && !localIds.length && !remoteIds.length) return 0;
      const predicates = [];
      const params = [viewer.id];
      if (serverOriginHash) { predicates.push('server_origin_hash=?'); params.push(serverOriginHash); }
      if (!allForServer) {
        const ownerPredicates = [];
        if (localIds.length) { ownerPredicates.push(`owner_local_user_id IN (${localIds.map(() => '?').join(',')})`); params.push(...localIds); }
        if (remoteIds.length) { ownerPredicates.push(`owner_remote_user_id IN (${remoteIds.map(() => '?').join(',')})`); params.push(...remoteIds); }
        predicates.push(`(${ownerPredicates.join(' OR ')})`);
      }
      return run(this.db, `DELETE FROM ubuddy_capability_profile_cache WHERE viewer_user_id=?${predicates.length ? ` AND ${predicates.join(' AND ')}` : ''}`, params).changes;
    },

    queueUBuddyCapabilityProfilePublication({ operationKind = 'publish', profile = null, commandId = '', expectedCloudStateRevision = 0 } = {}) {
      const owner = this.requireUser();
      const operation = operationKind === 'unpublish' ? 'unpublish' : 'publish';
      const normalizedProfile = operation === 'publish' ? normalizeUBuddyCapabilityProfile(profile) : null;
      if (normalizedProfile) validateUBuddyCapabilityProfile(normalizedProfile, { throwOnError: true });
      const cleanCommandId = String(commandId || newId('ubuddy_profile_publication')).trim().slice(0, 200);
      const payload = {
        commandId: cleanCommandId,
        expectedStateRevision: Math.max(0, Number(expectedCloudStateRevision || 0)),
        ...(normalizedProfile ? { profile: normalizedProfile } : {}),
      };
      const payloadHash = sha256(JSON.stringify(payload));
      const prior = get(this.db, 'SELECT * FROM ubuddy_capability_profile_publication_outbox WHERE command_id=?', [cleanCommandId]);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw profileError('ubuddy_profile_publication_idempotency_conflict', '简介发布命令已被不同请求占用。');
        return normalizeOutbox(prior);
      }
      const now = nowIso();
      const id = newId('ubuddy_profile_outbox');
      run(this.db, `INSERT INTO ubuddy_capability_profile_publication_outbox(
        id,owner_user_id,profile_revision,command_id,operation_kind,expected_cloud_state_revision,
        payload_hash,payload_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?)`, [
        id, owner.id, Number(normalizedProfile?.profileRevision || 0), cleanCommandId, operation,
        payload.expectedStateRevision, payloadHash, JSON.stringify(payload), now, now,
      ]);
      return normalizeOutbox(get(this.db, 'SELECT * FROM ubuddy_capability_profile_publication_outbox WHERE id=?', [id]));
    },

    listUBuddyCapabilityProfilePublicationOutbox({ limit = 100 } = {}) {
      const owner = this.requireUser();
      return all(this.db, `SELECT * FROM ubuddy_capability_profile_publication_outbox
        WHERE owner_user_id=? AND status IN ('pending','sending','failed','blocked_capability')
          AND (next_attempt_at='' OR next_attempt_at<=?) ORDER BY created_at,id LIMIT ?`, [
        owner.id, nowIso(), Math.max(1, Math.min(500, Number(limit) || 100)),
      ]).map(normalizeOutbox);
    },

    markUBuddyCapabilityProfilePublicationOutbox({ id = '', status = 'completed', error = '', retryAt = '', scrubPayload = false } = {}) {
      const allowed = new Set(['pending', 'sending', 'completed', 'failed', 'blocked_capability']);
      const nextStatus = allowed.has(status) ? status : 'failed';
      const now = nowIso();
      run(this.db, `UPDATE ubuddy_capability_profile_publication_outbox SET status=?,
        attempt_count=attempt_count+CASE WHEN ? IN ('completed','failed','blocked_capability') THEN 1 ELSE 0 END,
        next_attempt_at=?,last_error=?,payload_json=CASE WHEN ? THEN '{}' ELSE payload_json END,
        payload_hash=CASE WHEN ? THEN ? ELSE payload_hash END,updated_at=?,completed_at=? WHERE id=?`, [
        nextStatus, nextStatus, String(retryAt || ''), String(error || '').slice(0, 1000),
        scrubPayload ? 1 : 0, scrubPayload ? 1 : 0, sha256('{}'), now,
        nextStatus === 'completed' ? now : '', String(id || ''),
      ]);
      return normalizeOutbox(get(this.db, 'SELECT * FROM ubuddy_capability_profile_publication_outbox WHERE id=?', [id]));
    },
  });
}

function normalizeCacheRow(row = {}) {
  return {
    ownerUserId: row.owner_local_user_id || row.owner_remote_user_id || '',
    ownerRemoteUserId: row.owner_remote_user_id || '',
    contentHash: row.content_hash || '',
    accessScope: row.access_scope || 'friends',
    fetchedAt: row.fetched_at || '',
    expiresAt: row.expires_at || '',
    stale: Boolean(row.expires_at && Date.parse(row.expires_at) <= Date.now()),
    profile: parseJson(row.profile_json),
  };
}

function normalizeOutbox(row = {}) {
  if (!row?.id) return null;
  return { ...row, payload: parseJson(row.payload_json) };
}

function cleanIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

function parseJson(value = '') {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function sha256(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function profileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
