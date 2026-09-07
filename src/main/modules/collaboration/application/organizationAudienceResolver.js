import crypto from 'node:crypto';

import {
  UBUDDY_ORGANIZATION_AUDIENCE_ALL_MEMBERS,
  UBUDDY_ORGANIZATION_AUDIENCE_VERSION,
} from '../../../../shared/contracts/mentions.js';

export const UBUDDY_ORGANIZATION_AUDIENCE_SNAPSHOT_VERSION = 'ubuddy_organization_audience_snapshot_v1';
export const UBUDDY_ORGANIZATION_AUDIENCE_MAX_RECIPIENTS = 100;

export function resolveOrganizationAudience({ mentions = [], user = null, activeWorkspace = null, organizations = [] } = {}) {
  const audienceMentions = (Array.isArray(mentions) ? mentions : []).filter((mention) => (
    mention?.principalType === 'organization'
  ));
  if (!audienceMentions.length) return { userIds: [], users: [], snapshot: null };
  if (audienceMentions.length !== 1) throw organizationAudienceError(
    'organization_audience_multiple_not_supported',
    '每次只能选择一个组织的所有成员。',
  );

  const mention = audienceMentions[0];
  if (mention.source !== 'picker' || mention.audience !== UBUDDY_ORGANIZATION_AUDIENCE_ALL_MEMBERS) {
    throw organizationAudienceError('organization_audience_invalid', '组织成员范围无效，请重新从 @ 菜单选择。');
  }
  const organizationId = String(mention.organizationId || '').trim();
  const workspaceOrganizationId = String(
    activeWorkspace?.organizationId || activeWorkspace?.organization_id || '',
  ).trim();
  const workspaceKind = String(
    activeWorkspace?.kind || activeWorkspace?.workspaceKind || activeWorkspace?.workspace_kind || '',
  ).trim();
  const personalWorkspace = workspaceKind === 'personal'
    || (!workspaceKind && String(activeWorkspace?.id || '') === 'workspace_personal');
  const matchingOrganizationWorkspace = workspaceKind === 'organization'
    && workspaceOrganizationId === organizationId;
  if (!organizationId || (!personalWorkspace && !matchingOrganizationWorkspace)) {
    throw organizationAudienceError(
      'organization_audience_workspace_mismatch',
      '“@所有人”只能用于当前组织 Workspace，或个人 Workspace 中已加入的组织。',
    );
  }

  const organization = (Array.isArray(organizations) ? organizations : []).find((item) => (
    String(item?.id || '') === organizationId
  ));
  const currentUserId = String(user?.id || '').trim();
  const members = Array.isArray(organization?.members) ? organization.members : [];
  if (!organization || !members.some((member) => String(member?.user?.id || '') === currentUserId)) {
    throw organizationAudienceError(
      'organization_audience_forbidden',
      '当前账号已不属于该组织，不能向组织成员派发任务。',
    );
  }

  const users = members
    .map((member) => member?.user || null)
    .filter((member) => member?.id && String(member.id) !== currentUserId)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const userIds = [...new Set(users.map((member) => String(member.id)))];
  if (!userIds.length) {
    throw organizationAudienceError(
      'organization_audience_empty',
      '当前组织没有其他可派发任务的成员。',
    );
  }
  if (userIds.length > UBUDDY_ORGANIZATION_AUDIENCE_MAX_RECIPIENTS) {
    throw organizationAudienceError(
      'organization_audience_too_large',
      `当前组织有 ${userIds.length} 位可派发成员，超过单次上限 ${UBUDDY_ORGANIZATION_AUDIENCE_MAX_RECIPIENTS} 人，请分批选择联系人。`,
    );
  }
  const membershipHash = organizationMembershipHash(organizationId, userIds);
  return {
    userIds,
    users,
    snapshot: {
      version: UBUDDY_ORGANIZATION_AUDIENCE_SNAPSHOT_VERSION,
      mentionVersion: UBUDDY_ORGANIZATION_AUDIENCE_VERSION,
      organizationId,
      organizationName: String(organization.name || '').trim(),
      memberUserIds: userIds,
      memberCount: userIds.length,
      membershipHash,
      resolvedAt: new Date().toISOString(),
    },
  };
}

export function organizationAudienceSnapshotMatches(left = null, right = null) {
  if (!left || !right) return false;
  return String(left.organizationId || '') === String(right.organizationId || '')
    && String(left.membershipHash || '') === String(right.membershipHash || '')
    && sameIds(left.memberUserIds, right.memberUserIds);
}

export function organizationAudienceRoutingMentions(mentions = [], resolution = null) {
  const normalized = Array.isArray(mentions) ? mentions : [];
  if (!resolution?.snapshot || !Array.isArray(resolution.users)) return normalized;
  const explicitUserIds = new Set(normalized
    .filter((mention) => mention?.principalType === 'user')
    .map((mention) => String(mention.userId || ''))
    .filter(Boolean));
  const displayText = normalized.find((mention) => mention?.principalType === 'organization')?.displayText
    || '@组织所有人';
  const expanded = resolution.users
    .filter((member) => !explicitUserIds.has(String(member?.id || '')))
    .map((member) => ({
      principalType: 'user',
      userId: String(member.id),
      ownerUserId: '',
      agentId: '',
      agentInstanceId: '',
      organizationId: '',
      audience: '',
      displayText,
      mentionId: `organization_audience:${resolution.snapshot.organizationId}:${member.id}`,
      source: 'picker',
      resolvedFromOrganizationAudience: true,
    }));
  return [...normalized, ...expanded];
}

function organizationMembershipHash(organizationId, userIds) {
  return crypto.createHash('sha256')
    .update(`${organizationId}\n${[...userIds].sort().join('\n')}`, 'utf8')
    .digest('hex');
}

function sameIds(left = [], right = []) {
  const a = [...new Set((Array.isArray(left) ? left : []).map(String).filter(Boolean))].sort();
  const b = [...new Set((Array.isArray(right) ? right : []).map(String).filter(Boolean))].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function organizationAudienceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
