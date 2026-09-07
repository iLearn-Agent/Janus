import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';
import { normalizeChatGroup, normalizeChatGroupMember, normalizeChatGroupMessage } from '../domain/socialRecords.js';
import { toggleMessageReaction } from '../../../../shared/messageReactions.js';

const CHAT_GROUP_MESSAGE_WITHDRAW_WINDOW_MS = 2 * 60 * 1000;

export function installChatGroupMethods(prototype) {
  Object.assign(prototype, {
    chatGroupsOverview({ workspaceId = '' } = {}) {
      ensureChatGroupRemarkColumn(this.db);
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const groups = all(this.db, `SELECT chat.*,membership.user_id AS membership_user_id,
          membership.role AS membership_role,membership.status AS membership_status,membership.remark AS membership_remark,
          (SELECT COUNT(*) FROM chat_group_members member WHERE member.group_id=chat.id AND member.status='active') AS member_count,
          (SELECT COUNT(*) FROM chat_group_messages message WHERE message.group_id=chat.id
            AND message.sender_user_id<>? AND message.created_at>COALESCE(membership.last_read_at,'')) AS unread_count,
          (SELECT printf('%s：%s',
              COALESCE(NULLIF(sender_member.display_name_override,''),NULLIF(sender.display_name,''),
                NULLIF(sender.username,''),NULLIF(sender.email,''),NULLIF(message.sender_agent_id,''),
                NULLIF(message.sender_user_id,''),'系统'),
              CASE WHEN json_extract(message.metadata_json,'$.withdrawn')=1 THEN '消息已撤回' ELSE message.content END)
            FROM chat_group_messages message
            LEFT JOIN auth_users sender ON sender.id=message.sender_user_id
            LEFT JOIN chat_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
            WHERE message.group_id=chat.id ORDER BY message.created_at DESC,message.id DESC LIMIT 1) AS last_message,
          (SELECT CASE WHEN json_extract(message.metadata_json,'$.withdrawn')=1 THEN '消息已撤回' ELSE message.content END
            FROM chat_group_messages message
            WHERE message.group_id=chat.id ORDER BY message.created_at DESC,message.id DESC LIMIT 1) AS last_message_content,
          (SELECT message.sender_user_id FROM chat_group_messages message
            WHERE message.group_id=chat.id ORDER BY message.created_at DESC,message.id DESC LIMIT 1) AS last_message_sender_user_id,
          (SELECT COALESCE(NULLIF(sender_member.display_name_override,''),NULLIF(sender.display_name,''),
              NULLIF(sender.username,''),NULLIF(sender.email,''),NULLIF(message.sender_agent_id,''),
              NULLIF(message.sender_user_id,''),'系统')
            FROM chat_group_messages message
            LEFT JOIN auth_users sender ON sender.id=message.sender_user_id
            LEFT JOIN chat_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
            WHERE message.group_id=chat.id ORDER BY message.created_at DESC,message.id DESC LIMIT 1) AS last_message_sender_name
        FROM chat_groups chat JOIN chat_group_members membership ON membership.group_id=chat.id AND membership.user_id=?
        WHERE chat.account_workspace_id=? AND membership.status IN ('active','left','removed')
        ORDER BY CASE WHEN chat.status='active' THEN 0 ELSE 1 END,chat.updated_at DESC,chat.id`, [user.id, user.id, workspace.id])
        .map(normalizeChatGroup);
      return { capability: 'chat-groups-v2', audienceScope: 'account_social', groups: this.decorateConversationGroups(groups, 'chat_group') };
    },

    chatGroup(groupId = '', { workspaceId = '', markRead = true } = {}) {
      ensureChatGroupRemarkColumn(this.db);
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const id = String(groupId || '').trim();
      const membership = get(this.db, 'SELECT * FROM chat_group_members WHERE group_id=? AND user_id=?', [id, user.id]);
      const groupRow = get(this.db, 'SELECT * FROM chat_groups WHERE id=? AND account_workspace_id=?', [id, workspace.id]);
      if (!groupRow || !membership) throw new Error('群聊不存在或你已不在群内。');
      syncChatGroupConversation(this.db, groupRow);
      const lowerBound = groupRow.history_visibility === 'full' ? '' : membership.joined_at || '';
      const upperBound = ['left', 'removed'].includes(membership.status) ? membership.left_at || '' : '';
      const members = all(this.db, `SELECT member.*,user.email,
          COALESCE(NULLIF(member.display_name_override,''),user.display_name) AS display_name,
          user.display_name AS account_display_name,user.username,user.avatar_url,user.role AS user_role,user.email_verified
        FROM chat_group_members member JOIN auth_users user ON user.id=member.user_id
        WHERE member.group_id=? ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,member.joined_at,member.user_id`, [id])
        .map(normalizeChatGroupMember);
      const messages = all(this.db, `SELECT message.*,user.email AS sender_email,
          COALESCE(NULLIF(sender_member.display_name_override,''),user.display_name) AS sender_display_name,
          user.username AS sender_username,user.avatar_url AS sender_avatar_url,user.role AS sender_role,user.email_verified AS sender_email_verified
        FROM chat_group_messages message LEFT JOIN auth_users user ON user.id=message.sender_user_id
        LEFT JOIN chat_group_members sender_member ON sender_member.group_id=message.group_id AND sender_member.user_id=message.sender_user_id
        WHERE message.group_id=? AND message.account_workspace_id=?
          AND (?='' OR message.created_at>=?) AND (?='' OR message.created_at<=?)
        ORDER BY message.created_at,message.id`, [id, groupRow.account_workspace_id || 'workspace_personal', lowerBound, lowerBound, upperBound, upperBound])
        .map(normalizeChatGroupMessage)
        .map((message) => attachLocalReceiptDetails(this.db, message, user.id));
      if (markRead && membership.status === 'active') {
        const readAt = nowIso();
        run(this.db, 'UPDATE chat_group_members SET last_read_at=? WHERE group_id=? AND user_id=?', [readAt, id, user.id]);
        run(this.db, `UPDATE chat_group_message_receipts SET read_at=CASE WHEN read_at='' THEN ? ELSE read_at END,updated_at=?
          WHERE group_id=? AND recipient_user_id=? AND read_at=''`, [readAt, readAt, id, user.id]);
      }
      return { group: normalizeChatGroup(groupRow), members, messages, membership: normalizeChatGroupMember(membership) };
    },

    createChatGroup({ title = '', memberIds = [], clientRequestId = '', groupId = '', historyVisibility = 'from_join', metadata = {}, workspaceId = '' } = {}) {
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const cleanMemberIds = [...new Set((Array.isArray(memberIds) ? memberIds : []).map((value) => String(value || '').trim()).filter(Boolean))]
        .filter((id) => id !== user.id).sort();
      if (!cleanMemberIds.length) throw new Error('至少选择 1 位联系人创建群聊。');
      for (const memberId of cleanMemberIds) requireChatPeer(this.db, workspace, user.id, memberId);
      const requestId = String(clientRequestId || '').trim().slice(0, 200) || newId('chat_group_request');
      const existing = get(this.db, `SELECT id FROM chat_groups WHERE account_workspace_id=? AND owner_user_id=? AND client_request_id=?`, [workspace.id, user.id, requestId]);
      const requestedGroupId = String(groupId || '').trim().slice(0, 200);
      const id = requestedGroupId || existing?.id || newId('chat_group');
      const cleanTitle = String(title || '').trim().slice(0, 80) || defaultChatTitle(this.db, cleanMemberIds);
      const now = nowIso();
      const payload = { groupId: id, clientRequestId: requestId, title: cleanTitle, memberIds: cleanMemberIds,
        historyVisibility: historyVisibility === 'full' ? 'full' : 'from_join', workspaceId: workspace.id, metadata: jsonObject(metadata) };
      const idempotencyKey = `chat-group:create:${workspace.id}:${user.id}:${requestId}`;
      if (existing) {
        const prior = get(this.db, 'SELECT payload_hash FROM chat_group_outbox WHERE idempotency_key=?', [idempotencyKey]);
        if (!prior || prior.payload_hash !== hashPayload(payload)) throw new Error('群聊幂等键已被不同请求占用。');
        return { ok: true, idempotent: true, ...this.chatGroup(existing.id, { workspaceId: workspace.id, markRead: false }) };
      }
      if (get(this.db, 'SELECT 1 FROM chat_groups WHERE id=?', [id])) throw new Error('群聊 ID 已被占用。');
      const memberRows = [user.id, ...cleanMemberIds];
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        run(this.db, `INSERT INTO chat_groups(id,account_workspace_id,organization_id,owner_user_id,title,scope_type,chat_mode,
          binding_type,binding_id,history_visibility,status,client_request_id,metadata_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'conversation','manual','',?,'active',?,?,?,?)`, [id, workspace.id, workspace.organization_id || '', user.id,
          cleanTitle, chatGroupScopeType(this.db, workspace, cleanMemberIds), payload.historyVisibility,
          requestId, JSON.stringify(payload.metadata), now, now]);
        for (const memberId of memberRows) run(this.db, `INSERT INTO chat_group_members(group_id,user_id,role,status,invited_by_user_id,joined_at)
          VALUES(?,?,?,'active',?,?)`, [id, memberId, memberId === user.id ? 'owner' : 'member', user.id, now]);
        insertChatSystemMessage(this.db, { groupId: id, workspaceId: workspace.id, senderUserId: user.id,
          content: `群聊“${cleanTitle}”已创建。`, metadata: { type: 'chat_group_created', memberIds: memberRows }, createdAt: now });
        queueChatGroupOutbox(this.db, { workspaceId: workspace.id, operationKind: 'create_group', aggregateId: id,
          idempotencyKey, payload });
        syncChatGroupConversation(this.db, get(this.db, 'SELECT * FROM chat_groups WHERE id=?', [id]));
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return { ok: true, ...this.chatGroup(id, { workspaceId: workspace.id, markRead: false }) };
    },

    sendChatGroupMessage({ groupId = '', content = '', clientMessageId = '', sourceEventId = '', senderAgentId = '', kind = '', metadata = {}, workspaceId = '' } = {}) {
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const id = String(groupId || '').trim();
      const group = get(this.db, 'SELECT * FROM chat_groups WHERE id=? AND account_workspace_id=?', [id, workspace.id]);
      const membership = get(this.db, "SELECT * FROM chat_group_members WHERE group_id=? AND user_id=? AND status='active'", [id, user.id]);
      if (!group || !membership) throw new Error('群聊不存在或你已不在群内。');
      if (group.status !== 'active') throw new Error('群聊已解散，不能继续发送消息。');
      const cleanContent = String(content || '').trim().slice(0, 8000);
      if (!cleanContent) throw new Error('请输入消息内容。');
      const messageId = String(clientMessageId || '').trim().slice(0, 200) || newId('chat_group_msg');
      const cleanMetadata = jsonObject(metadata);
      const cleanSenderAgentId = String(senderAgentId || '').trim() === 'secretary_agent' ? 'secretary_agent' : '';
      const cleanKind = cleanSenderAgentId ? 'agent' : kind === 'system' ? 'system' : 'friend';
      const payload = { groupId: id, clientMessageId: messageId, sourceEventId: String(sourceEventId || '').trim().slice(0, 240),
        content: cleanContent, senderAgentId: cleanSenderAgentId, kind: cleanKind, metadata: cleanMetadata,
        workspaceId: group.account_workspace_id || 'workspace_personal' };
      const existing = get(this.db, 'SELECT * FROM chat_group_messages WHERE id=?', [messageId]);
      if (existing) {
        const existingPayload = { groupId: existing.group_id || '', sourceEventId: existing.source_event_id || '', content: existing.content || '',
          senderAgentId: existing.sender_agent_id || '', kind: existing.kind || 'friend', metadata: parseJson(existing.metadata_json), workspaceId: existing.account_workspace_id || '' };
        if (existing.group_id !== id || hashPayload(existingPayload) !== hashPayload(payload)) {
          throw new Error('消息幂等 ID 已被不同内容占用。');
        }
        return { ok: true, idempotent: true, ...this.chatGroup(id) };
      }
      const now = nowIso();
      run(this.db, `INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,source_event_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [messageId, group.account_workspace_id || 'workspace_personal', id, user.id, cleanSenderAgentId, cleanKind, cleanContent, JSON.stringify(cleanMetadata), payload.sourceEventId, now, now]);
      for (const recipient of all(this.db, "SELECT user_id FROM chat_group_members WHERE group_id=? AND status='active' AND user_id<>?", [id, user.id])) {
        run(this.db, `INSERT INTO chat_group_message_receipts(message_id,group_id,recipient_user_id,created_at,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(message_id,recipient_user_id) DO NOTHING`, [messageId, id, recipient.user_id, now, now]);
      }
      run(this.db, 'UPDATE chat_groups SET updated_at=? WHERE id=?', [now, id]);
      queueChatGroupOutbox(this.db, { workspaceId: group.account_workspace_id || 'workspace_personal', operationKind: 'send_message', aggregateId: id,
        idempotencyKey: `chat-group:message:${id}:${messageId}`, payload });
      syncChatGroupConversation(this.db, get(this.db, 'SELECT * FROM chat_groups WHERE id=?', [id]));
      return { ok: true, ...this.chatGroup(id) };
    },

    markChatGroupRead({ groupId = '', readThroughMessageId = '', workspaceId = '' } = {}) {
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const id = String(groupId || '').trim();
      const target = get(this.db, 'SELECT created_at FROM chat_group_messages WHERE id=? AND group_id=? AND account_workspace_id=?',
        [String(readThroughMessageId || '').trim(), id, workspace.id]);
      const membership = get(this.db, "SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=? AND status='active'", [id, user.id]);
      if (!target || !membership) throw new Error('消息不存在或你已不在群内。');
      const readAt = nowIso();
      run(this.db, `UPDATE chat_group_message_receipts SET read_at=CASE WHEN read_at='' THEN ? ELSE read_at END,updated_at=?
        WHERE group_id=? AND recipient_user_id=? AND message_id IN(
          SELECT id FROM chat_group_messages WHERE group_id=? AND created_at<=?
        )`, [readAt, readAt, id, user.id, id, target.created_at]);
      run(this.db, 'UPDATE chat_group_members SET last_read_at=? WHERE group_id=? AND user_id=?', [readAt, id, user.id]);
      return { ok: true, groupId: id, readThroughMessageId, readAt };
    },

    updateChatGroup({ groupId = '', action = '', userId = '', messageId = '', title = '', displayName = '', remark = '', role = '', emoji = '', clientRequestId = '', workspaceId = '' } = {}) {
      const user = this.requireUser();
      ensureChatGroupRemarkColumn(this.db);
      const activeWorkspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      const id = String(groupId || '').trim();
      const group = get(this.db, 'SELECT * FROM chat_groups WHERE id=? AND account_workspace_id=?', [id, activeWorkspace.id]);
      const actor = get(this.db, "SELECT * FROM chat_group_members WHERE group_id=? AND user_id=? AND status='active'", [id, user.id]);
      if (!group || !actor) throw new Error('群聊不存在或你已不在群内。');
      const cleanAction = String(action || '').trim().toLowerCase();
      const targetId = String(userId || '').trim();
      const targetMessageId = String(messageId || '').trim().slice(0, 200);
      const isManager = ['owner', 'admin'].includes(actor.role);
      const now = nowIso();
      const payload = { groupId: id, action: cleanAction, userId: targetId, messageId: targetMessageId, title: String(title || '').trim().slice(0, 80),
        displayName: String(displayName || '').trim().slice(0, 80), remark: String(remark || '').trim().slice(0, 80),
        role: String(role || '').trim(), emoji: String(emoji || '').trim(), clientRequestId: String(clientRequestId || '').trim() || newId('chat_group_action'),
        workspaceId: group.account_workspace_id || 'workspace_personal' };
      const idempotencyKey = `chat-group:update:${id}:${payload.clientRequestId}`;
      const prior = get(this.db, 'SELECT payload_hash FROM chat_group_outbox WHERE idempotency_key=?', [idempotencyKey]);
      if (prior) {
        if (prior.payload_hash !== hashPayload(payload)) throw new Error('群聊操作幂等键已被不同请求占用。');
        return { ok: true, idempotent: true, ...this.chatGroup(id, { markRead: false }) };
      }
      if (group.status !== 'active' && cleanAction !== 'dissolve') throw new Error('群聊已解散，不能继续修改。');
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
      try {
        if (cleanAction === 'rename') {
          if (!isManager) throw new Error('只有群主或管理员可以修改群名。');
          if (!payload.title) throw new Error('请输入群名。');
          run(this.db, 'UPDATE chat_groups SET title=?,updated_at=? WHERE id=?', [payload.title, now, id]);
        } else if (cleanAction === 'set_display_name') {
          run(this.db, 'UPDATE chat_group_members SET display_name_override=? WHERE group_id=? AND user_id=? AND status=\'active\'', [payload.displayName, id, user.id]);
        } else if (cleanAction === 'set_remark') {
          run(this.db, 'UPDATE chat_group_members SET remark=? WHERE group_id=? AND user_id=?', [payload.remark, id, user.id]);
        } else if (cleanAction === 'add_member') {
          if (!isManager) throw new Error('只有群主或管理员可以添加成员。');
          requireChatPeer(this.db, activeWorkspace, user.id, targetId);
          run(this.db, `INSERT INTO chat_group_members(group_id,user_id,role,status,invited_by_user_id,joined_at,left_at)
            VALUES(?,?,'member','active',?,?,NULL) ON CONFLICT(group_id,user_id) DO UPDATE SET role='member',status='active',
            invited_by_user_id=excluded.invited_by_user_id,joined_at=excluded.joined_at,left_at=NULL`, [id, targetId, user.id, now]);
        } else if (cleanAction === 'remove_member') {
          if (!isManager || targetId === group.owner_user_id) throw new Error('无法移除该成员。');
          run(this.db, "UPDATE chat_group_members SET status='removed',left_at=? WHERE group_id=? AND user_id=? AND status='active'", [now, id, targetId]);
        } else if (cleanAction === 'set_role') {
          if (actor.role !== 'owner' || targetId === group.owner_user_id || !['admin', 'member'].includes(payload.role)) throw new Error('只有群主可以调整管理员。');
          run(this.db, "UPDATE chat_group_members SET role=? WHERE group_id=? AND user_id=? AND status='active'", [payload.role, id, targetId]);
        } else if (cleanAction === 'transfer_owner') {
          if (actor.role !== 'owner' || !targetId || targetId === user.id) throw new Error('请选择新群主。');
          if (!get(this.db, "SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=? AND status='active'", [id, targetId])) throw new Error('新群主必须是当前成员。');
          run(this.db, "UPDATE chat_group_members SET role='member' WHERE group_id=? AND user_id=?", [id, user.id]);
          run(this.db, "UPDATE chat_group_members SET role='owner' WHERE group_id=? AND user_id=?", [id, targetId]);
          run(this.db, 'UPDATE chat_groups SET owner_user_id=?,updated_at=? WHERE id=?', [targetId, now, id]);
        } else if (cleanAction === 'leave') {
          if (actor.role === 'owner') throw new Error('群主退出前需先转让群主或解散群聊。');
          run(this.db, "UPDATE chat_group_members SET status='left',left_at=? WHERE group_id=? AND user_id=?", [now, id, user.id]);
        } else if (cleanAction === 'dissolve') {
          if (actor.role !== 'owner') throw new Error('只有群主可以解散群聊。');
          if (group.status === 'active') run(this.db, "UPDATE chat_groups SET status='dissolved',dissolved_at=?,updated_at=? WHERE id=?", [now, now, id]);
        } else if (cleanAction === 'withdraw_message') {
          const message = targetMessageId ? get(this.db, 'SELECT * FROM chat_group_messages WHERE id=? AND group_id=?', [targetMessageId, id]) : null;
          const metadata = parseJson(message?.metadata_json);
          if (!message || message.sender_user_id !== user.id || message.kind !== 'friend' || String(message.sender_agent_id || '').trim()) {
            throw new Error('只能撤回自己发送的自然人群聊消息。');
          }
          if (metadata.withdrawn === true) throw new Error('这条群聊消息已经撤回。');
          const ageMs = Date.now() - new Date(message.created_at || 0).getTime();
          if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > CHAT_GROUP_MESSAGE_WITHDRAW_WINDOW_MS) {
            throw new Error('消息发送超过2分钟，无法撤回。');
          }
          run(this.db, 'UPDATE chat_group_messages SET metadata_json=?,updated_at=? WHERE id=? AND group_id=?', [
            JSON.stringify({ ...metadata, withdrawn: true, withdrawnAt: now }), now, targetMessageId, id,
          ]);
          run(this.db, 'UPDATE chat_groups SET updated_at=? WHERE id=?', [now, id]);
        } else if (cleanAction === 'toggle_reaction') {
          const message = targetMessageId ? get(this.db, 'SELECT * FROM chat_group_messages WHERE id=? AND group_id=?', [targetMessageId, id]) : null;
          const metadata = parseJson(message?.metadata_json);
          const agentMessage = Boolean(String(message?.sender_agent_id || '').trim());
          if (!message || message.kind !== 'friend' || agentMessage) throw new Error('只能回应自然人群聊消息。');
          if (metadata.withdrawn === true) throw new Error('已撤回的消息不能添加表情。');
          const displayName = user.displayName || user.display_name || user.username || user.email || user.id;
          const nextMetadata = toggleMessageReaction(metadata, { emoji: payload.emoji, userId: user.id, displayName, reactedAt: now });
          run(this.db, 'UPDATE chat_group_messages SET metadata_json=?,updated_at=? WHERE id=? AND group_id=?', [JSON.stringify(nextMetadata), now, targetMessageId, id]);
          run(this.db, 'UPDATE chat_groups SET updated_at=? WHERE id=?', [now, id]);
        } else {
          throw new Error('不支持的群聊操作。');
        }
        queueChatGroupOutbox(this.db, { workspaceId: group.account_workspace_id || 'workspace_personal', operationKind: 'update_group', aggregateId: id,
          idempotencyKey, payload });
        const updated = get(this.db, 'SELECT * FROM chat_groups WHERE id=?', [id]);
        syncChatGroupConversation(this.db, updated);
        if (ownsTransaction) this.db.exec('COMMIT');
      } catch (error) {
        if (ownsTransaction) this.db.exec('ROLLBACK');
        throw error;
      }
      return { ok: true, ...this.chatGroup(id, { markRead: false }) };
    },

    listChatGroupOutbox({ workspaceId = '', limit = 100 } = {}) {
      const user = this.requireUser();
      const workspace = chatAccountWorkspace(this.db, user.id, workspaceId || this.accountWorkspaceContext?.());
      return all(this.db, `SELECT outbox.* FROM chat_group_outbox outbox
        JOIN chat_group_members membership ON membership.group_id=outbox.aggregate_id AND membership.user_id=?
        WHERE outbox.account_workspace_id=? AND outbox.status IN ('pending','failed') AND (outbox.next_attempt_at='' OR outbox.next_attempt_at<=?)
        ORDER BY outbox.created_at,outbox.id LIMIT ?`, [user.id, workspace.id, nowIso(), Math.max(1, Math.min(500, Number(limit) || 100))])
        .map((row) => ({ ...row, payload: parseJson(row.payload_json) }));
    },

    markChatGroupOutbox({ id = '', status = 'completed', error = '' } = {}) {
      const now = nowIso();
      const cleanStatus = status === 'completed' ? 'completed' : 'failed';
      run(this.db, `UPDATE chat_group_outbox SET status=?,attempt_count=attempt_count+1,last_error=?,updated_at=?,completed_at=? WHERE id=?`,
        [cleanStatus, String(error || '').slice(0, 1000), now, cleanStatus === 'completed' ? now : '', String(id || '')]);
      return true;
    },

    importCloudChatGroupResult(result = {}) {
      ensureChatGroupRemarkColumn(this.db);
      const groups = result.group ? [result.group] : Array.isArray(result.groups) ? result.groups : [];
      for (const item of groups) {
        importChatGroupRow(this, item);
        if (item.membership) importChatGroupMemberRow(this, { ...item.membership, groupId: item.id });
      }
      for (const item of Array.isArray(result.members) ? result.members : []) importChatGroupMemberRow(this, item);
      for (const item of Array.isArray(result.messages) ? result.messages : []) importChatGroupMessageRow(this, item);
      const detailGroupId = String(result.group?.id || '').trim();
      const groupId = detailGroupId || String(groups[0]?.id || '').trim();
      if (groupId) {
        const group = get(this.db, 'SELECT * FROM chat_groups WHERE id=?', [groupId]);
        if (group) syncChatGroupConversation(this.db, group);
      }
      if (detailGroupId) return this.chatGroup(detailGroupId, { workspaceId: get(this.db, 'SELECT account_workspace_id FROM chat_groups WHERE id=?', [detailGroupId])?.account_workspace_id, markRead: false });
      return this.chatGroupsOverview({ workspaceId: groupId ? get(this.db, 'SELECT account_workspace_id FROM chat_groups WHERE id=?', [groupId])?.account_workspace_id : '' });
    },
  });
}

function chatAccountWorkspace(db, userId = '', workspaceId = '') {
  const requested = String(workspaceId || '').trim() || get(db, `SELECT active_workspace_id FROM account_workspace_preferences
    WHERE user_id=? ORDER BY CASE WHEN device_id='local' THEN 0 ELSE 1 END,updated_at DESC LIMIT 1`, [userId])?.active_workspace_id || 'workspace_personal';
  const workspace = get(db, `SELECT workspace.* FROM account_workspaces workspace JOIN account_workspace_memberships membership
    ON membership.workspace_id=workspace.id WHERE workspace.id=? AND workspace.status='active' AND membership.user_id=? AND membership.status='active'`, [requested, userId]);
  if (!workspace) throw new Error('组织不存在或你已不在该组织中。');
  return workspace;
}

function ensureChatGroupRemarkColumn(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(chat_group_members)').all().map((row) => row.name));
  if (!columns.has('remark')) db.exec("ALTER TABLE chat_group_members ADD COLUMN remark TEXT NOT NULL DEFAULT ''");
}

function requireChatPeer(db, workspace = {}, actorId = '', targetId = '') {
  if (!targetId || targetId === actorId) throw new Error('请选择有效联系人。');
  if (!get(db, 'SELECT 1 FROM auth_users WHERE id=?', [targetId])) throw new Error('联系人不存在。');
  if (workspace.workspace_kind === 'organization') {
    if (get(db, "SELECT 1 FROM account_workspace_memberships WHERE workspace_id=? AND user_id=? AND status='active'", [workspace.id, targetId])) return true;
  }
  const sharedOrganization = get(db, "SELECT 1 FROM account_workspace_memberships actor JOIN account_workspace_memberships target ON target.workspace_id=actor.workspace_id JOIN account_workspaces org ON org.id=actor.workspace_id WHERE actor.user_id=? AND actor.status='active' AND target.user_id=? AND target.status='active' AND org.workspace_kind='organization' LIMIT 1", [actorId, targetId]);
  if (sharedOrganization) return true;
  const pair = [actorId, targetId].sort();
  if (!get(db, "SELECT 1 FROM friendships WHERE user_a_id=? AND user_b_id=? AND status='accepted'", pair)) {
    throw new Error('联系人群聊只能添加当前组织成员或已接受的外部联系人。');
  }
  return true;
}

function chatGroupScopeType(db, workspace = {}, memberIds = []) {
  if (workspace.workspace_kind !== 'organization') return 'external';
  const internal = memberIds.every((userId) => Boolean(get(db,
    "SELECT 1 FROM account_workspace_memberships WHERE workspace_id=? AND user_id=? AND status='active'", [workspace.id, userId])));
  return internal ? 'internal' : 'external';
}

function defaultChatTitle(db, memberIds = []) {
  const names = memberIds.slice(0, 3).map((id) => get(db, 'SELECT display_name,username FROM auth_users WHERE id=?', [id]))
    .map((row) => row?.display_name || row?.username || '').filter(Boolean);
  return names.join('、').slice(0, 80) || '新群聊';
}

function insertChatSystemMessage(db, { groupId, workspaceId, senderUserId, content, metadata = {}, createdAt = nowIso() }) {
  const id = newId('chat_group_msg');
  run(db, `INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,kind,content,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,'system',?,?,?,?)`, [id, workspaceId, groupId, senderUserId, content, JSON.stringify(metadata), createdAt, createdAt]);
  return id;
}

function queueChatGroupOutbox(db, { workspaceId, operationKind, aggregateId, idempotencyKey, payload }) {
  const payloadHash = hashPayload(payload);
  const existing = get(db, 'SELECT id,payload_hash FROM chat_group_outbox WHERE idempotency_key=?', [idempotencyKey]);
  if (existing && existing.payload_hash !== payloadHash) throw new Error('幂等键已被不同请求占用。');
  if (existing) return existing.id;
  const id = newId('chat_group_outbox');
  const now = nowIso();
  run(db, `INSERT INTO chat_group_outbox(id,account_workspace_id,operation_kind,aggregate_id,idempotency_key,payload_hash,payload_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?)`, [id, workspaceId, operationKind, aggregateId, idempotencyKey, payloadHash, JSON.stringify(payload), now, now]);
  return id;
}

function syncChatGroupConversation(db, group = {}) {
  if (!group?.id) return '';
  const conversationId = `chat_group_conversation:${group.id}`;
  const conversationGroupId = `chat_group:${group.id}`;
  run(db, `INSERT INTO conversations(id,account_workspace_id,conversation_kind,owner_user_id,title,group_id,status,created_at,updated_at)
    VALUES(?,?,'group',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,updated_at=excluded.updated_at`, [
    conversationId, group.account_workspace_id || 'workspace_personal', group.owner_user_id || '', group.title || '新群聊', conversationGroupId,
    group.status === 'dissolved' ? 'archived' : 'active', group.created_at || nowIso(), group.updated_at || nowIso(),
  ]);
  run(db, `INSERT OR IGNORE INTO conversation_aliases(alias_id,conversation_id,alias_kind,reason)
    VALUES(?,?,'chat_group_id','chat_group_conversation_binding')`, [conversationGroupId, conversationId]);
  for (const row of all(db, 'SELECT * FROM chat_group_messages WHERE group_id=? ORDER BY created_at,id', [group.id])) {
    run(db, `INSERT INTO messages(id,account_workspace_id,conversation_id,session_id,memory_id,task_workspace_id,sender_user_id,
      source_event_id,role,content,agent_id,department_id,visible,metadata_json,created_at,updated_at)
      VALUES(?,?,?,'','','',?,?,?,?,?,'social_chat',1,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`, [row.id, row.account_workspace_id || group.account_workspace_id || 'workspace_personal',
      conversationId, row.sender_user_id || '', row.source_event_id || '', row.kind === 'system' ? 'system' : row.sender_agent_id ? 'assistant' : 'user',
      row.content || '', row.sender_agent_id || '', row.metadata_json || '{}', row.created_at || '', row.updated_at || row.created_at || '']);
  }
  return conversationId;
}

function importChatGroupRow(auth, item = {}) {
  const id = String(item.id || '').trim();
  if (!id) return;
  const ownerId = auth.importCloudUser(item.owner || { id: item.ownerUserId || item.owner_user_id })?.id
    || auth.remoteUserLocalId?.(item.ownerUserId || item.owner_user_id) || item.ownerUserId || item.owner_user_id || '';
  const workspaceId = localWorkspaceId(auth.db, item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal');
  run(auth.db, `INSERT INTO chat_groups(id,account_workspace_id,organization_id,owner_user_id,title,scope_type,chat_mode,binding_type,binding_id,
    history_visibility,status,audience_scope,client_request_id,metadata_json,created_at,updated_at,dissolved_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_workspace_id=excluded.account_workspace_id,
    organization_id=excluded.organization_id,owner_user_id=excluded.owner_user_id,title=excluded.title,scope_type=excluded.scope_type,
    chat_mode=excluded.chat_mode,binding_type=excluded.binding_type,binding_id=excluded.binding_id,history_visibility=excluded.history_visibility,
    status=excluded.status,audience_scope=excluded.audience_scope,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,dissolved_at=excluded.dissolved_at`, [
    id, workspaceId, item.organizationId || item.organization_id || '', ownerId, item.title || '新群聊', item.scopeType || item.scope_type || 'external',
    item.chatMode || item.chat_mode || 'conversation', item.bindingType || item.binding_type || 'manual', item.bindingId || item.binding_id || '',
    item.historyVisibility || item.history_visibility || 'from_join', item.status || 'active', item.audienceScope || item.audience_scope || 'account_social',
    item.clientRequestId || item.client_request_id || `remote:${id}`,
    JSON.stringify(jsonObject(item.metadata)), item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso(), item.dissolvedAt || item.dissolved_at || null,
  ]);
}

function importChatGroupMemberRow(auth, item = {}) {
  const groupId = String(item.groupId || item.group_id || '').trim();
  const sourceUser = item.user || { id: item.userId || item.user_id };
  const remoteUser = { ...sourceUser, displayName: sourceUser.accountDisplayName || sourceUser.account_display_name || sourceUser.displayName,
    display_name: sourceUser.accountDisplayName || sourceUser.account_display_name || sourceUser.display_name };
  const userId = auth.importCloudUser(remoteUser)?.id || item.userId || item.user_id || '';
  if (!groupId || !userId) return;
  run(auth.db, `INSERT INTO chat_group_members(group_id,user_id,role,status,display_name_override,remark,invited_by_user_id,joined_at,left_at,last_read_at)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET role=excluded.role,status=excluded.status,remark=excluded.remark,
    display_name_override=excluded.display_name_override,invited_by_user_id=excluded.invited_by_user_id,
    joined_at=excluded.joined_at,left_at=excluded.left_at,last_read_at=COALESCE(excluded.last_read_at,chat_group_members.last_read_at)`, [
    groupId, userId, item.role || 'member', item.status || 'active',
    String(item.displayNameOverride || item.display_name_override || '').trim().slice(0, 80), String(item.remark || '').trim().slice(0, 80),
    item.invitedByUserId || item.invited_by_user_id || '',
    item.joinedAt || item.joined_at || nowIso(), item.leftAt || item.left_at || null, item.lastReadAt || item.last_read_at || null,
  ]);
}

function importChatGroupMessageRow(auth, item = {}) {
  const id = String(item.id || '').trim();
  const groupId = String(item.groupId || item.group_id || '').trim();
  const sourceSender = item.sender || { id: item.senderUserId || item.sender_user_id };
  const sender = { ...sourceSender, displayName: sourceSender.accountDisplayName || sourceSender.account_display_name || sourceSender.displayName,
    display_name: sourceSender.accountDisplayName || sourceSender.account_display_name || sourceSender.display_name };
  const senderId = auth.importCloudUser(sender)?.id || item.senderUserId || item.sender_user_id || '';
  if (!id || !groupId || !senderId) return;
  const workspaceId = localWorkspaceId(auth.db, item.workspaceId || item.accountWorkspaceId || item.account_workspace_id || 'workspace_personal');
  run(auth.db, `INSERT INTO chat_group_messages(id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,source_event_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,metadata_json=excluded.metadata_json,
    source_event_id=excluded.source_event_id,updated_at=excluded.updated_at`, [id, workspaceId, groupId, senderId,
    item.senderAgentId || item.sender_agent_id || '', item.kind || 'friend', item.content || '', JSON.stringify(jsonObject(item.metadata)),
    item.sourceEventId || item.source_event_id || '', item.createdAt || item.created_at || nowIso(), item.updatedAt || item.updated_at || nowIso()]);
  for (const receipt of Array.isArray(item.receiptDetails) ? item.receiptDetails : []) {
    const sourceRecipient = receipt.user || { id: receipt.userId || receipt.user_id };
    const recipientId = auth.importCloudUser(sourceRecipient)?.id || receipt.userId || receipt.user_id || '';
    if (!recipientId) continue;
    const createdAt = item.createdAt || item.created_at || nowIso();
    run(auth.db, `INSERT INTO chat_group_message_receipts(message_id,group_id,recipient_user_id,read_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(message_id,recipient_user_id) DO UPDATE SET
      read_at=CASE WHEN excluded.read_at<>'' THEN excluded.read_at ELSE chat_group_message_receipts.read_at END,
      updated_at=excluded.updated_at`, [id, groupId, recipientId, receipt.readAt || receipt.read_at || '', createdAt, nowIso()]);
  }
}

function attachLocalReceiptDetails(db, message = {}, currentUserId = '') {
  if (message.senderUserId !== currentUserId || message.kind === 'system') return message;
  const details = all(db, `SELECT receipt.*,user.email,user.display_name,user.username,user.avatar_url,user.role AS user_role,user.email_verified
    FROM chat_group_message_receipts receipt LEFT JOIN auth_users user ON user.id=receipt.recipient_user_id
    WHERE receipt.message_id=? ORDER BY CASE WHEN receipt.read_at<>'' THEN 0 ELSE 1 END,receipt.read_at,user.display_name,user.id`, [message.id])
    .map((row) => ({
      userId: row.recipient_user_id, read: Boolean(row.read_at), readAt: row.read_at || '',
      user: { id: row.recipient_user_id, email: row.email || '', displayName: row.display_name || '', display_name: row.display_name || '',
        username: row.username || '', avatarUrl: row.avatar_url || '', avatar_url: row.avatar_url || '' },
    }));
  return { ...message, receiptSummary: { total: details.length, read: details.filter((item) => item.read).length,
    unread: details.filter((item) => !item.read).length }, receiptDetails: details };
}

function localWorkspaceId(db, remoteId = '') {
  const workspaceId = String(remoteId || 'workspace_personal').trim() || 'workspace_personal';
  if (workspaceId === 'workspace_personal') return workspaceId;
  const organizationId = workspaceId.startsWith('workspace_org_') ? workspaceId.slice('workspace_org_'.length) : '';
  const organization = organizationId ? get(db, `SELECT id FROM contact_organizations WHERE remote_id=? OR id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`, [organizationId, organizationId, organizationId]) : null;
  return organization?.id ? `workspace_org_${organization.id}` : workspaceId;
}

function hashPayload(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex');
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function parseJson(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
