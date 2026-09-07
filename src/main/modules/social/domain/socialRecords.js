import { normalizeDelegationStatus as normalizeAgentDelegationStatus } from '../../../../shared/contracts/delegation.js';
import { normalizeMessageReactionMetadata } from '../../../../shared/messageReactions.js';

export function normalizeRole(role) {
  return String(role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
}

export function isPhoneOnlyEmail(email = '') {
  return String(email || '').toLowerCase().endsWith('@phone.janus.local');
}

export function orderedUserPair(left, right) {
  const items = [String(left || ''), String(right || '')].sort();
  return [items[0], items[1]];
}


export function normalizeAgentId(value = '') {
  return String(value || '').trim().slice(0, 80);
}


export function publicUserFromPrefixedRow(row, prefix) {
  const id = row[`${prefix}_id`] || '';
  if (!id) return null;
  return publicUser({
    id,
    email: row[`${prefix}_email`] || '',
    display_name: row[`${prefix}_display_name`] || '',
    username: row[`${prefix}_username`] || '',
    avatar_url: row[`${prefix}_avatar_url`] || '',
    role: row[`${prefix}_role`] || 'member',
    email_verified: row[`${prefix}_email_verified`] || 0,
  });
}

export function normalizeAgentDelegation(row) {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    requesterUserId: row.requester_user_id || '',
    requester_user_id: row.requester_user_id || '',
    recipientUserId: row.recipient_user_id || '',
    recipient_user_id: row.recipient_user_id || '',
    clientRequestId: row.client_request_id || '',
    client_request_id: row.client_request_id || '',
    senderAgentId: row.sender_agent_id || 'secretary_agent',
    sender_agent_id: row.sender_agent_id || 'secretary_agent',
    recipientAgentId: row.recipient_agent_id || 'secretary_agent',
    recipient_agent_id: row.recipient_agent_id || 'secretary_agent',
    title: row.title || '',
    instruction: row.instruction || '',
    status: normalizeAgentDelegationStatus(row.status),
    sessionId: row.session_id || '',
    session_id: row.session_id || '',
    taskRunId: row.task_run_id || '',
    task_run_id: row.task_run_id || '',
    groupId: row.group_id || metadata.groupId || '',
    group_id: row.group_id || metadata.groupId || '',
    lastError: row.last_error || '',
    last_error: row.last_error || '',
    metadata,
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
    startedAt: row.started_at || '',
    started_at: row.started_at || '',
    completedAt: row.completed_at || '',
    completed_at: row.completed_at || '',
    requester: publicUserFromPrefixedRow(row, 'requester'),
    recipient: publicUserFromPrefixedRow(row, 'recipient'),
  };
}

export function publicUser(row) {
  return {
    id: row.friend_id || row.id,
    email: isPhoneOnlyEmail(row.email) ? '' : row.email,
    phone: row.phone || '',
    displayName: row.display_name,
    display_name: row.display_name,
    username: row.username || '',
    avatarUrl: row.avatar_url || '',
    avatar_url: row.avatar_url || '',
    remoteId: row.remote_id || '',
    remote_id: row.remote_id || '',
    role: normalizeRole(row.role || 'member'),
    emailVerified: Boolean(row.email_verified),
    email_verified: Boolean(row.email_verified),
  };
}

export function normalizeFriendRequest(row, direction) {
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    direction,
    requesterId: row.requester_id,
    recipientId: row.recipient_id,
    status: row.status,
    message: row.message || '',
    user: publicUser(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeFriendship(row) {
  const remark = String(row.friend_remark || '').trim();
  const friend = publicUser(row);
  return {
    id: row.id,
    status: row.status,
    remark,
    friend: { ...friend, remark, accountDisplayName: row.account_display_name || friend.displayName || '' },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    online: Boolean(row.online),
    lastSeenAt: row.last_seen_at || '',
  };
}

export function normalizeSocialMessage(row) {
  const sender = row.sender_id ? publicUser({
    id: row.sender_id,
    email: row.sender_email,
    display_name: row.sender_display_name,
    username: row.sender_username,
    avatar_url: row.sender_avatar_url,
    role: row.sender_role,
    email_verified: row.sender_email_verified,
  }) : null;
  return {
    id: row.id,
    accountWorkspaceId: row.account_workspace_id || 'workspace_personal',
    workspaceId: row.account_workspace_id || 'workspace_personal',
    conversationId: row.conversation_id || '',
    conversation_id: row.conversation_id || '',
    senderUserId: row.sender_user_id || '',
    sender_user_id: row.sender_user_id || '',
    recipientUserId: row.recipient_user_id || '',
    recipient_user_id: row.recipient_user_id || '',
    senderAgentId: row.sender_agent_id || '',
    sender_agent_id: row.sender_agent_id || '',
    recipientAgentId: row.recipient_agent_id || '',
    recipient_agent_id: row.recipient_agent_id || '',
    kind: normalizeSocialMessageKind(row.kind),
    title: row.title || '',
    content: row.content || '',
    status: row.status || 'unread',
    readAt: row.read_at || '',
    read_at: row.read_at || '',
    createdAt: row.created_at,
    created_at: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    updated_at: row.updated_at || row.created_at,
    deliveryStatus: row.delivery_status || 'local',
    remoteId: row.remote_id || '',
    metadata: normalizeMessageReactionMetadata(parseJsonObject(row.metadata_json)),
    sender,
  };
}

export function normalizeCollaborationGroup(row = {}) {
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
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || row.created_at || '',
    closedAt: row.closed_at || '',
  };
}

export function normalizeCollaborationMember(row = {}) {
  const displayNameOverride = String(row.display_name_override || row.displayNameOverride || '').trim();
  return {
    groupId: row.group_id || '',
    userId: row.user_id || row.id || '',
    role: row.role || 'member',
    status: row.status || 'active',
    joinedAt: row.joined_at || '',
    leftAt: row.left_at || '',
    displayNameOverride,
    user: publicUser({
      id: row.user_id || row.id,
      email: row.email,
      display_name: displayNameOverride || row.display_name,
      username: row.username,
      avatar_url: row.avatar_url,
      role: row.user_role || 'member',
      email_verified: row.email_verified,
    }),
  };
}

export function normalizeCollaborationMessage(row = {}) {
  return {
    id: row.id || '',
    groupId: row.group_id || '',
    senderUserId: row.sender_user_id || '',
    senderAgentId: row.sender_agent_id || '',
    kind: normalizeSocialMessageKind(row.kind),
    content: row.content || '',
    sourceEventId: row.source_event_id || '',
    metadata: parseJsonObject(row.metadata_json),
    sender: publicUser({
      id: row.sender_user_id,
      email: row.sender_email,
      display_name: row.sender_display_name,
      username: row.sender_username,
      avatar_url: row.sender_avatar_url,
      role: row.sender_role || 'member',
      email_verified: row.sender_email_verified,
    }),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || row.created_at || '',
  };
}

export function normalizeChatGroup(row = {}) {
  return {
    id: row.id || '',
    accountWorkspaceId: row.account_workspace_id || row.accountWorkspaceId || 'workspace_personal',
    workspaceId: row.account_workspace_id || row.workspaceId || 'workspace_personal',
    organizationId: row.organization_id || row.organizationId || '',
    ownerUserId: row.owner_user_id || row.ownerUserId || '',
    title: row.title || '新群聊',
    scopeType: row.scope_type || row.scopeType || 'external',
    chatMode: row.chat_mode || row.chatMode || 'conversation',
    bindingType: row.binding_type || row.bindingType || 'manual',
    bindingId: row.binding_id || row.bindingId || '',
    historyVisibility: row.history_visibility || row.historyVisibility || 'from_join',
    audienceScope: row.audience_scope || row.audienceScope || 'account_social',
    status: row.status || 'active',
    memberCount: Number(row.member_count || row.memberCount || 0),
    unreadCount: Number(row.unread_count || row.unreadCount || 0),
    lastMessage: row.last_message || row.lastMessage || '',
    lastMessageContent: row.last_message_content ?? row.lastMessageContent ?? '',
    lastMessageSenderUserId: row.last_message_sender_user_id || row.lastMessageSenderUserId || '',
    lastMessageSenderName: row.last_message_sender_name || row.lastMessageSenderName || '',
    metadata: parseJsonObject(row.metadata_json || row.metadata),
    createdAt: row.created_at || row.createdAt || '',
    updatedAt: row.updated_at || row.updatedAt || row.created_at || row.createdAt || '',
    dissolvedAt: row.dissolved_at || row.dissolvedAt || '',
    ...((row.membership_role || row.membership) ? { membership: row.membership || {
      groupId: row.id || '', userId: row.membership_user_id || '', role: row.membership_role || 'member',
      status: row.membership_status || 'active', remark: String(row.membership_remark || '').trim(),
    } } : {}),
  };
}

export function normalizeChatGroupMember(row = {}) {
  const displayNameOverride = String(row.display_name_override || row.displayNameOverride || '').trim();
  const remark = String(row.remark || '').trim();
  return {
    groupId: row.group_id || row.groupId || '',
    userId: row.user_id || row.userId || row.id || '',
    role: row.role || 'member',
    status: row.status || 'active',
    invitedByUserId: row.invited_by_user_id || row.invitedByUserId || '',
    joinedAt: row.joined_at || row.joinedAt || '',
    leftAt: row.left_at || row.leftAt || '',
    lastReadAt: row.last_read_at || row.lastReadAt || '',
    displayNameOverride,
    remark,
    user: row.user || publicUser({
      id: row.user_id || row.userId || row.id,
      email: row.email,
      display_name: displayNameOverride || row.display_name || row.displayName,
      username: row.username,
      avatar_url: row.avatar_url || row.avatarUrl,
      role: row.user_role || 'member',
      email_verified: row.email_verified || row.emailVerified,
    }),
  };
}

export function normalizeChatGroupMessage(row = {}) {
  return {
    id: row.id || '',
    accountWorkspaceId: row.account_workspace_id || row.accountWorkspaceId || 'workspace_personal',
    workspaceId: row.account_workspace_id || row.workspaceId || 'workspace_personal',
    groupId: row.group_id || row.groupId || '',
    senderUserId: row.sender_user_id || row.senderUserId || '',
    senderAgentId: row.sender_agent_id || row.senderAgentId || '',
    kind: normalizeSocialMessageKind(row.kind),
    content: row.content || '',
    sourceEventId: row.source_event_id || row.sourceEventId || '',
    metadata: normalizeMessageReactionMetadata(parseJsonObject(row.metadata_json || row.metadata)),
    sender: row.sender || publicUser({
      id: row.sender_user_id || row.senderUserId,
      email: row.sender_email,
      display_name: row.sender_display_name,
      username: row.sender_username,
      avatar_url: row.sender_avatar_url,
      role: row.sender_role || 'member',
      email_verified: row.sender_email_verified,
    }),
    createdAt: row.created_at || row.createdAt || '',
    updatedAt: row.updated_at || row.updatedAt || row.created_at || row.createdAt || '',
  };
}

export function normalizeSocialMessageKind(kind = '') {
  const value = String(kind || '').trim().toLowerCase();
  if (['agent', 'friend', 'system'].includes(value)) return value;
  return 'friend';
}

export function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
