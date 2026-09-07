import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import { normalizeRole, isPhoneOnlyEmail, orderedUserPair, normalizeAgentId, publicUserFromPrefixedRow, normalizeAgentDelegation, publicUser, normalizeFriendRequest, normalizeFriendship, normalizeSocialMessage, normalizeCollaborationGroup, normalizeCollaborationMember, normalizeCollaborationMessage, normalizeSocialMessageKind, parseJsonObject } from '../domain/socialRecords.js';

export function installFriendshipMethods(prototype) {
  Object.assign(prototype, {
  sendFriendRequest({ userId = '', message = '' } = {}) {
    const user = this.requireUser();
    const targetId = String(userId || '').trim();
    if (!targetId || targetId === user.id) throw new Error('请选择有效用户。');
    const target = this.getUser(targetId);
    if (!target) throw new Error('用户不存在。');
    if (this.isBlockedEitherWay(user.id, targetId)) throw new Error('无法向该用户发送好友申请。');
    if (this.friendshipBetween(user.id, targetId)) throw new Error('你们已经是好友。');
    const reverse = get(
      this.db,
      "SELECT * FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      [targetId, user.id],
    );
    if (reverse) return this.acceptFriendRequest({ requestId: reverse.id });
    const existing = get(
      this.db,
      "SELECT * FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      [user.id, targetId],
    );
    if (existing) throw new Error('好友申请已发送。');
    const id = newId('friend_req');
    run(
      this.db,
      `INSERT INTO friend_requests (id, requester_id, recipient_id, message, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, user.id, targetId, String(message || '').trim().slice(0, 200), nowIso()],
    );
    return { ok: true, requestId: id, overview: this.friendsOverview() };
  },

  acceptFriendRequest({ requestId = '' } = {}) {
    const user = this.requireUser();
    const row = get(this.db, 'SELECT * FROM friend_requests WHERE id = ?', [String(requestId || '')]);
    if (!row || row.status !== 'pending') throw new Error('好友申请不存在或已处理。');
    if (row.recipient_id !== user.id) throw new Error('无权处理该好友申请。');
    const [userA, userB] = orderedUserPair(row.requester_id, row.recipient_id);
    run(this.db, "UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    run(
      this.db,
      `INSERT INTO friendships (id, user_a_id, user_b_id, status, updated_at)
       VALUES (?, ?, ?, 'accepted', ?)
       ON CONFLICT(user_a_id, user_b_id) DO UPDATE SET status = 'accepted', updated_at = excluded.updated_at`,
      [newId('friendship'), userA, userB, nowIso()],
    );
    return { ok: true, overview: this.friendsOverview() };
  },

  rejectFriendRequest({ requestId = '' } = {}) {
    return this.closeFriendRequest(requestId, 'rejected', true);
  },

  cancelFriendRequest({ requestId = '' } = {}) {
    return this.closeFriendRequest(requestId, 'cancelled', false);
  },

  closeFriendRequest(requestId, status, recipientOnly) {
    const user = this.requireUser();
    const row = get(this.db, 'SELECT * FROM friend_requests WHERE id = ?', [String(requestId || '')]);
    if (!row || row.status !== 'pending') throw new Error('好友申请不存在或已处理。');
    const allowed = recipientOnly ? row.recipient_id === user.id : row.requester_id === user.id;
    if (!allowed) throw new Error('无权处理该好友申请。');
    run(this.db, 'UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), row.id]);
    return { ok: true, overview: this.friendsOverview() };
  },

  removeFriend({ userId = '' } = {}) {
    const user = this.requireUser();
    const targetId = String(userId || '').trim();
    const [userA, userB] = orderedUserPair(user.id, targetId);
    run(this.db, "UPDATE friendships SET status = 'removed', updated_at = ? WHERE user_a_id = ? AND user_b_id = ?", [nowIso(), userA, userB]);
    return { ok: true, overview: this.friendsOverview() };
  },

  updateFriendRemark({ userId = '', remark = '' } = {}) {
    const user = this.requireUser();
    const targetId = String(userId || '').trim();
    if (!targetId || targetId === user.id) throw new Error('请选择有效联系人。');
    const friendship = this.friendshipBetween(user.id, targetId);
    const sharedOrganization = get(this.db, `SELECT 1 FROM contact_organization_members own
      JOIN contact_organization_members target ON target.organization_id=own.organization_id
      WHERE own.user_id=? AND target.user_id=? LIMIT 1`, [user.id, targetId]);
    if (!friendship && !sharedOrganization) throw new Error('联系人不存在或已不在你的通讯录中。');
    const cleanRemark = String(remark || '').trim().slice(0, 40);
    const now = nowIso();
    run(this.db, `INSERT INTO social_contact_remarks(owner_user_id,target_user_id,remark,created_at,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(owner_user_id,target_user_id) DO UPDATE SET remark=excluded.remark,updated_at=excluded.updated_at`,
    [user.id, targetId, cleanRemark, now, now]);
    if (friendship) {
      const column = friendship.user_a_id === user.id ? 'user_a_remark' : 'user_b_remark';
      run(this.db, `UPDATE friendships SET ${column} = ?, updated_at = ? WHERE id = ?`, [cleanRemark, now, friendship.id]);
    }
    return { ok: true, remark: cleanRemark, overview: this.friendsOverview() };
  },

  blockUser({ userId = '' } = {}) {
    const user = this.requireUser();
    const targetId = String(userId || '').trim();
    if (!targetId || targetId === user.id) throw new Error('请选择有效用户。');
    run(
      this.db,
      `INSERT INTO user_blocks (id, blocker_id, blocked_id)
       VALUES (?, ?, ?)
       ON CONFLICT(blocker_id, blocked_id) DO NOTHING`,
      [newId('block'), user.id, targetId],
    );
    this.removeFriend({ userId: targetId });
    run(this.db, "UPDATE friend_requests SET status = 'cancelled', updated_at = ? WHERE (requester_id = ? AND recipient_id = ?) OR (requester_id = ? AND recipient_id = ?)", [nowIso(), user.id, targetId, targetId, user.id]);
    return { ok: true, overview: this.friendsOverview() };
  },

  friendshipBetween(leftId, rightId) {
    const [userA, userB] = orderedUserPair(leftId, rightId);
    return get(
      this.db,
      "SELECT * FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'",
      [userA, userB],
    );
  },

  isBlockedEitherWay(leftId, rightId) {
    return Boolean(get(
      this.db,
      `SELECT id FROM user_blocks
       WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`,
      [leftId, rightId, rightId, leftId],
    ));
  },

  userSearchPayload(row, currentUserId) {
    const pendingOutgoing = get(
      this.db,
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      [currentUserId, row.id],
    );
    const pendingIncoming = get(
      this.db,
      "SELECT id FROM friend_requests WHERE requester_id = ? AND recipient_id = ? AND status = 'pending'",
      [row.id, currentUserId],
    );
    return {
      ...publicUser(row),
      friendshipStatus: this.friendshipBetween(currentUserId, row.id) ? 'accepted' : pendingOutgoing ? 'outgoing_pending' : pendingIncoming ? 'incoming_pending' : 'none',
      requestId: pendingOutgoing?.id || pendingIncoming?.id || '',
    };
  }
  });
}
