import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-auth-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const anonymousBootstrap = {
  root: tempRoot,
  workspaceRoot: '',
  org: { departments: [], agents: [], hrs: [] },
  sessions: [], projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: null, adminUsers: [],
  accountWorkspaces: [], activeAccountWorkspace: null, startupAccountWorkspace: null,
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [], agentDelegations: [], socialStatus: { enabled: true, connected: false },
  codexConfig: {}, codexConfigFiles: null, cloudSync: null, modelCatalog: { models: [] },
};
const authenticatedBootstrap = {
  ...anonymousBootstrap,
  workspaceRoot: path.join(tempRoot, 'renderer-auth-org-workspace'),
  currentUser: {
    id: 'user_renderer_auth', email: 'new.user@example.com', displayName: 'New User',
    display_name: 'New User', username: 'new_user', role: 'member', permissions: {}, remoteBound: true,
  },
  accountWorkspaces: [
    { id: 'workspace_personal', kind: 'personal', name: '个人空间', role: 'owner' },
    { id: 'workspace_org_renderer_auth', kind: 'organization', organizationId: 'org_renderer_auth', name: '认证测试组织', role: 'member' },
  ],
  activeAccountWorkspace: { id: 'workspace_org_renderer_auth', kind: 'organization', organizationId: 'org_renderer_auth', name: '认证测试组织', role: 'member' },
  startupAccountWorkspace: { id: 'workspace_org_renderer_auth', kind: 'organization', organizationId: 'org_renderer_auth', name: '认证测试组织', role: 'member' },
  socialStatus: { enabled: true, connected: true },
  managedProviderUsage: {
    enabled: true,
    managedProvider: true,
    limited: true,
    dailyTokenLimit: 500_000,
    dailyTokensUsed: 0,
    dailyTokensRemaining: 500_000,
    usagePercent: 0,
    exhausted: false,
  },
  friendOverview: {
    friends: [
      {
        id: 'friendship_renderer', status: 'accepted',
        friend: { id: 'user_bob_renderer', displayName: 'Bob Renderer', username: 'bob_renderer', email: 'bob.renderer@example.com' },
      },
      { id: 'legacy_empty_friendship', friend: null },
    ],
    requests: { incoming: {}, outgoing: null },
  },
  collaborationOverview: { groups: { legacy: true }, tasks: null },
  pptxPluginStatus: { id: 'ppt_creation', installed: true, downloaded: true, available: true, error: '' },
  userAgentSettings: [{
    id: 'instance_renderer_auth',
    agentFamilyId: 'agent_renderer_auth',
    syncEnabled: true,
    personalEvolutionConsent: false,
    clusterContributionConsent: false,
    family: { id: 'agent_renderer_auth', name: 'Renderer Agent' },
    memoryDocuments: [{
      id: 'memory_renderer_auth', scope: 'general', slotNo: 0,
      displayName: 'memory0', lifecycleState: 'active', syncEnabled: true,
      allowPersonalEvolution: false, allowClusterEvolution: false,
    }, {
      id: 'memory_renderer_auth_1', scope: 'general', slotNo: 1,
      displayName: 'memory1', lifecycleState: 'active', syncEnabled: true,
      allowPersonalEvolution: true, allowClusterEvolution: true,
    }],
  }],
  personalEvolutionStatus: {
    enabled: true, scope: 'personal', authority: 'cloud', algorithmVersion: 'personal_cloud_authority_v1',
    providerBoundary: 'platform_managed', grantReady: false, configured: false, executionAvailable: false,
    readiness: { database: false, model: false, encryption: false }, code: 'cloud_not_configured',
  },
  personalEvolutionProposals: [],
  stage8EvolutionStatus: { authority: 'cloud', cluster: { enabled: true }, market: { enabled: true }, performance: { enabled: true }, leadership: { enabled: true } },
  clusterEvolutionOverview: {
    cohorts: [{ id: 'cohort_renderer', status: 'active' }],
    runs: [{ id: 'run_renderer', status: 'running', updatedAt: '2026-07-24T10:00:00.000Z' }],
    candidates: [{ id: 'candidate_renderer', status: 'shadow_passed', updatedAt: '2026-07-24T11:00:00.000Z' }],
  },
  employees: {
    authority: 'cloud',
    capabilities: { multiMemory: { enabled: true, readOnly: false, authority: 'local_first', syncState: 'ready' } },
    quota: { used: 1, active: 1, reserved: 0, limit: 10, remaining: 9 },
    roster: [{
      id: 'instance_renderer_auth', agentFamilyId: 'agent_renderer_auth', instanceKind: 'professional',
      employmentState: 'active', routeEligible: true, queueDepth: 0,
      family: { id: 'agent_renderer_auth', name: 'Renderer Agent', departmentId: 'renderer_department' },
      currentMemory: { id: 'memory_renderer_auth', displayName: 'memory0' },
      performance: {
        level: 'P5', score: 78.5, provisional: false, completedTaskCount: 26, terminalAttemptCount: 29,
        quality: 84, reliability: 91, firstPass: 76, efficiency: 72, collaborationSafety: 88,
        peerBaselineKind: 'same_family', peerSampleCount: 12, contributionWeight: 1.2,
        windowStartedAt: '2026-04-25T00:00:00.000Z', windowEndedAt: '2026-07-24T00:00:00.000Z',
      },
      leadership: {
        level: 'L1', score: 73.5, status: 'active', provisional: false, leadershipTaskCount: 12,
        crossDepartmentTaskCount: 2, teamLeadTrialCount: 1, crossTeamTrialCount: 0, nextLevel: 'L2',
        metrics: { deliveryQuality: 81, decompositionMatching: 74, reviewReworkControl: 70, dependencyCoordination: 76, teamEfficiencyUplift: 62, safety: 93 },
        promotion: { ready: false, reasons: ['leadership_tasks_insufficient', 'team_lead_trials_insufficient'] },
      },
      leadershipActions: [],
      leadershipAppeals: [{ id: 'appeal_renderer', appealKind: 'assessment', status: 'rejected', submittedReason: '请求复核一次异常评分', decisionReason: '证据复核后维持原评分', updatedAt: '2026-07-23T10:00:00.000Z' }],
      availableMarketVersions: [{ id: 'market_renderer_v1' }],
      marketEffectiveSkill: { marketVersionId: 'market_renderer_v1' },
    }],
    recruitableFamilies: [{
      id: 'agent_renderer_auth', name: 'Renderer Agent', departmentId: 'renderer_department',
      canRecruit: false, routable: true, status: 'active',
    }],
  },
};

const htmlPath = path.join(tempRoot, 'renderer-auth-smoke.html');
writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>Renderer auth smoke</title><link rel="stylesheet" href="${rendererStyle}"></head>
  <body>
    <div id="app"></div>
    <script>
      const anonymousBootstrap = ${JSON.stringify(anonymousBootstrap)};
      const authenticatedBootstrap = ${JSON.stringify(authenticatedBootstrap)};
      localStorage.setItem('janus-last-login-identifier', 'remembered@example.com');
      window.__janusAuthTest = { registrations: [], emailCodes: [], emailCodeResolver: null, deferEmailCode: false, passwordChanges: [], friendRequests: [], friendRequestActions: [], leadershipAppealSubmissions: [], userAgentSettingUpdates: [], evolutionPreferenceUpdates: [], evolutionVersionActions: [], evolutionChecks: 0, activePersonalVersionId: '', evolutionPreference: { authority: 'cloud', enabled: true, stateRevision: 1 }, updateChecks: { software: 0, agents: 0 }, agentDownloadAttempts: 0, failSoftwareUpdateCheck: false, authenticated: false, errors: [], subscriptions: {} };
      window.confirm = () => true;
      const eventSubscription = (name) => (listener) => {
        window.__janusAuthTest.subscriptions[name] = listener;
        return () => { delete window.__janusAuthTest.subscriptions[name]; };
      };
      window.addEventListener('error', (event) => {
        window.__janusAuthTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__janusAuthTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
      });
      window.janus = {
        platform: 'win32',
        bootstrap: async () => window.__janusAuthTest.authenticated ? authenticatedBootstrap : anonymousBootstrap,
        updateStatus: async () => ({ status: 'available', available: true, version: '0.1.0' }),
        agentUpdateStatus: async () => ({ enabled: true, status: 'idle', available: false }),
        checkForUpdates: async () => {
          window.__janusAuthTest.updateChecks.software += 1;
          if (window.__janusAuthTest.failSoftwareUpdateCheck) throw new Error('software feed fixture unavailable');
          return { enabled: true, available: false, downloaded: false, lastCheckAt: '2026-07-16T08:00:00.000Z' };
        },
        checkAgentUpdates: async () => {
          window.__janusAuthTest.updateChecks.agents += 1;
          return {
            enabled: true,
            available: false,
            downloaded: false,
            lastCheckAt: '2026-07-16T08:00:01.000Z',
            current: { bundleId: 'agents-next-candidate', releaseVersion: '0.1.1' },
            candidate: null,
            message: 'Janus 0.1.1 was applied automatically.',
          };
        },
        downloadAgentUpdate: async () => {
          window.__janusAuthTest.agentDownloadAttempts += 1;
          const failed = window.__janusAuthTest.agentDownloadAttempts === 1;
          return {
            enabled: true,
            available: true,
            downloaded: !failed,
            lastCheckAt: '2026-07-16T08:00:01.000Z',
            current: { bundleId: 'agents-current', releaseVersion: '0.1.0' },
            candidate: {
              artifact: { bundleId: 'agents-next-candidate', releaseVersion: '0.1.1' },
              manifest: { version: '0.1.1', changeSummary: 'Daily governed organization update fixture.' },
            },
            lastError: failed ? 'system proxy blocked the Node HTTP stack' : '',
            failureStage: failed ? 'download' : '',
            message: failed ? 'Agent update download failed.' : 'Agent laboratory 0.1.1 downloaded.',
          };
        },
        applyAgentUpdate: async () => ({
          enabled: true,
          available: false,
          downloaded: false,
          lastCheckAt: '2026-07-16T08:00:01.000Z',
          current: { bundleId: 'agents-next-candidate', releaseVersion: '0.1.1', backupPath: '/tmp/agents-current' },
          candidate: {
            artifact: { bundleId: 'agents-next-candidate', releaseVersion: '0.1.1' },
            manifest: { version: '0.1.1', changeSummary: 'Daily governed organization update fixture.' },
          },
          message: 'Agent 组织 0.1.1 已应用，新对话将使用更新后的组织配置。',
        }),
        onCodexEvent: eventSubscription('codex'),
        onUpdateStatus: eventSubscription('updates'),
        onAgentUpdateStatus: eventSubscription('agentUpdates'),
        onEvolutionProgress: eventSubscription('evolution'),
        onModelsUpdated: eventSubscription('models'),
        onSocialUpdated: eventSubscription('social'),
        pptxPluginStatus: async () => authenticatedBootstrap.pptxPluginStatus,
        login: async () => {
          throw new Error("NetworkRequestError: Janus communication POST /api/auth/login failed (401): Invalid credentials.");
        },
        sendEmailCode: async (payload) => {
          if (payload.email === 'registered@example.com') {
            const error = new Error('Request failed (409).');
            error.code = 'email_already_registered';
            error.body = { error: { code: error.code, message: 'This email is already registered.' } };
            throw error;
          }
          if (payload.email === 'missing-mailbox@example.com') {
            const error = new Error('Request failed (422).');
            error.code = 'email_address_unreachable';
            error.body = { error: { code: error.code, message: 'This mailbox is unreachable.' } };
            throw error;
          }
          window.__janusAuthTest.emailCodes.push(payload);
          if (window.__janusAuthTest.deferEmailCode) {
            await new Promise((resolve) => { window.__janusAuthTest.emailCodeResolver = resolve; });
          }
          return { ok: true, delivery: 'email', email: payload.email, purpose: payload.purpose, expiresAt: new Date(Date.now() + 600000).toISOString(), retryAfterSeconds: 60 };
        },
        register: async (payload) => {
          window.__janusAuthTest.registrations.push(payload);
          window.__janusAuthTest.authenticated = true;
          return { user: authenticatedBootstrap.currentUser, accessToken: 'test-access', refreshToken: 'test-refresh' };
        },
        updatePassword: async (payload) => {
          window.__janusAuthTest.passwordChanges.push(payload);
          return { ok: true };
        },
        searchUsers: async (payload = {}) => {
          if (payload.query === '接口错误') {
            throw new Error("Error invoking remote method 'friends:search-users': NetworkRequestError: Janus communication GET /api/friends/search failed (400): 搜索条件无效。");
          }
          return [{
            id: 'user_bob_renderer', email: 'bob.renderer@example.com', username: 'bob_renderer',
            displayName: 'Bob Renderer', display_name: 'Bob Renderer', role: 'member', friendshipStatus: 'none',
          }];
        },
        sendFriendRequest: async (payload) => {
          window.__janusAuthTest.friendRequests.push(payload);
          return {
            ok: true,
            overview: {
              friends: [],
              requests: {
                incoming: [],
                outgoing: [{
                  id: 'friend_req_renderer', message: payload.message, status: 'pending',
                  user: { id: payload.userId, email: 'bob.renderer@example.com', displayName: 'Bob Renderer', username: 'bob_renderer' },
                }],
              },
            },
          };
        },
        acceptFriendRequest: async (payload) => {
          window.__janusAuthTest.friendRequestActions.push({ action: 'accept', ...payload });
          const incoming = authenticatedBootstrap.friendOverview.requests.incoming || [];
          const request = incoming.find((item) => item.id === payload.requestId);
          authenticatedBootstrap.friendOverview.requests.incoming = incoming.filter((item) => item.id !== payload.requestId);
          if (request?.user) authenticatedBootstrap.friendOverview.friends.push({ id: 'accepted_' + payload.requestId, status: 'accepted', friend: request.user });
          return { ok: true, overview: authenticatedBootstrap.friendOverview };
        },
        rejectFriendRequest: async (payload) => {
          window.__janusAuthTest.friendRequestActions.push({ action: 'reject', ...payload });
          authenticatedBootstrap.friendOverview.requests.incoming = (authenticatedBootstrap.friendOverview.requests.incoming || []).filter((item) => item.id !== payload.requestId);
          return { ok: true, overview: authenticatedBootstrap.friendOverview };
        },
        cancelFriendRequest: async (payload) => {
          window.__janusAuthTest.friendRequestActions.push({ action: 'cancel', ...payload });
          authenticatedBootstrap.friendOverview.requests.outgoing = (authenticatedBootstrap.friendOverview.requests.outgoing || []).filter((item) => item.id !== payload.requestId);
          return { ok: true, overview: authenticatedBootstrap.friendOverview };
        },
        friendsOverview: async () => authenticatedBootstrap.friendOverview,
        pollSocialNetwork: async () => ({
          status: authenticatedBootstrap.socialStatus,
          friends: authenticatedBootstrap.friendOverview,
          inbox: [], delegations: {}, collaboration: authenticatedBootstrap.collaborationOverview,
        }),
        socialConversation: async () => [],
        markSocialMessageRead: async () => ({ ok: true }),
        socialInbox: async () => [],
        listAgentDelegations: async () => [],
        collaborationOverview: async () => authenticatedBootstrap.collaborationOverview,
        chatGroupsOverview: async () => ({ capability: 'chat-groups-v2', groups: [] }),
        updateUserAgentSettings: async (payload) => {
          window.__janusAuthTest.userAgentSettingUpdates.push(payload);
          const item = authenticatedBootstrap.userAgentSettings[0];
          if (payload.memoryDocumentId) {
            const memory = item.memoryDocuments.find((entry) => entry.id === payload.memoryDocumentId);
            if (memory && Object.hasOwn(payload, 'allowPersonalEvolution')) memory.allowPersonalEvolution = payload.allowPersonalEvolution;
            if (memory && Object.hasOwn(payload, 'allowClusterEvolution')) memory.allowClusterEvolution = payload.allowClusterEvolution;
          } else {
            for (const field of ['syncEnabled', 'personalEvolutionConsent', 'clusterContributionConsent']) {
              if (Object.hasOwn(payload, field)) item[field] = payload[field];
            }
          }
          return { settings: authenticatedBootstrap.userAgentSettings };
        },
        userAgentSettings: async () => authenticatedBootstrap.userAgentSettings,
        evolutionPreference: async () => window.__janusAuthTest.evolutionPreference,
        setEvolutionPreference: async (payload) => {
          window.__janusAuthTest.evolutionPreferenceUpdates.push(payload);
          window.__janusAuthTest.evolutionPreference = {
            ...window.__janusAuthTest.evolutionPreference,
            enabled: payload.enabled,
            stateRevision: window.__janusAuthTest.evolutionPreference.stateRevision + 1,
            lastCommandId: payload.commandId,
            status: 'confirmed',
          };
          return window.__janusAuthTest.evolutionPreference;
        },
        checkEvolutionUpdates: async () => {
          window.__janusAuthTest.evolutionChecks += 1;
          const current = window.__janusAuthTest.activePersonalVersionId;
          const versions = [
            { id: 'personal_renderer_v2', status: current === 'personal_renderer_v2' ? 'active' : 'candidate', stabilityStatus: 'stable', available: !current, createdAt: '2026-07-25T08:00:00.000Z' },
            { id: 'personal_renderer_v1', status: current === 'personal_renderer_v1' ? 'active' : 'archived', stabilityStatus: 'stable', available: false, createdAt: '2026-07-24T08:00:00.000Z' },
          ];
          return { authority: 'cloud', checkedAt: '2026-07-25T09:00:00.000Z', preference: window.__janusAuthTest.evolutionPreference, personal: [{
            agentInstanceId: 'instance_renderer_auth', agentFamilyId: 'agent_renderer_auth', agentName: 'Renderer Agent',
            currentVersionId: current, availableCount: current ? 0 : 1, latestAvailableVersion: current ? null : versions[0], versions,
          }], market: [] };
        },
        personalEvolutionVersions: async () => {
          const current = window.__janusAuthTest.activePersonalVersionId;
          return { authority: 'cloud', items: [
            { id: 'personal_renderer_v2', status: current === 'personal_renderer_v2' ? 'active' : 'candidate', stabilityStatus: 'stable', available: !current, createdAt: '2026-07-25T08:00:00.000Z' },
            { id: 'personal_renderer_v1', status: current === 'personal_renderer_v1' ? 'active' : 'archived', stabilityStatus: 'stable', createdAt: '2026-07-24T08:00:00.000Z' },
          ] };
        },
        activatePersonalEvolutionVersion: async (payload) => {
          window.__janusAuthTest.evolutionVersionActions.push({ action: 'activate', ...payload });
          window.__janusAuthTest.activePersonalVersionId = payload.versionId;
          authenticatedBootstrap.userAgentSettings[0].activePersonalSkillVersionId = payload.versionId;
          return { authority: 'cloud', status: 'activated', activeVersionId: payload.versionId };
        },
        rollbackPersonalSkill: async (payload) => {
          window.__janusAuthTest.evolutionVersionActions.push({ action: 'rollback', ...payload });
          window.__janusAuthTest.activePersonalVersionId = payload.targetSkillVersionId || '';
          authenticatedBootstrap.userAgentSettings[0].activePersonalSkillVersionId = payload.targetSkillVersionId || '';
          return { authority: 'cloud', status: 'rolled_back', activeVersionId: payload.targetSkillVersionId || '' };
        },
        employeeOverview: async () => authenticatedBootstrap.employees,
        employeeLeadershipHistory: async () => ({ items: [{
          id: 'leadership_history_renderer', level: 'L1', score: 73.5, status: 'active', leadershipTaskCount: 12,
          windowEndedAt: '2026-07-24T00:00:00.000Z',
          metrics: { deliveryQuality: 81, decompositionMatching: 74, reviewReworkControl: 70, dependencyCoordination: 76, teamEfficiencyUplift: 62, safety: 93 },
        }] }),
        submitEmployeeLeadershipAppeal: async (payload) => {
          window.__janusAuthTest.leadershipAppealSubmissions.push(payload);
          return { item: { id: 'appeal_submitted_renderer', status: 'pending', ...payload } };
        },
        employeeMemoryDocuments: async () => authenticatedBootstrap.userAgentSettings[0].memoryDocuments,
        employeeContextSpaces: async () => ({ current: { activeContextSpaceId: 'context_renderer' }, items: [{ id: 'context_renderer', contextKind: 'general_memory', memoryDocumentId: 'memory_renderer_auth' }] }),
        employeeSessionHistory: async () => [],
        employeeMemoryVersions: async ({ memoryDocumentId }) => [{ id: 'memory_version_renderer', memoryDocumentId, versionNo: 1, content: '# Renderer Memory', createdAt: '2026-07-24T09:00:00.000Z', reviewStatus: 'approved' }],
        employeeMemoryDetails: async ({ memoryDocumentId }) => {
          const document = authenticatedBootstrap.userAgentSettings[0].memoryDocuments.find((entry) => entry.id === memoryDocumentId) || null;
          return document ? { document, versions: [{ id: 'memory_version_renderer', memoryDocumentId, versionNo: 1, content: '# Renderer Memory', createdAt: '2026-07-24T09:00:00.000Z', reviewStatus: 'approved' }], conflicts: [] } : null;
        },
        createEmployeeMemory: async (payload) => ({ document: { id: 'memory_renderer_created', displayName: payload.displayName || '新 Memory', lifecycleState: 'active' } }),
        archiveEmployeeMemory: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'archived' } }),
        switchEmployeeMemory: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'active' } }),
        clearEmployeeMemory: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'active' } }),
        restoreEmployeeMemory: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'active' } }),
        restoreAndSwitchEmployeeMemory: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'active' } }),
        renameEmployeeMemory: async ({ memoryDocumentId, displayName }) => ({ document: { id: memoryDocumentId, displayName } }),
        employeeMemoryConflicts: async () => ({ items: [] }),
        resolveEmployeeMemoryConflict: async ({ memoryDocumentId }) => ({ document: { id: memoryDocumentId, lifecycleState: 'active' } }),
        switchEmployeeContext: async ({ contextSpaceId }) => ({ contextSpace: { id: contextSpaceId }, contextSpaceId }),
        clusterEvolutionOverview: async () => authenticatedBootstrap.clusterEvolutionOverview,
        stage8EvolutionStatus: async () => authenticatedBootstrap.stage8EvolutionStatus,
        marketVersions: async () => ({
          items: [{
            id: 'market_renderer_v1', status: 'released', algorithmVersion: 'cluster_market_v2', createdAt: '2026-07-24T08:00:00.000Z',
            adoption: { full: '', sections: {} }, health: { status: 'healthy', baselineScore: 76, latestScore: 80, latestFailureRate: 0.04, observedTaskCount: 14 },
            sections: [{ sectionId: 'planning', title: '规划增强', content: '先确认目标，再拆分步骤。', supportCount: 5 }],
          }],
          effectiveSkill: { marketVersionId: 'market_renderer_v1', fullMarketVersionId: '', adoptedSections: ['planning'], conflicts: [], effectiveSkillHash: 'abcdef1234567890', effectiveSkill: '# Effective Skill' },
          canary: { policyVersion: 'market_canary_real_user_default_on_v2', optedIn: true, eligible: true,
            defaultEnrolled: true, explicitlyOptedOut: false, canOptOut: true, assignments: [] },
        }),
        personalEvolutionStatus: async () => authenticatedBootstrap.personalEvolutionStatus,
        listPersonalEvolutionProposals: async () => authenticatedBootstrap.personalEvolutionProposals,
        listEvolutionGrants: async () => ({ items: [] }),
        logout: async () => { window.__janusAuthTest.authenticated = false; return { ok: true }; },
        listSessions: async () => [],
        listTasks: async () => [],
        latestRelease: async () => ({ status: 'empty' }),
        minimizeWindow: async () => null,
        toggleMaximizeWindow: async () => null,
        closeWindow: async () => null,
      };
    </script>
    <script type="module" src="${rendererEntry}"></script>
  </body>
</html>`, 'utf8');

let browserWindow;
const clickSelector = (selector) => browserWindow.webContents.executeJavaScript(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('renderer auth smoke missing selector: ${selector}');
  element.click();
})()`);
const waitForText = (text) => browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = Date.now() + 5000;
  const expected = ${JSON.stringify(text)};
  const poll = () => {
    if (document.body.innerText.includes(expected)) return resolve(true);
    if (Date.now() > deadline) return reject(new Error('renderer auth smoke missing text: ' + expected));
    setTimeout(poll, 20);
  };
  poll();
})`);
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  const rendererConsole = [];
  browserWindow.webContents.on('console-message', (_event, level, message) => {
    rendererConsole.push(`[${level}] ${message}`);
  });
  await browserWindow.loadFile(htmlPath);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (document.querySelector('#login-form')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('login form did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const loginSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasLocalAdminButton: Boolean(document.querySelector('#local-admin-login-btn')),
    mentionsLocalAdmin: document.body.innerText.includes('local_admin'),
    accountLabelFontSize: getComputedStyle(document.querySelector('#login-identifier').closest('label').querySelector('span')).fontSize,
    accountInputFontSize: getComputedStyle(document.querySelector('#login-identifier')).fontSize,
    passwordLabelFontSize: getComputedStyle(document.querySelector('#login-password').closest('label').querySelector('span')).fontSize,
    passwordInputFontSize: getComputedStyle(document.querySelector('#login-password')).fontSize,
    nativeWindowFrame: document.querySelector('.window-titlebar')?.classList.contains('native-window-frame'),
    hasCustomWindowControls: Boolean(document.querySelector('.window-controls')),
    loginFormAutocomplete: document.querySelector('#login-form')?.autocomplete,
    identifierAutocomplete: document.querySelector('#login-identifier')?.autocomplete,
    passwordAutocomplete: document.querySelector('#login-password')?.autocomplete,
    passwordType: document.querySelector('#login-password')?.type,
  })`);
  assert.equal(loginSnapshot.hasLocalAdminButton, false);
  assert.equal(loginSnapshot.mentionsLocalAdmin, false);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#login-identifier').value`), 'remembered@example.com');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#login-password').value`), '');
  assert.ok(parseFloat(loginSnapshot.accountLabelFontSize) > parseFloat(loginSnapshot.accountInputFontSize));
  assert.ok(parseFloat(loginSnapshot.passwordLabelFontSize) > parseFloat(loginSnapshot.passwordInputFontSize));
  assert.equal(loginSnapshot.nativeWindowFrame, false);
  assert.equal(loginSnapshot.hasCustomWindowControls, true);
  assert.equal(loginSnapshot.loginFormAutocomplete, 'off');
  assert.equal(loginSnapshot.identifierAutocomplete, 'off');
  assert.equal(loginSnapshot.passwordAutocomplete, 'off');
  assert.equal(loginSnapshot.passwordType, 'password');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#login-password');
    input.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    input.focus();
    window.__janusAuthTest.focusedAuthInput = input;
    window.__janusAuthTest.subscriptions.updates?.({ checking: false, available: true, downloaded: false, version: '0.1.0' });
    window.__janusAuthTest.subscriptions.agentUpdates?.({ checking: false, available: false, downloaded: false, current: null });
    window.__janusAuthTest.subscriptions.models?.({ models: [] });
  })()`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    active: document.activeElement?.id,
    hasForm: Boolean(document.querySelector('#login-form')),
    hasCard: Boolean(document.querySelector('.auth-card')),
    sameInput: window.__janusAuthTest.focusedAuthInput === document.querySelector('#login-password'),
    inputConnected: window.__janusAuthTest.focusedAuthInput?.isConnected,
  })`), { active: 'login-password', hasForm: true, hasCard: true, sameInput: true, inputConnected: true });
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#login-password').value = 'wrong-password';
    document.querySelector('#login-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.auth-feedback')?.textContent.includes('账号或密码不正确。')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('sanitized login error was not shown'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const sanitizedLoginError = await browserWindow.webContents.executeJavaScript(`(() => {
    const feedback = document.querySelector('.auth-feedback');
    return {
      title: feedback?.querySelector('strong')?.textContent.trim() || '',
      message: feedback?.querySelector('.auth-feedback-copy > span')?.textContent.trim() || '',
      hint: feedback?.querySelector('small')?.textContent.trim() || '',
      role: feedback?.getAttribute('role') || '',
      hasIcon: Boolean(feedback?.querySelector('.auth-feedback-icon svg')),
      hasGlobalNotice: Boolean(document.querySelector('.app-notice')),
    };
  })()`);
  assert.deepEqual(sanitizedLoginError, {
    title: '账号或密码有误',
    message: '账号或密码不正确。',
    hint: '请检查邮箱或用户 ID，以及密码是否输入正确。',
    role: 'alert',
    hasIcon: true,
    hasGlobalNotice: false,
  });
  assert.equal(/NetworkRequestError|Janus communication|\/api\/auth\/login/.test(Object.values(sanitizedLoginError).join(' ')), false);

  await clickSelector('#show-password-reset-btn');
  const resetSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasForm: Boolean(document.querySelector('#password-reset-form')),
    passwordType: document.querySelector('#reset-new-password')?.type,
    passwordAutocomplete: document.querySelector('#reset-new-password')?.autocomplete,
  })`);
  assert.equal(resetSnapshot.hasForm, true);
  assert.equal(resetSnapshot.passwordType, 'password');
  assert.equal(resetSnapshot.passwordAutocomplete, 'new-password');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#reset-email');
    input.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    input.focus();
  })()`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.activeElement?.id`), 'reset-email');
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#password-reset-form'))`), true);
  await clickSelector('#back-to-login-btn');

  await clickSelector('#show-register-btn');
  const registerSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasCodeInput: Boolean(document.querySelector('#register-code')),
    hasCodeButton: Boolean(document.querySelector('#send-register-code-btn')),
    hasConfirm: Boolean(document.querySelector('#register-password-confirm')),
    formAutocomplete: document.querySelector('#register-form')?.autocomplete,
    fieldAutocompletes: Array.from(document.querySelectorAll('#register-form input')).map((input) => input.autocomplete),
    passwordTypes: Array.from(document.querySelectorAll('#register-password, #register-password-confirm')).map((input) => input.type),
    noValidate: document.querySelector('#register-form')?.noValidate,
  })`);
  assert.equal(registerSnapshot.hasCodeInput, true);
  assert.equal(registerSnapshot.hasCodeButton, true);
  assert.equal(registerSnapshot.hasConfirm, true);
  assert.equal(registerSnapshot.formAutocomplete, 'off');
  assert.deepEqual(registerSnapshot.fieldAutocompletes, ['off', 'off', 'off', 'off', 'off']);
  assert.deepEqual(registerSnapshot.passwordTypes, ['password', 'password']);
  assert.equal(registerSnapshot.noValidate, true);
  await browserWindow.webContents.executeJavaScript(`(() => {
    for (const input of document.querySelectorAll('#register-form input')) {
      input.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      input.focus();
      if (!document.querySelector('#register-form')) throw new Error('register form disappeared while focusing credentials');
    }
    const input = document.querySelector('#register-password-confirm');
    window.__janusAuthTest.focusedRegisterInput = input;
    window.__janusAuthTest.subscriptions.updates?.({ checking: false, available: true, downloaded: false, version: '0.1.0' });
    window.__janusAuthTest.subscriptions.agentUpdates?.({ checking: false, available: true, downloaded: false, current: null });
    window.__janusAuthTest.subscriptions.models?.({ models: [{ id: 'gpt-auth-regression' }] });
  })()`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    hasForm: Boolean(document.querySelector('#register-form')),
    active: document.activeElement?.id,
    sameInput: window.__janusAuthTest.focusedRegisterInput === document.querySelector('#register-password-confirm'),
    inputConnected: window.__janusAuthTest.focusedRegisterInput?.isConnected,
  })`), { hasForm: true, active: 'register-password-confirm', sameInput: true, inputConnected: true });

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-email').value = 'not-an-email';
    document.querySelector('#send-register-code-btn').click();
  })()`);
  await waitForText('邮箱格式不正确，请检查后重试。');
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.emailCodes.length`), 0);

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-email').value = 'registered@example.com';
    document.querySelector('#send-register-code-btn').click();
  })()`);
  await waitForText('该邮箱已被注册，请直接登录或使用其他邮箱。');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    title: document.querySelector('.auth-feedback strong')?.textContent.trim() || '',
    hint: document.querySelector('.auth-feedback small')?.textContent.trim() || '',
    hasGlobalNotice: Boolean(document.querySelector('.app-notice')),
  })`), {
    title: '该邮箱已注册',
    hint: '可直接返回登录，或使用其他邮箱。',
    hasGlobalNotice: false,
  });
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`Promise.all([
    import(${JSON.stringify(rendererStateEntry)}),
    import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'views', 'settingsView.js')).href)}),
    import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'i18n.js')).href)}),
  ]).then(([{ state }, { renderAuthPanel }, { translateUiText }]) => {
    state.languageMode = 'en';
    const host = document.createElement('div');
    host.innerHTML = renderAuthPanel();
    const authMessages = [
      '邮箱格式不正确，请检查后重试。', '该邮箱尚未注册。', '该邮箱已被注册，请直接登录或使用其他邮箱。',
      '该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。', '验证码邮件发送失败，请稍后重试；如果持续失败，请确认邮箱能够正常收件。',
      '请输入邮箱验证码。', '邮箱验证码应为 6 位数字。', '邮箱验证码已过期，请重新获取。', '邮箱验证码不正确。',
      '账号或密码不正确。', '邮箱尚未验证，请先完成邮箱验证。', '请输入邮箱或用户 ID。', '请输入密码。',
      '密码至少需要 8 位。', '两次输入的密码不一致。', '账号服务暂时无法访问。',
      '已登录。', '账号已创建并登录。', '现在可以使用新密码登录。',
    ];
    const untranslated = authMessages
      .map((source) => ({ source, translated: translateUiText(source, 'en') }))
      .filter(({ translated }) => /[\u3400-\u9fff]/.test(translated));
    const result = {
      title: host.querySelector('.auth-feedback strong')?.textContent.trim() || '',
      message: host.querySelector('.auth-feedback-copy > span')?.textContent.trim() || '',
      hint: host.querySelector('.auth-feedback small')?.textContent.trim() || '',
      containsChinese: /[\u3400-\u9fff]/.test(host.querySelector('.auth-feedback')?.textContent || ''),
      untranslated,
    };
    state.languageMode = 'zh-CN';
    return result;
  })`), {
    title: 'Email Already Registered',
    message: 'This email is already registered. Sign in or use another email.',
    hint: 'Return to sign in or use another email.',
    containsChinese: false,
    untranslated: [],
  });

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-email').value = 'missing-mailbox@example.com';
    document.querySelector('#send-register-code-btn').click();
  })()`);
  await waitForText('该邮箱不存在或无法接收邮件，请检查邮箱地址后重试。');

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-email').value = 'new.user@example.com';
    window.__janusAuthTest.deferEmailCode = true;
    const button = document.querySelector('#send-register-code-btn');
    for (let index = 0; index < 5; index += 1) button.click();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.emailCodes.length) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('register email code request did not reach backend bridge'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.emailCodes[0]`), {
    method: 'email',
    email: 'new.user@example.com',
    purpose: 'register',
  });
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    count: window.__janusAuthTest.emailCodes.length,
    disabled: Boolean(document.querySelector('#send-register-code-btn')?.disabled),
    label: document.querySelector('#send-register-code-btn')?.textContent || '',
  })`), { count: 1, disabled: true, label: '发送中…' });
  await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.emailCodeResolver(); window.__janusAuthTest.deferEmailCode = false`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const button = document.querySelector('#send-register-code-btn');
      if (button?.disabled && button.textContent.includes('秒后重发')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('register email code cooldown did not activate'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#send-register-code-btn').click()`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.emailCodes.length`), 1);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.body.innerText.includes('mock')`), false);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    title: document.querySelector('.email-code-notice strong')?.textContent.trim() || '',
    target: document.querySelector('.email-code-notice b')?.textContent.trim() || '',
    detail: document.querySelector('.email-code-notice small')?.textContent.trim() || '',
    hasIcon: Boolean(document.querySelector('.email-code-notice-icon svg')),
    hasFeedback: Boolean(document.querySelector('.auth-feedback')),
    hasGlobalNotice: Boolean(document.querySelector('.app-notice')),
  })`), {
    title: '验证码已发送',
    target: 'new.user@example.com',
    detail: '10 分钟内有效，仅可使用一次。没有收到时请检查垃圾邮件。',
    hasIcon: true,
    hasFeedback: false,
    hasGlobalNotice: false,
  });
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`Promise.all([
    import(${JSON.stringify(rendererStateEntry)}),
    import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'views', 'settingsView.js')).href)}),
  ]).then(([{ state }, { renderAuthPanel }]) => {
    state.languageMode = 'en';
    const host = document.createElement('div');
    host.innerHTML = renderAuthPanel();
    const result = {
      title: host.querySelector('.email-code-notice strong')?.textContent.trim() || '',
      destination: host.querySelector('.email-code-notice-copy > span')?.textContent.trim() || '',
      detail: host.querySelector('.email-code-notice small')?.textContent.trim() || '',
      containsChinese: /[\u3400-\u9fff]/.test(host.querySelector('.email-code-notice')?.textContent || ''),
    };
    state.languageMode = 'zh-CN';
    return result;
  })`), {
    title: 'Verification Code Sent',
    destination: 'Registration code sent to new.user@example.com',
    detail: 'Valid for 10 minutes and one use. Check spam if it does not arrive.',
    containsChinese: false,
  });
  const darkEmailNotice = await browserWindow.webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.auth-shell');
    shell?.classList.add('theme-dark');
    const notice = document.querySelector('.email-code-notice');
    const strong = notice?.querySelector('strong');
    const small = notice?.querySelector('small');
    const result = {
      background: notice ? getComputedStyle(notice).backgroundColor : '',
      foreground: notice ? getComputedStyle(notice).color : '',
      strong: strong ? getComputedStyle(strong).color : '',
      small: small ? getComputedStyle(small).color : '',
      radius: notice ? getComputedStyle(notice).borderRadius : '',
      columns: notice ? getComputedStyle(notice).gridTemplateColumns : '',
    };
    shell?.classList.remove('theme-dark');
    return result;
  })()`);
  assert.equal(darkEmailNotice.background, 'rgb(19, 34, 55)');
  assert.equal(darkEmailNotice.foreground, 'rgb(201, 222, 248)');
  assert.equal(darkEmailNotice.strong, 'rgb(237, 246, 255)');
  assert.equal(darkEmailNotice.small, 'rgb(159, 180, 206)');
  assert.equal(darkEmailNotice.radius, '13px');
  assert.match(darkEmailNotice.columns, /^34px /);

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-name').value = 'New User';
    document.querySelector('#register-email').value = 'new.user@example.com';
    document.querySelector('#register-code').value = '246810';
    document.querySelector('#register-password').value = 'strong-password1';
    document.querySelector('#register-password-confirm').value = 'different-password1';
    document.querySelector('#register-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.body.innerText.includes('两次输入的密码不一致')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('password confirmation mismatch was not shown'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.registrations.length`), 0);

  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.managedProviderUsage = {
      enabled: true,
      managedProvider: true,
      dailyTokenLimit: 500000,
      dailyTokensUsed: 400000,
      dailyTokensRemaining: 100000,
      usagePercent: 80,
      exhausted: false,
    };
  })`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#register-password-confirm').value = 'strong-password1';
    document.querySelector('#register-form').requestSubmit();
  })()`);
  const result = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (window.__janusAuthTest.errors.length || window.__janusAuthTest.registrations.length) {
        return resolve({ registrations: window.__janusAuthTest.registrations, errors: window.__janusAuthTest.errors });
      }
      if (Date.now() > deadline) return reject(new Error('registration did not reach backend bridge'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(result.errors, [], `renderer errors:\n${result.errors.join('\n')}\n${rendererConsole.join('\n')}`);
  assert.equal(result.registrations.length, 1);
  assert.deepEqual(result.registrations[0], {
    displayName: 'New User',
    email: 'new.user@example.com',
    code: '246810',
    password: 'strong-password1',
  });
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.account-avatar')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('authenticated sidebar did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const sidebarSnapshot = await browserWindow.webContents.executeJavaScript(`({
    avatarText: document.querySelector('.account-avatar')?.textContent.trim(),
    updateBadge: document.querySelector('.account-update-badge')?.textContent.trim(),
  })`);
  assert.equal(sidebarSnapshot.avatarText, 'NU');
  assert.equal(sidebarSnapshot.updateBadge, '可更新');
  await clickSelector('#account-card');
  const zeroUsageSnapshot = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    statePercent: state.managedProviderUsage?.usagePercent,
    stateUsed: state.managedProviderUsage?.dailyTokensUsed,
    hasSidebarQuota: Boolean(document.querySelector('.sidebar-model-usage')),
    hasSettingsLink: Boolean(document.querySelector('[data-account-menu-action="settings"]')),
  }))`);
  assert.deepEqual(zeroUsageSnapshot, {
    statePercent: 0,
    stateUsed: 0,
    hasSidebarQuota: false,
    hasSettingsLink: true,
  });
  await clickSelector('#account-card');
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.managedProviderUsage = {
      enabled: true,
      managedProvider: true,
      dailyTokenLimit: 500000,
      dailyTokensUsed: 500000,
      dailyTokensRemaining: 0,
      usagePercent: 100,
      exhausted: true,
    };
  })`);
  await clickSelector('#account-card');
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.sidebar-model-usage'))`), false);
  await clickSelector('#account-card');
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.managedProviderUsage = {
      enabled: true,
      managedProvider: false,
      dailyTokenLimit: null,
      dailyTokensUsed: 1234,
      dailyTokensRemaining: null,
      usagePercent: null,
      exhausted: false,
    };
  })`);
  await clickSelector('#account-card');
  assert.equal(await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.sidebar-model-usage'))`), false);
  await clickSelector('#account-card');
  const primaryNavSnapshot = await browserWindow.webContents.executeJavaScript(`({
    plugins: Boolean(document.querySelector('[data-tab="plugins"]')),
    personalEvolution: Boolean(document.querySelector('[data-tab="personal-evolution"]')),
  })`);
  assert.equal(primaryNavSnapshot.plugins, true);
  assert.equal(primaryNavSnapshot.personalEvolution, false);
  await clickSelector('[data-tab="employees"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-employee-installed-context="instance_renderer_auth"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('employee entry did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="instance_renderer_auth"]');
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 160 }));
  })()`);
  await clickSelector('[data-employee-context-action="memory"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const overview = document.querySelector('[data-employee-detail="instance_renderer_auth"][data-employee-detail-tab="overview"]');
      if (overview) {
        overview.click();
        return resolve(true);
      }
      if (Date.now() > deadline) return reject(new Error('employee memory drawer did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const employeeCapabilitySnapshot = await browserWindow.webContents.executeJavaScript(`({
    performance: document.querySelector('.employee-overview-drawer')?.textContent.includes('P5'),
    leadership: document.querySelector('.employee-overview-drawer')?.textContent.includes('L1'),
  })`);
  assert.equal(employeeCapabilitySnapshot.performance, true);
  assert.equal(employeeCapabilitySnapshot.leadership, true);
  await clickSelector('[data-employee-detail="instance_renderer_auth"][data-employee-detail-tab="growth"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.employee-growth-section:last-child .employee-history-row')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('employee growth drawer did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const growthSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasPerformanceMetrics: document.querySelector('.employee-growth-drawer')?.textContent.includes('首次通过'),
    hasLeadershipHistory: document.querySelector('.employee-growth-drawer')?.textContent.includes('73.5'),
    hasAppealOutcome: document.querySelector('.employee-growth-drawer')?.textContent.includes('证据复核后维持原评分'),
    hasPromotionGap: document.querySelector('.employee-growth-drawer')?.textContent.includes('team lead 试岗不足'),
    descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-growth-section > p')).fontSize),
    metricLabelFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-growth-metrics small')).fontSize),
    historyFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-history-row small')).fontSize),
  })`);
  assert.equal(growthSnapshot.hasPerformanceMetrics, true);
  assert.equal(growthSnapshot.hasLeadershipHistory, true);
  assert.equal(growthSnapshot.hasAppealOutcome, true);
  assert.equal(growthSnapshot.hasPromotionGap, true);
  assert.ok(growthSnapshot.descriptionFontSize >= 13 && growthSnapshot.metricLabelFontSize >= 11 && growthSnapshot.historyFontSize >= 12,
    `employee growth detail typography is too small: ${JSON.stringify(growthSnapshot)}`);
  await clickSelector('[data-employee-leadership-appeal="instance_renderer_auth"]');
  const appealDialogSnapshot = await browserWindow.webContents.executeJavaScript(`({
    visible: Boolean(document.querySelector('.employee-decision-dialog')),
    hasTextarea: Boolean(document.querySelector('.employee-decision-dialog textarea[name="reason"]')),
    descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-decision-dialog p')).fontSize),
    labelFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-decision-dialog label')).fontSize),
    actionWhiteSpace: getComputedStyle(document.querySelector('.employee-decision-dialog footer .btn')).whiteSpace,
  })`);
  assert.equal(appealDialogSnapshot.visible, true);
  assert.equal(appealDialogSnapshot.hasTextarea, true);
  assert.ok(appealDialogSnapshot.descriptionFontSize >= 14 && appealDialogSnapshot.labelFontSize >= 13
    && appealDialogSnapshot.actionWhiteSpace === 'nowrap', `employee decision dialog typography is too small: ${JSON.stringify(appealDialogSnapshot)}`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.employee-decision-dialog textarea[name="reason"]').value = '请复核本次 Leadership 评分证据。';
    document.querySelector('[data-leadership-dialog-form]').requestSubmit();
  })()`);
  const appealSubmission = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const submission = window.__janusAuthTest.leadershipAppealSubmissions[0];
      if (submission && !document.querySelector('.employee-decision-dialog')) return resolve(submission);
      if (Date.now() > deadline) return reject(new Error('Leadership appeal was not submitted'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(appealSubmission.agentInstanceId, 'instance_renderer_auth');
  assert.equal(appealSubmission.appealKind, 'assessment');
  assert.equal(appealSubmission.reason, '请复核本次 Leadership 评分证据。');
  assert.match(appealSubmission.commandId, /^lead_appeal_/);
  await clickSelector('[data-employee-detail="instance_renderer_auth"][data-employee-detail-tab="memory"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-employee-memory-archive="memory_renderer_auth_1"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('employee memory archive action did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const memorySnapshot = await browserWindow.webContents.executeJavaScript(`({
    archiveAvailable: Boolean(document.querySelector('[data-employee-memory-archive="memory_renderer_auth_1"]')),
    currentProtected: document.querySelector('.employee-memory-document-row')?.textContent.includes('当前'),
    runtimeGuidance: /新(?:的模型)?线程/.test(document.querySelector('.employee-memory-drawer')?.textContent || ''),
    summaryFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-memory-document-row button small')).fontSize),
    archiveFontSize: Number.parseFloat(getComputedStyle(document.querySelector('[data-employee-memory-archive="memory_renderer_auth_1"]')).fontSize),
    guidanceFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-memory-runtime-note')).fontSize),
  })`);
  assert.equal(memorySnapshot.archiveAvailable, true);
  assert.equal(memorySnapshot.currentProtected, true);
  assert.equal(memorySnapshot.runtimeGuidance, true);
  assert.ok(memorySnapshot.summaryFontSize >= 12 && memorySnapshot.archiveFontSize >= 12 && memorySnapshot.guidanceFontSize >= 13,
    `employee memory detail typography is too small: ${JSON.stringify(memorySnapshot)}`);
  await clickSelector('[data-employee-detail-close]');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="instance_renderer_auth"]');
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 160 }));
  })()`);
  await clickSelector('[data-employee-context-action="versions"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.employee-market-drawer .employee-skill-combination')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('employee Skill version selector did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const marketSnapshot = await browserWindow.webContents.executeJavaScript(`({
    currentCombination: document.querySelector('.employee-skill-combination')?.textContent.includes('当前组合'),
    versionChange: document.querySelector('.employee-market-drawer')?.textContent.includes('规划增强'),
    currentVersion: document.querySelector('.employee-market-drawer')?.textContent.includes('当前使用'),
    combinationDescriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-skill-combination p')).fontSize),
    versionDescriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-skill-choice small')).fontSize),
    actionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-skill-choice .btn')).fontSize),
    actionWhiteSpace: getComputedStyle(document.querySelector('.employee-skill-choice .btn')).whiteSpace,
  })`);
  assert.equal(marketSnapshot.currentCombination, true);
  assert.equal(marketSnapshot.versionChange, true);
  assert.equal(marketSnapshot.currentVersion, true);
  assert.ok(marketSnapshot.combinationDescriptionFontSize >= 13 && marketSnapshot.versionDescriptionFontSize >= 13
    && marketSnapshot.actionFontSize >= 13 && marketSnapshot.actionWhiteSpace === 'nowrap',
  `employee skill detail typography is too small: ${JSON.stringify(marketSnapshot)}`);
  await clickSelector('[data-employee-market-close]');
  await clickSelector('[data-network-view="friends"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('#friend-search-query')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('friend panel did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-friend-directory-category="external"]');
  const realFriendSnapshot = await browserWindow.webContents.executeJavaScript(`({
    rows: document.querySelectorAll('.network-friend-row').length,
    profileButton: Boolean(document.querySelector('[data-contact-profile="user_bob_renderer"]')),
    fatal: Boolean(document.querySelector('.fatal')),
  })`);
  assert.equal(realFriendSnapshot.rows, 1, 'malformed legacy friend records must be ignored');
  assert.equal(realFriendSnapshot.profileButton, true);
  assert.equal(realFriendSnapshot.fatal, false);
  await browserWindow.webContents.executeJavaScript(`(() => {
    authenticatedBootstrap.friendOverview.requests = {
      incoming: [{
        id: 'friend_request_incoming_renderer', status: 'pending', message: '你好，我们在同一个项目组。', createdAt: '2026-07-27T01:00:00.000Z',
        user: { id: 'user_alice_renderer', displayName: 'Alice Renderer', username: 'alice_renderer', email: 'alice.renderer@example.com' },
      }],
      outgoing: [{
        id: 'friend_request_outgoing_renderer', status: 'pending', message: '想和你一起协作。', createdAt: '2026-07-27T01:01:00.000Z',
        user: { id: 'user_carol_renderer', displayName: 'Carol Renderer', username: 'carol_renderer', email: 'carol.renderer@example.com' },
      }],
    };
  })()`);
  await clickSelector('[data-network-view="messages"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('#network-panel[data-page-kind="messages"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('message panel did not render before returning to contacts'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-network-view="friends"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-friend-directory-category="new"] .im-directory-nav-badge')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('new friend request badge did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-friend-directory-category="new"]');
  const incomingRequestSnapshot = await browserWindow.webContents.executeJavaScript(`({
    title: document.querySelector('.contact-requests-pane .contacts-pane-head h2')?.textContent || '',
    requester: document.querySelector('[data-friend-request-id="friend_request_incoming_renderer"]')?.textContent || '',
    hasAccept: Boolean(document.querySelector('[data-friend-accept="friend_request_incoming_renderer"]')),
    hasReject: Boolean(document.querySelector('[data-friend-reject="friend_request_incoming_renderer"]')),
    hasCancel: Boolean(document.querySelector('[data-friend-cancel="friend_request_outgoing_renderer"]')),
  })`);
  assert.equal(incomingRequestSnapshot.title, '新联系人');
  assert.match(incomingRequestSnapshot.requester, /Alice Renderer/);
  assert.match(incomingRequestSnapshot.requester, /你好，我们在同一个项目组。/);
  assert.equal(incomingRequestSnapshot.hasAccept, true);
  assert.equal(incomingRequestSnapshot.hasReject, true);
  assert.equal(incomingRequestSnapshot.hasCancel, true);
  await clickSelector('[data-friend-accept="friend_request_incoming_renderer"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.friendRequestActions.some((item) => item.action === 'accept') && !document.querySelector('[data-friend-request-id="friend_request_incoming_renderer"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('friend request acceptance did not update the UI'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.friendRequestActions[0]`), {
    action: 'accept', requestId: 'friend_request_incoming_renderer',
  });
  await clickSelector('[data-friend-directory-category="external"]');
  const acceptedContactVisible = await browserWindow.webContents.executeJavaScript(`Boolean(document.querySelector('[data-contact-profile="user_alice_renderer"]'))`);
  assert.equal(acceptedContactVisible, true);
  const unchangedSocialScroll = await browserWindow.webContents.executeJavaScript(`(async () => {
    const { state } = await import(${JSON.stringify(rendererStateEntry)});
    const existingIds = new Set(state.friendOverview.friends.map((item) => item.friend?.id));
    const additionalFriends = [];
    for (let index = 0; index < 28; index += 1) {
      const id = 'scroll_friend_' + index;
      if (existingIds.has(id)) continue;
      additionalFriends.push({
        id: 'scroll_friendship_' + index,
        status: 'accepted',
        friend: { id, displayName: 'Scroll Friend ' + String(index).padStart(2, '0'), username: id, email: id + '@example.com' },
      });
    }
    const nextFriends = { ...state.friendOverview, friends: [...state.friendOverview.friends, ...additionalFriends] };
    const payload = {
      workspaceId: state.activeAccountWorkspace?.id || 'workspace_personal',
      status: state.socialStatus,
      friends: nextFriends,
      inbox: state.socialInbox,
      delegations: state.agentDelegations,
      collaboration: state.collaborationOverview,
    };
    window.__janusAuthTest.subscriptions.social(payload);
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (document.querySelectorAll('.contacts-plain-list [data-contact-profile]').length >= additionalFriends.length) return resolve();
        if (Date.now() > deadline) return reject(new Error('social contact rows did not render'));
        setTimeout(poll, 20);
      };
      poll();
    });
    const region = document.querySelector('.contacts-list-scroll');
    region.style.maxHeight = '260px';
    region.scrollTop = Math.min(240, region.scrollHeight - region.clientHeight);
    window.__janusAuthTest.contactScrollNode = region;
    window.__janusAuthTest.contactScrollTop = region.scrollTop;
    window.__janusAuthTest.contactScrollPayload = payload;
    window.__janusAuthTest.subscriptions.social(payload);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = document.querySelector('.contacts-list-scroll');
    return {
      sameNode: current === region,
      scrollDelta: Math.abs(current.scrollTop - window.__janusAuthTest.contactScrollTop),
      scrollTop: current.scrollTop,
      scrollHeight: current.scrollHeight,
      clientHeight: current.clientHeight,
      rowCount: current.querySelectorAll('[data-contact-profile]').length,
      key: current.dataset.scrollKey || '',
    };
  })()`);
  assert.equal(unchangedSocialScroll.sameNode, true, 'unchanged social polling must not rebuild the contacts surface');
  assert.ok(unchangedSocialScroll.scrollTop > 0, `contacts fixture did not become scrollable: ${JSON.stringify(unchangedSocialScroll)}`);
  assert.ok(unchangedSocialScroll.scrollDelta <= 1, `unchanged social polling moved contacts scroll: ${JSON.stringify(unchangedSocialScroll)}`);
  assert.equal(unchangedSocialScroll.key, 'contacts-list:external');
  await browserWindow.webContents.executeJavaScript(`(async () => {
    const { state } = await import(${JSON.stringify(rendererStateEntry)});
    const nextFriends = { ...state.friendOverview, friends: [...state.friendOverview.friends, {
      id: 'scroll_friendship_changed', status: 'accepted',
      friend: { id: 'scroll_friend_changed', displayName: 'Scroll Friend Changed', username: 'scroll_friend_changed', email: 'scroll.changed@example.com' },
    }] };
    window.__janusAuthTest.subscriptions.social({
      ...window.__janusAuthTest.contactScrollPayload,
      friends: nextFriends,
    });
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-contact-profile="scroll_friend_changed"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('changed social update did not refresh contacts'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const changedSocialScroll = await browserWindow.webContents.executeJavaScript(`(() => {
    const current = document.querySelector('.contacts-list-scroll');
    return {
      replacedNode: current !== window.__janusAuthTest.contactScrollNode,
      scrollDelta: Math.abs(current.scrollTop - window.__janusAuthTest.contactScrollTop),
      scrollTop: current.scrollTop,
    };
  })()`);
  assert.equal(changedSocialScroll.replacedNode, true, 'changed social data should still refresh the visible contacts surface');
  assert.ok(changedSocialScroll.scrollTop > 0, `changed social update reset contacts to the top: ${JSON.stringify(changedSocialScroll)}`);
  assert.ok(changedSocialScroll.scrollDelta <= 2, `changed social update moved contacts scroll: ${JSON.stringify(changedSocialScroll)}`);
  await clickSelector('[data-contact-profile="user_bob_renderer"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-contact-profile-dialog] [data-contact-profile-message="user_bob_renderer"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('friend profile did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-contact-profile-message="user_bob_renderer"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.direct-social-chat-view')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('real friend direct chat did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-network-view="friends"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
  await clickSelector('[data-contact-add-open="contact"]');
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#friend-add-search-query').value = '接口错误';
    document.querySelector('#contact-add-search-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.app-notice')?.textContent.includes('搜索条件无效。')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('global notification error sanitizer did not run'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const sanitizedFriendSearchError = await browserWindow.webContents.executeJavaScript(`document.querySelector('.app-notice')?.textContent.trim()`);
  assert.equal(sanitizedFriendSearchError, '搜索用户失败：搜索条件无效。');
  assert.equal(/NetworkRequestError|Janus communication|\/api\/friends|\(400\)/.test(sanitizedFriendSearchError), false);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#friend-add-search-query').value = 'bob.renderer@example.com';
    document.querySelector('#contact-add-search-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-friend-request="user_bob_renderer"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('friend search result did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-friend-request="user_bob_renderer"]');
  const friendComposer = await browserWindow.webContents.executeJavaScript(`({
    hasGreeting: Boolean(document.querySelector('#friend-request-message')),
    hasSubmit: Boolean(document.querySelector('#friend-request-form button[type="submit"]')),
  })`);
  assert.equal(friendComposer.hasGreeting, true);
  assert.equal(friendComposer.hasSubmit, true);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#friend-request-message').value = '你好，我是 New User，想和你协作测试 uBuddy。';
    document.querySelector('#friend-request-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.friendRequests.length) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('friend request did not reach backend bridge'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.friendRequests[0]`), {
    userId: 'user_bob_renderer',
    message: '你好，我是 New User，想和你协作测试 uBuddy。',
  });
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#account-card').click();
    document.querySelector('[data-account-menu-action="settings"]').click();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.account-hero-avatar')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('account settings did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const avatarMatch = await browserWindow.webContents.executeJavaScript(`({
    settings: document.querySelector('.account-hero-avatar')?.textContent.trim(),
    hasPasswordCode: Boolean(document.querySelector('#password-change-code')),
    hasPasswordCodeButton: Boolean(document.querySelector('#send-password-change-code-btn')),
  })`);
  assert.equal(sidebarSnapshot.avatarText, avatarMatch.settings);
  assert.equal(avatarMatch.hasPasswordCode, true);
  assert.equal(avatarMatch.hasPasswordCodeButton, true);
  await clickSelector('[data-settings-section="evolution-sync"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-evolution-updates-check]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('evolution settings did not load'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const agentPermissionSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasPermissionCard: Boolean(document.querySelector('.user-agent-permissions-card')),
    toggleCount: document.querySelectorAll('[data-agent-setting]').length,
    hasPersonalToggle: Boolean(document.querySelector('[data-agent-setting="personalEvolutionConsent"]')),
    hasMemoryToggle: Boolean(document.querySelector('[data-agent-setting="allowPersonalEvolution"]')),
    hasAutoActivation: Boolean(document.querySelector('[data-agent-setting="personalSkillAutoActivate"]')),
    hasEvolutionToggle: Boolean(document.querySelector('[data-evolution-preference-toggle]')),
    hasManualCheck: Boolean(document.querySelector('[data-evolution-updates-check]')),
  })`);
  assert.equal(agentPermissionSnapshot.hasPermissionCard, false);
  assert.equal(agentPermissionSnapshot.toggleCount, 0);
  assert.equal(agentPermissionSnapshot.hasPersonalToggle, false);
  assert.equal(agentPermissionSnapshot.hasMemoryToggle, false);
  assert.equal(agentPermissionSnapshot.hasAutoActivation, false);
  assert.equal(agentPermissionSnapshot.hasEvolutionToggle, false);
  assert.equal(agentPermissionSnapshot.hasManualCheck, true);
  await clickSelector('[data-evolution-updates-check]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.evolutionChecks === 1 && document.querySelector('[data-personal-version-activate]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('manual evolution update check did not render a candidate'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-version-activate]')?.disabled`), false);
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.evolutionPreferenceUpdates.length`), 0);
  await clickSelector('[data-personal-version-activate]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.evolutionVersionActions.length === 1
        && !document.querySelector('.personal-version-summary')?.textContent.includes('基础 Skill')
        && !document.querySelector('[data-personal-version-activate]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('personal version activation did not complete: ' + JSON.stringify({
        actions: window.__janusAuthTest.evolutionVersionActions,
        summary: document.querySelector('.personal-version-summary')?.textContent || '',
        activateVisible: Boolean(document.querySelector('[data-personal-version-activate]')),
        errors: window.__janusAuthTest.errors,
      })));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const activationPayload = await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.evolutionVersionActions[0]`);
  assert.equal(activationPayload.action, 'activate');
  assert.equal(activationPayload.versionId, 'personal_renderer_v2');
  assert.equal(activationPayload.expectedActiveVersionId, '');
  assert.ok(activationPayload.commandId);
  await clickSelector('[data-personal-version-expand]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('[data-personal-version-rollback][data-target-version-id="personal_renderer_v1"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('personal version history did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-personal-version-rollback][data-target-version-id="personal_renderer_v1"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.evolutionVersionActions.length === 2) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('historical personal version rollback did not complete'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await clickSelector('[data-personal-version-rollback][data-target-version-id=""]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.evolutionVersionActions.length === 3 && document.querySelector('.personal-version-base.is-active')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('base Skill rollback did not complete'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const rollbackPayloads = await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.evolutionVersionActions.slice(1)`);
  assert.equal(rollbackPayloads[0].targetSkillVersionId, 'personal_renderer_v1');
  assert.equal(rollbackPayloads[0].expectedActiveVersionId, 'personal_renderer_v2');
  assert.equal(rollbackPayloads[1].targetSkillVersionId, '');
  assert.equal(rollbackPayloads[1].expectedActiveVersionId, 'personal_renderer_v1');
  await clickSelector('[data-settings-section="account"]');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('#update-center')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('update center did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const updateCenterSnapshot = await browserWindow.webContents.executeJavaScript(`({
    heading: document.querySelector('#update-center')?.textContent.trim(),
    checkAllButton: document.querySelector('#check-all-updates-btn')?.textContent.trim(),
    statusCount: document.querySelectorAll('.update-center-body .update-state-pill').length,
    splitChannelCount: document.querySelectorAll('[data-update-channel]').length,
    hasLegacySoftwareCheck: Boolean(document.querySelector('#check-updates-btn')),
    hasLegacyAgentCheck: Boolean(document.querySelector('#check-agent-updates-btn')),
    explainsUnifiedCheck: document.querySelector('.update-center-head')?.textContent.includes('一次检查软件与 Agent 实验室'),
    explainsUnifiedVersion: document.querySelector('.update-center-body')?.textContent.includes('共用统一版本序列'),
    currentVersionVisible: document.querySelector('.update-center-body')?.textContent.includes('当前版本：0.1.0'),
  })`);
  assert.equal(updateCenterSnapshot.heading, '更新中心');
  assert.equal(updateCenterSnapshot.checkAllButton, '检查最新版本');
  assert.equal(updateCenterSnapshot.statusCount, 1);
  assert.equal(updateCenterSnapshot.splitChannelCount, 0);
  assert.equal(updateCenterSnapshot.hasLegacySoftwareCheck, false);
  assert.equal(updateCenterSnapshot.hasLegacyAgentCheck, false);
  assert.equal(updateCenterSnapshot.explainsUnifiedCheck, true);
  assert.equal(updateCenterSnapshot.explainsUnifiedVersion, true);
  assert.equal(updateCenterSnapshot.currentVersionVisible, true);
  if (process.env.JANUS_RENDERER_AUTH_SCREENSHOT) {
    browserWindow.show();
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(process.env.JANUS_RENDERER_AUTH_SCREENSHOT, (await browserWindow.capturePage()).toPNG());
  }
  await clickSelector('#check-all-updates-btn');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const checks = window.__janusAuthTest.updateChecks;
      if (checks.software === 1 && checks.agents === 1 && document.querySelector('.update-center-body .update-state-pill')?.textContent.includes('已是最新')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('combined update check did not call both independent bridges'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const combinedUpdateSnapshot = await browserWindow.webContents.executeJavaScript(`({
    checks: window.__janusAuthTest.updateChecks,
    combinedState: document.querySelector('.update-center-body .update-state-pill')?.textContent.trim(),
    agentCandidateVisible: document.querySelector('.update-center-body')?.textContent.includes('可用版本 0.1.1'),
    currentVersionUpdated: document.querySelector('.update-center-body')?.textContent.includes('当前版本：0.1.1'),
    hasSeparateAgentAction: Boolean(document.querySelector('#download-agent-update-btn, #apply-agent-update-btn')),
  })`);
  assert.deepEqual(combinedUpdateSnapshot.checks, { software: 1, agents: 1 });
  assert.equal(combinedUpdateSnapshot.combinedState, '已是最新');
  assert.equal(combinedUpdateSnapshot.agentCandidateVisible, false);
  assert.equal(combinedUpdateSnapshot.currentVersionUpdated, true);
  assert.equal(combinedUpdateSnapshot.hasSeparateAgentAction, false);
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.__janusAuthTest.failSoftwareUpdateCheck = true;
    document.querySelector('#check-all-updates-btn').click();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const checks = window.__janusAuthTest.updateChecks;
      if (checks.software === 2 && checks.agents === 2 && document.querySelector('.update-center-body .update-state-pill')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('one failed update interface blocked the other update interface'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.errors`), []);
  const partialFailureSnapshot = await browserWindow.webContents.executeJavaScript(`({
    state: document.querySelector('.update-center-body .update-state-pill')?.textContent.trim(),
    hasSeparateAgentAction: Boolean(document.querySelector('#download-agent-update-btn, #apply-agent-update-btn')),
    notice: document.querySelector('.app-notice')?.textContent || '',
    noticeTone: document.querySelector('.app-notice')?.classList.contains('info'),
  })`);
  assert.equal(partialFailureSnapshot.state, '已是最新');
  assert.equal(partialFailureSnapshot.hasSeparateAgentAction, false);
  assert.match(partialFailureSnapshot.notice, /部分更新检查失败/);
  assert.equal(partialFailureSnapshot.noticeTone, false);
  await clickSelector('#send-password-change-code-btn');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.emailCodes.length === 2) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('password change email code request did not reach backend bridge'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.emailCodes[1]`), {
    method: 'email',
    email: 'new.user@example.com',
    purpose: 'password_change',
  });
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#current-password').value = 'old-password';
    document.querySelector('#new-password').value = 'new-password1';
    document.querySelector('#password-change-code').value = '135790';
    document.querySelector('#password-form').requestSubmit();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusAuthTest.passwordChanges.length) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('password change did not reach backend bridge'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__janusAuthTest.passwordChanges[0]`), {
    currentPassword: 'old-password',
    newPassword: 'new-password1',
    code: '135790',
  });
  const authenticatedWorkspaceState = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    currentUserId: state.currentUser?.id || '',
    activeWorkspaceId: state.activeAccountWorkspace?.id || '',
    startupWorkspaceId: state.startupAccountWorkspace?.id || '',
    workspaceIds: (state.accountWorkspaces || []).map((item) => item.id),
  }))`);
  assert.equal(authenticatedWorkspaceState.currentUserId, 'user_renderer_auth');
  assert.equal(authenticatedWorkspaceState.activeWorkspaceId, 'workspace_org_renderer_auth');
  assert.equal(authenticatedWorkspaceState.startupWorkspaceId, 'workspace_org_renderer_auth');
  assert.deepEqual(authenticatedWorkspaceState.workspaceIds, ['workspace_personal', 'workspace_org_renderer_auth']);
  await clickSelector('#logout-btn');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('#login-form')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('login form did not return after logout'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const anonymousWorkspaceState = await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => ({
    currentUser: state.currentUser,
    activeWorkspace: state.activeAccountWorkspace,
    startupWorkspace: state.startupAccountWorkspace,
    accountWorkspaces: state.accountWorkspaces,
    workspaceRoot: state.workspaceRoot,
    managedProviderUsage: state.managedProviderUsage,
  }))`);
  assert.equal(anonymousWorkspaceState.currentUser, null);
  assert.equal(anonymousWorkspaceState.activeWorkspace, null);
  assert.equal(anonymousWorkspaceState.startupWorkspace, null);
  assert.deepEqual(anonymousWorkspaceState.accountWorkspaces, []);
  assert.equal(anonymousWorkspaceState.workspaceRoot, '');
  assert.equal(anonymousWorkspaceState.managedProviderUsage, null);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#login-identifier').value`), 'new.user@example.com');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('#login-password').value`), '');
  const loginInputRect = await browserWindow.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('#login-identifier').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
  for (const point of [
    [loginInputRect.x + 4, loginInputRect.y + loginInputRect.height / 2],
    [loginInputRect.x + loginInputRect.width / 2, loginInputRect.y + loginInputRect.height / 2],
    [loginInputRect.x + loginInputRect.width - 4, loginInputRect.y + loginInputRect.height / 2],
  ]) {
    browserWindow.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(point[0]), y: Math.round(point[1]) });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const loginHoverSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.auth-card');
    const style = getComputedStyle(card);
    const inputStyle = getComputedStyle(document.querySelector('#login-identifier'));
    return {
      loginForm: Boolean(document.querySelector('#login-form')),
      width: card.getBoundingClientRect().width,
      height: card.getBoundingClientRect().height,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      inputAppearance: inputStyle.appearance || inputStyle.webkitAppearance,
    };
  })()`);
  assert.equal(loginHoverSnapshot.loginForm, true);
  assert.ok(loginHoverSnapshot.width > 0 && loginHoverSnapshot.height > 0);
  assert.notEqual(loginHoverSnapshot.display, 'none');
  assert.notEqual(loginHoverSnapshot.visibility, 'hidden');
  assert.notEqual(loginHoverSnapshot.opacity, '0');
  assert.equal(loginHoverSnapshot.inputAppearance, 'none');
  process.stdout.write('Renderer login/register smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-auth', stateExpression: 'window.__janusAuthTest?.errors || []' });
  const rendererErrors = browserWindow && !browserWindow.isDestroyed()
    ? await browserWindow.webContents.executeJavaScript('window.__janusAuthTest?.errors || []').catch(() => [])
    : [];
  process.stderr.write(`${String(error?.stack || error)}\n${rendererErrors.join('\n')}\n`);
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
