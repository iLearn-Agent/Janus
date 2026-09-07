import assert from 'node:assert/strict';
import fs from 'node:fs';

import { renderWindowTitlebar } from '../src/renderer/app/components/overlays.js';
import { chatRunBelongsToActiveAccount } from '../src/renderer/app/features/chat/messageSendController.js';
import { createAuthController } from '../src/renderer/app/features/settings/authController.js';
import { state } from '../src/renderer/app/state.js';
import { loadRecentAccountWorkspaceIds, saveRecentAccountWorkspaceIds } from '../src/renderer/app/storage.js';
import { renderSidebar } from '../src/renderer/app/views/navigationView.js';
import { renderContactsWorkspace } from '../src/renderer/app/views/networkView.js';

const organizationWorkspaces = [1, 2, 3, 4, 5, 6].map((index) => ({
  id: `workspace_org_renderer_${index}`,
  kind: 'organization',
  organizationId: `organization_renderer_${index}`,
  name: `Renderer Org ${index}`,
  role: 'member',
}));
Object.assign(state, {
  languageMode: 'zh',
  currentUser: { id: 'workspace-renderer-user', displayName: 'Workspace User' },
  accountWorkspaces: [
    { id: 'workspace_personal', kind: 'personal', name: '个人空间', role: 'owner' },
    ...organizationWorkspaces,
  ],
  activeAccountWorkspace: organizationWorkspaces[4],
  startupAccountWorkspace: organizationWorkspaces[1],
  recentAccountWorkspaceIds: [
    'workspace_org_renderer_3',
    'workspace_org_stale',
    'workspace_org_renderer_2',
    'workspace_personal',
  ],
  accountWorkspaceMenuOpen: true,
  workspaceSwitchBusy: false,
});

const markup = renderWindowTitlebar();
assert.doesNotMatch(markup, /data-account-workspace-toggle/);
state.currentTab = 'chat';
state.accountMenuOpen = true;
state.accountMenuWorkspaceOpen = false;
const sidebarMarkup = renderSidebar();
assert.doesNotMatch(sidebarMarkup, /<strong>Janus<\/strong>/);
assert.match(sidebarMarkup, /class="sidebar-profile-area/);
assert.match(sidebarMarkup, /class="account-card sidebar-account-button" id="account-card"/);
assert.match(sidebarMarkup, /data-account-menu-action="settings"/);
assert.match(sidebarMarkup, /data-account-menu-action="logout"/);
assert.match(sidebarMarkup, /<strong>设置<\/strong>/);
assert.match(sidebarMarkup, /<strong>退出登录<\/strong>/);
assert.doesNotMatch(sidebarMarkup, /account-menu-workspace-toggle/,
  'the avatar menu must only contain account actions');
assert.equal((sidebarMarkup.match(/class="account-dock-button account-dock-workspace/g) || []).length, 2,
  'the dock must show one recent organization and Personal');
assert.match(sidebarMarkup, /data-account-workspace-id="workspace_org_renderer_5"/,
  'the active organization must be promoted into the recent dock slot');
assert.match(sidebarMarkup, /class="account-dock-button account-dock-workspace is-active"\s+type="button" data-account-workspace-id="workspace_org_renderer_5"/,
  'the highlight must follow the current organization');
assert.match(sidebarMarkup, /aria-label="当前组织：Renderer Org 5；可通过更多工作空间切换组织"/,
  'the active organization shortcut must explain how to reach other organizations');
assert.match(sidebarMarkup, /class="account-dock-workspace-tooltip"[^>]*role="tooltip">当前组织：Renderer Org 5；可通过更多工作空间切换组织<\/span>/);
assert.match(sidebarMarkup, /data-account-workspace-id="workspace_personal"/);
assert.match(sidebarMarkup, /data-account-workspace-source="account-dock-personal"[\s\S]*?<span class="account-dock-workspace-mark"><svg/,
  'Personal must use the user icon in the dock');
assert.doesNotMatch(sidebarMarkup, /account-dock-workspace-mark">个</,
  'Personal must not fall back to the Chinese initial');
assert.match(sidebarMarkup, /data-account-workspace-account-toggle/);
assert.match(sidebarMarkup, /data-account-workspace-account-toggle[^>]*aria-describedby="account-workspace-tooltip-more"/);
assert.match(sidebarMarkup, /class="account-dock-workspace-tooltip" id="account-workspace-tooltip-more" role="tooltip">更多工作空间<\/span>/,
  'the plus shortcut must reuse the organization tooltip instead of the browser title tooltip');
assert.doesNotMatch(sidebarMarkup, /data-account-workspace-account-toggle[^>]*title=/);
assert.doesNotMatch(sidebarMarkup, /workspace_org_stale/);
assert.doesNotMatch(sidebarMarkup, /data-account-update/,
  'the update control must stay hidden when no update is available');

state.accountMenuOpen = false;
state.accountMenuWorkspaceOpen = true;
state.accountMenuWorkspaceMoreOpen = true;
const expandedSidebarMarkup = renderSidebar();
assert.equal((expandedSidebarMarkup.match(/data-account-workspace-source="account-dock-more"/g) || []).length, 7);
assert.match(expandedSidebarMarkup, /aria-label="选择工作空间"/);
assert.match(expandedSidebarMarkup, /data-account-workspace-id="workspace_personal"/);
assert.match(expandedSidebarMarkup, /data-account-workspace-id="workspace_org_renderer_6"/);
assert.match(expandedSidebarMarkup, /class="account-menu-workspace-option is-active"[^>]*data-account-workspace-id="workspace_org_renderer_5"/,
  'the expanded menu must highlight the current organization');
assert.doesNotMatch(expandedSidebarMarkup, /class="account-menu-workspace-option is-active"[^>]*data-account-workspace-id="workspace_org_renderer_2"/,
  'the default organization must not override the current highlight');
assert.doesNotMatch(expandedSidebarMarkup, /workspace_org_stale/);

state.accountMenuWorkspaceOpen = false;
state.updates = { available: true };
const updateSidebarMarkup = renderSidebar();
assert.doesNotMatch(updateSidebarMarkup, /data-account-update/,
  'the lower dock must contain workspace switching controls only');
state.updates = null;

state.activeAccountWorkspace = state.accountWorkspaces[0];
const activePersonalMarkup = renderSidebar();
assert.match(activePersonalMarkup, /class="account-dock-button account-dock-workspace is-active"\s+type="button" data-account-workspace-id="workspace_personal"/,
  'the highlight must move to Personal when Personal becomes current');
assert.doesNotMatch(activePersonalMarkup, /class="account-dock-button account-dock-workspace is-active"\s+type="button" data-account-workspace-id="workspace_org_renderer_2"/,
  'the default organization must remain unselected while Personal is current');
assert.match(activePersonalMarkup, /aria-label="切换为组织 Renderer Org 3"/,
  'an inactive organization shortcut must identify the organization it switches to');

state.activeAccountWorkspace = state.startupAccountWorkspace;
const activeDefaultMarkup = renderSidebar();
assert.match(activeDefaultMarkup, /class="account-dock-button account-dock-workspace is-active"\s+type="button" data-account-workspace-id="workspace_org_renderer_2"/,
  'the default organization is highlighted once it also becomes current');
state.activeAccountWorkspace = organizationWorkspaces[4];

const fullWorkspaceList = state.accountWorkspaces;
const fullActiveWorkspace = state.activeAccountWorkspace;
state.accountWorkspaces = [fullWorkspaceList[0]];
state.activeAccountWorkspace = fullWorkspaceList[0];
const personalOnlyMarkup = renderSidebar();
assert.equal((personalOnlyMarkup.match(/class="account-dock-button account-dock-workspace/g) || []).length, 1);
assert.doesNotMatch(personalOnlyMarkup, /data-account-workspace-account-toggle/);

state.accountWorkspaces = [fullWorkspaceList[0], fullWorkspaceList[1]];
const personalAndOrganizationMarkup = renderSidebar();
assert.equal((personalAndOrganizationMarkup.match(/class="account-dock-button account-dock-workspace/g) || []).length, 2);
assert.doesNotMatch(personalAndOrganizationMarkup, /data-account-workspace-account-toggle/);
assert.match(personalAndOrganizationMarkup, /aria-label="切换为组织 Renderer Org 1；暂无其他可切换组织"/,
  'the only organization must explain both the switch target and the lack of alternatives');
state.activeAccountWorkspace = fullWorkspaceList[1];
const onlyActiveOrganizationMarkup = renderSidebar();
assert.match(onlyActiveOrganizationMarkup, /aria-label="当前组织：Renderer Org 1；暂无其他可切换组织"/,
  'the active sole organization must not look like an inert placeholder');
state.languageMode = 'en';
state.activeAccountWorkspace = fullWorkspaceList[0];
const englishSingleOrganizationMarkup = renderSidebar();
assert.match(englishSingleOrganizationMarkup, /aria-label="Switch to organization Renderer Org 1; no other organizations available"/);
state.languageMode = 'zh';
state.accountWorkspaces = fullWorkspaceList;
state.activeAccountWorkspace = fullActiveWorkspace;

state.friendDirectoryCategory = 'organizations';
state.contactsActivePane = 'contacts';
state.contactsSelectedOrganizationId = 'organization_renderer_1';
state.friendOverview = {
  friends: [],
  requests: { incoming: [], outgoing: [] },
  organizations: organizationWorkspaces.map((workspace, index) => ({
    id: workspace.organizationId,
    name: workspace.name,
    organizationNumber: `ORG-${index + 1}`,
    role: 'member',
  })),
};
state.organizationSettingsWorkspaceMoreOpen = true;
state.organizationSettingsWorkspaceMorePosition = { left: 420, top: 180 };
const organizationSettingsMarkup = renderContactsWorkspace();
assert.equal((organizationSettingsMarkup.match(/data-organization-settings-workspace-location="primary"/g) || []).length, 3);
assert.equal((organizationSettingsMarkup.match(/data-organization-settings-workspace-location="more"/g) || []).length, 2);
assert.match(organizationSettingsMarkup, /data-organization-settings-workspace-more-toggle/);
assert.match(organizationSettingsMarkup, /aria-label="其他组织"/);
assert.doesNotMatch(organizationSettingsMarkup, /data-account-workspace-id="workspace_personal"/,
  'organization settings must never include Personal');

const localValues = new Map();
const previousWindow = globalThis.window;
globalThis.window = {
  localStorage: {
    getItem: (key) => localValues.get(key) ?? null,
    setItem: (key, value) => localValues.set(key, value),
  },
};
saveRecentAccountWorkspaceIds('workspace-renderer-user', ['workspace_org_renderer_3', 'workspace_org_renderer_3', 'workspace_personal']);
saveRecentAccountWorkspaceIds('other-user', ['workspace_org_other']);
assert.deepEqual(loadRecentAccountWorkspaceIds('workspace-renderer-user'), ['workspace_org_renderer_3', 'workspace_personal']);
assert.deepEqual(loadRecentAccountWorkspaceIds('other-user'), ['workspace_org_other']);
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

const rendererSource = fs.readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');
const dockStyles = fs.readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
assert.match(dockStyles, /\.account-dock-workspace:hover \.account-dock-workspace-tooltip/);
assert.match(dockStyles, /\.account-dock-workspace:focus-visible \.account-dock-workspace-tooltip/);
assert.match(dockStyles, /\.account-dock-more:hover \.account-dock-workspace-tooltip/);
assert.match(dockStyles, /\.account-dock-more:focus-visible \.account-dock-workspace-tooltip/);
assert.match(dockStyles, /\.account-dock-workspace-tooltip\s*\{[^}]*bottom:\s*calc\(100% \+ 7px\)[^}]*color:\s*#263446[^}]*background:\s*#ffffff/s,
  'workspace tooltips must expand upward with a light-theme surface');
const themeStyles = fs.readFileSync(new URL('../src/renderer/styles/theme.css', import.meta.url), 'utf8');
assert.match(themeStyles, /\.shell\.theme-dark \.account-dock-workspace-tooltip\s*\{[^}]*color:\s*#f7f9fc[^}]*background:\s*#202834/s,
  'workspace tooltips must use the matching dark-theme surface');
assert.match(rendererSource, /workspaceSwitchGeneration/);
assert.match(rendererSource, /persistComposerDrafts\(\)/);
assert.match(rendererSource, /resetWorkspaceScopedState:\s*resetWorkspaceScopedRendererState/);
assert.match(rendererSource, /switchAccountWorkspace\(\{ workspaceId: targetId \}\)/);
assert.match(rendererSource, /rendererWorkspaceStorageScope/);
assert.match(rendererSource, /renderWorkspaceSwitchProgress\(\)/);
assert.match(rendererSource, /正在切换到 \$\{targetName\}/);
assert.match(rendererSource, /Switching to \$\{targetName\}/);
assert.match(rendererSource, /requestAnimationFrame\(\(\) => resolve\(\)\)/,
  'the switching indicator must paint before the bootstrap request starts');
const runtimeSource = fs.readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
assert.match(runtimeSource, /switchAccountWorkspace[\s\S]*?this\.bootstrap\(\{ remote: false \}\)/,
  'workspace switching must not block its first paint on remote bootstrap refreshes');
const ipcSource = fs.readFileSync(new URL('../src/main/ipc/registerIpcHandlers.js', import.meta.url), 'utf8');
assert.doesNotMatch(ipcSource, /account-workspaces:switch[\s\S]{0,300}await getFeishuChannelService/,
  'workspace switching must not wait for the remote-channel reconcile');

const runningChat = {
  ownerUserId: 'workspace-renderer-user',
  accountWorkspaceId: 'workspace_org_renderer',
  workspaceSwitchGeneration: 4,
};
const runningChatState = {
  currentUser: { id: 'workspace-renderer-user' },
  activeAccountWorkspace: { id: 'workspace_org_renderer' },
  workspaceSwitchGeneration: 4,
};
assert.equal(chatRunBelongsToActiveAccount(runningChat, runningChatState), true);
runningChatState.workspaceSwitchGeneration = 5;
assert.equal(chatRunBelongsToActiveAccount(runningChat, runningChatState), true,
  'a chat run remains owned by its workspace across renderer switch generations');
runningChatState.workspaceSwitchGeneration = 4;
runningChatState.activeAccountWorkspace = { id: 'workspace_personal' };
assert.equal(chatRunBelongsToActiveAccount(runningChat, runningChatState), false,
  'a chat run must not refresh its old session from another workspace');

const accountBWorkspace = { id: 'workspace_org_account_b', kind: 'organization', organizationId: 'org_account_b', name: 'Account B Org' };
const authState = {
  currentUser: { id: 'account_a' },
  accountWorkspaces: [{ id: 'workspace_org_account_a', kind: 'organization', name: 'Account A Org' }],
  activeAccountWorkspace: { id: 'workspace_org_account_a', kind: 'organization', name: 'Account A Org' },
  startupAccountWorkspace: { id: 'workspace_org_account_a', kind: 'organization', name: 'Account A Org' },
  workspaceRoot: '/tmp/account-a',
  workspaceSwitchGeneration: 4,
  currentTab: 'chat',
};
let workspaceResetCount = 0;
let hydratedWorkspaceId = '';
let nextAuthBoot = {
  currentUser: { id: 'account_b', displayName: 'Account B' },
  accountWorkspaces: [{ id: 'workspace_personal', kind: 'personal', name: '个人空间' }, accountBWorkspace],
  activeAccountWorkspace: accountBWorkspace,
  startupAccountWorkspace: accountBWorkspace,
  workspaceRoot: '/tmp/account-b',
  org: { departments: [], agents: [], hrs: [], leaders: [], name: 'Account B Org' },
  sessions: [], projects: [], tasks: [], agentStatuses: [],
};
const authController = createAuthController({
  api: { bootstrap: async () => nextAuthBoot },
  documentRef: {},
  state: authState,
  render: () => {},
  notify: () => {},
  hydrateComposerDrafts: () => { hydratedWorkspaceId = authState.activeAccountWorkspace?.id || ''; },
  isCurrentUserAdmin: () => false,
  refreshReleaseStatus: async () => {},
  loadRememberedLoginIdentifier: () => '',
  saveRememberedLoginIdentifier: () => {},
  userVisibleErrorMessage: (error) => String(error?.message || error || ''),
  resetWorkspaceScopedState: () => { workspaceResetCount += 1; },
  windowRef: {},
});
await authController.refreshBootstrapAfterAuth();
assert.equal(workspaceResetCount, 1);
assert.equal(authState.currentUser.id, 'account_b');
assert.equal(authState.activeAccountWorkspace.id, 'workspace_org_account_b');
assert.equal(authState.startupAccountWorkspace.id, 'workspace_org_account_b');
assert.deepEqual(authState.accountWorkspaces.map((item) => item.id), ['workspace_personal', 'workspace_org_account_b']);
assert.equal(authState.workspaceRoot, '/tmp/account-b');
assert.equal(hydratedWorkspaceId, 'workspace_org_account_b');
assert.equal(authState.workspaceSwitchGeneration, 5);
nextAuthBoot = {
  currentUser: null,
  accountWorkspaces: [],
  activeAccountWorkspace: null,
  startupAccountWorkspace: null,
  workspaceRoot: '',
  org: { departments: [], agents: [], hrs: [], leaders: [] },
  sessions: [], projects: [], tasks: [], agentStatuses: [],
};
await authController.refreshBootstrapAfterAuth();
assert.equal(workspaceResetCount, 2);
assert.equal(authState.currentUser, null);
assert.deepEqual(authState.accountWorkspaces, []);
assert.equal(authState.activeAccountWorkspace, null);
assert.equal(authState.startupAccountWorkspace, null);
assert.equal(authState.workspaceRoot, '');
assert.equal(authState.workspaceSwitchGeneration, 6);

let resolveInitialSocialPull;
let initialSocialPullCount = 0;
let socialThreadRefreshCount = 0;
let loginRenderCount = 0;
const loginState = {
  currentUser: null,
  currentTab: 'settings',
  workspaceSwitchGeneration: 0,
  authDraft: {},
};
const loginBoot = {
  currentUser: { id: 'login_social_user', displayName: 'Login Social User' },
  accountWorkspaces: [{ id: 'workspace_personal', kind: 'personal', name: '个人空间' }],
  activeAccountWorkspace: { id: 'workspace_personal', kind: 'personal', name: '个人空间' },
  startupAccountWorkspace: { id: 'workspace_personal', kind: 'personal', name: '个人空间' },
  workspaceRoot: '/tmp/login-social-user',
  org: { departments: [], agents: [], hrs: [], leaders: [] },
  sessions: [], projects: [], tasks: [], agentStatuses: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [], agentDelegations: [], collaboration: { groups: [], tasks: [] },
};
const loginController = createAuthController({
  api: {
    login: async () => ({ ok: true }),
    bootstrap: async () => loginBoot,
    pollSocialNetwork: async () => {
      initialSocialPullCount += 1;
      return new Promise((resolve) => { resolveInitialSocialPull = resolve; });
    },
  },
  documentRef: {
    getElementById(id) {
      if (id === 'login-identifier') return { value: 'login_social_user' };
      if (id === 'login-password') return { value: 'password' };
      return null;
    },
  },
  state: loginState,
  render: () => { loginRenderCount += 1; },
  notify: () => {},
  hydrateComposerDrafts: () => {},
  isCurrentUserAdmin: () => false,
  refreshReleaseStatus: async () => {},
  refreshSocialThreads: async () => { socialThreadRefreshCount += 1; },
  loadRememberedLoginIdentifier: () => '',
  saveRememberedLoginIdentifier: () => {},
  userVisibleErrorMessage: (error) => String(error?.message || error || ''),
  resetWorkspaceScopedState: () => {},
  windowRef: {},
});
await loginController.loginAccount({ preventDefault() {} });
assert.equal(initialSocialPullCount, 1, 'successful login must start one immediate social pull');
assert.ok(loginRenderCount >= 1, 'the authenticated local bootstrap must render before the social pull settles');
assert.deepEqual(loginState.socialInbox, []);
resolveInitialSocialPull({
  status: { connected: true },
  friends: { friends: [{ friend: { id: 'login_friend', displayName: 'Login Friend' } }], requests: { incoming: [], outgoing: [] } },
  inbox: [{ id: 'login_message', senderUserId: 'login_friend', content: '登录后自动拉取' }],
  delegations: [], collaboration: { groups: [], tasks: [] }, chatGroups: { groups: [] },
});
await new Promise((resolve) => setImmediate(resolve));
assert.equal(loginState.socialInbox[0].id, 'login_message');
assert.equal(loginState.friendOverview.friends[0].friend.id, 'login_friend');
assert.equal(socialThreadRefreshCount, 1);

const preloadSource = fs.readFileSync(new URL('../src/preload/preload.js', import.meta.url), 'utf8');
assert.match(preloadSource, /account-workspaces:list/);
assert.match(preloadSource, /account-workspaces:switch/);

const chatStyles = fs.readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');
const accountMenuStyles = chatStyles.slice(chatStyles.indexOf('.account-menu {'), chatStyles.indexOf('.account-menu-item {'));
assert.match(accountMenuStyles, /width:\s*220px/);
assert.match(accountMenuStyles, /max-width:\s*220px/);
assert.match(chatStyles, /\.account-menu-workspace-more-submenu\s*\{/);
assert.match(chatStyles, /left:\s*calc\(100% \+ 8px\)/);

console.log(JSON.stringify({ ok: true, workspaceOptions: state.accountWorkspaces.length }, null, 2));
