import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import { normalizeRole, isPhoneOnlyEmail, orderedUserPair, normalizeAgentId, publicUserFromPrefixedRow, normalizeAgentDelegation, publicUser, normalizeFriendRequest, normalizeFriendship, normalizeSocialMessage, normalizeCollaborationGroup, normalizeCollaborationMember, normalizeCollaborationMessage, normalizeSocialMessageKind, parseJsonObject } from '../domain/socialRecords.js';
import { organizationAccountId, personalAccountId } from '../../../../shared/accountWorkspaces.js';
import { toggleMessageReaction } from '../../../../shared/messageReactions.js';

const DIRECT_MESSAGE_WITHDRAW_WINDOW_MS = 2 * 60 * 1000;

export function installFriendMessagingMethods(prototype) {
  Object.assign(prototype, {
  ensureSocialDirectConversation({ senderUserId = '', recipientUserId = '', workspaceId = '' } = {}) {
    const current = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, current.id, workspaceId || this.accountWorkspaceContext?.());
    return ensureSocialDirectConversation(this.db, workspace, senderUserId || current.id, recipientUserId || current.id, current.id);
  },

  searchUsers({ query = '', limit = 20 } = {}) {
    const user = this.requireUser();
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const rows = all(
      this.db,
      `SELECT *
       FROM auth_users
       WHERE id <> ?
         AND (
           lower(email) LIKE ?
           OR lower(display_name) LIKE ?
           OR lower(username) LIKE ?
           OR lower(id) LIKE ?
         )
       ORDER BY display_name ASC
       LIMIT ?`,
      [user.id, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, Math.max(1, Math.min(50, Number(limit) || 20))],
    );
    return rows
      .filter((row) => !this.isBlockedEitherWay(user.id, row.id))
      .map((row) => this.userSearchPayload(row, user.id));
  },

  listFriendRequests() {
    const user = this.requireUser();
    const incoming = all(
      this.db,
      `SELECT fr.*, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified
       FROM friend_requests fr
       JOIN auth_users u ON u.id = fr.requester_id
       WHERE fr.recipient_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [user.id],
    ).map((row) => normalizeFriendRequest(row, 'incoming'));
    const outgoing = all(
      this.db,
      `SELECT fr.*, u.email, u.display_name, u.username, u.avatar_url, u.role, u.email_verified
       FROM friend_requests fr
       JOIN auth_users u ON u.id = fr.recipient_id
       WHERE fr.requester_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [user.id],
    ).map((row) => normalizeFriendRequest(row, 'outgoing'));
    return { incoming, outgoing };
  },

  listFriends({ workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    if (workspace.workspace_kind === 'organization') {
      return all(this.db, `SELECT ('organization_member:' || membership.organization_id || ':' || membership.user_id) AS id,
          'accepted' AS status,COALESCE(remark.remark,'') AS friend_remark,membership.joined_at AS created_at,membership.updated_at,
          u.id AS friend_id,u.email,u.phone,COALESCE(NULLIF(membership.display_name_override,''),u.display_name) AS display_name,
          u.display_name AS account_display_name,u.username,u.avatar_url,u.remote_id,u.role,u.email_verified
        FROM contact_organization_members membership JOIN auth_users u ON u.id=membership.user_id
        LEFT JOIN social_contact_remarks remark ON remark.owner_user_id=? AND remark.target_user_id=membership.user_id
        WHERE membership.organization_id=? AND membership.user_id<>?
        ORDER BY lower(COALESCE(NULLIF(membership.display_name_override,''),u.display_name)),u.id`, [user.id, workspace.organization_id, user.id]).map(normalizeFriendship);
    }
    return all(
      this.db,
      `SELECT f.*, u.id AS friend_id, u.email, u.phone, u.display_name, u.display_name AS account_display_name,
              u.username, u.avatar_url, u.remote_id, u.role, u.email_verified,
              COALESCE(NULLIF(remark.remark,''),CASE WHEN f.user_a_id = ? THEN f.user_a_remark ELSE f.user_b_remark END) AS friend_remark
       FROM friendships f
       JOIN auth_users u ON u.id = CASE WHEN f.user_a_id = ? THEN f.user_b_id ELSE f.user_a_id END
       LEFT JOIN social_contact_remarks remark ON remark.owner_user_id=? AND remark.target_user_id=u.id
       WHERE (f.user_a_id = ? OR f.user_b_id = ?) AND f.status = 'accepted'
       ORDER BY f.updated_at DESC`,
      [user.id, user.id, user.id, user.id, user.id],
    ).map(normalizeFriendship);
  },

  friendsOverview({ workspaceId = '' } = {}) {
    const user = this.requireUser();
    // Validate the requested/current Workspace even though the address book itself
    // remains account-global. This also repairs a stale implicit preference by
    // falling back to the personal Workspace without touching user content.
    resolveAccountWorkspaceForSocial(
      this.db,
      user.id,
      workspaceId || this.accountWorkspaceContext?.(),
    );
    const organization = this.organizationOverview();
    return {
      friends: this.listFriends({ workspaceId: 'workspace_personal' }),
      requests: this.listFriendRequests(),
      organizations: organization.organizations,
      organizationExitRequests: organization.organizationExitRequests || [],
      organizationNotices: organization.organizationNotices || [],
    };
  },

  socialInbox({ limit = 50, workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const params = [accountId, user.id, user.id, user.id, Math.max(1, Math.min(100, Number(limit) || 50))];
    const rows = all(
      this.db,
      `SELECT sm.*,
              u.id AS sender_id, u.email AS sender_email, u.display_name AS sender_display_name,
              u.username AS sender_username, u.avatar_url AS sender_avatar_url, u.role AS sender_role,
              u.email_verified AS sender_email_verified
       FROM social_messages sm
       LEFT JOIN auth_users u ON u.id = sm.sender_user_id
       WHERE EXISTS (SELECT 1 FROM conversation_account_bindings binding
         WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status IN ('active','read_only'))
         AND sm.recipient_user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = ? AND b.blocked_id = sm.sender_user_id)
              OR (b.blocker_id = sm.sender_user_id AND b.blocked_id = ?)
         )
       ORDER BY sm.created_at DESC
       LIMIT ?`,
      params,
    );
    return rows.map(normalizeSocialMessage);
  },

  socialInboxAllWorkspaces({ limit = 200 } = {}) {
    return this.socialInbox({ limit: Math.max(1, Math.min(1000, Number(limit) || 200)) });
  },

  socialConversation({ peerId = '', limit = 200, workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const targetId = String(peerId || '').trim();
    if (!targetId) return [];
    const params = [accountId, user.id, targetId, targetId, user.id, Math.max(1, Math.min(500, Number(limit) || 200))];
    return all(
      this.db,
      `SELECT recent.*,
              u.id AS sender_id, u.email AS sender_email, u.display_name AS sender_display_name,
              u.username AS sender_username, u.avatar_url AS sender_avatar_url, u.role AS sender_role,
              u.email_verified AS sender_email_verified
       FROM (
         SELECT sm.*
         FROM social_messages sm
         WHERE EXISTS (SELECT 1 FROM conversation_account_bindings binding
           WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status IN ('active','read_only'))
           AND ((sm.sender_user_id = ? AND sm.recipient_user_id = ?)
            OR (sm.sender_user_id = ? AND sm.recipient_user_id = ?))
         ORDER BY sm.created_at DESC, sm.id DESC
         LIMIT ?
       ) recent
       LEFT JOIN auth_users u ON u.id = recent.sender_user_id
       ORDER BY recent.created_at ASC, recent.id ASC`,
      params,
    ).map(normalizeSocialMessage);
  },

  socialConversationSummaries({ messagesPerThread = 100, limit = 100, workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const perThread = Math.max(1, Math.min(200, Number(messagesPerThread) || 100));
    const threadLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const rows = all(
      this.db,
      `WITH ranked AS (
         SELECT sm.*,
                CASE WHEN sm.sender_user_id = ? THEN sm.recipient_user_id ELSE sm.sender_user_id END AS peer_user_id,
                ROW_NUMBER() OVER (
                  PARTITION BY CASE WHEN sm.sender_user_id = ? THEN sm.recipient_user_id ELSE sm.sender_user_id END
                  ORDER BY sm.created_at DESC, sm.id DESC
                ) AS thread_row_number
         FROM social_messages sm
         WHERE EXISTS (SELECT 1 FROM conversation_account_bindings binding
           WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status IN ('active','read_only'))
           AND (sm.sender_user_id = ? OR sm.recipient_user_id = ?)
       )
       SELECT ranked.*,
              sender.id AS sender_id, sender.email AS sender_email, sender.display_name AS sender_display_name,
              sender.username AS sender_username, sender.avatar_url AS sender_avatar_url, sender.role AS sender_role,
              sender.email_verified AS sender_email_verified,
              peer.id AS peer_id, peer.email AS peer_email, peer.display_name AS peer_display_name,
              peer.username AS peer_username, peer.avatar_url AS peer_avatar_url, peer.role AS peer_role,
              peer.email_verified AS peer_email_verified
       FROM ranked
       LEFT JOIN auth_users sender ON sender.id = ranked.sender_user_id
       LEFT JOIN auth_users peer ON peer.id = ranked.peer_user_id
       WHERE ranked.thread_row_number <= ?
       ORDER BY ranked.created_at ASC, ranked.id ASC`,
      [user.id, user.id, accountId, user.id, user.id, perThread],
    );
    const byPeer = new Map();
    for (const row of rows) {
      const peerId = String(row.peer_user_id || '').trim();
      if (!peerId) continue;
      const thread = byPeer.get(peerId) || {
        friend: publicUserFromPrefixedRow(row, 'peer') || (peerId === user.id ? publicUser(user) : { id: peerId }),
        messages: [],
      };
      thread.messages.push(normalizeSocialMessage(row));
      byPeer.set(peerId, thread);
    }
    const threads = [...byPeer.values()]
      .sort((left, right) => String(right.messages.at(-1)?.createdAt || '').localeCompare(String(left.messages.at(-1)?.createdAt || '')))
      .slice(0, threadLimit);
    return { threads };
  },

  socialSendMessage({ recipientId = '', userId = '', title = '', content = '', senderAgentId = '', recipientAgentId = '', kind = '', metadata = {}, clientMessageId = '', workspaceId = '' } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const targetId = String(recipientId || userId || '').trim();
    if (!targetId) throw new Error('\u8bf7\u9009\u62e9\u6709\u6548\u597d\u53cb\u3002');
    const selfMessage = targetId === user.id;
    const target = this.getUser(targetId);
    if (!target) throw new Error('\u7528\u6237\u4e0d\u5b58\u5728\u3002');
    if (!selfMessage && this.isBlockedEitherWay(user.id, targetId)) throw new Error('\u65e0\u6cd5\u7ed9\u8be5\u7528\u6237\u53d1\u9001\u6d88\u606f\u3002');
    if (!selfMessage) {
      const targetMembership = get(this.db, `SELECT 1 FROM account_workspace_memberships
        WHERE workspace_id=? AND user_id=? AND status='active'`, [workspace.id, targetId]);
      const sharedOrganization = get(this.db, `SELECT 1 FROM account_workspace_memberships actor JOIN account_workspace_memberships target ON target.workspace_id=actor.workspace_id JOIN account_workspaces org ON org.id=actor.workspace_id WHERE actor.user_id=? AND actor.status='active' AND target.user_id=? AND target.status='active' AND org.workspace_kind='organization' LIMIT 1`, [user.id, targetId]);
      if (!targetMembership && !sharedOrganization && !this.friendshipBetween(user.id, targetId)) throw new Error('只能给当前组织成员或已接受的外部联系人发送消息。');
      }
    const cleanContent = String(content || '').trim();
    if (!cleanContent) throw new Error('\u8bf7\u8f93\u5165\u6d88\u606f\u5185\u5bb9\u3002');
    const cleanAgentId = String(senderAgentId || '').trim().slice(0, 80);
    const cleanKind = normalizeSocialMessageKind(kind || (cleanAgentId ? 'agent' : 'friend'));
    const cleanMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    if (selfMessage && (cleanAgentId || String(recipientAgentId || '').trim() || !['', 'direct_message'].includes(String(cleanMetadata.type || '')))) {
      throw new Error('自己与自己的会话只支持普通消息。');
    }
    if (cleanMetadata.type === 'social_task_group_message') {
      const taskGroupId = String(cleanMetadata.taskGroupId || cleanMetadata.groupId || '').trim();
      if (!taskGroupId) throw new Error('缺少任务群聊 ID。');
      const dissolved = get(
        this.db,
        `SELECT 1 FROM social_messages
         WHERE account_workspace_id=? AND json_extract(metadata_json, '$.type') = 'social_task_group'
           AND json_extract(metadata_json, '$.action') = 'dissolved'
           AND COALESCE(json_extract(metadata_json, '$.taskGroupId'), json_extract(metadata_json, '$.groupId')) = ?
           AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
         LIMIT 1`,
        [workspace.id, taskGroupId, user.id, targetId, targetId, user.id],
      );
      if (dissolved) throw new Error('任务群已解散，只能查看历史记录。');
      cleanMetadata.taskGroupId = taskGroupId;
      cleanMetadata.groupId = taskGroupId;
    }
    if (cleanMetadata.type === 'social_task_group') {
      const taskGroupId = String(cleanMetadata.taskGroupId || cleanMetadata.groupId || '').trim();
      const action = String(cleanMetadata.action || '').trim().toLowerCase();
      if (!taskGroupId) throw new Error('\u7f3a\u5c11\u4efb\u52a1\u7fa4\u804a ID\u3002');
      cleanMetadata.taskGroupId = taskGroupId;
      cleanMetadata.groupId = taskGroupId;
      if (action === 'created') {
        cleanMetadata.initiatorUserId = user.id;
      } else if (action === 'dissolved' || action === 'renamed') {
        const created = get(
          this.db,
          `SELECT sender_user_id FROM social_messages
           WHERE account_workspace_id=? AND json_extract(metadata_json, '$.type') = 'social_task_group'
             AND json_extract(metadata_json, '$.action') = 'created'
             AND COALESCE(json_extract(metadata_json, '$.taskGroupId'), json_extract(metadata_json, '$.groupId')) = ?
             AND ((sender_user_id = ? AND recipient_user_id = ?) OR (sender_user_id = ? AND recipient_user_id = ?))
           ORDER BY created_at ASC LIMIT 1`,
          [workspace.id, taskGroupId, user.id, targetId, targetId, user.id],
        );
        if (!created || created.sender_user_id !== user.id) throw new Error(action === 'renamed' ? '只有群聊发起人可以修改群聊名称。' : '\u53ea\u6709\u7fa4\u804a\u53d1\u8d77\u4eba\u53ef\u4ee5\u89e3\u6563\u4efb\u52a1\u7fa4\u804a\u3002');
        cleanMetadata.initiatorUserId = created.sender_user_id;
        if (action === 'renamed') cleanMetadata.groupTitle = String(cleanMetadata.groupTitle || cleanMetadata.title || '').trim().slice(0, 80);
      }
    }
    const id = String(clientMessageId || '').trim().slice(0, 200) || newId('social_msg');
    const conversationId = ensureSocialDirectConversation(this.db, workspace, user.id, targetId);
    const existing = get(this.db, 'SELECT * FROM social_messages WHERE id=?', [id]);
    if (existing) {
      if (existing.sender_user_id !== user.id || existing.recipient_user_id !== targetId
        || existing.content !== cleanContent.slice(0, 4000) || existing.title !== String(title || '').trim().slice(0, 160)) {
        const error = new Error('消息幂等键已被不同请求占用。');
        error.code = 'social_message_idempotency_conflict';
        throw error;
      }
      return { ok: true, idempotent: true, message: this.socialMessageById(id, { workspaceId: workspace.id }), inbox: this.socialInbox({ workspaceId: workspace.id }) };
    }
    run(
      this.db,
      `INSERT INTO social_messages (id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id, kind, title, content, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workspace.id,
        conversationId,
        user.id,
        targetId,
        cleanAgentId,
        String(recipientAgentId || '').trim().slice(0, 80),
        cleanKind,
        String(title || '').trim().slice(0, 160),
        cleanContent.slice(0, 4000),
        JSON.stringify(cleanMetadata),
        nowIso(),
      ],
    );
    if (selfMessage) run(this.db, "UPDATE social_messages SET status = 'read', read_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), id]);
    return { ok: true, message: this.socialMessageById(id, { workspaceId: workspace.id }), inbox: this.socialInbox({ workspaceId: workspace.id }) };
  },

  socialUpdateMessage({ messageId = '', content, metadata = {}, action = 'edit', workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const id = String(messageId || '').trim();
    const row = get(this.db, `SELECT sm.* FROM social_messages sm WHERE sm.id=? AND sm.sender_user_id=?
      AND EXISTS (SELECT 1 FROM conversation_account_bindings binding
        WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status='active')`, [id, user.id, accountId]);
    if (!row) throw new Error('\u6d88\u606f\u4e0d\u5b58\u5728\u6216\u65e0\u6743\u4fee\u6539\u3002');
    const currentMetadata = parseJsonObject(row.metadata_json);
    const withdraw = String(action || '').toLowerCase() === 'withdraw';
    const directPersonMessage = ['', 'direct_message'].includes(String(currentMetadata.type || ''))
      && row.kind === 'friend'
      && !String(row.sender_agent_id || '').trim()
      && !String(row.recipient_agent_id || '').trim();
    const delegationComment = currentMetadata.type === 'agent_delegation_comment';
    if (!delegationComment && !(withdraw && directPersonMessage)) {
      throw new Error(withdraw ? '只能撤回自己发送的自然人私聊消息。' : '\u53ea\u80fd\u4fee\u6539\u59d4\u6258\u7684\u8865\u5145\u6d88\u606f\u3002');
    }
    if (withdraw && directPersonMessage) {
      const ageMs = Date.now() - new Date(row.created_at || 0).getTime();
      if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > DIRECT_MESSAGE_WITHDRAW_WINDOW_MS) {
        throw new Error('消息发送超过2分钟，无法撤回。');
      }
    }
    const now = nowIso();
    const nextContent = withdraw ? row.content : String(content ?? row.content ?? '').trim();
    if (!withdraw && !nextContent) throw new Error('\u4fee\u6539\u540e\u7684\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a\u3002');
    const nextMetadata = {
      ...currentMetadata,
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      ...(withdraw
        ? { withdrawn: true, withdrawnAt: now }
        : { withdrawn: false, edited: true, editedAt: now }),
    };
    run(
      this.db,
      'UPDATE social_messages SET content = ?, metadata_json = ?, updated_at = ? WHERE id = ? AND sender_user_id = ?',
      [nextContent.slice(0, 8000), JSON.stringify(nextMetadata), now, id, user.id],
    );
    return {
      ok: true,
      message: this.socialMessageById(id, { workspaceId: workspace.id }),
      inbox: this.socialInbox({ workspaceId: workspace.id }),
    };
  },


  socialToggleMessageReaction({ messageId = '', emoji = '', workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const id = String(messageId || '').trim();
    const row = get(this.db, `SELECT sm.* FROM social_messages sm WHERE (sm.id=? OR sm.remote_id=?)
      AND (sm.sender_user_id=? OR sm.recipient_user_id=?)
      AND EXISTS (SELECT 1 FROM conversation_account_bindings binding
        WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status='active')`,
      [id, id, user.id, user.id, accountId]);
    if (!row) throw new Error('消息不存在或无权回应。');
    const currentMetadata = parseJsonObject(row.metadata_json);
    const directPersonMessage = ['', 'direct_message'].includes(String(currentMetadata.type || ''))
      && row.kind === 'friend'
      && !String(row.sender_agent_id || '').trim()
      && !String(row.recipient_agent_id || '').trim();
    if (!directPersonMessage) throw new Error('只能回应普通私聊消息。');
    if (currentMetadata.withdrawn === true) throw new Error('已撤回的消息不能添加表情。');
    const displayName = user.displayName || user.display_name || user.username || user.email || user.id;
    const now = nowIso();
    const nextMetadata = toggleMessageReaction(currentMetadata, { emoji, userId: user.id, displayName, reactedAt: now });
    run(this.db, 'UPDATE social_messages SET metadata_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(nextMetadata), now, id]);
    return {
      ok: true,
      message: this.socialMessageById(id, { workspaceId: workspace.id, accountGlobal }),
      inbox: this.socialInbox({ workspaceId: workspace.id }),
    };
  },

  socialMessageById(messageId = '', { workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const params = accountGlobal
      ? [String(messageId || ''), String(messageId || ''), user.id, user.id]
      : [String(messageId || ''), String(messageId || ''), accountId, user.id, user.id];
    const row = get(
      this.db,
      `SELECT sm.*,
              u.id AS sender_id, u.email AS sender_email, u.display_name AS sender_display_name,
              u.username AS sender_username, u.avatar_url AS sender_avatar_url, u.role AS sender_role,
              u.email_verified AS sender_email_verified
       FROM social_messages sm
       LEFT JOIN auth_users u ON u.id = sm.sender_user_id
       WHERE (sm.id=? OR sm.remote_id=?) ${accountGlobal ? '' : `AND EXISTS (SELECT 1 FROM conversation_account_bindings binding
         WHERE binding.conversation_id=sm.conversation_id AND binding.account_id=? AND binding.access_status IN ('active','read_only'))`}
         AND (sm.recipient_user_id=? OR sm.sender_user_id=?)`,
      params,
    );
    return row ? normalizeSocialMessage(row) : null;
  },

  socialMarkRead({ messageId = '', workspaceId = '', accountGlobal = false } = {}) {
    const user = this.requireUser();
    const workspace = resolveAccountWorkspaceForSocial(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
    const accountId = socialAccountId(this.db, workspace, user.id);
    const params = [nowIso(), String(messageId || ''), user.id, accountId];
    run(
      this.db,
      `UPDATE social_messages SET status='read',read_at=? WHERE id=? AND recipient_user_id=?
       AND EXISTS (SELECT 1 FROM conversation_account_bindings binding
         WHERE binding.conversation_id=social_messages.conversation_id AND binding.account_id=? AND binding.access_status='active')`,
      params,
    );
    return { ok: true, inbox: this.socialInbox({ workspaceId: workspace.id }) };
  }
  });
}

function resolveAccountWorkspaceForSocial(db, userId = '', workspaceId = '') {
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
  if (!workspace) {
    const error = new Error('工作空间不存在或你已不在该工作空间中。');
    error.code = 'ACCOUNT_WORKSPACE_ACCESS_DENIED';
    throw error;
  }
  return workspace;
}

function socialAccountId(db, workspace = {}, userId = '') {
  const scopeUserId = workspace.workspace_kind === 'personal' ? String(userId || '').trim() : '';
  const accountId = get(db, `SELECT account_id FROM account_workspace_bindings
    WHERE workspace_id=? AND user_id_scope=?`, [workspace.id, scopeUserId])?.account_id
    || (workspace.workspace_kind === 'organization'
      ? organizationAccountId(workspace.organization_id)
      : personalAccountId(scopeUserId));
  const now = nowIso();
  if (accountId && !get(db, 'SELECT 1 FROM accounts WHERE id=?', [accountId])) {
    run(db, `INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)`, [
      accountId, workspace.workspace_kind === 'organization' ? 'organization' : 'personal',
      workspace.workspace_kind === 'organization' ? workspace.owner_user_id || '' : scopeUserId,
      workspace.workspace_kind === 'organization' ? workspace.organization_id || '' : '',
      workspace.workspace_kind === 'organization' ? workspace.name || '未命名组织' : '个人账号', now, now,
    ]);
  }
  if (accountId && !get(db, 'SELECT 1 FROM account_workspace_bindings WHERE workspace_id=? AND user_id_scope=?', [workspace.id, scopeUserId])) {
    run(db, `INSERT INTO account_workspace_bindings(account_id,workspace_id,user_id_scope,binding_kind,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`, [accountId, workspace.id, scopeUserId, workspace.workspace_kind, now, now]);
  }
  if (accountId && !get(db, 'SELECT 1 FROM account_memberships WHERE account_id=? AND user_id=?', [accountId, userId])) {
    const legacy = get(db, `SELECT role,status,joined_at,updated_at FROM account_workspace_memberships
      WHERE workspace_id=? AND user_id=?`, [workspace.id, userId]);
    if (legacy) run(db, `INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
      VALUES(?,?,?,?,?,?)`, [accountId, userId, legacy.role || 'member', legacy.status || 'active', legacy.joined_at || now, legacy.updated_at || now]);
  }
  if (!accountId || !get(db, `SELECT 1 FROM account_memberships
    WHERE account_id=? AND user_id=? AND status='active'`, [accountId, userId])) {
    const error = new Error('账号不存在或你已不在该账号中。');
    error.code = 'ACCOUNT_ACCESS_DENIED';
    throw error;
  }
  return accountId;
}

function ensureSocialDirectConversation(db, workspace = {}, senderUserId = '', recipientUserId = '', authorizedUserId = senderUserId) {
  const [userA, userB] = [String(senderUserId || ''), String(recipientUserId || '')].sort();
  const organizationDirect = workspace.workspace_kind === 'organization';
  const anchorAccountId = organizationDirect ? socialAccountId(db, workspace, authorizedUserId) : '';
  const kind = organizationDirect ? 'organization_direct' : 'personal_direct';
  const conversationId = `social_direct:${kind}:${encodeURIComponent(anchorAccountId || 'personal')}:${encodeURIComponent(userA)}:${encodeURIComponent(userB)}`;
  const now = nowIso();
  run(db, `INSERT INTO social_direct_conversations(
      id,conversation_kind,anchor_account_id,user_a_id,user_b_id,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,'active',?,?) ON CONFLICT(conversation_kind,anchor_account_id,user_a_id,user_b_id) DO UPDATE SET
    status='active',updated_at=excluded.updated_at`, [conversationId, kind, anchorAccountId, userA, userB, now, now]);
  const accountIds = organizationDirect ? [anchorAccountId] : [personalAccountId(userA), personalAccountId(userB)];
  for (const accountId of new Set(accountIds.filter(Boolean))) {
    if (!get(db, 'SELECT 1 FROM accounts WHERE id=?', [accountId])) {
      const ownerUserId = accountId === personalAccountId(userA) ? userA : userB;
      run(db, `INSERT INTO accounts(id,account_kind,owner_user_id,organization_id,name,status,created_at,updated_at)
        VALUES(?,'personal',?,'','个人账号','external',?,?)`, [accountId, ownerUserId, now, now]);
      run(db, `INSERT INTO account_memberships(account_id,user_id,role,status,joined_at,updated_at)
        VALUES(?,?,'owner','active',?,?)`, [accountId, ownerUserId, now, now]);
    }
    run(db, `INSERT INTO conversation_account_bindings(
        conversation_id,account_id,binding_role,access_status,created_at,updated_at
      ) VALUES(?,?,?,'active',?,?) ON CONFLICT(conversation_id,account_id) DO UPDATE SET
      access_status='active',updated_at=excluded.updated_at`, [
      conversationId, accountId, organizationDirect ? 'anchor' : 'participant', now, now,
    ]);
  }
  return conversationId;
}
