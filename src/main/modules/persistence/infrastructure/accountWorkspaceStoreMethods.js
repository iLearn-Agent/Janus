import { get, run } from '../../../db.js';
import { nowIso } from '../../../utils.js';
import { PERSONAL_ACCOUNT_WORKSPACE_ID, normalizeAccountWorkspaceId } from '../../../../shared/accountWorkspaces.js';
import {
  accountIdForWorkspace,
  activeAccountWorkspace,
  applyStartupAccountWorkspace,
  ensurePersonalAccountWorkspace,
  listAccountWorkspaces,
  requireAccountWorkspaceMembership,
  setActiveAccountWorkspace,
  setStartupAccountWorkspace,
  startupAccountWorkspace,
  syncOrganizationAccountWorkspaces,
} from '../../workspaces/index.js';

export function installAccountWorkspaceStoreMethods(prototype) {
  Object.assign(prototype, {
    ensureAccountWorkspaces({ user = null } = {}) {
      syncOrganizationAccountWorkspaces(this.db);
      if (user?.id) ensurePersonalAccountWorkspace(this.db, user);
      return user?.id ? listAccountWorkspaces(this.db, user.id) : [];
    },

    listAccountWorkspaces({ userId = '' } = {}) {
      return listAccountWorkspaces(this.db, userId);
    },

    activeAccountWorkspace({ userId = '', deviceId = '' } = {}) {
      const scopedWorkspaceId = normalizeAccountWorkspaceId(this.accountWorkspaceContext?.());
      if (scopedWorkspaceId) return requireAccountWorkspaceMembership(this.db, userId, scopedWorkspaceId);
      return activeAccountWorkspace(this.db, userId, deviceId || this.contextDeviceId?.() || 'local');
    },

    startupAccountWorkspace({ userId = '', deviceId = '' } = {}) {
      return startupAccountWorkspace(this.db, userId, deviceId || this.contextDeviceId?.() || 'local');
    },

    applyStartupAccountWorkspace({ userId = '', deviceId = '' } = {}) {
      return applyStartupAccountWorkspace(this.db, userId, deviceId || this.contextDeviceId?.() || 'local');
    },

    setStartupAccountWorkspace({ userId = '', workspaceId = '', deviceId = '' } = {}) {
      return setStartupAccountWorkspace(this.db, userId, workspaceId, deviceId || this.contextDeviceId?.() || 'local');
    },

    switchAccountWorkspace({ userId = '', workspaceId = '', deviceId = '' } = {}) {
      return setActiveAccountWorkspace(this.db, userId, workspaceId, deviceId || this.contextDeviceId?.() || 'local');
    },

    requireAccountWorkspace({ userId = '', workspaceId = '' } = {}) {
      return requireAccountWorkspaceMembership(this.db, userId, workspaceId);
    },

    resolveAccountWorkspaceId({ userId = '', workspaceId = '', deviceId = '' } = {}) {
      const cleanWorkspaceId = normalizeAccountWorkspaceId(workspaceId || this.accountWorkspaceContext?.());
      if (cleanWorkspaceId) return requireAccountWorkspaceMembership(this.db, userId, cleanWorkspaceId).id;
      return activeAccountWorkspace(this.db, userId, deviceId || this.contextDeviceId?.() || 'local')?.id || PERSONAL_ACCOUNT_WORKSPACE_ID;
    },

    resolveAccountId({ userId = '', workspaceId = '', deviceId = '' } = {}) {
      const resolvedWorkspaceId = this.resolveAccountWorkspaceId({ userId, workspaceId, deviceId });
      return accountIdForWorkspace(this.db, resolvedWorkspaceId, userId);
    },

    ensureWorkspaceAgentBinding({ workspaceId = '', agentInstanceId = '', ownerUserId = '', visibility = 'private' } = {}) {
      const cleanWorkspaceId = normalizeAccountWorkspaceId(workspaceId);
      const cleanInstanceId = String(agentInstanceId || '').trim();
      const cleanOwnerUserId = String(ownerUserId || '').trim();
      if (!cleanWorkspaceId || !cleanInstanceId || !cleanOwnerUserId) return null;
      requireAccountWorkspaceMembership(this.db, cleanOwnerUserId, cleanWorkspaceId);
      const instance = get(this.db, 'SELECT id,user_id FROM user_agent_instances WHERE id=?', [cleanInstanceId]);
      if (!instance || instance.user_id !== cleanOwnerUserId) throw new Error('Agent 不属于当前用户。');
      const now = nowIso();
      run(this.db, `INSERT INTO workspace_agent_bindings(
          workspace_id,agent_instance_id,owner_user_id,visibility,status,created_at,updated_at
        ) VALUES(?,?,?,?,'active',?,?)
        ON CONFLICT(workspace_id,agent_instance_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,
          status='active',updated_at=excluded.updated_at`, [cleanWorkspaceId, cleanInstanceId, cleanOwnerUserId,
        visibility === 'represented' ? 'represented' : 'private', now, now]);
      const accountId = accountIdForWorkspace(this.db, cleanWorkspaceId, cleanOwnerUserId);
      run(this.db, `INSERT INTO account_agent_instances(
          account_id,agent_instance_id,owner_user_id,visibility,status,created_at,updated_at
        ) VALUES(?,?,?,?, 'active',?,?) ON CONFLICT(account_id,agent_instance_id) DO UPDATE SET
        owner_user_id=excluded.owner_user_id,visibility=excluded.visibility,status='active',updated_at=excluded.updated_at`, [
        accountId, cleanInstanceId, cleanOwnerUserId,
        visibility === 'represented' ? 'represented' : 'member_private', now, now,
      ]);
      return get(this.db, 'SELECT * FROM workspace_agent_bindings WHERE workspace_id=? AND agent_instance_id=?', [cleanWorkspaceId, cleanInstanceId]);
    },
  });
}
