import crypto from 'node:crypto';

import {
  delegationTransitionAllowed as cloudDelegationTransitionAllowed,
  isDelegationStatus as isCloudDelegationStatus,
  legacyDelegationTransitionAllowed as legacyCloudDelegationTransitionAllowed,
  nextDelegationStatus as nextCloudDelegationStatus,
  normalizeDelegationStatus as normalizeCloudDelegationStatus,
  privateDelegationMetadata as privateCloudDelegationMetadata,
  privateWorkspaceMessageMetadata as privateCloudWorkspaceMessageMetadata,
  publicDelegationMetadata as publicCloudDelegationMetadata,
  publicDelegationSubmissionText as publicCloudDelegationSubmissionText,
} from '../../collaboration/index.js';
import { cloudApiError } from '../../http/index.js';
import { normalizeMentionEntities } from '../../../../shared/contracts/mentions.js';
import { privateTaskSourceMetadata, taskSourceContextMetadata, withoutPrivateTaskSourceMetadata } from '../../../../shared/contracts/taskCard.js';
import { normalizePublicTaskSummary } from '../../../../shared/contracts/taskSummary.js';
import { evolutionEncryptionReady,evolutionKeyringFromEnv } from '../../../../shared/evolution/index.js';
import { createSqliteAuthoritativeEvidence } from '../../evolution/index.js';
import {
  cloudPublicUser,
  cloudFriendRequestPayload,
  cloudFriendshipPayload,
  cloudFriendshipBetween,
  cloudUsersBlocked,
  requireCloudMessagingFriend,
  cloudSocialMessageSelectSql,
  hydratedCloudSocialMessage,
  cloudSocialMessagePayload,
  cloudOrderedUserPair,
  normalizeCloudCursor,
  cloudJsonObject,
  normalizeCloudMessageKind,
} from '../domain/cloudSocialRecords.js';
import {
  requireCloudAccountWorkspace,
  requireCloudWorkspaceMessagingPeer,
} from './cloudSocialMessaging.js';


function listCloudDelegations(db, userId, searchParams) {
  const workspace = requireCloudAccountWorkspace(db, userId, searchParams.get('workspaceId'));
  const direction = ['incoming', 'outgoing'].includes(String(searchParams.get('direction') || '')) ? String(searchParams.get('direction')) : 'all';
  const cursor = normalizeCloudCursor(searchParams.get('cursor'));
  const limit = Math.max(1, Math.min(500, Number(searchParams.get('limit')) || 100));
  const where = ['ad.account_workspace_id = ?', direction === 'incoming' ? 'ad.recipient_user_id = ?' : direction === 'outgoing' ? 'ad.requester_user_id = ?' : '(ad.requester_user_id = ? OR ad.recipient_user_id = ?)'];
  const params = direction === 'all' ? [workspace.id, userId, userId] : [workspace.id, userId];
  if (cursor) {
    where.push('ad.updated_at > ?');
    params.push(cursor);
  }
  params.push(limit);
  const rows = db.prepare(`${cloudDelegationSelectSql()} WHERE ${where.join(' AND ')} ORDER BY ad.updated_at ASC LIMIT ?`).all(...params);
  return { items: rows.map((row) => cloudDelegationPayload(row, userId, cloudDelegationWorkspaceRow(db, row.id, userId))), cursor: rows.at(-1)?.updated_at || cursor || new Date().toISOString() };
}

function createCloudDelegation(db, requesterId, payload = {}) {
  const recipientId = String(payload.recipientId || payload.userId || '').trim();
  const workspace = requireCloudAccountWorkspace(db, requesterId, payload.workspaceId);
  requireCloudWorkspaceMessagingPeer(db, workspace, requesterId, recipientId);
  const instruction = String(payload.instruction || '').trim();
  if (!instruction) throw cloudApiError('delegation_instruction_required', '请输入委托任务内容。', 400);
  const title = String(payload.title || instruction.slice(0, 48) || 'uBuddy 委托').slice(0, 160);
  const clientRequestId = String(payload.clientRequestId || payload.metadata?.dispatchCommandId || '').trim().slice(0, 240);
  if (clientRequestId) {
    const existing = db.prepare(`SELECT * FROM agent_delegations
      WHERE account_workspace_id=? AND requester_user_id=? AND client_request_id=?`).get(workspace.id, requesterId, clientRequestId);
    if (existing) {
      if (existing.recipient_user_id !== recipientId || existing.title !== title || existing.instruction !== instruction.slice(0, 16000)) {
        throw cloudApiError('delegation_idempotency_conflict', '委托创建幂等键已被不同请求占用。', 409);
      }
      return { ok: true, idempotent: true, delegation: hydratedCloudDelegation(db, existing.id, requesterId), message: null };
    }
  }
  const delegationId = `agent_delegate_${crypto.randomUUID()}`;
  const messageId = `social_msg_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const rawMetadata = cloudJsonObject(payload.metadata);
  const incomingMetadata = {
    ...rawMetadata,
    ...taskSourceContextMetadata({ ...rawMetadata, task_workspace_id: delegationId }),
  };
  const publicMetadata = publicCloudDelegationMetadata(incomingMetadata);
  const recipientPrivateMetadata = withoutPrivateTaskSourceMetadata(privateCloudDelegationMetadata(incomingMetadata));
  const requesterPrivateMetadata = privateTaskSourceMetadata(incomingMetadata);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO agent_delegations (
        id, account_workspace_id, requester_user_id, recipient_user_id, client_request_id, sender_agent_id, recipient_agent_id,
        title, instruction, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      delegationId, workspace.id, requesterId, recipientId, clientRequestId,
      String(payload.senderAgentId || 'secretary_agent').slice(0, 80),
      String(payload.recipientAgentId || 'secretary_agent').slice(0, 80),
      title, instruction.slice(0, 16000), JSON.stringify(publicMetadata), now, now,
    );
    if (Object.keys(recipientPrivateMetadata).length || Object.keys(requesterPrivateMetadata).length) {
      db.prepare(
        `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      ).run(
        delegationId, recipientId, JSON.stringify(recipientPrivateMetadata), now, now,
        delegationId, requesterId, JSON.stringify(requesterPrivateMetadata), now, now,
      );
    }
    db.prepare(
      `INSERT INTO social_messages (
        id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        kind, title, content, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', 'agent', ?, ?, ?, ?, ?)`,
    ).run(
      messageId, workspace.id, requesterId, recipientId, `uBuddy 委托：${title}`, instruction.slice(0, 8000),
      JSON.stringify({ ...publicMetadata, type: 'agent_delegation', action: 'assigned', delegationId, status: 'assigned' }), now, now,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, delegation: hydratedCloudDelegation(db, delegationId, requesterId), message: hydratedCloudSocialMessage(db, messageId) };
}

function updateCloudDelegation(db, currentUserId, delegationId, payload = {}) {
  const workspace = requireCloudAccountWorkspace(db, currentUserId, payload.workspaceId);
  const current = db.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(String(delegationId || ''));
  if (!current || current.account_workspace_id !== workspace.id || ![current.requester_user_id, current.recipient_user_id].includes(currentUserId)) {
    throw cloudApiError('delegation_not_found', '委托任务不存在。', 404);
  }
  if (current.group_id) requireCloudActiveTaskMembership(db, current.group_id, currentUserId);
  const hasExplicitStatus = Object.prototype.hasOwnProperty.call(payload, 'status');
  const rawStatus = hasExplicitStatus ? String(payload.status || '').trim().toLowerCase() : current.status;
  if (!isCloudDelegationStatus(rawStatus)) throw cloudApiError('delegation_status_invalid', '不支持的任务状态。', 400);
  const status = rawStatus;
  const statusChanged = status !== current.status;
  if (statusChanged && currentUserId !== current.recipient_user_id) {
    throw cloudApiError('delegation_update_forbidden', '发起人不能通过通用更新接口修改任务状态。', 403);
  }
  if (statusChanged && !legacyCloudDelegationTransitionAllowed(current.status, status)) {
    throw cloudApiError('delegation_transition_invalid', `不能从 ${current.status} 更新为 ${status}。`, 409);
  }
  const incomingMetadata = cloudJsonObject(payload.metadata);
  const publicMetadata = publicCloudDelegationMetadata(incomingMetadata);
  const privateMetadata = privateCloudDelegationMetadata(incomingMetadata);
  if (currentUserId === current.requester_user_id && (Object.keys(publicMetadata).length || Object.prototype.hasOwnProperty.call(payload, 'taskRunId') || Object.prototype.hasOwnProperty.call(payload, 'lastError'))) {
    throw cloudApiError('delegation_update_forbidden', '发起人只能维护自己的私有 uBuddy 工作区。', 403);
  }
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = db.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(current.id);
    if (!locked) throw cloudApiError('delegation_not_found', '委托任务不存在。', 404);
    const persistedStatus = hasExplicitStatus ? status : locked.status;
    if (persistedStatus !== locked.status && currentUserId !== locked.recipient_user_id) {
      throw cloudApiError('delegation_update_forbidden', '发起人不能通过通用更新接口修改任务状态。', 403);
    }
    if (persistedStatus !== locked.status && !legacyCloudDelegationTransitionAllowed(locked.status, persistedStatus)) {
      throw cloudApiError('delegation_transition_invalid', `不能从 ${locked.status} 更新为 ${persistedStatus}。`, 409);
    }
    const existingWorkspace = db.prepare('SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?').get(locked.id, currentUserId);
    const workspaceSessionId = Object.prototype.hasOwnProperty.call(payload, 'sessionId')
      ? String(payload.sessionId || '').slice(0, 200)
      : existingWorkspace?.session_id || '';
    const workspaceMetadata = { ...cloudJsonObject(existingWorkspace?.metadata_json), ...privateMetadata };
    if (Object.prototype.hasOwnProperty.call(payload, 'sessionId') || Object.keys(privateMetadata).length) {
      db.prepare(
        `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(delegation_id, user_id) DO UPDATE SET
           session_id = excluded.session_id, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at`,
      ).run(locked.id, currentUserId, workspaceSessionId, JSON.stringify(workspaceMetadata), now, now);
    }
    if (currentUserId === locked.recipient_user_id) {
      const metadata = { ...cloudJsonObject(locked.metadata_json), ...publicMetadata };
      const startedAt = ['accepted', 'running', 'working'].includes(persistedStatus) ? (locked.started_at || now) : locked.started_at;
      const completedAt = ['completed', 'failed', 'rejected', 'declined'].includes(persistedStatus) ? now : locked.completed_at;
      db.prepare(
        `UPDATE agent_delegations SET status = ?, task_run_id = ?, last_error = ?,
           metadata_json = ?, updated_at = ?, started_at = ?, completed_at = ? WHERE id = ?`,
      ).run(
        persistedStatus,
        Object.prototype.hasOwnProperty.call(payload, 'taskRunId') ? String(payload.taskRunId || '').slice(0, 200) : locked.task_run_id,
        Object.prototype.hasOwnProperty.call(payload, 'lastError') ? String(payload.lastError || '').slice(0, 2000) : locked.last_error,
        JSON.stringify(metadata), now, startedAt || null, completedAt || null, locked.id,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  let message = null;
  if (statusChanged && ['completed', 'failed', 'rejected'].includes(status)) {
    const messageId = `social_msg_${crypto.randomUUID()}`;
    const content = String(payload.result || payload.lastError || `${current.title}：${status}`).slice(0, 8000);
    db.prepare(
      `INSERT INTO social_messages (
        id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
        kind, title, content, metadata_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', 'agent', ?, ?, ?, ?, ?)`,
    ).run(
      messageId, workspace.id, current.recipient_user_id, current.requester_user_id,
      `uBuddy 任务${status === 'completed' ? '已完成' : '状态更新'}：${current.title}`, content,
      JSON.stringify({ ...publicMetadata, type: 'agent_delegation', action: status, delegationId: current.id, status }), now, now,
    );
    message = hydratedCloudSocialMessage(db, messageId);
  }
  return { ok: true, delegation: hydratedCloudDelegation(db, current.id, currentUserId), message };
}

function cloudDelegationWorkspace(db, delegationId, userId, workspaceId = '') {
  const workspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  const delegation = requireCloudDelegationParticipant(db, delegationId, userId, { allowClosed: true, accountWorkspaceId: workspace.id });
  const workspaceRow = db.prepare('SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?').get(delegation.id, userId);
  const messages = db.prepare(
    `SELECT * FROM agent_delegation_workspace_messages
     WHERE delegation_id = ? AND user_id = ? ORDER BY created_at ASC, id ASC LIMIT 1000`,
  ).all(delegation.id, userId);
  return {
    workspace: workspaceRow ? cloudDelegationWorkspacePayload(workspaceRow) : { delegationId: delegation.id, userId, sessionId: '', metadata: {} },
    items: messages.map(cloudDelegationWorkspaceMessagePayload),
  };
}

function createCloudDelegationWorkspaceMessage(db, delegationId, userId, payload = {}) {
  const workspace = requireCloudAccountWorkspace(db, userId, payload.workspaceId);
  const delegation = requireCloudDelegationParticipant(db, delegationId, userId, { allowClosed: true, accountWorkspaceId: workspace.id });
  if (['closed', 'withdrawn', 'declined', 'rejected'].includes(delegation.status)) {
    throw cloudApiError('delegation_workspace_readonly', '任务已结束，私有工作区现在为只读。', 409);
  }
  const content = String(payload.content || '').trim();
  if (!content) throw cloudApiError('message_required', '请输入消息内容。', 400);
  const role = ['user', 'assistant', 'system'].includes(String(payload.role || '')) ? String(payload.role) : 'user';
  const messageId = String(payload.clientMessageId || '').trim().slice(0, 200) || `workspace_msg_${crypto.randomUUID()}`;
  const metadata = privateCloudWorkspaceMessageMetadata(cloudJsonObject(payload.metadata));
  const sourceEventId = String(payload.sourceEventId || metadata.sourceEventId || '').trim().slice(0, 240);
  const sourceGroupMessageId = String(payload.sourceGroupMessageId || metadata.sourceGroupMessageId || '').trim().slice(0, 240);
  const now = new Date().toISOString();
  const conflictingId = db.prepare('SELECT delegation_id, user_id FROM agent_delegation_workspace_messages WHERE id = ?').get(messageId);
  const persistedMessageId = conflictingId && (conflictingId.delegation_id !== delegation.id || conflictingId.user_id !== userId)
    ? `${messageId.slice(0, 140)}_${crypto.createHash('sha256').update(`${delegation.id}:${userId}:${messageId}`).digest('hex').slice(0, 24)}`
    : messageId;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, session_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, '{}', ?, ?)
       ON CONFLICT(delegation_id, user_id) DO UPDATE SET
         session_id = CASE WHEN excluded.session_id <> '' THEN excluded.session_id ELSE agent_delegation_workspaces.session_id END,
         updated_at = excluded.updated_at`,
    ).run(delegation.id, userId, String(payload.sessionId || '').slice(0, 200), now, now);
    db.prepare(
      `INSERT OR IGNORE INTO agent_delegation_workspace_messages
         (id, delegation_id, user_id, role, content, metadata_json, source_event_id, source_group_message_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(persistedMessageId, delegation.id, userId, role, content.slice(0, 32000), JSON.stringify(metadata), sourceEventId, sourceGroupMessageId, now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const row = db.prepare(`SELECT * FROM agent_delegation_workspace_messages
    WHERE delegation_id = ? AND user_id = ? AND (id = ? OR (? <> '' AND source_event_id = ?) OR (? <> '' AND source_group_message_id = ?))
    ORDER BY created_at ASC LIMIT 1`).get(delegation.id, userId, persistedMessageId, sourceEventId, sourceEventId, sourceGroupMessageId, sourceGroupMessageId);
  return { ok: true, message: cloudDelegationWorkspaceMessagePayload(row) };
}

function cloudCollaborationOverview(db, userId, workspaceId = '') {
  const workspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  const groupRows = db.prepare(
    `SELECT g.*, m.status AS membership_status, m.last_read_at, m.left_at,
            (SELECT COUNT(*) FROM collaboration_group_members cm WHERE cm.group_id = g.id AND cm.status = 'active') AS member_count
     FROM collaboration_groups g
     JOIN collaboration_group_members m ON m.group_id = g.id AND m.user_id = ?
     WHERE g.account_workspace_id = ? AND (m.status = 'active' OR g.status = 'closed')
     ORDER BY g.updated_at DESC`,
  ).all(userId, workspace.id);
  const groups = groupRows.map((row) => {
    const cutoff = row.membership_status === 'removed' ? row.left_at || '' : '';
    const unread = db.prepare(
      `SELECT COUNT(*) AS count FROM collaboration_group_messages
       WHERE group_id = ? AND sender_user_id <> ? AND created_at > COALESCE(?, '')
         AND (? = '' OR created_at <= ?)`,
    ).get(row.id, userId, row.last_read_at || '', cutoff, cutoff);
    const lastMessage = db.prepare(
      `SELECT content FROM collaboration_group_messages
       WHERE group_id = ? AND (? = '' OR created_at <= ?)
       ORDER BY created_at DESC LIMIT 1`,
    ).get(row.id, cutoff, cutoff)?.content || '';
    return cloudCollaborationGroupPayload({ ...row, unread_count: unread?.count || 0, last_message: lastMessage });
  });
  const taskRows = db.prepare(
    `${cloudDelegationSelectSql()} WHERE ad.account_workspace_id = ? AND (ad.requester_user_id = ? OR ad.recipient_user_id = ?) ORDER BY ad.updated_at DESC LIMIT 200`,
  ).all(workspace.id, userId, userId);
  return { groups, tasks: taskRows.map((row) => cloudDelegationPayload(row, userId, cloudDelegationWorkspaceRow(db, row.id, userId))) };
}

function cloudCollaborationGroupDetail(db, groupId, userId, { markRead = false, workspaceId = '' } = {}) {
  const workspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  const id = String(groupId || '').trim();
  const membership = db.prepare('SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ?').get(id, userId);
  if (!membership) throw cloudApiError('collaboration_group_not_found', '任务群不存在或你不在群内。', 404);
  const group = db.prepare('SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id = ?').get(id, workspace.id);
  if (!group) throw cloudApiError('collaboration_group_not_found', '任务群不存在。', 404);
  const cutoff = membership.status === 'removed' ? membership.left_at || '' : '';
  if (markRead && membership.status === 'active') {
    db.prepare('UPDATE collaboration_group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?')
      .run(new Date().toISOString(), id, userId);
  }
  const members = db.prepare(
    `SELECT m.*, u.email, u.display_name, u.username, u.avatar_url, u.role AS user_role, u.email_verified
     FROM collaboration_group_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? AND (? = '' OR m.joined_at <= ?)
     ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at`,
  ).all(id, cutoff, cutoff);
  const messages = db.prepare(
    `SELECT gm.*, u.email AS sender_email, u.display_name AS sender_display_name,
            u.username AS sender_username, u.avatar_url AS sender_avatar_url,
            u.role AS sender_role, u.email_verified AS sender_email_verified
     FROM collaboration_group_messages gm
     JOIN users u ON u.id = gm.sender_user_id
     WHERE gm.group_id = ? AND (? = '' OR gm.created_at <= ?)
     ORDER BY gm.created_at ASC`,
  ).all(id, cutoff, cutoff);
  const taskRows = db.prepare(`${cloudDelegationSelectSql()} WHERE ad.group_id = ? ORDER BY ad.created_at ASC`).all(id);
  const memberCount = db.prepare("SELECT COUNT(*) AS count FROM collaboration_group_members WHERE group_id = ? AND status = 'active'").get(id)?.count || 0;
  const lastMessage = db.prepare('SELECT content FROM collaboration_group_messages WHERE group_id = ? ORDER BY created_at DESC LIMIT 1').get(id)?.content || '';
  const groupWorkspace = ensureCloudCollaborationGroupWorkspace(db, id, group.status || 'active');
  return {
    group: cloudCollaborationGroupPayload({ ...group, member_count: memberCount, last_message: lastMessage }),
    workspace: cloudCollaborationGroupWorkspacePayload(groupWorkspace, { readOnly: group.status === 'closed' || membership.status !== 'active' }),
    members: members.map(cloudCollaborationMemberPayload),
    messages: messages.map(cloudCollaborationMessagePayload),
    tasks: taskRows.map((row) => cloudDelegationPayload(row, userId, cloudDelegationWorkspaceRow(db, row.id, userId))),
  };
}

function createCloudCollaborationGroup(db, ownerId, payload = {}) {
  const workspace = requireCloudAccountWorkspace(db, ownerId, payload.workspaceId);
  const clientRequestId = String(payload.clientRequestId || '').trim().slice(0, 200) || `dispatch_${crypto.randomUUID()}`;
  const storedRequestId = workspace.id === 'workspace_personal' ? clientRequestId : `${workspace.id}:${clientRequestId}`.slice(0, 500);
  const existing = db.prepare(`SELECT id FROM collaboration_groups
    WHERE account_workspace_id=? AND owner_user_id=? AND client_request_id IN (?,?)
    ORDER BY CASE WHEN client_request_id=? THEN 0 ELSE 1 END LIMIT 1`).get(workspace.id, ownerId, storedRequestId, clientRequestId, storedRequestId);
  if (existing) return { ok: true, ...cloudCollaborationGroupDetail(db, existing.id, ownerId, { workspaceId: workspace.id }), idempotent: true };
  const assignments = (Array.isArray(payload.assignments) ? payload.assignments : [])
    .map((item) => ({
      recipientId: String(item?.recipientId || item?.userId || '').trim(),
      title: String(item?.title || payload.title || 'uBuddy 委托任务').trim().slice(0, 160),
      instruction: String(item?.instruction || '').trim().slice(0, 16000),
      metadata: cloudJsonObject(item?.metadata),
    }))
    .filter((item) => item.recipientId && item.recipientId !== ownerId && item.instruction);
  if (new Set(assignments.map((item) => item.recipientId)).size !== assignments.length) {
    throw cloudApiError('collaboration_assignment_duplicate_recipient', '同一参与人只能对应一项远程分工。', 400);
  }
  const groupMetadata = cloudJsonObject(payload.metadata);
  const plannedRecipientIds = [...new Set((Array.isArray(payload.plannedRecipientIds)
    ? payload.plannedRecipientIds
    : Array.isArray(groupMetadata.plannedRecipientIds) ? groupMetadata.plannedRecipientIds : [])
    .map((item) => String(item || '').trim()).filter((item) => item && item !== ownerId))];
  if (!assignments.length && !plannedRecipientIds.length) {
    throw cloudApiError('collaboration_assignments_required', '请至少选择一位好友并填写任务内容。', 400);
  }
  const assignmentRecipientIds = [...new Set(assignments.map((item) => item.recipientId))];
  const allRecipientIds = [...new Set([...assignmentRecipientIds, ...plannedRecipientIds])];
  for (const recipientId of allRecipientIds) {
    requireCloudWorkspaceMessagingPeer(db, workspace, ownerId, recipientId);
  }
  const groupId = `collab_group_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  groupMetadata.plannedRecipientIds = allRecipientIds;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO collaboration_groups (id, account_workspace_id, owner_user_id, title, client_request_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(groupId, workspace.id, ownerId, String(payload.title || 'uBuddy 任务群').trim().slice(0, 80) || 'uBuddy 任务群', storedRequestId, JSON.stringify(groupMetadata), now, now);
    db.prepare(`INSERT INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,created_at,updated_at)
      VALUES(?,?,0,'active',?,?)`).run(groupId, `workspace_${groupId}`, now, now);
    db.prepare(
      `INSERT INTO collaboration_group_members (group_id, user_id, role, status, joined_at, last_read_at)
       VALUES (?, ?, 'owner', 'active', ?, ?)`,
    ).run(groupId, ownerId, now, now);
    for (const recipientId of assignmentRecipientIds) {
      db.prepare(
        `INSERT INTO collaboration_group_members (group_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'member', 'active', ?)`,
      ).run(groupId, recipientId, now);
    }
    const createdMessage = assignments.length
      ? 'uBuddy 已创建任务群并发布任务。'
      : 'uBuddy 已创建任务群，正在等待成员上线后发布任务。';
    db.prepare(
      `INSERT INTO collaboration_group_messages
         (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'secretary_agent', 'system', ?, ?, ?, ?)`,
    ).run(`group_msg_${crypto.randomUUID()}`, workspace.id, groupId, ownerId, createdMessage, JSON.stringify({ type: 'group_created' }), now, now);
    for (const assignment of assignments) {
      const delegationId = `agent_delegate_${crypto.randomUUID()}`;
      const metadata = {
        ...groupMetadata,
        ...assignment.metadata,
        ...taskSourceContextMetadata({
          ...groupMetadata,
          ...assignment.metadata,
          source_group_id: groupMetadata.source_group_id || groupMetadata.sourceGroupId || '',
          task_workspace_id: delegationId,
        }),
        groupId,
        source: 'collaboration_group',
        initiatedThroughOwnUBuddy: true,
      };
      const publicMetadata = publicCloudDelegationMetadata(metadata);
      const recipientPrivateMetadata = withoutPrivateTaskSourceMetadata(privateCloudDelegationMetadata(metadata));
      const requesterPrivateMetadata = privateTaskSourceMetadata(metadata);
      db.prepare(
        `INSERT INTO agent_delegations (
           id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
           title, instruction, status, group_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', ?, ?, 'assigned', ?, ?, ?, ?)`,
      ).run(delegationId, workspace.id, ownerId, assignment.recipientId, assignment.title, assignment.instruction, groupId, JSON.stringify(publicMetadata), now, now);
      db.prepare(
        `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      ).run(delegationId, assignment.recipientId, JSON.stringify(recipientPrivateMetadata), now, now, delegationId, ownerId, JSON.stringify(requesterPrivateMetadata), now, now);
      const assignmentMessageId = `group_msg_${crypto.randomUUID()}`;
      db.prepare(
        `INSERT INTO collaboration_group_messages
           (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'secretary_agent', 'agent', ?, ?, ?, ?)`,
      ).run(assignmentMessageId, workspace.id, groupId, ownerId, assignment.instruction, JSON.stringify({ type: 'task_assigned', delegationId, recipientUserId: assignment.recipientId }), now, now);
      insertCloudPrivateTaskIngress(db, { delegationId, userId: assignment.recipientId, content: assignment.instruction, type: 'task_assigned', sourceEventId: `task-assigned:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: ownerId, now });
      insertCloudPrivateTaskIngress(db, { delegationId, userId: ownerId, content: assignment.instruction, type: 'task_published', sourceEventId: `task-published:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: ownerId, now });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, ...cloudCollaborationGroupDetail(db, groupId, ownerId, { workspaceId: workspace.id }) };
}

function createCloudCollaborationMessage(db, groupId, userId, payload = {}) {
  const id = String(groupId || '').trim();
  const workspace = requireCloudAccountWorkspace(db, userId, payload.workspaceId);
  const membership = db.prepare('SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ?').get(id, userId);
  const group = db.prepare('SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id = ?').get(id, workspace.id);
  if (!membership || !group) throw cloudApiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  if (group.status === 'closed') throw cloudApiError('collaboration_group_closed', '任务群已解散，不能继续发送消息。', 409);
  if (membership.status !== 'active') throw cloudApiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  const messageMetadata = cloudJsonObject(payload.metadata);
  const routingConfirmationFor = String(messageMetadata.routingConfirmationFor || '').trim();
  if (routingConfirmationFor) {
    const original = db.prepare('SELECT * FROM collaboration_group_messages WHERE id = ? AND group_id = ? AND sender_user_id = ?').get(routingConfirmationFor, id, userId);
    if (!original) throw cloudApiError('routing_source_not_found', '原群消息不存在或不能由当前用户确认路由。', 404);
    const routing = routeCloudGroupMessageToPrivateThreads(db, {
      groupId: id,
      groupMessageId: original.id,
      senderUserId: original.sender_user_id,
      content: original.content,
      metadata: { ...cloudJsonObject(original.metadata_json), delegationId: messageMetadata.delegationId || messageMetadata.taskId },
    });
    return { ok: true, routing, needsRoutingConfirmation: routing.needsRoutingConfirmation, ...cloudCollaborationGroupDetail(db, id, userId, { markRead: true, workspaceId: workspace.id }) };
  }
  const content = String(payload.content || '').trim();
  if (!content) throw cloudApiError('message_required', '请输入消息内容。', 400);
  const now = new Date().toISOString();
  const senderAgentId = String(payload.senderAgentId || '') === 'secretary_agent' ? 'secretary_agent' : '';
  const messageId = String(payload.clientMessageId || '').trim().slice(0, 200) || `group_msg_${crypto.randomUUID()}`;
  const sourceEventId = String(payload.sourceEventId || messageMetadata.sourceEventId || messageMetadata.source_event_id || '').trim().slice(0, 240);
  let routing = emptyCloudTaskRouting();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT OR IGNORE INTO collaboration_group_messages
         (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(messageId, workspace.id, id, userId, senderAgentId, normalizeCloudMessageKind(payload.kind || (senderAgentId ? 'agent' : 'friend')), content.slice(0, 8000), JSON.stringify(messageMetadata), sourceEventId, now, now);
    const persistedMessage=db.prepare('SELECT * FROM collaboration_group_messages WHERE id=?').get(messageId);
    if(persistedMessage)recordCloudCollaborationEvidence(db,{ownerUserId:userId,sourceKind:'collaboration_message',sourceId:persistedMessage.id,
      sourceVersionId:persistedMessage.source_event_id || '',content:persistedMessage.content,
      delegationId:String(cloudJsonObject(persistedMessage.metadata_json).delegationId || ''),occurredAt:persistedMessage.created_at || now,
      metadata:{groupId:id,senderAgentId:persistedMessage.sender_agent_id || '',kind:persistedMessage.kind}});
    if (!senderAgentId) routing = routeCloudGroupMessageToPrivateThreads(db, { groupId: id, groupMessageId: messageId, senderUserId: userId, content, metadata: messageMetadata, now });
    db.prepare('UPDATE collaboration_groups SET updated_at = ? WHERE id = ?').run(now, id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, routing, needsRoutingConfirmation: routing.needsRoutingConfirmation, ...cloudCollaborationGroupDetail(db, id, userId, { markRead: true, workspaceId: workspace.id }) };
}

function updateCloudCollaborationGroup(db, groupId, ownerId, payload = {}) {
  const id = String(groupId || '').trim();
  const workspace = requireCloudAccountWorkspace(db, ownerId, payload.workspaceId);
  const group = db.prepare('SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id = ?').get(id, workspace.id);
  if (!group || group.owner_user_id !== ownerId) throw cloudApiError('collaboration_owner_required', '只有任务群发起人可以执行此操作。', 403);
  const action = String(payload.action || '').trim().toLowerCase();
  if (group.status === 'closed') {
    if (action === 'close') return { ok: true, ...cloudCollaborationGroupDetail(db, id, ownerId, { workspaceId: workspace.id }) };
    throw cloudApiError('collaboration_group_closed', '任务群已解散，不能继续修改。', 409);
  }
  const now = new Date().toISOString();
  if (action === 'close') {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE collaboration_groups SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
      db.prepare("UPDATE collaboration_group_workspaces SET status = 'closed', updated_at = ? WHERE group_id = ?").run(now, id);
      db.prepare("UPDATE agent_delegations SET status = 'closed', completed_at = ?, updated_at = ? WHERE group_id = ?").run(now, now, id);
      db.prepare("UPDATE collaboration_group_members SET status = 'closed', left_at = COALESCE(left_at, ?) WHERE group_id = ? AND status = 'active'").run(now, id);
      db.prepare(
        `INSERT INTO collaboration_group_messages
           (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)`,
      ).run(`group_msg_${crypto.randomUUID()}`, workspace.id, id, ownerId, '发起人已解散任务群，协作正式结束。', JSON.stringify({ type: 'group_closed' }), now, now);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else if (action === 'rename') {
    const title = String(payload.title || group.title).trim().slice(0, 80) || group.title;
    db.prepare('UPDATE collaboration_groups SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
  } else if (action === 'add_member') {
    const targetId = String(payload.userId || '').trim();
    requireCloudWorkspaceMessagingPeer(db, workspace, ownerId, targetId);
    const assignment = cloudJsonObject(payload.assignment);
    const instruction = String(assignment.instruction || '').trim().slice(0, 16000);
    if (!instruction) throw cloudApiError('collaboration_assignment_required', '添加成员时必须同时分配具体任务。', 400);
    if (db.prepare("SELECT 1 FROM collaboration_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'").get(id, targetId)) {
      throw cloudApiError('collaboration_member_exists', '该用户已经在任务群中。', 409);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const lockedGroup = db.prepare('SELECT * FROM collaboration_groups WHERE id = ?').get(id);
      if (lockedGroup?.status === 'closed') throw cloudApiError('collaboration_group_closed', '任务群已解散，不能继续修改。', 409);
      db.prepare(
        `INSERT INTO collaboration_group_members (group_id, user_id, role, status, joined_at, left_at)
         VALUES (?, ?, 'member', 'active', ?, NULL)
         ON CONFLICT(group_id, user_id) DO UPDATE SET status = 'active', joined_at = excluded.joined_at, left_at = NULL`,
      ).run(id, targetId, now);
      const delegationId = `agent_delegate_${crypto.randomUUID()}`;
      const sharedTaskSummary = normalizePublicTaskSummary(cloudJsonObject(lockedGroup.metadata_json).taskSummary);
      const assignmentMetadata = {
        ...cloudJsonObject(assignment.metadata),
        ...(sharedTaskSummary ? { taskSummary: sharedTaskSummary } : {}),
        groupId: id,
        source: 'collaboration_group',
        initiatedThroughOwnUBuddy: true,
      };
      const publicMetadata = publicCloudDelegationMetadata(assignmentMetadata);
      const recipientPrivateMetadata = privateCloudDelegationMetadata(assignmentMetadata);
      db.prepare(
        `INSERT INTO agent_delegations (
           id, account_workspace_id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
           title, instruction, status, group_id, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', ?, ?, 'assigned', ?, ?, ?, ?)`,
      ).run(delegationId, workspace.id, ownerId, targetId, String(assignment.title || `${group.title} · 新任务`).trim().slice(0, 160), instruction, id, JSON.stringify(publicMetadata), now, now);
      db.prepare(
        `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?), (?, ?, '{}', ?, ?)`,
      ).run(delegationId, targetId, JSON.stringify(recipientPrivateMetadata), now, now, delegationId, ownerId, now, now);
      const assignmentMessageId = `group_msg_${crypto.randomUUID()}`;
      db.prepare(
        `INSERT INTO collaboration_group_messages
           (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'secretary_agent', 'agent', ?, ?, ?, ?)`,
      ).run(assignmentMessageId, workspace.id, id, ownerId, instruction, JSON.stringify({ type: 'task_assigned', action: 'add_member', userId: targetId, delegationId }), now, now);
      insertCloudPrivateTaskIngress(db, { delegationId, userId: targetId, content: instruction, type: 'task_assigned', sourceEventId: `task-assigned:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: ownerId, now });
      insertCloudPrivateTaskIngress(db, { delegationId, userId: ownerId, content: instruction, type: 'task_published', sourceEventId: `task-published:${delegationId}`, sourceGroupMessageId: assignmentMessageId, fromUserId: ownerId, now });
      db.prepare('UPDATE collaboration_groups SET updated_at = ? WHERE id = ?').run(now, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else if (action === 'remove_member') {
    const targetId = String(payload.userId || '').trim();
    if (!targetId || targetId === ownerId) throw cloudApiError('collaboration_remove_invalid', '不能移除任务群发起人。', 400);
    const target = db.prepare("SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ? AND status = 'active'").get(id, targetId);
    if (!target) throw cloudApiError('collaboration_member_not_found', '该用户不是当前任务群成员。', 404);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE collaboration_group_members SET status = 'removed', left_at = ? WHERE group_id = ? AND user_id = ?").run(now, id, targetId);
      db.prepare("UPDATE agent_delegations SET status = 'withdrawn', updated_at = ? WHERE group_id = ? AND recipient_user_id = ? AND status NOT IN ('closed','declined','withdrawn')").run(now, id, targetId);
      insertCloudCollaborationSystemMessage(db, id, ownerId, '发起人移除了一位群成员，其未完成任务已撤回。', { type: 'member_removed', userId: targetId }, now);
      db.prepare('UPDATE collaboration_groups SET updated_at = ? WHERE id = ?').run(now, id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else {
    throw cloudApiError('collaboration_action_invalid', '不支持的任务群操作。', 400);
  }
  return { ok: true, ...cloudCollaborationGroupDetail(db, id, ownerId, { workspaceId: workspace.id }) };
}

function applyCloudCollaborationTaskAction(db, delegationId, userId, payload = {}) {
  const id = String(delegationId || '').trim();
  const workspace = requireCloudAccountWorkspace(db, userId, payload.workspaceId);
  const delegation = db.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(id);
  if (!delegation || delegation.account_workspace_id !== workspace.id || ![delegation.requester_user_id, delegation.recipient_user_id].includes(userId)) {
    throw cloudApiError('delegation_not_found', '任务不存在。', 404);
  }
  const group = delegation.group_id ? db.prepare('SELECT * FROM collaboration_groups WHERE id = ?').get(delegation.group_id) : null;
  if (group?.status === 'closed') throw cloudApiError('collaboration_group_closed', '任务群已结束。', 409);
  if (delegation.group_id) requireCloudActiveTaskMembership(db, delegation.group_id, userId);
  const action = String(payload.action || '').trim().toLowerCase();
  const recipientActions = ['working', 'submit', 'decline', 'blocked'];
  const requesterActions = ['accept_result', 'request_revision', 'publish', 'update_requirements', 'withdraw'];
  if (recipientActions.includes(action) && userId !== delegation.recipient_user_id) throw cloudApiError('delegation_update_forbidden', '只有接收人可以执行此操作。', 403);
  if (requesterActions.includes(action) && userId !== delegation.requester_user_id) throw cloudApiError('delegation_update_forbidden', '只有发起人可以执行此操作。', 403);
  if (action === 'accept_result' && delegation.status === 'result_accepted') {
    return { ok: true, idempotent: true, delegation: hydratedCloudDelegation(db, id, userId), ...(delegation.group_id ? cloudCollaborationGroupDetail(db, delegation.group_id, userId, { workspaceId: workspace.id }) : {}) };
  }
  if (action === 'withdraw' && delegation.status === 'withdrawn') {
    return { ok: true, idempotent: true, delegation: hydratedCloudDelegation(db, id, userId), ...(delegation.group_id ? cloudCollaborationGroupDetail(db, delegation.group_id, userId, { workspaceId: workspace.id }) : {}) };
  }
  const expectedStatus = String(payload.expectedStatus || '').trim();
  if (expectedStatus && expectedStatus !== delegation.status) {
    throw cloudApiError('delegation_status_conflict', '任务状态已经更新，请刷新后重试。', 409, { expectedStatus, actualStatus: delegation.status });
  }
  const rawActionMetadata = cloudJsonObject(payload.metadata);
  const sourceWorkspaceMessageId = String(rawActionMetadata.sourceWorkspaceMessageId || '').trim();
  if (sourceWorkspaceMessageId && ['submit', 'publish', 'update_requirements'].includes(action)) {
    const duplicate = db.prepare(`SELECT id FROM agent_delegation_revisions
      WHERE delegation_id = ? AND action = ? AND json_extract(metadata_json, '$.sourceWorkspaceMessageId') = ? LIMIT 1`)
      .get(id, action, sourceWorkspaceMessageId);
    if (duplicate) return { ok: true, idempotent: true, delegation: hydratedCloudDelegation(db, id, userId), ...(delegation.group_id ? cloudCollaborationGroupDetail(db, delegation.group_id, userId, { workspaceId: workspace.id }) : {}) };
  }
  const status = nextCloudDelegationStatus(delegation.status, action);
  if (!status) throw cloudApiError('delegation_action_invalid', '不支持的任务操作。', 400);
  if (!cloudDelegationTransitionAllowed(delegation.status, action)) {
    throw cloudApiError('delegation_transition_invalid', `当前状态 ${delegation.status} 不能执行 ${action}。`, 409);
  }
  const rawContent = String(payload.content || '').trim();
  const content = (['submit', 'publish', 'update_requirements'].includes(action) ? publicCloudDelegationSubmissionText(rawContent) : rawContent).slice(0, 16000);
  if (['submit', 'request_revision', 'publish', 'update_requirements'].includes(action) && !content) throw cloudApiError('delegation_content_required', '请填写需要同步的任务内容。', 400);
  const now = new Date().toISOString();
  const actionMetadata = ['submit', 'publish', 'update_requirements'].includes(action)
    ? {
        ...rawActionMetadata,
        attachments: canonicalCloudCollaborationTaskAttachments(db, delegation, rawActionMetadata.attachments),
      }
    : rawActionMetadata;
  const currentMetadata = cloudJsonObject(delegation.metadata_json);
  const incomingActionMetadata = publicCloudTaskActionMetadata(actionMetadata, action);
  const metadata = {
    ...currentMetadata,
    ...incomingActionMetadata,
    ...(action === 'submit' ? { latestResult: content, resultSubmittedAt: now } : {}),
    ...(action === 'request_revision' ? { latestRevisionRequest: content, revisionRequestedAt: now } : {}),
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = db.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(id);
    if (!locked || locked.status !== delegation.status) {
      throw cloudApiError('delegation_status_conflict', '任务状态已经更新，请刷新后重试。', 409);
    }
    db.prepare(
      `UPDATE agent_delegations SET status = ?, instruction = CASE WHEN ? IN ('publish','update_requirements') THEN ? ELSE instruction END,
         metadata_json = ?, updated_at = ?, completed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END WHERE id = ?`,
    ).run(status, action, content.slice(0, 16000), JSON.stringify(action === 'submit' ? publicCloudTaskActionMetadata(metadata, action) : publicCloudDelegationMetadata(metadata)), now, status, now, id);
    const revisionNo = Number(db.prepare('SELECT COALESCE(MAX(revision_no), 0) AS revision_no FROM agent_delegation_revisions WHERE delegation_id = ?').get(id)?.revision_no || 0) + 1;
    const revisionId=`task_revision_${crypto.randomUUID()}`;
    db.prepare(
      `INSERT INTO agent_delegation_revisions
         (id, delegation_id, author_user_id, revision_no, action, content, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(revisionId,id,userId,revisionNo,action,content,JSON.stringify(incomingActionMetadata),now);
    recordCloudCollaborationEvidence(db,{ownerUserId:userId,sourceKind:'delegation_event',sourceId:id,sourceVersionId:revisionId,
      content:content || JSON.stringify({action,status,revisionNo}),delegationId:id,occurredAt:now,
      metadata:{action,status,revisionNo,groupId:delegation.group_id || ''}});
    let groupMessageId = '';
    if (delegation.group_id) {
      const labels = { submit: '提交了任务结果', accept_result: '接受了任务结果', request_revision: '提出了修改要求', publish: '确认并发布了任务要求', update_requirements: '更新了任务要求', withdraw: '撤回了任务', decline: '拒绝了任务', blocked: '将任务标记为受阻', working: '开始处理任务' };
      groupMessageId = `group_msg_${crypto.randomUUID()}`;
      db.prepare(
        `INSERT OR IGNORE INTO collaboration_group_messages
           (id, account_workspace_id, group_id, sender_user_id, sender_agent_id, kind, content, metadata_json, source_event_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?)`,
      ).run(groupMessageId, workspace.id, delegation.group_id, userId, ['submit', 'publish', 'update_requirements', 'withdraw'].includes(action) ? 'secretary_agent' : '', content || labels[action], JSON.stringify({ type: 'task_action', action, delegationId: id, status, revisionNo, attachments: metadata.attachments || [] }), `delegation-milestone:${id}:${revisionNo}:${action}`, now, now);
      db.prepare('UPDATE collaboration_groups SET updated_at = ? WHERE id = ?').run(now, delegation.group_id);
    } else if (['publish', 'update_requirements', 'withdraw'].includes(action)) {
      db.prepare(
        `INSERT INTO social_messages (
           id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
           kind, title, content, metadata_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'secretary_agent', 'secretary_agent', 'agent', ?, ?, ?, ?, ?)`,
      ).run(
        `social_msg_${crypto.randomUUID()}`, workspace.id, delegation.requester_user_id, delegation.recipient_user_id,
        action === 'publish'
          ? `uBuddy 已发布委托：${delegation.title}`
          : action === 'withdraw'
            ? `uBuddy 已撤回委托：${delegation.title}`
            : `uBuddy 已更新委托要求：${delegation.title}`,
        (content || '发起人已撤回这项任务。').slice(0, 8000), JSON.stringify({ type: 'agent_delegation', action, delegationId: id, status, revisionNo }), now, now,
      );
    }
    const ingressTargetUserId = ['publish', 'update_requirements', 'request_revision', 'accept_result', 'withdraw'].includes(action)
      ? delegation.recipient_user_id
      : action === 'submit' ? delegation.requester_user_id : '';
    if (ingressTargetUserId) insertCloudPrivateTaskIngress(db, {
      delegationId: id,
      userId: ingressTargetUserId,
      content: content || `任务状态已更新：${action}`,
      type: action === 'submit' ? 'result_submitted' : action === 'request_revision' ? 'revision_requested' : action === 'accept_result' ? 'result_accepted' : action === 'withdraw' ? 'task_withdrawn' : 'requirements_update',
      sourceEventId: `task-action:${id}:${revisionNo}:${action}`,
      sourceGroupMessageId: groupMessageId,
      fromUserId: userId,
      metadata: { action, revisionNo, status, attachments: metadata.attachments || [] },
      now,
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    ok: true,
    delegation: hydratedCloudDelegation(db, id, userId),
    ...(delegation.group_id ? cloudCollaborationGroupDetail(db, delegation.group_id, userId, { workspaceId: workspace.id }) : {}),
  };
}

const MAX_CLOUD_COLLABORATION_FILE_BYTES = 60 * 1024 * 1024;

function requireCloudDirectDelegationFilesCapability(headers = {}) {
  const capability = String(headers['x-janus-social-capability'] || '').trim();
  if (!capability.split(',').map((item) => item.trim()).includes('direct-delegation-files-v1')) {
    throw cloudApiError('direct_delegation_files_capability_required', '当前客户端或通信服务版本不支持一对一任务文件交付。', 426);
  }
}

function canonicalCloudCollaborationTaskAttachments(db, delegation = {}, attachments = []) {
  const groupId = String(delegation.group_id || '').trim();
  return (Array.isArray(attachments) ? attachments.slice(0, 20) : []).map((attachment) => {
    const remoteFileId = String(attachment?.remote_file_id || attachment?.remoteFileId || '').trim();
    const remoteFileKind = String(attachment?.remote_file_kind || attachment?.remoteFileKind || '').trim();
    if (!remoteFileId || (remoteFileKind && remoteFileKind !== 'collaboration_task')) {
      throw cloudApiError('collaboration_file_scope_invalid', '任务附件不属于当前委托。', 400);
    }
    const stored = db.prepare('SELECT * FROM collaboration_files WHERE id = ? AND delegation_id = ?').get(remoteFileId, delegation.id);
    if (!stored || String(stored.group_id || '').trim() !== groupId) {
      throw cloudApiError('collaboration_file_scope_invalid', '任务附件不属于当前委托。', 400);
    }
    if ((attachment?.sha256 && String(attachment.sha256).toLowerCase() !== String(stored.sha256 || '').toLowerCase())
      || (Number(attachment?.size || 0) > 0 && Number(attachment.size) !== Number(stored.size_bytes || 0))) {
      throw cloudApiError('collaboration_file_metadata_mismatch', '任务附件元数据校验失败。', 400);
    }
    return cloudCollaborationFileAttachment(stored);
  });
}

function ensureCloudCollaborationGroupWorkspace(db, groupId, status = '') {
  const group = db.prepare('SELECT * FROM collaboration_groups WHERE id = ?').get(String(groupId || '').trim());
  if (!group) throw cloudApiError('collaboration_group_not_found', '任务群不存在。', 404);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO collaboration_group_workspaces(group_id,workspace_epoch,revision,status,created_at,updated_at)
    VALUES(?,?,0,?,?,?) ON CONFLICT(group_id) DO UPDATE SET status=excluded.status`).run(
    group.id,
    `workspace_${group.id}`,
    status || group.status || 'active',
    now,
    now,
  );
  return db.prepare('SELECT * FROM collaboration_group_workspaces WHERE group_id = ?').get(group.id);
}

function cloudCollaborationGroupWorkspace(db, groupId, userId, { sinceRevision = 0, workspaceId = '' } = {}) {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  const membership = requireCloudActiveTaskMembership(db, groupId, userId, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
  const group = db.prepare('SELECT * FROM collaboration_groups WHERE id = ? AND account_workspace_id = ?').get(groupId, accountWorkspace.id);
  const workspace = ensureCloudCollaborationGroupWorkspace(db, groupId, group?.status || 'active');
  const files = db.prepare(`SELECT * FROM collaboration_group_workspace_files
    WHERE group_id = ? AND revision > ? ORDER BY revision ASC, relative_path ASC LIMIT 5000`).all(groupId, Math.max(0, Number(sinceRevision || 0)));
  return {
    workspace: cloudCollaborationGroupWorkspacePayload(workspace, { readOnly: group?.status === 'closed' || membership.status !== 'active' }),
    files: files.map(cloudCollaborationGroupWorkspaceFilePayload),
  };
}

function storeCloudCollaborationGroupWorkspaceFile(db, { groupId = '', fileId = '', userId = '', workspaceId = '', headers = {}, data = Buffer.alloc(0) } = {}) {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId || headers['x-janus-workspace-id']);
  requireCloudActiveTaskMembership(db, groupId, userId, { accountWorkspaceId: accountWorkspace.id });
  const cleanFileId = String(fileId || '').trim().slice(0, 200);
  if (!cleanFileId) throw cloudApiError('collaboration_workspace_file_id_required', '缺少共享工作区文件 ID。', 400);
  const relativePath = cloudCollaborationWorkspaceRelativePath(headers['x-janus-relative-path']);
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (body.length > MAX_CLOUD_COLLABORATION_FILE_BYTES) throw cloudApiError('collaboration_workspace_file_too_large', '共享工作区文件不能超过 60 MB。', 413);
  const filename = cloudCollaborationFilename(headers['x-janus-filename'] || relativePath.split('/').at(-1));
  const contentType = String(headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const claimedSha256 = String(headers['x-janus-file-sha256'] || '').trim().toLowerCase();
  if (claimedSha256 && claimedSha256 !== sha256) throw cloudApiError('collaboration_workspace_file_hash_mismatch', '共享工作区文件校验失败。', 400);
  const baseRevision = Math.max(0, Number(headers['x-janus-base-revision'] || 0));
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const workspace = ensureCloudCollaborationGroupWorkspace(db, groupId, 'active');
    const current = db.prepare('SELECT * FROM collaboration_group_workspace_files WHERE group_id = ? AND relative_path = ?').get(groupId, relativePath);
    const currentRevision = Math.max(0, Number(current?.revision || 0));
    if (baseRevision !== currentRevision) {
      const error = cloudApiError('collaboration_workspace_file_conflict', '共享工作区文件已被其他成员更新。', 409);
      error.details = { relativePath, expectedRevision: baseRevision, current: current ? cloudCollaborationGroupWorkspaceFilePayload(current) : null };
      throw error;
    }
    const nextRevision = Math.max(0, Number(workspace.revision || 0)) + 1;
    db.prepare('UPDATE collaboration_group_workspaces SET revision = ?, status = ?, updated_at = ? WHERE group_id = ?').run(nextRevision, 'active', now, groupId);
    db.prepare(`INSERT INTO collaboration_group_workspace_files(
      id,group_id,relative_path,revision,owner_user_id,filename,content_type,size_bytes,sha256,data,deleted,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)
    ON CONFLICT(group_id,relative_path) DO UPDATE SET
      id=excluded.id,revision=excluded.revision,owner_user_id=excluded.owner_user_id,filename=excluded.filename,
      content_type=excluded.content_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256,data=excluded.data,deleted=0,updated_at=excluded.updated_at`).run(
      cleanFileId, groupId, relativePath, nextRevision, userId, filename, contentType, body.length, sha256, body, now, now,
    );
    const stored = db.prepare('SELECT * FROM collaboration_group_workspace_files WHERE group_id = ? AND relative_path = ?').get(groupId, relativePath);
    db.exec('COMMIT');
    return { created: !current, file: cloudCollaborationGroupWorkspaceFilePayload(stored) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteCloudCollaborationGroupWorkspaceFile(db, { groupId = '', fileId = '', userId = '', workspaceId = '', baseRevision = 0 } = {}) {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  requireCloudActiveTaskMembership(db, groupId, userId, { accountWorkspaceId: accountWorkspace.id });
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const workspace = ensureCloudCollaborationGroupWorkspace(db, groupId, 'active');
    const current = db.prepare('SELECT * FROM collaboration_group_workspace_files WHERE group_id = ? AND id = ?').get(groupId, fileId);
    if (!current) throw cloudApiError('collaboration_workspace_file_not_found', '共享工作区文件不存在。', 404);
    if (Math.max(0, Number(baseRevision || 0)) !== Math.max(0, Number(current.revision || 0))) {
      const error = cloudApiError('collaboration_workspace_file_conflict', '共享工作区文件已被其他成员更新。', 409);
      error.details = { relativePath: current.relative_path, expectedRevision: Number(baseRevision || 0), current: cloudCollaborationGroupWorkspaceFilePayload(current) };
      throw error;
    }
    const nextRevision = Math.max(0, Number(workspace.revision || 0)) + 1;
    db.prepare('UPDATE collaboration_group_workspaces SET revision = ?, updated_at = ? WHERE group_id = ?').run(nextRevision, now, groupId);
    db.prepare(`UPDATE collaboration_group_workspace_files SET revision=?,owner_user_id=?,data=X'',size_bytes=0,sha256='',deleted=1,updated_at=?
      WHERE group_id=? AND id=?`).run(nextRevision, userId, now, groupId, fileId);
    const stored = db.prepare('SELECT * FROM collaboration_group_workspace_files WHERE group_id = ? AND id = ?').get(groupId, fileId);
    db.exec('COMMIT');
    return { ok: true, file: cloudCollaborationGroupWorkspaceFilePayload(stored) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cloudCollaborationGroupWorkspaceFileForUser(db, groupId, fileId, userId, workspaceId = '') {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  requireCloudActiveTaskMembership(db, groupId, userId, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
  const file = db.prepare('SELECT * FROM collaboration_group_workspace_files WHERE group_id = ? AND id = ? AND deleted = 0').get(groupId, fileId);
  if (!file) throw cloudApiError('collaboration_workspace_file_not_found', '共享工作区文件不存在。', 404);
  return { ...file, data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '') };
}

function cloudCollaborationWorkspaceRelativePath(value = '') {
  let decoded = String(value || '').trim();
  try { decoded = decodeURIComponent(decoded); } catch {}
  const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))) {
    throw cloudApiError('collaboration_workspace_path_invalid', '共享工作区文件路径无效。', 400);
  }
  return segments.join('/').slice(0, 1200);
}

function cloudCollaborationGroupWorkspacePayload(row = {}, { readOnly = false } = {}) {
  return {
    id: row.group_id || '', groupId: row.group_id || '', workspaceEpoch: row.workspace_epoch || '',
    revision: Math.max(0, Number(row.revision || 0)), status: row.status || 'active', scope: 'collaboration_group',
    readOnly: Boolean(readOnly || row.status === 'closed'), createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}

function cloudCollaborationGroupWorkspaceFilePayload(row = {}) {
  return {
    id: row.id || '', groupId: row.group_id || '', relativePath: row.relative_path || '',
    revision: Math.max(0, Number(row.revision || 0)), ownerUserId: row.owner_user_id || '', filename: row.filename || 'file',
    contentType: row.content_type || 'application/octet-stream', size: Math.max(0, Number(row.size_bytes || 0)),
    sha256: row.sha256 || '', deleted: Boolean(row.deleted), createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}

function storeCloudCollaborationFile(db, { delegationId = '', fileId = '', userId = '', workspaceId = '', headers = {}, data = Buffer.alloc(0) } = {}) {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId || headers['x-janus-workspace-id']);
  const delegation = requireCloudDelegationParticipant(db, delegationId, userId, { accountWorkspaceId: accountWorkspace.id });
  const groupId = String(delegation.group_id || '').trim();
  if (groupId) requireCloudActiveTaskMembership(db, groupId, userId, { accountWorkspaceId: accountWorkspace.id });
  else requireCloudDirectDelegationFilesCapability(headers);
  const cleanFileId = String(fileId || '').trim().slice(0, 200);
  if (!cleanFileId) throw cloudApiError('collaboration_file_id_required', '缺少任务附件 ID。', 400);
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  if (!body.length) throw cloudApiError('collaboration_file_empty', '不能提交空文件。', 400);
  if (body.length > MAX_CLOUD_COLLABORATION_FILE_BYTES) throw cloudApiError('collaboration_file_too_large', '任务附件不能超过 60 MB。', 413);
  const filename = cloudCollaborationFilename(headers['x-janus-filename']);
  const contentType = String(headers['x-janus-content-type'] || 'application/octet-stream').trim().slice(0, 200) || 'application/octet-stream';
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const claimedSha256 = String(headers['x-janus-file-sha256'] || '').trim().toLowerCase();
  if (claimedSha256 && claimedSha256 !== sha256) throw cloudApiError('collaboration_file_hash_mismatch', '任务附件校验失败。', 400);
  const existing = db.prepare('SELECT * FROM collaboration_files WHERE id = ?').get(cleanFileId);
  if (existing && (existing.delegation_id !== delegation.id || existing.owner_user_id !== userId || existing.sha256 !== sha256)) {
    throw cloudApiError('collaboration_file_conflict', '任务附件 ID 已被其他文件占用。', 409);
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO collaboration_files
       (id, delegation_id, group_id, owner_user_id, filename, content_type, size_bytes, sha256, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, content_type = excluded.content_type,
       size_bytes = excluded.size_bytes, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(cleanFileId, delegation.id, groupId || null, userId, filename, contentType, body.length, sha256, body, now, now);
  return { created: !existing, attachment: cloudCollaborationFileAttachment(db.prepare('SELECT * FROM collaboration_files WHERE id = ?').get(cleanFileId)) };
}

function cloudCollaborationFileForUser(db, fileId = '', userId = '', workspaceId = '') {
  const accountWorkspace = requireCloudAccountWorkspace(db, userId, workspaceId);
  const file = db.prepare('SELECT * FROM collaboration_files WHERE id = ?').get(String(fileId || '').trim());
  if (!file) throw cloudApiError('collaboration_file_not_found', '任务附件不存在。', 404);
  if (file.group_id) {
    const membership = db.prepare("SELECT status FROM collaboration_group_members WHERE group_id = ? AND user_id = ? AND status IN ('active','closed')").get(file.group_id, userId);
    if (!membership) throw cloudApiError('collaboration_file_forbidden', '无权下载该任务附件。', 403);
    requireCloudActiveTaskMembership(db, file.group_id, userId, { allowClosed: true, accountWorkspaceId: accountWorkspace.id });
  } else {
    const delegation = db.prepare('SELECT * FROM agent_delegations WHERE id = ? AND account_workspace_id = ?').get(file.delegation_id, accountWorkspace.id);
    if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(userId)) {
      throw cloudApiError('collaboration_file_forbidden', '无权下载该任务附件。', 403);
    }
  }
  return { ...file, data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || '') };
}

function cloudCollaborationFilename(value = '') {
  let decoded = String(value || '').trim();
  try { decoded = decodeURIComponent(decoded); } catch {}
  return decoded.split(/[\\/]/).at(-1)?.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().slice(0, 240) || 'file';
}

function cloudCollaborationContentDisposition(filename = 'file') {
  const clean = cloudCollaborationFilename(filename);
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '');
  return `attachment; filename="${ascii || 'file'}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function cloudCollaborationFileAttachment(row = {}) {
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

function insertCloudCollaborationSystemMessage(db, groupId, senderUserId, content, metadata = {}, createdAt = new Date().toISOString()) {
  const accountWorkspaceId = db.prepare('SELECT account_workspace_id FROM collaboration_groups WHERE id=?').get(groupId)?.account_workspace_id || 'workspace_personal';
  db.prepare(
    `INSERT INTO collaboration_group_messages
       (id, account_workspace_id, group_id, sender_user_id, kind, content, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'system', ?, ?, ?, ?)`,
  ).run(`group_msg_${crypto.randomUUID()}`, accountWorkspaceId, groupId, senderUserId, String(content || '').slice(0, 8000), JSON.stringify(cloudJsonObject(metadata)), createdAt, createdAt);
}

function cloudCollaborationGroupPayload(row = {}) {
  return {
    id: row.id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    ownerUserId: row.owner_user_id || '',
    title: row.title || 'uBuddy 任务群',
    status: row.status || 'active',
    memberCount: Number(row.member_count || 0),
    unreadCount: Number(row.unread_count || 0),
    lastMessage: row.last_message || '',
    metadata: cloudJsonObject(row.metadata_json),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    closedAt: row.closed_at || '',
  };
}

function cloudCollaborationMemberPayload(row = {}) {
  return {
    groupId: row.group_id || '',
    userId: row.user_id || '',
    role: row.role || 'member',
    status: row.status || 'active',
    joinedAt: row.joined_at || '',
    leftAt: row.left_at || '',
    user: cloudPublicUser({ id: row.user_id, email: row.email, display_name: row.display_name, username: row.username, avatar_url: row.avatar_url, role: row.user_role, email_verified: row.email_verified }),
  };
}

function cloudCollaborationMessagePayload(row = {}) {
  return {
    id: row.id || '',
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    groupId: row.group_id || '',
    senderUserId: row.sender_user_id || '',
    senderAgentId: row.sender_agent_id || '',
    kind: normalizeCloudMessageKind(row.kind),
    content: row.content || '',
    sourceEventId: row.source_event_id || '',
    metadata: cloudJsonObject(row.metadata_json),
    sender: cloudPublicUser({ id: row.sender_user_id, email: row.sender_email, display_name: row.sender_display_name, username: row.sender_username, avatar_url: row.sender_avatar_url, role: row.sender_role, email_verified: row.sender_email_verified }),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}


function cloudDelegationSelectSql() {
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

function hydratedCloudDelegation(db, id, viewerUserId = '') {
  const row = db.prepare(`${cloudDelegationSelectSql()} WHERE ad.id = ?`).get(String(id || ''));
  return row ? cloudDelegationPayload(row, viewerUserId, cloudDelegationWorkspaceRow(db, row.id, viewerUserId)) : null;
}

function cloudDelegationWorkspaceRow(db, delegationId, viewerUserId) {
  if (!viewerUserId) return null;
  return db.prepare('SELECT * FROM agent_delegation_workspaces WHERE delegation_id = ? AND user_id = ?').get(delegationId, viewerUserId) || null;
}

function cloudDelegationPayload(row, viewerUserId = '', workspace = null) {
  const metadata = cloudJsonObject(row.metadata_json);
  const recipientView = !viewerUserId || viewerUserId === row.recipient_user_id;
  const participantView = [row.requester_user_id, row.recipient_user_id].includes(viewerUserId);
  const workspaceMetadata = participantView ? cloudJsonObject(workspace?.metadata_json) : {};
  const legacySessionId = viewerUserId === row.recipient_user_id ? row.session_id || '' : '';
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    requesterUserId: row.requester_user_id,
    recipientUserId: row.recipient_user_id,
    clientRequestId: row.client_request_id || '',
    senderAgentId: row.sender_agent_id || 'secretary_agent',
    recipientAgentId: row.recipient_agent_id || 'secretary_agent',
    title: row.title || '',
    instruction: row.instruction || '',
    status: normalizeCloudDelegationStatus(row.status),
    sessionId: participantView ? workspace?.session_id || legacySessionId : '',
    taskRunId: recipientView ? row.task_run_id || '' : '',
    groupId: row.group_id || metadata.groupId || '',
    metadata: participantView ? { ...publicCloudDelegationMetadata(metadata), ...workspaceMetadata } : publicCloudDelegationMetadata(metadata),
    lastError: recipientView ? row.last_error || '' : '',
    requester: cloudPublicUser({ id: row.requester_user_id, email: row.requester_email, display_name: row.requester_display_name, username: row.requester_username, avatar_url: row.requester_avatar_url, role: row.requester_role, email_verified: row.requester_email_verified }),
    recipient: cloudPublicUser({ id: row.recipient_user_id, email: row.recipient_email, display_name: row.recipient_display_name, username: row.recipient_username, avatar_url: row.recipient_avatar_url, role: row.recipient_role, email_verified: row.recipient_email_verified }),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    startedAt: row.started_at || '',
    completedAt: row.completed_at || '',
  };
}


function cloudDelegationWorkspacePayload(row = {}) {
  return {
    delegationId: row.delegation_id,
    userId: row.user_id,
    sessionId: row.session_id || '',
    metadata: cloudJsonObject(row.metadata_json),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cloudDelegationWorkspaceMessagePayload(row = {}) {
  return {
    id: row.id,
    delegationId: row.delegation_id,
    userId: row.user_id,
    role: row.role || 'user',
    content: row.content || '',
    metadata: cloudJsonObject(row.metadata_json),
    sourceEventId: row.source_event_id || '',
    sourceGroupMessageId: row.source_group_message_id || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function emptyCloudTaskRouting() {
  return { routed: [], needsRoutingConfirmation: false, candidateDelegationIds: [], candidates: [] };
}

function insertCloudPrivateTaskIngress(db, {
  delegationId = '', userId = '', content = '', type = 'group_update', sourceEventId = '',
  sourceGroupMessageId = '', fromUserId = '', metadata = {}, now = new Date().toISOString(),
} = {}) {
  if (!delegationId || !userId || !String(content || '').trim()) return null;
  db.prepare(
    `INSERT INTO agent_delegation_workspaces (delegation_id, user_id, metadata_json, created_at, updated_at)
     VALUES (?, ?, '{}', ?, ?)
     ON CONFLICT(delegation_id, user_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(delegationId, userId, now, now);
  const privateMetadata = { privateTaskWorkspace: true, type, fromUserId, sourceEventId, sourceGroupMessageId, ...cloudJsonObject(metadata) };
  const ingressResult = db.prepare(
    `INSERT OR IGNORE INTO agent_delegation_workspace_messages
       (id, delegation_id, user_id, role, content, metadata_json, source_event_id, source_group_message_id, created_at, updated_at)
     VALUES (?, ?, ?, 'system', ?, ?, ?, ?, ?, ?)`,
  ).run(`workspace_msg_${crypto.randomUUID()}`, delegationId, userId, String(content).slice(0, 32000), JSON.stringify(privateMetadata), String(sourceEventId || '').slice(0, 240), String(sourceGroupMessageId || '').slice(0, 240), now, now);
  if (Number(ingressResult.changes || 0) > 0) db.prepare('UPDATE agent_delegations SET updated_at = ? WHERE id = ?').run(now, delegationId);
  const row = sourceEventId
    ? db.prepare('SELECT * FROM agent_delegation_workspace_messages WHERE delegation_id = ? AND user_id = ? AND source_event_id = ?').get(delegationId, userId, sourceEventId)
    : null;
  return row;
}

function routeCloudGroupMessageToPrivateThreads(db, { groupId = '', groupMessageId = '', senderUserId = '', content = '', metadata = {}, now = new Date().toISOString() } = {}) {
  const tasks = db.prepare(
    `SELECT id, title, requester_user_id, recipient_user_id, status FROM agent_delegations
     WHERE group_id = ? AND status NOT IN ('closed','withdrawn','declined','rejected') ORDER BY created_at ASC`,
  ).all(groupId);
  const explicitDelegationId = String(metadata.delegationId || metadata.taskId || '').trim();
  const mentionedUserIds = [...new Set(normalizeMentionEntities(metadata.mentions, { content, requirePicker: true })
    .map((mention) => String(mention.ownerUserId || mention.userId || '').trim()).filter(Boolean))];
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
      const targets = mentionedUserIds.filter((target) => [task.requester_user_id, task.recipient_user_id].includes(target));
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
  const ambiguousMention = mentionedUserIds.some((target) => {
    const senderMatching = senderTasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(target));
    return (senderMatching.length ? senderMatching : tasks.filter((task) => [task.requester_user_id, task.recipient_user_id].includes(target))).length > 1;
  });
  for (const { task, targetUserId } of dedupedRoutes) insertCloudPrivateTaskIngress(db, {
    delegationId: task.id, userId: targetUserId, content, type: 'group_message_ingress',
    sourceEventId: `group-message:${groupMessageId}`, sourceGroupMessageId: groupMessageId, fromUserId: senderUserId,
    metadata: { groupId, routedBy: explicitDelegationId ? 'delegation_id' : mentionedUserIds.length ? 'mention' : 'broadcast' }, now,
  });
  return {
    routed: dedupedRoutes.map(({ task, targetUserId }) => ({ delegationId: task.id, targetUserId })),
    needsRoutingConfirmation: !dedupedRoutes.length && (uniqueCandidates.length > 1 || ambiguousMention || Boolean(explicitDelegationId)),
    candidateDelegationIds: uniqueCandidates,
    candidates: [...new Map(candidates.map((task) => [task.id, task])).values()].map((task) => ({ delegationId: task.id, title: task.title || '', requesterUserId: task.requester_user_id, recipientUserId: task.recipient_user_id, targetUserId: task.requester_user_id === senderUserId ? task.recipient_user_id : task.requester_user_id })),
  };
}

function requireCloudDelegationParticipant(db, delegationId, userId, { allowClosed = false, accountWorkspaceId = '' } = {}) {
  const delegation = accountWorkspaceId
    ? db.prepare('SELECT * FROM agent_delegations WHERE id = ? AND account_workspace_id = ?').get(String(delegationId || ''), accountWorkspaceId)
    : db.prepare('SELECT * FROM agent_delegations WHERE id = ?').get(String(delegationId || ''));
  if (!delegation || ![delegation.requester_user_id, delegation.recipient_user_id].includes(userId)) {
    throw cloudApiError('delegation_not_found', '任务不存在。', 404);
  }
  if (delegation.group_id) requireCloudActiveTaskMembership(db, delegation.group_id, userId, { allowClosed, accountWorkspaceId: delegation.account_workspace_id });
  return delegation;
}

function requireCloudActiveTaskMembership(db, groupId, userId, { allowClosed = false, accountWorkspaceId = '' } = {}) {
  const group = accountWorkspaceId
    ? db.prepare('SELECT status FROM collaboration_groups WHERE id = ? AND account_workspace_id = ?').get(groupId, accountWorkspaceId)
    : db.prepare('SELECT status FROM collaboration_groups WHERE id = ?').get(groupId);
  const membership = db.prepare('SELECT * FROM collaboration_group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  if (!group || !membership) {
    throw cloudApiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  }
  if (!allowClosed && group.status === 'closed') throw cloudApiError('collaboration_group_closed', '任务群已结束。', 409);
  const acceptedStatuses = allowClosed && group.status === 'closed' ? ['closed'] : ['active'];
  if (!acceptedStatuses.includes(membership.status)) {
    throw cloudApiError('collaboration_group_not_found', '任务群不存在或你已不在群内。', 404);
  }
  return membership;
}


function publicCloudTaskActionMetadata(metadata = {}, action = '') {
  const clean = publicCloudDelegationMetadata(metadata);
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

function recordCloudCollaborationEvidence(db,input={}) {
  const keyring=evolutionKeyringFromEnv(process.env);
  if (!evolutionEncryptionReady(keyring) && !keyring.allowPlaintextTestOnly) return null;
  const instance=db.prepare(`SELECT * FROM cloud_user_agent_instances_v3
    WHERE user_id=? AND agent_family_id='secretary_agent' AND status='active'`).get(input.ownerUserId);
  if (!instance) return null;
  return createSqliteAuthoritativeEvidence(db,{keyring,ownerUserId:input.ownerUserId,userAgentInstanceId:instance.id,
    agentFamilyId:instance.agent_family_id,sourceKind:input.sourceKind,sourceId:input.sourceId,sourceVersionId:input.sourceVersionId || '',
    content:input.content,delegationId:input.delegationId || '',occurredAt:input.occurredAt || new Date().toISOString(),
    confidence:0.8,metadata:input.metadata || {}});
}


export {
  listCloudDelegations,
  createCloudDelegation,
  updateCloudDelegation,
  cloudDelegationWorkspace,
  createCloudDelegationWorkspaceMessage,
  cloudCollaborationOverview,
  cloudCollaborationGroupDetail,
  createCloudCollaborationGroup,
  createCloudCollaborationMessage,
  updateCloudCollaborationGroup,
  applyCloudCollaborationTaskAction,
  cloudCollaborationGroupWorkspace,
  storeCloudCollaborationGroupWorkspaceFile,
  deleteCloudCollaborationGroupWorkspaceFile,
  cloudCollaborationGroupWorkspaceFileForUser,
  cloudCollaborationGroupWorkspacePayload,
  cloudCollaborationGroupWorkspaceFilePayload,
  storeCloudCollaborationFile,
  cloudCollaborationFileForUser,
  cloudCollaborationFilename,
  cloudCollaborationContentDisposition,
  cloudCollaborationFileAttachment,
  insertCloudCollaborationSystemMessage,
  cloudCollaborationGroupPayload,
  cloudCollaborationMemberPayload,
  cloudCollaborationMessagePayload,
  cloudDelegationSelectSql,
  hydratedCloudDelegation,
  cloudDelegationWorkspaceRow,
  cloudDelegationPayload,
  cloudDelegationWorkspacePayload,
  cloudDelegationWorkspaceMessagePayload,
  emptyCloudTaskRouting,
  insertCloudPrivateTaskIngress,
  routeCloudGroupMessageToPrivateThreads,
  requireCloudDelegationParticipant,
  requireCloudActiveTaskMembership,
  publicCloudTaskActionMetadata,
};
