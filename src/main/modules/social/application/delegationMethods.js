import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import { normalizeRole, isPhoneOnlyEmail, orderedUserPair, normalizeAgentId, publicUserFromPrefixedRow, normalizeAgentDelegation, publicUser, normalizeFriendRequest, normalizeFriendship, normalizeSocialMessage, normalizeCollaborationGroup, normalizeCollaborationMember, normalizeCollaborationMessage, normalizeSocialMessageKind, parseJsonObject } from '../domain/socialRecords.js';
import {
  normalizeDelegationStatus as normalizeAgentDelegationStatus,
  privateDelegationMetadata as privateAgentDelegationMetadata,
  publicDelegationMetadata as publicAgentDelegationMetadata,
} from '../../../../shared/contracts/delegation.js';
import { privateTaskSourceMetadata, taskSourceContextMetadata } from '../../../../shared/contracts/taskCard.js';

export function installDelegationMethods(prototype) {
  Object.assign(prototype, {
  agentDelegations({ direction = 'all', limit = 50, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = delegationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const cleanDirection = ['incoming', 'outgoing', 'all'].includes(String(direction || '').trim().toLowerCase())
      ? String(direction || '').trim().toLowerCase()
      : 'all';
    const where = [];
    const params = [];
    if (cleanDirection === 'incoming') {
      where.push('ad.recipient_user_id = ?');
      params.push(user.id);
    } else if (cleanDirection === 'outgoing') {
      where.push('ad.requester_user_id = ?');
      params.push(user.id);
    } else {
      where.push('(ad.requester_user_id = ? OR ad.recipient_user_id = ?)');
      params.push(user.id, user.id);
    }
    where.push('ad.account_workspace_id = ?');
    params.push(workspace.id);
    params.push(Math.max(1, Math.min(5000, Number(limit) || 50)));
    const rows = all(
      this.db,
      `SELECT ad.*,
              requester.id AS requester_id, requester.email AS requester_email,
              requester.display_name AS requester_display_name, requester.username AS requester_username,
              requester.avatar_url AS requester_avatar_url, requester.role AS requester_role,
              requester.email_verified AS requester_email_verified,
              recipient.id AS recipient_id, recipient.email AS recipient_email,
              recipient.display_name AS recipient_display_name, recipient.username AS recipient_username,
              recipient.avatar_url AS recipient_avatar_url, recipient.role AS recipient_role,
              recipient.email_verified AS recipient_email_verified
       FROM agent_delegations ad
       LEFT JOIN auth_users requester ON requester.id = ad.requester_user_id
       LEFT JOIN auth_users recipient ON recipient.id = ad.recipient_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY ad.updated_at DESC, ad.created_at DESC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => this.withDelegationWorkspace(normalizeAgentDelegation(row), user.id));
  },

  agentDelegationsAllWorkspaces({ direction = 'all', limit = 200 } = {}) {
    const user = this.requireUser();
    const workspaceIds = all(this.db, `SELECT membership.workspace_id FROM account_workspace_memberships membership
      JOIN account_workspaces workspace ON workspace.id=membership.workspace_id
      WHERE membership.user_id=? AND membership.status='active' AND workspace.status='active'`, [user.id])
      .map((row) => row.workspace_id);
    return workspaceIds.flatMap((workspaceId) => this.agentDelegations({ direction, limit, workspaceId }))
      .sort((left, right) => String(right.updatedAt || right.updated_at || '').localeCompare(String(left.updatedAt || left.updated_at || '')))
      .slice(0, Math.max(1, Math.min(5000, Number(limit) || 200)));
  },

  delegationWorkspace(delegationId = '', userId = '', { workspaceId = '' } = {}) {
    const user = this.requireUser();
    const ownerId = String(userId || user.id).trim();
    if (ownerId !== user.id) throw new Error('无权访问其他用户的任务工作区。');
    const delegation = get(this.db, `SELECT account_workspace_id,requester_user_id,recipient_user_id FROM agent_delegations
      WHERE id=?${workspaceId ? ' AND account_workspace_id=?' : ''}`, workspaceId ? [String(delegationId || ''), workspaceId] : [String(delegationId || '')]);
    if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(ownerId)) throw new Error('任务不存在或无权访问。');
    const row = get(this.db, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?', [String(delegationId || ''), ownerId]);
    return row ? {
      delegationId: row.delegation_id,
      userId: row.user_id,
      sessionId: row.session_id || '',
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  },

  upsertDelegationWorkspace({ delegationId = '', userId = '', sessionId, metadata, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const ownerId = String(userId || user.id).trim();
    if (ownerId !== user.id) throw new Error('无权修改其他用户的任务工作区。');
    const delegation = get(this.db, `SELECT account_workspace_id,requester_user_id,recipient_user_id FROM agent_delegations
      WHERE id=?${workspaceId ? ' AND account_workspace_id=?' : ''}`, workspaceId ? [String(delegationId || ''), workspaceId] : [String(delegationId || '')]);
    if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(ownerId)) throw new Error('任务不存在或无权访问。');
    const existing = get(this.db, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?', [String(delegationId || ''), ownerId]);
    const nextSessionId = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'sessionId') ? String(sessionId || '') : String(existing?.session_id || '');
    const nextMetadata = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'metadata')
      ? { ...parseJsonObject(existing?.metadata_json), ...privateAgentDelegationMetadata(metadata) }
      : parseJsonObject(existing?.metadata_json);
    const now = nowIso();
    run(this.db, `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(delegation_id, user_id) DO UPDATE SET
        session_id = excluded.session_id, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
    [String(delegationId || ''), ownerId, nextSessionId, JSON.stringify(nextMetadata), existing?.created_at || now, now]);
    return this.delegationWorkspace(delegationId, ownerId, { workspaceId: delegation.account_workspace_id });
  },

  withDelegationWorkspace(delegation, userId = '') {
    if (!delegation) return null;
    const ownerId = String(userId || this.requireUser().id).trim();
    const row = get(this.db, 'SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?', [delegation.id, ownerId]);
    const workspaceMetadata = parseJsonObject(row?.metadata_json);
    const legacySessionId = ownerId === delegation.recipientUserId ? delegation.sessionId : '';
    const sessionId = row?.session_id || legacySessionId || '';
    return {
      ...delegation,
      sessionId,
      session_id: sessionId,
      metadata: { ...publicAgentDelegationMetadata(delegation.metadata), ...workspaceMetadata },
      workspace: row ? { userId: ownerId, sessionId, metadata: workspaceMetadata, updatedAt: row.updated_at } : null,
    };
  },

  createAgentDelegation({ recipientId = '', userId = '', title = '', instruction = '', senderAgentId = 'secretary_agent', recipientAgentId = 'secretary_agent', groupId = '', clientRequestId = '', metadata = {}, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = delegationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const targetId = String(recipientId || userId || '').trim();
    if (!targetId || targetId === user.id) throw new Error('\u8bf7\u9009\u62e9\u6709\u6548\u597d\u53cb\u3002');
    const target = this.getUser(targetId);
    if (!target) throw new Error('\u7528\u6237\u4e0d\u5b58\u5728\u3002');
    if (this.isBlockedEitherWay(user.id, targetId)) throw new Error('\u65e0\u6cd5\u5411\u8be5\u7528\u6237\u59d4\u6258\u4efb\u52a1\u3002');
    if (workspace.workspace_kind === 'organization') {
      if (!get(this.db, `SELECT 1 FROM account_workspace_memberships WHERE workspace_id=? AND user_id=? AND status='active'`, [workspace.id, targetId])) {
        throw new Error('只能向当前组织工作空间中的成员委托任务。');
      }
    } else if (!this.friendshipBetween(user.id, targetId)) throw new Error('\u53ea\u80fd\u5411\u597d\u53cb\u7684 Buddy agent \u59d4\u6258\u4efb\u52a1\u3002');
    const cleanInstruction = String(instruction || '').trim();
    if (!cleanInstruction) throw new Error('\u8bf7\u8f93\u5165\u8981\u59d4\u6258\u7ed9\u5bf9\u65b9 Buddy agent \u7684\u4efb\u52a1\u5185\u5bb9\u3002');
    const cleanTitle = (String(title || '').trim() || cleanInstruction.slice(0, 48) || 'Buddy agent \u59d4\u6258\u4efb\u52a1').slice(0, 160);
    const cleanClientRequestId = String(clientRequestId || metadata?.dispatchCommandId || '').trim().slice(0, 240);
    if (cleanClientRequestId) {
      const existing = get(this.db, `SELECT * FROM agent_delegations
        WHERE account_workspace_id=? AND requester_user_id=? AND client_request_id=?`, [workspace.id, user.id, cleanClientRequestId]);
      if (existing) {
        if (existing.recipient_user_id !== targetId || existing.title !== cleanTitle || existing.instruction !== cleanInstruction.slice(0, 8000)) {
          const error = new Error('委托创建幂等键已被不同请求占用。');
          error.code = 'delegation_idempotency_conflict';
          throw error;
        }
        return { ok: true, idempotent: true, delegation: this.agentDelegationById(existing.id, { workspaceId: workspace.id }), messageId: '' };
      }
    }
    const cleanSenderAgentId = normalizeAgentId(senderAgentId) || 'secretary_agent';
    const cleanRecipientAgentId = normalizeAgentId(recipientAgentId) || 'secretary_agent';
    const delegationId = newId('agent_delegate');
    const rawMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    const cleanMetadata = {
      ...rawMetadata,
      ...taskSourceContextMetadata({
      ...rawMetadata,
      task_workspace_id: delegationId,
      }),
    };
    run(
      this.db,
      `INSERT INTO agent_delegations (
        id, account_workspace_id, requester_user_id, recipient_user_id, client_request_id, sender_agent_id, recipient_agent_id,
        title, instruction, status, group_id, metadata_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?, ?)`,
      [
        delegationId,
        workspace.id,
        user.id,
        targetId,
        cleanClientRequestId,
        cleanSenderAgentId,
        cleanRecipientAgentId,
        cleanTitle,
        cleanInstruction.slice(0, 8000),
        String(groupId || cleanMetadata.groupId || ''),
        JSON.stringify(publicAgentDelegationMetadata(cleanMetadata)),
        nowIso(),
      ],
    );
    const requesterPrivateMetadata = privateTaskSourceMetadata(cleanMetadata);
    if (Object.keys(requesterPrivateMetadata).length) {
      this.upsertDelegationWorkspace({ delegationId, metadata: requesterPrivateMetadata });
    }
    const messageId = newId('social_msg');
    const conversationId = this.ensureSocialDirectConversation({
      senderUserId: user.id, recipientUserId: targetId, workspaceId: workspace.id,
    });
    const messageMetadata = {
      ...publicAgentDelegationMetadata(cleanMetadata),
      type: 'agent_delegation',
      action: 'assigned',
      delegationId,
      requesterUserId: user.id,
      recipientUserId: targetId,
      senderAgentId: cleanSenderAgentId,
      recipientAgentId: cleanRecipientAgentId,
      status: 'assigned',
    };
    run(
      this.db,
      `INSERT INTO social_messages (id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, sender_agent_id, kind, title, content, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?)`,
      [
        messageId,
        workspace.id,
        conversationId,
        user.id,
        targetId,
        cleanSenderAgentId,
        `Buddy agent \u59d4\u6258\uff1a${cleanTitle}`,
        `\u597d\u53cb\u7684 Buddy agent \u5411\u4f60\u7684 uBuddy \u6307\u6d3e\u4e86\u4e00\u9879\u4efb\u52a1\u3002\n\n\u4efb\u52a1\uff1a${cleanTitle}\n\n${cleanInstruction}`.slice(0, 4000),
        JSON.stringify(messageMetadata),
      ],
    );
    return { ok: true, delegation: this.agentDelegationById(delegationId, { workspaceId: workspace.id }), messageId };
  },

  agentDelegationById(delegationId = '', { workspaceId = '', allowGroupOwner = false } = {}) {
    const user = this.requireUser();
    const workspace = delegationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const params = [String(delegationId || ''), workspace.id, user.id, user.id, ...(allowGroupOwner ? [user.id] : [])];
    const row = get(
      this.db,
      `SELECT ad.*,
              requester.id AS requester_id, requester.email AS requester_email,
              requester.display_name AS requester_display_name, requester.username AS requester_username,
              requester.avatar_url AS requester_avatar_url, requester.role AS requester_role,
              requester.email_verified AS requester_email_verified,
              recipient.id AS recipient_id, recipient.email AS recipient_email,
              recipient.display_name AS recipient_display_name, recipient.username AS recipient_username,
              recipient.avatar_url AS recipient_avatar_url, recipient.role AS recipient_role,
              recipient.email_verified AS recipient_email_verified
       FROM agent_delegations ad
       LEFT JOIN auth_users requester ON requester.id = ad.requester_user_id
       LEFT JOIN auth_users recipient ON recipient.id = ad.recipient_user_id
       WHERE ad.id = ? AND ad.account_workspace_id=? AND (ad.requester_user_id = ? OR ad.recipient_user_id = ?
         ${allowGroupOwner ? 'OR EXISTS (SELECT 1 FROM collaboration_groups owner_group WHERE owner_group.id=ad.group_id AND owner_group.owner_user_id=?)' : ''})`,
      params,
    );
    return row ? this.withDelegationWorkspace(normalizeAgentDelegation(row), user.id) : null;
  },

  agentDelegationByEntityId(delegationId = '') {
    const user = this.requireUser();
    const entity = get(this.db, `SELECT account_workspace_id FROM agent_delegations
      WHERE id=? AND (requester_user_id=? OR recipient_user_id=?)`, [String(delegationId || ''), user.id, user.id]);
    return entity ? this.agentDelegationById(delegationId, { workspaceId: entity.account_workspace_id }) : null;
  },

  updateAgentDelegation({ delegationId = '', status = '', sessionId, taskRunId, lastError, metadata, started = false, completed = false, workspaceId = '', allowGroupOwner = false } = {}) {
    const user = this.requireUser();
    const entity = get(this.db, `SELECT ad.account_workspace_id,ad.requester_user_id,ad.recipient_user_id FROM agent_delegations ad
      WHERE ad.id=? AND (ad.requester_user_id=? OR ad.recipient_user_id=?
        ${allowGroupOwner ? 'OR EXISTS (SELECT 1 FROM collaboration_groups owner_group WHERE owner_group.id=ad.group_id AND owner_group.owner_user_id=?)' : ''})`,
    [String(delegationId || ''), user.id, user.id, ...(allowGroupOwner ? [user.id] : [])]);
    const entityWorkspaceId = String(workspaceId || entity?.account_workspace_id || '').trim();
    const current = entityWorkspaceId ? this.agentDelegationById(delegationId, { workspaceId: entityWorkspaceId, allowGroupOwner }) : null;
    if (!current) throw new Error('\u59d4\u6258\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u8bbf\u95ee\u3002');
    const viewerIsParticipant = [entity?.requester_user_id, entity?.recipient_user_id].includes(user.id);
    const updates = [];
    const params = [];
    const now = nowIso();
    const cleanStatus = status ? normalizeAgentDelegationStatus(status) : '';
    if (cleanStatus) {
      updates.push('status = ?');
      params.push(cleanStatus);
      if (cleanStatus === 'running' || cleanStatus === 'accepted') updates.push('completed_at = NULL');
    }
    if (viewerIsParticipant && (Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'sessionId') || Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'metadata'))) {
      this.upsertDelegationWorkspace({
        delegationId,
        workspaceId: entityWorkspaceId,
        ...(Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'sessionId') ? { sessionId } : {}),
        ...(Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'metadata') ? { metadata } : {}),
      });
    }
    if (Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'taskRunId')) {
      updates.push('task_run_id = ?');
      params.push(String(taskRunId || ''));
    }
    if (Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'lastError')) {
      updates.push('last_error = ?');
      params.push(String(lastError || '').slice(0, 2000));
    }
    if (Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'metadata')) {
      updates.push('metadata_json = ?');
      params.push(JSON.stringify(publicAgentDelegationMetadata(metadata)));
    }
    if (started) {
      updates.push('started_at = COALESCE(started_at, ?)');
      params.push(now);
    }
    if (completed) {
      updates.push('completed_at = ?');
      params.push(now);
    }
    if (!updates.length) return current;
    updates.push('updated_at = ?');
    params.push(now, String(delegationId || ''));
    run(this.db, `UPDATE agent_delegations SET ${updates.join(', ')} WHERE id = ?`, params);
    return this.agentDelegationById(delegationId, { workspaceId: entityWorkspaceId, allowGroupOwner });
  }
  });
}

function delegationAccountWorkspace(db, userId = '', workspaceId = '') {
  const explicitWorkspaceId = String(workspaceId || '').trim();
  const requested = explicitWorkspaceId || get(db, `SELECT active_workspace_id FROM account_workspace_preferences
    WHERE user_id=? ORDER BY CASE WHEN device_id='local' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`, [userId])?.active_workspace_id || 'workspace_personal';
  let workspace = get(db, `SELECT workspace.* FROM account_workspaces workspace
    JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE workspace.id=? AND workspace.status='active' AND membership.user_id=? AND membership.status='active'`, [requested, userId]);
  if (!workspace && !explicitWorkspaceId) {
    workspace = get(db, `SELECT workspace.* FROM account_workspaces workspace
      JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
      WHERE workspace.id='workspace_personal' AND workspace.status='active' AND membership.user_id=? AND membership.status='active'`, [userId]);
    if (workspace) run(db, `UPDATE account_workspace_preferences SET active_workspace_id='workspace_personal',updated_at=?
      WHERE user_id=? AND active_workspace_id=?`, [nowIso(), userId, requested]);
  }
  if (!workspace) throw new Error('工作空间不存在或你已不在该工作空间中。');
  return workspace;
}
