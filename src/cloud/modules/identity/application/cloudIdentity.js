import crypto from 'node:crypto';

import { createMailTransport } from '../../../../../network/server/mailTransport.js';
import { profileAvatarUrlValidation } from '../../../../shared/profileAvatar.js';
import { cloudApiError } from '../../http/index.js';

const CLOUD_PASSWORD_ITERATIONS = 310_000;
const CLOUD_PASSWORD_KEYLEN = 32;
const CLOUD_PASSWORD_DIGEST = 'sha256';
const CLOUD_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const CLOUD_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLOUD_EMAIL_CODE_TTL_MS = Math.max(60_000, Number(process.env.JANUS_EMAIL_CODE_TTL_MINUTES || process.env.EMAIL_CODE_TTL_MINUTES || 10) * 60 * 1000);
const CLOUD_EMAIL_CODE_RESEND_MS = Math.max(10_000, Number(process.env.JANUS_EMAIL_CODE_RESEND_SECONDS || 60) * 1000);
const CLOUD_EMAIL_CODE_MAX_ATTEMPTS = Math.max(1, Number(process.env.JANUS_EMAIL_CODE_MAX_ATTEMPTS || 5));

function registerCloudUser(db, payload = {}, { emailCodeSecret = '' } = {}) {
  const email = normalizeCloudEmail(payload.email);
  const password = validateCloudPassword(payload.password);
  const displayName = normalizeCloudDisplayName(payload.displayName, email.split('@')[0]);
  if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
    throw cloudApiError('email_already_registered', '该邮箱已被注册。', 409);
  }
  const verification = verifyCloudEmailCode(db, {
    email,
    purpose: 'register',
    code: payload.code,
    emailCodeSecret,
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
      throw cloudApiError('email_already_registered', '该邮箱已被注册。', 409);
    }
    const id = `user_${crypto.randomUUID()}`;
    const username = uniqueCloudUsername(db, displayName || email.split('@')[0] || id);
    consumeCloudEmailCode(db, verification);
    db.prepare(
      `INSERT INTO users (
        id, email, display_name, username, avatar_url, email_verified, role, password_hash, updated_at
       ) VALUES (?, ?, ?, ?, '', 1, 'member', ?, ?)`,
    ).run(id, email, displayName, username, hashCloudPassword(password), new Date().toISOString());
    const result = createCloudSession(db, db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error?.message || '').includes('UNIQUE constraint failed: users.email')) {
      throw cloudApiError('email_already_registered', '该邮箱已被注册。', 409);
    }
    throw error;
  }
}

async function sendCloudEmailCode({ db, payload = {}, currentUser = null, emailCodeSecret = '', mailer = null } = {}) {
  const purpose = normalizeCloudEmailPurpose(payload.purpose);
  const email = normalizeCloudEmail(payload.email || currentUser?.email || currentUser?.email_address);
  if (!emailCodeSecret) throw cloudApiError('email_delivery_unavailable', '邮箱验证码服务尚未配置。', 503);
  if (!mailer?.sendEmailCode || mailer.configured === false) {
    throw cloudApiError('email_delivery_unavailable', '邮箱发送服务尚未配置，请联系管理员。', 503);
  }
  const existing = db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (purpose === 'register' && existing) throw cloudApiError('email_already_registered', '该邮箱已被注册。', 409);
  if (purpose === 'password_reset' && !existing) throw cloudApiError('email_not_found', '账号不存在。', 404);
  if (['password_change', 'organization_invitation_reset'].includes(purpose)) {
    if (!currentUser?.id) throw cloudApiError('unauthorized', '请先登录账号。', 401);
    if (email !== String(currentUser.email || '').trim().toLowerCase()) {
      throw cloudApiError('email_mismatch', '验证码只能发送到当前账号邮箱。', 403);
    }
  }
  const latest = db.prepare(
    `SELECT expires_at, created_at FROM auth_email_verifications
     WHERE email = ? COLLATE NOCASE AND purpose = ? AND consumed = 0
     ORDER BY created_at DESC LIMIT 1`,
  ).get(email, purpose);
  if (latest) {
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < CLOUD_EMAIL_CODE_RESEND_MS
      && new Date(latest.expires_at).getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((CLOUD_EMAIL_CODE_RESEND_MS - elapsed) / 1000));
      return {
        ok: true,
        provider: 'cloud',
        delivery: 'email',
        email,
        purpose,
        expiresAt: new Date(latest.expires_at).toISOString(),
        retryAfterSeconds,
        reused: true,
      };
    }
  }
  const code = String(crypto.randomInt(100_000, 1_000_000));
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLOUD_EMAIL_CODE_TTL_MS).toISOString();
  const id = `email_code_${crypto.randomUUID()}`;
  const codeHash = hashCloudEmailCode({ email, purpose, code, emailCodeSecret });
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `UPDATE auth_email_verifications SET consumed = 1
       WHERE email = ? COLLATE NOCASE AND purpose = ? AND consumed = 0`,
    ).run(email, purpose);
    db.prepare(
      `INSERT INTO auth_email_verifications (id, email, purpose, code_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, email, purpose, codeHash, expiresAt, createdAt);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  try {
    await mailer.sendEmailCode({ email, purpose, code, expiresAt });
  } catch (error) {
    db.prepare('UPDATE auth_email_verifications SET consumed = 1 WHERE id = ?').run(id);
    const deliveryError = cloudApiError('email_delivery_failed', '验证码邮件发送失败，请稍后重试。', 503);
    deliveryError.cause = error;
    throw deliveryError;
  }
  return {
    ok: true,
    provider: 'cloud',
    delivery: 'email',
    email,
    purpose,
    expiresAt,
    retryAfterSeconds: Math.ceil(CLOUD_EMAIL_CODE_RESEND_MS / 1000),
    reused: false,
  };
}

function resetCloudUserPassword(db, payload = {}, { emailCodeSecret = '' } = {}) {
  const email = normalizeCloudEmail(payload.email);
  const password = validateCloudPassword(payload.newPassword);
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
  if (!user) throw cloudApiError('email_not_found', '账号不存在。', 404);
  const verification = verifyCloudEmailCode(db, {
    email,
    purpose: 'password_reset',
    code: payload.code,
    emailCodeSecret,
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    consumeCloudEmailCode(db, verification);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashCloudPassword(password), new Date().toISOString(), user.id);
    db.prepare('UPDATE auth_access_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    db.exec('COMMIT');
    return { ok: true, userId: user.id };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function loginCloudUser(db, payload = {}) {
  const identifier = String(payload.identifier || payload.email || '').trim().toLowerCase();
  if (!identifier) throw cloudApiError('identifier_required', '\u8bf7\u8f93\u5165\u90ae\u7bb1\u3001\u7528\u6237\u540d\u6216\u7528\u6237 ID\u3002', 400);
  if (identifier.length > 254) throw cloudApiError('identifier_invalid', '\u8d26\u53f7\u683c\u5f0f\u4e0d\u6b63\u786e\u3002', 400);
  const user = db.prepare(
    `SELECT * FROM users
     WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE OR id = ? COLLATE NOCASE
     LIMIT 1`,
  ).get(identifier, identifier, identifier);
  if (!user || !verifyCloudPassword(payload.password, user.password_hash)) {
    throw cloudApiError('invalid_credentials', '\u8d26\u53f7\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\u3002', 401);
  }
  assertCloudUserActive(user);
  return createCloudSession(db, user);
}

function refreshCloudSession(db, payload = {}) {
  const refreshToken = String(payload.refreshToken || '').trim();
  if (!refreshToken) throw cloudApiError('refresh_token_required', '\u8bf7\u91cd\u65b0\u767b\u5f55\u3002', 401);
  const tokenHash = hashCloudToken(refreshToken);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(
      `SELECT rt.*, u.*
       FROM auth_refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ? AND rt.revoked = 0
       LIMIT 1`,
    ).get(tokenHash);
    if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
      throw cloudApiError('session_expired', '\u767b\u5f55\u72b6\u6001\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002', 401);
    }
    assertCloudUserActive(row);
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(tokenHash);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    assertCloudUserActive(user);
    const result = createCloudSession(db, user);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function logoutCloudSession(db, payload = {}) {
  const refreshToken = String(payload.refreshToken || '').trim();
  if (refreshToken) {
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hashCloudToken(refreshToken));
  }
}

function requireCloudAuth(db, request) {
  const match = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw cloudApiError('unauthorized', '\u8bf7\u5148\u767b\u5f55\u8d26\u53f7\u3002', 401);
  const row = db.prepare(
    `SELECT u.*
     FROM auth_access_tokens at
     JOIN users u ON u.id = at.user_id
     WHERE at.token_hash = ? AND at.revoked = 0 AND at.expires_at > ?
     LIMIT 1`,
  ).get(hashCloudToken(match[1]), new Date().toISOString());
  if (!row) throw cloudApiError('session_expired', '\u767b\u5f55\u72b6\u6001\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002', 401);
  assertCloudUserActive(row);
  recordCloudAccountAccess(db, row.id);
  return row;
}

function createCloudSession(db, user) {
  if (!user?.id) throw cloudApiError('user_not_found', '\u8d26\u53f7\u4e0d\u5b58\u5728\u3002', 404);
  assertCloudUserActive(user);
  const accessToken = crypto.randomBytes(48).toString('base64url');
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const accessExpiresAt = new Date(Date.now() + CLOUD_ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(Date.now() + CLOUD_REFRESH_TOKEN_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO auth_access_tokens (token_hash, user_id, expires_at)
     VALUES (?, ?, ?)`,
  ).run(hashCloudToken(accessToken), user.id, accessExpiresAt);
  db.prepare(
    `INSERT INTO auth_refresh_tokens (token_hash, user_id, expires_at)
     VALUES (?, ?, ?)`,
  ).run(hashCloudToken(refreshToken), user.id, refreshExpiresAt);
  return {
    user: cloudUserPayload(user),
    accessToken,
    refreshToken,
    provider: 'cloud',
  };
}

function updateCloudUserProfile(db, currentUser, payload = {}) {
  const displayName = normalizeCloudDisplayName(payload.displayName || currentUser.display_name, currentUser.display_name);
  const email = normalizeCloudEmail(payload.email || currentUser.email);
  const username = normalizeCloudUsername(payload.username ?? currentUser.username ?? displayName);
  if (email !== String(currentUser.email || '').trim().toLowerCase()) {
    throw cloudApiError('email_change_not_supported', '注册邮箱不支持直接修改。', 400);
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, currentUser.id);
  if (existing) throw cloudApiError('email_already_registered', '该邮箱已被其他账号使用。', 409);
  const usernameConflict = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id <> ?').get(username, currentUser.id);
  if (usernameConflict) throw cloudApiError('username_already_taken', '该用户名已被其他账号使用。', 409);
  const avatarProvided = Object.hasOwn(payload, 'avatarUrl') || Object.hasOwn(payload, 'avatar_url');
  const avatarValidation = profileAvatarUrlValidation(avatarProvided
    ? payload.avatarUrl ?? payload.avatar_url ?? ''
    : currentUser.avatar_url || '', { allowLegacyLocal: !avatarProvided });
  if (!avatarValidation.valid) throw cloudApiError('profile_avatar_invalid', avatarValidation.reason, 400);
  try {
    db.prepare(
      `UPDATE users SET email = ?, display_name = ?, username = ?, avatar_url = ?, updated_at = ? WHERE id = ?`,
    ).run(email, displayName, username, avatarValidation.value, new Date().toISOString(), currentUser.id);
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE constraint failed: users.username')) {
      throw cloudApiError('username_already_taken', '该用户名已被其他账号使用。', 409);
    }
    throw error;
  }
  return cloudUserPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id));
}

function updateCloudUserPassword(db, currentUser, payload = {}, { emailCodeSecret = '' } = {}) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id);
  if (!row || !verifyCloudPassword(payload.currentPassword, row.password_hash)) {
    throw cloudApiError('invalid_current_password', '当前密码不正确。', 401);
  }
  const password = validateCloudPassword(payload.newPassword);
  const verification = verifyCloudEmailCode(db, {
    email: row.email,
    purpose: 'password_change',
    code: payload.code,
    emailCodeSecret,
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    consumeCloudEmailCode(db, verification);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashCloudPassword(password), new Date().toISOString(), row.id);
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function assertCloudUserActive(user = {}) {
  if (!user?.id) throw cloudApiError('user_not_found', '\u8d26\u53f7\u4e0d\u5b58\u5728\u3002', 404);
  const status = String(user.account_status || 'active').trim().toLowerCase() || 'active';
  if (status !== 'active') {
    throw cloudApiError('account_suspended', user.suspension_reason || '\u8d26\u53f7\u5df2\u88ab\u505c\u7528\uff0c\u8bf7\u8054\u7cfb\u7ba1\u7406\u5458\u3002', 403, {
      suspendedAt: user.suspended_at || '',
      reason: user.suspension_reason || '',
    });
  }
}

function suspendCloudUser(db, { userId = '', reason = 'upload_compliance_violation', now = new Date().toISOString() } = {}) {
  const id = String(userId || '').trim();
  if (!id) throw cloudApiError('user_id_required', '\u7f3a\u5c11\u7528\u6237 ID\u3002', 400);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw cloudApiError('user_not_found', '\u8d26\u53f7\u4e0d\u5b58\u5728\u3002', 404);
  const cleanReason = String(reason || 'upload_compliance_violation').trim().slice(0, 500);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE users SET account_status='suspended', suspended_at=?, suspension_reason=?, updated_at=? WHERE id=?")
      .run(now, cleanReason, now, id);
    db.prepare('UPDATE auth_access_tokens SET revoked = 1 WHERE user_id = ?').run(id);
    db.prepare('UPDATE auth_refresh_tokens SET revoked = 1 WHERE user_id = ?').run(id);
    upsertUploadComplianceStatus(db, { userId: id, status: 'suspended', reason: cleanReason, now });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, user: cloudUserPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
}

function reactivateCloudUser(db, { userId = '', reason = 'manual_reactivation', now = new Date().toISOString() } = {}) {
  const id = String(userId || '').trim();
  if (!id) throw cloudApiError('user_id_required', '\u7f3a\u5c11\u7528\u6237 ID\u3002', 400);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw cloudApiError('user_not_found', '\u8d26\u53f7\u4e0d\u5b58\u5728\u3002', 404);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE users SET account_status='active', suspended_at='', suspension_reason='', updated_at=? WHERE id=?").run(now, id);
    upsertUploadComplianceStatus(db, { userId: id, status: 'ok', reason: String(reason || '').slice(0, 500), reset: true, now });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, user: cloudUserPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
}

function recordCloudAccountAccess(db, userId = '', { now = new Date().toISOString() } = {}) {
  const id = String(userId || '').trim();
  if (!id || !uploadComplianceAvailable(db)) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user || String(user.role || '') === 'admin' || String(user.account_status || 'active') !== 'active') return null;
  const row = db.prepare('SELECT * FROM cloud_upload_compliance WHERE user_id = ?').get(id);
  const lastEffective = row?.last_effective_sync_at || '';
  const createdAt = user.created_at || now;
  const ageMs = Date.parse(now) - Date.parse(createdAt);
  const staleForMs = lastEffective ? Date.parse(now) - Date.parse(lastEffective) : ageMs;
  const lastAccessMs = row?.last_access_at ? Date.parse(now) - Date.parse(row.last_access_at) : Number.POSITIVE_INFINITY;
  const stale = Number.isFinite(staleForMs) && staleForMs >= uploadComplianceStaleMs()
    && Number.isFinite(ageMs) && ageMs >= uploadComplianceGraceMs();
  const shouldCount = stale && (!Number.isFinite(lastAccessMs) || lastAccessMs >= uploadComplianceAccessDebounceMs());
  const nextSuspicious = Number(row?.suspicious_access_count || 0) + (shouldCount ? 1 : 0);
  db.prepare(`INSERT INTO cloud_upload_compliance (
      user_id,last_access_at,suspicious_access_count,status,reason,updated_at
    ) VALUES (?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_access_at=excluded.last_access_at,
      suspicious_access_count=excluded.suspicious_access_count,
      status=CASE WHEN excluded.suspicious_access_count>=? THEN 'suspicious' ELSE cloud_upload_compliance.status END,
      reason=CASE WHEN excluded.suspicious_access_count>=? THEN 'no_effective_upload_after_cloud_access' ELSE cloud_upload_compliance.reason END,
      updated_at=excluded.updated_at`).run(
        id, now, nextSuspicious, shouldCount ? 'suspicious' : 'ok', shouldCount ? 'no_effective_upload_after_cloud_access' : '', now,
        uploadComplianceSuspendStrikes(), uploadComplianceSuspendStrikes(),
      );
  if (nextSuspicious >= uploadComplianceSuspendStrikes()) {
    return suspendCloudUser(db, { userId: id, reason: 'no_effective_upload_after_cloud_access', now });
  }
  return { ok: true, suspiciousAccessCount: nextSuspicious };
}

function upsertUploadComplianceStatus(db, { userId = '', status = 'ok', reason = '', reset = false, now = new Date().toISOString() } = {}) {
  if (!uploadComplianceAvailable(db)) return;
  db.prepare(`INSERT INTO cloud_upload_compliance (user_id,status,reason,updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      status=excluded.status, reason=excluded.reason,
      suspicious_access_count=CASE WHEN ? THEN 0 ELSE suspicious_access_count END,
      empty_batch_streak=CASE WHEN ? THEN 0 ELSE empty_batch_streak END,
      updated_at=excluded.updated_at`).run(String(userId || '').trim(), status, reason, now, reset ? 1 : 0, reset ? 1 : 0);
}

function uploadComplianceAvailable(db) {
  try { return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_upload_compliance'").get()); }
  catch { return false; }
}

function uploadComplianceSuspendStrikes() { return Math.max(1, Number(process.env.JANUS_UPLOAD_COMPLIANCE_SUSPEND_STRIKES || 4)); }
function uploadComplianceStaleMs() { return Math.max(60_000, Number(process.env.JANUS_UPLOAD_COMPLIANCE_STALE_HOURS || 72) * 60 * 60 * 1000); }
function uploadComplianceGraceMs() { return Math.max(0, Number(process.env.JANUS_UPLOAD_COMPLIANCE_GRACE_HOURS || 24) * 60 * 60 * 1000); }
function uploadComplianceAccessDebounceMs() { return Math.max(60_000, Number(process.env.JANUS_UPLOAD_COMPLIANCE_ACCESS_DEBOUNCE_MINUTES || 30) * 60 * 1000); }

function cloudUserPayload(row = {}) {
  return {
    id: row.id || '',
    email: row.email || '',
    displayName: row.display_name || '',
    display_name: row.display_name || '',
    username: row.username || '',
    avatarUrl: row.avatar_url || '',
    avatar_url: row.avatar_url || '',
    emailVerified: Boolean(row.email_verified),
    email_verified: Boolean(row.email_verified),
    role: row.role || 'member',
    accountStatus: row.account_status || 'active',
    account_status: row.account_status || 'active',
    suspendedAt: row.suspended_at || '',
    suspended_at: row.suspended_at || '',
    suspensionReason: row.suspension_reason || '',
    suspension_reason: row.suspension_reason || '',
    createdAt: row.created_at || '',
    created_at: row.created_at || '',
    updatedAt: row.updated_at || '',
    updated_at: row.updated_at || '',
  };
}

function normalizeCloudEmail(value = '') {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw cloudApiError('email_invalid', '请输入有效邮箱。', 400);
  }
  return email;
}

function normalizeCloudEmailPurpose(value = '') {
  const purpose = String(value || '').trim().toLowerCase();
  if (!['register', 'password_reset', 'password_change', 'organization_invitation_reset'].includes(purpose)) {
    throw cloudApiError('email_purpose_invalid', '不支持的邮箱验证码用途。', 400);
  }
  return purpose;
}

function normalizeCloudEmailCode(value = '') {
  const code = String(value || '').trim();
  if (!/^\d{6}$/.test(code)) throw cloudApiError('email_code_invalid', '请输入 6 位邮箱验证码。', 400);
  return code;
}

function validateCloudPassword(value = '') {
  const password = String(value || '');
  if (password.length < 8) throw cloudApiError('password_too_short', '密码至少需要 8 位。', 400);
  if (password.length > 128) throw cloudApiError('password_too_long', '密码不能超过 128 位。', 400);
  return password;
}

function normalizeCloudDisplayName(value = '', fallback = '') {
  const displayName = String(value || '').trim() || String(fallback || '').trim() || 'Janus 用户';
  if (displayName.length > 80) throw cloudApiError('display_name_too_long', '显示名称不能超过 80 个字符。', 400);
  return displayName;
}

function normalizeCloudUsername(value = '') {
  const username = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!username) throw cloudApiError('username_invalid', '用户名至少需要包含一个字母、数字或中文字符。', 400);
  return username;
}

function uniqueCloudUsername(db, value = '') {
  const base = String(value || 'janus')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fff]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'janus';
  let candidate = base;
  let suffix = 1;
  while (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(candidate)) {
    suffix += 1;
    candidate = `${base.slice(0, Math.max(1, 48 - String(suffix).length - 1))}_${suffix}`;
  }
  return candidate;
}

function hashCloudPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(password, salt, CLOUD_PASSWORD_ITERATIONS, CLOUD_PASSWORD_KEYLEN, CLOUD_PASSWORD_DIGEST).toString('base64url');
  return `pbkdf2$${CLOUD_PASSWORD_DIGEST}$${CLOUD_PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyCloudPassword(password, encoded = '') {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, rawIterations, salt, expected] = parts;
  const iterations = Number(rawIterations);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;
  const actual = crypto.pbkdf2Sync(String(password || ''), salt, iterations, Buffer.from(expected, 'base64url').length, digest).toString('base64url');
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashCloudToken(token = '') {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function hashCloudEmailCode({ email = '', purpose = '', code = '', emailCodeSecret = '' } = {}) {
  return crypto.createHmac('sha256', String(emailCodeSecret))
    .update(`${String(email).toLowerCase()}\n${purpose}\n${code}`)
    .digest('hex');
}

function verifyCloudEmailCode(db, { email = '', purpose = '', code = '', emailCodeSecret = '' } = {}) {
  if (!emailCodeSecret) throw cloudApiError('email_delivery_unavailable', '邮箱验证码服务尚未配置。', 503);
  const normalizedEmail = normalizeCloudEmail(email);
  const normalizedPurpose = normalizeCloudEmailPurpose(purpose);
  const normalizedCode = normalizeCloudEmailCode(code);
  const row = db.prepare(
    `SELECT * FROM auth_email_verifications
     WHERE email = ? COLLATE NOCASE AND purpose = ? AND consumed = 0
     ORDER BY created_at DESC LIMIT 1`,
  ).get(normalizedEmail, normalizedPurpose);
  if (!row) throw cloudApiError('email_code_required', '请先获取邮箱验证码。', 400);
  if (Number(row.attempt_count || 0) >= CLOUD_EMAIL_CODE_MAX_ATTEMPTS) {
    throw cloudApiError('email_code_attempts_exceeded', '验证码尝试次数过多，请重新获取。', 400);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('UPDATE auth_email_verifications SET consumed = 1 WHERE id = ?').run(row.id);
    throw cloudApiError('email_code_expired', '邮箱验证码已过期，请重新获取。', 400);
  }
  const expected = hashCloudEmailCode({
    email: normalizedEmail,
    purpose: normalizedPurpose,
    code: normalizedCode,
    emailCodeSecret,
  });
  const left = Buffer.from(String(row.code_hash || ''), 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    db.prepare('UPDATE auth_email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?').run(row.id);
    throw cloudApiError('email_code_invalid', '邮箱验证码不正确。', 400);
  }
  return row;
}

function consumeCloudEmailCode(db, verification = {}) {
  const result = db.prepare(
    'UPDATE auth_email_verifications SET consumed = 1 WHERE id = ? AND consumed = 0',
  ).run(verification.id);
  if (Number(result.changes || 0) !== 1) {
    throw cloudApiError('email_code_consumed', '邮箱验证码已使用，请重新获取。', 400);
  }
}

function createCloudMailerFromEnv(env = process.env) {
  const smtpUrl = String(env.SMTP_URL || env.JANUS_SMTP_URL || '').trim();
  const smtpHost = String(env.SMTP_HOST || env.JANUS_SMTP_HOST || '').trim();
  const smtpUser = String(env.SMTP_USER || env.JANUS_SMTP_USER || '').trim();
  const smtpPass = String(env.SMTP_PASS || env.JANUS_SMTP_PASS || '');
  const mailFrom = String(env.MAIL_FROM || env.JANUS_MAIL_FROM || (smtpUser ? `Janus <${smtpUser}>` : '')).trim();
  if ((!smtpUrl && !smtpHost) || !mailFrom) {
    return {
      configured: false,
      async sendEmailCode() {
        throw new Error('SMTP is not configured.');
      },
    };
  }
  const transport = createMailTransport({
    mailProvider: 'smtp',
    smtpUrl,
    smtpHost,
    smtpPort: Number(env.SMTP_PORT || env.JANUS_SMTP_PORT || 587),
    smtpSecure: ['1', 'true', 'yes', 'on'].includes(String(env.SMTP_SECURE || env.JANUS_SMTP_SECURE || '').toLowerCase()),
    smtpUser,
    smtpPass,
  });
  return {
    configured: true,
    async sendEmailCode({ email, purpose, code, expiresAt }) {
      const expiresMinutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
      await transport.sendMail({
        from: mailFrom,
        to: email,
        subject: cloudEmailSubject(purpose),
        text: [
          `你的 Janus 邮箱验证码是：${code}`,
          `验证码将在 ${expiresMinutes} 分钟后失效。`,
          '如果不是你本人操作，请忽略这封邮件。',
        ].join('\n'),
      });
    },
  };
}

function cloudEmailSubject(purpose = '') {
  if (purpose === 'password_reset') return 'Janus 密码重置验证码';
  if (purpose === 'password_change') return 'Janus 修改密码验证码';
  if (purpose === 'organization_invitation_reset') return 'Janus 组织邀请码重置验证码';
  return 'Janus 注册验证码';
}


export {
  registerCloudUser,
  sendCloudEmailCode,
  resetCloudUserPassword,
  loginCloudUser,
  refreshCloudSession,
  logoutCloudSession,
  requireCloudAuth,
  suspendCloudUser,
  reactivateCloudUser,
  recordCloudAccountAccess,
  createCloudSession,
  updateCloudUserProfile,
  updateCloudUserPassword,
  cloudUserPayload,
  normalizeCloudEmail,
  normalizeCloudEmailPurpose,
  normalizeCloudEmailCode,
  validateCloudPassword,
  normalizeCloudDisplayName,
  normalizeCloudUsername,
  uniqueCloudUsername,
  hashCloudPassword,
  verifyCloudPassword,
  hashCloudToken,
  hashCloudEmailCode,
  verifyCloudEmailCode,
  consumeCloudEmailCode,
  createCloudMailerFromEnv,
  cloudEmailSubject,
};
