import crypto from 'node:crypto';

import { cloudApiError } from '../../http/index.js';
import { consumeCloudEmailCode, verifyCloudEmailCode, verifyCloudPassword } from '../../identity/index.js';
import { cloudPublicUser } from '../domain/cloudSocialRecords.js';

const ORGANIZATION_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;
const ORGANIZATION_SECONDARY_VERIFICATION_TTL_MS = Math.max(
  60_000,
  Number(process.env.JANUS_ORGANIZATION_SECONDARY_VERIFICATION_TTL_SECONDS || 7 * 24 * 60 * 60) * 1000,
);
const SENSITIVE_ORGANIZATION_ACTIONS = new Set([
  'promote_admin', 'revoke_admin', 'remove_member', 'transfer_owner',
  'update_invitation_code', 'resolve_exit', 'owner_exit',
]);

function cloudOrganizationOverview(db, userId) {
  const rows = db.prepare(
    `SELECT o.*, membership.role AS current_user_role, membership.joined_at AS current_user_joined_at,
            (SELECT COUNT(*) FROM contact_organization_members count_members WHERE count_members.organization_id = o.id) AS member_count
     FROM contact_organizations o
     JOIN contact_organization_members membership ON membership.organization_id = o.id
     WHERE membership.user_id = ?
     ORDER BY CASE WHEN membership.role = 'owner' THEN 0 ELSE 1 END, lower(o.name), o.organization_number`,
  ).all(userId);
  return {
    organizations: rows.map((row) => cloudOrganizationPayload(db, row)),
    organizationExitRequests: cloudOrganizationExitRequests(db, userId),
    organizationNotices: cloudOrganizationNotices(db, userId),
  };
}

function createCloudOrganization(db, userId, payload = {}) {
  const name = normalizeOrganizationName(payload.name);
  const verificationCode = normalizeOrganizationVerificationCode(payload.verificationCode || payload.secret);
  const id = `organization_${crypto.randomUUID()}`;
  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  let organizationNumber = '';
  db.exec('BEGIN IMMEDIATE');
  try {
    const requestedNumber = payload.organizationNumber || payload.organization_number;
    organizationNumber = String(requestedNumber || '').trim()
      ? normalizeOrganizationNumber(requestedNumber)
      : nextDefaultOrganizationNumber(db);
    if (db.prepare('SELECT id FROM contact_organizations WHERE organization_number = ? COLLATE NOCASE').get(organizationNumber)) {
      throw cloudApiError('organization_number_exists', '该组织号已被使用，请更换后重试。', 409);
    }
    db.prepare(
      `INSERT INTO contact_organizations (
        id, organization_number, name, verification_code_salt, verification_code_hash, owner_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, organizationNumber, name, salt, organizationVerificationCodeHash(verificationCode, salt), userId, now, now);
    db.prepare(
      `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
       VALUES (?, ?, 'owner', ?, ?)`,
    ).run(id, userId, now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const overview = cloudOrganizationOverview(db, userId);
  return { ok: true, organization: overview.organizations.find((item) => item.id === id) || null, overview };
}

function joinCloudOrganization(db, userId, payload = {}) {
  const organizationNumber = normalizeOrganizationNumber(payload.organizationNumber || payload.organization_number);
  const verificationCode = normalizeOrganizationVerificationCode(payload.verificationCode || payload.secret);
  const organization = db.prepare('SELECT * FROM contact_organizations WHERE organization_number = ? COLLATE NOCASE').get(organizationNumber);
  if (!organization) throw cloudApiError('organization_not_found', '未找到该组织，请检查组织号。', 404);
  if (!organizationVerificationCodeMatches(verificationCode, organization.verification_code_salt, organization.verification_code_hash)) {
    throw cloudApiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  if (db.prepare('SELECT 1 FROM contact_organization_members WHERE organization_id = ? AND user_id = ?').get(organization.id, userId)) {
    throw cloudApiError('organization_already_joined', '你已经加入该组织。', 409);
  }
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
  db.prepare(
    `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
     VALUES (?, ?, 'member', ?, ?)`,
  ).run(organization.id, userId, now, now);
  db.prepare('UPDATE contact_organizations SET updated_at = ? WHERE id = ?').run(now, organization.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const overview = cloudOrganizationOverview(db, userId);
  return { ok: true, organization: overview.organizations.find((item) => item.id === organization.id) || null, overview };
}

function cloudOrganizationPayload(db, row = {}) {
  const members = db.prepare(
    `SELECT membership.role AS organization_role, membership.joined_at, users.*
     FROM contact_organization_members membership
     JOIN users ON users.id = membership.user_id
     WHERE membership.organization_id = ?
     ORDER BY CASE WHEN membership.role = 'owner' THEN 0 ELSE 1 END, lower(users.display_name), lower(users.username)`,
  ).all(row.id).map((member) => ({
    role: normalizeOrganizationRole(member.organization_role),
    joinedAt: member.joined_at || '',
    user: cloudPublicUser(member),
  }));
  const owner = members.find((member) => member.role === 'owner')?.user || null;
  return {
    id: row.id,
    organizationNumber: row.organization_number || '',
    name: row.name || '未命名组织',
    role: normalizeOrganizationRole(row.current_user_role),
    ownerUserId: row.owner_user_id || '',
    owner,
    memberCount: Number(row.member_count || members.length),
    members,
    source: 'cloud',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cloudOrganizationAction(db, userId, payload = {}, { emailCodeSecret = '' } = {}) {
  const action = String(payload.action || '').trim().toLowerCase();
  if (action === 'acknowledge_notice') {
    db.prepare("UPDATE contact_organization_notices SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = ''")
      .run(new Date().toISOString(), String(payload.noticeId || ''), userId);
    return { ok: true, overview: cloudOrganizationOverview(db, userId) };
  }
  const context = db.prepare(`SELECT organization.*, membership.role AS current_user_role
    FROM contact_organizations organization
    JOIN contact_organization_members membership ON membership.organization_id = organization.id
    WHERE organization.id = ? AND membership.user_id = ?`).get(String(payload.organizationId || ''), userId);
  if (!context) throw cloudApiError('organization_not_found', '组织不存在或你已不在该组织中。', 404);
  if (['rename', 'update_invitation_code', 'reset_invitation_code'].includes(action)
    && normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw cloudApiError('organization_owner_required', action === 'rename' ? '只有组织创建者可以修改组织名称。' : '只有组织创建者可以修改邀请码。', 403);
  }
  let secondaryVerification = {};
  if (SENSITIVE_ORGANIZATION_ACTIONS.has(action)) {
    secondaryVerification = requireCloudOrganizationVerification(db, context, userId, payload, { emailCodeSecret });
  }
  let result;
  if (action === 'rename') result = renameCloudOrganization(db, context, userId, payload);
  else if (action === 'request_exit') result = requestCloudOrganizationExit(db, context, userId);
  else if (action === 'resolve_exit') result = resolveCloudOrganizationExit(db, context, userId, payload);
  else if (action === 'validate_invitation_code') result = validateCloudOrganizationInvitationCode(context, payload);
  else {
    if (action === 'reset_invitation_code') {
      result = resetCloudOrganizationInvitationCode(db, context, userId, payload, { emailCodeSecret });
    } else {
      if (action === 'promote_admin') result = setCloudOrganizationAdmin(db, context, userId, payload, true);
      else if (action === 'revoke_admin') result = setCloudOrganizationAdmin(db, context, userId, payload, false);
      else if (action === 'remove_member') result = removeCloudOrganizationMember(db, context, userId, payload);
      else if (action === 'transfer_owner') result = transferCloudOrganizationOwner(db, context, userId, payload, false);
      else if (action === 'update_invitation_code') result = updateCloudOrganizationInvitationCode(db, context, userId, payload);
      else if (action === 'owner_exit') result = cloudOrganizationOwnerExit(db, context, userId, payload);
      else throw cloudApiError('organization_action_invalid', '不支持的组织操作。', 400);
    }
  }
  return { ok: true, ...result, ...secondaryVerification, overview: cloudOrganizationOverview(db, userId) };
}

function renameCloudOrganization(db, context, userId, payload = {}) {
  const name = normalizeOrganizationName(payload.name || payload.organizationName || '');
  if (name === String(context.name || '').trim()) return { organizationId: context.id, name };
  db.prepare(`UPDATE contact_organizations SET name=?,updated_at=?
    WHERE id=? AND owner_user_id=?`).run(name, new Date().toISOString(), context.id, userId);
  return { organizationId: context.id, name };
}

function validateCloudOrganizationInvitationCode(context, payload = {}) {
  const code = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organizationVerificationCodeMatches(code, context.verification_code_salt, context.verification_code_hash)) {
    throw cloudApiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  return {
    invitationCodeValid: true,
    organizationId: context.id,
    organizationNumber: context.organization_number || '',
    organizationName: context.name || '未命名组织',
  };
}

function requireCloudOrganizationVerification(db, organization, userId, payload, { emailCodeSecret = '' } = {}) {
  const grant = String(payload.secondaryVerificationGrant || '').trim();
  if (!grant && payload.secondaryVerificationExpected
    && !payload.verificationCode && !payload.organizationVerificationCode
    && !payload.accountPassword && !payload.password) {
    throw cloudApiError('organization_secondary_verification_expired', '本次登录的二次验证已失效，请重新验证。', 403);
  }
  if (grant) {
    try {
      verifyCloudOrganizationSecondaryVerificationGrant(grant, {
        userId,
        organizationId: organization.id,
        secret: emailCodeSecret,
      });
      return { secondaryVerificationRemembered: true, secondaryVerificationGrant: grant };
    } catch {
      if (!payload.verificationCode && !payload.organizationVerificationCode
        && !payload.accountPassword && !payload.password) {
        throw cloudApiError('organization_secondary_verification_expired', '本次登录的二次验证已失效，请重新验证。', 403);
      }
    }
  }
  const code = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organizationVerificationCodeMatches(code, organization.verification_code_salt, organization.verification_code_hash)) {
    throw cloudApiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user || !verifyCloudPassword(payload.accountPassword || payload.password || '', user.password_hash)) {
    throw cloudApiError('account_password_invalid', '当前账号密码不正确。', 403);
  }
  if (payload.rememberSecondaryVerification !== true) return {};
  if (!emailCodeSecret) throw cloudApiError('organization_secondary_verification_unavailable', '当前服务无法保存本次登录的二次验证状态。', 503);
  const secondaryVerificationGrant = signCloudOrganizationSecondaryVerificationGrant({
    userId,
    organizationId: organization.id,
    secret: emailCodeSecret,
  });
  return { secondaryVerificationRemembered: true, secondaryVerificationGrant };
}

function signCloudOrganizationSecondaryVerificationGrant({ userId = '', organizationId = '', secret = '' } = {}) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    sub: String(userId),
    org: String(organizationId),
    typ: 'organization_secondary_verification',
    iat: now,
    exp: now + ORGANIZATION_SECONDARY_VERIFICATION_TTL_MS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyCloudOrganizationSecondaryVerificationGrant(token, {
  userId = '', organizationId = '', secret = '',
} = {}) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) throw new Error('bad_secondary_verification_token');
  const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error('bad_secondary_verification_signature');
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (parsed.typ !== 'organization_secondary_verification'
    || parsed.sub !== String(userId)
    || parsed.org !== String(organizationId)
    || Number(parsed.exp || 0) <= Date.now()) {
    throw new Error('bad_secondary_verification_scope');
  }
  return parsed;
}

function updateCloudOrganizationInvitationCode(db, context, userId, payload = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw cloudApiError('organization_owner_required', '只有组织创建者可以修改邀请码。', 403);
  }
  const invitationCode = normalizeOrganizationVerificationCode(payload.newInvitationCode || payload.newVerificationCode || '');
  if (organizationVerificationCodeMatches(invitationCode, context.verification_code_salt, context.verification_code_hash)) {
    throw cloudApiError('organization_invitation_code_unchanged', '新邀请码不能与当前邀请码相同。', 409);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  db.prepare(`UPDATE contact_organizations SET verification_code_salt=?,verification_code_hash=?,updated_at=?
    WHERE id=? AND owner_user_id=?`).run(salt, organizationVerificationCodeHash(invitationCode, salt), now, context.id, userId);
  return { organizationId: context.id, invitationCodeUpdated: true };
}

function resetCloudOrganizationInvitationCode(db, context, userId, payload = {}, { emailCodeSecret = '' } = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw cloudApiError('organization_owner_required', '只有组织创建者可以重置邀请码。', 403);
  }
  const account = db.prepare('SELECT email,email_verified FROM users WHERE id=?').get(userId);
  if (!account?.email || !account.email_verified) {
    throw cloudApiError('verified_email_required', '当前账号需要先绑定并验证邮箱，才能重置组织邀请码。', 403);
  }
  const verification = verifyCloudEmailCode(db, {
    email: account.email,
    purpose: 'organization_invitation_reset',
    code: payload.emailCode || payload.code || '',
    emailCodeSecret,
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    consumeCloudEmailCode(db, verification);
    const result = updateCloudOrganizationInvitationCode(db, context, userId, payload);
    db.exec('COMMIT');
    return { ...result, invitationCodeReset: true };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function setCloudOrganizationAdmin(db, context, userId, payload, promote) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw cloudApiError('organization_owner_required', '只有组织创建者可以调整管理员权限。', 403);
  const targetId = String(payload.targetUserId || '');
  const target = db.prepare('SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?').get(context.id, targetId);
  const role = normalizeOrganizationRole(target?.role);
  if (!target || targetId === userId || role === 'owner') throw cloudApiError('organization_member_invalid', '请选择有效组织成员。', 400);
  if ((promote && role === 'admin') || (!promote && role !== 'admin')) throw cloudApiError('organization_role_unchanged', promote ? '该成员已经是管理员。' : '该成员不是管理员。', 409);
  const nextRole = promote ? 'admin' : 'member';
  const now = new Date().toISOString();
  db.prepare('UPDATE contact_organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?').run(nextRole, now, context.id, targetId);
  addCloudOrganizationNotice(db, targetId, context, promote ? 'role_admin' : 'role_member', promote ? '你已成为组织管理员' : '管理员权限已被移除', promote ? `你已被任命为“${context.name}”的管理员。` : `你在“${context.name}”中的管理员权限已被创建者移除。`);
  return { targetUserId: targetId, role: nextRole };
}

function removeCloudOrganizationMember(db, context, userId, payload) {
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  const targetId = String(payload.targetUserId || '');
  const target = db.prepare('SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?').get(context.id, targetId);
  const targetRole = normalizeOrganizationRole(target?.role);
  if (!['owner', 'admin'].includes(actorRole)) throw cloudApiError('organization_admin_required', '只有创建者或管理员可以移除组织成员。', 403);
  if (!target || targetId === userId || targetRole === 'owner' || (actorRole === 'admin' && targetRole !== 'member')) throw cloudApiError('organization_remove_forbidden', '你不能移除同级管理员或组织创建者。', 403);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM contact_organization_members WHERE organization_id = ? AND user_id = ?').run(context.id, targetId);
    db.prepare("UPDATE contact_organization_exit_requests SET status='cancelled',resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE organization_id=? AND requester_user_id=? AND status='pending'").run(userId, now, now, context.id, targetId);
    addCloudOrganizationNotice(db, targetId, context, 'member_removed', '你已被移出组织', `你已被管理员从“${context.name}”中移出。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { targetUserId: targetId, removed: true };
}

function transferCloudOrganizationOwner(db, context, userId, payload, removePreviousOwner) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw cloudApiError('organization_owner_required', '只有组织创建者可以转让组织。', 403);
  const targetId = String(payload.targetUserId || payload.successorUserId || '');
  if (!targetId || targetId === userId || !db.prepare('SELECT 1 FROM contact_organization_members WHERE organization_id=? AND user_id=?').get(context.id, targetId)) throw cloudApiError('organization_successor_invalid', '请选择其他组织成员作为新创建者。', 400);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE contact_organization_members SET role=?,updated_at=? WHERE organization_id=? AND user_id=?').run(removePreviousOwner ? 'member' : 'admin', now, context.id, userId);
    db.prepare("UPDATE contact_organization_members SET role='owner',updated_at=? WHERE organization_id=? AND user_id=?").run(now, context.id, targetId);
    db.prepare('UPDATE contact_organizations SET owner_user_id=?,updated_at=? WHERE id=?').run(targetId, now, context.id);
    addCloudOrganizationNotice(db, targetId, context, 'owner_transferred', '你已成为组织创建者', `“${context.name}”已转让给你，你现在拥有该组织的最高管理权限。`);
    if (removePreviousOwner) db.prepare('DELETE FROM contact_organization_members WHERE organization_id=? AND user_id=?').run(context.id, userId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ownerUserId: targetId, exited: removePreviousOwner };
}

function requestCloudOrganizationExit(db, context, userId) {
  const role = normalizeOrganizationRole(context.current_user_role);
  if (role === 'owner') throw cloudApiError('organization_owner_exit_choice_required', '创建者退出时需要先选择继任者或解散组织。', 400);
  if (db.prepare("SELECT 1 FROM contact_organization_exit_requests WHERE organization_id=? AND requester_user_id=? AND status='pending'").get(context.id, userId)) throw cloudApiError('organization_exit_pending', '退出申请已经发送，请等待处理。', 409);
  const id = `organization_exit_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const requester = db.prepare('SELECT display_name,username,email FROM users WHERE id=?').get(userId) || {};
  const recipients = db.prepare(`SELECT user_id FROM contact_organization_members WHERE organization_id=? AND user_id<>? AND role IN (${role === 'admin' ? "'owner'" : "'owner','admin'"})`).all(context.id, userId);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO contact_organization_exit_requests(id,organization_id,requester_user_id,requester_role,status,created_at,updated_at) VALUES(?,?,?,?,'pending',?,?)").run(id, context.id, userId, role, now, now);
    for (const recipient of recipients) addCloudOrganizationNotice(db, recipient.user_id, context, 'exit_request', '收到组织退出申请', `${requester.display_name || requester.username || requester.email || '一位成员'}申请退出“${context.name}”。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { requestId: id, status: 'pending' };
}

function resolveCloudOrganizationExit(db, context, userId, payload) {
  const request = db.prepare("SELECT * FROM contact_organization_exit_requests WHERE id=? AND organization_id=? AND status='pending'").get(String(payload.requestId || ''), context.id);
  if (!request) throw cloudApiError('organization_exit_not_found', '退出申请不存在或已被处理。', 404);
  const requester = db.prepare('SELECT role FROM contact_organization_members WHERE organization_id=? AND user_id=?').get(context.id, request.requester_user_id);
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  const requesterRole = normalizeOrganizationRole(requester?.role || request.requester_role);
  if (!requester || (actorRole !== 'owner' && !(actorRole === 'admin' && requesterRole === 'member'))) throw cloudApiError('organization_exit_forbidden', '你无权处理该退出申请。', 403);
  const approve = String(payload.decision || '').toLowerCase() === 'approve';
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (approve) db.prepare('DELETE FROM contact_organization_members WHERE organization_id=? AND user_id=?').run(context.id, request.requester_user_id);
    db.prepare('UPDATE contact_organization_exit_requests SET status=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?').run(approve ? 'approved' : 'rejected', userId, now, now, request.id);
    addCloudOrganizationNotice(db, request.requester_user_id, context, approve ? 'exit_approved' : 'exit_rejected', approve ? '退出组织申请已通过' : '退出组织申请未通过', approve ? `你已退出“${context.name}”。` : `你退出“${context.name}”的申请被管理员拒绝。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { requestId: request.id, decision: approve ? 'approve' : 'reject' };
}

function cloudOrganizationOwnerExit(db, context, userId, payload) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw cloudApiError('organization_owner_required', '只有组织创建者可以使用该退出方式。', 403);
  if (String(payload.mode || '').toLowerCase() === 'dissolve') return dissolveCloudOrganization(db, context, userId);
  const successorId = String(payload.successorUserId || '') || db.prepare("SELECT user_id FROM contact_organization_members WHERE organization_id=? AND user_id<>? ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,joined_at,user_id LIMIT 1").get(context.id, userId)?.user_id || '';
  return successorId ? transferCloudOrganizationOwner(db, context, userId, { targetUserId: successorId }, true) : dissolveCloudOrganization(db, context, userId);
}

function dissolveCloudOrganization(db, context, userId) {
  const members = db.prepare('SELECT user_id FROM contact_organization_members WHERE organization_id=? AND user_id<>?').all(context.id, userId);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const member of members) addCloudOrganizationNotice(db, member.user_id, context, 'organization_dissolved', '组织已解散', `创建者已解散“${context.name}”。`);
    db.prepare('DELETE FROM contact_organizations WHERE id=?').run(context.id);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { dissolved: true, exited: true };
}

function cloudOrganizationExitRequests(db, userId) {
  return db.prepare(`SELECT request.*,organization.name AS organization_name,organization.organization_number,actor.role AS current_user_role,
      requester.role AS current_requester_role,users.display_name,users.username,users.email,users.avatar_url,users.role,users.email_verified
    FROM contact_organization_exit_requests request
    JOIN contact_organizations organization ON organization.id=request.organization_id
    JOIN contact_organization_members actor ON actor.organization_id=request.organization_id AND actor.user_id=?
    LEFT JOIN contact_organization_members requester ON requester.organization_id=request.organization_id AND requester.user_id=request.requester_user_id
    JOIN users ON users.id=request.requester_user_id
    WHERE request.status='pending' AND (request.requester_user_id=? OR actor.role='owner' OR (actor.role='admin' AND COALESCE(requester.role,request.requester_role)='member'))
    ORDER BY request.created_at`).all(userId, userId).map((row) => ({ id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, organizationNumber: row.organization_number, requesterRole: normalizeOrganizationRole(row.current_requester_role || row.requester_role), currentUserRole: normalizeOrganizationRole(row.current_user_role), own: row.requester_user_id === userId, canResolve: row.requester_user_id !== userId && (row.current_user_role === 'owner' || (row.current_user_role === 'admin' && normalizeOrganizationRole(row.current_requester_role || row.requester_role) === 'member')), requester: cloudPublicUser({ ...row, id: row.requester_user_id }), createdAt: row.created_at }));
}

function cloudOrganizationNotices(db, userId) {
  return db.prepare("SELECT * FROM contact_organization_notices WHERE user_id=? ORDER BY read_at='' DESC,created_at DESC LIMIT 30").all(userId).map((row) => ({ id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, type: row.type, title: row.title, content: row.content, read: Boolean(row.read_at), createdAt: row.created_at }));
}

function addCloudOrganizationNotice(db, userId, organization, type, title, content) {
  db.prepare('INSERT INTO contact_organization_notices(id,user_id,organization_id,organization_name,type,title,content,created_at) VALUES(?,?,?,?,?,?,?,?)').run(`organization_notice_${crypto.randomUUID()}`, userId, organization.id || '', organization.name || '', type, title, content, new Date().toISOString());
}

function normalizeOrganizationRole(role = '') {
  const value = String(role || '').toLowerCase();
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function normalizeOrganizationName(value = '') {
  const name = String(value || '').trim();
  if (name.length < 2) throw cloudApiError('organization_name_invalid', '组织名称至少需要 2 个字符。', 400);
  if (name.length > 60) throw cloudApiError('organization_name_invalid', '组织名称不能超过 60 个字符。', 400);
  return name;
}

function normalizeOrganizationNumber(value = '') {
  const number = String(value || '').trim().toUpperCase();
  if (!ORGANIZATION_NUMBER_PATTERN.test(number)) {
    throw cloudApiError('organization_number_invalid', '组织号需要 4–32 位，只能包含字母、数字、下划线或短横线。', 400);
  }
  return number;
}

function nextDefaultOrganizationNumber(db) {
  const rows = db.prepare(
    "SELECT organization_number FROM contact_organizations WHERE upper(organization_number) LIKE 'ORG-%'",
  ).all();
  let highest = 0;
  for (const row of rows) {
    const match = String(row.organization_number || '').toUpperCase().match(/^ORG-(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  const number = `ORG-${String(highest + 1).padStart(4, '0')}`;
  if (number.length > 32) {
    throw cloudApiError('organization_number_generation_failed', '自动生成组织号失败，请手动填写组织号。', 500);
  }
  return number;
}

function normalizeOrganizationVerificationCode(value = '') {
  const code = String(value || '');
  if (code.length < 6) throw cloudApiError('organization_verification_code_invalid', '组织邀请码至少需要 6 个字符。', 400);
  if (code.length > 128) throw cloudApiError('organization_verification_code_invalid', '组织邀请码不能超过 128 个字符。', 400);
  return code;
}

function organizationVerificationCodeHash(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString('hex');
}

function organizationVerificationCodeMatches(code, salt, expectedHash) {
  const actual = Buffer.from(organizationVerificationCodeHash(code, salt), 'hex');
  const expected = Buffer.from(String(expectedHash || ''), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export {
  cloudOrganizationOverview,
  createCloudOrganization,
  joinCloudOrganization,
  cloudOrganizationAction,
};
