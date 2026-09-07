import { all, get, run } from '../../../db.js';
import { nowIso } from '../../../utils.js';
import {
  PERSONAL_ACCOUNT_WORKSPACE_ID,
  normalizeAccountWorkspaceId,
  normalizeAccountWorkspaceRole,
  organizationAccountId,
  organizationAccountWorkspaceId,
  personalAccountId,
} from '../../../../shared/accountWorkspaces.js';
import { normalizeProfileAvatarUrl } from '../../../../shared/profileAvatar.js';

const DEFAULT_DEVICE_ID = 'local';

export function ensurePersonalAccountWorkspace(db, user = {}) {
  const userId = String(user.id || user.userId || '').trim();
  if (!userId) return null;
  const now = nowIso();
  const displayName = String(user.displayName || user.display_name || '').trim().slice(0, 80);
  const avatarUrl = normalizeProfileAvatarUrl(user.avatarUrl || user.avatar_url || '');
  run(db, `INSERT INTO account_workspaces(
      id,workspace_kind,organization_id,owner_user_id,name,status,created_at,updated_at
    ) VALUES(?, 'personal', '', '', '个人空间', 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET status='active',updated_at=excluded.updated_at`, [PERSONAL_ACCOUNT_WORKSPACE_ID, now, now]);
  run(db, `INSERT INTO account_workspace_memberships(
      workspace_id,user_id,role,status,display_name,avatar_url,joined_at,updated_at
    ) VALUES(?,?,'owner','active',?,?,?,?)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET status='active',display_name=excluded.display_name,
      avatar_url=excluded.avatar_url,updated_at=excluded.updated_at`, [PERSONAL_ACCOUNT_WORKSPACE_ID, userId, displayName, avatarUrl, now, now]);
  const accountId = personalAccountId(userId);
  run(db, `INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
    VALUES(?,'personal',?,'',?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
    owner_user_id=excluded.owner_user_id,name=excluded.name,status=CASE WHEN accounts.status='external' THEN 'external' ELSE 'active' END,
    updated_at=excluded.updated_at`, [accountId, userId, displayName || '个人账号', now, now]);
  if (get(db, 'SELECT 1 FROM auth_users WHERE id=?', [userId])) {
    run(db, `INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
      VALUES(?,?,'owner','active',?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
      role='owner',status='active',updated_at=excluded.updated_at`, [accountId, userId, now, now]);
  }
  run(db, `INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
    VALUES(?,?,?,'personal',?,?) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET
    account_id=excluded.account_id,binding_kind='personal',updated_at=excluded.updated_at`, [
    accountId, PERSONAL_ACCOUNT_WORKSPACE_ID, userId, now, now,
  ]);
  return accountWorkspacePayload(db, PERSONAL_ACCOUNT_WORKSPACE_ID, userId);
}

export function ensureOrganizationAccountWorkspace(db, organization = {}, members = []) {
  const organizationId = String(organization.id || organization.organizationId || '').trim();
  if (!organizationId) return null;
  const workspaceId = organizationAccountWorkspaceId(organizationId);
  const now = nowIso();
  const ownerUserId = String(organization.ownerUserId || organization.owner_user_id || organization.owner?.id || '').trim();
  run(db, `INSERT INTO account_workspaces(
      id,workspace_kind,organization_id,owner_user_id,name,avatar_url,status,created_at,updated_at
    ) VALUES(?,'organization',?,?,?,?, 'active',?,?)
    ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,owner_user_id=excluded.owner_user_id,
      name=excluded.name,avatar_url=excluded.avatar_url,status='active',updated_at=excluded.updated_at`, [
    workspaceId,
    organizationId,
    ownerUserId,
    String(organization.name || '未命名组织').trim().slice(0, 80),
    String(organization.avatarUrl || organization.avatar_url || '').trim().slice(0, 1000),
    organization.createdAt || organization.created_at || now,
    organization.updatedAt || organization.updated_at || now,
  ]);
  const accountId = organizationAccountId(organizationId);
  run(db, `INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
    VALUES(?,'organization',?,?,?,'active',?,?) ON CONFLICT(id) DO UPDATE SET
    owner_user_id=excluded.owner_user_id,organization_id=excluded.organization_id,name=excluded.name,
    status='active',updated_at=excluded.updated_at`, [
    accountId, ownerUserId, organizationId, String(organization.name || '未命名组织').trim().slice(0, 80),
    organization.createdAt || organization.created_at || now, organization.updatedAt || organization.updated_at || now,
  ]);
  run(db, `INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
    VALUES(?,?,'','organization',?,?) ON CONFLICT(workspace_id,user_id_scope) DO UPDATE SET
    account_id=excluded.account_id,binding_kind='organization',updated_at=excluded.updated_at`, [accountId, workspaceId, now, now]);
  const activeMemberIds = new Set();
  for (const item of Array.isArray(members) ? members : []) {
    const userId = String(item.userId || item.user_id || item.user?.id || item.id || '').trim();
    if (!userId) continue;
    activeMemberIds.add(userId);
    const role = normalizeAccountWorkspaceRole(item.role || (userId === ownerUserId ? 'owner' : 'member'));
    run(db, `INSERT INTO account_workspace_memberships(
        workspace_id,user_id,role,status,display_name,avatar_url,title,joined_at,updated_at
      ) VALUES(?,?,?,'active',?,?,?,?,?)
      ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',display_name=excluded.display_name,
        avatar_url=excluded.avatar_url,title=excluded.title,updated_at=excluded.updated_at`, [
      workspaceId,
      userId,
      role,
      String(item.displayNameOverride || item.display_name_override || item.displayName || item.display_name
        || item.user?.displayName || item.user?.display_name || '').trim().slice(0, 80),
      normalizeProfileAvatarUrl(item.avatarUrl || item.avatar_url || item.user?.avatarUrl || item.user?.avatar_url || ''),
      String(item.title || '').trim().slice(0, 120),
      item.joinedAt || item.joined_at || now,
      organization.updatedAt || organization.updated_at || now,
    ]);
    if (get(db, 'SELECT 1 FROM auth_users WHERE id=?', [userId])) {
      run(db, `INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
        VALUES(?,?,?,'active',?,?) ON CONFLICT(account_id,user_id) DO UPDATE SET
        role=excluded.role,status='active',updated_at=excluded.updated_at`, [
        accountId, userId, role, item.joinedAt || item.joined_at || now, organization.updatedAt || organization.updated_at || now,
      ]);
    }
  }
  const existing = all(db, 'SELECT user_id FROM account_workspace_memberships WHERE workspace_id=?', [workspaceId]);
  for (const row of existing) {
    if (!activeMemberIds.has(row.user_id)) {
      run(db, "UPDATE account_workspace_memberships SET status='left',updated_at=? WHERE workspace_id=? AND user_id=?", [now, workspaceId, row.user_id]);
      run(db, "UPDATE account_memberships SET status='left',updated_at=? WHERE account_id=? AND user_id=?", [now, accountId, row.user_id]);
    }
  }
  return { workspaceId, organizationId };
}

export function deactivateOrganizationAccountWorkspace(db, organizationId = '') {
  const cleanOrganizationId = String(organizationId || '').trim();
  if (!cleanOrganizationId) return false;
  const workspaceId = organizationAccountWorkspaceId(cleanOrganizationId);
  const now = nowIso();
  run(db, "UPDATE account_workspace_memberships SET status='removed',updated_at=? WHERE workspace_id=?", [now, workspaceId]);
  run(db, "UPDATE account_memberships SET status='removed',updated_at=? WHERE account_id=?", [now, organizationAccountId(cleanOrganizationId)]);
  run(db, "UPDATE accounts SET status='deleted',updated_at=? WHERE id=?", [now, organizationAccountId(cleanOrganizationId)]);
  const result = run(db, "UPDATE account_workspaces SET status='deleted',updated_at=? WHERE id=?", [now, workspaceId]);
  return Number(result?.changes || 0) > 0;
}

export function syncOrganizationAccountWorkspaces(db) {
  const organizations = all(db, 'SELECT * FROM contact_organizations');
  const activeWorkspaceIds = new Set();
  for (const organization of organizations) {
    activeWorkspaceIds.add(organizationAccountWorkspaceId(organization.id));
    const members = all(db, `SELECT membership.*,user.display_name,user.avatar_url
      FROM contact_organization_members membership
      LEFT JOIN auth_users user ON user.id=membership.user_id
      WHERE membership.organization_id=?`, [organization.id]);
    ensureOrganizationAccountWorkspace(db, organization, members);
  }
  for (const workspace of all(db, "SELECT id,organization_id FROM account_workspaces WHERE workspace_kind='organization'")) {
    if (!activeWorkspaceIds.has(workspace.id)) deactivateOrganizationAccountWorkspace(db, workspace.organization_id);
  }
  for (const user of all(db, 'SELECT id,display_name,avatar_url FROM auth_users')) ensurePersonalAccountWorkspace(db, user);
  run(db, `UPDATE account_workspace_preferences SET active_workspace_id=?,updated_at=?
    WHERE NOT EXISTS (SELECT 1 FROM account_workspaces workspace
      JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
      WHERE workspace.id=account_workspace_preferences.active_workspace_id AND workspace.status='active'
        AND membership.user_id=account_workspace_preferences.user_id AND membership.status='active')`, [
    PERSONAL_ACCOUNT_WORKSPACE_ID, nowIso(),
  ]);
}

export function listAccountWorkspaces(db, userId = '') {
  const cleanUserId = String(userId || '').trim();
  if (!cleanUserId) return [];
  ensurePersonalAccountWorkspace(db, { id: cleanUserId });
  return all(db, `SELECT workspace.*,membership.role AS membership_role,membership.status AS membership_status,
      membership.display_name AS membership_display_name,membership.avatar_url AS membership_avatar_url,
      membership.title AS membership_title,membership.joined_at AS membership_joined_at
    FROM account_workspaces workspace
    JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE membership.user_id=? AND membership.status='active' AND workspace.status='active'
    ORDER BY CASE WHEN workspace.workspace_kind='personal' THEN 0 ELSE 1 END,lower(workspace.name),workspace.id`, [cleanUserId])
    .map((row) => ({ ...normalizeAccountWorkspaceRow(row), accountId: accountIdForWorkspace(db, row, cleanUserId) }));
}

export function activeAccountWorkspace(db, userId = '', deviceId = DEFAULT_DEVICE_ID) {
  const available = listAccountWorkspaces(db, userId);
  if (!available.length) return null;
  const preference = get(db, 'SELECT active_workspace_id FROM account_workspace_preferences WHERE user_id=? AND device_id=?', [userId, cleanDeviceId(deviceId)]);
  const selected = available.find((item) => item.id === preference?.active_workspace_id) || available[0];
  if (preference?.active_workspace_id !== selected.id) setActiveAccountWorkspace(db, userId, selected.id, deviceId);
  return selected;
}

export function startupAccountWorkspace(db, userId = '', deviceId = DEFAULT_DEVICE_ID) {
  const available = listAccountWorkspaces(db, userId);
  if (!available.length) return null;
  const cleanId = cleanDeviceId(deviceId);
  const preference = get(db, `SELECT startup_workspace_id FROM account_workspace_startup_preferences
    WHERE user_id=? AND device_id=?`, [userId, cleanId]);
  const activePreference = get(db, `SELECT active_workspace_id FROM account_workspace_preferences
    WHERE user_id=? AND device_id=?`, [userId, cleanId]);
  return available.find((item) => item.id === preference?.startup_workspace_id)
    || available.find((item) => item.id === activePreference?.active_workspace_id)
    || available.find((item) => item.id === PERSONAL_ACCOUNT_WORKSPACE_ID)
    || available.find((item) => item.kind === 'organization')
    || available[0];
}

export function setStartupAccountWorkspace(db, userId = '', workspaceId = '', deviceId = DEFAULT_DEVICE_ID) {
  const cleanUserId = String(userId || '').trim();
  const cleanWorkspaceId = normalizeAccountWorkspaceId(workspaceId) || PERSONAL_ACCOUNT_WORKSPACE_ID;
  const workspace = requireAccountWorkspaceMembership(db, cleanUserId, cleanWorkspaceId);
  const now = nowIso();
  run(db, `INSERT INTO account_workspace_startup_preferences(user_id,device_id,startup_workspace_id,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET
    startup_workspace_id=excluded.startup_workspace_id,updated_at=excluded.updated_at`, [
    cleanUserId, cleanDeviceId(deviceId), cleanWorkspaceId, now,
  ]);
  return workspace;
}

export function applyStartupAccountWorkspace(db, userId = '', deviceId = DEFAULT_DEVICE_ID) {
  const startup = startupAccountWorkspace(db, userId, deviceId);
  if (!startup) return null;
  // Do not turn an inferred fallback into a sticky startup preference. Until
  // the user explicitly chooses a startup Workspace, preserve the last active
  // Workspace across application restarts and upgrades.
  return setActiveAccountWorkspace(db, userId, startup.id, deviceId);
}

export function setActiveAccountWorkspace(db, userId = '', workspaceId = '', deviceId = DEFAULT_DEVICE_ID) {
  const cleanUserId = String(userId || '').trim();
  const cleanWorkspaceId = normalizeAccountWorkspaceId(workspaceId) || PERSONAL_ACCOUNT_WORKSPACE_ID;
  const membership = requireAccountWorkspaceMembership(db, cleanUserId, cleanWorkspaceId);
  const now = nowIso();
  run(db, `INSERT INTO account_workspace_preferences(user_id,device_id,active_workspace_id,updated_at)
    VALUES(?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET active_workspace_id=excluded.active_workspace_id,updated_at=excluded.updated_at`, [
    cleanUserId, cleanDeviceId(deviceId), cleanWorkspaceId, now,
  ]);
  return accountWorkspacePayload(db, cleanWorkspaceId, cleanUserId) || membership;
}

export function requireAccountWorkspaceMembership(db, userId = '', workspaceId = '') {
  const cleanUserId = String(userId || '').trim();
  const cleanWorkspaceId = normalizeAccountWorkspaceId(workspaceId);
  const row = get(db, `SELECT workspace.*,membership.role AS membership_role,membership.status AS membership_status
    FROM account_workspaces workspace JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE workspace.id=? AND workspace.status='active' AND membership.user_id=? AND membership.status='active'`, [cleanWorkspaceId, cleanUserId]);
  if (!row) {
    const error = new Error('工作空间不存在或你已不在该工作空间中。');
    error.code = 'ACCOUNT_WORKSPACE_ACCESS_DENIED';
    throw error;
  }
  return { ...normalizeAccountWorkspaceRow(row), accountId: accountIdForWorkspace(db, row, cleanUserId) };
}

export function accountWorkspacePayload(db, workspaceId = '', userId = '') {
  const row = get(db, `SELECT workspace.*,membership.role AS membership_role,membership.status AS membership_status,
      membership.display_name AS membership_display_name,membership.avatar_url AS membership_avatar_url,
      membership.title AS membership_title,membership.joined_at AS membership_joined_at
    FROM account_workspaces workspace LEFT JOIN account_workspace_memberships membership
      ON membership.workspace_id=workspace.id AND membership.user_id=? WHERE workspace.id=?`, [userId, workspaceId]);
  if (!row) return null;
  return { ...normalizeAccountWorkspaceRow(row), accountId: accountIdForWorkspace(db, row, userId) };
}

export function accountIdForWorkspace(db, workspace = '', userId = '') {
  const row = typeof workspace === 'string'
    ? get(db, 'SELECT * FROM account_workspaces WHERE id=?', [normalizeAccountWorkspaceId(workspace)])
    : workspace;
  if (!row) return '';
  const scopeUserId = row.workspace_kind === 'personal' ? String(userId || '').trim() : '';
  return get(db, `SELECT account_id FROM account_workspace_bindings
    WHERE workspace_id=? AND user_id_scope=?`, [row.id, scopeUserId])?.account_id
    || (row.workspace_kind === 'organization' ? organizationAccountId(row.organization_id) : personalAccountId(scopeUserId));
}

export function accountWorkspaceIdForOrganization(organizationId = '') {
  return organizationAccountWorkspaceId(organizationId);
}

function normalizeAccountWorkspaceRow(row = {}) {
  return {
    id: row.id || '',
    kind: row.workspace_kind || 'personal',
    organizationId: row.organization_id || '',
    ownerUserId: row.owner_user_id || '',
    name: row.workspace_kind === 'personal' ? '个人' : row.name || '未命名组织',
    avatarUrl: row.avatar_url || '',
    status: row.status || 'active',
    role: row.membership_role || 'member',
    membershipStatus: row.membership_status || '',
    profile: {
      displayName: row.membership_display_name || '',
      avatarUrl: row.membership_avatar_url || '',
      title: row.membership_title || '',
    },
    joinedAt: row.membership_joined_at || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cleanDeviceId(value = '') {
  return String(value || DEFAULT_DEVICE_ID).trim().slice(0, 180) || DEFAULT_DEVICE_ID;
}
