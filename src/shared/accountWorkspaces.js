export const PERSONAL_ACCOUNT_WORKSPACE_ID = 'workspace_personal';
export const ACCOUNT_KINDS = Object.freeze(['personal', 'organization']);
export const ACCOUNT_WORKSPACE_KINDS = Object.freeze(['personal', 'organization']);
export const ACCOUNT_WORKSPACE_MEMBERSHIP_ROLES = Object.freeze(['owner', 'admin', 'member', 'guest']);
export const ACCOUNT_WORKSPACE_MEMBERSHIP_STATUSES = Object.freeze(['active', 'suspended', 'left', 'removed']);

export function normalizeAccountWorkspaceId(value = '') {
  return String(value || '').trim().slice(0, 180);
}

export function organizationAccountWorkspaceId(organizationId = '') {
  const cleanId = normalizeAccountWorkspaceId(organizationId);
  return cleanId ? `workspace_org_${cleanId}` : '';
}

export function personalAccountId(userId = '') {
  const cleanId = normalizeAccountWorkspaceId(userId);
  return cleanId ? `account_personal_${cleanId}` : '';
}

export function organizationAccountId(organizationId = '') {
  const cleanId = normalizeAccountWorkspaceId(organizationId);
  return cleanId ? `account_org_${cleanId}` : '';
}

export function normalizeAccountId(value = '') {
  return String(value || '').trim().slice(0, 220);
}

export function normalizeAccountWorkspaceKind(value = '') {
  const kind = String(value || '').trim().toLowerCase();
  return ACCOUNT_WORKSPACE_KINDS.includes(kind) ? kind : 'personal';
}

export function normalizeAccountWorkspaceRole(value = '') {
  const role = String(value || '').trim().toLowerCase();
  return ACCOUNT_WORKSPACE_MEMBERSHIP_ROLES.includes(role) ? role : 'member';
}

export function normalizeAccountWorkspaceStatus(value = '') {
  const status = String(value || '').trim().toLowerCase();
  return ACCOUNT_WORKSPACE_MEMBERSHIP_STATUSES.includes(status) ? status : 'active';
}

export function isPersonalAccountWorkspace(workspaceId = '') {
  return normalizeAccountWorkspaceId(workspaceId) === PERSONAL_ACCOUNT_WORKSPACE_ID;
}
