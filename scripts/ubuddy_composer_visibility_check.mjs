import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { state } from '../src/renderer/app/state.js';
import { renderMemoryNameModal } from '../src/renderer/app/components/overlays.js';
import { createNetworkWorkspaceController } from '../src/renderer/app/features/network/workspaceController.js';
import { createProjectComposerController } from '../src/renderer/app/features/navigation/projectComposerController.js';
import { composerCapabilities, renderChat } from '../src/renderer/app/views/chatView.js';
import { mentionDeletionRange } from '../src/shared/contracts/mentions.js';

Object.assign(state, {
  languageMode: 'zh-CN',
  sessions: [],
  messages: [],
  currentSessionId: '',
  currentDepartmentId: '',
  currentAgentId: '',
  currentAgentInstanceId: '',
  selectionSource: null,
  homeMode: 'department',
  attachments: [],
  chatDraft: '',
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialMentionMenuOpen: false,
  projects: [],
  activeProjectId: '',
  workspaceDetached: false,
  networkConversationPeerId: '',
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  employeeOverview: {
    capabilities: { multiMemory: { enabled: true, readOnly: false } },
    roster: [
      { id: 'ubuddy_instance', agentFamilyId: 'secretary_agent', routeEligible: true, currentMemory: { id: 'ubuddy_memory0', displayName: 'memory0.md' } },
      { id: 'ppt_instance', agentFamilyId: 'ppt', routeEligible: true, currentMemory: { id: 'ppt_memory0', displayName: 'memory0.md' } },
    ],
  },
  composerMemoryMenuOpen: false,
  composerMemoryBusy: false,
  composerMemoryAgentInstanceId: '',
  composerMemoryDocuments: [],
  composerMemoryContext: null,
});

const ordinaryMarkup = renderChat();
assert.equal(composerCapabilities().showContactMention, false);
assert.doesNotMatch(ordinaryMarkup, /data-composer-ubuddy-mode/);
assert.match(ordinaryMarkup, /data-social-mention-toggle[^>]*>@<\/button>/);
assert.doesNotMatch(ordinaryMarkup, /@ 项目文件/);

state.projects = [{ id: 'empty_project', title: 'Empty Project', workspaceRoot: '' }];
state.activeProjectId = 'empty_project';
assert.match(renderChat(), /data-social-mention-toggle[^>]*>@<\/button>/);

state.projects = [{ id: 'project_mention_test', title: 'Mention Test', workspaceRoot: '/tmp/mention-test' }];
state.activeProjectId = 'project_mention_test';
const projectMarkup = renderChat();
assert.match(projectMarkup, /data-social-mention-toggle/);
assert.match(projectMarkup, /data-social-mention-toggle[^>]*>@<\/button>/);
assert.doesNotMatch(projectMarkup, /@ 项目文件/);
state.workspaceDetached = true;
assert.match(renderChat(), /data-social-mention-toggle[^>]*>@<\/button>/);
state.workspaceDetached = false;

state.composerToolMenuOpen = true;
const ordinaryToolMenuMarkup = renderChat();
assert.match(ordinaryToolMenuMarkup, /data-composer-interaction-mode="goal"/);
assert.match(ordinaryToolMenuMarkup, /data-composer-interaction-mode="plan"/);
assert.match(ordinaryToolMenuMarkup, /计划模式|Plan/);
state.composerToolMenuOpen = false;

state.currentDepartmentId = 'ppt_department';
state.currentAgentId = 'ppt';
state.currentAgentInstanceId = 'ppt_instance';
state.selectionSource = 'employee';
const employeeMarkup = renderChat();
assert.equal(composerCapabilities().showContactMention, false);
assert.doesNotMatch(employeeMarkup, /data-composer-ubuddy-mode/);
assert.match(employeeMarkup, /data-social-mention-toggle/);
assert.match(employeeMarkup, /data-social-mention-toggle[^>]*>@<\/button>/);
assert.doesNotMatch(employeeMarkup, /@ 项目文件/);
assert.match(employeeMarkup, /data-composer-memory-toggle/);

state.currentSessionId = 'ppt_session_without_roster_entry';
state.sessions = [{
  id: 'ppt_session_without_roster_entry',
  departmentId: 'ppt_department',
  agentId: 'ppt',
  agentInstanceId: 'ppt_session_instance',
}];
state.currentAgentInstanceId = 'ppt_session_instance';
state.selectionSource = null;
state.employeeOverview.roster = state.employeeOverview.roster.filter((item) => item.id !== 'ppt_session_instance');
state.composerMemoryMenuOpen = true;
state.composerMemoryAgentInstanceId = 'ppt_session_instance';
state.composerMemoryContext = { activeMemoryDocumentId: 'ppt_session_memory0' };
state.composerMemoryDocuments = [{
  id: 'ppt_session_memory0',
  scope: 'general',
  lifecycleState: 'active',
  displayName: 'PPT memory0.md',
  messageCount: 2,
  updatedAt: '2026-08-20T10:00:00.000Z',
}, {
  id: 'ppt_session_memory1',
  scope: 'general',
  lifecycleState: 'inactive',
  displayName: 'PPT memory1.md',
  messageCount: 0,
  updatedAt: '2026-08-20T10:01:00.000Z',
}];
const pptSessionMemoryMarkup = renderChat();
assert.equal(composerCapabilities().showMemory, true);
assert.match(pptSessionMemoryMarkup, /data-composer-memory-toggle/);
assert.match(pptSessionMemoryMarkup, /data-composer-memory-rename="ppt_session_memory0"/);
assert.match(pptSessionMemoryMarkup, /重命名当前 Memory/);
assert.match(pptSessionMemoryMarkup, /data-composer-memory-switch="ppt_session_memory1"/);
assert.match(pptSessionMemoryMarkup, /data-composer-memory-rename="ppt_session_memory0"[^>]*role="menuitem" >/);
assert.match(pptSessionMemoryMarkup, /data-composer-memory-switch="ppt_session_memory0"[^>]*disabled/);
assert.doesNotMatch(pptSessionMemoryMarkup, /data-composer-memory-switch="ppt_session_memory1"[^>]*disabled/);

state.activeChatRun = { channelId: 'ppt-active-run', departmentId: 'ppt_department', agentInstanceId: 'ppt_session_instance', terminal: false };
const pptRunningMemoryMarkup = renderChat();
assert.match(pptRunningMemoryMarkup, /data-composer-memory-rename="ppt_session_memory0"[^>]*disabled/);
assert.match(pptRunningMemoryMarkup, /data-composer-memory-switch="ppt_session_memory1"[^>]*disabled/);
state.activeChatRun = null;

state.languageMode = 'en';
const pptSessionMemoryEnglishMarkup = renderChat();
assert.match(pptSessionMemoryEnglishMarkup, /Rename current Memory/);
assert.match(renderMemoryNameModal(), /^$/);
state.memoryNameDialog = {
  agentInstanceId: 'ppt_session_instance',
  source: 'composer',
  mode: 'rename',
  memoryDocumentId: 'ppt_session_memory0',
  draft: 'PPT memory0.md',
  busy: false,
  error: '',
};
assert.match(renderMemoryNameModal(), /Rename Memory/);
assert.match(renderMemoryNameModal(), /Memory name/);
state.memoryNameDialog = null;
state.languageMode = 'zh-CN';
state.composerMemoryMenuOpen = false;
state.composerMemoryAgentInstanceId = '';
state.composerMemoryContext = null;
state.composerMemoryDocuments = [];
state.currentSessionId = '';
state.sessions = [];

state.currentDepartmentId = '';
state.currentAgentId = '';
state.currentAgentInstanceId = '';
state.selectionSource = null;
state.homeMode = 'secretary';
state.composerToolMenuOpen = true;
const secretaryHomeMarkup = renderChat();
assert.equal(composerCapabilities().showContactMention, false);
assert.doesNotMatch(secretaryHomeMarkup, /data-ubuddy-message-mode-toggle|data-ubuddy-participant-policy-toggle/,
  'ordinary chat home must not expose uBuddy private-conversation controls');

state.currentSessionId = 'ubuddy_visibility_session';
state.sessions = [{
  id: 'ubuddy_visibility_session', departmentId: 'secretary_department', agentId: 'secretary_agent',
}];
const uBuddyMarkup = renderChat();
assert.equal(composerCapabilities().showContactMention, true);
assert.doesNotMatch(uBuddyMarkup, /data-composer-ubuddy-mode/);
assert.match(uBuddyMarkup, /data-social-mention-toggle/);
assert.match(uBuddyMarkup, /data-social-mention-toggle[^>]*>@<\/button>/);
assert.doesNotMatch(uBuddyMarkup, /@ 联系人 \/ Agent \/ Skill \/ 插件 \/ 文件/);
assert.match(uBuddyMarkup, /告诉 uBuddy 你想完成什么任务/);
assert.match(uBuddyMarkup, /data-composer-memory-toggle/);
assert.doesNotMatch(uBuddyMarkup, /data-composer-interaction-mode="goal"/);
assert.doesNotMatch(uBuddyMarkup, /data-composer-interaction-mode="plan"/);
assert.doesNotMatch(uBuddyMarkup, /计划模式/);
state.composerToolMenuOpen = false;

const mentionProjects = state.projects;
const mentionActiveProjectId = state.activeProjectId;
state.projects = [];
state.activeProjectId = '';
state.socialMentionMenuOpen = true;
const uBuddyWithoutProjectMarkup = renderChat();
assert.match(uBuddyWithoutProjectMarkup, /class="project-reference-disabled"[^>]*data-select-project-reference-workspace[^>]*>选择文件夹后可以 @ 引用项目文件<\/button>/);
assert.doesNotMatch(uBuddyWithoutProjectMarkup, /project-reference-(?:disabled-add|add-mark|directory-add)/);
state.projects = mentionProjects;
state.activeProjectId = mentionActiveProjectId;
state.socialMentionMenuOpen = false;

state.friendOverview = {
  friends: [{ friend: { id: 'friend_mention', displayName: '联系人小林', username: 'xiaolin' } }],
  organizations: [{
    id: 'organization_mention',
    name: '产品组织',
    members: [
      { user: { id: 'friend_mention', displayName: '联系人小林', username: 'xiaolin' } },
      { user: { id: 'organization_contact_mention', displayName: '组织联系人小周', email: 'zhou@example.com' } },
    ],
  }],
  requests: { incoming: [], outgoing: [] },
};
state.currentUser = { id: 'organization_owner', displayName: '组织负责人' };
state.activeAccountWorkspace = {
  id: 'workspace_org_organization_mention',
  workspaceKind: 'organization',
  organizationId: 'organization_mention',
};
state.friendOverview.organizations[0].members.unshift({
  user: { id: 'organization_owner', displayName: '组织负责人' },
});
const originalMentionRoster = structuredClone(state.employeeOverview.roster);
state.employeeOverview.roster[1].displayName = 'PPT Agent C';
state.employeeOverview.roster.push(
  { id: 'ppt_instance_b', agentFamilyId: 'ppt', displayName: 'PPT Agent B', routeEligible: true },
  { id: 'ppt_instance_a', agentFamilyId: 'ppt', displayName: 'PPT Agent A', routeEligible: true },
);
state.socialMentionMenuOpen = true;
state.projectReferenceBrowseProjectId = state.activeProjectId;
state.projectReferenceProjectId = state.activeProjectId;
state.projectReferenceEntries = [
  { kind: 'directory', name: 'src', relativePath: 'src' },
  { kind: 'file', name: 'README.md', relativePath: 'README.md' },
];
const openUBuddyMentionMarkup = renderChat();
const organizationGroupIndex = openUBuddyMentionMarkup.indexOf('data-project-mention-group="organization"');
const contactsGroupIndex = openUBuddyMentionMarkup.indexOf('data-project-mention-group="contacts"');
const contactIndex = openUBuddyMentionMarkup.indexOf('联系人小林', contactsGroupIndex);
const organizationContactIndex = openUBuddyMentionMarkup.indexOf('组织联系人小周', contactsGroupIndex);
const agentsGroupIndex = openUBuddyMentionMarkup.indexOf('data-project-mention-group="agents"');
const agentAIndex = openUBuddyMentionMarkup.indexOf('data-ubuddy-mention-agent-instance="ppt_instance_a"', agentsGroupIndex);
const agentBIndex = openUBuddyMentionMarkup.indexOf('data-ubuddy-mention-agent-instance="ppt_instance_b"', agentsGroupIndex);
const agentCIndex = openUBuddyMentionMarkup.indexOf('data-ubuddy-mention-agent-instance="ppt_instance"', agentsGroupIndex);
const filesGroupIndex = openUBuddyMentionMarkup.indexOf('data-project-mention-group="files"');
assert.ok(organizationGroupIndex >= 0 && organizationGroupIndex < contactsGroupIndex,
  'the active organization audience must render before individual contacts');
assert.match(openUBuddyMentionMarkup, /data-ubuddy-mention-principal="organization"/);
assert.match(openUBuddyMentionMarkup, /data-ubuddy-mention-organization="organization_mention"/);
assert.match(openUBuddyMentionMarkup, /data-ubuddy-mention-audience="all_members"/);
assert.match(openUBuddyMentionMarkup, /产品组织 · 2 位成员，不含我/);
assert.ok(contactsGroupIndex >= 0 && contactsGroupIndex < contactIndex, 'uBuddy @ picker must render the contacts group and its entries');
assert.ok(contactIndex < organizationContactIndex && organizationContactIndex < agentsGroupIndex, 'organization-only contacts must be included in the contacts group');
assert.ok(contactIndex < agentsGroupIndex && agentsGroupIndex < agentAIndex, 'contacts must render before Agents in the uBuddy @ picker');
assert.ok(agentAIndex < agentBIndex && agentBIndex < agentCIndex, 'same-family Agents must render in natural alphabetical order');
assert.ok(agentCIndex < filesGroupIndex, 'project files must render after contacts and Agents in the uBuddy @ picker');
assert.match(openUBuddyMentionMarkup, /class="project-mention-entity[^"]*"[^>]+data-ubuddy-mention-user="friend_mention"/);
assert.match(openUBuddyMentionMarkup, /class="project-mention-entity[^"]*"[^>]+data-ubuddy-mention-user="organization_contact_mention"/);
assert.equal((openUBuddyMentionMarkup.match(/data-ubuddy-mention-user="friend_mention"/g) || []).length, 1, 'friend and organization membership must deduplicate by account');
assert.match(openUBuddyMentionMarkup, /data-project-reference-directory="src"/);
assert.match(openUBuddyMentionMarkup, /data-project-reference-select="README\.md"/);
assert.doesNotMatch(openUBuddyMentionMarkup, /project-reference-(?:disabled-add|add-mark|directory-add)/);
const organizationWorkspace = state.activeAccountWorkspace;
state.activeAccountWorkspace = { id: 'workspace_personal', kind: 'personal', organizationId: '' };
const personalWorkspaceMentionMarkup = renderChat();
assert.match(personalWorkspaceMentionMarkup, /data-project-mention-group="organization"/,
  'joined organization audiences must remain available in the personal Workspace');
assert.match(personalWorkspaceMentionMarkup, /data-ubuddy-mention-token="@所有人"/);
assert.match(personalWorkspaceMentionMarkup, /产品组织 · 2 位成员，不含我/);
state.friendOverview.organizations.push({
  id: 'organization_design',
  name: '设计组织',
  members: [
    { user: { id: 'organization_owner', displayName: '组织负责人' } },
    { user: { id: 'organization_designer', displayName: '设计成员' } },
  ],
});
const multipleOrganizationMentionMarkup = renderChat();
assert.match(multipleOrganizationMentionMarkup, /data-ubuddy-mention-token="@产品组织所有人"/);
assert.match(multipleOrganizationMentionMarkup, /data-ubuddy-mention-token="@设计组织所有人"/);
state.friendOverview.organizations.pop();
state.activeAccountWorkspace = organizationWorkspace;
const mentionPickerCss = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(mentionPickerCss, /\.project-mention-entity\s*\{[^}]*background:\s*#fff;[^}]*text-align:\s*left;/s);
assert.match(mentionPickerCss, /\.project-mention-menu\s*\{[^}]*width:\s*min\(400px,[^}]*background:\s*#fff;/s);
assert.doesNotMatch(mentionPickerCss, /\.project-reference-(?:disabled-add|add-mark|directory-add)\s*\{/);
state.socialMentionMenuOpen = false;
state.chatDraft = '@组织联系人小周 请整理需求';
state.composerMentions = [{
  principalType: 'user', userId: 'organization_contact_mention', displayText: '@组织联系人小周', mentionId: 'picker_test', source: 'picker',
}];
state.secretaryMentions = [...state.composerMentions];
const highlightedMentionMarkup = renderChat();
assert.match(highlightedMentionMarkup, /class="social-mention-highlight"[^>]*><mark class="social-mention-token">@组织联系人小周<\/mark> 请整理需求<\/div>/);
assert.match(highlightedMentionMarkup, /<textarea id="chat-input" class="mention-token-input"/);
const mentionToken = '@组织联系人小周';
assert.equal(mentionDeletionRange({ value: `${mentionToken} `, tokens: [mentionToken], key: 'Backspace', selectionStart: mentionToken.length + 1 }), null,
  'the trailing space must be deleted separately before Backspace removes the mention');
assert.deepEqual(mentionDeletionRange({ value: mentionToken, tokens: [mentionToken], key: 'Backspace', selectionStart: mentionToken.length }), { start: 0, end: mentionToken.length });
assert.deepEqual(mentionDeletionRange({ value: `${mentionToken} `, tokens: [mentionToken], key: 'Delete', selectionStart: 0 }), { start: 0, end: mentionToken.length },
  'forward Delete must remove only the mention and leave its trailing space for the next key press');
assert.equal(mentionDeletionRange({ value: ' ', tokens: [mentionToken], key: 'Delete', selectionStart: 0 }), null);
assert.deepEqual(mentionDeletionRange({ value: mentionToken, tokens: [mentionToken], key: 'Backspace', selectionStart: 3 }), { start: 0, end: mentionToken.length },
  'a caret inside a mention must still remove the whole mention');
state.socialMentionMenuOpen = false;
state.chatDraft = '';
state.composerMentions = [];
state.secretaryMentions = [];
state.projectReferenceBrowseProjectId = '';
state.friendOverview = { friends: [], requests: { incoming: [], outgoing: [] } };
state.activeAccountWorkspace = { id: 'workspace_personal', workspaceKind: 'personal', organizationId: '' };
state.employeeOverview.roster = originalMentionRoster;

state.currentSessionId = 'secretary_session';
state.sessions = [{ id: 'secretary_session', departmentId: 'secretary_department', agentId: 'secretary_agent', agentInstanceId: 'ubuddy_instance' }];
state.composerMemoryMenuOpen = true;
state.composerMemoryAgentInstanceId = 'ubuddy_instance';
state.composerMemoryDocuments = [
  { id: 'ubuddy_memory0', scope: 'general', slotNo: 0, displayName: 'memory0.md', lifecycleState: 'active' },
  { id: 'ubuddy_memory1', scope: 'general', slotNo: 1, displayName: 'memory1.md', lifecycleState: 'inactive' },
  { id: 'ubuddy_memory_archived', scope: 'general', slotNo: 2, displayName: 'memory2.md', lifecycleState: 'archived' },
];
state.composerMemoryContext = { activeMemoryDocumentId: 'ubuddy_memory0' };
const uBuddyMemoryMarkup = renderChat();
assert.doesNotMatch(uBuddyMemoryMarkup, /data-composer-memory-checkpoint/);
assert.match(uBuddyMemoryMarkup, /data-composer-memory-create/);
assert.match(uBuddyMemoryMarkup, /data-composer-memory-switch="ubuddy_memory1"/);
assert.doesNotMatch(uBuddyMemoryMarkup, /ubuddy_memory_archived/);
assert.doesNotMatch(uBuddyMemoryMarkup, /清除 Memory（封存并新建）/);

state.memoryNameDialog = { agentInstanceId: 'ubuddy_instance', source: 'composer', draft: '新对话 2', busy: false, error: '' };
const memoryNameMarkup = renderMemoryNameModal();
assert.match(memoryNameMarkup, /id="memory-name-form"/);
assert.match(memoryNameMarkup, /name="displayName"/);
assert.match(memoryNameMarkup, /创建并切换/);
state.memoryNameDialog = null;

state.homeMode = 'department';
state.sessions = [{ id: 'secretary_session', departmentId: 'secretary_department', agentId: 'secretary_agent' }];
state.currentSessionId = 'secretary_session';
state.composerMemoryMenuOpen = false;
const uBuddySessionMarkup = renderChat();
assert.doesNotMatch(uBuddySessionMarkup, /data-composer-ubuddy-mode/);
assert.match(uBuddySessionMarkup, /data-social-mention-toggle/);

const uBuddyModeState = {
  busy: false,
  interactionMode: '',
  homeMode: 'secretary',
  composerImageMode: false,
  composerToolMenuOpen: true,
  sandboxPermission: '',
  currentSessionId: 'ubuddy_plan_session',
};
const uBuddyModeUpdates = [];
const uBuddyModeNotices = [];
const uBuddyModeController = createProjectComposerController({
  api: {
    updateSession: async (payload) => {
      uBuddyModeUpdates.push(payload);
      return { id: payload.sessionId, departmentId: 'secretary_department', interactionMode: payload.interactionMode };
    },
  },
  state: uBuddyModeState,
  notify: (message) => uBuddyModeNotices.push(message),
  render: () => {},
  normalizePathKey: (value) => value,
  pathBasename: (value) => value,
  saveSandboxPermission: () => {},
  focusChatInputAtEnd: () => {},
  currentChatRun: () => null,
  isUBuddyComposerMode: () => true,
  preserveChatDraftFromInput: () => {},
  upsertRecentSession: () => {},
  projectById: () => null,
});
await uBuddyModeController.setComposerInteractionMode('plan');
assert.equal(uBuddyModeState.interactionMode, '', 'uBuddy plan mode must remain unsupported');
assert.equal(uBuddyModeUpdates.length, 0, 'unsupported uBuddy plan mode must not mutate the session');
await uBuddyModeController.setComposerInteractionMode('goal');
assert.equal(uBuddyModeState.interactionMode, '', 'uBuddy goal mode must remain unsupported');
assert.equal(uBuddyModeUpdates.length, 0, 'unsupported uBuddy modes must not mutate the session');
assert.ok(uBuddyModeNotices.length > 0, 'unsupported uBuddy modes must explain the limitation');

const rendererSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const employeeChatSource = rendererSource.match(/function openEmployeeChat[\s\S]*?\n}\n\nfunction notify/)?.[0] || '';
assert.match(employeeChatSource, /employee\.agentFamilyId === 'secretary_agent'/);
assert.doesNotMatch(employeeChatSource, /defaultRecruited === true/);
assert.match(employeeChatSource, /openUBuddyConversation\(\)/);
assert.match(employeeChatSource, /startNewPlainChat\(\{ renderNow: false, focus: false \}\)/);
assert.match(employeeChatSource, /state\.homeMode = 'department'/);
assert.doesNotMatch(rendererSource, /data-composer-ubuddy-mode|setUBuddyComposerMode/);
const createComposerMemorySource = rendererSource.match(/async function createComposerMemory[\s\S]*?\n}\n\nfunction openMemoryNameDialog/)?.[0] || '';
assert.match(createComposerMemorySource, /openMemoryNameDialog/);
assert.doesNotMatch(createComposerMemorySource, /window\.prompt/);

for (const relativePath of [
  '../src/renderer/app/views/networkView.js',
  '../src/renderer/app/views/messageHomeView.js',
  '../src/renderer/app/views/employeesView.js',
]) {
  assert.doesNotMatch(readFileSync(new URL(relativePath, import.meta.url), 'utf8'), /\?{4,}/, `${relativePath} contains corrupted user-visible copy`);
}

const originalConversation = {
  currentTab: 'chat',
  networkMessageHomeOpen: false,
  networkConversationPeerId: 'friend_1',
  networkConversationGroupId: '',
  networkConversationMode: 'person',
  networkConversationBusy: false,
  networkConversationMessages: [{ id: 'direct_1' }],
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  socialMentionMenuOpen: false,
  homeMode: 'department',
  currentDepartmentId: 'ppt_department',
  currentAgentId: 'ppt',
  selectionSource: 'employee',
  modelMenuOpen: false,
  imageModelMenuOpen: false,
  pptTemplateMenuOpen: false,
  pptStyleMenuOpen: false,
  agentMenuOpen: false,
  chatDraft: '尚未发送的原聊天草稿',
  secretarySessionId: '',
  currentSessionId: 'existing_chat',
  currentChatKey: 'session:existing_chat',
  sessions: [{ id: 'existing_chat', departmentId: 'ppt_department' }],
  messages: [{ id: 'existing_message' }],
  networkConversationDrafts: {},
  contextUsage: { sessionId: 'existing_chat', stateRevision: 28, usagePercent: 28, measurementState: 'available' },
  uBuddyConversationOpening: false,
};
const failureState = structuredClone(originalConversation);
const failureNotices = [];
let failureRenderCount = 0;
const failureController = createNetworkWorkspaceController({
  api: { ensureSecretarySession: async () => { throw new Error('offline'); } },
  state: failureState,
  render: () => { failureRenderCount += 1; },
  notify: (message) => failureNotices.push(message),
  userErrorMessage: (error) => error.message,
  preserveChatDraftFromInput: () => failureState.chatDraft,
  focusChatInputAtEnd: () => {},
  scrollMessagesToBottom: () => {},
});
assert.equal(await failureController.openUBuddyConversation(), null);
assert.deepEqual(failureState, originalConversation, 'failed uBuddy open must preserve the original conversation state');
assert.equal(failureRenderCount, 2, 'failed optimistic navigation must render once immediately and once to restore the original conversation');
assert.match(failureNotices[0] || '', /offline/);

const immediateState = structuredClone(originalConversation);
let releaseImmediateMessages;
const immediateMessages = new Promise((resolve) => { releaseImmediateMessages = resolve; });
let immediateRenderCount = 0;
const immediateController = createNetworkWorkspaceController({
  api: {
    ensureSecretarySession: async () => ({ id: 'ubuddy_immediate', title: 'uBuddy', departmentId: 'secretary_department', agentId: 'secretary_agent', writeState: 'writable' }),
    listMessages: async () => immediateMessages,
    chatContextStatus: async () => null,
  },
  state: immediateState,
  render: () => { immediateRenderCount += 1; },
  notify: () => {},
  userErrorMessage: (error) => error.message,
  preserveChatDraftFromInput: () => immediateState.chatDraft,
  focusChatInputAtEnd: () => {},
  scrollMessagesToBottom: () => {},
  syncCurrentChatRun: () => {},
  restoreActiveRunTransient: () => {},
});
const immediateOpen = immediateController.openUBuddyConversation();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(immediateState.currentTab, 'chat');
assert.equal(immediateState.currentSessionId, '');
assert.equal(immediateState.homeMode, 'secretary');
assert.equal(immediateState.uBuddyConversationOpening, true);
assert.equal(immediateRenderCount, 1, 'uBuddy must paint its conversation shell before messages hydrate');
releaseImmediateMessages([{ id: 'ubuddy_immediate_message' }]);
assert.equal(await immediateOpen, 'ubuddy_immediate');
assert.equal(immediateState.currentSessionId, 'ubuddy_immediate');
assert.equal(immediateState.homeMode, 'secretary');
assert.equal(immediateState.uBuddyConversationOpening, false);
assert.deepEqual(immediateState.messages.map((message) => message.id), ['ubuddy_immediate_message']);
assert.equal(immediateRenderCount, 2, 'uBuddy must commit hydrated messages with one follow-up render');

const successState = structuredClone(originalConversation);
let ensureCalls = 0;
const successController = createNetworkWorkspaceController({
  api: {
    ensureSecretarySession: async () => {
      ensureCalls += 1;
      return { id: 'ubuddy_primary', title: 'uBuddy', departmentId: 'secretary_department', agentId: 'secretary_agent', conversationRole: 'primary', writeState: 'writable' };
    },
    listMessages: async () => [{ id: 'ubuddy_welcome', role: 'assistant', content: '我是 uBuddy。' }],
    chatContextStatus: async () => ({ sessionId: 'ubuddy_primary', stateRevision: 1, usagePercent: 0, measurementState: 'unknown' }),
  },
  state: successState,
  render: () => {},
  notify: () => {},
  userErrorMessage: (error) => error.message,
  preserveChatDraftFromInput: () => successState.chatDraft,
  focusChatInputAtEnd: () => {},
  scrollMessagesToBottom: () => {},
  syncCurrentChatRun: () => {},
  restoreActiveRunTransient: () => {},
});
assert.equal(await successController.openUBuddyConversation(), 'ubuddy_primary');
assert.equal(await successController.openUBuddyConversation(), 'ubuddy_primary');
assert.equal(successState.currentSessionId, 'ubuddy_primary');
assert.equal(successState.currentChatKey, 'session:ubuddy_primary');
assert.equal(successState.homeMode, 'secretary');
assert.equal(successState.chatDraft, '', 'opening uBuddy must not leak a direct-message draft into the uBuddy composer');
assert.equal(successState.messages[0]?.id, 'ubuddy_welcome');
assert.equal(successState.contextUsage?.sessionId, 'ubuddy_primary');
assert.equal(successState.contextUsage?.usagePercent, 0, 'opening uBuddy must replace the previous conversation context usage');
assert.equal(successState.sessions.filter((item) => item.id === 'ubuddy_primary').length, 1);
assert.equal(successState.networkConversationDrafts['friend_1:person'], '尚未发送的原聊天草稿');
assert.equal(ensureCalls, 1, 'reopening the active uBuddy conversation must not repeat session hydration');

successState.messages = [{
  id: 'trigger_message_1',
  role: 'user',
  content: '@管理员 写一份环境治理报告给我。',
  metadata: {},
}, {
  id: 'published_task_card_message',
  role: 'assistant',
  content: '任务已确认发布。',
  metadata: {
    publishedTaskCards: [{
      delegationId: 'delegation_card_1',
      title: '环境治理报告',
      instruction: '写一份环境治理报告给我。',
      status: 'assigned',
      groupId: 'group_card_1',
      sourceContext: {
        source_conversation_id: 'ubuddy_primary',
        source_message_id: 'trigger_message_1',
        source_group_id: '',
        task_workspace_id: 'delegation_card_1',
      },
    }],
  },
}];
state.messages = successState.messages;
state.currentSessionId = 'ubuddy_primary';
state.currentChatKey = 'session:ubuddy_primary';
state.homeMode = 'secretary';
state.sessions = successState.sessions;
state.agentDelegations = [];
const publishedTaskCardMarkup = renderChat();
for (const action of ['open_workspace', 'cancel_task']) {
  assert.match(publishedTaskCardMarkup, new RegExp(`data-task-card-action="${action}"`));
}
assert.doesNotMatch(publishedTaskCardMarkup, /data-task-card-action="open_flow_graph"/);
state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newTaskWorkspaceUi: false };
const legacyPublishedTaskCardMarkup = renderChat();
assert.doesNotMatch(legacyPublishedTaskCardMarkup, /data-task-card-action="open_workspace"/);
assert.doesNotMatch(legacyPublishedTaskCardMarkup, /data-task-card-action="open_flow_graph"/);
assert.match(legacyPublishedTaskCardMarkup, /data-task-card-action="cancel_task"/);
state.uBuddyFeatureFlags = { ...state.uBuddyFeatureFlags, newTaskWorkspaceUi: true };
assert.match(publishedTaskCardMarkup, /data-task-source-conversation-id="ubuddy_primary"/);
assert.match(publishedTaskCardMarkup, /data-task-source-message-id="trigger_message_1"/);
assert.match(publishedTaskCardMarkup, /data-task-workspace-id="delegation_card_1"/);
assert.ok(
  publishedTaskCardMarkup.indexOf('data-message-id="trigger_message_1"')
    < publishedTaskCardMarkup.indexOf('data-task-workspace-id="delegation_card_1"'),
  'the published card must render below its source user message',
);
assert.ok(
  publishedTaskCardMarkup.indexOf('data-task-workspace-id="delegation_card_1"')
    < publishedTaskCardMarkup.indexOf('data-message-id="published_task_card_message"'),
  'the published card must not remain attached to the assistant confirmation message',
);

state.messages = [{
  id: 'local_trigger', role: 'user', content: '告诉通用 Agent 整理名单。', metadata: {},
}, {
  id: 'local_published', role: 'assistant', content: '任务已发布。', metadata: { publishedTaskCards: [{
    taskWorkspaceId: 'local_agent_session', workspaceKind: 'agent_session', targetSessionId: 'local_agent_session',
    workId: 'local_work_1', title: '整理名单', instruction: '整理名单。', status: 'queued',
    sourceContext: { source_conversation_id: 'ubuddy_primary', source_message_id: 'local_trigger', task_workspace_id: 'local_agent_session' },
  }] },
}];
const localAgentCardMarkup = renderChat();
assert.match(localAgentCardMarkup, /data-task-workspace-kind="agent_session"/);
assert.match(localAgentCardMarkup, /data-task-target-session-id="local_agent_session"/);
assert.match(localAgentCardMarkup, /data-task-work-id="local_work_1"/);
assert.doesNotMatch(localAgentCardMarkup, /查看流程图/);
state.messages = [...state.messages, {
  id: 'local_completed', role: 'assistant', content: '任务已完成。',
  metadata: { workId: 'local_work_1', agentDeliveryCompleted: true, targetSessionId: 'local_agent_session' },
}];
const completedLocalAgentCardMarkup = renderChat();
assert.match(completedLocalAgentCardMarkup, /<b>已完成<\/b>/);
assert.doesNotMatch(completedLocalAgentCardMarkup, /停止单 Agent 任务/);
Object.assign(state, {
  activeTaskWorkspaceKind: 'agent_session',
  activeTaskWorkspaceId: 'local_agent_session',
  activeTaskSourceContext: { source_conversation_id: 'ubuddy_primary', source_message_id: 'local_trigger', task_workspace_id: 'local_agent_session' },
  activeTaskReturnAnchorId: 'local_trigger',
  activeTaskReturnSurface: 'session',
  currentSessionId: 'local_agent_session',
  sessions: [{ id: 'local_agent_session', departmentId: 'general', agentId: 'general_agent' }],
  messages: [{ id: 'local_agent_reply', role: 'assistant', content: '正在整理。', metadata: {} }],
});
const localAgentWorkspaceMarkup = renderChat();
assert.match(localAgentWorkspaceMarkup, /本地 Agent 任务工作区/);
assert.match(localAgentWorkspaceMarkup, /data-task-card-action="return_to_source_chat"/);
Object.assign(state, {
  activeTaskWorkspaceKind: '', activeTaskWorkspaceId: '', activeTaskSourceContext: null,
  activeTaskReturnAnchorId: '', activeTaskReturnSurface: '',
});

Object.assign(state, {
  currentUser: { id: 'owner_1', displayName: 'Owner' },
  networkPanelOpen: true,
  networkConversationPeerId: 'friend_1',
  networkConversationMode: 'person',
  networkConversationMessages: [],
  collaborationGroupId: '',
  collaborationGroupDetail: null,
  friendOverview: { friends: [{ friend: { id: 'friend_1', displayName: '好友一' } }], requests: { incoming: [], outgoing: [] } },
  agentDelegations: [{
    id: 'direct_published_task', title: '环境治理报告', instruction: '写一份环境治理报告给我。', status: 'assigned',
    metadata: {
      source_conversation_id: 'direct:owner_1:friend_1',
      source_message_id: 'direct_source_message_1',
      task_workspace_id: 'direct_published_task',
      originalInstruction: '@我的uBuddy @好友一 写一份环境治理报告给我。',
    },
  }],
});
const directPublishedTaskMarkup = renderChat();
assert.match(directPublishedTaskMarkup, /data-message-id="direct_source_message_1"[\s\S]*data-task-workspace-id="direct_published_task"/);
assert.match(directPublishedTaskMarkup, /data-task-return-anchor-id="direct_source_message_1"/);

let releaseWorkspaceRefresh;
const workspaceRefresh = new Promise((resolve) => { releaseWorkspaceRefresh = resolve; });
const focusDelegationId = 'focus-during-open';
const focusTask = {
  id: focusDelegationId,
  requesterUserId: 'alice',
  recipientUserId: 'bob',
  status: 'assigned',
  title: '首次打开焦点测试',
};
const sourceAttachment = { id: 'source-attachment', name: '尚未发送.md' };
const focusState = {
  currentTab: 'chat',
  networkPanelOpen: true,
  networkPanelView: 'tasks',
  networkConversationPeerId: '',
  networkConversationGroupId: '',
  networkDelegationId: '',
  networkDelegationEditingMessageId: '',
  networkDelegationMemory: null,
  networkDelegationMemoryMenuOpen: false,
  networkConversationMessages: [],
  networkConversationBusy: false,
  networkDelegationCommentDrafts: { [focusDelegationId]: '继续编辑' },
  networkDelegationRunsById: {},
  networkDelegationTaskById: {},
  agentDelegations: [focusTask],
  collaborationOverview: { tasks: [focusTask] },
  attachments: [sourceAttachment],
  chatDraft: '原聊天未发送草稿',
  composerMentions: [{ mentionId: 'source-mention' }],
  secretaryMentions: [],
};
let renderedDelegationInput = null;
let focusRenderCount = 0;
const sourceMessageList = { scrollTop: 128, scrollHeight: 900, clientHeight: 400 };
const focusDocument = {
  activeElement: null,
  getElementById(id) {
    return id === 'network-delegation-comment-input' ? renderedDelegationInput : null;
  },
  querySelector(selector) { return selector === '#message-list' ? sourceMessageList : null; },
};
const renderFocusWorkspace = () => {
  focusRenderCount += 1;
  renderedDelegationInput = {
    id: 'network-delegation-comment-input',
    value: focusState.networkDelegationCommentDrafts[focusDelegationId] || '',
    selectionStart: 2,
    selectionEnd: 2,
    scrollTop: 0,
    focus() { focusDocument.activeElement = this; },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
};
const focusController = createNetworkWorkspaceController({
  api: {
    collaborationWorkspaceMessages: async () => [],
    delegationTaskMemory: async () => null,
    listAgentDelegations: async () => [focusTask],
  },
  state: focusState,
  render: renderFocusWorkspace,
  notify: () => {},
  userErrorMessage: (error) => error.message,
  refreshCollaborationOverview: async () => workspaceRefresh,
  preserveChatDraftFromInput: () => focusState.chatDraft,
  documentRef: focusDocument,
  setTimer: (callback) => callback(),
});
const openingWorkspace = focusController.openNetworkDelegation(focusDelegationId);
await Promise.resolve();
assert.equal(focusRenderCount, 1, 'opening a workspace must render its cached surface immediately');
assert.equal(focusState.attachments.length, 0, 'workspace attachments must be isolated from the source composer');
renderedDelegationInput.focus();
renderedDelegationInput.setSelectionRange(3, 3);
sourceMessageList.scrollTop = 0;
releaseWorkspaceRefresh();
await openingWorkspace;
assert.equal(focusRenderCount, 2);
assert.equal(focusDocument.activeElement, renderedDelegationInput,
  'the final workspace refresh must restore focus to the replacement composer');
assert.equal(renderedDelegationInput.selectionStart, 3);
assert.equal(renderedDelegationInput.selectionEnd, 3);
await focusController.returnToTaskSourceChat();
assert.equal(focusState.networkDelegationId, '');
assert.equal(focusState.networkPanelView, 'tasks', 'workspace back must restore the exact source surface');
assert.deepEqual(focusState.attachments, [sourceAttachment]);
assert.equal(focusState.chatDraft, '原聊天未发送草稿');
assert.equal(focusState.composerMentions[0]?.mentionId, 'source-mention');
assert.equal(sourceMessageList.scrollTop, 128, 'workspace back must restore the exact source scroll position');

let resolveReturnRefresh;
const returnRefresh = new Promise((resolve) => { resolveReturnRefresh = resolve; });
const returnRaceState = {
  workspaceSwitchGeneration: 1,
  currentTab: 'chat', currentSessionId: 'target_session', currentChatKey: 'session:target_session',
  networkDelegationId: '', networkConversationBusy: false, networkDelegationEditingMessageId: '',
  networkDelegationMemory: null, networkDelegationMemoryMenuOpen: false, attachments: [],
  activeTaskSourceContext: { source_conversation_id: 'source_session', source_message_id: 'source_message' },
  activeTaskReturnAnchorId: 'source_message', activeTaskReturnSurface: 'session', activeTaskReturnScrollTop: 0,
  activeTaskWorkspaceKind: 'agent_session', activeTaskWorkspaceId: 'target_session',
  taskWorkspaceReturnContext: {
    currentTab: 'chat', currentSessionId: 'source_session', currentChatKey: 'session:source_session', currentAgentInstanceId: '',
    homeMode: 'secretary', networkPanelOpen: false, networkPanelView: 'messages', networkMessageHomeOpen: false,
    networkConversationPeerId: '', networkConversationGroupId: '', networkConversationMode: 'person', networkConversationMessages: [],
    collaborationGroupId: '', collaborationGroupDetail: null, messages: [{ id: 'source_old' }], contextUsage: null,
    taskDetail: null, chatDraft: '', attachments: [], composerMentions: [], secretaryMentions: [], socialMentionMenuOpen: false,
    sourceContext: { source_conversation_id: 'source_session', source_message_id: 'source_message' },
    returnAnchorId: 'source_message', returnSurface: 'session', sourceScrollTop: 0,
  },
};
const returnRaceController = createNetworkWorkspaceController({
  api: { listMessages: () => returnRefresh }, state: returnRaceState, render: () => {}, notify: () => {},
  userErrorMessage: (error) => error.message, focusActiveComposerInput: () => {}, scrollMessagesToBottom: () => {},
  syncCurrentChatRun: () => {}, restoreActiveRunTransient: () => {},
  documentRef: { querySelector: () => null, querySelectorAll: () => [] }, setTimer: (callback) => callback(),
});
const returningToSource = returnRaceController.returnToTaskSourceChat();
await Promise.resolve();
returnRaceState.messages = [...returnRaceState.messages, { id: 'new_optimistic_message' }];
resolveReturnRefresh([{ id: 'stale_refresh_message' }]);
await returningToSource;
assert.equal(returnRaceState.messages.some((message) => message.id === 'new_optimistic_message'), true,
  'a delayed return refresh must not overwrite newer local messages');

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const taskAMessages = deferred();
const taskBMessages = deferred();
const raceTasks = [{ id: 'race-a', metadata: {} }, { id: 'race-b', metadata: {} }];
const raceState = {
  currentTab: 'chat', currentSessionId: 'race-source', currentChatKey: 'session:race-source', homeMode: 'secretary',
  networkPanelOpen: false, networkPanelView: 'messages', networkMessageHomeOpen: false,
  networkConversationPeerId: '', networkConversationGroupId: '', networkConversationMode: 'person', networkConversationMessages: [],
  networkDelegationId: '', networkDelegationRunsById: {}, networkDelegationTaskById: {},
  collaborationGroupId: '', collaborationGroupDetail: null, collaborationOverview: { tasks: raceTasks },
  agentDelegations: raceTasks, attachments: [], composerMentions: [], secretaryMentions: [],
};
const raceController = createNetworkWorkspaceController({
  api: {
    listAgentDelegations: async () => raceTasks,
    collaborationWorkspaceMessages: ({ delegationId }) => delegationId === 'race-a' ? taskAMessages.promise : taskBMessages.promise,
    delegationTaskMemory: async () => null,
  },
  state: raceState,
  render: () => {},
  notify: () => {},
  userErrorMessage: (error) => error.message,
  refreshCollaborationOverview: async () => {},
  documentRef: { activeElement: null, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  setTimer: (callback) => callback(),
});
const openingA = raceController.openNetworkDelegation('race-a');
await Promise.resolve();
const openingB = raceController.openNetworkDelegation('race-b');
await Promise.resolve();
taskBMessages.resolve([{ content: '任务 B', metadata: { privateTaskWorkspace: true, delegationId: 'race-b' } }]);
await openingB;
taskAMessages.resolve([{ content: '任务 A', metadata: { privateTaskWorkspace: true, delegationId: 'race-a' } }]);
await openingA;
assert.equal(raceState.networkDelegationId, 'race-b');
assert.equal(raceState.networkConversationMessages[0]?.content, '任务 B', 'a stale workspace response must not overwrite the active task');

console.log('uBuddy composer visibility checks passed.');
