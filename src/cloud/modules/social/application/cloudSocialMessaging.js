import crypto from 'node:crypto';

import { cloudApiError } from '../../http/index.js';
import { cloudOrganizationOverview } from './cloudOrganizations.js';
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

function searchCloudUsers(db, currentUserId, query = '', rawLimit = 20) {
  const cleanQuery = String(query || '').trim().toLowerCase();
  if (!cleanQuery) return [];
  const limit = Math.max(1, Math.min(50, Number(rawLimit || 20)));
  const rows = db.prepare(
    `SELECT * FROM users
     WHERE id <> ?
       AND (lower(email) LIKE ? OR lower(display_name) LIKE ? OR lower(username) LIKE ? OR lower(id) LIKE ?)
     ORDER BY display_name ASC
     LIMIT ?`,
  ).all(currentUserId, `%${cleanQuery}%`, `%${cleanQuery}%`, `%${cleanQuery}%`, `%${cleanQuery}%`, limit * 2);
  const items = [];
  for (const row of rows) {
    if (cloudUsersBlocked(db, currentUserId, row.id)) continue;
    const outgoing = db.prepare(
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
    ).get(currentUserId, row.id);
    const incoming = db.prepare(
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
    ).get(row.id, currentUserId);
    items.push({
      ...cloudPublicUser(row),
      friendshipStatus: cloudFriendshipBetween(db, currentUserId, row.id)
        ? 'accepted'
        : outgoing
          ? 'outgoing_pending'
          : incoming
            ? 'incoming_pending'
            : 'none',
      requestId: outgoing?.id || incoming?.id || '',
    });
    if (items.length >= limit) break;
  }
  return items;
}

function cloudFriendsOverview(db, userId) {
  const organization = cloudOrganizationOverview(db, userId);
  const friendRows = db.prepare(
    `SELECT f.*, u.id AS friend_id, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified,
            CASE WHEN f.user_a_id = ? THEN f.user_a_remark ELSE f.user_b_remark END AS friend_remark,
            (SELECT max(last_seen_at) FROM user_presence WHERE user_id = u.id) AS last_seen_at
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END
     WHERE (f.user_a_id = ? OR f.user_b_id = ?) AND f.status = 'accepted'
     ORDER BY f.updated_at DESC`,
  ).all(userId, userId, userId, userId);
  const incomingRows = db.prepare(
    `SELECT fr.*, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified
     FROM friend_requests fr JOIN users u ON u.id = fr.requester_id
     WHERE fr.recipient_id = ? AND fr.status = 'pending' ORDER BY fr.updated_at DESC`,
  ).all(userId);
  const outgoingRows = db.prepare(
    `SELECT fr.*, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified
     FROM friend_requests fr JOIN users u ON u.id = fr.recipient_id
     WHERE fr.requester_id = ? AND fr.status = 'pending' ORDER BY fr.updated_at DESC`,
  ).all(userId);
  return {
    friends: friendRows.map(cloudFriendshipPayload),
    requests: {
      incoming: incomingRows.map((row) => cloudFriendRequestPayload(row, 'incoming')),
      outgoing: outgoingRows.map((row) => cloudFriendRequestPayload(row, 'outgoing')),
    },
    organizations: organization.organizations,
    organizationExitRequests: organization.organizationExitRequests || [],
    organizationNotices: organization.organizationNotices || [],
  };
}

function createCloudFriendRequest(db, currentUserId, payload = {}) {
  const targetId = String(payload.userId || '').trim();
  const message = String(payload.message || '').trim().slice(0, 200);
  if (!targetId || targetId === currentUserId) throw cloudApiError('user_not_found', '不能添加自己为好友。', 400);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) throw cloudApiError('user_not_found', '用户不存在。', 404);
    if (cloudUsersBlocked(db, currentUserId, targetId)) throw cloudApiError('blocked_user', '无法向该用户发送好友申请。', 403);
    if (cloudFriendshipBetween(db, currentUserId, targetId)) throw cloudApiError('friendship_already_exists', '你们已经是好友。', 409);
    const reverse = db.prepare(
      "SELECT * FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
    ).get(targetId, currentUserId);
    let requestId;
    if (reverse) {
      acceptCloudFriendRequestRow(db, currentUserId, reverse);
      requestId = reverse.id;
    } else {
      const existing = db.prepare(
        "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      ).get(currentUserId, targetId);
      if (existing) throw cloudApiError('friend_request_already_pending', '好友申请已发送。', 409);
      requestId = `friend_req_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO friend_requests (id, requester_id, recipient_id, status, message, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(requestId, currentUserId, targetId, message, now, now);
    }
    db.exec('COMMIT');
    return { ok: true, requestId, overview: cloudFriendsOverview(db, currentUserId) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function updateCloudFriendRequest(db, currentUserId, requestId, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(String(requestId || ''));
    if (!row || row.status !== 'pending') throw cloudApiError('friend_request_not_found', '好友申请不存在或已处理。', 404);
    if (action === 'accept') {
      acceptCloudFriendRequestRow(db, currentUserId, row);
    } else {
      const allowed = action === 'reject' ? row.recipient_id === currentUserId : row.requester_id === currentUserId;
      if (!allowed) throw cloudApiError('forbidden', '无权处理该好友申请。', 403);
      db.prepare('UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?')
        .run(action === 'reject' ? 'rejected' : 'cancelled', new Date().toISOString(), row.id);
    }
    db.exec('COMMIT');
    return { ok: true, overview: cloudFriendsOverview(db, currentUserId) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function acceptCloudFriendRequestRow(db, currentUserId, row) {
  if (row.recipient_id !== currentUserId) throw cloudApiError('forbidden', '无权处理该好友申请。', 403);
  if (cloudUsersBlocked(db, row.requester_id, row.recipient_id)) throw cloudApiError('blocked_user', '无法处理该好友申请。', 403);
  const [userA, userB] = cloudOrderedUserPair(row.requester_id, row.recipient_id);
  const now = new Date().toISOString();
  db.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?").run(now, row.id);
  db.prepare(
    `INSERT INTO friendships (id, user_a_id, user_b_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'accepted', ?, ?)
     ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET status = 'accepted', updated_at = excluded.updated_at`,
  ).run(`friendship_${crypto.randomUUID()}`, userA, userB, now, now);
}

function removeCloudFriend(db, currentUserId, targetId) {
  const [userA, userB] = cloudOrderedUserPair(currentUserId, targetId);
  db.prepare("UPDATE friendships SET status = 'removed', updated_at = ? WHERE user_a_id = ? AND user_b_id = ?")
    .run(new Date().toISOString(), userA, userB);
  return { ok: true, overview: cloudFriendsOverview(db, currentUserId) };
}

function updateCloudFriendRemark(db, currentUserId, targetId, payload = {}) {
  const [userA, userB] = cloudOrderedUserPair(currentUserId, targetId);
  const friendship = db.prepare("SELECT * FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'").get(userA, userB);
  if (!friendship) throw cloudApiError('friendship_not_found', '好友关系不存在。', 404);
  const cleanRemark = String(payload.remark || '').trim().slice(0, 40);
  const column = friendship.user_a_id === currentUserId ? 'user_a_remark' : 'user_b_remark';
  db.prepare(`UPDATE friendships SET ${column} = ?, updated_at = ? WHERE id = ?`).run(cleanRemark, new Date().toISOString(), friendship.id);
  return { ok: true, remark: cleanRemark, overview: cloudFriendsOverview(db, currentUserId) };
}

function blockCloudUser(db, currentUserId, payload = {}) {
  const targetId = String(payload.userId || '').trim();
  if (!targetId || targetId === currentUserId) throw cloudApiError('user_not_found', '请选择有效用户。', 400);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetId)) throw cloudApiError('user_not_found', '用户不存在。', 404);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO user_blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)')
      .run(`block_${crypto.randomUUID()}`, currentUserId, targetId, now);
    db.prepare(
      `UPDATE friend_requests SET status = 'cancelled', updated_at = ?
       WHERE status = 'pending' AND ((requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?))`,
    ).run(now, currentUserId, targetId, targetId, currentUserId);
    const [userA, userB] = cloudOrderedUserPair(currentUserId, targetId);
    db.prepare("UPDATE friendships SET status = 'removed', updated_at = ? WHERE user_a_id = ? AND user_b_id = ?").run(now, userA, userB);
    db.exec('COMMIT');
    return { ok: true, overview: cloudFriendsOverview(db, currentUserId) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function listCloudSocialMessages(db, userId, searchParams) {
  const workspace = requireCloudAccountWorkspace(db, userId, searchParams.get('workspaceId'));
  const peerId = String(searchParams.get('peerId') || '').trim();
  const cursor = normalizeCloudCursor(searchParams.get('cursor'));
  const limit = Math.max(1, Math.min(500, Number(searchParams.get('limit')) || 100));
  const where = ['sm.account_workspace_id=?', '(sm.sender_user_id = ? OR sm.recipient_user_id = ?)'];
  const params = [workspace.id, userId, userId];
  if (peerId) {
    where.push('((sm.sender_user_id = ? AND sm.recipient_user_id = ?) OR (sm.sender_user_id = ? AND sm.recipient_user_id = ?))');
    params.push(userId, peerId, peerId, userId);
  }
  if (cursor) {
    where.push('sm.updated_at > ?');
    params.push(cursor);
  }
  params.push(limit);
  const rows = db.prepare(`${cloudSocialMessageSelectSql()} WHERE ${where.join(' AND ')} ORDER BY sm.updated_at ASC LIMIT ?`).all(...params);
  return { items: rows.map(cloudSocialMessagePayload), cursor: rows.at(-1)?.updated_at || cursor || new Date().toISOString() };
}

function createCloudSocialMessage(db, senderId, payload = {}) {
  const workspace = requireCloudAccountWorkspace(db, senderId, payload.workspaceId);
  const recipientId = String(payload.recipientId || payload.userId || '').trim();
  requireCloudWorkspaceMessagingPeer(db, workspace, senderId, recipientId);
  const content = String(payload.content || '').trim();
  if (!content) throw cloudApiError('message_required', '请输入消息内容。', 400);
  const metadata = { ...cloudJsonObject(payload.metadata) };
  const selfMessage = senderId === recipientId;
  if (selfMessage && (String(payload.senderAgentId || '').trim() || String(payload.recipientAgentId || '').trim() || !['', 'direct_message'].includes(String(metadata.type || '')))) {
    throw cloudApiError('self_message_kind_invalid', '自己与自己的会话只支持普通消息。', 400);
  }
  if (metadata.type === 'social_task_group_message') {
    const taskGroupId = String(metadata.taskGroupId || metadata.groupId || '').trim();
    if (!taskGroupId) throw cloudApiError('task_group_id_required', '缺少任务群聊 ID。', 400);
    const dissolved = db.prepare(
      `SELECT 1 FROM social_messages
       WHERE account_workspace_id=? AND json_extract(metadata_json, '$.type') = 'social_task_group'
         AND json_extract(metadata_json, '$.action') = 'dissolved'
         AND COALESCE(json_extract(metadata_json, '$.taskGroupId'), json_extract(metadata_json, '$.groupId')) = ?
         AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
       LIMIT 1`,
    ).get(workspace.id, taskGroupId, senderId, recipientId, recipientId, senderId);
    if (dissolved) throw cloudApiError('task_group_closed', '任务群已解散，只能查看历史记录。', 409);
    metadata.taskGroupId = taskGroupId;
    metadata.groupId = taskGroupId;
  }
  if (metadata.type === 'social_task_group') {
    const taskGroupId = String(metadata.taskGroupId || metadata.groupId || '').trim();
    const action = String(metadata.action || '').trim().toLowerCase();
    if (!taskGroupId) throw cloudApiError('task_group_id_required', '缺少任务群聊 ID。', 400);
    metadata.taskGroupId = taskGroupId;
    metadata.groupId = taskGroupId;
    if (action === 'created') {
      metadata.initiatorUserId = senderId;
    } else if (action === 'dissolved' || action === 'renamed') {
      const created = db.prepare(
        `SELECT sender_user_id FROM social_messages
         WHERE account_workspace_id=? AND json_extract(metadata_json, '$.type') = 'social_task_group'
           AND json_extract(metadata_json, '$.action') = 'created'
           AND COALESCE(json_extract(metadata_json, '$.taskGroupId'), json_extract(metadata_json, '$.groupId')) = ?
           AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
         ORDER BY created_at ASC LIMIT 1`,
      ).get(workspace.id, taskGroupId, senderId, recipientId, recipientId, senderId);
      if (!created || created.sender_user_id !== senderId) {
        throw cloudApiError(action === 'renamed' ? 'task_group_rename_forbidden' : 'task_group_dissolve_forbidden', action === 'renamed' ? '只有群聊发起人可以修改群聊名称。' : '只有群聊发起人可以解散任务群聊。', 403);
      }
      metadata.initiatorUserId = created.sender_user_id;
      if (action === 'renamed') metadata.groupTitle = String(metadata.groupTitle || metadata.title || '').trim().slice(0, 80);
    }
  }
  const id = String(payload.clientMessageId || '').trim().slice(0, 200) || `social_msg_${crypto.randomUUID()}`;
  const existing = db.prepare('SELECT * FROM social_messages WHERE id=?').get(id);
  if (existing) {
    if (existing.sender_user_id !== senderId || existing.recipient_user_id !== recipientId
      || existing.content !== content.slice(0, 8000) || existing.title !== String(payload.title || '').slice(0, 160)) {
      throw cloudApiError('social_message_idempotency_conflict', '消息幂等键已被不同请求占用。', 409);
    }
    return { ok: true, idempotent: true, message: hydratedCloudSocialMessage(db, id) };
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO social_messages (
      id, account_workspace_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
      kind, title, content, metadata_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, workspace.id, senderId, recipientId,
    String(payload.senderAgentId || '').slice(0, 80),
    String(payload.recipientAgentId || '').slice(0, 80),
    normalizeCloudMessageKind(payload.kind),
    String(payload.title || '').slice(0, 160),
    content.slice(0, 8000),
    JSON.stringify(metadata),
    now, now,
  );
  if (selfMessage) db.prepare("UPDATE social_messages SET status='read',read_at=?,updated_at=? WHERE id=?").run(now, now, id);
  return { ok: true, message: hydratedCloudSocialMessage(db, id) };
}

function updateCloudSocialMessage(db, senderId, messageId, payload = {}) {
  const current = db.prepare('SELECT * FROM social_messages WHERE id = ? AND sender_user_id = ?').get(String(messageId || ''), senderId);
  if (!current) throw cloudApiError('message_not_found', '\u6d88\u606f\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u4fee\u6539\u3002', 404);
  const workspace = requireCloudAccountWorkspace(db, senderId, payload.workspaceId);
  if (current.account_workspace_id !== workspace.id) throw cloudApiError('message_not_found', '消息不存在或无权修改。', 404);
  const currentMetadata = cloudJsonObject(current.metadata_json);
  const withdraw = String(payload.action || '').toLowerCase() === 'withdraw';
  const directPersonMessage = currentMetadata.type === 'direct_message'
    && current.kind === 'friend'
    && !String(current.sender_agent_id || '').trim()
    && !String(current.recipient_agent_id || '').trim()
    && current.sender_user_id !== current.recipient_user_id;
  const delegationComment = currentMetadata.type === 'agent_delegation_comment';
  if (!delegationComment && !(withdraw && directPersonMessage)) {
    throw cloudApiError('message_update_forbidden', withdraw ? '只能撤回自己发送的自然人私聊消息。' : '\u53ea\u80fd\u4fee\u6539\u59d4\u6258\u7684\u8865\u5145\u6d88\u606f\u3002', 403);
  }
  if (withdraw && directPersonMessage) {
    const ageMs = Date.now() - new Date(current.created_at || 0).getTime();
    if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > 2 * 60 * 1000) {
      throw cloudApiError('message_withdraw_expired', '消息发送超过2分钟，无法撤回。', 409);
    }
  }
  const content = withdraw ? current.content : String(payload.content ?? current.content ?? '').trim();
  if (!withdraw && !content) throw cloudApiError('message_required', '\u4fee\u6539\u540e\u7684\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002', 400);
  const now = new Date().toISOString();
  const metadata = {
    ...currentMetadata,
    ...cloudJsonObject(payload.metadata),
    ...(withdraw ? { withdrawn: true, withdrawnAt: now } : { withdrawn: false, edited: true, editedAt: now }),
  };
  db.prepare('UPDATE social_messages SET content = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND sender_user_id = ?')
    .run(content.slice(0, 8000), JSON.stringify(metadata), now, current.id, senderId);
  return { ok: true, message: hydratedCloudSocialMessage(db, current.id) };
}

function markCloudSocialMessageRead(db, userId, messageId, payload = {}) {
  const current = db.prepare('SELECT account_workspace_id FROM social_messages WHERE id=? AND recipient_user_id=?').get(String(messageId || ''), userId);
  if (!current) throw cloudApiError('message_not_found', '消息不存在。', 404);
  const workspace = requireCloudAccountWorkspace(db, userId, payload.workspaceId);
  if (current.account_workspace_id !== workspace.id) throw cloudApiError('message_not_found', '消息不存在。', 404);
  const now = new Date().toISOString();
  const result = db.prepare(
    "UPDATE social_messages SET status = 'read', read_at = ?, updated_at = ? WHERE id = ? AND recipient_user_id = ?",
  ).run(now, now, String(messageId || ''), userId);
  if (!Number(result.changes || 0)) throw cloudApiError('message_not_found', '消息不存在。', 404);
  return { ok: true, message: hydratedCloudSocialMessage(db, messageId) };
}

function requireCloudAccountWorkspace(db, userId = '', workspaceId = '') {
  const requested = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
  const workspace = db.prepare(`SELECT workspace.* FROM account_workspaces workspace
    JOIN account_workspace_memberships membership ON membership.workspace_id=workspace.id
    WHERE workspace.id=? AND workspace.status='active' AND membership.user_id=? AND membership.status='active'`).get(requested, userId);
  if (!workspace) throw cloudApiError('account_workspace_forbidden', '工作空间不存在或你已不在该工作空间中。', 403);
  return workspace;
}

function requireCloudWorkspaceMessagingPeer(db, workspace, senderId = '', recipientId = '') {
  if (!recipientId) throw cloudApiError('recipient_required', '请选择有效联系人。', 400);
  if (workspace.workspace_kind === 'organization') {
    const membership = db.prepare(`SELECT 1 FROM account_workspace_memberships
      WHERE workspace_id=? AND user_id=? AND status='active'`).get(workspace.id, recipientId);
    if (!membership) throw cloudApiError('account_workspace_peer_forbidden', '只能给当前组织工作空间中的成员发送消息。', 403);
    return true;
  }
  return requireCloudMessagingFriend(db, senderId, recipientId, { allowSelf: true });
}

function updateCloudPresence(db, userId, payload = {}) {
  const deviceId = String(payload.deviceId || '').trim();
  if (!deviceId) throw cloudApiError('device_id_required', '缺少设备 ID。', 400);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_presence (user_id, device_id, platform, arch, hostname, status, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'online', ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       platform = excluded.platform, arch = excluded.arch, hostname = excluded.hostname,
       status = 'online', last_seen_at = excluded.last_seen_at`,
  ).run(userId, deviceId, String(payload.platform || ''), String(payload.arch || ''), String(payload.hostname || ''), now);
  return { ok: true, onlineUntil: new Date(Date.now() + 45_000).toISOString() };
}

export {
  searchCloudUsers,
  cloudFriendsOverview,
  createCloudFriendRequest,
  updateCloudFriendRequest,
  acceptCloudFriendRequestRow,
  removeCloudFriend,
  updateCloudFriendRemark,
  blockCloudUser,
  listCloudSocialMessages,
  createCloudSocialMessage,
  updateCloudSocialMessage,
  markCloudSocialMessageRead,
  requireCloudAccountWorkspace,
  requireCloudWorkspaceMessagingPeer,
  updateCloudPresence,
};
