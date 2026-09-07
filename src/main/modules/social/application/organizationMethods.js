import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { verifyPassword } from '../../identity/index.js';
import { newId, nowIso } from '../../../utils.js';
import { publicUser } from '../domain/socialRecords.js';
import { deactivateOrganizationAccountWorkspace, ensureOrganizationAccountWorkspace } from '../../workspaces/index.js';

const ORGANIZATION_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;
const SENSITIVE_ORGANIZATION_ACTIONS = new Set([
  'promote_admin', 'revoke_admin', 'remove_member', 'transfer_owner',
  'update_invitation_code', 'resolve_exit', 'owner_exit',
]);

export function installOrganizationMethods(prototype) {
  Object.assign(prototype, {
    organizationOverview() {
      const user = this.requireUser();
      const organizations = all(
        this.db,
        `SELECT o.*, m.role AS current_user_role, m.joined_at AS current_user_joined_at,
                (SELECT COUNT(*) FROM contact_organization_members count_members WHERE count_members.organization_id = o.id) AS member_count
         FROM contact_organizations o
         JOIN contact_organization_members m ON m.organization_id = o.id
         WHERE m.user_id = ?
         ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, lower(o.name), o.organization_number`,
        [user.id],
      ).map((organization) => organizationPayload(this.db, organization, user.id));
      return {
        organizations,
        organizationExitRequests: organizationExitRequests(this.db, user.id),
        organizationNotices: organizationNotices(this.db, user.id),
      };
    },

    createOrganization({ name = '', organizationNumber = '', verificationCode = '', secret = '' } = {}) {
      const user = this.requireUser();
      const cleanName = normalizeOrganizationName(name);
      const cleanVerificationCode = normalizeOrganizationVerificationCode(verificationCode || secret);
      const id = newId('organization');
      const salt = crypto.randomBytes(16).toString('hex');
      const now = nowIso();
      let cleanNumber = '';
      this.db.exec('BEGIN IMMEDIATE');
      try {
        cleanNumber = String(organizationNumber || '').trim()
          ? normalizeOrganizationNumber(organizationNumber)
          : nextDefaultOrganizationNumber(this.db);
        if (get(this.db, 'SELECT id FROM contact_organizations WHERE organization_number = ? COLLATE NOCASE', [cleanNumber])) {
          throw new Error('该组织号已被使用，请更换后重试。');
        }
        run(
          this.db,
          `INSERT INTO contact_organizations (
            id, organization_number, name, verification_code_salt, verification_code_hash, owner_user_id, source, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
          [id, cleanNumber, cleanName, salt, organizationVerificationCodeHash(cleanVerificationCode, salt), user.id, now, now],
        );
        run(
          this.db,
          `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
           VALUES (?, ?, 'owner', ?, ?)`,
          [id, user.id, now, now],
        );
        ensureOrganizationAccountWorkspace(this.db, {
          id, ownerUserId: user.id, name: cleanName, createdAt: now, updatedAt: now,
        }, [{ userId: user.id, role: 'owner', displayName: user.displayName, avatarUrl: user.avatarUrl, joinedAt: now }]);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      const overview = this.friendsOverview();
      return { ok: true, organization: overview.organizations.find((item) => item.id === id) || null, overview };
    },

    joinOrganization({ organizationNumber = '', verificationCode = '', secret = '' } = {}) {
      const user = this.requireUser();
      const cleanNumber = normalizeOrganizationNumber(organizationNumber);
      const cleanVerificationCode = normalizeOrganizationVerificationCode(verificationCode || secret);
      const organization = get(this.db, 'SELECT * FROM contact_organizations WHERE organization_number = ? COLLATE NOCASE', [cleanNumber]);
      if (!organization) throw new Error('未找到该组织，请检查组织号。');
      if (!organization.verification_code_salt || !organization.verification_code_hash) {
        throw new Error('该组织来自云端缓存，请连接社交服务后再使用邀请码加入。');
      }
      if (!organizationVerificationCodeMatches(cleanVerificationCode, organization.verification_code_salt, organization.verification_code_hash)) {
        throw new Error('组织邀请码不正确。');
      }
      const existing = get(
        this.db,
        'SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?',
        [organization.id, user.id],
      );
      if (existing) throw new Error('你已经加入该组织。');
      const now = nowIso();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        run(
          this.db,
          `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
           VALUES (?, ?, 'member', ?, ?)`,
          [organization.id, user.id, now, now],
        );
        run(this.db, 'UPDATE contact_organizations SET updated_at = ? WHERE id = ?', [now, organization.id]);
        const members = all(this.db, `SELECT membership.*,auth.display_name,auth.avatar_url
          FROM contact_organization_members membership LEFT JOIN auth_users auth ON auth.id=membership.user_id
          WHERE membership.organization_id=?`, [organization.id]);
        ensureOrganizationAccountWorkspace(this.db, { ...organization, updated_at: now }, members);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      const overview = this.friendsOverview();
      return { ok: true, organization: overview.organizations.find((item) => item.id === organization.id) || null, overview };
    },

    organizationAction(payload = {}) {
      const user = this.requireUser();
      const result = performOrganizationAction(this, user.id, payload);
      const organizationId = String(payload.organizationId || payload.organization_id || result.organization?.id || '').trim();
      const organization = organizationId ? get(this.db, 'SELECT * FROM contact_organizations WHERE id=?', [organizationId]) : null;
      if (organization) ensureOrganizationAccountWorkspace(this.db, organization,
        all(this.db, `SELECT membership.*,auth.display_name,auth.avatar_url FROM contact_organization_members membership
          LEFT JOIN auth_users auth ON auth.id=membership.user_id WHERE membership.organization_id=?`, [organization.id]));
      else if (organizationId && result.dissolved) deactivateOrganizationAccountWorkspace(this.db, organizationId);
      return { ok: true, ...result, overview: this.friendsOverview() };
    },

    importCloudOrganizations(items = []) {
      const currentUser = this.requireUser();
      const visibleOrganizationIds = new Set();
      for (const item of Array.isArray(items) ? items : []) {
        const remoteId = String(item.id || item.remoteId || '').trim();
        const organizationNumber = String(item.organizationNumber || item.organization_number || '').trim().toUpperCase();
        if (!remoteId || !organizationNumber) continue;
        const owner = item.owner ? this.importCloudUser(item.owner) : null;
        const existing = get(this.db, 'SELECT * FROM contact_organizations WHERE remote_id = ? OR organization_number = ? COLLATE NOCASE LIMIT 1', [remoteId, organizationNumber]);
        const localId = existing?.id || remoteId;
        visibleOrganizationIds.add(localId);
        run(
          this.db,
          `INSERT INTO contact_organizations (
            id, organization_number, name, verification_code_salt, verification_code_hash, owner_user_id, source, remote_id, created_at, updated_at
           ) VALUES (?, ?, ?, '', '', ?, 'cloud', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             organization_number = excluded.organization_number,
             name = excluded.name,
             owner_user_id = excluded.owner_user_id,
             source = 'cloud',
             remote_id = excluded.remote_id,
             updated_at = excluded.updated_at`,
          [
            localId,
            organizationNumber,
            String(item.name || '未命名组织').trim().slice(0, 60),
            owner?.id || currentUser.id,
            remoteId,
            item.createdAt || item.created_at || nowIso(),
            item.updatedAt || item.updated_at || nowIso(),
          ],
        );
        const activeMemberIds = new Set();
        for (const member of Array.isArray(item.members) ? item.members : []) {
          const sourceMember = member.user || member;
          const imported = this.importCloudUser({ ...sourceMember,
            displayName: sourceMember.accountDisplayName || sourceMember.account_display_name || sourceMember.displayName,
            display_name: sourceMember.accountDisplayName || sourceMember.account_display_name || sourceMember.display_name });
          if (!imported) continue;
          activeMemberIds.add(imported.id);
          const memberUser = member.user || member;
          if (imported.id !== currentUser.id && Object.prototype.hasOwnProperty.call(memberUser, 'remark')) {
            const remark = String(memberUser.remark || '').trim().slice(0, 40);
            run(this.db, `INSERT INTO social_contact_remarks(owner_user_id,target_user_id,remark,created_at,updated_at)
              VALUES(?,?,?,?,?) ON CONFLICT(owner_user_id,target_user_id) DO UPDATE SET remark=excluded.remark,updated_at=excluded.updated_at`,
            [currentUser.id, imported.id, remark, member.joinedAt || member.joined_at || nowIso(), item.updatedAt || item.updated_at || nowIso()]);
          }
          run(
            this.db,
            `INSERT INTO contact_organization_members (organization_id, user_id, role, display_name_override, joined_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role,
               display_name_override = excluded.display_name_override, updated_at = excluded.updated_at`,
            [
              localId,
              imported.id,
              normalizeOrganizationRole(member.role),
              String(member.displayNameOverride || member.display_name_override || '').trim().slice(0, 80),
              member.joinedAt || member.joined_at || nowIso(),
              item.updatedAt || item.updated_at || nowIso(),
            ],
          );
        }
        for (const row of all(this.db, 'SELECT user_id FROM contact_organization_members WHERE organization_id = ?', [localId])) {
          if (!activeMemberIds.has(row.user_id)) {
            run(this.db, 'DELETE FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [localId, row.user_id]);
          }
        }
        ensureOrganizationAccountWorkspace(this.db, {
          id: localId,
          ownerUserId: owner?.id || currentUser.id,
          name: String(item.name || '未命名组织').trim().slice(0, 60),
          createdAt: item.createdAt || item.created_at || nowIso(),
          updatedAt: item.updatedAt || item.updated_at || nowIso(),
        }, all(this.db, `SELECT membership.*,auth.display_name,auth.avatar_url FROM contact_organization_members membership
          LEFT JOIN auth_users auth ON auth.id=membership.user_id WHERE membership.organization_id=?`, [localId]));
      }
      for (const organization of all(this.db, `SELECT organization.* FROM contact_organizations organization
        JOIN contact_organization_members membership ON membership.organization_id=organization.id
        WHERE membership.user_id=? AND organization.source='cloud'`, [currentUser.id])) {
        if (visibleOrganizationIds.has(organization.id)) continue;
        run(this.db, 'DELETE FROM contact_organization_members WHERE organization_id=? AND user_id=?', [organization.id, currentUser.id]);
        ensureOrganizationAccountWorkspace(this.db, organization,
          all(this.db, `SELECT membership.*,auth.display_name,auth.avatar_url FROM contact_organization_members membership
            LEFT JOIN auth_users auth ON auth.id=membership.user_id WHERE membership.organization_id=?`, [organization.id]));
      }
      return this.organizationOverview();
    },
  });
}

function organizationPayload(db, row = {}, viewerUserId = '') {
  const members = all(
    db,
    `SELECT m.role AS organization_role,m.display_name_override,m.joined_at,u.*,
            u.display_name AS account_display_name,COALESCE(remark.remark,'') AS contact_remark
     FROM contact_organization_members m
     JOIN auth_users u ON u.id = m.user_id
     LEFT JOIN social_contact_remarks remark ON remark.owner_user_id=? AND remark.target_user_id=m.user_id
     WHERE m.organization_id = ?
     ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END,
       lower(COALESCE(NULLIF(m.display_name_override,''),u.display_name)),lower(u.username)`,
    [viewerUserId, row.id],
  ).map((member) => ({
    role: normalizeOrganizationRole(member.organization_role),
    joinedAt: member.joined_at || '',
    displayNameOverride: member.display_name_override || '',
    user: {
      ...publicUser({ ...member, display_name: member.display_name_override || member.display_name }),
      accountDisplayName: member.account_display_name || '',
      remark: member.contact_remark || '',
    },
  }));
  return {
    id: row.id,
    organizationNumber: row.organization_number || '',
    name: row.name || '未命名组织',
    role: normalizeOrganizationRole(row.current_user_role),
    ownerUserId: row.owner_user_id || '',
    owner: members.find((member) => member.role === 'owner')?.user || null,
    memberCount: Number(row.member_count || members.length),
    members,
    source: row.source || 'local',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function performOrganizationAction(auth, userId, payload = {}) {
  const db = auth.db;
  const action = String(payload.action || '').trim().toLowerCase();
  if (action === 'acknowledge_notice') {
    const noticeId = String(payload.noticeId || '').trim();
    if (!noticeId) throw new Error('缺少组织提醒。');
    run(db, "UPDATE contact_organization_notices SET read_at = ? WHERE id = ? AND user_id = ? AND read_at = ''", [nowIso(), noticeId, userId]);
    return { noticeId };
  }
  const organizationId = String(payload.organizationId || '').trim();
  const context = organizationContext(db, organizationId, userId);
  if (!context) throw new Error('组织不存在或你已不在该组织中。');
  if (['rename', 'update_invitation_code', 'reset_invitation_code'].includes(action)
    && normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw new Error(action === 'rename' ? '只有组织创建者可以修改组织名称。' : '只有组织创建者可以修改邀请码。');
  }
  let secondaryVerification = {};
  if (SENSITIVE_ORGANIZATION_ACTIONS.has(action)) {
    secondaryVerification = requireSensitiveOrganizationVerification(auth, context, userId, payload);
  }
  let result;
  if (action === 'rename') result = renameOrganization(db, context, userId, payload);
  else if (action === 'set_display_name') result = updateOrganizationDisplayName(db, context, userId, payload);
  else if (action === 'request_exit') result = requestOrganizationExit(db, context, userId);
  else if (action === 'resolve_exit') result = resolveOrganizationExit(db, context, userId, payload);
  else if (action === 'validate_invitation_code') result = validateOrganizationInvitationCode(context, payload);
  else if (action === 'reset_invitation_code') result = resetOrganizationInvitationCode(auth, context, userId, payload);
  else if (action === 'promote_admin') result = updateOrganizationAdminRole(db, context, userId, payload, true);
  else if (action === 'revoke_admin') result = updateOrganizationAdminRole(db, context, userId, payload, false);
  else if (action === 'remove_member') result = removeOrganizationMember(db, context, userId, payload);
  else if (action === 'transfer_owner') result = transferOrganizationOwner(db, context, userId, payload, false);
  else if (action === 'update_invitation_code') result = updateOrganizationInvitationCode(db, context, userId, payload);
  else if (action === 'owner_exit') result = ownerExitOrganization(db, context, userId, payload);
  else throw new Error('不支持的组织操作。');
  return { ...result, ...secondaryVerification };
}

function renameOrganization(db, context, userId, payload = {}) {
  const name = normalizeOrganizationName(payload.name || payload.organizationName || '');
  if (name === String(context.name || '').trim()) return { organizationId: context.id, name };
  const now = nowIso();
  run(db, `UPDATE contact_organizations SET name=?,updated_at=?
    WHERE id=? AND owner_user_id=?`, [name, now, context.id, userId]);
  return { organizationId: context.id, name };
}

function updateOrganizationDisplayName(db, context, userId, payload = {}) {
  const displayName = String(payload.displayName || payload.display_name || '').trim().slice(0, 80);
  const now = nowIso();
  run(db, `UPDATE contact_organization_members SET display_name_override=?,updated_at=?
    WHERE organization_id=? AND user_id=?`, [displayName, now, context.id, userId]);
  const accountName = get(db, 'SELECT display_name FROM auth_users WHERE id=?', [userId])?.display_name || '';
  run(db, `UPDATE account_workspace_memberships SET display_name=?,updated_at=?
    WHERE workspace_id=? AND user_id=?`, [displayName || accountName, now, `workspace_org_${context.id}`, userId]);
  return { organizationId: context.id, displayName };
}

function validateOrganizationInvitationCode(context, payload = {}) {
  const code = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organizationVerificationCodeMatches(code, context.verification_code_salt, context.verification_code_hash)) {
    throw new Error('组织邀请码不正确。');
  }
  return {
    invitationCodeValid: true,
    organizationId: context.id,
    organizationNumber: context.organization_number || '',
    organizationName: context.name || '未命名组织',
  };
}

function organizationContext(db, organizationId, userId) {
  if (!organizationId) return null;
  return get(
    db,
    `SELECT o.*, membership.role AS current_user_role
     FROM contact_organizations o
     JOIN contact_organization_members membership ON membership.organization_id = o.id
     WHERE o.id = ? AND membership.user_id = ?`,
    [organizationId, userId],
  );
}

function requireSensitiveOrganizationVerification(auth, organization, userId, payload = {}) {
  if (auth.hasOrganizationSecondaryVerification?.(organization.id)) {
    return { secondaryVerificationRemembered: true };
  }
  if (payload.secondaryVerificationExpected
    && !payload.verificationCode && !payload.organizationVerificationCode
    && !payload.accountPassword && !payload.password) {
    throw new Error('本次登录的二次验证已失效，请重新验证。');
  }
  const verificationCode = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organization.verification_code_salt || !organization.verification_code_hash
    || !organizationVerificationCodeMatches(verificationCode, organization.verification_code_salt, organization.verification_code_hash)) {
    throw new Error('组织邀请码不正确。');
  }
  const account = get(auth.db, 'SELECT password_hash FROM auth_users WHERE id = ?', [userId]);
  if (!account?.password_hash) throw new Error('当前账号尚未设置密码，无法执行敏感组织操作。');
  if (!verifyPassword(payload.accountPassword || payload.password || '', account.password_hash)) throw new Error('当前账号密码不正确。');
  if (payload.rememberSecondaryVerification !== true) return {};
  auth.rememberOrganizationSecondaryVerification?.(organization.id);
  return { secondaryVerificationRemembered: true };
}

function updateOrganizationInvitationCode(db, context, userId, payload = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw new Error('只有组织创建者可以修改邀请码。');
  const invitationCode = normalizeOrganizationVerificationCode(
    payload.newInvitationCode || payload.newVerificationCode || '',
  );
  if (organizationVerificationCodeMatches(invitationCode, context.verification_code_salt, context.verification_code_hash)) {
    throw new Error('新邀请码不能与当前邀请码相同。');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const now = nowIso();
  run(db, `UPDATE contact_organizations SET verification_code_salt=?,verification_code_hash=?,updated_at=?
    WHERE id=? AND owner_user_id=?`, [salt, organizationVerificationCodeHash(invitationCode, salt), now, context.id, userId]);
  return { organizationId: context.id, invitationCodeUpdated: true };
}

function resetOrganizationInvitationCode(auth, context, userId, payload = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw new Error('只有组织创建者可以重置邀请码。');
  const account = get(auth.db, 'SELECT email,email_verified FROM auth_users WHERE id=?', [userId]);
  if (!account?.email || !account.email_verified) throw new Error('当前账号需要先绑定并验证邮箱，才能重置组织邀请码。');
  auth.db.exec('BEGIN IMMEDIATE');
  try {
    auth.consumeEmailCode({
      email: account.email,
      purpose: 'organization_invitation_reset',
      code: payload.emailCode || payload.code || '',
    });
    const result = updateOrganizationInvitationCode(auth.db, context, userId, payload);
    auth.db.exec('COMMIT');
    return { ...result, invitationCodeReset: true };
  } catch (error) {
    auth.db.exec('ROLLBACK');
    throw error;
  }
}

function updateOrganizationAdminRole(db, context, userId, payload, promote) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw new Error('只有组织创建者可以调整管理员权限。');
  const targetId = String(payload.targetUserId || '').trim();
  const target = get(db, 'SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, targetId]);
  if (!target || targetId === userId) throw new Error('请选择有效组织成员。');
  const targetRole = normalizeOrganizationRole(target.role);
  if (targetRole === 'owner') throw new Error('不能修改组织创建者的管理员权限。');
  if (promote && targetRole === 'admin') throw new Error('该成员已经是管理员。');
  if (!promote && targetRole !== 'admin') throw new Error('该成员不是管理员。');
  const nextRole = promote ? 'admin' : 'member';
  const now = nowIso();
  run(db, 'UPDATE contact_organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?', [nextRole, now, context.id, targetId]);
  run(db, 'UPDATE contact_organizations SET updated_at = ? WHERE id = ?', [now, context.id]);
  addOrganizationNotice(db, targetId, context, promote ? 'role_admin' : 'role_member', promote ? '你已成为组织管理员' : '管理员权限已被移除', promote ? `你已被任命为“${context.name}”的管理员。` : `你在“${context.name}”中的管理员权限已被创建者移除。`);
  return { organizationId: context.id, targetUserId: targetId, role: nextRole };
}

function removeOrganizationMember(db, context, userId, payload) {
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  if (!['owner', 'admin'].includes(actorRole)) throw new Error('只有创建者或管理员可以移除组织成员。');
  const targetId = String(payload.targetUserId || '').trim();
  const target = get(db, 'SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, targetId]);
  if (!target || targetId === userId) throw new Error('请选择其他组织成员。');
  const targetRole = normalizeOrganizationRole(target.role);
  if (targetRole === 'owner' || (actorRole === 'admin' && targetRole !== 'member')) throw new Error('你不能移除同级管理员或组织创建者。');
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    run(db, 'DELETE FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, targetId]);
    run(db, "UPDATE contact_organization_exit_requests SET status = 'cancelled', resolved_by_user_id = ?, resolved_at = ?, updated_at = ? WHERE organization_id = ? AND requester_user_id = ? AND status = 'pending'", [userId, now, now, context.id, targetId]);
    run(db, 'UPDATE contact_organizations SET updated_at = ? WHERE id = ?', [now, context.id]);
    addOrganizationNotice(db, targetId, context, 'member_removed', '你已被移出组织', `你已被管理员从“${context.name}”中移出。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { organizationId: context.id, targetUserId: targetId, removed: true };
}

function transferOrganizationOwner(db, context, userId, payload, removePreviousOwner) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw new Error('只有组织创建者可以转让组织。');
  const targetId = String(payload.targetUserId || payload.successorUserId || '').trim();
  const retainAdmin = removePreviousOwner ? false : organizationTransferRetainAdmin(payload);
  const previousOwnerRole = retainAdmin ? 'admin' : 'member';
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const currentOwner = get(db, `SELECT organization.owner_user_id,membership.role
      FROM contact_organizations organization
      JOIN contact_organization_members membership
        ON membership.organization_id=organization.id AND membership.user_id=?
      WHERE organization.id=?`, [userId, context.id]);
    if (!currentOwner || currentOwner.owner_user_id !== userId || normalizeOrganizationRole(currentOwner.role) !== 'owner') {
      throw new Error('组织创建者身份已发生变化，请刷新后重试。');
    }
    const target = get(db, 'SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, targetId]);
    if (!target || targetId === userId) throw new Error('请选择其他组织成员作为新创建者。');
    run(db, 'UPDATE contact_organization_members SET role = ?, updated_at = ? WHERE organization_id = ? AND user_id = ?', [previousOwnerRole, now, context.id, userId]);
    run(db, "UPDATE contact_organization_members SET role = 'owner', updated_at = ? WHERE organization_id = ? AND user_id = ?", [now, context.id, targetId]);
    run(db, 'UPDATE contact_organizations SET owner_user_id = ?, updated_at = ? WHERE id = ?', [targetId, now, context.id]);
    const organization = get(db, 'SELECT * FROM contact_organizations WHERE id=?', [context.id]);
    let members = all(db, `SELECT membership.*,auth.display_name,auth.avatar_url
      FROM contact_organization_members membership LEFT JOIN auth_users auth ON auth.id=membership.user_id
      WHERE membership.organization_id=?`, [context.id]);
    ensureOrganizationAccountWorkspace(db, organization, members);
    if (removePreviousOwner) {
      run(db, 'DELETE FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, userId]);
      members = members.filter((member) => member.user_id !== userId);
      ensureOrganizationAccountWorkspace(db, organization, members);
    }
    addOrganizationNotice(db, targetId, context, 'owner_transferred', '你已成为组织创建者', `“${context.name}”已转让给你，你现在拥有该组织的最高管理权限。`);
    assertOrganizationOwnerTransferConsistency(db, context.id, targetId, userId, {
      previousOwnerRole,
      previousOwnerExited: removePreviousOwner,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    organizationId: context.id,
    ownerUserId: targetId,
    previousOwnerRole,
    retainedAdmin: retainAdmin,
    exited: removePreviousOwner,
  };
}

function organizationTransferRetainAdmin(payload = {}) {
  const hasCamelCase = Object.prototype.hasOwnProperty.call(payload, 'retainAdmin');
  const hasSnakeCase = Object.prototype.hasOwnProperty.call(payload, 'retain_admin');
  if (!hasCamelCase && !hasSnakeCase) return true;
  const value = hasCamelCase ? payload.retainAdmin : payload.retain_admin;
  if (typeof value !== 'boolean') throw new Error('转让后的管理员保留选项无效。');
  return value;
}

function assertOrganizationOwnerTransferConsistency(db, organizationId, ownerUserId, previousOwnerUserId, {
  previousOwnerRole = 'member',
  previousOwnerExited = false,
} = {}) {
  const ownership = get(db, `SELECT organization.owner_user_id,
      (SELECT COUNT(*) FROM contact_organization_members membership
        WHERE membership.organization_id=organization.id AND membership.role='owner') AS owner_count,
      (SELECT membership.user_id FROM contact_organization_members membership
        WHERE membership.organization_id=organization.id AND membership.role='owner' LIMIT 1) AS role_owner_user_id
    FROM contact_organizations organization WHERE organization.id=?`, [organizationId]);
  const workspaceId = `workspace_org_${organizationId}`;
  const accountId = `account_org_${organizationId}`;
  const workspace = get(db, 'SELECT owner_user_id FROM account_workspaces WHERE id=?', [workspaceId]);
  const workspaceOwner = get(db, 'SELECT role,status FROM account_workspace_memberships WHERE workspace_id=? AND user_id=?', [workspaceId, ownerUserId]);
  const workspacePreviousOwner = get(db, 'SELECT role,status FROM account_workspace_memberships WHERE workspace_id=? AND user_id=?', [workspaceId, previousOwnerUserId]);
  const account = get(db, 'SELECT owner_user_id FROM accounts WHERE id=?', [accountId]);
  const accountOwner = get(db, 'SELECT role,status FROM account_memberships WHERE account_id=? AND user_id=?', [accountId, ownerUserId]);
  const accountPreviousOwner = get(db, 'SELECT role,status FROM account_memberships WHERE account_id=? AND user_id=?', [accountId, previousOwnerUserId]);
  const previousOwnerStatus = previousOwnerExited ? 'left' : 'active';
  if (!ownership || ownership.owner_user_id !== ownerUserId || Number(ownership.owner_count) !== 1
    || ownership.role_owner_user_id !== ownerUserId
    || workspace?.owner_user_id !== ownerUserId || workspaceOwner?.role !== 'owner' || workspaceOwner?.status !== 'active'
    || workspacePreviousOwner?.role !== previousOwnerRole || workspacePreviousOwner?.status !== previousOwnerStatus
    || account?.owner_user_id !== ownerUserId || accountOwner?.role !== 'owner' || accountOwner?.status !== 'active'
    || accountPreviousOwner?.role !== previousOwnerRole || accountPreviousOwner?.status !== previousOwnerStatus) {
    throw new Error('组织创建者转让后的账号角色不一致，操作已回滚。');
  }
}

function requestOrganizationExit(db, context, userId) {
  const role = normalizeOrganizationRole(context.current_user_role);
  if (role === 'owner') throw new Error('创建者退出时需要先选择继任者或解散组织。');
  const existing = get(db, "SELECT id FROM contact_organization_exit_requests WHERE organization_id = ? AND requester_user_id = ? AND status = 'pending'", [context.id, userId]);
  if (existing) throw new Error('退出申请已经发送，请等待处理。');
  const id = newId('organization_exit');
  const now = nowIso();
  const requester = get(db, 'SELECT display_name,username,email FROM auth_users WHERE id = ?', [userId]) || {};
  const recipients = all(db, `SELECT user_id FROM contact_organization_members WHERE organization_id = ? AND user_id <> ? AND role IN (${role === 'admin' ? "'owner'" : "'owner','admin'"})`, [context.id, userId]);
  db.exec('BEGIN IMMEDIATE');
  try {
    run(db, `INSERT INTO contact_organization_exit_requests (id,organization_id,requester_user_id,requester_role,status,created_at,updated_at)
      VALUES (?,?,?,?,'pending',?,?)`, [id, context.id, userId, role, now, now]);
    for (const recipient of recipients) addOrganizationNotice(db, recipient.user_id, context, 'exit_request', '收到组织退出申请', `${requester.display_name || requester.username || requester.email || '一位成员'}申请退出“${context.name}”。`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { requestId: id, organizationId: context.id, status: 'pending' };
}

function resolveOrganizationExit(db, context, userId, payload) {
  const requestId = String(payload.requestId || '').trim();
  const request = get(db, "SELECT * FROM contact_organization_exit_requests WHERE id = ? AND organization_id = ? AND status = 'pending'", [requestId, context.id]);
  if (!request) throw new Error('退出申请不存在或已被处理。');
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  const requester = get(db, 'SELECT role FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, request.requester_user_id]);
  if (!requester) throw new Error('申请人已不在组织中。');
  const requesterRole = normalizeOrganizationRole(requester.role);
  if (actorRole !== 'owner' && !(actorRole === 'admin' && requesterRole === 'member')) throw new Error('你无权处理该退出申请。');
  const approve = String(payload.decision || '').toLowerCase() === 'approve';
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (approve) run(db, 'DELETE FROM contact_organization_members WHERE organization_id = ? AND user_id = ?', [context.id, request.requester_user_id]);
    run(db, 'UPDATE contact_organization_exit_requests SET status = ?, resolved_by_user_id = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = ?', [approve ? 'approved' : 'rejected', userId, now, now, request.id, 'pending']);
    addOrganizationNotice(db, request.requester_user_id, context, approve ? 'exit_approved' : 'exit_rejected', approve ? '退出组织申请已通过' : '退出组织申请未通过', approve ? `你已退出“${context.name}”。` : `你退出“${context.name}”的申请被管理员拒绝。`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { requestId, decision: approve ? 'approve' : 'reject' };
}

function ownerExitOrganization(db, context, userId, payload) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw new Error('只有组织创建者可以使用该退出方式。');
  const mode = String(payload.mode || 'auto').trim().toLowerCase();
  if (mode === 'dissolve') return dissolveOrganization(db, context, userId);
  let successorId = String(payload.successorUserId || '').trim();
  if (!successorId) {
    successorId = get(db, `SELECT user_id FROM contact_organization_members
      WHERE organization_id = ? AND user_id <> ?
      ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, joined_at ASC, user_id ASC LIMIT 1`, [context.id, userId])?.user_id || '';
  }
  if (!successorId) return dissolveOrganization(db, context, userId);
  return transferOrganizationOwner(db, context, userId, { targetUserId: successorId }, true);
}

function dissolveOrganization(db, context, userId) {
  const members = all(db, 'SELECT user_id FROM contact_organization_members WHERE organization_id = ? AND user_id <> ?', [context.id, userId]);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const member of members) addOrganizationNotice(db, member.user_id, context, 'organization_dissolved', '组织已解散', `创建者已解散“${context.name}”。`);
    run(db, 'DELETE FROM contact_organizations WHERE id = ?', [context.id]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { organizationId: context.id, dissolved: true, exited: true };
}

function organizationExitRequests(db, userId) {
  return all(db, `SELECT request.*, organization.name AS organization_name, organization.organization_number,
      actor.role AS current_user_role, requester.role AS current_requester_role,
      users.display_name, users.username, users.email, users.avatar_url
    FROM contact_organization_exit_requests request
    JOIN contact_organizations organization ON organization.id = request.organization_id
    JOIN contact_organization_members actor ON actor.organization_id = request.organization_id AND actor.user_id = ?
    LEFT JOIN contact_organization_members requester ON requester.organization_id = request.organization_id AND requester.user_id = request.requester_user_id
    JOIN auth_users users ON users.id = request.requester_user_id
    WHERE request.status = 'pending' AND (request.requester_user_id = ? OR actor.role = 'owner' OR (actor.role = 'admin' AND COALESCE(requester.role,request.requester_role) = 'member'))
    ORDER BY request.created_at ASC`, [userId, userId]).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationNumber: row.organization_number,
    requesterRole: normalizeOrganizationRole(row.current_requester_role || row.requester_role),
    currentUserRole: normalizeOrganizationRole(row.current_user_role),
    own: row.requester_user_id === userId,
    canResolve: row.requester_user_id !== userId && (row.current_user_role === 'owner' || (row.current_user_role === 'admin' && normalizeOrganizationRole(row.current_requester_role || row.requester_role) === 'member')),
    requester: publicUser({ ...row, id: row.requester_user_id }),
    createdAt: row.created_at,
  }));
}

function organizationNotices(db, userId) {
  return all(db, 'SELECT * FROM contact_organization_notices WHERE user_id = ? ORDER BY read_at = ? DESC, created_at DESC LIMIT 30', [userId, '']).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    type: row.type,
    title: row.title,
    content: row.content,
    read: Boolean(row.read_at),
    createdAt: row.created_at,
  }));
}

function addOrganizationNotice(db, userId, organization, type, title, content) {
  run(db, `INSERT INTO contact_organization_notices (id,user_id,organization_id,organization_name,type,title,content,created_at)
    VALUES (?,?,?,?,?,?,?,?)`, [newId('organization_notice'), userId, organization.id || '', organization.name || '', type, title, content, nowIso()]);
}

function normalizeOrganizationRole(role = '') {
  const value = String(role || '').trim().toLowerCase();
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function normalizeOrganizationName(value = '') {
  const name = String(value || '').trim();
  if (name.length < 2) throw new Error('组织名称至少需要 2 个字符。');
  if (name.length > 60) throw new Error('组织名称不能超过 60 个字符。');
  return name;
}

function normalizeOrganizationNumber(value = '') {
  const number = String(value || '').trim().toUpperCase();
  if (!ORGANIZATION_NUMBER_PATTERN.test(number)) {
    throw new Error('组织号需要 4–32 位，只能包含字母、数字、下划线或短横线。');
  }
  return number;
}

function nextDefaultOrganizationNumber(db) {
  const rows = all(
    db,
    "SELECT organization_number FROM contact_organizations WHERE upper(organization_number) LIKE 'ORG-%'",
  );
  return defaultOrganizationNumberFromRows(rows);
}

function defaultOrganizationNumberFromRows(rows = []) {
  let highest = 0;
  for (const row of rows) {
    const match = String(row.organization_number || '').toUpperCase().match(/^ORG-(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  const number = `ORG-${String(highest + 1).padStart(4, '0')}`;
  if (number.length > 32) throw new Error('自动生成组织号失败，请手动填写组织号。');
  return number;
}

function normalizeOrganizationVerificationCode(value = '') {
  const code = String(value || '');
  if (code.length < 6) throw new Error('组织邀请码至少需要 6 个字符。');
  if (code.length > 128) throw new Error('组织邀请码不能超过 128 个字符。');
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
