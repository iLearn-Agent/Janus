import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import { normalizeRole, isPhoneOnlyEmail, orderedUserPair, normalizeAgentId, publicUserFromPrefixedRow, normalizeAgentDelegation, publicUser, normalizeFriendRequest, normalizeFriendship, normalizeSocialMessage, normalizeCollaborationGroup, normalizeCollaborationMember, normalizeCollaborationMessage, normalizeSocialMessageKind, parseJsonObject } from '../domain/socialRecords.js';
import {
  delegationTransitionAllowed,
  normalizeDelegationStatus as normalizeAgentDelegationStatus,
  privateDelegationMetadata as privateAgentDelegationMetadata,
  publicDelegationMetadata as publicAgentDelegationMetadata,
} from '../../../../shared/contracts/delegation.js';
import { privateTaskSourceMetadata, taskSourceContextMetadata, withoutPrivateTaskSourceMetadata } from '../../../../shared/contracts/taskCard.js';
import { normalizePublicTaskSummary } from '../../../../shared/contracts/taskSummary.js';
import {
  automaticTaskGroupTitleSummary,
  buildTaskGroupTitle,
  manualTaskGroupTitleMetadata,
} from '../../../../shared/taskGroupTitle.js';

function refreshAutomaticCollaborationGroupTitle(db, groupId = '', now = nowIso()) {
  const group = get(db, 'SELECT metadata_json FROM collaboration_groups WHERE id = ?', [groupId]);
  const metadata = parseJsonObject(group?.metadata_json);
  const summary = automaticTaskGroupTitleSummary(metadata);
  if (!summary) return;
  const plannedRecipientIds = normalizedPlannedRecipientIds(metadata.plannedRecipientIds);
  const participantIds = plannedRecipientIds.length
    ? [get(db, 'SELECT owner_user_id FROM collaboration_groups WHERE id=?', [groupId])?.owner_user_id, ...plannedRecipientIds].filter(Boolean)
    : all(db, `SELECT m.user_id FROM collaboration_group_members m WHERE m.group_id=? AND m.status='active'
      ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END,m.joined_at`, [groupId]).map((item) => item.user_id);
  const participants = participantIds.map((userId) => get(db,
    'SELECT id,email,display_name,username FROM auth_users WHERE id=?', [userId]) || { id: userId });
  run(db, 'UPDATE collaboration_groups SET title=?,updated_at=? WHERE id=?', [
    buildTaskGroupTitle({ objective: summary, participants }), now, groupId,
  ]);
}

function localCollaborationGroupWorkspace(row = {}, group = {}, membership = {}) {
  return {
    id: row.group_id || group.id || '',
    groupId: row.group_id || group.id || '',
    workspaceEpoch: row.workspace_epoch || `workspace_${group.id || ''}`,
    revision: Math.max(0, Number(row.revision || 0)),
    status: row.status || group.status || 'active',
    scope: 'collaboration_group',
    readOnly: group.status === 'closed' || membership.status !== 'active',
    createdAt: row.created_at || group.createdAt || group.created_at || '',
    updatedAt: row.updated_at || group.updatedAt || group.updated_at || '',
  };
}

export function installCollaborationGroupMethods(prototype) {
  Object.assign(prototype, {
  importCloudCollaborationOverview(result = {}) {
    const user = this.requireUser();
    const groups = result?.group ? [result.group] : Array.isArray(result?.groups) ? result.groups : [];
    const detailMembers = Array.isArray(result?.members) ? result.members : [];
    if (!groups.length) return { importedGroups: 0, importedMemberships: 0 };
    const ownsTransaction = !this.db.isTransaction;
    let importedGroups = 0;
    let importedMemberships = 0;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of groups) {
        const id = String(item?.id || '').trim();
        if (!id) continue;
        const workspaceId = localCollaborationWorkspaceId(this.db,
          item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal');
        const remoteOwnerId = item.ownerUserId || item.owner_user_id || item.owner?.id || '';
        const ownerId = this.importCloudUser?.(item.owner || { id: remoteOwnerId })?.id
          || this.remoteUserLocalId?.(remoteOwnerId) || remoteOwnerId || user.id;
        const metadata = parseJsonObject(item.metadata);
        const plannedParticipants = Array.isArray(result?.plannedParticipants) ? result.plannedParticipants : [];
        metadata.plannedRecipientIds = normalizedPlannedRecipientIds(metadata.plannedRecipientIds).map((remoteUserId) => {
          const planned = plannedParticipants.find((candidate) => String(candidate?.userId || candidate?.user?.id || '') === remoteUserId);
          const imported = planned?.user ? this.importCloudUser?.(planned.user) : null;
          return imported?.id || this.remoteUserLocalId?.(remoteUserId) || remoteUserId;
        });
        run(this.db, `INSERT INTO collaboration_groups(
          id,account_workspace_id,owner_user_id,title,status,client_request_id,metadata_json,created_at,updated_at,closed_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          account_workspace_id=excluded.account_workspace_id,owner_user_id=excluded.owner_user_id,title=excluded.title,
          status=excluded.status,client_request_id=CASE WHEN excluded.client_request_id!='' THEN excluded.client_request_id ELSE collaboration_groups.client_request_id END,
          metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,closed_at=excluded.closed_at`, [
          id, workspaceId, ownerId, item.title || 'uBuddy 任务群', item.status || 'active',
          item.clientRequestId || item.client_request_id || `remote:${id}`, JSON.stringify(metadata),
          item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso(), item.closedAt || item.closed_at || null,
        ]);
        importedGroups += 1;
        const membership = item.membership || detailMembers.find((candidate) => {
          const remoteMemberId = candidate?.userId || candidate?.user_id || candidate?.user?.id || '';
          const localMemberId = this.remoteUserLocalId?.(remoteMemberId) || remoteMemberId;
          return localMemberId === user.id || remoteMemberId === user.remoteId || remoteMemberId === user.remote_id;
        }) || (Array.isArray(result?.groups) ? {
          userId: user.remoteId || user.remote_id || user.id,
          user: { id: user.remoteId || user.remote_id || user.id },
          role: remoteOwnerId && [user.id, user.remoteId, user.remote_id].includes(remoteOwnerId) ? 'owner' : 'member',
          status: item.status === 'closed' ? 'closed' : 'active',
          joinedAt: item.createdAt || item.created_at || nowIso(),
        } : null);
        if (!membership) continue;
        const remoteMemberId = membership.userId || membership.user_id || '';
        const sourceMember = membership.user || { id: remoteMemberId };
        const memberId = this.importCloudUser?.({ ...sourceMember,
          displayName: sourceMember.accountDisplayName || sourceMember.account_display_name || sourceMember.displayName,
          display_name: sourceMember.accountDisplayName || sourceMember.account_display_name || sourceMember.display_name })?.id
          || this.remoteUserLocalId?.(remoteMemberId) || remoteMemberId || '';
        if (!memberId || memberId !== user.id) continue;
        run(this.db, `INSERT INTO collaboration_group_members(
          group_id,user_id,role,status,display_name_override,joined_at,left_at,last_read_at
        ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET
          role=excluded.role,status=excluded.status,display_name_override=excluded.display_name_override,
          joined_at=excluded.joined_at,left_at=excluded.left_at,
          last_read_at=COALESCE(excluded.last_read_at,collaboration_group_members.last_read_at)`, [
          id, memberId, membership.role || 'member', membership.status || 'active',
          String(membership.displayNameOverride || membership.display_name_override || '').trim().slice(0, 80),
          membership.joinedAt || membership.joined_at || item.createdAt || item.created_at || nowIso(),
          membership.leftAt || membership.left_at || null, membership.lastReadAt || membership.last_read_at || null,
        ]);
        importedMemberships += 1;
      }
      if (ownsTransaction) this.db.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return { importedGroups, importedMemberships };
  },

  collaborationOverview({ workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = collaborationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const groups = all(
      this.db,
      `SELECT g.*,
              (SELECT COUNT(*) FROM collaboration_group_members cm WHERE cm.group_id = g.id AND cm.status = 'active') AS member_count,
              (SELECT COUNT(*) FROM collaboration_group_messages gm
               WHERE gm.group_id = g.id AND gm.sender_user_id <> ?
                 AND gm.created_at > COALESCE(m.last_read_at, '')) AS unread_count,
              (SELECT printf('%s：%s',
                        COALESCE(NULLIF(sender_member.display_name_override,''),NULLIF(sender.display_name,''),
                          NULLIF(sender.username,''),NULLIF(sender.email,''),NULLIF(gm.sender_agent_id,''),
                          NULLIF(gm.sender_user_id,''),'系统'),
                        gm.content)
                 FROM collaboration_group_messages gm
                 LEFT JOIN auth_users sender ON sender.id=gm.sender_user_id
                 LEFT JOIN collaboration_group_members sender_member ON sender_member.group_id=gm.group_id AND sender_member.user_id=gm.sender_user_id
                WHERE gm.group_id = g.id ORDER BY gm.created_at DESC,gm.id DESC LIMIT 1) AS last_message
       FROM collaboration_groups g
       JOIN collaboration_group_members m ON m.group_id = g.id AND m.user_id = ?
       WHERE g.account_workspace_id=? AND ((g.status = 'active' AND m.status = 'active') OR (g.status = 'closed' AND m.status = 'closed'))
       ORDER BY g.updated_at DESC`,
      [user.id, user.id, workspace.id],
    ).map(normalizeCollaborationGroup);
    return { groups: this.decorateConversationGroups(groups, 'collaboration_group'), tasks: this.agentDelegations({ direction: 'all', limit: 200, workspaceId: workspace.id }) };
  },

  collaborationGroup(groupId = '', { workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = collaborationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const id = String(groupId || '').trim();
    const membership = get(this.db, 'SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ?', [id, user.id]);
    if (!membership) throw new Error('任务群不存在或你不在群内。');
    const groupRow = get(this.db, 'SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id=?', [id, workspace.id]);
    if (!groupRow) throw new Error('任务群不存在。');
    syncGroupConversationMessages(this.db, groupRow);
    const members = all(
      this.db,
      `SELECT m.*,u.id,u.email,COALESCE(NULLIF(m.display_name_override,''),u.display_name) AS display_name,
              u.display_name AS account_display_name,u.username,u.avatar_url,u.role AS user_role,u.email_verified
       FROM collaboration_group_members m JOIN auth_users u ON u.id = m.user_id
       WHERE m.group_id = ? AND (? = '' OR m.joined_at <= ?)
       ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at`,
      [id, membership.status === 'removed' ? membership.left_at || '' : '', membership.left_at || ''],
    ).map(normalizeCollaborationMember);
    const messages = all(
      this.db,
      `SELECT gm.*,u.email AS sender_email,
              COALESCE(NULLIF(sender_member.display_name_override,''),u.display_name) AS sender_display_name,
              u.username AS sender_username, u.avatar_url AS sender_avatar_url,
              u.role AS sender_role, u.email_verified AS sender_email_verified
       FROM collaboration_group_messages gm JOIN auth_users u ON u.id = gm.sender_user_id
       LEFT JOIN collaboration_group_members sender_member ON sender_member.group_id=gm.group_id AND sender_member.user_id=gm.sender_user_id
       WHERE gm.group_id = ? AND gm.account_workspace_id=? AND (? = '' OR gm.created_at <= ?) ORDER BY gm.created_at ASC`,
      [id, workspace.id, membership.status === 'removed' ? membership.left_at || '' : '', membership.left_at || ''],
    ).map(normalizeCollaborationMessage);
    const tasks = all(this.db, `SELECT ad.*,
        requester.id AS requester_id,requester.email AS requester_email,requester.display_name AS requester_display_name,
        requester.username AS requester_username,requester.avatar_url AS requester_avatar_url,requester.role AS requester_role,
        requester.email_verified AS requester_email_verified,
        recipient.id AS recipient_id,recipient.email AS recipient_email,recipient.display_name AS recipient_display_name,
        recipient.username AS recipient_username,recipient.avatar_url AS recipient_avatar_url,recipient.role AS recipient_role,
        recipient.email_verified AS recipient_email_verified
      FROM agent_delegations ad
      LEFT JOIN auth_users requester ON requester.id=ad.requester_user_id
      LEFT JOIN auth_users recipient ON recipient.id=ad.recipient_user_id
      WHERE ad.group_id=? AND ad.account_workspace_id=? ORDER BY ad.created_at ASC`, [id, workspace.id])
      .map((row) => this.withDelegationWorkspace(normalizeAgentDelegation(row), user.id));
    const groupMetadata = parseJsonObject(groupRow.metadata_json);
    const activeMemberIds = new Set(members.filter((item) => item.status === 'active').map((item) => item.userId));
    const plannedParticipants = normalizedPlannedRecipientIds(groupMetadata.plannedRecipientIds).map((userId) => ({
      userId,
      status: activeMemberIds.has(userId) ? 'active' : 'awaiting_presence',
      user: publicUser(this.getUser(userId) || { id: userId }),
    }));
    run(this.db, `INSERT INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,updated_at)
      VALUES(?,?,0,?,?) ON CONFLICT(group_id) DO UPDATE SET status=excluded.status`, [id, `workspace_${id}`, groupRow.status || 'active', groupRow.updated_at || nowIso()]);
    const workspaceRow = get(this.db, 'SELECT * FROM collaboration_group_workspaces WHERE group_id = ?', [id]);
    run(this.db, 'UPDATE collaboration_group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?', [nowIso(), id, user.id]);
    const normalizedGroup = normalizeCollaborationGroup(groupRow);
    return { group: normalizedGroup, workspace: localCollaborationGroupWorkspace(workspaceRow, normalizedGroup, membership), members, plannedParticipants, messages, tasks };
  },

  createCollaborationGroup({ title = '', clientRequestId = '', assignments = [], plannedRecipientIds = [], metadata = {}, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = collaborationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const cleanRequestId = String(clientRequestId || '').trim() || newId('dispatch');
    const storedRequestId = workspace.id === 'workspace_personal' ? cleanRequestId : `${workspace.id}:${cleanRequestId}`;
    const existing = get(this.db, `SELECT id FROM collaboration_groups
      WHERE account_workspace_id=? AND owner_user_id=? AND client_request_id IN (?,?)
      ORDER BY CASE WHEN client_request_id=? THEN 0 ELSE 1 END LIMIT 1`,
    [workspace.id, user.id, storedRequestId, cleanRequestId, storedRequestId]);
    if (existing) return { ok: true, ...this.collaborationGroup(existing.id, { workspaceId: workspace.id }), idempotent: true };
    const cleanAssignments = (Array.isArray(assignments) ? assignments : [])
      .map((item) => ({
        recipientId: String(item.recipientId || item.userId || '').trim(),
        title: String(item.title || title || 'uBuddy 委托任务').trim().slice(0, 160),
        instruction: String(item.instruction || '').trim().slice(0, 8000),
        metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {},
      }))
      .filter((item) => item.recipientId && item.recipientId !== user.id && item.instruction);
    if (new Set(cleanAssignments.map((item) => item.recipientId)).size !== cleanAssignments.length) {
      const error = new Error('同一参与人只能对应一项远程分工；请将多个工作项合并到同一分工中。');
      error.code = 'collaboration_assignment_duplicate_recipient';
      throw error;
    }
    const plannedIds = normalizedPlannedRecipientIds(
      Array.isArray(plannedRecipientIds) && plannedRecipientIds.length
        ? plannedRecipientIds
        : metadata?.plannedRecipientIds,
    );
    if (!cleanAssignments.length && !plannedIds.length) throw new Error('请至少选择一位好友并填写任务内容。');
    const allRecipientIds = [...new Set([...cleanAssignments.map((item) => item.recipientId), ...plannedIds])];
    const organizationAudienceSnapshot = metadata?.organizationAudienceSnapshot
      && typeof metadata.organizationAudienceSnapshot === 'object'
      ? metadata.organizationAudienceSnapshot
      : null;
    const organizationAudienceId = String(organizationAudienceSnapshot?.organizationId || '').trim();
    const organizationAudienceMemberIds = new Set(
      (Array.isArray(organizationAudienceSnapshot?.memberUserIds)
        ? organizationAudienceSnapshot.memberUserIds
        : []).map((userId) => String(userId || '').trim()).filter(Boolean),
    );
    const currentOrganizationAudienceIds = workspace.workspace_kind === 'personal' && organizationAudienceId
      ? all(this.db, `SELECT recipient.user_id FROM contact_organization_members owner
          JOIN contact_organization_members recipient ON recipient.organization_id=owner.organization_id
          WHERE owner.organization_id=? AND owner.user_id=? AND recipient.user_id<>?
          ORDER BY recipient.user_id`, [organizationAudienceId, user.id, user.id])
        .map((row) => String(row.user_id || '')).filter(Boolean).sort()
      : [];
    const snapshotOrganizationAudienceIds = [...organizationAudienceMemberIds].sort();
    const organizationAudienceHash = currentOrganizationAudienceIds.length
      ? crypto.createHash('sha256')
        .update(`${organizationAudienceId}\n${currentOrganizationAudienceIds.join('\n')}`, 'utf8')
        .digest('hex')
      : '';
    const organizationAudienceCurrent = currentOrganizationAudienceIds.length === snapshotOrganizationAudienceIds.length
      && currentOrganizationAudienceIds.every((userId, index) => userId === snapshotOrganizationAudienceIds[index])
      && organizationAudienceHash === String(organizationAudienceSnapshot?.membershipHash || '');
    for (const recipientId of allRecipientIds) {
      const organizationAudienceMember = workspace.workspace_kind === 'personal'
        && organizationAudienceCurrent
        && organizationAudienceMemberIds.has(recipientId);
      const allowed = workspace.workspace_kind === 'organization'
        ? get(this.db, `SELECT 1 FROM account_workspace_memberships WHERE workspace_id=? AND user_id=? AND status='active'`, [workspace.id, recipientId])
        : this.friendshipBetween(user.id, recipientId) || organizationAudienceMember;
      if (!allowed || this.isBlockedEitherWay(user.id, recipientId)) {
        throw new Error('任务群只能邀请当前好友或已确认的组织成员。');
      }
    }
    const automaticSummary = automaticTaskGroupTitleSummary(metadata);
    const storedTitle = automaticSummary
      ? buildTaskGroupTitle({
        objective: automaticSummary,
        participants: [user, ...allRecipientIds.map((recipientId) => this.getUser(recipientId) || { id: recipientId })],
      })
      : (String(title || '').trim() || 'uBuddy 任务群').slice(0, 80);
    const groupId = newId('collab_group');
    const now = nowIso();
    this.db.exec('BEGIN');
    try {
      run(this.db, `INSERT INTO collaboration_groups (id, account_workspace_id, owner_user_id, title, client_request_id, metadata_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [groupId, workspace.id, user.id, storedTitle, storedRequestId, JSON.stringify(metadata || {}), now]);
      run(this.db, `INSERT INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,updated_at)
        VALUES(?,?,0,'active',?)`, [groupId, `workspace_${groupId}`, now]);
      run(this.db, `INSERT INTO collaboration_group_members (group_id, user_id, role, last_read_at) VALUES (?, ?, 'owner', ?)`, [groupId, user.id, now]);
      for (const recipientId of [...new Set(cleanAssignments.map((item) => item.recipientId))]) {
        run(this.db, `INSERT INTO collaboration_group_members (group_id, user_id, role) VALUES (?, ?, 'member')`, [groupId, recipientId]);
      }
      const createdMessageId = newId('group_msg');
      const createdMessage = cleanAssignments.length
        ? 'uBuddy 已创建任务群并发布任务。'
        : 'uBuddy 已创建任务群，正在等待成员上线后发布任务。';
      run(this.db, `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, updated_at)
        VALUES (?, ?, ?, ?, 'secretary_agent', 'system', ?, ?, ?)`, [createdMessageId, workspace.id, groupId, user.id, createdMessage, JSON.stringify({ type: 'group_created' }), now]);
      for (const item of cleanAssignments) {
        const delegationId = newId('agent_delegate');
        const delegationMetadata = {
          ...item.metadata,
          ...(metadata || {}),
          ...taskSourceContextMetadata({
            ...item.metadata,
            ...(metadata || {}),
            source_group_id: metadata?.source_group_id || metadata?.sourceGroupId || '',
            task_workspace_id: delegationId,
          }),
          groupId,
          source: 'collaboration_group',
          initiatedThroughOwnUBuddy: true,
        };
        run(this.db, `INSERT INTO agent_delegations (
          id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
          title, instruction, status, group_id, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', ?, ?, 'assigned', ?, ?, ?)`,
        [delegationId, workspace.id, user.id, item.recipientId, item.title, item.instruction, groupId, JSON.stringify(publicAgentDelegationMetadata(delegationMetadata)), now]);
        const privateMetadata = privateAgentDelegationMetadata(delegationMetadata);
        const recipientPrivateMetadata = withoutPrivateTaskSourceMetadata(privateMetadata);
        const requesterPrivateMetadata = privateTaskSourceMetadata(delegationMetadata);
        run(this.db, `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
          VALUES (?, ?, ?, ?), (?, ?, ?, ?)`, [delegationId, item.recipientId, JSON.stringify(recipientPrivateMetadata), now, delegationId, user.id, JSON.stringify(requesterPrivateMetadata), now]);
        run(this.db, `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, updated_at)
          VALUES (?, ?, ?, ?, 'secretary_agent', 'agent', ?, ?, ?)`, [newId('group_msg'), workspace.id, groupId, user.id, item.instruction, JSON.stringify({ type: 'task_assigned', delegationId, recipientUserId: item.recipientId }), now]);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, ...this.collaborationGroup(groupId, { workspaceId: workspace.id }) };
  },

  sendCollaborationMessage({ groupId = '', content = '', senderAgentId = '', kind = '', metadata = {}, sourceEventId: requestedSourceEventId = '', workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = collaborationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const id = String(groupId || '').trim();
    const membership = get(this.db, 'SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ?', [id, user.id]);
    const group = get(this.db, 'SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id=?', [id, workspace.id]);
    if (!membership || !group) throw new Error('任务群不存在或你已不在群内。');
    if (group.status === 'closed') throw new Error('任务群已解散，不能继续发送消息。');
    if (membership.status !== 'active') throw new Error('任务群不存在或你已不在群内。');
    const text = String(content || '').trim();
    if (!text) throw new Error('请输入消息内容。');
    const messageId = newId('group_msg');
    const now = nowIso();
    const sourceEventId = String(requestedSourceEventId || metadata?.sourceEventId || metadata?.source_event_id || '').trim().slice(0, 240);
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      run(this.db, `INSERT OR IGNORE INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [messageId, workspace.id, id, user.id, String(senderAgentId || '') === 'secretary_agent' ? 'secretary_agent' : '', normalizeSocialMessageKind(kind || (senderAgentId ? 'agent' : 'friend')), text.slice(0, 8000), JSON.stringify(metadata || {}), sourceEventId, now]);
      const persisted = sourceEventId
        ? get(this.db,'SELECT * FROM collaboration_group_messages WHERE group_id=? AND source_event_id=?',[id,sourceEventId])
        : get(this.db,'SELECT * FROM collaboration_group_messages WHERE id=?',[messageId]);
      recordCollaborationMessageEvidenceOutbox(this,{message:persisted,group,metadata});
      run(this.db, 'UPDATE collaboration_groups SET updated_at = ? WHERE id = ?', [now, id]);
      if (ownsTransaction) this.db.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, ...this.collaborationGroup(id, { workspaceId: workspace.id }) };
  },

  updateCollaborationGroup({ groupId = '', action = '', userId = '', title = '', displayName = '', assignment = null, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = collaborationAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const id = String(groupId || '').trim();
    const group = get(this.db, 'SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id=?', [id, workspace.id]);
    const membership = get(this.db, 'SELECT * FROM collaboration_group_members WHERE group_id=? AND user_id=?', [id, user.id]);
    if (!group || !membership) throw new Error('任务群不存在或你不在群内。');
    if (action === 'set_display_name' && membership.status !== 'active') throw new Error('任务群已结束，不能修改群内显示名。');
    if (action !== 'set_display_name' && group.owner_user_id !== user.id) throw new Error('只有任务群发起人可以执行此操作。');
    if (group.status === 'closed' && action !== 'close') throw new Error('任务群已解散，不能继续修改。');
    if (group.status === 'closed' && action === 'close') return { ok: true, ...this.collaborationGroup(id, { workspaceId: workspace.id }), idempotent: true };
    const now = nowIso();
    if (action === 'set_display_name') {
      run(this.db, `UPDATE collaboration_group_members SET display_name_override=?
        WHERE group_id=? AND user_id=? AND status='active'`, [String(displayName || '').trim().slice(0, 80), id, user.id]);
    } else if (action === 'close') {
      const tasks = all(this.db, 'SELECT id,status,metadata_json FROM agent_delegations WHERE group_id=?', [id]);
      const withdrawnIds = [];
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const task of tasks) {
          if (!delegationTransitionAllowed(task.status, 'withdraw')) continue;
          const metadata = {
            ...parseJsonObject(task.metadata_json),
            withdrawnFromStatus: task.status,
            withdrawnAt: now,
            withdrawnReason: 'group_closed_by_owner',
          };
          run(this.db, `UPDATE agent_delegations SET status='withdrawn',metadata_json=?,completed_at=COALESCE(completed_at,?),updated_at=?
            WHERE id=?`, [JSON.stringify(publicAgentDelegationMetadata(metadata)), now, now, task.id]);
          withdrawnIds.push(task.id);
        }
        run(this.db, "UPDATE collaboration_groups SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
        run(this.db, "UPDATE collaboration_group_workspaces SET status = 'closed', updated_at = ? WHERE group_id = ?", [now, id]);
        run(this.db, "UPDATE collaboration_group_members SET status = 'closed', left_at = COALESCE(left_at, ?) WHERE group_id = ? AND status = 'active'", [now, id]);
        run(this.db, `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json, updated_at)
          VALUES (?, ?, ?, ?, 'system', '发起人已停止未完成任务并结束工作群。', ?, ?)`, [newId('group_msg'), workspace.id, id, user.id, JSON.stringify({ type: 'group_closed', withdrawnDelegationIds: withdrawnIds }), now]);
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      const result = { ok: true, ...this.collaborationGroup(id, { workspaceId: workspace.id }) };
      result.terminationSummary = {
        withdrawnCount: withdrawnIds.length,
        preservedCount: tasks.length - withdrawnIds.length,
        withdrawnDelegationIds: withdrawnIds,
      };
      return result;
    } else if (action === 'rename') {
      run(this.db, 'UPDATE collaboration_groups SET title = ?, metadata_json = ?, updated_at = ? WHERE id = ?', [
        (String(title || '').trim() || group.title).slice(0, 80),
        JSON.stringify(manualTaskGroupTitleMetadata(parseJsonObject(group.metadata_json))), now, id,
      ]);
    } else if (action === 'remove_member') {
      const targetId = String(userId || '').trim();
      if (!targetId || targetId === user.id) throw new Error('不能移除任务群发起人。');
      const tasks = all(this.db, 'SELECT id,status,metadata_json FROM agent_delegations WHERE group_id=? AND recipient_user_id=?', [id, targetId]);
      const withdrawnIds = [];
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, "UPDATE collaboration_group_members SET status = 'removed', left_at = ? WHERE group_id = ? AND user_id = ? AND status = 'active'", [now, id, targetId]);
        for (const task of tasks) {
          if (!delegationTransitionAllowed(task.status, 'withdraw')) continue;
          const metadata = {
            ...parseJsonObject(task.metadata_json),
            withdrawnFromStatus: task.status,
            withdrawnAt: now,
            withdrawnReason: 'member_removed_by_owner',
          };
          run(this.db, `UPDATE agent_delegations SET status='withdrawn',metadata_json=?,completed_at=COALESCE(completed_at,?),updated_at=?
            WHERE id=?`, [JSON.stringify(publicAgentDelegationMetadata(metadata)), now, now, task.id]);
          withdrawnIds.push(task.id);
        }
        run(this.db, `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json, updated_at)
          VALUES (?, ?, ?, ?, 'system', '发起人移除了一位群成员，其未完成任务已撤回。', ?, ?)`, [newId('group_msg'), workspace.id, id, user.id, JSON.stringify({ type: 'member_removed', userId: targetId, withdrawnDelegationIds: withdrawnIds }), now]);
        refreshAutomaticCollaborationGroupTitle(this.db, id, now);
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
    } else if (action === 'add_member') {
      const targetId = String(userId || '').trim();
      const targetAllowed = workspace.workspace_kind === 'organization'
        ? get(this.db, `SELECT 1 FROM account_workspace_memberships WHERE workspace_id=? AND user_id=? AND status='active'`, [workspace.id, targetId])
        : this.friendshipBetween(user.id, targetId);
      if (!targetAllowed) throw new Error('只能邀请当前工作空间中的联系人。');
      const cleanAssignment = assignment && typeof assignment === 'object' ? assignment : {};
      const instruction = String(cleanAssignment.instruction || '').trim().slice(0, 16000);
      if (!instruction) throw new Error('添加成员时必须同时分配具体任务。');
      if (get(this.db, "SELECT 1 FROM collaboration_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'", [id, targetId])) throw new Error('该用户已经在任务群中。');
      const delegationId = newId('agent_delegate');
      const sharedTaskSummary = normalizePublicTaskSummary(parseJsonObject(group.metadata_json).taskSummary);
      const assignmentMetadata = {
        ...(cleanAssignment.metadata || {}),
        ...(sharedTaskSummary ? { taskSummary: sharedTaskSummary } : {}),
        groupId: id,
        source: 'collaboration_group',
        initiatedThroughOwnUBuddy: true,
      };
      this.db.exec('BEGIN');
      try {
        run(this.db, `INSERT INTO collaboration_group_members (group_id, user_id, role, status, joined_at, left_at)
          VALUES (?, ?, 'member', 'active', ?, NULL)
          ON CONFLICT(group_id, user_id) DO UPDATE SET status = 'active', joined_at = excluded.joined_at, left_at = NULL`, [id, targetId, now]);
        run(this.db, `INSERT INTO agent_delegations (
          id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
          title, instruction, status, group_id, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', ?, ?, 'assigned', ?, ?, ?)`, [
          delegationId, workspace.id, user.id, targetId,
          String(cleanAssignment.title || `${group.title} · 新任务`).trim().slice(0, 160),
          instruction, id,
          JSON.stringify(publicAgentDelegationMetadata(assignmentMetadata)), now,
        ]);
        const privateMetadata = privateAgentDelegationMetadata(assignmentMetadata);
        run(this.db, `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, updated_at)
          VALUES (?, ?, ?, ?), (?, ?, '{}', ?)`, [delegationId, targetId, JSON.stringify(privateMetadata), now, delegationId, user.id, now]);
        run(this.db, `INSERT INTO collaboration_group_messages (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, updated_at)
          VALUES (?, ?, ?, ?, 'secretary_agent', 'agent', ?, ?, ?)`, [newId('group_msg'), workspace.id, id, user.id, instruction, JSON.stringify({ type: 'task_assigned', action: 'add_member', userId: targetId, delegationId }), now]);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      refreshAutomaticCollaborationGroupTitle(this.db, id, now);
    } else {
      throw new Error('不支持的任务群操作。');
    }
    run(this.db, 'UPDATE collaboration_groups SET updated_at = ? WHERE id = ?', [now, id]);
    return { ok: true, ...this.collaborationGroup(id, { workspaceId: workspace.id }) };
  },

  importCloudFriendsOverview(overview = {}) {
    const user = this.requireUser();
    const friends = Array.isArray(overview.friends) ? overview.friends : [];
    const incoming = Array.isArray(overview.requests?.incoming) ? overview.requests.incoming : [];
    const outgoing = Array.isArray(overview.requests?.outgoing) ? overview.requests.outgoing : [];
    for (const item of friends) {
      const friend = item.friend || item.user || {};
      const imported = this.importCloudUser(friend);
      if (!imported) continue;
      const [userA, userB] = orderedUserPair(user.id, imported.id);
      run(
        this.db,
        `INSERT INTO friendships (id, user_a_id, user_b_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', ?, ?)
         ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET status = 'accepted', updated_at = excluded.updated_at`,
        [String(item.id || newId('friendship')), userA, userB, item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso()],
      );
      const remarkColumn = userA === user.id ? 'user_a_remark' : 'user_b_remark';
      const contactRemark = String(item.remark || friend.remark || '').trim().slice(0, 40);
      run(this.db, `UPDATE friendships SET ${remarkColumn} = ? WHERE user_a_id = ? AND user_b_id = ?`, [contactRemark, userA, userB]);
      run(this.db, `INSERT INTO social_contact_remarks(owner_user_id,target_user_id,remark,created_at,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(owner_user_id,target_user_id) DO UPDATE SET remark=excluded.remark,updated_at=excluded.updated_at`,
      [user.id, imported.id, contactRemark, item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso()]);
    }
    for (const [direction, requests] of [['incoming', incoming], ['outgoing', outgoing]]) {
      for (const item of requests) {
        const expectedRemoteId = String(direction === 'incoming'
          ? item.requesterId || item.requester_id || ''
          : item.recipientId || item.recipient_id || '').trim();
        const other = this.importCloudUser({ ...(item.user || {}), ...(expectedRemoteId ? { id: expectedRemoteId } : {}) });
        if (!other) continue;
        const requesterId = direction === 'incoming' ? other.id : user.id;
        const recipientId = direction === 'incoming' ? user.id : other.id;
        run(
          this.db,
          `INSERT INTO friend_requests (id, requester_id, recipient_id, status, message, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = 'pending', message = excluded.message, updated_at = excluded.updated_at`,
          [String(item.id), requesterId, recipientId, String(item.message || ''), item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso()],
        );
      }
    }
    const activeRequestIds = new Set([...incoming, ...outgoing].map((item) => String(item.id || '')).filter(Boolean));
    for (const row of all(this.db, "SELECT id FROM friend_requests WHERE status = 'pending' AND (requester_id = ? OR recipient_id = ?)", [user.id, user.id])) {
      if (!activeRequestIds.has(row.id)) run(this.db, "UPDATE friend_requests SET status = 'closed', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    }
    const activeFriendIds = new Set(friends.map((item) => {
      const remoteId = String(item.friend?.id || item.user?.id || '');
      return get(this.db, 'SELECT id FROM auth_users WHERE remote_id = ?', [remoteId])?.id || '';
    }).filter(Boolean));
    for (const row of all(
      this.db,
      `SELECT id, CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS friend_id
       FROM friendships WHERE status = 'accepted' AND (user_a_id = ? OR user_b_id = ?)`,
      [user.id, user.id, user.id],
    )) {
      if (!activeFriendIds.has(row.friend_id)) run(this.db, "UPDATE friendships SET status = 'removed', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    }
    this.importCloudOrganizations(overview.organizations || []);
    return mergeCloudPresence(this.friendsOverview(), overview);
  }
  });
}

function normalizedPlannedRecipientIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
}

export function mergeCloudPresence(localOverview = {}, cloudOverview = {}) {
  const presenceByRemoteUserId = new Map();
  const rememberPresence = (item = {}) => {
    const user = item?.friend || item?.user || item;
    const remoteUserId = String(user?.id || '').trim();
    if (!remoteUserId) return;
    presenceByRemoteUserId.set(remoteUserId, {
      presenceKnown: true,
      online: item?.online === true || user?.online === true,
      lastSeenAt: String(item?.lastSeenAt || item?.last_seen_at || user?.lastSeenAt || user?.last_seen_at || ''),
    });
  };
  for (const item of Array.isArray(cloudOverview?.friends) ? cloudOverview.friends : []) rememberPresence(item);
  for (const organization of Array.isArray(cloudOverview?.organizations) ? cloudOverview.organizations : []) {
    for (const member of Array.isArray(organization?.members) ? organization.members : []) rememberPresence(member);
  }
  const projectPresence = (item = {}) => {
    const user = item?.friend || item?.user || item;
    const remoteUserId = String(user?.remoteId || user?.remote_id || user?.id || '').trim();
    const presence = presenceByRemoteUserId.get(remoteUserId);
    if (!presence) return item;
    if (item?.friend) return { ...item, ...presence, friend: { ...item.friend, ...presence } };
    if (item?.user) return { ...item, ...presence, user: { ...item.user, ...presence } };
    return { ...item, ...presence };
  };
  return {
    ...localOverview,
    friends: (Array.isArray(localOverview?.friends) ? localOverview.friends : []).map(projectPresence),
    organizations: (Array.isArray(localOverview?.organizations) ? localOverview.organizations : []).map((organization) => ({
      ...organization,
      members: (Array.isArray(organization?.members) ? organization.members : []).map(projectPresence),
    })),
  };
}

function syncGroupConversationMessages(db, group = {}) {
  if (!group?.id) return '';
  const conversationId = `group_conversation:${group.id}`;
  run(db, `INSERT INTO conversations(
    id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,status,created_at,updated_at
  ) VALUES(?,?,'group',?,?,?, ?,?,?) ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,status=excluded.status,updated_at=excluded.updated_at`, [
    conversationId, group.account_workspace_id || 'workspace_personal', group.owner_user_id || '', group.title || 'uBuddy 任务群', group.id,
    group.status === 'closed' ? 'archived' : 'active', group.created_at || nowIso(), group.updated_at || nowIso(),
  ]);
  run(db, `INSERT OR IGNORE INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'group_id','group_conversation_binding')`, [group.id, conversationId]);
  const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages(
    id,account_workspace_id,conversation_id,session_id,memory_id,task_workspace_id,sender_user_id,
    source_event_id,role,content,agent_id,department_id,visible,metadata_json,created_at,updated_at
  ) VALUES(?,?,?,'','','',?,?,?,?,?,'collaboration',1,?,?,?)`);
  const insertAttachment = db.prepare(`INSERT OR IGNORE INTO message_attachments(
    id,account_workspace_id,conversation_id,message_id,task_workspace_id,file_id,relation_type,name,
    content_type,size_bytes,sha256,local_path,remote_file_id,metadata_json,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,'attachment',?,?,?,?,?,?,?,?,?)`);
  const rows = db.prepare(`SELECT * FROM collaboration_group_messages WHERE group_id=? ORDER BY created_at,id`).all(group.id);
  for (const row of rows) {
    const role = row.kind === 'system' ? 'system' : row.sender_agent_id ? 'assistant' : 'user';
    insertMessage.run(
      row.id, row.account_workspace_id || group.account_workspace_id || 'workspace_personal', conversationId,
      row.sender_user_id || '', row.source_event_id || '', role, row.content || '', row.sender_agent_id || '',
      row.metadata_json || '{}', row.created_at || '', row.updated_at || row.created_at || '',
    );
    let metadata = {};
    try { metadata = JSON.parse(row.metadata_json || '{}'); } catch { metadata = {}; }
    for (const attachment of Array.isArray(metadata.attachments) ? metadata.attachments : []) {
      const name = String(attachment?.name || attachment?.filename || '').trim();
      const fileId = String(attachment?.fileId || attachment?.file_id || attachment?.id || '').trim();
      if (!name && !fileId) continue;
      const attachmentId = `message_attachment_${crypto.createHash('sha256').update(`${row.id}\n${fileId}\n${name}`).digest('hex').slice(0, 40)}`;
      insertAttachment.run(
        attachmentId, row.account_workspace_id || group.account_workspace_id || 'workspace_personal', conversationId, row.id, '', fileId,
        name, attachment?.contentType || attachment?.content_type || attachment?.type || '',
        Math.max(0, Number(attachment?.sizeBytes || attachment?.size_bytes || attachment?.size || 0) || 0),
        attachment?.sha256 || '', attachment?.path || attachment?.localPath || attachment?.local_path || '',
        attachment?.remoteFileId || attachment?.remote_file_id || '', JSON.stringify(attachment || {}),
        row.created_at || '', row.updated_at || row.created_at || '',
      );
    }
  }
  return conversationId;
}

function collaborationAccountWorkspace(db, userId = '', workspaceId = '') {
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

function localCollaborationWorkspaceId(db, remoteId = '') {
  const workspaceId = String(remoteId || 'workspace_personal').trim() || 'workspace_personal';
  if (workspaceId === 'workspace_personal') return workspaceId;
  const organizationId = workspaceId.startsWith('workspace_org_') ? workspaceId.slice('workspace_org_'.length) : '';
  const organization = organizationId ? get(db, `SELECT id FROM contact_organizations
    WHERE remote_id=? OR id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [organizationId, organizationId, organizationId]) : null;
  return organization?.id ? `workspace_org_${organization.id}` : workspaceId;
}

function recordCollaborationMessageEvidenceOutbox(store,{message,group,metadata={}}={}) {
  if (!message || !group || typeof store.recordEvolutionEvidenceOutbox !== 'function') return null;
  const instance = store.findUserAgentInstance?.({userId:message.sender_user_id,agentFamilyId:'secretary_agent'});
  if (!instance || instance.employmentState !== 'active') return null;
  const content=String(message.content || '').trim();
  if (!content) return null;
  const delegationId=String(metadata.delegationId || metadata.delegation_id || parseJsonObject(message.metadata_json).delegationId || '');
  return store.recordEvolutionEvidenceOutbox({localUserId:message.sender_user_id,userAgentInstanceId:instance.id,
    agentFamilyId:instance.agentFamilyId,sourceKind:'collaboration_message',sourceId:message.id,
    sourceVersionId:message.source_event_id || '',contentHash:crypto.createHash('sha256').update(content).digest('hex'),
    delegationId,confidence:0.8,privacyLevel:'owner_private',createdAt:message.created_at || nowIso(),
    snapshot:{content,groupId:group.id,delegationId,kind:message.kind,senderAgentId:message.sender_agent_id || '',
      sourceEventId:message.source_event_id || '',occurredAt:message.created_at || nowIso()}},{withinTransaction:true});
}
