import { cloudApiError } from '../../http/index.js';

function cloudPublicUser(row = {}) {
  const role = String(row.role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
  return {
    id: row.friend_id || row.id || '',
    email: row.email || '',
    displayName: row.display_name || '',
    display_name: row.display_name || '',
    username: row.username || '',
    avatarUrl: row.avatar_url || '',
    avatar_url: row.avatar_url || '',
    role,
    isAdmin: role === 'admin',
    is_admin: role === 'admin',
    emailVerified: Boolean(row.email_verified),
    email_verified: Boolean(row.email_verified),
  };
}

function cloudFriendRequestPayload(row, direction) {
  return {
    id: row.id,
    direction,
    requesterId: row.requester_id,
    recipientId: row.recipient_id,
    status: row.status,
    message: row.message || '',
    user: cloudPublicUser(row),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function cloudFriendshipPayload(row) {
  const lastSeenAt = row.last_seen_at || '';
  const remark = String(row.friend_remark || '').trim();
  return {
    id: row.id,
    status: row.status,
    remark,
    friend: { ...cloudPublicUser(row), remark },
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    online: Boolean(lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() <= 45_000),
    lastSeenAt,
  };
}

function cloudFriendshipBetween(db, leftId, rightId) {
  const [userA, userB] = cloudOrderedUserPair(leftId, rightId);
  return db.prepare("SELECT * FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'").get(userA, userB);
}

function cloudUsersBlocked(db, leftId, rightId) {
  return Boolean(db.prepare(
    `SELECT id FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1`,
  ).get(leftId, rightId, rightId, leftId));
}

function requireCloudMessagingFriend(db, senderId, recipientId, { allowSelf = false } = {}) {
  if (!recipientId || (!allowSelf && recipientId === senderId)) throw cloudApiError('invalid_recipient', '请选择有效好友。', 400);
  if (recipientId === senderId) return;
  if (cloudUsersBlocked(db, senderId, recipientId)) throw cloudApiError('blocked_user', '无法联系该用户。', 403);
  if (!cloudFriendshipBetween(db, senderId, recipientId)) throw cloudApiError('friendship_required', '只能联系已添加的好友。', 403);
}

function cloudSocialMessageSelectSql() {
  return `SELECT sm.*,
                 sender.email AS sender_email, sender.display_name AS sender_display_name,
                 sender.username AS sender_username, sender.avatar_url AS sender_avatar_url,
                 sender.role AS sender_role, sender.email_verified AS sender_email_verified,
                 recipient.email AS recipient_email, recipient.display_name AS recipient_display_name,
                 recipient.username AS recipient_username, recipient.avatar_url AS recipient_avatar_url,
                 recipient.role AS recipient_role, recipient.email_verified AS recipient_email_verified
          FROM social_messages sm
          JOIN users sender ON sender.id = sm.sender_user_id
          JOIN users recipient ON recipient.id = sm.recipient_user_id`;
}

function hydratedCloudSocialMessage(db, id) {
  const row = db.prepare(`${cloudSocialMessageSelectSql()} WHERE sm.id = ?`).get(String(id || ''));
  return row ? cloudSocialMessagePayload(row) : null;
}

function cloudSocialMessagePayload(row) {
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    senderUserId: row.sender_user_id,
    recipientUserId: row.recipient_user_id,
    senderAgentId: row.sender_agent_id || '',
    recipientAgentId: row.recipient_agent_id || '',
    kind: normalizeCloudMessageKind(row.kind),
    title: row.title || '',
    content: row.content || '',
    status: row.status || 'unread',
    metadata: cloudJsonObject(row.metadata_json),
    sender: cloudPublicUser({ id: row.sender_user_id, email: row.sender_email, display_name: row.sender_display_name, username: row.sender_username, avatar_url: row.sender_avatar_url, role: row.sender_role, email_verified: row.sender_email_verified }),
    recipient: cloudPublicUser({ id: row.recipient_user_id, email: row.recipient_email, display_name: row.recipient_display_name, username: row.recipient_username, avatar_url: row.recipient_avatar_url, role: row.recipient_role, email_verified: row.recipient_email_verified }),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
    readAt: row.read_at || '',
  };
}

function cloudOrderedUserPair(left, right) {
  return [String(left || ''), String(right || '')].sort();
}

function normalizeCloudCursor(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function cloudJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCloudMessageKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return ['friend', 'agent', 'system'].includes(kind) ? kind : 'friend';
}



export {
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
};
