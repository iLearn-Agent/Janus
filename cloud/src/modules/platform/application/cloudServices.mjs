import crypto from 'node:crypto';

import { route } from '../../../../../network/server/express.js';
import { apiError } from '../../../errors.mjs';
import { inTransaction } from '../../../db.mjs';
import { normalizeMentionEntities } from '../../../../../src/shared/contracts/mentions.js';
import {
  delegationTransitionAllowed,
  isDelegationStatus,
  legacyDelegationTransitionAllowed,
  nextDelegationStatus,
  normalizeDelegationStatus,
  privateDelegationMetadata,
  privateWorkspaceMessageMetadata,
  publicDelegationMetadata,
  publicDelegationSubmissionText,
} from '../../collaboration/index.mjs';
import {
  hashEmailCode,
  hashPassword,
  hashRefreshToken,
  newId,
  randomToken,
  signAccessToken,
  signOrganizationSecondaryVerificationGrant,
  verifyAccessToken,
  verifyOrganizationSecondaryVerificationGrant,
  verifyPassword,
} from '../../../security.mjs';

const PERSONAL_ACCOUNT_WORKSPACE_ID = 'workspace_personal';
const SENSITIVE_ORGANIZATION_ACTIONS = new Set([
  'promote_admin', 'revoke_admin', 'remove_member', 'transfer_owner',
  'update_invitation_code', 'resolve_exit', 'owner_exit',
]);

function organizationAccountWorkspaceId(organizationId = '') {
  return `workspace_org_${String(organizationId || '').trim()}`;
}

function organizationAccountId(organizationId = '') {
  return `account_org_${String(organizationId || '').trim()}`;
}

async function ensurePersonalAccountWorkspaceMembership(db, userId, userRow = null) {
  const user = userRow || await one(db, 'SELECT * FROM users WHERE id=$1', [userId]);
  if (!user) throw apiError('user_not_found', '用户不存在。', 404);
  await db.query(
    `INSERT INTO account_workspaces(id,workspace_kind,name,status,updated_at)
     VALUES($1,'personal','个人空间','active',now())
     ON CONFLICT(id) DO UPDATE SET status='active',updated_at=excluded.updated_at`,
    [PERSONAL_ACCOUNT_WORKSPACE_ID],
  );
  await db.query(
    `INSERT INTO account_workspace_memberships(
       workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at
     ) VALUES($1,$2,'owner','active',$3,$4,COALESCE($5,now()),now())
     ON CONFLICT(workspace_id,user_id) DO UPDATE SET
       role='owner',status='active',display_name=excluded.display_name,
       avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`,
    [PERSONAL_ACCOUNT_WORKSPACE_ID, userId, user.display_name || '', user.avatar_url || '', user.created_at || null],
  );
}

async function ensureOrganizationAccountWorkspace(db, organization, userId = '', role = 'member') {
  if (!organization?.id) throw apiError('organization_not_found', '组织不存在。', 404);
  const workspaceId = organizationAccountWorkspaceId(organization.id);
  await db.query(
    `INSERT INTO account_workspaces(
       id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at
     ) VALUES($1,'organization',$2,$3,$4,'active',COALESCE($5,now()),now())
     ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,
       owner_user_id=excluded.owner_user_id,name=excluded.name,status='active',updated_at=excluded.updated_at`,
    [workspaceId, organization.id, organization.owner_user_id || '', organization.name || '', organization.created_at || null],
  );
  if (userId) {
    const workspaceRole = ['owner', 'admin'].includes(String(role || '').toLowerCase()) ? String(role).toLowerCase() : 'member';
    await db.query(
      `INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status,joined_at,updated_at)
       VALUES($1,$2,$3,'active',now(),now())
       ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',updated_at=excluded.updated_at`,
      [workspaceId, userId, workspaceRole],
    );
  }
  await syncOrganizationAccountPrincipal(db, organization, userId ? [{
    userId,
    role,
    status: 'active',
  }] : []);
  return workspaceId;
}

async function syncOrganizationAccountPrincipal(db, organization, memberships = []) {
  const available = await one(db, `SELECT 1 AS available FROM information_schema.tables
    WHERE table_name='accounts' LIMIT 1`);
  if (!available) return false;
  const accountId = organizationAccountId(organization.id);
  const workspaceId = organizationAccountWorkspaceId(organization.id);
  await db.query(`INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
    VALUES($1,'organization',$2,$3,$4,'active',COALESCE($5,now()),now())
    ON CONFLICT(id) DO UPDATE SET owner_user_id=excluded.owner_user_id,organization_id=excluded.organization_id,
      name=excluded.name,status='active',updated_at=excluded.updated_at`, [
    accountId,
    organization.owner_user_id || organization.ownerUserId || '',
    organization.id,
    organization.name || '未命名组织',
    organization.created_at || organization.createdAt || null,
  ]);
  await db.query(`INSERT INTO account_workspace_bindings_v8(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
    VALUES($1,$2,'','organization',COALESCE($3,now()),now())
    ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET account_id=excluded.account_id,
      binding_kind='organization',updated_at=excluded.updated_at`, [accountId, workspaceId, organization.created_at || organization.createdAt || null]);
  for (const membership of memberships) {
    const membershipRole = ['owner', 'admin'].includes(String(membership.role || '').toLowerCase())
      ? String(membership.role).toLowerCase() : 'member';
    const membershipStatus = ['left', 'removed', 'suspended'].includes(String(membership.status || '').toLowerCase())
      ? String(membership.status).toLowerCase() : 'active';
    await db.query(`INSERT INTO account_memberships_v8(account_id,user_id,role,status,joined_at,updated_at)
      VALUES($1,$2,$3,$4,COALESCE($5,now()),now())
      ON CONFLICT(account_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status,updated_at=excluded.updated_at`, [
      accountId,
      membership.userId,
      membershipRole,
      membershipStatus,
      membership.joinedAt || null,
    ]);
  }
  return true;
}

async function updateOrganizationAccountWorkspaceMembership(db, organizationId, userId, { role = '', status = '' } = {}) {
  const updates = [];
  const params = [];
  if (role) {
    params.push(['owner', 'admin'].includes(String(role).toLowerCase()) ? String(role).toLowerCase() : 'member');
    updates.push(`role=$${params.length}`);
  }
  if (status) {
    params.push(String(status));
    updates.push(`status=$${params.length}`);
  }
  if (!updates.length) return;
  params.push(organizationAccountWorkspaceId(organizationId), userId);
  await db.query(
    `UPDATE account_workspace_memberships SET ${updates.join(',')},updated_at=now()
     WHERE workspace_id=$${params.length - 1} AND user_id=$${params.length}`,
    params,
  );
}

function authMiddleware(pool, config) {
  return route(async (req, _res, next) => {
    req.auth = { user: await authenticateRequest(pool, config, req) };
    next();
  });
}

async function authenticateRequest(pool, config, req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) throw apiError('unauthorized', '请先登录账号。', 401);
  let payload;
  try {
    payload = verifyAccessToken(match[1], config.jwtSecret);
  } catch {
    throw apiError('unauthorized', '登录状态已过期，请重新登录。', 401);
  }
  const user = await getUserById(pool, payload.sub);
  if (!user) throw apiError('unauthorized', '请先登录账号。', 401);
  return user;
}

async function sessionResponse(pool, config, user) {
  const accessToken = signAccessToken({
    userId: user.id,
    secret: config.jwtSecret,
    expiresInSeconds: config.accessTokenTtlSeconds,
  });
  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, revoked, expires_at, created_at)
     VALUES ($1, $2, $3, false, $4, now())`,
    [newId('refresh'), user.id, hashRefreshToken(refreshToken, config.jwtSecret), expiresAt],
  );
  return {
    user,
    accessToken,
    refreshToken,
    provider: 'cloud',
  };
}

async function consumeEmailCode(client, config, { email, purpose, code }) {
  if (!code) throw apiError('email_code_required', '请输入邮箱验证码。', 400);
  const row = await one(
    client,
    `SELECT * FROM email_verifications
     WHERE email = $1 AND purpose = $2 AND consumed = false
     ORDER BY created_at DESC
     LIMIT 1`,
    [email, purpose],
  );
  if (!row) throw apiError('email_code_required', '请先获取邮箱验证码。', 400);
  if (new Date(row.expires_at).getTime() <= Date.now()) throw apiError('email_code_expired', '邮箱验证码已过期。', 400);
  const expected = hashEmailCode({ email, purpose, code, secret: config.emailCodeSecret });
  if (row.code_hash !== expected) throw apiError('email_code_invalid', '邮箱验证码不正确。', 400);
  await client.query('UPDATE email_verifications SET consumed = true WHERE id = $1', [row.id]);
}

async function friendsOverview(db, userId) {
  const friends = (await many(
    db,
    `SELECT f.*, u.id AS friend_id, u.email, u.display_name, u.display_name AS account_display_name,
            u.username, u.avatar_url, u.role, u.email_verified,
            u.updated_at AS friend_updated_at,
            CASE WHEN remark.remark IS NOT NULL AND remark.remark<>'' THEN remark.remark
              ELSE CASE WHEN f.user_a_id=$1 THEN f.user_a_remark ELSE f.user_b_remark END END AS friend_remark,
            presence.last_seen_at
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_a_id = $1 THEN f.user_b_id ELSE f.user_a_id END
     LEFT JOIN social_contact_remarks remark ON remark.owner_user_id=$1 AND remark.target_user_id=u.id
     LEFT JOIN (
       SELECT user_id, max(last_seen_at) AS last_seen_at
       FROM user_presence
       GROUP BY user_id
     ) presence ON presence.user_id = u.id
     WHERE (f.user_a_id = $1 OR f.user_b_id = $1) AND f.status = 'accepted'
     ORDER BY f.updated_at DESC`,
    [userId],
  )).map(friendshipPayload);

  const incoming = (await many(
    db,
    `SELECT fr.*, u.id AS friend_id, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified,
            u.updated_at AS friend_updated_at
     FROM friend_requests fr
     JOIN users u ON u.id = fr.requester_id
     WHERE fr.recipient_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [userId],
  )).map((row) => friendRequestPayload(row, 'incoming'));

  const outgoing = (await many(
    db,
    `SELECT fr.*, u.id AS friend_id, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified,
            u.updated_at AS friend_updated_at
     FROM friend_requests fr
     JOIN users u ON u.id = fr.recipient_id
     WHERE fr.requester_id = $1 AND fr.status = 'pending'
     ORDER BY fr.created_at DESC`,
    [userId],
  )).map((row) => friendRequestPayload(row, 'outgoing'));

  const organization = await organizationOverview(db, userId);
  return {
    friends,
    requests: { incoming, outgoing },
    organizations: organization.organizations,
    organizationExitRequests: organization.organizationExitRequests || [],
    organizationNotices: organization.organizationNotices || [],
  };
}

async function organizationOverview(db, userId) {
  const rows = await many(
    db,
    `SELECT org.*, membership.role AS current_user_role, membership.joined_at AS current_user_joined_at
     FROM contact_organizations org
     JOIN contact_organization_members membership ON membership.organization_id = org.id
     WHERE membership.user_id = $1
     ORDER BY CASE WHEN membership.role = 'owner' THEN 0 ELSE 1 END, lower(org.name), org.organization_number`,
    [userId],
  );
  const organizations = [];
  for (const row of rows) organizations.push(await organizationPayload(db, row, userId));
  return {
    organizations,
    organizationExitRequests: await organizationExitRequests(db, userId),
    organizationNotices: await organizationNotices(db, userId),
  };
}

async function createOrganization(db, userId, payload = {}) {
  const name = normalizeOrganizationName(payload.name);
  const verificationCode = normalizeOrganizationVerificationCode(payload.verificationCode || payload.secret);
  const requestedNumber = payload.organizationNumber || payload.organization_number;
  const hasRequestedNumber = Boolean(String(requestedNumber || '').trim());
  const id = newId('organization');
  const salt = crypto.randomBytes(16).toString('hex');
  let organizationNumber = '';
  let created = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    organizationNumber = hasRequestedNumber
      ? normalizeOrganizationNumber(requestedNumber)
      : await nextDefaultOrganizationNumber(db);
    if (await one(db, 'SELECT id FROM contact_organizations WHERE lower(organization_number) = lower($1)', [organizationNumber])) {
      if (hasRequestedNumber) {
        throw apiError('organization_number_exists', '该组织号已被使用，请更换后重试。', 409);
      }
      continue;
    }
    try {
      await inTransaction(db, async (client) => {
        await client.query(
          `INSERT INTO contact_organizations (
            id, organization_number, name, verification_code_salt, verification_code_hash, owner_user_id, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())`,
          [id, organizationNumber, name, salt, organizationVerificationCodeHash(verificationCode, salt), userId],
        );
        await client.query(
          `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
           VALUES ($1, $2, 'owner', now(), now())`,
          [id, userId],
        );
        await ensureOrganizationAccountWorkspace(client, {
          id,
          owner_user_id: userId,
          name,
        }, userId, 'owner');
      });
      created = true;
      break;
    } catch (error) {
      if (!isOrganizationNumberConflict(error)) throw error;
      if (hasRequestedNumber) throw apiError('organization_number_exists', '该组织号已被使用，请更换后重试。', 409);
      organizationNumber = '';
    }
  }
  if (!created) throw apiError('organization_number_generation_failed', '自动生成组织号失败，请手动填写组织号。', 409);
  const overview = await friendsOverview(db, userId);
  return { ok: true, organization: overview.organizations.find((item) => item.id === id) || null, overview };
}

async function joinOrganization(db, userId, payload = {}) {
  const organizationNumber = normalizeOrganizationNumber(payload.organizationNumber || payload.organization_number);
  const verificationCode = normalizeOrganizationVerificationCode(payload.verificationCode || payload.secret);
  const organization = await one(db, 'SELECT * FROM contact_organizations WHERE lower(organization_number) = lower($1)', [organizationNumber]);
  if (!organization) throw apiError('organization_not_found', '未找到该组织，请检查组织号。', 404);
  if (!organizationVerificationCodeMatches(verificationCode, organization.verification_code_salt, organization.verification_code_hash)) {
    throw apiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  if (await one(db, 'SELECT 1 FROM contact_organization_members WHERE organization_id = $1 AND user_id = $2', [organization.id, userId])) {
    throw apiError('organization_already_joined', '你已经加入该组织。', 409);
  }
  await inTransaction(db, async (client) => {
    await client.query(
      `INSERT INTO contact_organization_members (organization_id, user_id, role, joined_at, updated_at)
       VALUES ($1, $2, 'member', now(), now())`,
      [organization.id, userId],
    );
    await ensureOrganizationAccountWorkspace(client, organization, userId, 'member');
    await client.query('UPDATE contact_organizations SET updated_at = now() WHERE id = $1', [organization.id]);
  });
  const overview = await friendsOverview(db, userId);
  return { ok: true, organization: overview.organizations.find((item) => item.id === organization.id) || null, overview };
}

async function organizationPayload(db, row = {}, viewerUserId = '') {
  const members = (await many(
    db,
    `SELECT membership.role AS organization_role,membership.display_name_override,membership.joined_at,
            users.id,users.email,users.display_name,users.display_name AS account_display_name,
            users.username,users.avatar_url,users.role,users.email_verified,COALESCE(remark.remark,'') AS contact_remark
     FROM contact_organization_members membership
     JOIN users ON users.id = membership.user_id
     LEFT JOIN social_contact_remarks remark ON remark.owner_user_id=$2 AND remark.target_user_id=membership.user_id
     WHERE membership.organization_id = $1
     ORDER BY CASE WHEN membership.role = 'owner' THEN 0 ELSE 1 END,
       lower(CASE WHEN membership.display_name_override<>'' THEN membership.display_name_override ELSE users.display_name END),lower(coalesce(users.username,''))`,
    [row.id, viewerUserId],
  )).map((member) => ({
    role: normalizeOrganizationRole(member.organization_role),
    joinedAt: toIso(member.joined_at),
    displayNameOverride: member.display_name_override || '',
    user: {
      ...publicUser({ ...member, display_name: member.display_name_override || member.display_name }),
      accountDisplayName: member.account_display_name || '',
      remark: member.contact_remark || '',
    },
  }));
  return {
    id: row.id,
    organizationNumber: row.organization_number,
    name: row.name,
    role: normalizeOrganizationRole(row.current_user_role),
    ownerUserId: row.owner_user_id,
    owner: members.find((member) => member.role === 'owner')?.user || null,
    memberCount: Number(row.member_count || members.length),
    members,
    source: 'cloud',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function organizationAction(db, userId, payload = {}, { config = {} } = {}) {
  const action = String(payload.action || '').trim().toLowerCase();
  if (action === 'acknowledge_notice') {
    await db.query('UPDATE contact_organization_notices SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [String(payload.noticeId || ''), userId]);
    return { ok: true, overview: await friendsOverview(db, userId) };
  }
  const organizationId = String(payload.organizationId || '').trim();
  const context = await one(db, `SELECT organization.*, membership.role AS current_user_role
    FROM contact_organizations organization
    JOIN contact_organization_members membership ON membership.organization_id = organization.id
    WHERE organization.id = $1 AND membership.user_id = $2`, [organizationId, userId]);
  if (!context) throw apiError('organization_not_found', '组织不存在或你已不在该组织中。', 404);
  if (['update_invitation_code', 'reset_invitation_code'].includes(action)
    && normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw apiError('organization_owner_required', '只有组织创建者可以修改邀请码。', 403);
  }
  let secondaryVerification = {};
  if (SENSITIVE_ORGANIZATION_ACTIONS.has(action)) {
    secondaryVerification = await requireOrganizationSensitiveVerification(db, context, userId, payload, { config });
  }
  let result;
  if (action === 'set_display_name') result = await updateOrganizationDisplayName(db, context, userId, payload);
  else if (action === 'request_exit') result = await requestOrganizationExit(db, context, userId);
  else if (action === 'resolve_exit') result = await resolveOrganizationExit(db, context, userId, payload);
  else if (action === 'validate_invitation_code') result = validateOrganizationInvitationCode(context, payload);
  else {
    if (action === 'reset_invitation_code') {
      result = await resetOrganizationInvitationCode(db, context, userId, payload, { config });
    } else {
      if (action === 'promote_admin') result = await setOrganizationAdmin(db, context, userId, payload, true);
      else if (action === 'revoke_admin') result = await setOrganizationAdmin(db, context, userId, payload, false);
      else if (action === 'remove_member') result = await removeOrganizationMember(db, context, userId, payload);
      else if (action === 'transfer_owner') result = await transferOrganizationOwner(db, context, userId, payload, false);
      else if (action === 'update_invitation_code') result = await updateOrganizationInvitationCode(db, context, userId, payload);
      else if (action === 'owner_exit') result = await organizationOwnerExit(db, context, userId, payload);
      else throw apiError('organization_action_invalid', '不支持的组织操作。', 400);
    }
  }
  return { ok: true, ...result, ...secondaryVerification, overview: await friendsOverview(db, userId) };
}

async function updateOrganizationDisplayName(db, context, userId, payload = {}) {
  const displayName = String(payload.displayName || payload.display_name || '').trim().slice(0, 80);
  await inTransaction(db, async (client) => {
    await client.query(`UPDATE contact_organization_members SET display_name_override=$1,updated_at=now()
      WHERE organization_id=$2 AND user_id=$3`, [displayName, context.id, userId]);
    const account = await one(client, 'SELECT display_name FROM users WHERE id=$1', [userId]);
    await client.query(`UPDATE account_workspace_memberships SET display_name=$1,updated_at=now()
      WHERE workspace_id=$2 AND user_id=$3`, [displayName || account?.display_name || '', organizationAccountWorkspaceId(context.id), userId]);
  });
  return { organizationId: context.id, displayName };
}

function validateOrganizationInvitationCode(context, payload = {}) {
  const code = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organizationVerificationCodeMatches(code, context.verification_code_salt, context.verification_code_hash)) {
    throw apiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  return {
    invitationCodeValid: true,
    organizationId: context.id,
    organizationNumber: context.organization_number || '',
    organizationName: context.name || '未命名组织',
  };
}

async function requireOrganizationSensitiveVerification(db, organization, userId, payload, { config = {} } = {}) {
  const grant = String(payload.secondaryVerificationGrant || '').trim();
  if (!grant && payload.secondaryVerificationExpected
    && !payload.verificationCode && !payload.organizationVerificationCode
    && !payload.accountPassword && !payload.password) {
    throw apiError('organization_secondary_verification_expired', '本次登录的二次验证已失效，请重新验证。', 403);
  }
  if (grant) {
    try {
      verifyOrganizationSecondaryVerificationGrant(grant, {
        userId,
        organizationId: organization.id,
        secret: config.jwtSecret,
      });
      return { secondaryVerificationRemembered: true, secondaryVerificationGrant: grant };
    } catch {
      if (!payload.verificationCode && !payload.organizationVerificationCode
        && !payload.accountPassword && !payload.password) {
        throw apiError('organization_secondary_verification_expired', '本次登录的二次验证已失效，请重新验证。', 403);
      }
    }
  }
  const code = normalizeOrganizationVerificationCode(payload.verificationCode || payload.organizationVerificationCode || '');
  if (!organizationVerificationCodeMatches(code, organization.verification_code_salt, organization.verification_code_hash)) {
    throw apiError('organization_verification_code_invalid', '组织邀请码不正确。', 403);
  }
  const user = await one(db, 'SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!user || !verifyPassword(payload.accountPassword || payload.password || '', user.password_hash || '')) {
    throw apiError('account_password_invalid', '当前账号密码不正确。', 403);
  }
  if (payload.rememberSecondaryVerification !== true) return {};
  const secondaryVerificationGrant = signOrganizationSecondaryVerificationGrant({
    userId,
    organizationId: organization.id,
    secret: config.jwtSecret,
    expiresInSeconds: config.organizationSecondaryVerificationTtlSeconds,
  });
  return { secondaryVerificationRemembered: true, secondaryVerificationGrant };
}

async function updateOrganizationInvitationCode(db, context, userId, payload = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw apiError('organization_owner_required', '只有组织创建者可以修改邀请码。', 403);
  }
  const invitationCode = normalizeOrganizationVerificationCode(payload.newInvitationCode || payload.newVerificationCode || '');
  if (organizationVerificationCodeMatches(invitationCode, context.verification_code_salt, context.verification_code_hash)) {
    throw apiError('organization_invitation_code_unchanged', '新邀请码不能与当前邀请码相同。', 409);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await db.query(`UPDATE contact_organizations SET verification_code_salt=$1,verification_code_hash=$2,updated_at=now()
    WHERE id=$3 AND owner_user_id=$4`, [salt, organizationVerificationCodeHash(invitationCode, salt), context.id, userId]);
  return { organizationId: context.id, invitationCodeUpdated: true };
}

async function resetOrganizationInvitationCode(db, context, userId, payload = {}, { config = {} } = {}) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') {
    throw apiError('organization_owner_required', '只有组织创建者可以重置邀请码。', 403);
  }
  const account = await one(db, 'SELECT email,email_verified FROM users WHERE id=$1', [userId]);
  if (!account?.email || !account.email_verified) {
    throw apiError('verified_email_required', '当前账号需要先绑定并验证邮箱，才能重置组织邀请码。', 403);
  }
  return inTransaction(db, async (client) => {
    await consumeEmailCode(client, config, {
      email: String(account.email).trim().toLowerCase(),
      purpose: 'organization_invitation_reset',
      code: payload.emailCode || payload.code || '',
    });
    const result = await updateOrganizationInvitationCode(client, context, userId, payload);
    return { ...result, invitationCodeReset: true };
  });
}

async function setOrganizationAdmin(db, context, userId, payload, promote) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw apiError('organization_owner_required', '只有组织创建者可以调整管理员权限。', 403);
  const targetId = String(payload.targetUserId || '').trim();
  const target = await one(db, 'SELECT role FROM contact_organization_members WHERE organization_id = $1 AND user_id = $2', [context.id, targetId]);
  const targetRole = normalizeOrganizationRole(target?.role);
  if (!target || targetId === userId || targetRole === 'owner') throw apiError('organization_member_invalid', '请选择有效组织成员。', 400);
  if ((promote && targetRole === 'admin') || (!promote && targetRole !== 'admin')) throw apiError('organization_role_unchanged', promote ? '该成员已经是管理员。' : '该成员不是管理员。', 409);
  const nextRole = promote ? 'admin' : 'member';
  await inTransaction(db, async (client) => {
    await client.query('UPDATE contact_organization_members SET role = $1, updated_at = now() WHERE organization_id = $2 AND user_id = $3', [nextRole, context.id, targetId]);
    await updateOrganizationAccountWorkspaceMembership(client, context.id, targetId, { role: nextRole, status: 'active' });
    await addOrganizationNotice(client, targetId, context, promote ? 'role_admin' : 'role_member', promote ? '你已成为组织管理员' : '管理员权限已被移除', promote ? `你已被任命为“${context.name}”的管理员。` : `你在“${context.name}”中的管理员权限已被创建者移除。`);
  });
  return { targetUserId: targetId, role: nextRole };
}

async function removeOrganizationMember(db, context, userId, payload) {
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  const targetId = String(payload.targetUserId || '').trim();
  const target = await one(db, 'SELECT role FROM contact_organization_members WHERE organization_id = $1 AND user_id = $2', [context.id, targetId]);
  const targetRole = normalizeOrganizationRole(target?.role);
  if (!['owner', 'admin'].includes(actorRole)) throw apiError('organization_admin_required', '只有创建者或管理员可以移除组织成员。', 403);
  if (!target || targetId === userId || targetRole === 'owner' || (actorRole === 'admin' && targetRole !== 'member')) throw apiError('organization_remove_forbidden', '你不能移除同级管理员或组织创建者。', 403);
  await inTransaction(db, async (client) => {
    await client.query('DELETE FROM contact_organization_members WHERE organization_id = $1 AND user_id = $2', [context.id, targetId]);
    await updateOrganizationAccountWorkspaceMembership(client, context.id, targetId, { status: 'removed' });
    await client.query("UPDATE contact_organization_exit_requests SET status='cancelled',resolved_by_user_id=$1,resolved_at=now(),updated_at=now() WHERE organization_id=$2 AND requester_user_id=$3 AND status='pending'", [userId, context.id, targetId]);
    await addOrganizationNotice(client, targetId, context, 'member_removed', '你已被移出组织', `你已被管理员从“${context.name}”中移出。`);
  });
  return { targetUserId: targetId, removed: true };
}

async function transferOrganizationOwner(db, context, userId, payload, removePreviousOwner) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw apiError('organization_owner_required', '只有组织创建者可以转让组织。', 403);
  const targetId = String(payload.targetUserId || payload.successorUserId || '').trim();
  const retainAdmin = removePreviousOwner ? false : organizationTransferRetainAdmin(payload);
  const previousOwnerRole = retainAdmin ? 'admin' : 'member';
  await inTransaction(db, async (client) => {
    const currentOwner = await one(client, `SELECT organization.owner_user_id,membership.role,membership.joined_at
      FROM contact_organizations organization
      JOIN contact_organization_members membership
        ON membership.organization_id=organization.id AND membership.user_id=$1
      WHERE organization.id=$2 FOR UPDATE`, [userId, context.id]);
    if (!currentOwner || currentOwner.owner_user_id !== userId || normalizeOrganizationRole(currentOwner.role) !== 'owner') {
      throw apiError('organization_owner_changed', '组织创建者身份已发生变化，请刷新后重试。', 409);
    }
    const target = await one(client, `SELECT role,joined_at FROM contact_organization_members
      WHERE organization_id=$1 AND user_id=$2`, [context.id, targetId]);
    if (!targetId || targetId === userId || !target) throw apiError('organization_successor_invalid', '请选择其他组织成员作为新创建者。', 400);
    await client.query('UPDATE contact_organization_members SET role=$1,updated_at=now() WHERE organization_id=$2 AND user_id=$3', [previousOwnerRole, context.id, userId]);
    await client.query("UPDATE contact_organization_members SET role='owner',updated_at=now() WHERE organization_id=$1 AND user_id=$2", [context.id, targetId]);
    await client.query('UPDATE contact_organizations SET owner_user_id=$1,updated_at=now() WHERE id=$2', [targetId, context.id]);
    await client.query('UPDATE account_workspaces SET owner_user_id=$1,updated_at=now() WHERE id=$2', [targetId, organizationAccountWorkspaceId(context.id)]);
    await updateOrganizationAccountWorkspaceMembership(client, context.id, targetId, { role: 'owner', status: 'active' });
    await updateOrganizationAccountWorkspaceMembership(client, context.id, userId, { role: previousOwnerRole, status: removePreviousOwner ? 'left' : 'active' });
    if (removePreviousOwner) await client.query('DELETE FROM contact_organization_members WHERE organization_id=$1 AND user_id=$2', [context.id, userId]);
    await addOrganizationNotice(client, targetId, context, 'owner_transferred', '你已成为组织创建者', `“${context.name}”已转让给你，你现在拥有该组织的最高管理权限。`);
    const principalProjectionAvailable = await syncOrganizationAccountPrincipal(client, {
      ...context,
      owner_user_id: targetId,
    }, [
      { userId: targetId, role: 'owner', status: 'active', joinedAt: target.joined_at },
      { userId, role: previousOwnerRole, status: removePreviousOwner ? 'left' : 'active', joinedAt: currentOwner.joined_at },
    ]);
    await assertOrganizationOwnerTransferConsistency(client, context.id, targetId, userId, {
      previousOwnerRole,
      previousOwnerExited: removePreviousOwner,
      principalProjectionAvailable,
    });
  });
  return {
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
  if (typeof value !== 'boolean') {
    throw apiError('organization_retain_admin_invalid', '转让后的管理员保留选项无效。', 400);
  }
  return value;
}

async function assertOrganizationOwnerTransferConsistency(db, organizationId, ownerUserId, previousOwnerUserId, {
  previousOwnerRole = 'member',
  previousOwnerExited = false,
  principalProjectionAvailable = false,
} = {}) {
  const organization = await one(db, 'SELECT owner_user_id FROM contact_organizations WHERE id=$1', [organizationId]);
  const ownerMemberships = await many(db, `SELECT user_id FROM contact_organization_members
    WHERE organization_id=$1 AND role='owner'`, [organizationId]);
  const workspaceId = organizationAccountWorkspaceId(organizationId);
  const workspace = await one(db, 'SELECT owner_user_id FROM account_workspaces WHERE id=$1', [workspaceId]);
  const workspaceOwner = await one(db, `SELECT role,status FROM account_workspace_memberships
    WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, ownerUserId]);
  const workspacePreviousOwner = await one(db, `SELECT role,status FROM account_workspace_memberships
    WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, previousOwnerUserId]);
  const previousOwnerStatus = previousOwnerExited ? 'left' : 'active';
  let principalConsistent = true;
  if (principalProjectionAvailable) {
    const accountId = organizationAccountId(organizationId);
    const account = await one(db, 'SELECT owner_user_id FROM accounts WHERE id=$1', [accountId]);
    const accountOwner = await one(db, 'SELECT role,status FROM account_memberships_v8 WHERE account_id=$1 AND user_id=$2', [accountId, ownerUserId]);
    const accountPreviousOwner = await one(db, 'SELECT role,status FROM account_memberships_v8 WHERE account_id=$1 AND user_id=$2', [accountId, previousOwnerUserId]);
    principalConsistent = account?.owner_user_id === ownerUserId
      && accountOwner?.role === 'owner' && accountOwner?.status === 'active'
      && accountPreviousOwner?.role === previousOwnerRole && accountPreviousOwner?.status === previousOwnerStatus;
  }
  if (!organization || organization.owner_user_id !== ownerUserId || ownerMemberships.length !== 1
    || ownerMemberships[0]?.user_id !== ownerUserId
    || workspace?.owner_user_id !== ownerUserId || workspaceOwner?.role !== 'owner' || workspaceOwner?.status !== 'active'
    || workspacePreviousOwner?.role !== previousOwnerRole || workspacePreviousOwner?.status !== previousOwnerStatus
    || !principalConsistent) {
    throw apiError('organization_transfer_inconsistent', '组织创建者转让后的账号角色不一致，操作已回滚。', 500);
  }
}

async function requestOrganizationExit(db, context, userId) {
  const role = normalizeOrganizationRole(context.current_user_role);
  if (role === 'owner') throw apiError('organization_owner_exit_choice_required', '创建者退出时需要先选择继任者或解散组织。', 400);
  if (await one(db, "SELECT 1 FROM contact_organization_exit_requests WHERE organization_id=$1 AND requester_user_id=$2 AND status='pending'", [context.id, userId])) throw apiError('organization_exit_pending', '退出申请已经发送，请等待处理。', 409);
  const id = newId('organization_exit');
  const requester = await one(db, 'SELECT display_name,username,email FROM users WHERE id=$1', [userId]) || {};
  const recipients = await many(db, `SELECT user_id FROM contact_organization_members WHERE organization_id=$1 AND user_id<>$2 AND role IN (${role === 'admin' ? "'owner'" : "'owner','admin'"})`, [context.id, userId]);
  await inTransaction(db, async (client) => {
    await client.query("INSERT INTO contact_organization_exit_requests(id,organization_id,requester_user_id,requester_role,status) VALUES($1,$2,$3,$4,'pending')", [id, context.id, userId, role]);
    for (const recipient of recipients) await addOrganizationNotice(client, recipient.user_id, context, 'exit_request', '收到组织退出申请', `${requester.display_name || requester.username || requester.email || '一位成员'}申请退出“${context.name}”。`);
  });
  return { requestId: id, status: 'pending' };
}

async function resolveOrganizationExit(db, context, userId, payload) {
  const request = await one(db, "SELECT * FROM contact_organization_exit_requests WHERE id=$1 AND organization_id=$2 AND status='pending'", [String(payload.requestId || ''), context.id]);
  if (!request) throw apiError('organization_exit_not_found', '退出申请不存在或已被处理。', 404);
  const requester = await one(db, 'SELECT role FROM contact_organization_members WHERE organization_id=$1 AND user_id=$2', [context.id, request.requester_user_id]);
  const actorRole = normalizeOrganizationRole(context.current_user_role);
  const requesterRole = normalizeOrganizationRole(requester?.role || request.requester_role);
  if (!requester || (actorRole !== 'owner' && !(actorRole === 'admin' && requesterRole === 'member'))) throw apiError('organization_exit_forbidden', '你无权处理该退出申请。', 403);
  const approve = String(payload.decision || '').toLowerCase() === 'approve';
  await inTransaction(db, async (client) => {
    if (approve) {
      await client.query('DELETE FROM contact_organization_members WHERE organization_id=$1 AND user_id=$2', [context.id, request.requester_user_id]);
      await updateOrganizationAccountWorkspaceMembership(client, context.id, request.requester_user_id, { status: 'left' });
    }
    const updated = await client.query("UPDATE contact_organization_exit_requests SET status=$1,resolved_by_user_id=$2,resolved_at=now(),updated_at=now() WHERE id=$3 AND status='pending'", [approve ? 'approved' : 'rejected', userId, request.id]);
    if (updated.rowCount !== 1) throw apiError('organization_exit_resolved', '该退出申请已被其他管理员处理。', 409);
    await addOrganizationNotice(client, request.requester_user_id, context, approve ? 'exit_approved' : 'exit_rejected', approve ? '退出组织申请已通过' : '退出组织申请未通过', approve ? `你已退出“${context.name}”。` : `你退出“${context.name}”的申请被管理员拒绝。`);
  });
  return { requestId: request.id, decision: approve ? 'approve' : 'reject' };
}

async function organizationOwnerExit(db, context, userId, payload) {
  if (normalizeOrganizationRole(context.current_user_role) !== 'owner') throw apiError('organization_owner_required', '只有组织创建者可以使用该退出方式。', 403);
  if (String(payload.mode || '').toLowerCase() === 'dissolve') return dissolveOrganization(db, context, userId);
  let successorId = String(payload.successorUserId || '').trim();
  if (!successorId) successorId = (await one(db, "SELECT user_id FROM contact_organization_members WHERE organization_id=$1 AND user_id<>$2 ORDER BY CASE WHEN role='admin' THEN 0 ELSE 1 END,joined_at,user_id LIMIT 1", [context.id, userId]))?.user_id || '';
  return successorId ? transferOrganizationOwner(db, context, userId, { targetUserId: successorId }, true) : dissolveOrganization(db, context, userId);
}

async function dissolveOrganization(db, context, userId) {
  const members = await many(db, 'SELECT user_id FROM contact_organization_members WHERE organization_id=$1 AND user_id<>$2', [context.id, userId]);
  await inTransaction(db, async (client) => {
    for (const member of members) await addOrganizationNotice(client, member.user_id, context, 'organization_dissolved', '组织已解散', `创建者已解散“${context.name}”。`);
    await client.query("UPDATE account_workspace_memberships SET status='removed',updated_at=now() WHERE workspace_id=$1", [organizationAccountWorkspaceId(context.id)]);
    await client.query("UPDATE account_workspaces SET status='inactive',updated_at=now() WHERE id=$1", [organizationAccountWorkspaceId(context.id)]);
    await client.query('DELETE FROM contact_organizations WHERE id=$1', [context.id]);
  });
  return { dissolved: true, exited: true };
}

async function organizationExitRequests(db, userId) {
  const rows = await many(db, `SELECT request.*,organization.name AS organization_name,organization.organization_number,
      actor.role AS current_user_role,requester.role AS current_requester_role,
      users.email,users.display_name,users.username,users.avatar_url,users.role,users.email_verified
    FROM contact_organization_exit_requests request
    JOIN contact_organizations organization ON organization.id=request.organization_id
    JOIN contact_organization_members actor ON actor.organization_id=request.organization_id AND actor.user_id=$1
    LEFT JOIN contact_organization_members requester ON requester.organization_id=request.organization_id AND requester.user_id=request.requester_user_id
    JOIN users ON users.id=request.requester_user_id
    WHERE request.status='pending' AND (request.requester_user_id=$1 OR actor.role='owner' OR (actor.role='admin' AND COALESCE(requester.role,request.requester_role)='member'))
    ORDER BY request.created_at`, [userId]);
  return rows.map((row) => ({ id: row.id, organizationId: row.organization_id, organizationName: row.organization_name, organizationNumber: row.organization_number, requesterRole: normalizeOrganizationRole(row.current_requester_role || row.requester_role), currentUserRole: normalizeOrganizationRole(row.current_user_role), own: row.requester_user_id === userId, canResolve: row.requester_user_id !== userId && (row.current_user_role === 'owner' || (row.current_user_role === 'admin' && normalizeOrganizationRole(row.current_requester_role || row.requester_role) === 'member')), requester: publicUser({ ...row, id: row.requester_user_id }), createdAt: toIso(row.created_at) }));
}

async function organizationNotices(db, userId) {
  const rows = await many(db, 'SELECT * FROM contact_organization_notices WHERE user_id=$1 ORDER BY (read_at IS NULL) DESC,created_at DESC LIMIT 30', [userId]);
  return rows.map((row) => ({ id: row.id, organizationId: row.organization_id || '', organizationName: row.organization_name, type: row.type, title: row.title, content: row.content, read: Boolean(row.read_at), createdAt: toIso(row.created_at) }));
}

async function addOrganizationNotice(db, userId, organization, type, title, content) {
  await db.query('INSERT INTO contact_organization_notices(id,user_id,organization_id,organization_name,type,title,content) VALUES($1,$2,$3,$4,$5,$6,$7)', [newId('organization_notice'), userId, organization.id || null, organization.name || '', type, title, content]);
}

function normalizeOrganizationRole(role = '') {
  const value = String(role || '').trim().toLowerCase();
  return value === 'owner' || value === 'admin' ? value : 'member';
}

function normalizeOrganizationName(value = '') {
  const name = String(value || '').trim();
  if (name.length < 2) throw apiError('organization_name_invalid', '组织名称至少需要 2 个字符。', 400);
  if (name.length > 60) throw apiError('organization_name_invalid', '组织名称不能超过 60 个字符。', 400);
  return name;
}

function normalizeOrganizationNumber(value = '') {
  const number = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(number)) {
    throw apiError('organization_number_invalid', '组织号需要 4–32 位，只能包含字母、数字、下划线或短横线。', 400);
  }
  return number;
}

async function nextDefaultOrganizationNumber(db) {
  const rows = await many(
    db,
    "SELECT organization_number FROM contact_organizations WHERE upper(organization_number) LIKE 'ORG-%'",
  );
  let highest = 0;
  for (const row of rows) {
    const match = String(row.organization_number || '').toUpperCase().match(/^ORG-(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]) || 0);
  }
  const number = `ORG-${String(highest + 1).padStart(4, '0')}`;
  if (number.length > 32) throw apiError('organization_number_generation_failed', '自动生成组织号失败，请手动填写组织号。', 500);
  return number;
}

function isOrganizationNumberConflict(error) {
  return error?.code === '23505' || /contact_organizations.*organization_number|idx_contact_organizations_number_ci/i.test(String(error?.message || ''));
}

function normalizeOrganizationVerificationCode(value = '') {
  const code = String(value || '');
  if (code.length < 6) throw apiError('organization_verification_code_invalid', '组织邀请码至少需要 6 个字符。', 400);
  if (code.length > 128) throw apiError('organization_verification_code_invalid', '组织邀请码不能超过 128 个字符。', 400);
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

async function userSearchPayload(db, row, currentUserId) {
  const outgoing = await one(
    db,
    "SELECT id FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'",
    [currentUserId, row.id],
  );
  const incoming = await one(
    db,
    "SELECT id FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2 AND status = 'pending'",
    [row.id, currentUserId],
  );
  return {
    ...publicUser(row),
    friendshipStatus: await friendshipBetween(db, currentUserId, row.id)
      ? 'accepted'
      : outgoing
        ? 'outgoing_pending'
        : incoming
          ? 'incoming_pending'
          : 'none',
    requestId: outgoing?.id || incoming?.id || '',
  };
}

async function acceptFriendRequestInTransaction(client, currentUserId, row) {
  if (row.recipient_id !== currentUserId) throw apiError('forbidden', '无权处理该好友申请。', 403);
  if (await isBlockedEitherWay(client, row.requester_id, row.recipient_id)) throw apiError('blocked_user', '无法处理该好友申请。', 403);
  const [userA, userB] = orderedUserPair(row.requester_id, row.recipient_id);
  await client.query("UPDATE friend_requests SET status = 'accepted', updated_at = now() WHERE id = $1", [row.id]);
  await client.query(
    `INSERT INTO friendships (id, user_a_id, user_b_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'accepted', now(), now())
     ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET status = 'accepted', updated_at = excluded.updated_at`,
    [newId('friendship'), userA, userB],
  );
}

async function closeFriendRequest(pool, userId, requestId, status, recipientOnly) {
  await inTransaction(pool, async (client) => {
    const row = await pendingFriendRequest(client, requestId);
    const allowed = recipientOnly ? row.recipient_id === userId : row.requester_id === userId;
    if (!allowed) throw apiError('forbidden', '无权处理该好友申请。', 403);
    await client.query('UPDATE friend_requests SET status = $1, updated_at = now() WHERE id = $2', [status, row.id]);
  });
}

async function pendingFriendRequest(db, requestId) {
  const row = await one(db, 'SELECT * FROM friend_requests WHERE id = $1', [String(requestId || '')]);
  if (!row || row.status !== 'pending') throw apiError('friend_request_not_found', '好友申请不存在或已处理。', 404);
  return row;
}

async function friendshipBetween(db, leftId, rightId) {
  const [userA, userB] = orderedUserPair(leftId, rightId);
  return one(db, "SELECT * FROM friendships WHERE user_a_id = $1 AND user_b_id = $2 AND status = 'accepted'", [userA, userB]);
}

async function isBlockedEitherWay(db, leftId, rightId) {
  const row = await one(
    db,
    `SELECT id FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [leftId, rightId],
  );
  return Boolean(row);
}

async function findUserByEmail(db, email) {
  return one(db, 'SELECT * FROM users WHERE email = $1', [email]);
}

async function findUserByIdentifier(db, identifier) {
  return one(
    db,
    'SELECT * FROM users WHERE lower(email) = $1 OR lower(coalesce(username, \'\')) = $1 OR lower(id) = $1 LIMIT 1',
    [identifier],
  );
}

async function getUserById(db, id) {
  const row = await one(db, 'SELECT * FROM users WHERE id = $1', [String(id || '')]);
  return row ? userPayload(row) : null;
}

async function uniqueUsername(db, value) {
  const base = normalizeUsername(value);
  let candidate = base;
  let suffix = 1;
  while (await one(db, 'SELECT id FROM users WHERE username = $1', [candidate])) {
    suffix += 1;
    candidate = `${base}_${suffix}`.slice(0, 32);
  }
  return candidate;
}

function sessionPayload(row) {
  const pinnedAt = row.pinned_at ? toIso(row.pinned_at) : '';
  const status = normalizeSessionStatus(row.status);
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    workspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    userId: row.user_id,
    user_id: row.user_id,
    title: row.title || 'Untitled',
    departmentId: row.department_id || '',
    department_id: row.department_id || '',
    agentId: row.agent_id || '',
    agent_id: row.agent_id || '',
    codexThreadId: row.codex_thread_id || '',
    codex_thread_id: row.codex_thread_id || '',
    status,
    pinnedAt,
    pinned_at: pinnedAt,
    pinned: Boolean(pinnedAt),
    archived: status === 'archived',
    createdAt: toIso(row.created_at),
    created_at: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    updated_at: toIso(row.updated_at),
  };
}

function normalizeSessionPatch(input = {}, { base = {}, partial = false, allowMissingTitle = true } = {}) {
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const titleSource = hasOwn('title') ? input.title : base.title;
  const title = String(titleSource || '').trim();
  if (hasOwn('title') && !title) throw apiError('invalid_session_title', '会话标题不能为空。', 400);
  if (!title && (!partial || !allowMissingTitle)) throw apiError('invalid_session_title', '会话标题不能为空。', 400);

  let status = normalizeSessionStatus(base.status || input.status || 'active');
  if (input.deleted === true) status = 'deleted';
  else if (hasOwn('archived')) status = input.archived ? 'archived' : 'active';
  else if (hasOwn('status')) status = normalizeSessionStatus(input.status);

  let pinnedAt = base.pinned_at || base.pinnedAt || null;
  if (hasOwn('pinnedAt') || hasOwn('pinned_at')) {
    pinnedAt = normalizeOptionalDate(input.pinnedAt ?? input.pinned_at, 'pinned_at');
  }
  if (hasOwn('pinned')) pinnedAt = input.pinned ? new Date().toISOString() : null;
  if (status === 'deleted') pinnedAt = null;

  return {
    title: title || base.title || 'Untitled',
    departmentId: String(input.departmentId ?? input.department_id ?? base.department_id ?? base.departmentId ?? '').trim().slice(0, 120),
    agentId: String(input.agentId ?? input.agent_id ?? base.agent_id ?? base.agentId ?? '').trim().slice(0, 120),
    codexThreadId: String(input.codexThreadId ?? input.codex_thread_id ?? base.codex_thread_id ?? base.codexThreadId ?? '').trim().slice(0, 200),
    status,
    pinnedAt,
    createdAt: normalizeOptionalDate(input.createdAt ?? input.created_at ?? base.created_at ?? base.createdAt, 'created_at'),
    updatedAt: normalizeOptionalDate(input.updatedAt ?? input.updated_at ?? base.updated_at ?? base.updatedAt, 'updated_at'),
  };
}

function normalizeSessionId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw apiError('invalid_session_id', '会话 ID 无效。', 400);
  return id;
}

function normalizeSessionStatus(value) {
  const status = String(value || 'active').trim().toLowerCase();
  return ['active', 'archived', 'deleted'].includes(status) ? status : 'active';
}

function normalizeOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw apiError('invalid_session_date', `${field} 不是有效时间。`, 400);
  return date.toISOString();
}

function userPayload(row) {
  const role = normalizeRole(row.role);
  return {
    id: row.id,
    remoteId: row.id,
    email: row.email,
    displayName: row.display_name,
    display_name: row.display_name,
    username: row.username || '',
    avatarUrl: row.avatar_url || '',
    avatar_url: row.avatar_url || '',
    authProvider: 'cloud',
    emailVerified: Boolean(row.email_verified),
    email_verified: Boolean(row.email_verified),
    role,
    isAdmin: role === 'admin',
    is_admin: role === 'admin',
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    permissions: permissionsForRole(role),
  };
}

function publicUser(row) {
  const updatedAt = toIso(row.friend_updated_at || row.user_updated_at || row.profile_updated_at || row.sender_updated_at || row.updated_at);
  return {
    id: row.friend_id || row.id,
    email: row.email,
    displayName: row.display_name,
    display_name: row.display_name,
    username: row.username || '',
    avatarUrl: row.avatar_url || '',
    avatar_url: row.avatar_url || '',
    role: normalizeRole(row.role),
    emailVerified: Boolean(row.email_verified),
    email_verified: Boolean(row.email_verified),
    updatedAt,
    updated_at: updatedAt,
  };
}

function friendRequestPayload(row, direction) {
  return {
    id: row.id,
    direction,
    requesterId: row.requester_id,
    recipientId: row.recipient_id,
    status: row.status,
    message: row.message || '',
    user: publicUser(row),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function friendshipPayload(row) {
  const lastSeenAt = row.last_seen_at ? toIso(row.last_seen_at) : '';
  const remark = String(row.friend_remark || '').trim();
  const friend = publicUser(row);
  return {
    id: row.id,
    status: row.status,
    remark,
    friend: { ...friend, remark, accountDisplayName: row.account_display_name || friend.displayName || '' },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    online: Boolean(lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= 45_000),
    lastSeenAt,
  };
}

async function requireMessagingFriend(db, senderId, recipientId, { allowSelf = false } = {}) {
  if (!recipientId || (!allowSelf && recipientId === senderId)) throw apiError('invalid_recipient', '请选择有效好友。', 400);
  if (recipientId === senderId) return;
  if (await isBlockedEitherWay(db, senderId, recipientId)) throw apiError('blocked_user', '无法联系该用户。', 403);
  if (!await friendshipBetween(db, senderId, recipientId)) throw apiError('friendship_required', '只能联系已添加的好友。', 403);
}

function parseCursor(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMessageKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ['friend', 'agent', 'system'].includes(kind) ? kind : 'friend';
}


async function hydratedSocialMessage(db, id) {
  const row = await one(
    db,
    `SELECT sm.*,
            sender.email AS sender_email, sender.display_name AS sender_display_name,
            sender.username AS sender_username, sender.avatar_url AS sender_avatar_url,
            sender.role AS sender_role, sender.email_verified AS sender_email_verified,
            recipient.email AS recipient_email, recipient.display_name AS recipient_display_name,
            recipient.username AS recipient_username, recipient.avatar_url AS recipient_avatar_url,
            recipient.role AS recipient_role, recipient.email_verified AS recipient_email_verified
     FROM social_messages sm
     JOIN users sender ON sender.id = sm.sender_user_id
     JOIN users recipient ON recipient.id = sm.recipient_user_id
     WHERE sm.id = $1`,
    [id],
  );
  return row ? socialMessagePayload(row) : null;
}

function socialMessagePayload(row) {
  const sender = publicUser({
    id: row.sender_user_id,
    email: row.sender_email,
    display_name: row.sender_display_name,
    username: row.sender_username,
    avatar_url: row.sender_avatar_url,
    role: row.sender_role,
    email_verified: row.sender_email_verified,
  });
  const recipient = publicUser({
    id: row.recipient_user_id,
    email: row.recipient_email,
    display_name: row.recipient_display_name,
    username: row.recipient_username,
    avatar_url: row.recipient_avatar_url,
    role: row.recipient_role,
    email_verified: row.recipient_email_verified,
  });
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    senderAgentId: row.sender_agent_id || '',
    recipientAgentId: row.recipient_agent_id || '',
    kind: normalizeMessageKind(row.kind),
    title: row.title || '',
    content: row.content || '',
    status: row.status || 'unread',
    metadata: publicSocialMessageMetadata(row.metadata_json),
    sender,
    recipient,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    readAt: row.read_at ? toIso(row.read_at) : '',
  };
}

function delegationSelectSql() {
  return `SELECT ad.*,
                 requester.email AS requester_email, requester.display_name AS requester_display_name,
                 requester.username AS requester_username, requester.avatar_url AS requester_avatar_url,
                 requester.role AS requester_role, requester.email_verified AS requester_email_verified,
                 recipient.email AS recipient_email, recipient.display_name AS recipient_display_name,
                 recipient.username AS recipient_username, recipient.avatar_url AS recipient_avatar_url,
                 recipient.role AS recipient_role, recipient.email_verified AS recipient_email_verified
          FROM agent_delegations ad
          JOIN users requester ON requester.id = ad.requester_user_id
          JOIN users recipient ON recipient.id = ad.recipient_user_id`;
}

async function hydratedDelegation(db, id, viewerUserId = '') {
  const row = await one(db, `${delegationSelectSql()} WHERE ad.id = $1`, [id]);
  if (!row) return null;
  const workspace = viewerUserId
    ? await one(db, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = $1 AND user_id = $2', [id, viewerUserId])
    : null;
  return delegationPayload(row, viewerUserId, workspace);
}

async function delegationPayloadsForViewer(db, rows = [], viewerUserId = '') {
  if (!viewerUserId || !rows.length) return rows.map((row) => delegationPayload(row, viewerUserId));
  return Promise.all(rows.map(async (row) => delegationPayload(
    row,
    viewerUserId,
    await one(db, 'SELECT * FROM agent_delegation_workspaces WHERE user_id = $1 AND delegation_id = $2', [viewerUserId, row.id]),
  )));
}

function delegationPayload(row, viewerUserId = '', workspace = null) {
  const metadata = jsonObject(row.metadata_json);
  const recipientView = !viewerUserId || viewerUserId === row.recipient_user_id;
  const participantView = [row.requester_user_id, row.recipient_user_id].includes(viewerUserId);
  const workspaceMetadata = participantView ? jsonObject(workspace?.metadata_json) : {};
  const legacySessionId = viewerUserId === row.recipient_user_id ? row.session_id || '' : '';
  const sessionId = participantView ? workspace?.session_id || legacySessionId : '';
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    workspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    requesterUserId: row.requester_user_id,
    recipientUserId: row.recipient_user_id,
    clientRequestId: row.client_request_id || '',
    senderAgentId: row.sender_agent_id || 'secretary_agent',
    recipientAgentId: row.recipient_agent_id || 'secretary_agent',
    title: row.title || '',
    instruction: row.instruction || '',
    status: normalizeDelegationStatus(row.status),
    sessionId,
    taskRunId: recipientView ? row.task_run_id || '' : '',
    groupId: row.group_id || metadata.groupId || '',
    metadata: participantView ? { ...publicDelegationMetadata(metadata), ...workspaceMetadata } : publicDelegationMetadata(metadata),
    lastError: recipientView ? row.last_error || '' : '',
    requester: publicUser({ id: row.requester_user_id, email: row.requester_email, display_name: row.requester_display_name, username: row.requester_username, avatar_url: row.requester_avatar_url, role: row.requester_role, email_verified: row.requester_email_verified }),
    recipient: publicUser({ id: row.recipient_user_id, email: row.recipient_email, display_name: row.recipient_display_name, username: row.recipient_username, avatar_url: row.recipient_avatar_url, role: row.recipient_role, email_verified: row.recipient_email_verified }),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: row.started_at ? toIso(row.started_at) : '',
    completedAt: row.completed_at ? toIso(row.completed_at) : '',
  };
}


function delegationWorkspacePayload(row = {}) {
  return {
    delegationId: row.delegation_id,
    userId: row.user_id,
    sessionId: row.session_id || '',
    metadata: jsonObject(row.metadata_json),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function delegationWorkspaceMessagePayload(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    delegationId: row.delegation_id,
    userId: row.user_id,
    role: row.role || 'user',
    content: row.content || '',
    metadata: jsonObject(row.metadata_json),
    sourceEventId: row.source_event_id || '',
    sourceGroupMessageId: row.source_group_message_id || '',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function emptyTaskRouting() {
  return { routed: [], needsRoutingConfirmation: false, candidateDelegationIds: [], candidates: [] };
}

async function insertPrivateTaskIngress(db, {
  delegationId = '', userId = '', content = '', type = 'group_update', sourceEventId = '',
  sourceGroupMessageId = '', fromUserId = '', metadata = {},
} = {}) {
  if (!delegationId || !userId || !String(content || '').trim()) return null;
  await db.query(
    `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
     VALUES ($1, $2, '{}'::jsonb, now())
     ON CONFLICT (delegation_id, user_id) DO UPDATE SET updated_at = now()`,
    [delegationId, userId],
  );
  const privateMetadata = {
    privateTaskWorkspace: true,
    type,
    fromUserId,
    sourceEventId,
    sourceGroupMessageId,
    ...jsonObject(metadata),
  };
  const row = await one(
    db,
    `INSERT INTO agent_delegation_workspace_messages
       (id, delegation_id, user_id, role, content, metadata_json, source_event_id, source_group_message_id)
     VALUES ($1, $2, $3, 'system', $4, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [newId('workspace_msg'), delegationId, userId, String(content).slice(0, 32000), JSON.stringify(privateMetadata), String(sourceEventId || '').slice(0, 240), String(sourceGroupMessageId || '').slice(0, 240)],
  );
  if (row) await db.query('UPDATE agent_delegations SET updated_at = now() WHERE id = $1', [delegationId]);
  return row;
}

async function routeGroupMessageToPrivateThreads(db, { groupId = '', groupMessageId = '', senderUserId = '', content = '', metadata = {} } = {}) {
  const tasks = await many(
    db,
    `SELECT id, title, requester_user_id, recipient_user_id, status FROM agent_delegations
     WHERE group_id = $1 AND status NOT IN ('closed','withdrawn','declined','rejected')
     ORDER BY created_at ASC`,
    [groupId],
  );
  const explicitDelegationId = String(metadata.delegationId || metadata.taskId || '').trim();
  const normalizedMentions = normalizeMentionEntities(metadata.mentions, { content, requirePicker: true });
  const mentionedUserIds = [...new Set(normalizedMentions
    .map((mention) => String(mention.ownerUserId || mention.userId || '').trim())
    .filter(Boolean))];
  const mentionedPeopleIds = [...new Set(normalizedMentions
    .filter((mention) => mention.principalType === 'user')
    .map((mention) => String(mention.userId || '').trim())
    .filter((userId) => userId && userId !== senderUserId))];
  const senderTasks = tasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(senderUserId));
  const routes = [];
  let candidates = [];
  if (explicitDelegationId) {
    candidates = tasks.filter((task) => task.id === explicitDelegationId);
    if (candidates.length === 1) {
      const task = candidates[0];
      const defaultTarget = task.requester_user_id === senderUserId
        ? task.recipient_user_id
        : task.recipient_user_id === senderUserId ? task.requester_user_id : task.recipient_user_id;
      const targets = mentionedUserIds.filter((userId) => [task.requester_user_id, task.recipient_user_id].includes(userId));
      for (const targetUserId of targets.length ? targets : [defaultTarget]) routes.push({ task, targetUserId });
    }
  } else if (mentionedUserIds.length) {
    for (const targetUserId of mentionedUserIds) {
      const senderMatching = senderTasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(targetUserId));
      const matching = senderMatching.length ? senderMatching : tasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(targetUserId));
      candidates.push(...matching);
      if (matching.length === 1) routes.push({ task: matching[0], targetUserId });
    }
  } else {
    candidates = tasks;
    for (const task of tasks) {
      routes.push({ task, targetUserId: task.recipient_user_id });
      routes.push({ task, targetUserId: task.requester_user_id });
    }
  }
  const uniqueCandidates = [...new Set(candidates.map((task) => task.id))];
  const dedupedRoutes = [...new Map(routes.map((route) => [`${route.task.id}:${route.targetUserId}`, route])).values()];
  const ambiguousMention = mentionedUserIds.some((targetUserId) => {
    const senderMatching = senderTasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(targetUserId));
    return (senderMatching.length ? senderMatching : tasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(targetUserId))).length > 1;
  });
  const unmatchedMentionedUserIds = mentionedPeopleIds.filter((targetUserId) => (
    !tasks.some((task) => [task.requester_user_id, task.recipient_user_id].includes(targetUserId))
  ));
  const needsRoutingConfirmation = !dedupedRoutes.length && (uniqueCandidates.length > 1 || ambiguousMention || Boolean(explicitDelegationId));
  for (const { task, targetUserId } of dedupedRoutes) {
    await insertPrivateTaskIngress(db, {
      delegationId: task.id,
      userId: targetUserId,
      content,
      type: 'group_message_ingress',
      sourceEventId: `group-message:${groupMessageId}`,
      sourceGroupMessageId: groupMessageId,
      fromUserId: senderUserId,
      metadata: { groupId, routedBy: explicitDelegationId ? 'delegation_id' : mentionedUserIds.length ? 'mention' : 'broadcast' },
    });
  }
  const candidatePayloads = [...new Map(candidates.map((task) => [task.id, task])).values()].map((task) => ({
    delegationId: task.id,
    title: task.title || '',
    requesterUserId: task.requester_user_id,
    recipientUserId: task.recipient_user_id,
    targetUserId: task.requester_user_id === senderUserId ? task.recipient_user_id : task.requester_user_id,
  }));
  return {
    routed: dedupedRoutes.map(({ task, targetUserId }) => ({ delegationId: task.id, targetUserId })),
    needsRoutingConfirmation,
    candidateDelegationIds: uniqueCandidates,
    candidates: candidatePayloads,
    unmatchedMentionedUserIds,
  };
}

async function requireDelegationParticipant(db, delegationId, userId, accountWorkspaceId = '') {
  const params = [delegationId];
  const workspaceClause = accountWorkspaceId ? ` AND account_workspace_id=$${params.push(accountWorkspaceId)}` : '';
  const delegation = await one(db, `SELECT * FROM agent_delegations WHERE id=$1${workspaceClause}`, params);
  if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(userId)) throw apiError('delegation_not_found', '任务不存在。', 404);
  if (delegation.group_id) await requireActiveTaskMembership(db, delegation.group_id, userId, { allowClosed: true, accountWorkspaceId: delegation.account_workspace_id });
  return delegation;
}

async function requireActiveTaskMembership(db, groupId, userId, { allowClosed = false, accountWorkspaceId = '' } = {}) {
  const params = [groupId];
  const workspaceClause = accountWorkspaceId ? ` AND account_workspace_id=$${params.push(accountWorkspaceId)}` : '';
  const group = await one(db, `SELECT status,account_workspace_id FROM collaboration_groups WHERE id=$1${workspaceClause}`, params);
  const membership = await one(db, 'SELECT * FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  if (!group || !membership) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  if (!allowClosed && group.status === 'closed') throw apiError('collaboration_group_closed', '任务群已结束。', 409);
  const acceptedStatuses = allowClosed && group.status === 'closed' ? ['closed'] : ['active'];
  if (!acceptedStatuses.includes(membership.status)) throw apiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  return membership;
}


function publicTaskActionMetadata(metadata = {}, action = '') {
  const clean = publicDelegationMetadata(metadata);
  const sanitize = (items) => (Array.isArray(items) ? items : []).slice(0, 20).map((item) => {
    const publicUrl = (value) => /^https?:\/\//i.test(String(value || '')) ? String(value) : '';
    return {
      id: String(item?.id || ''),
      name: String(item?.name || item?.filename || 'file').slice(0, 300),
      filename: String(item?.filename || item?.name || 'file').slice(0, 300),
      type: String(item?.type || item?.content_type || '').slice(0, 200),
      content_type: String(item?.content_type || item?.type || '').slice(0, 200),
      size: Math.max(0, Number(item?.size || 0) || 0),
      remote_file_id: String(item?.remote_file_id || item?.remoteFileId || '').slice(0, 200),
      remote_file_kind: String(item?.remote_file_kind || item?.remoteFileKind || '').slice(0, 80),
      group_id: String(item?.group_id || item?.groupId || '').slice(0, 200),
      delegation_id: String(item?.delegation_id || item?.delegationId || '').slice(0, 200),
      sha256: String(item?.sha256 || '').slice(0, 128),
      relative_path: String(item?.relative_path || '').replace(/^\/+/, '').slice(0, 1000),
      file_url: publicUrl(item?.file_url || item?.fileUrl),
      download_url: publicUrl(item?.download_url),
    };
  });
  if (['submit', 'publish', 'update_requirements'].includes(action)) {
    clean.attachments = sanitize(clean.attachments);
    if (action === 'submit') clean.resultAttachments = sanitize(clean.resultAttachments || clean.attachments);
    else delete clean.resultAttachments;
  } else {
    delete clean.attachments;
    delete clean.resultAttachments;
  }
  return clean;
}

function publicSocialMessageMetadata(value = {}) {
  const metadata = stripPrivateSocialMetadata(jsonObject(value));
  if (Array.isArray(metadata.attachments)) {
    metadata.attachments = metadata.attachments.slice(0, 20).map((item) => {
      const name = collaborationFilename(item?.filename || item?.name || 'file');
      const publicUrl = (url) => /^https?:\/\//i.test(String(url || '')) ? String(url).slice(0, 4000) : '';
      return {
        id: String(item?.remote_file_id || item?.remoteFileId || item?.id || '').slice(0, 200),
        remote_file_id: String(item?.remote_file_id || item?.remoteFileId || '').slice(0, 200),
        remote_file_kind: String(item?.remote_file_kind || item?.remoteFileKind || '').slice(0, 80),
        group_id: String(item?.group_id || item?.groupId || '').slice(0, 200),
        name,
        filename: name,
        kind: String(item?.kind || '').slice(0, 80),
        type: String(item?.type || item?.content_type || '').slice(0, 200),
        content_type: String(item?.content_type || item?.type || '').slice(0, 200),
        size: Math.max(0, Number(item?.size || 0) || 0),
        sha256: String(item?.sha256 || '').slice(0, 128),
        file_url: publicUrl(item?.file_url || item?.fileUrl),
        download_url: publicUrl(item?.download_url),
      };
    });
  }
  return metadata;
}

const PRIVATE_SOCIAL_METADATA_KEYS = new Set([
  'privatetaskworkspace',
  'taskworkspaceroot',
  'workspaceroot',
  'path',
  'localpath',
  'sourcepath',
  'sourcesecretarysessionid',
  'sourcesecretarymessageid',
  'secretarysessionid',
  'secretarymessageid',
  'ownersecretarysessionid',
  'ownersecretarymessageid',
]);

function stripPrivateSocialMetadata(value, depth = 0) {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map((item) => stripPrivateSocialMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_SOCIAL_METADATA_KEYS.has(String(key).toLowerCase().replace(/[^a-z0-9]/g, '')))
    .map(([key, item]) => [key, stripPrivateSocialMetadata(item, depth + 1)]));
}

function isPrivateTaskWorkspaceMessage(value = {}) {
  return jsonObject(value.metadata_json || value.metadata).privateTaskWorkspace === true;
}

const MAX_COLLABORATION_FILE_BYTES = 60 * 1024 * 1024;

function collaborationFilename(value = '') {
  let decoded = String(value || '').trim();
  try { decoded = decodeURIComponent(decoded); } catch {}
  const filename = decoded.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().slice(0, 240);
  return filename || 'file';
}

function collaborationContentDisposition(filename = 'file') {
  const clean = collaborationFilename(filename);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '');
  return `attachment; filename="${ascii || 'file'}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function collaborationFileAttachment(row = {}) {
  return {
    id: row.id || '',
    remote_file_id: row.id || '',
    name: row.filename || 'file',
    filename: row.filename || 'file',
    type: row.content_type || 'application/octet-stream',
    content_type: row.content_type || 'application/octet-stream',
    size: Math.max(0, Number(row.size_bytes || 0)),
    sha256: row.sha256 || '',
    remote_file_kind: 'collaboration_task',
    group_id: row.group_id || '',
    delegation_id: row.delegation_id || '',
  };
}

function collaborationGroupWorkspaceRelativePath(value = '') {
  let decoded = String(value || '').trim();
  try { decoded = decodeURIComponent(decoded); } catch {}
  const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw apiError('collaboration_workspace_path_invalid', '共享工作区文件路径无效。', 400);
  }
  return segments.join('/').slice(0, 1200);
}

function collaborationGroupWorkspacePayload(row = {}, { readOnly = false } = {}) {
  return {
    id: row.group_id || '',
    groupId: row.group_id || '',
    workspaceEpoch: row.workspace_epoch || '',
    revision: Math.max(0, Number(row.revision || 0)),
    status: row.status || 'active',
    scope: 'collaboration_group',
    readOnly: Boolean(readOnly || row.status === 'closed'),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function collaborationGroupWorkspaceFilePayload(row = {}) {
  return {
    id: row.id || '',
    groupId: row.group_id || '',
    relativePath: row.relative_path || '',
    revision: Math.max(0, Number(row.revision || 0)),
    ownerUserId: row.owner_user_id || '',
    filename: row.filename || 'file',
    contentType: row.content_type || 'application/octet-stream',
    size: Math.max(0, Number(row.size_bytes || 0)),
    sha256: row.sha256 || '',
    deleted: Boolean(row.deleted),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function ensureCollaborationGroupWorkspace(db, groupId, { ownerUserId = '', status = '' } = {}) {
  const group = await one(db, 'SELECT * FROM collaboration_groups WHERE id = $1', [groupId]);
  if (!group) throw apiError('collaboration_group_not_found', '任务群不存在。', 404);
  await db.query(
    `INSERT INTO collaboration_group_workspaces (group_id, workspace_epoch, revision, status, updated_at)
     VALUES ($1, $2, 0, $3, now())
     ON CONFLICT (group_id) DO UPDATE SET status = excluded.status`,
    [groupId, `workspace_${groupId}`, status || group.status || 'active'],
  );
  return one(db, 'SELECT * FROM collaboration_group_workspaces WHERE group_id = $1', [groupId]);
}

async function activeCollaborationMembership(db, groupId, userId) {
  return one(db, "SELECT * FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'", [groupId, userId]);
}

function collaborationGroupPayload(row = {}) {
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    workspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    ownerUserId: row.owner_user_id,
    clientRequestId: row.client_request_id || '',
    title: row.title || 'uBuddy 任务群',
    status: row.status || 'active',
    memberCount: Number(row.member_count || 0),
    unreadCount: Number(row.unread_count || 0),
    lastMessage: row.last_message || '',
    metadata: jsonObject(row.metadata_json),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    closedAt: row.closed_at ? toIso(row.closed_at) : '',
    ...(row.membership_user_id ? { membership: {
      groupId: row.id,
      userId: row.membership_user_id,
      role: row.membership_role || 'member',
      status: row.membership_status || 'active',
      displayNameOverride: row.membership_display_name_override || '',
      joinedAt: toIso(row.membership_joined_at),
      leftAt: row.membership_left_at ? toIso(row.membership_left_at) : '',
      lastReadAt: row.membership_last_read_at ? toIso(row.membership_last_read_at) : '',
    } } : {}),
  };
}

function collaborationMemberPayload(row = {}) {
  return {
    groupId: row.group_id,
    userId: row.user_id,
    role: row.role || 'member',
    status: row.status || 'active',
    joinedAt: toIso(row.joined_at),
    leftAt: row.left_at ? toIso(row.left_at) : '',
    displayNameOverride: row.display_name_override || '',
    user: {
      ...publicUser({
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      username: row.username,
      avatar_url: row.avatar_url,
      role: row.user_role,
      email_verified: row.email_verified,
      }),
      accountDisplayName: row.account_display_name || row.display_name || '',
    },
  };
}

function collaborationMessagePayload(row = {}) {
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    workspaceId: row.account_workspace_id || PERSONAL_ACCOUNT_WORKSPACE_ID,
    groupId: row.group_id,
    senderUserId: row.sender_user_id,
    senderAgentId: row.sender_agent_id || '',
    kind: normalizeMessageKind(row.kind),
    content: row.content || '',
    sourceEventId: row.source_event_id || '',
    metadata: publicSocialMessageMetadata(row.metadata_json),
    sender: {
      ...publicUser({
        id: row.sender_user_id,
        email: row.sender_email,
        display_name: row.sender_display_name,
        username: row.sender_username,
        avatar_url: row.sender_avatar_url,
        role: row.sender_role,
        email_verified: row.sender_email_verified,
      }),
      accountDisplayName: row.sender_account_display_name || row.sender_display_name || '',
    },
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

async function collaborationOverview(db, userId, accountWorkspaceId = PERSONAL_ACCOUNT_WORKSPACE_ID) {
  const groupRows = await many(
    db,
    `SELECT g.*,m.user_id AS membership_user_id,m.role AS membership_role,m.status AS membership_status,
            m.display_name_override AS membership_display_name_override,
            m.joined_at AS membership_joined_at,m.left_at AS membership_left_at,m.last_read_at AS membership_last_read_at
     FROM collaboration_groups g
     JOIN collaboration_group_members m ON m.group_id = g.id AND m.user_id = $1
     WHERE g.account_workspace_id=$2 AND ((g.status = 'active' AND m.status = 'active') OR (g.status = 'closed' AND m.status = 'closed'))
     ORDER BY g.updated_at DESC`,
    [userId, accountWorkspaceId],
  );
  const groups = [];
  for (const row of groupRows) {
    const memberCount = await one(db, "SELECT COUNT(*) AS count FROM collaboration_group_members WHERE group_id = $1 AND status = 'active'", [row.id]);
    const unreadCount = await one(
      db,
      `SELECT COUNT(*) AS count FROM collaboration_group_messages
       WHERE group_id = $1 AND sender_user_id <> $2
         AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)`,
      [row.id, userId, row.membership_last_read_at || row.last_read_at || null],
    );
    const recentMessages = await many(db, `SELECT message.content,message.metadata_json,
        CASE
          WHEN sender_member.display_name_override<>'' THEN sender_member.display_name_override
          WHEN sender.display_name<>'' THEN sender.display_name
          WHEN sender.username<>'' THEN sender.username
          ELSE message.sender_user_id
        END AS sender_label
      FROM collaboration_group_messages message
      JOIN users sender ON sender.id=message.sender_user_id
      LEFT JOIN collaboration_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
      WHERE message.group_id=$1 ORDER BY message.created_at DESC LIMIT 50`, [row.id]);
    const last = recentMessages.find((message) => !isPrivateTaskWorkspaceMessage(message));
    groups.push(collaborationGroupPayload({ ...row, member_count: memberCount?.count || 0, unread_count: unreadCount?.count || 0, last_message: groupConversationPreview(last) }));
  }
  const taskRows = await many(db, `${delegationSelectSql()} WHERE ad.account_workspace_id=$2 AND (ad.requester_user_id = $1 OR ad.recipient_user_id = $1) ORDER BY ad.updated_at DESC LIMIT 200`, [userId, accountWorkspaceId]);
  return { groups, tasks: await delegationPayloadsForViewer(db, taskRows, userId) };
}

function groupConversationPreview(message = null) {
  const content = String(message?.content || '').trim();
  if (!content) return '';
  const sender = String(message?.sender_label || '').trim();
  return sender ? `${sender}：${content}` : content;
}

async function collaborationGroupDetail(db, groupId, userId, { markRead = false, accountWorkspaceId = '' } = {}) {
  const membership = await one(db, 'SELECT * FROM collaboration_group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  if (!membership) throw apiError('collaboration_group_not_found', '任务群不存在或你不在群内。', 404);
  const group = await one(db, `SELECT * FROM collaboration_groups WHERE id=$1${accountWorkspaceId ? ' AND account_workspace_id=$2' : ''}`, accountWorkspaceId ? [groupId, accountWorkspaceId] : [groupId]);
  if (!group) throw apiError('collaboration_group_not_found', '任务群不存在。', 404);
  if (markRead) await db.query('UPDATE collaboration_group_members SET last_read_at = now() WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
  const members = await many(
    db,
    `SELECT m.*,u.email,CASE WHEN m.display_name_override<>'' THEN m.display_name_override ELSE u.display_name END AS display_name,
            u.display_name AS account_display_name,u.username,u.avatar_url,u.role AS user_role,u.email_verified
     FROM collaboration_group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND ($2::timestamptz IS NULL OR m.joined_at <= $2::timestamptz)
     ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at`,
    [groupId, membership.status === 'removed' ? membership.left_at : null],
  );
  const messages = await many(
    db,
    `SELECT gm.*,u.email AS sender_email,
            CASE WHEN sender_member.display_name_override<>'' THEN sender_member.display_name_override ELSE u.display_name END AS sender_display_name,
            u.display_name AS sender_account_display_name,
            u.username AS sender_username, u.avatar_url AS sender_avatar_url,
            u.role AS sender_role, u.email_verified AS sender_email_verified
     FROM collaboration_group_messages gm JOIN users u ON u.id = gm.sender_user_id
     LEFT JOIN collaboration_group_members sender_member ON sender_member.group_id=gm.group_id AND sender_member.user_id=gm.sender_user_id
     WHERE gm.group_id = $1 AND ($2::timestamptz IS NULL OR gm.created_at <= $2::timestamptz) ORDER BY gm.created_at ASC`,
    [groupId, membership.status === 'removed' ? membership.left_at : null],
  );
  const publicMessages = messages.filter((message) => !isPrivateTaskWorkspaceMessage(message));
  const taskRows = await many(db, `${delegationSelectSql()} WHERE ad.group_id = $1 ORDER BY ad.created_at ASC`, [groupId]);
  const workspaceRow = await ensureCollaborationGroupWorkspace(db, groupId, { ownerUserId: group.owner_user_id, status: group.status });
  return {
    group: collaborationGroupPayload(group),
    workspace: collaborationGroupWorkspacePayload(workspaceRow, { readOnly: group.status === 'closed' || membership.status !== 'active' }),
    members: members.map(collaborationMemberPayload),
    messages: publicMessages.map(collaborationMessagePayload),
    tasks: await delegationPayloadsForViewer(db, taskRows, userId),
  };
}

export function permissionsForRole(role = 'member') {
  const admin = role === 'admin';
  return {
    canChat: true,
    canUploadFiles: true,
    canUseArtifacts: true,
    canUseImageGeneration: true,
    canUsePptDepartment: true,
    canViewTasks: admin,
    canManageTasks: admin,
    canViewEvolution: admin,
    canRunEvolution: admin,
    canManageUsers: admin,
    canEditCodexConfig: admin,
    canRunDoctor: admin,
  };
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows[0] || null;
}

async function many(db, sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

function orderedUserPair(left, right) {
  return [String(left || ''), String(right || '')].sort();
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw apiError('invalid_email', '请输入有效邮箱。', 400);
  return value;
}

function normalizePurpose(purpose) {
  const value = String(purpose || 'register').trim().toLowerCase().replace(/-/g, '_');
  if (['register', 'email_verify', 'password_reset', 'password_change', 'organization_invitation_reset'].includes(value)) return value;
  throw apiError('email_code_invalid', '验证码用途不正确。', 400);
}

function normalizeCode(code) {
  return String(code || '').trim();
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 8) throw apiError('invalid_password', '密码至少需要 8 位。', 400);
  return value;
}

function normalizeDisplayName(value, fallback = 'Janus User') {
  const name = String(value || '').trim().slice(0, 80) || fallback;
  if (!name) throw apiError('invalid_profile', '显示名不能为空。', 400);
  return name;
}

function normalizeUsername(value, fallback = '') {
  const username = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (username) return username;
  const preserved = String(fallback || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  return preserved || `user_${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeRole(role) {
  return String(role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
}

function toIso(value) {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export {
  MAX_COLLABORATION_FILE_BYTES,
  authMiddleware,
  authenticateRequest,
  sessionResponse,
  ensurePersonalAccountWorkspaceMembership,
  consumeEmailCode,
  friendsOverview,
  organizationOverview,
  createOrganization,
  joinOrganization,
  organizationAction,
  userSearchPayload,
  acceptFriendRequestInTransaction,
  closeFriendRequest,
  pendingFriendRequest,
  friendshipBetween,
  isBlockedEitherWay,
  findUserByEmail,
  findUserByIdentifier,
  getUserById,
  uniqueUsername,
  sessionPayload,
  normalizeSessionPatch,
  normalizeSessionId,
  normalizeSessionStatus,
  normalizeOptionalDate,
  userPayload,
  publicUser,
  friendRequestPayload,
  friendshipPayload,
  requireMessagingFriend,
  parseCursor,
  jsonObject,
  normalizeMessageKind,
  hydratedSocialMessage,
  socialMessagePayload,
  delegationSelectSql,
  hydratedDelegation,
  delegationPayloadsForViewer,
  delegationPayload,
  delegationWorkspacePayload,
  delegationWorkspaceMessagePayload,
  emptyTaskRouting,
  insertPrivateTaskIngress,
  routeGroupMessageToPrivateThreads,
  requireDelegationParticipant,
  requireActiveTaskMembership,
  publicTaskActionMetadata,
  publicSocialMessageMetadata,
  collaborationFilename,
  collaborationContentDisposition,
  collaborationFileAttachment,
  collaborationGroupWorkspaceRelativePath,
  collaborationGroupWorkspacePayload,
  collaborationGroupWorkspaceFilePayload,
  ensureCollaborationGroupWorkspace,
  activeCollaborationMembership,
  collaborationGroupPayload,
  collaborationMemberPayload,
  collaborationMessagePayload,
  collaborationOverview,
  collaborationGroupDetail,
  one,
  many,
  orderedUserPair,
  normalizeEmail,
  normalizePurpose,
  normalizeCode,
  validatePassword,
  normalizeDisplayName,
  normalizeUsername,
  normalizeRole,
  toIso,
};
