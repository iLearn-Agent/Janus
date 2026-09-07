import { employeeRouteEligibleForChat } from '../../utils/agentIdentity.js';
import { socialTaskGroupId, socialTaskGroups } from '../../utils/socialTaskGroups.js';
function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function socialMessageVisibleInNavigation(message = {}, groupIds = new Set()) {
  const metadata = message?.metadata || {};
  const groupId = socialTaskGroupId(message);
  if (groupId) return groupIds.has(groupId);
  return !metadata.taskGroupId && !metadata.groupId;
}

function unreadSocialMessageIds(messages = [], currentUserId = '', groupIds = null) {
  const visibleGroupIds = groupIds || new Set(socialTaskGroups(messages).map((group) => String(group.id || '')));
  return safeArray(messages).flatMap((message, index) => {
    const unread = String(message?.recipientUserId || message?.recipient_user_id || '') === String(currentUserId || '')
      && message?.status !== 'read'
      && !message?.readAt
      && !message?.read_at
      && socialMessageVisibleInNavigation(message, visibleGroupIds);
    if (!unread) return [];
    return [String(message?.id || `anonymous:${index}:${message?.createdAt || message?.created_at || ''}`)];
  });
}

export function navigationMessageUnreadCount(rendererState = {}) {
  const currentUserId = rendererState.currentUser?.id || '';
  const employeeById = new Map(safeArray(rendererState.employeeOverview?.roster)
    .map((employee) => [employee.id, employee]));
  const agentById = new Map(safeArray(rendererState.org?.agents)
    .map((agent) => [agent.id, agent]));
  const agentUnread = safeArray(rendererState.sessions).reduce((total, session) => {
    const departmentId = session?.departmentId || session?.department_id || '';
    const agentId = session?.agentId || session?.agent_id || '';
    const status = String(session?.status || '');
    const employeeId = session?.agentInstanceId || session?.agent_instance_id || '';
    const employee = employeeId ? employeeById.get(employeeId) : null;
    const agent = agentById.get(agentId);
    if (!agentId || !agent || agent.routable === false
      || ['archived', 'deleted'].includes(status) || session?.archived === true
      || ['agent_delegation', 'secretary_department', 'private_assistant'].includes(departmentId)
      || agentId === 'secretary_agent'
      || (employee && !employeeRouteEligibleForChat(employee))) return total;
    return total + Math.max(0, Number(session?.unreadDeliveryCount ?? session?.unreadCount ?? 0));
  }, 0);
  const socialUnreadIds = new Set([
    ...safeArray(rendererState.socialThreads).flatMap((thread) => unreadSocialMessageIds(thread?.messages, currentUserId)),
    ...unreadSocialMessageIds(rendererState.socialInbox, currentUserId, new Set(socialTaskGroups(rendererState.socialInbox)
      .map((group) => String(group.id || '')).filter(Boolean))),
  ]);
  const chatGroupUnread = safeArray(rendererState.chatGroupsOverview?.groups)
    .filter((group) => !group?.archived)
    .reduce((total, group) => total + Math.max(0, Number(group?.unreadCount || 0)), 0);
  const collaborationUnread = safeArray(rendererState.collaborationOverview?.groups)
    .filter((group) => !group?.archived)
    .reduce((total, group) => total + Math.max(0, Number(group?.unreadCount || 0)), 0);
  return agentUnread + socialUnreadIds.size + chatGroupUnread + collaborationUnread;
}

export function agentRunNoticeCount(rendererState = {}, {
  sessionId = '', agentId = '', agentInstanceId = '', channelId = '',
} = {}) {
  const cleanSessionId = String(sessionId || '');
  const cleanAgentId = String(agentId || '');
  const cleanInstanceId = String(agentInstanceId || '');
  const cleanChannelId = String(channelId || '');
  return safeArray(rendererState.chatRuns).filter((run) => {
    if (!run?.unreadNotice || run.nonBlocking || run.targetKind === 'private_assistant'
      || run.departmentId === 'private_assistant') return false;
    if (cleanChannelId && String(run.channelId || '') !== cleanChannelId) return false;
    const runSessionId = String(run.displaySessionId || run.sessionId || '');
    if (cleanSessionId && runSessionId !== cleanSessionId) return false;
    if (cleanAgentId && String(run.agentId || '') !== cleanAgentId) return false;
    if (cleanInstanceId && String(run.agentInstanceId || run.agent_instance_id || '') !== cleanInstanceId) return false;
    return true;
  }).length;
}

export function clearAgentRunNotices(rendererState = {}, criteria = {}) {
  const cleanSessionId = String(criteria.sessionId || '');
  const cleanAgentId = String(criteria.agentId || '');
  const cleanInstanceId = String(criteria.agentInstanceId || '');
  const cleanChannelId = String(criteria.channelId || '');
  let changed = false;
  for (const run of safeArray(rendererState.chatRuns)) {
    if (!run?.unreadNotice) continue;
    if (cleanChannelId && String(run.channelId || '') !== cleanChannelId) continue;
    if (cleanSessionId && String(run.displaySessionId || run.sessionId || '') !== cleanSessionId) continue;
    if (cleanAgentId && String(run.agentId || '') !== cleanAgentId) continue;
    if (cleanInstanceId && String(run.agentInstanceId || run.agent_instance_id || '') !== cleanInstanceId) continue;
    run.unreadNotice = false;
    run.unreadNoticeKind = '';
    changed = true;
  }
  return changed;
}
