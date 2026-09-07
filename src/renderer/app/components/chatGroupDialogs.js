import { state, userInitials } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { escapeAttr, escapeHtml } from '../utils/format.js';
import { renderUserAvatar } from '../utils/avatar.js';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function userName(user = {}) {
  return user.remark || user.displayName || user.display_name || user.username || user.email || user.id || '用户';
}

function activeOrganization() {
  const organizationId = state.activeAccountWorkspace?.organizationId || state.activeAccountWorkspace?.organization_id || '';
  return safeArray(state.friendOverview?.organizations).find((item) => String(item.id || '') === String(organizationId || ''))
    || safeArray(state.friendOverview?.organizations)[0] || null;
}

function eligibleInviteContacts(detail = {}) {
  const organizationContacts = safeArray(activeOrganization()?.members).map((item) => ({ ...(item.user || {}), directoryKind: 'internal' }));
  const organizationIds = new Set(organizationContacts.map((user) => String(user.id || '')));
  const externalContacts = safeArray(state.friendOverview?.friends).map((item) => item.friend || item.user || {})
    .filter((user) => !organizationIds.has(String(user.id || ''))).map((user) => ({ ...user, directoryKind: 'external' }));
  const memberIds = new Set(safeArray(detail.members).filter((member) => member.status === 'active').map((member) => String(member.userId || member.user_id || member.user?.id || '')));
  return [...organizationContacts, ...externalContacts].filter((user, index, users) => (
    user.id && user.id !== state.currentUser?.id && !memberIds.has(String(user.id))
    && users.findIndex((item) => String(item.id || '') === String(user.id || '')) === index
  ));
}

export function renderChatGroupInviteDialog() {
  if (!state.chatGroupInviteOpen) return '';
  const detail = state.chatGroupInviteGroupDetail || state.chatGroupDetail || {};
  const group = detail.group || {};
  const contacts = eligibleInviteContacts(detail);
  return `<div class="friend-search-dialog-scrim chat-group-invite-overlay" role="presentation" data-chat-group-invite-close>
    <form class="friend-search-dialog contact-add-dialog chat-group-invite-dialog" data-chat-group-invite-form role="dialog" aria-modal="true" aria-labelledby="chat-group-invite-title">
      <header><div><strong id="chat-group-invite-title">邀请新成员</strong><span>${escapeHtml(group.title || '联系人群聊')}</span></div><button type="button" data-chat-group-invite-close aria-label="关闭邀请成员窗口">${iconSvg('x')}</button></header>
      <div class="chat-group-invite-body">
        <p>新成员只能从当前组织联系人或已接受的外部联系人中选择。</p>
        <div class="chat-group-invite-members">${contacts.length ? contacts.map((user) => `<label><input type="radio" name="chat-group-invite-user" value="${escapeAttr(user.id)}" data-chat-group-invite-user ${state.chatGroupInviteUserId === user.id ? 'checked' : ''}>${renderUserAvatar(user, { className: 'network-user-avatar', title: userName(user), fallbackLabel: userInitials(user) })}<span><strong>${escapeHtml(userName(user))}</strong><small>${user.directoryKind === 'internal' ? '组织内联系人' : '外部联系人'} · ${escapeHtml(user.username ? `@${user.username}` : user.email || user.id)}</small></span></label>`).join('') : '<div class="friend-request-empty">暂无可邀请的联系人</div>'}</div>
      </div>
      <footer><button type="button" class="btn secondary" data-chat-group-invite-close>取消</button><button type="submit" class="btn primary" ${state.chatGroupInviteBusy || !state.chatGroupInviteUserId ? 'disabled' : ''}>${state.chatGroupInviteBusy ? '正在邀请…' : '邀请加入'}</button></footer>
    </form>
  </div>`;
}
