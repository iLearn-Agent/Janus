import crypto from 'node:crypto';

import { all, get, run } from './db.js';
import { newId, nowIso } from './utils.js';
import { hashPassword, validatePassword, verifyPassword } from './modules/identity/index.js';
import { installAuthSocialMethods } from './modules/social/index.js';
import { normalizeProfileAvatarUrl, profileAvatarUrlValidation } from '../shared/profileAvatar.js';
import { personalAccountId } from '../shared/accountWorkspaces.js';

const ACTIVE_USER_KEY = 'auth:active_user_id';
const NEXT_USER_KEY = 'auth:next_user_num';
const DEFAULT_ADMIN_ID = 'local_admin';
const DEFAULT_ADMIN_EMAIL = 'admin@janus.local';
const DEFAULT_RESET_PASSWORD = 'opl12345';
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_RESEND_MS = 60 * 1000;

export class AuthService {
  constructor(db, { autoActivateDefaultAdmin = true } = {}) {
    this.db = db;
    this.autoActivateDefaultAdmin = autoActivateDefaultAdmin !== false;
    this.organizationSecondaryVerificationOrganizations = new Set();
    this.ensureReady();
  }

  ensureReady() {
    const count = Number(get(this.db, 'SELECT COUNT(*) AS count FROM auth_users')?.count || 0);
    if (count === 0) {
      run(
        this.db,
        `INSERT INTO auth_users (id, email, display_name, username, role, password_hash, email_verified, remote_id)
         VALUES (?, ?, ?, ?, 'admin', '', 1, ?)`,
        [DEFAULT_ADMIN_ID, DEFAULT_ADMIN_EMAIL, 'Admin', 'admin', ''],
      );
      if (this.autoActivateDefaultAdmin) this.setActiveUser(DEFAULT_ADMIN_ID);
      else this.settingSet(ACTIVE_USER_KEY, '');
      this.settingSet(NEXT_USER_KEY, '1');
    }
    this.ensureAtLeastOneAdmin();
    const active = this.settingGet(ACTIVE_USER_KEY, '');
    if (active && (!this.getUser(active) || (!this.autoActivateDefaultAdmin && this.isImplicitDefaultAdmin(active)))) {
      this.settingSet(ACTIVE_USER_KEY, '');
    }
  }

  isImplicitDefaultAdmin(userId = '') {
    if (String(userId || '') !== DEFAULT_ADMIN_ID) return false;
    const row = get(this.db, 'SELECT remote_id, auth_provider FROM auth_users WHERE id = ?', [DEFAULT_ADMIN_ID]);
    return Boolean(row && !row.remote_id && row.auth_provider !== 'cloud');
  }

  currentUser() {
    const activeId = this.settingGet(ACTIVE_USER_KEY, '');
    return activeId ? this.getUser(activeId) : null;
  }

  requireUser() {
    const user = this.currentUser();
    if (!user) throw new Error('请先登录账号。');
    return user;
  }

  requireAdmin() {
    const user = this.requireUser();
    if (user.role !== 'admin') throw new Error('需要管理员权限。');
    return user;
  }

  login({ method = 'password', identifier = '', email = '', phone = '', password = '', code = '', newPassword = '' } = {}) {
    const cleanMethod = String(method || 'password').trim().toLowerCase();
    if (cleanMethod === 'email_code') return this.loginWithEmailCode({ email: email || identifier, code, newPassword: newPassword || password });
    if (cleanMethod === 'phone_code') return this.loginWithPhoneCode({ phone: phone || identifier, code, newPassword: newPassword || password });

    const row = this.findUserByIdentifier(identifier || email || phone);
    if (!row) throw new Error('账号不存在，请先注册。');
    if (row.id === DEFAULT_ADMIN_ID && !row.password_hash) throw new Error('内置管理员账号不支持直接登录。');
    if (!row.password_hash) throw new Error('该账号尚未设置密码，请通过忘记密码设置。');
    if (!verifyPassword(password, row.password_hash || '')) throw new Error('密码不正确。');
    if (row.email && !isPhoneOnlyEmail(row.email) && !row.email_verified) throw new Error('邮箱尚未验证，请先完成邮箱验证。');
    this.clearOrganizationSecondaryVerification();
    this.setActiveUser(row.id);
    return this.sessionPayload(this.payload(row));
  }

  register(payload = {}) {
    return this.registerWithEmail(payload);
  }

  registerWithEmail({ email = '', password = '', displayName = '' } = {}) {
    const cleanEmail = normalizeEmail(email);
    validatePassword(password);
    if (get(this.db, 'SELECT id FROM auth_users WHERE lower(email) = ?', [cleanEmail])) {
      throw new Error('该邮箱已被注册。');
    }
    const id = newId('user');
    const name = String(displayName || '').trim() || `Janus${id.slice(-6)}`;
    const username = uniqueUsername(this.db, name || id);
    run(
      this.db,
      `INSERT INTO auth_users (
        id, email, phone, display_name, username, role, password_hash, email_verified,
        auth_provider, remote_id, updated_at
       ) VALUES (?, ?, '', ?, ?, 'member', ?, 1, 'local_mock', ?, ?)`,
      [id, cleanEmail, name, username, hashPassword(password), '', nowIso()],
    );
    this.clearOrganizationSecondaryVerification();
    this.setActiveUser(id);
    return this.sessionPayload(this.getUser(id));
  }

  loginWithEmailCode({ email = '', code = '', newPassword = '' } = {}) {
    const cleanEmail = normalizeEmail(email);
    this.consumeEmailCode({ email: cleanEmail, purpose: 'login', code });
    let row = get(this.db, 'SELECT * FROM auth_users WHERE lower(email) = ?', [cleanEmail]);
    if (!row) {
      row = this.createVerifiedUser({
        email: cleanEmail,
        phone: '',
        displayName: cleanEmail.split('@')[0],
        password: newPassword,
        emailVerified: 1,
        phoneVerified: 0,
      });
    } else if (newPassword) {
      validatePassword(newPassword);
      run(this.db, 'UPDATE auth_users SET password_hash = ?, email_verified = 1, updated_at = ? WHERE id = ?', [hashPassword(newPassword), nowIso(), row.id]);
      row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [row.id]);
    } else if (!row.email_verified) {
      run(this.db, 'UPDATE auth_users SET email_verified = 1, updated_at = ? WHERE id = ?', [nowIso(), row.id]);
      row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [row.id]);
    }
    this.clearOrganizationSecondaryVerification();
    this.setActiveUser(row.id);
    return this.sessionPayload(this.payload(row));
  }

  loginWithPhoneCode({ phone = '', code = '', newPassword = '' } = {}) {
    const cleanPhone = normalizePhone(phone);
    this.consumeCode({ target: cleanPhone, purpose: 'login', code });
    let row = get(this.db, 'SELECT * FROM auth_users WHERE phone = ?', [cleanPhone]);
    if (!row) {
      row = this.createVerifiedUser({
        email: phoneEmail(cleanPhone),
        phone: cleanPhone,
        displayName: `用户${cleanPhone.slice(-4)}`,
        password: newPassword,
        emailVerified: 0,
        phoneVerified: 1,
      });
    } else if (newPassword) {
      validatePassword(newPassword);
      run(this.db, 'UPDATE auth_users SET password_hash = ?, phone_verified = 1, updated_at = ? WHERE id = ?', [hashPassword(newPassword), nowIso(), row.id]);
      row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [row.id]);
    } else if (!row.phone_verified) {
      run(this.db, 'UPDATE auth_users SET phone_verified = 1, updated_at = ? WHERE id = ?', [nowIso(), row.id]);
      row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [row.id]);
    }
    this.clearOrganizationSecondaryVerification();
    this.setActiveUser(row.id);
    return this.sessionPayload(this.payload(row));
  }

  createVerifiedUser({ email = '', phone = '', displayName = '', password = '', emailVerified = 0, phoneVerified = 0 } = {}) {
    if (password) validatePassword(password);
    const id = newId('user');
    const name = String(displayName || '').trim() || `Janus${id.slice(-6)}`;
    const username = uniqueUsername(this.db, name || id);
    run(
      this.db,
      `INSERT INTO auth_users (
        id, email, phone, display_name, username, role, password_hash, email_verified, phone_verified,
        auth_provider, remote_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'member', ?, ?, ?, 'local_mock', ?, ?)`,
      [id, email, phone, name, username, password ? hashPassword(password) : '', emailVerified ? 1 : 0, phoneVerified ? 1 : 0, '', nowIso()],
    );
    return get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [id]);
  }

  sendEmailCode({ email = '', phone = '', target = '', method = 'email', purpose = 'register' } = {}) {
    const cleanMethod = String(method || (phone ? 'phone' : 'email')).trim().toLowerCase();
    const cleanTarget = cleanMethod === 'phone' ? normalizePhone(phone || target) : normalizeEmail(email || target);
    const cleanPurpose = normalizeEmailPurpose(purpose);
    const existing = cleanMethod === 'phone'
      ? get(this.db, 'SELECT * FROM auth_users WHERE phone = ?', [cleanTarget])
      : get(this.db, 'SELECT * FROM auth_users WHERE lower(email) = ?', [cleanTarget]);
    if (cleanPurpose === 'register' && existing) throw new Error('该邮箱已被注册。');
    if (cleanPurpose === 'password_reset' && !existing) throw new Error('账号不存在。');
    if (['password_change', 'organization_invitation_reset'].includes(cleanPurpose)) {
      const currentUser = this.requireUser();
      if (cleanMethod !== 'email' || cleanTarget !== String(currentUser.email || '').trim().toLowerCase()) {
        throw new Error('验证码只能发送到当前账号邮箱。');
      }
    }
    const latest = get(
      this.db,
      `SELECT * FROM email_verifications
       WHERE lower(email) = ? AND purpose = ? AND consumed = 0
       ORDER BY created_at DESC LIMIT 1`,
      [cleanTarget, cleanPurpose],
    );
    const elapsedMs = Date.now() - new Date(latest?.created_at || 0).getTime();
    if (latest && Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < EMAIL_CODE_RESEND_MS
      && new Date(latest.expires_at).getTime() > Date.now()) {
      return {
        ok: true,
        provider: 'local_mock',
        delivery: 'local_debug',
        method: cleanMethod,
        target: cleanTarget,
        email: cleanMethod === 'email' ? cleanTarget : '',
        phone: cleanMethod === 'phone' ? cleanTarget : '',
        purpose: cleanPurpose,
        expiresAt: latest.expires_at,
        retryAfterSeconds: Math.max(1, Math.ceil((EMAIL_CODE_RESEND_MS - elapsedMs) / 1000)),
        reused: true,
        devCode: String(latest.code),
      };
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString();
    run(this.db, 'UPDATE email_verifications SET consumed = 1 WHERE lower(email) = ? AND purpose = ? AND consumed = 0', [cleanTarget, cleanPurpose]);
    run(
      this.db,
      `INSERT INTO email_verifications (id, email, purpose, code, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [newId(`${cleanMethod}_code`), cleanTarget, cleanPurpose, code, expiresAt],
    );
    return {
      ok: true,
      provider: 'local_mock',
      delivery: 'local_debug',
      method: cleanMethod,
      target: cleanTarget,
      email: cleanMethod === 'email' ? cleanTarget : '',
      phone: cleanMethod === 'phone' ? cleanTarget : '',
      purpose: cleanPurpose,
      expiresAt,
      retryAfterSeconds: Math.ceil(EMAIL_CODE_RESEND_MS / 1000),
      reused: false,
      devCode: code,
    };
  }

  verifyEmail({ email = '', code = '', purpose = 'email_verify' } = {}) {
    const user = this.requireUser();
    const cleanEmail = normalizeEmail(email || user.email);
    if (cleanEmail !== String(user.email || '').toLowerCase()) throw new Error('只能验证当前账号邮箱。');
    this.consumeEmailCode({ email: cleanEmail, purpose, code });
    run(this.db, 'UPDATE auth_users SET email_verified = 1, updated_at = ? WHERE id = ?', [nowIso(), user.id]);
    return this.getUser(user.id);
  }

  resetPasswordByEmail({ method = 'email', email = '', phone = '', target = '', code = '', newPassword = '' } = {}) {
    const cleanMethod = String(method || (phone ? 'phone' : 'email')).trim().toLowerCase();
    const cleanTarget = cleanMethod === 'phone' ? normalizePhone(phone || target) : normalizeEmail(email || target);
    validatePassword(newPassword);
    const row = cleanMethod === 'phone'
      ? get(this.db, 'SELECT * FROM auth_users WHERE phone = ?', [cleanTarget])
      : get(this.db, 'SELECT * FROM auth_users WHERE lower(email) = ?', [cleanTarget]);
    if (!row) throw new Error('账号不存在。');
    this.consumeCode({ target: cleanTarget, purpose: 'password_reset', code });
    run(this.db, 'UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(newPassword), nowIso(), row.id]);
    return { ok: true, user_id: row.id };
  }

  consumeEmailCode({ email = '', purpose = 'register', code = '' } = {}) {
    return this.consumeCode({ target: normalizeEmail(email), purpose, code });
  }

  consumeCode({ target = '', purpose = 'register', code = '' } = {}) {
    const cleanTarget = String(target || '').trim().toLowerCase();
    const cleanPurpose = normalizeEmailPurpose(purpose);
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('请输入验证码。');
    const row = get(
      this.db,
      `SELECT * FROM email_verifications
       WHERE lower(email) = ? AND purpose = ? AND consumed = 0
       ORDER BY created_at DESC LIMIT 1`,
      [cleanTarget, cleanPurpose],
    );
    if (!row) throw new Error('请先获取验证码。');
    if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('验证码已过期。');
    if (String(row.code) !== cleanCode) throw new Error('验证码不正确。');
    run(this.db, 'UPDATE email_verifications SET consumed = 1 WHERE id = ?', [row.id]);
    return row;
  }

  logout() {
    this.clearOrganizationSecondaryVerification();
    this.settingSet(ACTIVE_USER_KEY, '');
    return { ok: true };
  }

  clearOrganizationSecondaryVerification() {
    this.organizationSecondaryVerificationOrganizations.clear();
  }

  rememberOrganizationSecondaryVerification(organizationId = '') {
    const id = String(organizationId || '').trim();
    if (id) this.organizationSecondaryVerificationOrganizations.add(id);
  }

  hasOrganizationSecondaryVerification(organizationId = '') {
    return this.organizationSecondaryVerificationOrganizations.has(String(organizationId || '').trim());
  }

  profile() {
    const user = this.requireUser();
    const sessions = Number(get(this.db, 'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [user.id])?.count || 0);
    return { ...user, session_count: sessions };
  }

  updateProfile(payload = {}) {
    const { displayName = '', email = '', username = '' } = payload;
    const user = this.requireUser();
    const nextName = String(displayName || user.display_name || user.displayName || '').trim();
    const nextEmail = normalizeEmail(email || user.email);
    const nextUsername = normalizeUsername(username || user.username || nextName || user.id);
    const avatarProvided = Object.hasOwn(payload, 'avatarUrl') || Object.hasOwn(payload, 'avatar_url');
    const rawAvatarUrl = avatarProvided
      ? String(payload.avatarUrl ?? payload.avatar_url ?? '').trim()
      : String(user.avatarUrl || user.avatar_url || '').trim();
    const avatarValidation = profileAvatarUrlValidation(rawAvatarUrl, { allowLegacyLocal: !avatarProvided });
    if (!avatarValidation.valid) throw new Error(avatarValidation.reason);
    const nextAvatarUrl = avatarValidation.value;
    if (!nextName) throw new Error('显示名不能为空。');
    const conflict = get(this.db, 'SELECT id FROM auth_users WHERE lower(email) = ? AND id <> ?', [nextEmail, user.id]);
    if (conflict) throw new Error('该邮箱已被其他账号使用。');
    const usernameConflict = get(this.db, 'SELECT id FROM auth_users WHERE lower(username) = ? AND id <> ?', [nextUsername.toLowerCase(), user.id]);
    if (usernameConflict) throw new Error('该用户名已被其他账号使用。');
    const emailVerified = nextEmail === String(user.email || '').toLowerCase() ? (user.emailVerified ? 1 : 0) : 0;
    run(
      this.db,
      `UPDATE auth_users
       SET display_name = ?, email = ?, username = ?, avatar_url = ?, email_verified = ?, updated_at = ?
       WHERE id = ?`,
      [nextName, nextEmail, nextUsername, nextAvatarUrl, emailVerified, nowIso(), user.id],
    );
    run(this.db, `UPDATE account_workspace_memberships
      SET display_name=?,avatar_url=?,updated_at=? WHERE user_id=?`, [nextName, nextAvatarUrl, nowIso(), user.id]);
    return this.getUser(user.id);
  }

  queueProfileUpdate({ userId = '', payload = {} } = {}) {
    const user = this.getUser(userId || this.requireUser().id);
    if (!user) throw new Error('账号不存在。');
    const avatarProvided = Object.hasOwn(payload, 'avatarUrl') || Object.hasOwn(payload, 'avatar_url');
    const avatarValidation = avatarProvided
      ? profileAvatarUrlValidation(payload.avatarUrl ?? payload.avatar_url ?? '')
      : { valid: true, value: '' };
    if (!avatarValidation.valid) throw new Error(avatarValidation.reason);
    const canonicalPayload = {
      displayName: String(payload.displayName ?? payload.display_name ?? user.displayName ?? user.display_name ?? '').trim(),
      email: String(payload.email ?? user.email ?? '').trim().toLowerCase(),
      username: String(payload.username ?? user.username ?? '').trim(),
      ...(avatarProvided ? { avatarUrl: avatarValidation.value } : {}),
    };
    const payloadJson = JSON.stringify(canonicalPayload);
    const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
    const commandId = newId('profile_update');
    const now = nowIso();
    run(this.db, `INSERT INTO profile_update_outbox(
      user_id,command_id,payload_hash,payload_json,status,attempt_count,next_attempt_at,last_error,created_at,updated_at,completed_at
    ) VALUES(?,?,?,?,'pending',0,'','',?,?,'') ON CONFLICT(user_id) DO UPDATE SET
      command_id=excluded.command_id,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,
      status='pending',attempt_count=0,next_attempt_at='',last_error='',updated_at=excluded.updated_at,completed_at=''`, [
      user.id, commandId, payloadHash, payloadJson, now, now,
    ]);
    return this.profileUpdateOutbox(user.id);
  }

  profileUpdateOutbox(userId = '') {
    const cleanUserId = String(userId || '').trim();
    const row = cleanUserId ? get(this.db, 'SELECT * FROM profile_update_outbox WHERE user_id=?', [cleanUserId]) : null;
    if (!row) return null;
    return { ...row, payload: parseProfileUpdatePayload(row.payload_json) };
  }

  pendingProfileUpdates({ limit = 20 } = {}) {
    return all(this.db, `SELECT * FROM profile_update_outbox
      WHERE status IN ('pending','failed') AND (next_attempt_at='' OR next_attempt_at<=?)
      ORDER BY updated_at,user_id LIMIT ?`, [nowIso(), Math.max(1, Math.min(100, Number(limit) || 20))])
      .map((row) => ({ ...row, payload: parseProfileUpdatePayload(row.payload_json) }));
  }

  markProfileUpdateSending(userId = '') {
    run(this.db, `UPDATE profile_update_outbox SET status='sending',updated_at=? WHERE user_id=?`, [nowIso(), String(userId || '')]);
  }

  markProfileUpdateCompleted(userId = '') {
    const now = nowIso();
    run(this.db, `UPDATE profile_update_outbox SET status='completed',attempt_count=attempt_count+1,
      next_attempt_at='',last_error='',payload_json='{}',updated_at=?,completed_at=? WHERE user_id=?`, [now, now, String(userId || '')]);
  }

  markProfileUpdateFailed(userId = '', error = '', { retryable = true } = {}) {
    const now = nowIso();
    const row = get(this.db, 'SELECT attempt_count FROM profile_update_outbox WHERE user_id=?', [String(userId || '')]);
    const attemptCount = Number(row?.attempt_count || 0) + 1;
    const delayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.min(6, Math.max(0, attemptCount - 1))));
    const nextAttemptAt = retryable ? new Date(Date.now() + delayMs).toISOString() : '9999-12-31T23:59:59.999Z';
    run(this.db, `UPDATE profile_update_outbox SET status='failed',attempt_count=?,next_attempt_at=?,last_error=?,updated_at=?
      WHERE user_id=?`, [attemptCount, nextAttemptAt, String(error || '').slice(0, 1000), now, String(userId || '')]);
  }

  updatePassword({ currentPassword = '', newPassword = '' } = {}) {
    const user = this.requireUser();
    const row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [user.id]);
    if (!verifyPassword(currentPassword, row.password_hash || '')) throw new Error('当前密码不正确。');
    validatePassword(newPassword);
    run(this.db, 'UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(newPassword), nowIso(), user.id]);
    return { ok: true };
  }

  listUsers() {
    this.requireAdmin();
    return all(
      this.db,
      `SELECT id, email, phone, display_name, username, avatar_url, remote_id, auth_provider, email_verified, phone_verified, role, created_at, updated_at
       FROM auth_users
       ORDER BY role = 'admin' DESC, created_at ASC`,
    ).map((row) => ({
      ...this.payload(row),
      session_count: Number(get(this.db, 'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [row.id])?.count || 0),
    }));
  }

  updateUserRole(userId, role) {
    const admin = this.requireAdmin();
    const nextRole = normalizeRole(role);
    const row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [String(userId || '')]);
    if (!row) throw new Error('账号不存在。');
    if (row.role === 'admin' && nextRole !== 'admin' && this.adminCount() <= 1) {
      throw new Error('不能降级最后一名管理员。');
    }
    run(this.db, 'UPDATE auth_users SET role = ?, updated_at = ? WHERE id = ?', [nextRole, nowIso(), row.id]);
    return { ...this.getUser(row.id), updated_by: admin.id };
  }

  resetUserPassword(userId) {
    const admin = this.requireAdmin();
    const id = String(userId || '');
    if (id === admin.id) throw new Error('不能通过管理员重置当前登录账号。');
    const row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [id]);
    if (!row) throw new Error('账号不存在。');
    run(this.db, 'UPDATE auth_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hashPassword(DEFAULT_RESET_PASSWORD), nowIso(), id]);
    return { ok: true, user_id: id, reset_by: admin.id, password: DEFAULT_RESET_PASSWORD };
  }

  deleteUser(userId) {
    const admin = this.requireAdmin();
    const id = String(userId || '');
    if (id === admin.id) throw new Error('不能删除当前登录账号。');
    const row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [id]);
    if (!row) throw new Error('账号不存在。');
    if (row.role === 'admin' && this.adminCount() <= 1) throw new Error('不能删除最后一名管理员。');
    run(this.db, 'DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)', [id]);
    run(this.db, 'DELETE FROM sessions WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM friend_requests WHERE requester_id = ? OR recipient_id = ?', [id, id]);
    run(this.db, 'DELETE FROM friendships WHERE user_a_id = ? OR user_b_id = ?', [id, id]);
    run(this.db, 'DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [id, id]);
    run(this.db, 'DELETE FROM contact_organization_members WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM contact_organizations WHERE owner_user_id = ?', [id]);
    run(this.db, 'DELETE FROM social_messages WHERE sender_user_id = ? OR recipient_user_id = ?', [id, id]);
    run(this.db, 'DELETE FROM social_conversation_preference_outbox WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM social_conversation_preferences WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM social_inbox_preference_outbox WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM social_inbox_preferences WHERE user_id = ?', [id]);
    run(this.db, 'DELETE FROM auth_users WHERE id = ?', [id]);
    return { ok: true, deleted_user_id: id };
  }


  importCloudUser(user = {}, { activate = false } = {}) {
    const remoteId = String(user.id || user.remoteId || user.remote_id || '').trim();
    if (!remoteId) return null;
    const bound = get(this.db, 'SELECT * FROM auth_users WHERE remote_id = ?', [remoteId]);
    const providedEmail = String(user.email || '').trim().toLowerCase();
    let email = providedEmail || String(bound?.email || `${remoteId}@cloud.janus.local`).trim().toLowerCase();
    const emailOwner = get(this.db, 'SELECT * FROM auth_users WHERE lower(email) = ?', [email]);
    const reusableVerifiedLocal = !bound && emailOwner && !emailOwner.remote_id && Number(emailOwner.email_verified) === 1;
    if (bound && emailOwner && emailOwner.id !== bound.id) {
      email = bound.email;
    } else if (!bound && emailOwner && !reusableVerifiedLocal) {
      // Contact snapshots can omit or redact an email and reuse a local placeholder. Never
      // rebind the existing account; keep both stable remote identities with a synthetic alias.
      email = uniqueCloudContactEmail(this.db, remoteId);
    }
    const verifiedEmailMatch = !bound
      ? get(this.db, `SELECT * FROM auth_users
         WHERE lower(email) = ? AND email_verified = 1 AND remote_id = ''
         ORDER BY created_at ASC LIMIT 1`, [email])
      : null;
    const localId = bound?.id || verifiedEmailMatch?.id || remoteId;
    const providedDisplayName = String(user.displayName || user.display_name || '').trim();
    const displayName = providedDisplayName
      || String(bound?.display_name || verifiedEmailMatch?.display_name || user.username || email.split('@')[0] || remoteId).trim();
    const username = bound?.username || verifiedEmailMatch?.username || uniqueUsername(this.db, String(user.username || remoteId).trim());
    const phone = String(user.phone || bound?.phone || verifiedEmailMatch?.phone || '');
    const cloudAvatarUrl = Object.hasOwn(user, 'avatarUrl') || Object.hasOwn(user, 'avatar_url')
      ? normalizeProfileAvatarUrl(user.avatarUrl ?? user.avatar_url ?? '')
      : '';
    const cloudUpdatedAt = String(user.updatedAt || user.updated_at || '').trim();
    const localAvatarSource = bound || verifiedEmailMatch || null;
    const localUpdatedAt = String(localAvatarSource?.updated_at || '').trim();
    const cloudTime = Date.parse(cloudUpdatedAt || '');
    const localTime = Date.parse(localUpdatedAt || '');
    const currentLocalUserId = String(this.currentUser()?.id || '');
    const keepLocalAvatar = localAvatarSource
      && localId === currentLocalUserId
      && localUpdatedAt
      && (!cloudUpdatedAt || (Number.isFinite(localTime) && Number.isFinite(cloudTime) && localTime > cloudTime));
    const hasCloudAvatar = Object.hasOwn(user, 'avatarUrl') || Object.hasOwn(user, 'avatar_url');
    const avatarUrl = keepLocalAvatar
      ? String(localAvatarSource.avatar_url || '')
      : hasCloudAvatar
        ? cloudAvatarUrl
        : String(localAvatarSource?.avatar_url || '');
    const emailVerified = Object.hasOwn(user, 'emailVerified') || Object.hasOwn(user, 'email_verified')
      ? Boolean(user.emailVerified || user.email_verified)
      : Boolean(bound?.email_verified || verifiedEmailMatch?.email_verified);
    const phoneVerified = Object.hasOwn(user, 'phoneVerified') || Object.hasOwn(user, 'phone_verified')
      ? Boolean(user.phoneVerified || user.phone_verified)
      : Boolean(bound?.phone_verified || verifiedEmailMatch?.phone_verified);
    const role = user.role ? normalizeRole(user.role) : normalizeRole(bound?.role || verifiedEmailMatch?.role || 'member');
    const now = String(user.updatedAt || user.updated_at || nowIso());
    run(
      this.db,
      `INSERT INTO auth_users (
        id, email, phone, display_name, username, avatar_url, remote_id, remote_bound_at, auth_provider,
        email_verified, phone_verified, role, password_hash, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'cloud', ?, ?, ?, '', ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email, phone = excluded.phone, display_name = excluded.display_name,
         username = excluded.username, avatar_url = excluded.avatar_url, remote_id = excluded.remote_id,
         remote_bound_at = CASE WHEN auth_users.remote_bound_at = '' THEN excluded.remote_bound_at ELSE auth_users.remote_bound_at END,
         auth_provider = 'cloud', email_verified = excluded.email_verified,
         phone_verified = excluded.phone_verified, role = excluded.role, updated_at = excluded.updated_at`,
      [
        localId,
        email,
        phone,
        displayName,
        username,
        avatarUrl,
        remoteId,
        nowIso(),
        emailVerified ? 1 : 0,
        phoneVerified ? 1 : 0,
        role,
        now,
      ],
    );
    run(this.db, `UPDATE account_workspace_memberships
      SET display_name=?,avatar_url=?,updated_at=? WHERE user_id=?`, [displayName, avatarUrl, now, localId]);
    if (activate) this.setActiveUser(localId);
    return this.getUser(localId);
  }

  bindRemoteIdentity({ localUserId = '', remoteId = '' } = {}) {
    const local = this.getUser(localUserId);
    const cleanRemoteId = String(remoteId || '').trim();
    if (!local || !cleanRemoteId) throw new Error('缺少本地账号或云端账号身份。');
    const conflict = get(this.db, 'SELECT id FROM auth_users WHERE remote_id = ? AND id <> ?', [cleanRemoteId, local.id]);
    if (conflict) throw new Error('该云端账号已绑定其他本地用户。');
    run(this.db, `UPDATE auth_users
      SET remote_id = ?, remote_bound_at = CASE WHEN remote_bound_at = '' THEN ? ELSE remote_bound_at END,
          auth_provider = 'cloud', updated_at = ? WHERE id = ?`,
    [cleanRemoteId, nowIso(), nowIso(), local.id]);
    return this.getUser(local.id);
  }



  canAccessSession(user, session, requiredWorkspace = '') {
    if (!user || !session) return false;
    if (session.userId && session.userId !== user.id) return false;
    const workspaceId = String(session.accountWorkspaceId || session.workspaceId || 'workspace_personal');
    const requiredWorkspaceId = String(typeof requiredWorkspace === 'object' ? requiredWorkspace?.workspaceId || '' : requiredWorkspace || '').trim();
    if (requiredWorkspaceId && workspaceId !== requiredWorkspaceId) return false;
    return Boolean(get(this.db, `SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=? AND user_id=? AND status='active'`, [workspaceId, user.id]));
  }

  getUser(id) {
    const row = get(this.db, 'SELECT * FROM auth_users WHERE id = ?', [String(id || '')]);
    return row ? this.payload(row) : null;
  }

  findUserByIdentifier(identifier = '') {
    const value = String(identifier || '').trim().toLowerCase();
    if (!value) throw new Error('请输入账号、手机号或邮箱。');
    if (value.includes('@')) return get(this.db, 'SELECT * FROM auth_users WHERE lower(email) = ?', [value]);
    const phone = value.replace(/[^\d+]/g, '');
    if (/^\+?\d{6,20}$/.test(phone)) {
      const normalizedPhone = normalizePhone(phone);
      const byPhone = get(this.db, 'SELECT * FROM auth_users WHERE phone = ?', [normalizedPhone]);
      if (byPhone) return byPhone;
    }
    return get(this.db, 'SELECT * FROM auth_users WHERE lower(id) = ? OR lower(username) = ?', [value, value]);
  }

  setActiveUser(id) {
    const userId = String(id || '').trim();
    this.settingSet(ACTIVE_USER_KEY, userId);
    if (!userId || !get(this.db, 'SELECT 1 FROM auth_users WHERE id=?', [userId])) return;
    const now = nowIso();
    const user = get(this.db, 'SELECT * FROM auth_users WHERE id=?', [userId]);
    const principalKind = user.auth_provider === 'cloud' && user.password_hash
      ? 'hybrid' : user.auth_provider === 'cloud' ? 'cloud' : 'local';
    run(this.db, `INSERT INTO auth_principals(id,user_id,principal_kind,status,created_at,updated_at)
      VALUES(?, ?, ?, 'active', ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      principal_kind=excluded.principal_kind,status='active',updated_at=excluded.updated_at`, [
      `principal_${userId}`, userId, principalKind, now, now,
    ]);
    const accountId = personalAccountId(userId);
    run(this.db, `INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES(?,'personal',?,'',?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
      owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at`, [
      accountId, userId, user.display_name || '个人账号', user.created_at || now, now,
    ]);
    run(this.db, `INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
      VALUES(?,?,'owner','active',?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
      role='owner',status='active',updated_at=excluded.updated_at`, [accountId, userId, user.created_at || now, now]);
    run(this.db, `INSERT INTO account_workspace_memberships(
        workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at
      ) VALUES('workspace_personal',?,'owner','active',?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET
      status='active',display_name=excluded.display_name,avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`, [
      userId, user.display_name || '', user.avatar_url || '', user.created_at || now, now,
    ]);
    run(this.db, `INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES(?,'workspace_personal',?,'personal',?,?) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET
      account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at`, [accountId, userId, user.created_at || now, now]);
  }

  payload(row) {
    const role = normalizeRole(row.role || 'member');
    return {
      id: row.id,
      remoteId: row.remote_id || `local:${row.id}`,
      remoteBound: Boolean(row.remote_id),
      remoteBoundAt: row.remote_bound_at || '',
      email: isPhoneOnlyEmail(row.email) ? '' : row.email,
      phone: row.phone || '',
      display_name: row.display_name,
      displayName: row.display_name,
      username: row.username || '',
      avatar_url: row.avatar_url || '',
      avatarUrl: row.avatar_url || '',
      authProvider: row.auth_provider || 'local_mock',
      email_verified: Boolean(row.email_verified),
      emailVerified: Boolean(row.email_verified),
      phone_verified: Boolean(row.phone_verified),
      phoneVerified: Boolean(row.phone_verified),
      role,
      is_admin: role === 'admin',
      isAdmin: role === 'admin',
      created_at: row.created_at,
      updated_at: row.updated_at,
      permissions: permissionsForRole(role),
    };
  }

  sessionPayload(user) {
    const accessToken = `local_access_${crypto.createHash('sha256').update(`${user.id}:${Date.now()}`).digest('hex').slice(0, 24)}`;
    const refreshToken = `local_refresh_${crypto.createHash('sha256').update(`${user.id}:refresh:${Date.now()}`).digest('hex').slice(0, 24)}`;
    return {
      ...user,
      user,
      provider: 'local_mock',
      accessToken,
      refreshToken,
    };
  }

  ensureAtLeastOneAdmin() {
    if (this.adminCount() > 0) return;
    const first = get(this.db, 'SELECT id FROM auth_users ORDER BY created_at ASC LIMIT 1');
    if (first) run(this.db, "UPDATE auth_users SET role = 'admin' WHERE id = ?", [first.id]);
  }

  adminCount() {
    return Number(get(this.db, "SELECT COUNT(*) AS count FROM auth_users WHERE role = 'admin'")?.count || 0);
  }

  nextUserNumber() {
    const current = Math.max(1, Number(this.settingGet(NEXT_USER_KEY, '1') || 1));
    this.settingSet(NEXT_USER_KEY, String(current + 1));
    return current;
  }

  settingGet(key, fallback = '') {
    return get(this.db, 'SELECT value FROM app_settings WHERE key = ?', [key])?.value || fallback;
  }

  settingSet(key, value) {
    run(
      this.db,
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value || '')],
    );
  }
}

function uniqueCloudContactEmail(db, remoteId = '') {
  const safeId = String(remoteId || 'contact').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 96) || 'contact';
  let candidate = `${safeId}@cloud.janus.local`.toLowerCase();
  let suffix = 1;
  while (get(db, 'SELECT id FROM auth_users WHERE lower(email) = ?', [candidate])) {
    candidate = `${safeId}+${suffix}@cloud.janus.local`.toLowerCase();
    suffix += 1;
  }
  return candidate;
}

function parseProfileUpdatePayload(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeEmailPurpose(purpose) {
  const value = String(purpose || 'register').trim().toLowerCase().replace(/-/g, '_');
  if (['register', 'login', 'email_verify', 'password_reset', 'password_change', 'organization_invitation_reset'].includes(value)) return value;
  return 'register';
}

export function permissionsForRole(role = 'member') {
  const admin = role === 'admin';
  return {
    canChat: true,
    canUploadFiles: true,
    canUseArtifacts: true,
    canUseImageGeneration: true,
    canUsePptDepartment: true,
    canManageSkills: true,
    canViewTasks: admin,
    canManageTasks: admin,
    canViewEvolution: admin,
    canRunEvolution: admin,
    canManageUsers: admin,
    canEditCodexConfig: admin,
    canRunDoctor: true,
  };
}

function normalizeRole(role) {
  return String(role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('请输入有效邮箱。');
  return value;
}

function normalizePhone(phone) {
  const value = String(phone || '').trim().replace(/[\s()-]/g, '');
  if (!/^\+?\d{6,20}$/.test(value)) throw new Error('请输入有效手机号。');
  return value;
}

function phoneEmail(phone) {
  return `${normalizePhone(phone).replace(/^\+/, '')}@phone.janus.local`;
}

function isPhoneOnlyEmail(email = '') {
  return String(email || '').toLowerCase().endsWith('@phone.janus.local');
}

function normalizeUsername(value) {
  const base = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return base || `user_${crypto.randomBytes(3).toString('hex')}`;
}

function uniqueUsername(db, value) {
  const base = normalizeUsername(value);
  let candidate = base;
  let suffix = 1;
  while (get(db, 'SELECT id FROM auth_users WHERE lower(username) = ?', [candidate.toLowerCase()])) {
    suffix += 1;
    candidate = `${base}_${suffix}`.slice(0, 32);
  }
  return candidate;
}

installAuthSocialMethods(AuthService.prototype);
