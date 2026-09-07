import assert from 'node:assert/strict';

import { state } from '../src/renderer/app/state.js';
import { renderSettings } from '../src/renderer/app/views/settingsView.js';

state.currentUser = { id: 'user_archive_settings' };
state.currentSettingsSection = 'archived';
state.languageMode = 'zh-CN';
state.archivedSessionsLoading = false;
state.archivedSessionsError = '';
state.archivedSessions = [{
  id: 'session_classic_archived',
  title: '传统归档会话',
  status: 'archived',
  updatedAt: '2026-08-30T10:00:00.000Z',
}];
state.sessions = [{
  id: 'session_agent_inbox_archived',
  title: 'GeneralistB 对话',
  status: 'active',
  agentId: 'general_agent',
  updatedAt: '2026-08-30T11:00:00.000Z',
}];
state.socialThreads = [{
  friend: { id: 'friend_archive_settings', displayName: '归档联系人' },
  messages: [{
    conversationId: 'direct_archive_settings',
    content: '保留的历史消息',
    createdAt: '2026-08-30T12:00:00.000Z',
  }],
}];
state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
state.chatGroupsOverview = { groups: [] };
state.collaborationOverview = { groups: [] };
state.conversationPreferences = {
  preferences: [
    { conversationKind: 'agent_session', conversationId: 'session_agent_inbox_archived', archived: true },
    { conversationKind: 'social_direct', conversationId: 'direct_archive_settings', archived: true },
    { conversationKind: 'agent_session', conversationId: 'session_not_archived', archived: false },
  ],
};

const html = renderSettings({
  sessionIsArchived: (session = {}) => session.archived === true || session.status === 'archived',
  sessionSubtitle: (session = {}) => session.agentId || '普通聊天',
});

assert.match(html, /传统归档会话/);
assert.match(html, /GeneralistB 对话/);
assert.match(html, /data-conversation-archive="agent:session_agent_inbox_archived"/);
assert.match(html, /归档联系人/);
assert.match(html, /data-conversation-archive="direct:direct_archive_settings"/);
assert.doesNotMatch(html, /session_not_archived/);

process.stdout.write('Conversation archive settings projection smoke passed.\n');
