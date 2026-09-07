import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-settings-update-ui-'));
app.setPath('userData', path.join(tempRoot, 'user-data'));
const htmlPath = path.join(tempRoot, 'settings-update-smoke.html');
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const modelScreenshot = process.env.JANUS_SETTINGS_MODEL_SCREENSHOT || '/tmp/janus-settings-model-ui.png';
const updateScreenshot = process.env.JANUS_SETTINGS_UPDATE_SCREENSHOT || '/tmp/janus-settings-update-ui.png';
const narrowSettingsScreenshot = String(process.env.JANUS_SETTINGS_NARROW_SCREENSHOT || '').trim();
const smallSettingsScreenshot = String(process.env.JANUS_SETTINGS_SMALL_SCREENSHOT || '').trim();
const announcementScreenshot = String(process.env.JANUS_UPDATE_ANNOUNCEMENT_SCREENSHOT || '').trim();
const personalEvolutionScreenshot = String(process.env.JANUS_PERSONAL_EVOLUTION_SCREENSHOT || '').trim();
const employeeScreenshotDir = String(process.env.JANUS_EMPLOYEE_CONTEXT_SCREENSHOT_DIR || '').trim();
const evolutionMarketFixturePath = String(process.env.JANUS_EVOLUTION_MARKET_FIXTURE || '').trim();
const evolutionMarketFixture = evolutionMarketFixturePath
  ? JSON.parse(readFileSync(evolutionMarketFixturePath, 'utf8'))
  : null;

const bootstrap = {
  appVersion: '0.2.2',
  root: tempRoot,
  workspaceRoot: tempRoot,
  org: { departments: [], agents: [], hrs: [] },
  sessions: [],
  projects: [],
  tasks: [],
  agentStatuses: [],
  evolution: null,
  desktopLifecycle: {
    closeBehavior: 'quit', defaultCloseBehavior: 'quit', platform: 'win32',
    traySupported: true, trayActive: false, backgroundAvailable: true, lastError: '',
  },
  currentUser: {
    id: 'settings_update_user',
    email: 'settings.ui@example.com',
    displayName: '设置测试用户',
    display_name: '设置测试用户',
    username: 'settings_ui',
    role: 'admin',
    emailVerified: true,
    permissions: { canEditCodexConfig: true },
    remoteBound: true,
  },
  adminUsers: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [],
  agentDelegations: [],
  collaboration: { groups: [], tasks: [] },
  socialStatus: { enabled: false, connected: false },
  codexConfig: {
    baseUrl: '',
    storedBaseUrl: '',
    storedHasApiKey: false,
    adminProviderOverrideEnabled: false,
    adminProviderOverrideUsable: false,
    userProviderOverrideValidated: false,
    providerKeyApplicationEnabled: false,
    credentialSource: 'embedded',
    configurationMode: 'embedded-with-user-override',
    hasApiKey: true,
    model: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    providerName: 'openai',
    authEnvKey: 'OPENAI_API_KEY',
  },
  codexConfigFiles: {
    authJson: '',
    configToml: '',
  },
  providerKeyAccess: { own: [], review: [], distributionReady: true },
  cloudSync: null,
  userAgentSettings: [{
    id: 'settings_agent_instance', agentFamilyId: 'settings_agent', syncEnabled: true,
    activePersonalSkillVersionId: '', family: { id: 'settings_agent', name: '设置测试 Agent' },
    memoryDocuments: [],
  }],
  employees: {
    roster: [{
      id: 'settings_agent_instance', agentFamilyId: 'settings_agent', instanceKind: 'employee',
      employmentState: 'active', routeEligible: true, stateRevision: 4, queueDepth: 0,
      family: { id: 'settings_agent', name: '通用 Agent', departmentId: 'general' },
      currentMemory: { id: 'settings_memory_0', displayName: 'memory0.md', scope: 'general', lifecycleState: 'active' },
      currentContext: { activeMemoryDocumentId: 'settings_memory_0', activeContextSpaceId: 'settings_context_0' },
      availableMarketVersions: [],
    }],
    recruitableFamilies: [
      { id: 'settings_agent', name: '通用 Agent', departmentId: 'general', canRecruit: false },
      { id: 'unrecruited_agent', name: '未招募测试 Agent', departmentId: 'research', canRecruit: true },
    ],
    quota: { used: 1, limit: 10 },
  },
  personalEvolutionStatus: {
    enabled: true, authority: 'cloud', grantReady: true, configured: true, executionAvailable: true,
    readiness: { database: true, model: true, encryption: true }, instances: [],
    evidenceUpload: {
      currentAccount: { pending: 3, deferred: 2 }, otherAccountsPending: 7, permanentlyBlocked: 1,
      nextRetryAt: '2026-08-02T00:00:00.000Z', deferredReasons: { cloud_upload_failed: 2 },
    },
  },
  personalEvolutionProposals: [],
  plugins: [],
  modelCatalog: {
    models: [{
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 SOL',
      defaultReasoningEffort: 'medium',
      reasoningEfforts: ['low', 'medium', 'high'],
    }],
  },
};

const initialUpdate = {
  enabled: true,
  checking: false,
  available: true,
  downloading: false,
  downloaded: false,
  installing: false,
  downloadProgress: 0,
  version: '0.3.0',
  releaseDate: '2026-08-07T00:00:00.000Z',
  lastCheckAt: '2026-07-25T12:00:00.000Z',
  lastError: '',
};

writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>Janus settings/update UI smoke</title>
    <link rel="stylesheet" href="${rendererStyle}">
  </head>
  <body>
    <div id="app"></div>
    <script>
      const bootstrap = ${JSON.stringify(bootstrap)};
      const initialUpdate = ${JSON.stringify(initialUpdate)};
      const evolutionMarketFixture = ${JSON.stringify(evolutionMarketFixture)};
      window.__settingsUpdateTest = {
        subscriptions: {},
        errors: [],
        downloadCalls: 0,
        installCalls: 0,
        desktopLifecycleCalls: [],
        confirmCalls: 0,
        confirmMessages: [],
        loggingCalls: { status: 0, open: 0, export: 0, clear: 0 },
        rendererEvents: [],
        evolutionChecks: 0,
        preferenceCalls: [],
        versionActions: [],
        activePersonalVersionId: '',
        conflictNextActivation: true,
        marketQueries: [],
        marketActions: [],
        employeeActions: [],
        providerKeyApplications: [],
        providerKeyDecisions: [],
        providerKeyClaims: [],
        providerKeyAccess: { own: [], review: [], distributionReady: true },
        marketHash: 'market_hash_0',
        marketSectionState: '',
        marketConflictNextAction: true,
        preference: { authority: 'cloud', enabled: true, stateRevision: 1 },
      };
      const subscribe = (name) => (listener) => {
        window.__settingsUpdateTest.subscriptions[name] = listener;
        return () => { delete window.__settingsUpdateTest.subscriptions[name]; };
      };
      window.addEventListener('error', (event) => {
        window.__settingsUpdateTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__settingsUpdateTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
      });
      window.confirm = (message) => {
        window.__settingsUpdateTest.confirmCalls += 1;
        window.__settingsUpdateTest.confirmMessages.push(String(message || ''));
        return true;
      };
      window.janus = {
        platform: 'win32',
        bootstrap: async () => bootstrap,
        updateStatus: async () => ({ ...initialUpdate }),
        agentUpdateStatus: async () => ({ enabled: true, available: false, downloaded: false, current: { releaseVersion: '0.2.2' } }),
        downloadUpdate: async () => {
          window.__settingsUpdateTest.downloadCalls += 1;
          return { ...initialUpdate, downloading: true, downloadProgress: 0, message: 'Downloading update.' };
        },
        installUpdate: async () => {
          window.__settingsUpdateTest.installCalls += 1;
          return { ...initialUpdate, available: true, installing: true, message: 'Installing update. Janus will restart.' };
        },
        loggingStatus: async () => {
          window.__settingsUpdateTest.loggingCalls.status += 1;
          return {
            enabled: true, level: 'info', fileCount: 3, totalBytes: 4096, retentionDays: 14,
            maxTotalBytes: 209715200, droppedCount: 0, lastWriteAt: '2026-07-29T01:00:00.000Z', lastError: '',
          };
        },
        openLogDirectory: async () => {
          window.__settingsUpdateTest.loggingCalls.open += 1;
          return { ok: true };
        },
        exportDiagnosticLog: async () => {
          window.__settingsUpdateTest.loggingCalls.export += 1;
          return { canceled: false, name: 'Janus-Diagnostics-test.log', size: 4096 };
        },
        clearApplicationLogs: async () => {
          window.__settingsUpdateTest.loggingCalls.clear += 1;
          return { removed: 2, bytesFreed: 2048 };
        },
        reportRendererEvent: async (payload) => {
          window.__settingsUpdateTest.rendererEvents.push(payload);
          return { accepted: true };
        },
        codexConfigFiles: async () => ({ authJson: '', configToml: '' }),
        requestProviderKeyApplication: async (payload) => {
          window.__settingsUpdateTest.providerKeyApplications.push(payload);
          const application = {
            id: 'provider_application_renderer', userId: bootstrap.currentUser.id,
            accountEmail: bootstrap.currentUser.email, organization: payload.organization,
            usage: payload.usage, status: 'pending', decisionNote: '', createdAt: new Date().toISOString(),
          };
          window.__settingsUpdateTest.providerKeyAccess = { own: [application], review: [application], distributionReady: true };
          return { ok: true, application, reused: false, notificationDelivered: true };
        },
        providerKeyApplications: async () => window.__settingsUpdateTest.providerKeyAccess,
        decideProviderKeyApplication: async (payload) => {
          window.__settingsUpdateTest.providerKeyDecisions.push(payload);
          const application = window.__settingsUpdateTest.providerKeyAccess.own[0];
          application.status = payload.action === 'approve' ? 'approved' : 'rejected';
          return { ok: true, application, notificationDelivered: true };
        },
        claimProviderKeyApplication: async (payload) => {
          window.__settingsUpdateTest.providerKeyClaims.push(payload);
          const application = window.__settingsUpdateTest.providerKeyAccess.own[0];
          application.status = 'claimed';
          return { status: { ...bootstrap.codexConfig, hasApiKey: true }, application };
        },
        userAgentSettings: async () => bootstrap.userAgentSettings,
        updateUserAgentSettings: async () => ({ settings: bootstrap.userAgentSettings }),
        evolutionPreference: async () => window.__settingsUpdateTest.preference,
        setEvolutionPreference: async (payload) => {
          window.__settingsUpdateTest.preferenceCalls.push(payload);
          window.__settingsUpdateTest.preference = {
            ...window.__settingsUpdateTest.preference,
            enabled: payload.enabled,
            stateRevision: window.__settingsUpdateTest.preference.stateRevision + 1,
            status: 'confirmed',
          };
          return window.__settingsUpdateTest.preference;
        },
        checkEvolutionUpdates: async () => {
          window.__settingsUpdateTest.evolutionChecks += 1;
          const current = window.__settingsUpdateTest.activePersonalVersionId;
          const versions = [
            { id: 'settings_personal_v2', status: current === 'settings_personal_v2' ? 'active' : 'candidate', stabilityStatus: 'stable', available: current !== 'settings_personal_v2', createdAt: '2026-07-25T10:00:00.000Z', overlayText: '优先核对交付结果和引用。' },
            { id: 'settings_personal_v1', status: current === 'settings_personal_v1' ? 'active' : 'archived', stabilityStatus: 'stable', createdAt: '2026-07-24T10:00:00.000Z', overlayText: '先给出简短结论。' },
          ];
          const marketAdopted = window.__settingsUpdateTest.marketSectionState === 'adopted';
          return { authority: 'cloud', checkedAt: '2026-07-25T11:00:00.000Z', preference: window.__settingsUpdateTest.preference, personal: [{
            agentInstanceId: 'settings_agent_instance', agentFamilyId: 'settings_agent', agentName: '设置测试 Agent',
            currentVersionId: current, availableCount: current === 'settings_personal_v2' ? 0 : 1, latestAvailableVersion: current === 'settings_personal_v2' ? null : versions[0], versions,
          }], market: [{
            agentFamilyId: 'settings_agent', name: '设置测试 Agent', departmentId: 'testing', recruited: true,
            agentInstanceId: 'settings_agent_instance', updateStatus: marketAdopted ? 'current' : 'available',
            releasedVersionCount: 1, availableVersionCount: marketAdopted ? 0 : 1,
            currentMarketVersionId: marketAdopted ? 'market_settings_v2' : '',
            latestVersion: { id: 'market_settings_v2', status: 'released', versionKind: 'market_base', createdAt: '2026-07-25T07:00:00.000Z', sectionCount: 1, health: { status: 'healthy' } },
          }, {
            agentFamilyId: 'unrecruited_agent', name: '未招募测试 Agent', departmentId: 'research', recruited: false,
            agentInstanceId: '', updateStatus: 'view_only_available', releasedVersionCount: 1, availableVersionCount: 1,
            currentMarketVersionId: '', latestVersion: { id: 'market_unrecruited_v1', status: 'released', versionKind: 'market_base', createdAt: '2026-07-24T07:00:00.000Z', sectionCount: 1, health: { status: 'healthy' } },
          }, {
            agentFamilyId: 'cloud_only_agent', name: '云端隐藏 Agent', departmentId: 'legacy', recruited: false,
            agentInstanceId: '', updateStatus: 'view_only_available', releasedVersionCount: 1, availableVersionCount: 1,
            currentMarketVersionId: '', latestVersion: { id: 'market_cloud_only_v1', status: 'released', versionKind: 'market_base', createdAt: '2026-07-23T07:00:00.000Z', sectionCount: 1, health: { status: 'healthy' } },
          }] };
        },
        personalEvolutionVersions: async () => {
          const current = window.__settingsUpdateTest.activePersonalVersionId;
          return { authority: 'cloud', items: [
            { id: 'settings_personal_v2', status: current === 'settings_personal_v2' ? 'active' : 'candidate', stabilityStatus: 'stable', available: current !== 'settings_personal_v2', createdAt: '2026-07-25T10:00:00.000Z', overlayText: '优先核对交付结果和引用。' },
            { id: 'settings_personal_v1', status: current === 'settings_personal_v1' ? 'active' : 'archived', stabilityStatus: 'stable', createdAt: '2026-07-24T10:00:00.000Z', overlayText: '先给出简短结论。' },
          ] };
        },
        activatePersonalEvolutionVersion: async (payload) => {
          window.__settingsUpdateTest.versionActions.push({ action: 'activate', ...payload });
          if (window.__settingsUpdateTest.conflictNextActivation) {
            window.__settingsUpdateTest.conflictNextActivation = false;
            window.__settingsUpdateTest.activePersonalVersionId = 'settings_personal_v1';
            bootstrap.userAgentSettings[0].activePersonalSkillVersionId = 'settings_personal_v1';
            const error = new Error('Personal version changed.');
            error.code = 'personal_version_conflict';
            throw error;
          }
          window.__settingsUpdateTest.activePersonalVersionId = payload.versionId;
          bootstrap.userAgentSettings[0].activePersonalSkillVersionId = payload.versionId;
          return { authority: 'cloud', status: 'activated', activeVersionId: payload.versionId };
        },
        rollbackPersonalSkill: async (payload) => {
          window.__settingsUpdateTest.versionActions.push({ action: 'rollback', ...payload });
          window.__settingsUpdateTest.activePersonalVersionId = payload.targetSkillVersionId || '';
          bootstrap.userAgentSettings[0].activePersonalSkillVersionId = payload.targetSkillVersionId || '';
          return { authority: 'cloud', status: 'rolled_back', activeVersionId: payload.targetSkillVersionId || '' };
        },
        marketVersions: async (payload) => {
          window.__settingsUpdateTest.marketQueries.push(payload);
          const recruited = Boolean(payload.agentInstanceId);
          const fixtureVersion = recruited ? evolutionMarketFixture?.marketVersion : null;
          const fixtureSection = fixtureVersion?.sections?.[0];
          const versionId = recruited ? fixtureVersion?.id || 'market_settings_v2' : 'market_unrecruited_v1';
          return {
            authority: 'cloud', agentFamilyId: payload.agentFamilyId, agentInstanceId: payload.agentInstanceId || '',
            items: [{
              id: versionId, status: 'released', versionKind: 'market_base', algorithmVersion: fixtureVersion?.algorithmVersion || 'cluster_market_v2',
              createdAt: fixtureVersion?.createdAt || '2026-07-25T07:00:00.000Z',
              adoption: { full: window.__settingsUpdateTest.marketSectionState === 'adopted' ? 'adopted' : '', sections: {} },
              health: fixtureVersion?.health || { status: 'healthy', baselineScore: 80, latestScore: 84, latestFailureRate: 0.03, observedTaskCount: 18 },
              sections: [{ sectionId: 'verification', title: fixtureSection?.title || '交付验证',
                content: fixtureSection?.content || '交付前验证结果和引用。', supportCount: fixtureSection?.supportCount || 7 }],
            }],
            effectiveSkill: recruited ? { marketVersionId: window.__settingsUpdateTest.marketSectionState === 'adopted' ? versionId : '',
              fullMarketVersionId: window.__settingsUpdateTest.marketSectionState === 'adopted' ? versionId : '',
              adoptedSections: window.__settingsUpdateTest.marketSectionState === 'adopted' ? ['verification'] : [], conflicts: [],
              effectiveSkillHash: window.__settingsUpdateTest.marketHash,
              effectiveSkill: fixtureVersion?.effectiveSkill || '# Effective Skill' } : null,
            canary: recruited ? { policyVersion: 'market_canary_real_user_default_on_v2',
              optedIn: window.__settingsUpdateTest.preference.enabled !== false,
              eligible: window.__settingsUpdateTest.preference.enabled !== false,
              defaultEnrolled: true, explicitlyOptedOut: false, canOptOut: true, assignments: [] } : null,
          };
        },
        adoptMarketSections: async (payload) => {
          window.__settingsUpdateTest.marketActions.push({ action: 'adopt', ...payload });
          if (window.__settingsUpdateTest.marketConflictNextAction) {
            window.__settingsUpdateTest.marketConflictNextAction = false;
            window.__settingsUpdateTest.marketHash = 'market_hash_remote';
            const error = new Error('Market Skill changed.');
            error.code = 'market_skill_conflict';
            throw error;
          }
          if (!payload.conflictResolutions?.verification) {
            return { status: 'conflict_required', marketVersionId: payload.marketVersionId, conflicts: [{
              sectionId: 'verification', title: '交付验证', personalOverlay: 'Use personal verification.', marketContent: 'Use market verification.',
            }] };
          }
          window.__settingsUpdateTest.marketSectionState = 'adopted';
          window.__settingsUpdateTest.marketHash = 'market_hash_adopted';
          return { status: 'applied', marketVersionId: payload.marketVersionId, effectiveSkillHash: window.__settingsUpdateTest.marketHash };
        },
        rollbackMarketSections: async (payload) => {
          window.__settingsUpdateTest.marketActions.push({ action: 'rollback', ...payload });
          window.__settingsUpdateTest.marketSectionState = 'rolled_back';
          window.__settingsUpdateTest.marketHash = 'market_hash_rollback';
          return { status: 'rolled_back', marketVersionId: payload.marketVersionId, effectiveSkillHash: window.__settingsUpdateTest.marketHash };
        },
        ignoreMarketSections: async (payload) => {
          window.__settingsUpdateTest.marketActions.push({ action: 'ignore', ...payload });
          window.__settingsUpdateTest.marketSectionState = 'ignored';
          window.__settingsUpdateTest.marketHash = 'market_hash_ignored';
          return { status: 'ignored', marketVersionId: payload.marketVersionId, effectiveSkillHash: window.__settingsUpdateTest.marketHash };
        },
        setMarketCanaryOptIn: async ({ enabled }) => ({ policyVersion: 'market_canary_real_user_default_on_v2',
          optedIn: Boolean(enabled), eligible: Boolean(enabled), defaultEnrolled: false,
          explicitlyOptedOut: !enabled, canOptOut: true, assignments: [] }),
        employeeOverview: async () => bootstrap.employees,
        deactivateEmployee: async (payload) => {
          window.__settingsUpdateTest.employeeActions.push({ action: 'deactivate', ...payload });
          return { status: 'confirmed', overview: bootstrap.employees };
        },
        employeeMemoryDocuments: async () => [{
          id: 'settings_memory_0', userAgentInstanceId: 'settings_agent_instance', displayName: 'memory0.md',
          scope: 'general', lifecycleState: 'active', currentVersionId: 'settings_memory_v2', content: '# 工作记忆\\n- 保留用户偏好\\n- 交付前复核',
        }],
        employeeContextSpaces: async () => ({
          current: { activeContextSpaceId: 'settings_context_0', activeMemoryDocumentId: 'settings_memory_0' },
          items: [{ id: 'settings_context_0', contextKind: 'general', displayName: '默认工作空间' }],
        }),
        employeeSessionHistory: async () => [],
        employeeMemoryVersions: async () => [{
          id: 'settings_memory_v2', memoryDocumentId: 'settings_memory_0', versionNo: 2,
          content: '# 工作记忆\\n- 保留用户偏好\\n- 交付前复核', reviewStatus: 'approved', createdAt: '2026-07-25T10:00:00.000Z',
        }],
        personalEvolutionStatus: async () => bootstrap.personalEvolutionStatus,
        listPersonalEvolutionProposals: async () => [],
        onCodexEvent: subscribe('codex'),
        onUpdateStatus: subscribe('updates'),
        onAgentUpdateStatus: subscribe('agentUpdates'),
        onDesktopLifecycleChanged: subscribe('desktopLifecycle'),
        onPluginProgress: subscribe('plugins'),
        onEvolutionProgress: subscribe('evolution'),
        onModelsUpdated: subscribe('models'),
        onSocialUpdated: subscribe('social'),
        listSessions: async () => [],
        listTasks: async () => [],
        minimizeWindow: async () => null,
        toggleMaximizeWindow: async () => null,
        closeWindow: async () => null,
        setDesktopCloseBehavior: async (closeBehavior) => {
          window.__settingsUpdateTest.desktopLifecycleCalls.push(closeBehavior);
          bootstrap.desktopLifecycle = {
            ...bootstrap.desktopLifecycle,
            closeBehavior,
            trayActive: closeBehavior === 'background',
          };
          window.__settingsUpdateTest.subscriptions.desktopLifecycle?.(bootstrap.desktopLifecycle);
          return bootstrap.desktopLifecycle;
        },
      };
    </script>
    <script type="module" src="${rendererEntry}"></script>
  </body>
</html>`, 'utf8');

let browserWindow;
const waitFor = (expression, failureMessage, timeout = 10000) => browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
  const deadline = Date.now() + ${timeout};
  const poll = () => {
    if (${expression}) return resolve(true);
    if (Date.now() > deadline) return reject(new Error(${JSON.stringify(failureMessage)}));
    setTimeout(poll, 20);
  };
  poll();
})`);

try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: true,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  browserWindow.webContents.on('console-message', (_event, level, message) => {
    process.stderr.write(`[renderer:${level}] ${message}\n`);
  });
  await browserWindow.loadFile(htmlPath);
  await waitFor("document.querySelector('#account-card')", 'authenticated shell did not render');
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#account-card').click();
    document.querySelector('[data-account-menu-action="settings"]').click();
  })()`);
  await waitFor("document.querySelector('#codex-file-config-form')", 'account settings did not render');
  const accountSeparationSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasEvolution: Boolean(document.querySelector('[data-evolution-preference-toggle]')),
    hasAgentSync: Boolean(document.querySelector('[data-agent-setting="syncEnabled"]')),
    hasEvolutionNav: Boolean(document.querySelector('[data-settings-section="evolution-sync"]')),
  })`);
  assert.equal(accountSeparationSnapshot.hasEvolution, false);
  assert.equal(accountSeparationSnapshot.hasAgentSync, false);
  assert.equal(accountSeparationSnapshot.hasEvolutionNav, true);
  const accountNavigatorSnapshot = await browserWindow.webContents.executeJavaScript(`(() => ({
    itemCount: document.querySelectorAll('[data-account-section-target]').length,
    anchorCount: document.querySelectorAll('[data-account-section]').length,
    desktopVisible: getComputedStyle(document.querySelector('.account-section-nav')).display !== 'none',
    compactHidden: getComputedStyle(document.querySelector('.account-section-menu')).display === 'none',
    active: document.querySelector('[data-account-section-target].active')?.dataset.accountSectionTarget,
    bodyWidth: Math.round(document.querySelector('.settings-section-body').getBoundingClientRect().width),
    navigatorHeight: Math.round(document.querySelector('.account-section-nav-list').getBoundingClientRect().height),
    navigatorOpacity: Number(getComputedStyle(document.querySelector('.account-section-nav')).opacity),
    labels: [...document.querySelectorAll('[data-account-section-target]')].map((item) => item.textContent.trim()),
    labelLeftEdgeSpread: (() => {
      const leftEdges = [...document.querySelectorAll('[data-account-section-target] span')]
        .map((item) => item.getBoundingClientRect().left);
      return Math.max(...leftEdges) - Math.min(...leftEdges);
    })(),
    navigatorInRightGutter: (() => {
      const nav = document.querySelector('.account-section-nav').getBoundingClientRect();
      const region = document.querySelector('.settings-account-view').getBoundingClientRect();
      const body = document.querySelector('.settings-section-body').getBoundingClientRect();
      const axis = nav.right - 5;
      return document.querySelector('.account-section-nav').dataset.placement === 'right'
        && Math.abs(axis - (region.right - 13)) < 1
        && nav.left >= body.right;
    })(),
    navigatorAxisOffset: (() => {
      const line = getComputedStyle(document.querySelector('.account-section-nav-list'), '::before');
      const dot = getComputedStyle(document.querySelector('.account-section-nav-item'), '::before');
      const lineCenter = Number.parseFloat(line.right) + Number.parseFloat(line.width) / 2;
      const dotCenter = Number.parseFloat(dot.right) + Number.parseFloat(dot.width) / 2;
      return Math.abs(lineCenter - dotCenter);
    })(),
  }))()`);
  assert.deepEqual({
    ...accountNavigatorSnapshot,
    navigatorHeight: undefined,
  }, {
    itemCount: 6,
    anchorCount: 6,
    desktopVisible: true,
    compactHidden: true,
    active: 'organization',
    bodyWidth: 880,
    navigatorOpacity: 0.34,
    labels: ['组织管理', '更新中心', '模型服务', '个人资料', '安全设置', '退出登录'],
    labelLeftEdgeSpread: 0,
    navigatorInRightGutter: true,
    navigatorAxisOffset: 0,
    navigatorHeight: undefined,
  });
  assert.ok(accountNavigatorSnapshot.navigatorHeight >= 540, `account section navigator must span the viewport, got ${accountNavigatorSnapshot.navigatorHeight}px`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-section-target="model-service"]').click()`);
  await waitFor("document.querySelector('[data-account-section-target=\"model-service\"].active') && Math.abs(document.querySelector('[data-account-section=\"model-service\"]').getBoundingClientRect().top - document.querySelector('.settings-section-view').getBoundingClientRect().top) < 40", 'account section navigator did not scroll to model service');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-section-target="organization"]').click()`);
  await waitFor("document.querySelector('[data-account-section-target=\"organization\"].active') && Math.abs(document.querySelector('[data-account-section=\"organization\"]').getBoundingClientRect().top - document.querySelector('.settings-section-view').getBoundingClientRect().top) < 40", 'account section navigator did not return to organization');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const region = document.querySelector('.settings-section-view');
    const anchor = document.querySelector('[data-account-section="updates"]');
    region.scrollTop += anchor.getBoundingClientRect().top - region.getBoundingClientRect().top - 20;
  })()`);
  await waitFor("document.querySelector('[data-account-section-target=\"updates\"].active')", 'account section navigator did not follow direct scrolling');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.settings-section-view').scrollTop = document.querySelector('.settings-section-view').scrollHeight`);
  await waitFor("document.querySelector('[data-account-section-target=\"security\"].active')", 'security section lost active state at the bottom of account settings');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-account-section-target="organization"]').click()`);
  await waitFor("document.querySelector('[data-account-section-target=\"organization\"].active')", 'account section navigator did not reset after direct scrolling');
  browserWindow.setSize(1100, 800);
  await waitFor("getComputedStyle(document.querySelector('.account-section-nav')).display === 'none' && getComputedStyle(document.querySelector('.account-section-menu')).display !== 'none'", 'account section navigator did not collapse at narrow width');
  const compactNavigatorSnapshot = await browserWindow.webContents.executeJavaScript(`(() => ({
    labelRemoved: !document.querySelector('.account-section-menu > span'),
    optionCount: document.querySelectorAll('[data-account-section-menu] option').length,
    noHorizontalOverflow: document.querySelector('.settings-account-view').scrollWidth <= document.querySelector('.settings-account-view').clientWidth + 1,
  }))()`);
  assert.deepEqual(compactNavigatorSnapshot, { labelRemoved: true, optionCount: 6, noHorizontalOverflow: true });
  browserWindow.setSize(900, 800);
  await waitFor("Math.round(document.querySelector('.settings-sidebar').getBoundingClientRect().width) === 164", 'settings sidebar did not enter compact narrow layout');
  const narrowSettingsLayout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const shell=document.querySelector('.settings-shell');const sidebar=document.querySelector('.settings-sidebar');const main=document.querySelector('.settings-shell > .main');
    const labels=[...document.querySelectorAll('.settings-nav-item strong')];const sidebarRect=sidebar.getBoundingClientRect();const mainRect=main.getBoundingClientRect();
    const active=document.querySelector('.settings-nav-item.active');const iconRect=active?.querySelector(':scope > span')?.getBoundingClientRect();const labelRect=active?.querySelector('strong')?.getBoundingClientRect();
    return {sidebarWidth:Math.round(sidebarRect.width),columns:getComputedStyle(shell).gridTemplateColumns,overlap:Math.max(0,sidebarRect.right-mainRect.left),shellOverflow:Math.max(0,shell.scrollWidth-shell.clientWidth),mainOverflow:Math.max(0,main.scrollWidth-main.clientWidth),iconLabelGap:labelRect&&iconRect?Math.round((labelRect.left-iconRect.right)*10)/10:999,maxLabelWidth:Math.max(...labels.map((label)=>label.getBoundingClientRect().width)),clippedLabels:labels.filter((label)=>label.scrollWidth>label.clientWidth+1||label.scrollHeight>label.clientHeight+1).map((label)=>label.textContent.trim())};
  })()`);
  assert.deepEqual({
    sidebarWidth: narrowSettingsLayout.sidebarWidth,
    overlap: narrowSettingsLayout.overlap,
    shellOverflow: narrowSettingsLayout.shellOverflow,
    mainOverflow: narrowSettingsLayout.mainOverflow,
    clippedLabels: narrowSettingsLayout.clippedLabels,
  }, { sidebarWidth: 164, overlap: 0, shellOverflow: 0, mainOverflow: 0, clippedLabels: [] });
  assert.match(narrowSettingsLayout.columns, /^164px /);
  assert.ok(narrowSettingsLayout.iconLabelGap <= 4, `settings navigation text is too far from its icon: ${JSON.stringify(narrowSettingsLayout)}`);
  assert.ok(narrowSettingsLayout.maxLabelWidth <= 49, `narrow settings labels exceeded four Chinese characters: ${JSON.stringify(narrowSettingsLayout)}`);
  if (narrowSettingsScreenshot) await browserWindow.capturePage().then((image) => image.toPNG()).then((buffer) => writeFileSync(narrowSettingsScreenshot, buffer));

  browserWindow.setSize(720, 800);
  await waitFor("Math.round(document.querySelector('.settings-sidebar').getBoundingClientRect().width) === 164", 'settings sidebar did not remain compact at 720px');
  const compactSettingsLayout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const shell=document.querySelector('.settings-shell');const sidebar=document.querySelector('.settings-sidebar');const main=document.querySelector('.settings-shell > .main');
    const sidebarRect=sidebar.getBoundingClientRect();const mainRect=main.getBoundingClientRect();
    return {overlap:Math.max(0,sidebarRect.right-mainRect.left),shellOverflow:Math.max(0,shell.scrollWidth-shell.clientWidth),columns:getComputedStyle(shell).gridTemplateColumns};
  })()`);
  assert.deepEqual({ overlap: compactSettingsLayout.overlap, shellOverflow: compactSettingsLayout.shellOverflow }, { overlap: 0, shellOverflow: 0 });
  assert.match(compactSettingsLayout.columns, /^164px /);

  browserWindow.setSize(620, 800);
  await waitFor("getComputedStyle(document.querySelector('.settings-shell')).gridTemplateColumns.split(' ').length === 1", 'settings navigation did not move above content at the small breakpoint');
  const smallSettingsLayout = await browserWindow.webContents.executeJavaScript(`(()=>{
    const shell=document.querySelector('.settings-shell');const sidebar=document.querySelector('.settings-sidebar');const main=document.querySelector('.settings-shell > .main');
    const sidebarRect=sidebar.getBoundingClientRect();const mainRect=main.getBoundingClientRect();const labels=[...document.querySelectorAll('.settings-nav-item strong')];
    return {overlap:Math.max(0,sidebarRect.bottom-mainRect.top),shellOverflow:Math.max(0,shell.scrollWidth-shell.clientWidth),fullWidthLabels:labels.every((label)=>getComputedStyle(label).maxWidth==='none'),clippedLabels:labels.filter((label)=>label.scrollWidth>label.clientWidth+1||label.scrollHeight>label.clientHeight+1).map((label)=>label.textContent.trim())};
  })()`);
  assert.deepEqual(smallSettingsLayout, { overlap: 0, shellOverflow: 0, fullWidthLabels: true, clippedLabels: [] });
  if (smallSettingsScreenshot) await browserWindow.capturePage().then((image) => image.toPNG()).then((buffer) => writeFileSync(smallSettingsScreenshot, buffer));

  browserWindow.setSize(1280, 800);
  await waitFor("getComputedStyle(document.querySelector('.account-section-nav')).display !== 'none' && getComputedStyle(document.querySelector('.account-section-menu')).display === 'none'", 'account section navigator did not restore its desktop layout');
  const providerSettingsSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasApplication: Boolean(document.querySelector('#provider-key-application-form')),
    hasReview: Boolean(document.querySelector('.provider-key-review-card')),
    configToml: document.querySelector('#codex-config-toml')?.value,
    authJson: document.querySelector('#codex-auth-json')?.value,
    defaultServiceCopy: document.querySelector('.model-service-mode-bar')?.textContent || '',
    advancedCollapsed: !document.querySelector('[data-advanced-model-service-disclosure]')?.open,
    advancedSummary: document.querySelector('.advanced-model-service-summary')?.textContent || '',
    advancedNotice: document.querySelector('.model-config-notice-row')?.textContent || '',
    configEditorsHidden: document.querySelector('#codex-config-toml')?.getClientRects().length === 0 && document.querySelector('#codex-auth-json')?.getClientRects().length === 0,
    exposesEmbeddedCredentialWording: /(内嵌|Key 和 URL|安装包凭据)/.test(document.querySelector('#codex-file-config-form')?.textContent || ''),
  })`);
  assert.equal(providerSettingsSnapshot.hasApplication, false);
  assert.equal(providerSettingsSnapshot.hasReview, false);
  assert.equal(providerSettingsSnapshot.configToml, '');
  assert.equal(providerSettingsSnapshot.authJson, '');
  assert.match(providerSettingsSnapshot.defaultServiceCopy, /默认模型服务/);
  assert.match(providerSettingsSnapshot.defaultServiceCopy, /Token 用量受软件额度限制/);
  assert.doesNotMatch(providerSettingsSnapshot.defaultServiceCopy, /开箱即用|可直接使用|无需额外配置/);
  assert.equal(providerSettingsSnapshot.advancedCollapsed, true);
  assert.match(providerSettingsSnapshot.advancedSummary, /自定义 Provider 配置/);
  assert.match(providerSettingsSnapshot.advancedNotice, /自定义 Provider 不受 Janus Token 限额/);
  assert.equal(providerSettingsSnapshot.configEditorsHidden, true);
  assert.equal(providerSettingsSnapshot.exposesEmbeddedCredentialWording, false);
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`({
    applications: window.__settingsUpdateTest.providerKeyApplications.length,
    decisions: window.__settingsUpdateTest.providerKeyDecisions.length,
    claims: window.__settingsUpdateTest.providerKeyClaims.length,
  })`), { applications: 0, decisions: 0, claims: 0 });
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#settings-search-input');
    input.value = '模型服务';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('[data-settings-search-result][data-settings-search-anchor=\"#account-section-model-service\"]')?.textContent.includes('账户与权限')", 'granular settings search result did not render its parent section');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-search-result][data-settings-search-anchor="#account-section-model-service"]')?.click()`);
  await waitFor("document.querySelector('#account-section-model-service.settings-search-target-highlight') && document.querySelector('#settings-search-input')?.value===''", 'settings search result did not navigate and highlight its target');
  await waitFor("!document.querySelector('#account-section-model-service.settings-search-target-highlight')", 'settings search target highlight did not clear', 3000);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#settings-search-input');
    input.value = '主题';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('[data-settings-section=\"preferences\"]') && !document.querySelector('[data-settings-section=\"account\"]')", 'preferences search aliases did not include theme');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#settings-search-input');
    input.value = '关闭最后一个窗口时';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('[data-settings-section=\"preferences\"]') && !document.querySelector('[data-settings-section=\"account\"]')", 'settings search did not include subsection copy');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#settings-search-input');
    input.value = 'never automatically uploaded';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('[data-settings-section=\"diagnostics\"]') && !document.querySelector('[data-settings-section=\"preferences\"]')", 'settings search did not include English body copy');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#settings-search-input');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("document.querySelector('[data-settings-section=\"preferences\"]') && document.querySelector('[data-settings-section=\"account\"]')", 'settings navigation did not restore after clearing search');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="preferences"]').click()`);
  await waitFor("document.querySelector('.settings-preferences-view') && document.querySelector('[data-desktop-close-behavior=\"quit\"].active')", 'preferences settings did not render');
  const desktopLifecycleSnapshot = await browserWindow.webContents.executeJavaScript(`({
    title: document.querySelector('.settings-section-head h1')?.textContent,
    firstNavigationItem: document.querySelector('[data-settings-section]')?.dataset.settingsSection,
    secondNavigationItem: document.querySelectorAll('[data-settings-section]')[1]?.dataset.settingsSection,
    preferenceNavigationCount: document.querySelectorAll('[data-settings-section="preferences"]').length,
    hasLegacyNavigation: Boolean(document.querySelector('[data-settings-section="general"], [data-settings-section="appearance"]')),
    hasThemeChoices: document.querySelectorAll('[data-theme-choice]').length === 2,
    hasLanguageChoices: document.querySelectorAll('[data-language-choice]').length === 2,
    panelOrder: [...document.querySelectorAll('.settings-preferences-view .settings-panel')].map((panel) => (
      panel.querySelector('h2')?.textContent || panel.querySelector('[data-desktop-close-behavior]')?.closest('.settings-row')?.querySelector('strong')?.textContent || ''
    )),
    closeBehaviorDescription: document.querySelector('.desktop-lifecycle-row small')?.textContent,
    choices: [...document.querySelectorAll('[data-desktop-close-behavior]')].map((item) => item.textContent.trim()),
    active: document.querySelector('[data-desktop-close-behavior].active')?.dataset.desktopCloseBehavior,
    noOverflow: document.querySelector('.settings-preferences-view').scrollWidth <= document.querySelector('.settings-preferences-view').clientWidth + 1,
  })`);
  assert.deepEqual(desktopLifecycleSnapshot, {
    title: '偏好',
    firstNavigationItem: 'account',
    secondNavigationItem: 'preferences',
    preferenceNavigationCount: 1,
    hasLegacyNavigation: false,
    hasThemeChoices: true,
    hasLanguageChoices: true,
    panelOrder: ['主题', '语言', '关闭最后一个窗口时'],
    closeBehaviorDescription: 'Janus 将结束本机任务并退出',
    choices: ['后台运行', '退出 Janus'],
    active: 'quit',
    noOverflow: true,
  });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-desktop-close-behavior="background"]').click()`);
  await waitFor("window.__settingsUpdateTest.desktopLifecycleCalls.length === 1 && document.querySelector('[data-desktop-close-behavior=\"background\"].active')", 'desktop close behavior did not persist through the renderer bridge');
  assert.deepEqual(await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.desktopLifecycleCalls`), ['background']);
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('.desktop-lifecycle-row small')?.textContent`), 'Janus 将继续运行并保留在通知区域');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'win32', trayActive: false, backgroundAvailable: false, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === '后台运行当前不可用，关闭最后一个窗口时 Janus 将退出' && document.querySelector('.settings-inline-error')?.textContent.includes('通知区域图标不可用')", 'Windows unavailable notification-area fallback did not render');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'darwin', trayActive: true, backgroundAvailable: true, lastError: '' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus 将继续运行并保留在菜单栏'", 'macOS menu-bar close behavior did not render');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'darwin', trayActive: false, backgroundAvailable: true, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus 将继续运行，可从 Dock 重新打开' && document.querySelector('.settings-inline-error')?.textContent.includes('菜单栏图标不可用')", 'macOS Dock fallback did not render');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'linux', trayActive: true, backgroundAvailable: true, lastError: '' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus 将继续运行并保留在系统托盘'", 'Linux system Tray close behavior did not render');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'linux', trayActive: false, backgroundAvailable: false, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === '后台运行当前不可用，关闭最后一个窗口时 Janus 将退出' && document.querySelector('.settings-inline-error')?.textContent.includes('系统托盘不可用')", 'Linux unavailable Tray fallback did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-language-choice="en"]').click()`);
  await waitFor("document.documentElement.lang === 'en' && document.querySelector('.settings-section-head h1')?.textContent === 'Preferences'", 'Preferences did not switch to English');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="account"]').click()`);
  await waitFor("document.querySelector('.settings-account-view') && document.querySelector('[data-account-section-target]')?.textContent.trim() === 'Organization'", 'English account section navigation did not render');
  const englishAccountNavigatorSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const labels = [...document.querySelectorAll('[data-account-section-target]')];
    const leftEdges = labels.map((item) => item.querySelector('span').getBoundingClientRect().left);
    return {
      labels: labels.map((item) => item.textContent.trim()),
      labelLeftEdgeSpread: Math.max(...leftEdges) - Math.min(...leftEdges),
    };
  })()`);
  assert.deepEqual(englishAccountNavigatorSnapshot, {
    labels: ['Organization', 'Updates', 'Models', 'Profile', 'Security', 'Sign Out'],
    labelLeftEdgeSpread: 0,
  });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="preferences"]').click()`);
  await waitFor("document.querySelector('.settings-preferences-view')", 'English preferences did not restore after checking account navigation');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'win32', trayActive: true, backgroundAvailable: true, lastError: '' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus will keep running in the notification area.'", 'Windows notification-area copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'win32', trayActive: false, backgroundAvailable: false, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Background mode is currently unavailable. Janus will quit when its last window is closed.' && document.querySelector('.settings-inline-error')?.textContent.includes('Notification area icon unavailable')", 'Windows unavailable notification-area copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'darwin', trayActive: true, backgroundAvailable: true, lastError: '' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus will keep running in the menu bar.'", 'macOS menu-bar copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'darwin', trayActive: false, backgroundAvailable: true, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus will keep running and can be reopened from the Dock.' && document.querySelector('.settings-inline-error')?.textContent.includes('Menu bar icon unavailable')", 'macOS Dock fallback copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'linux', trayActive: true, backgroundAvailable: true, lastError: '' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Janus will keep running in the system tray.'", 'Linux system Tray copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.desktopLifecycle?.({ closeBehavior: 'background', platform: 'linux', trayActive: false, backgroundAvailable: false, lastError: 'indicator unavailable' })`);
  await waitFor("document.querySelector('.desktop-lifecycle-row small')?.textContent === 'Background mode is currently unavailable. Janus will quit when its last window is closed.' && document.querySelector('.settings-inline-error')?.textContent.includes('System tray unavailable')", 'Linux unavailable system Tray copy did not render in English');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-language-choice="zh-CN"]').click()`);
  await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('.settings-section-head h1')?.textContent === '偏好'", 'Preferences did not switch back to Chinese');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="diagnostics"]').click()`);
  await waitFor("document.querySelector('.diagnostics-status-pill.is-ready')", 'diagnostics logging status did not render');
  const diagnosticsSnapshot = await browserWindow.webContents.executeJavaScript(`({
    title: document.querySelector('.settings-section-head h1')?.textContent,
    retention: document.querySelector('.diagnostics-metric-grid')?.textContent.includes('14 天'),
    hasOpen: Boolean(document.querySelector('[data-logging-open-directory]')),
    hasExport: Boolean(document.querySelector('[data-logging-export]')),
    hasClear: Boolean(document.querySelector('[data-logging-clear]')),
  })`);
  assert.equal(diagnosticsSnapshot.title, '诊断与日志');
  assert.equal(diagnosticsSnapshot.retention, true);
  assert.equal(diagnosticsSnapshot.hasOpen && diagnosticsSnapshot.hasExport && diagnosticsSnapshot.hasClear, true);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-logging-open-directory]').click()`);
  await waitFor("window.__settingsUpdateTest.loggingCalls.open === 1", 'open log directory action did not run');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-logging-export]').click()`);
  await waitFor("window.__settingsUpdateTest.loggingCalls.export === 1 && !document.querySelector('[data-logging-export]').disabled", 'diagnostic export action did not settle');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-logging-clear]').click()`);
  await waitFor("window.__settingsUpdateTest.loggingCalls.clear === 1", 'clear logs action did not run');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="evolution-sync"]').click()`);
  await waitFor("document.querySelector('[data-evolution-updates-check]') && !document.querySelector('[data-evolution-updates-check]').disabled", 'evolution settings did not load');

  const initialEvolutionSnapshot = await browserWindow.webContents.executeJavaScript(`({
    hasEvolutionToggle: Boolean(document.querySelector('[data-evolution-preference-toggle]')),
    agentSettingCount: document.querySelectorAll('[data-agent-setting]').length,
    hasPersonalToggle: Boolean(document.querySelector('[data-agent-setting="personalEvolutionConsent"]')),
    hasMemoryToggle: Boolean(document.querySelector('[data-agent-setting="allowPersonalEvolution"]')),
    hasSyncToggle: Boolean(document.querySelector('[data-agent-setting="syncEnabled"]')),
    hasManualCheck: Boolean(document.querySelector('[data-evolution-updates-check]')),
  })`);
  assert.equal(initialEvolutionSnapshot.hasEvolutionToggle, false);
  assert.equal(initialEvolutionSnapshot.agentSettingCount, 0);
  assert.equal(initialEvolutionSnapshot.hasPersonalToggle, false);
  assert.equal(initialEvolutionSnapshot.hasMemoryToggle, false);
  assert.equal(initialEvolutionSnapshot.hasSyncToggle, false);
  assert.equal(initialEvolutionSnapshot.hasManualCheck, true);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-evolution-updates-check]').click()`);
  await waitFor("window.__settingsUpdateTest.evolutionChecks === 1 && document.querySelector('[data-personal-version-activate]')", 'manual personal update check did not render a candidate');
  const updateSnapshot = await browserWindow.webContents.executeJavaScript(`({
    candidateDisabled: document.querySelector('[data-personal-version-activate]')?.disabled,
    marketCardCount: document.querySelectorAll('.market-evolution-agent-card').length,
    recruitedAction: document.querySelector('[data-settings-market-family="settings_agent"]')?.textContent.trim(),
    unrecruitedAction: document.querySelector('[data-settings-market-family="unrecruited_agent"]')?.textContent.trim(),
    cloudOnlyVisible: Boolean(document.querySelector('[data-settings-market-family="cloud_only_agent"]')),
  })`);
  assert.equal(updateSnapshot.candidateDisabled, false, 'mandatory evolution keeps candidate activation available');
  assert.equal(updateSnapshot.marketCardCount, 2, 'settings must match the visible talent-market catalog');
  assert.equal(updateSnapshot.recruitedAction, '查看并选择 Skill');
  assert.equal(updateSnapshot.unrecruitedAction, '查看 Skill');
  assert.equal(updateSnapshot.cloudOnlyVisible, false, 'cloud-only legacy families must not leak into settings');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-evolution-detail]').click()`);
  await waitFor("document.querySelector('.personal-evolution-view')?.offsetParent !== null && !document.querySelector('.settings-shell')", 'personal evolution detail did not render');
  const evidenceUploadText = await browserWindow.webContents.executeJavaScript(`document.querySelector('.personal-evidence-upload-status')?.textContent || ''`);
  assert.match(evidenceUploadText, /本账户待上传\s*5/);
  assert.match(evidenceUploadText, /其他账户待处理\s*7/);
  assert.match(evidenceUploadText, /永久阻塞\s*1/);
  if (personalEvolutionScreenshot) {
    await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    mkdirSync(path.dirname(personalEvolutionScreenshot), { recursive: true });
    writeFileSync(personalEvolutionScreenshot, (await browserWindow.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-evolution-settings]').click()`);
  await waitFor("document.querySelector('.settings-evolution-sync-view') && document.querySelector('[data-personal-version-agent=\"settings_agent_instance\"]')", 'personal evolution shortcut did not return to version settings');
  assert.equal(await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="evolution-sync"]')?.classList.contains('active')`), true);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-market-family="unrecruited_agent"]').click()`);
  await waitFor("document.querySelector('.employee-market-drawer') && !document.querySelector('.employee-market-drawer .employee-drawer-loading')", 'unrecruited market detail did not render');
  const unrecruitedMarketSnapshot = await browserWindow.webContents.executeJavaScript(`({
    readOnlyCopy: document.querySelector('.employee-market-drawer')?.textContent.includes('招募后可以选择使用'),
    adoptUnavailable: !document.querySelector('[data-market-adopt], [data-market-adopt-full]') || document.querySelector('[data-market-adopt], [data-market-adopt-full]').disabled,
    ignoreUnavailable: !document.querySelector('[data-market-ignore]') || document.querySelector('[data-market-ignore]').disabled,
    hasCanary: Boolean(document.querySelector('[data-market-canary-toggle]')),
  })`);
  assert.equal(unrecruitedMarketSnapshot.readOnlyCopy, true);
  assert.equal(unrecruitedMarketSnapshot.adoptUnavailable, true);
  assert.equal(unrecruitedMarketSnapshot.ignoreUnavailable, true);
  assert.equal(unrecruitedMarketSnapshot.hasCanary, false);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-close]').click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-market-family="settings_agent"]').click()`);
  await waitFor("document.querySelector('.employee-market-drawer') && !document.querySelector('.employee-market-drawer .employee-drawer-loading')", 'recruited market detail did not render');
  const marketSnapshot = await browserWindow.webContents.executeJavaScript(`({
    adoptDisabled: document.querySelector('[data-market-adopt], [data-market-adopt-full]')?.disabled,
    ignoreUnavailable: !document.querySelector('[data-market-ignore]'),
    canaryHidden: !document.querySelector('[data-market-canary-toggle]'),
    pauseCopy: document.querySelector('.employee-market-drawer')?.textContent.includes('暂时不能启用新的候选个人版本'),
  })`);
  assert.equal(marketSnapshot.adoptDisabled, false);
  assert.equal(marketSnapshot.ignoreUnavailable, true);
  assert.equal(marketSnapshot.canaryHidden, true);
  assert.equal(marketSnapshot.pauseCopy, false);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-close]').click()`);

  await browserWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-personal-version-activate]');
    button.click();
    button.click();
  })()`);
  await waitFor("window.__settingsUpdateTest.versionActions.length === 1 && document.querySelector('[data-personal-version-activate]')?.dataset.expectedActiveVersionId === 'settings_personal_v1'", 'version conflict did not refresh the current cloud version');
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.versionActions.length`), 1, 'busy protection must ignore a repeated activation click');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-version-activate]').click()`);
  await waitFor("window.__settingsUpdateTest.versionActions.length === 2 && window.__settingsUpdateTest.activePersonalVersionId === 'settings_personal_v2'", 'candidate activation did not complete after conflict refresh');
  const activationPayloads = await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.versionActions.slice(0, 2)`);
  assert.equal(activationPayloads[0].expectedActiveVersionId, '');
  assert.equal(activationPayloads[1].expectedActiveVersionId, 'settings_personal_v1');
  assert.ok(activationPayloads[1].commandId);

  await browserWindow.webContents.executeJavaScript(`(() => {
    if (!document.querySelector('[data-personal-version-rollback][data-target-version-id="settings_personal_v1"]')) {
      document.querySelector('[data-personal-version-expand]').click();
    }
  })()`);
  await waitFor("document.querySelector('[data-personal-version-rollback][data-target-version-id=\"settings_personal_v1\"]')", 'historical version action did not render');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-version-rollback][data-target-version-id="settings_personal_v1"]').click()`);
  await waitFor("window.__settingsUpdateTest.versionActions.length === 3 && window.__settingsUpdateTest.activePersonalVersionId === 'settings_personal_v1'", 'historical version rollback did not complete');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-personal-version-rollback][data-target-version-id=""]').click()`);
  await waitFor("window.__settingsUpdateTest.versionActions.length === 4 && document.querySelector('.personal-version-base.is-active')", 'base Skill restore did not complete');
  const rollbackPayloads = await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.versionActions.slice(2)`);
  assert.equal(rollbackPayloads[0].targetSkillVersionId, 'settings_personal_v1');
  assert.equal(rollbackPayloads[0].expectedActiveVersionId, 'settings_personal_v2');
  assert.equal(rollbackPayloads[1].targetSkillVersionId, '');
  assert.equal(rollbackPayloads[1].expectedActiveVersionId, 'settings_personal_v1');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-market-family="settings_agent"]').click()`);
  await waitFor("document.querySelector('[data-market-adopt], [data-market-adopt-full]')?.disabled === false", 'market adoption did not become available');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-market-adopt], [data-market-adopt-full]');
    button.click();
    button.click();
  })()`);
  await waitFor("window.__settingsUpdateTest.marketActions.length === 1 && document.querySelector('[data-market-adopt], [data-market-adopt-full]')?.disabled === false", 'market hash conflict did not refresh the detail');
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.marketActions.length`), 1, 'market busy protection must ignore repeated clicks');
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.marketActions[0].expectedEffectiveSkillHash`), 'market_hash_0');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-market-adopt], [data-market-adopt-full]').click()`);
  await waitFor("window.__settingsUpdateTest.marketActions.length === 2 && document.querySelector('[data-market-resolve=personal]')", 'personal Overlay conflict choices did not render');
  const pendingConflictSnapshot = await browserWindow.webContents.executeJavaScript(`({
    adoptDisabled: document.querySelector('[data-market-adopt], [data-market-adopt-full]')?.disabled,
    ignoreUnavailable: !document.querySelector('[data-market-ignore]') || document.querySelector('[data-market-ignore]').disabled,
    canaryHidden: !document.querySelector('[data-market-canary-toggle]'),
    resolutionDisabled: document.querySelector('[data-market-resolve=personal]')?.disabled,
  })`);
  assert.equal(pendingConflictSnapshot.adoptDisabled, true, 'other market adoption must remain locked while Overlay resolution is pending');
  assert.equal(pendingConflictSnapshot.ignoreUnavailable, true, 'ignore must not consume a pending Overlay resolution');
  assert.equal(pendingConflictSnapshot.canaryHidden, true, 'the version selector must not expose Canary controls');
  assert.equal(pendingConflictSnapshot.resolutionDisabled, false, 'the explicit Overlay resolution choice must remain available');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-market-resolve=personal]').click()`);
  await waitFor("window.__settingsUpdateTest.marketActions.length === 3 && window.__settingsUpdateTest.marketSectionState === 'adopted'", 'market section adoption did not complete');
  const marketAdoptionPayloads = await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.marketActions.slice(0, 3)`);
  assert.equal(marketAdoptionPayloads[0].expectedEffectiveSkillHash, 'market_hash_0');
  assert.equal(marketAdoptionPayloads[1].expectedEffectiveSkillHash, 'market_hash_remote');
  assert.equal(marketAdoptionPayloads[2].conflictResolutions.verification, 'personal');
  assert.ok(marketAdoptionPayloads[2].commandId);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-close]').click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-market-family="settings_agent"]').click()`);
  await waitFor("document.querySelector('[data-market-rollback-full]')?.disabled === false", 'adopted market version did not expose rollback');
  const adoptedSnapshot = await browserWindow.webContents.executeJavaScript(`({
    adoptUnavailable: !document.querySelector('[data-market-adopt], [data-market-adopt-full]') || document.querySelector('[data-market-adopt], [data-market-adopt-full]').disabled,
    rollbackDisabled: document.querySelector('[data-market-rollback-full]')?.disabled,
  })`);
  assert.equal(adoptedSnapshot.adoptUnavailable, true);
  assert.equal(adoptedSnapshot.rollbackDisabled, false);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-market-rollback-full]').click()`);
  await waitFor("window.__settingsUpdateTest.marketActions.length === 4 && window.__settingsUpdateTest.marketSectionState === 'rolled_back'", 'market rollback must remain available');
  const marketRollbackPayload = await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.marketActions[3]`);
  assert.equal(marketRollbackPayload.action, 'rollback');
  assert.equal(marketRollbackPayload.expectedEffectiveSkillHash, 'market_hash_adopted');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-close]').click()`);

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="account"]').click()`);
  await waitFor("document.querySelector('#codex-file-config-form')", 'account settings did not render after returning from evolution settings');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('.advanced-model-service-summary')?.click()`);
  await waitFor("document.querySelector('[data-advanced-model-service-disclosure]')?.open && document.querySelector('#codex-config-toml')?.offsetParent!==null", 'advanced model configuration did not expand');

  const modelScrollBefore = await browserWindow.webContents.executeJavaScript(`(() => {
    const region = document.querySelector('.settings-section-view');
    document.querySelector('#codex-file-config-form').scrollIntoView({ block: 'start' });
    region.scrollTop += 80;
    return region.scrollTop;
  })()`);
  assert.ok(modelScrollBefore > 300, `model settings must be below the top of the settings page, got ${modelScrollBefore}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#codex-config-toml').focus({ preventScroll: true })`);
  const modelScrollAfter = await browserWindow.webContents.executeJavaScript(`document.querySelector('.settings-section-view').scrollTop`);
  assert.ok(Math.abs(modelScrollAfter - modelScrollBefore) <= 2, `model configuration focus changed scrollTop from ${modelScrollBefore} to ${modelScrollAfter}`);
  writeFileSync(modelScreenshot, (await browserWindow.capturePage()).toPNG());

  await browserWindow.webContents.executeJavaScript(`(async () => {
    const { state } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href)});
    state.appPackaged = true;
    state.updateAnnouncementAutoPopup = true;
    state.updateAnnouncementLastSeenAvailableVersion = '';
    window.__settingsUpdateTest.subscriptions.updates({
      ...initialUpdate,
      version: '0.2.20',
      releaseDate: '2026-08-02T00:00:00.000Z',
      releaseNotes: '消息、组织与更新体验进一步统一。',
    });
  })()`);
  await waitFor("document.querySelector('.update-announcement-dialog.is-summary')?.textContent.includes('发现 Janus 0.2.20')", 'available update announcement did not open');
  if (announcementScreenshot) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    writeFileSync(announcementScreenshot, (await browserWindow.capturePage()).toPNG());
  }
  const announcementSummary = await browserWindow.webContents.executeJavaScript(`({
    hasDirectAction: Boolean(document.querySelector('[data-update-announcement-download]')),
    releaseDate: document.querySelector('.update-announcement-version time')?.textContent || '',
    compactHighlights: document.querySelectorAll('.update-announcement-summary li').length,
    descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.update-announcement-summary > p')).fontSize),
    highlightFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.update-announcement-summary li')).fontSize),
    actionWhiteSpace: getComputedStyle(document.querySelector('[data-update-announcement-download]')).whiteSpace,
  })`);
  assert.equal(announcementSummary.hasDirectAction, true, 'update announcement must expose a direct update action');
  assert.equal(announcementSummary.releaseDate, '发布时间：2026年8月2日', 'update announcement must show the release date');
  assert.ok(announcementSummary.compactHighlights <= 3, 'summary announcement must stay compact');
  assert.ok(announcementSummary.descriptionFontSize >= 15 && announcementSummary.highlightFontSize >= 14
    && announcementSummary.actionWhiteSpace === 'nowrap', `update announcement typography is too small: ${JSON.stringify(announcementSummary)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-update-announcement-details]').click()`);
  await waitFor("document.querySelector('.update-announcement-dialog.is-detailed') && document.body.textContent.includes('版本 0.2.18')", 'detailed update log did not render version history');
  const announcementDetailsTypography = await browserWindow.webContents.executeJavaScript(`({
    bodyFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.update-release-entry > p')).fontSize),
    sectionTitleFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.update-release-entry h4')).fontSize),
  })`);
  assert.ok(announcementDetailsTypography.bodyFontSize >= 14 && announcementDetailsTypography.sectionTitleFontSize >= 14,
    `update history typography is too small: ${JSON.stringify(announcementDetailsTypography)}`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const checkbox = document.querySelector('[data-update-announcement-auto-popup]');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('[data-update-announcement-close]').click();
  })()`);
  await waitFor("!document.querySelector('.update-announcement-dialog') && !document.querySelector('#update-announcement-auto-popup')?.checked", 'announcement dismissal preference was not retained');
  await browserWindow.webContents.executeJavaScript(`(async () => {
    const checkbox = document.querySelector('#update-announcement-auto-popup');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    const { state } = await import(${JSON.stringify(pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href)});
    state.appPackaged = false;
    window.__settingsUpdateTest.subscriptions.updates(initialUpdate);
  })()`);
  await waitFor("document.querySelector('#download-update-btn')", 'update center did not return after closing the announcement');

  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#update-center').scrollIntoView({ block: 'start' });
    document.querySelector('#download-update-btn').click();
  })()`);
  await waitFor("window.__settingsUpdateTest.downloadCalls === 1 && document.querySelector('[data-update-status-message]')?.textContent.includes('下载期间仍可继续使用')", 'download UI did not enter its downloading state');
  const progressBefore = await browserWindow.webContents.executeJavaScript(`(() => {
    const region = document.querySelector('.settings-section-view');
    window.__settingsUpdateTest.settingsRegion = region;
    window.__settingsUpdateTest.updateMessage = document.querySelector('[data-update-status-message]');
    return { top: region.scrollTop };
  })()`);
  const progressAfter = await browserWindow.webContents.executeJavaScript(`(() => {
    const listener = window.__settingsUpdateTest.subscriptions.updates;
    for (let percent = 1; percent <= 99; percent += 1) {
      listener({ ...initialUpdate, downloading: true, downloadProgress: percent, message: 'Downloading update ' + percent + '%.' });
    }
    const region = document.querySelector('.settings-section-view');
    return {
      sameRegion: region === window.__settingsUpdateTest.settingsRegion,
      sameMessage: document.querySelector('[data-update-status-message]') === window.__settingsUpdateTest.updateMessage,
      top: region.scrollTop,
      message: document.querySelector('[data-update-status-message]')?.textContent || '',
    };
  })()`);
  assert.equal(progressAfter.sameRegion, true, 'download progress must not replace the settings page DOM');
  assert.equal(progressAfter.sameMessage, true, 'download progress must update the existing status node in place');
  assert.equal(progressAfter.top, progressBefore.top, 'download progress must not move the settings scroll position');
  assert.match(progressAfter.message, /进度 99%/);

  await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.subscriptions.updates({
    ...initialUpdate,
    available: true,
    downloading: false,
    downloaded: true,
    downloadProgress: 100,
    message: 'Signed update verified. Install it when you are ready to restart.'
  })`);
  await waitFor("document.querySelector('#install-update-btn')", 'verified update did not expose the install action');
  const downloadedSnapshot = await browserWindow.webContents.executeJavaScript(`(() => ({
    top: document.querySelector('.settings-section-view').scrollTop,
    downloadCalls: window.__settingsUpdateTest.downloadCalls,
    installCalls: window.__settingsUpdateTest.installCalls,
    label: document.querySelector('.update-state-pill')?.textContent.trim(),
    action: document.querySelector('#install-update-btn')?.textContent.trim(),
    notice: document.querySelector('.app-notice')?.textContent.trim() || '',
  }))()`);
  assert.equal(downloadedSnapshot.top, progressBefore.top, 'download completion render must preserve settings scroll position');
  assert.equal(downloadedSnapshot.downloadCalls, 1);
  assert.equal(downloadedSnapshot.installCalls, 0, 'download completion must not install or close the app automatically');
  assert.equal(downloadedSnapshot.label, '已就绪');
  assert.equal(downloadedSnapshot.action, '安装并重启');
  assert.equal(downloadedSnapshot.notice.includes('Downloading update.'), false, 'ready state must not keep a stale downloading notice');
  writeFileSync(updateScreenshot, (await browserWindow.capturePage()).toPNG());

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="preferences"]').click()`);
  await waitFor("document.querySelector('[data-language-choice=\"en\"]')", 'language controls did not render before update install');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-language-choice="en"]').click()`);
  await waitFor("document.documentElement.lang === 'en'", 'settings did not switch to English before update install');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="account"]').click()`);
  await waitFor("document.querySelector('#install-update-btn')?.textContent.trim() === 'Install & Restart'", 'verified update action did not render in English');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#install-update-btn').click()`);
  await waitFor("window.__settingsUpdateTest.installCalls === 1", 'confirmed install did not reach the update bridge');
  const installSnapshot = await browserWindow.webContents.executeJavaScript(`({
    confirmCalls: window.__settingsUpdateTest.confirmCalls,
    confirmMessages: window.__settingsUpdateTest.confirmMessages,
    installCalls: window.__settingsUpdateTest.installCalls,
    errors: window.__settingsUpdateTest.errors,
  })`);
  assert.equal(installSnapshot.confirmCalls, 2, 'log cleanup and the install action must require confirmation');
  assert.equal(installSnapshot.confirmMessages.at(-1), 'Installing the update will close and restart Janus. Install now?');
  assert.equal(installSnapshot.installCalls, 1);
  assert.deepEqual(installSnapshot.errors, []);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="preferences"]').click()`);
  await waitFor("document.querySelector('[data-language-choice=\"zh-CN\"]')", 'language controls did not reopen after update confirmation');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-language-choice="zh-CN"]').click()`);
  await waitFor("document.documentElement.lang === 'zh-CN'", 'settings did not switch back to Chinese after update confirmation');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-settings-section="evolution-sync"]').click()`);
  await waitFor("document.querySelector('[data-evolution-updates-check]')", 'evolution settings did not reopen before employee UI checks');

  process.stdout.write('Checking employee context menu...\n');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#settings-back-btn').click()`);
  await waitFor("document.querySelector('[data-tab=\"employees\"]')", 'app navigation did not return after leaving settings');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-tab="employees"]').click()`);
  await waitFor("document.querySelector('[data-page-kind=\"employees\"]') && document.querySelector('[data-employee-installed-context=\"settings_agent_instance\"]')", 'talent market employee did not render');
  const unrecruitedContextSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const candidate = document.querySelector('[data-employee-market-candidate-open="unrecruited_agent"]');
    candidate.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return {
      candidateHasContextTarget: candidate.hasAttribute('data-employee-installed-context'),
      customMenuOpened: Boolean(document.querySelector('.employee-context-menu')),
    };
  })()`);
  assert.deepEqual(unrecruitedContextSnapshot, { candidateHasContextTarget: false, customMenuOpened: false }, 'unrecruited talent must not expose employee management on right click');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="settings_agent_instance"]');
    const rect = employee.getBoundingClientRect();
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right + 8, clientY: rect.bottom + 6 }));
  })()`);
  await waitFor("document.querySelector('.employee-context-menu')", 'employee context menu did not render');
  const contextMenuSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('.employee-context-menu');
    const rect = menu.getBoundingClientRect();
    return {
      labels: [...menu.querySelectorAll('[data-employee-context-action]')].map((item) => item.textContent.trim()),
      withinViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
    };
  })()`);
  assert.deepEqual(contextMenuSnapshot.labels, ['编辑名称与备注', '设为星标员工', '记忆与进化', '版本管理', '停用员工']);
  assert.equal(contextMenuSnapshot.withinViewport, true);
  await captureEmployeeScreenshot(browserWindow, 'employee-context-menu.png');

  process.stdout.write('Checking employee profile editor shortcut...\n');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-context-action="profile"]').click()`);
  await waitFor("document.querySelector('.employee-profile-editor[open] [data-employee-profile-form=\"settings_agent_instance\"]')", 'employee profile editor did not open from the context menu');
  const profileEditorSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('[data-employee-profile-form="settings_agent_instance"]');
    return {
      open: Boolean(form?.closest('.employee-profile-editor')?.open),
      displayNameFocused: document.activeElement === form?.querySelector('input[name="displayName"]'),
    };
  })()`);
  assert.deepEqual(profileEditorSnapshot, { open: true, displayNameFocused: true });
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-detail-close]').click()`);

  process.stdout.write('Checking employee memory drawer...\n');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="settings_agent_instance"]');
    const rect = employee.getBoundingClientRect();
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right + 8, clientY: rect.bottom + 6 }));
  })()`);
  await waitFor("document.querySelector('[data-employee-context-action=\"memory\"]')", 'employee context menu did not reopen before memory check');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-context-action="memory"]').click()`);
  await waitFor("document.querySelector('.employee-memory-drawer') && !document.querySelector('.employee-memory-drawer .employee-drawer-loading')", 'employee memory drawer did not render');
  await waitFor("(() => { const rect = document.querySelector('.employee-memory-drawer').getBoundingClientRect(); return Math.abs(rect.right - innerWidth) <= 1; })()", 'employee memory drawer animation did not settle');
  const memoryDrawerSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.employee-memory-drawer');
    const rect = drawer.getBoundingClientRect();
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      rightAligned: Math.abs(rect.right - innerWidth) <= 1,
      tall: rect.height >= innerHeight - 1,
      wide: rect.width >= 520,
    };
  })()`);
  await captureEmployeeScreenshot(browserWindow, 'employee-memory-drawer.png');
  assert.equal(memoryDrawerSnapshot.rightAligned && memoryDrawerSnapshot.tall && memoryDrawerSnapshot.wide, true, `unexpected memory drawer geometry: ${JSON.stringify(memoryDrawerSnapshot)}`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-detail-close]').click()`);

  process.stdout.write('Checking employee version drawer...\n');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="settings_agent_instance"]');
    const rect = employee.getBoundingClientRect();
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right + 8, clientY: rect.bottom + 6 }));
  })()`);
  await waitFor("document.querySelector('[data-employee-context-action=\"versions\"]')", 'employee context menu did not reopen');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-context-action="versions"]').click()`);
  await waitFor("document.querySelector('.employee-market-drawer') && !document.querySelector('.employee-market-drawer .employee-drawer-loading')", 'employee version drawer did not render');
  await waitFor("(() => { const rect = document.querySelector('.employee-market-drawer').getBoundingClientRect(); return Math.abs(rect.right - innerWidth) <= 1; })()", 'employee version drawer animation did not settle');
  const versionDrawerSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.employee-market-drawer');
    const rect = drawer.getBoundingClientRect();
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
      rightAligned: Math.abs(rect.right - innerWidth) <= 1,
      tall: rect.height >= innerHeight - 1,
      wide: rect.width >= 520,
      skillTabActive: drawer.querySelector('[data-employee-detail-tab="skill"]')?.classList.contains('is-active'),
      hasMarketSection: drawer.textContent.includes('市场版本') && drawer.textContent.includes('同类 Agent 共享的能力基础'),
      hasPersonalSection: drawer.textContent.includes('我的版本') && drawer.textContent.includes('只属于这个 Agent 实例'),
      hasPersonalDifference: drawer.textContent.includes('优先核对交付结果和引用'),
      hidesAdvancedContent: !/Canary|技术信息|编译算法|有效 Hash|最终编译内容/.test(drawer.textContent),
      hidesCompiledSkill: !drawer.textContent.includes('设置测试 Agent 的最终有效 Skill'),
      fullDownloadAction: drawer.querySelector('[data-market-adopt-full]')?.textContent.trim(),
      sectionDownloadAction: drawer.querySelector('[data-market-adopt]')?.textContent.trim(),
      basePersonalCurrent: [...drawer.querySelectorAll('.employee-skill-choice.is-current')].some((item) => item.textContent.includes('不使用个人版本')),
    };
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await captureEmployeeScreenshot(browserWindow, 'employee-version-drawer.png');
  assert.equal(versionDrawerSnapshot.rightAligned && versionDrawerSnapshot.tall && versionDrawerSnapshot.wide, true, `unexpected version drawer geometry: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.skillTabActive, true, `Agent detail must expose an active Skill tab: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.hasMarketSection, true, `market versions must be explained concisely: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.hasPersonalSection, true, `personal Agent versions must be selectable here: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.hasPersonalDifference, true, `personal version differences must be visible: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.hidesAdvancedContent, true, `advanced Skill internals must stay hidden: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.hidesCompiledSkill, true, `compiled Skill content must not be exposed: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.fullDownloadAction, '使用此版本', `market version must expose full-version adoption: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.sectionDownloadAction, undefined, `market version should not expose legacy section adoption: ${JSON.stringify(versionDrawerSnapshot)}`);
  assert.equal(versionDrawerSnapshot.basePersonalCurrent, true, `the current personal overlay choice must be identified: ${JSON.stringify(versionDrawerSnapshot)}`);
  const stableVersionDrawerSnapshot = await browserWindow.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.employee-market-drawer');
    drawer.scrollTop = 40;
    const scrollTop = drawer.scrollTop;
    window.__settingsUpdateTest.subscriptions.models({
      models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 SOL', defaultReasoningEffort: 'medium', reasoningEfforts: ['low', 'medium', 'high'] }]
    });
    const current = document.querySelector('.employee-market-drawer');
    return {
      sameNode: current === drawer,
      scrollStable: current.scrollTop === scrollTop,
      animationName: getComputedStyle(current).animationName,
    };
  })()`);
  assert.equal(stableVersionDrawerSnapshot.sameNode, true, 'background renderer updates must preserve the open version drawer DOM');
  assert.equal(stableVersionDrawerSnapshot.scrollStable, true, 'background renderer updates must preserve version drawer scroll position');
  assert.equal(stableVersionDrawerSnapshot.animationName, 'none', 'market drawer must not replay its entrance animation during refreshes');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-market-close]').click()`);

  process.stdout.write('Checking employee deactivation action...\n');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const employee = document.querySelector('[data-employee-installed-context="settings_agent_instance"]');
    const rect = employee.getBoundingClientRect();
    employee.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right + 8, clientY: rect.bottom + 6 }));
  })()`);
  await waitFor("document.querySelector('[data-employee-context-action=\"deactivate\"]')", 'employee context menu did not reopen for deactivation');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-employee-context-action="deactivate"]').click()`);
  await waitFor("window.__settingsUpdateTest.employeeActions.length === 1 && document.querySelector('[data-message-default-page]')", 'employee context deactivation did not complete');
  const employeeAction = await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.employeeActions[0]`);
  assert.equal(employeeAction.action, 'deactivate');
  assert.equal(employeeAction.agentInstanceId, 'settings_agent_instance');
  assert.equal(employeeAction.expectedStateRevision, 4);
  assert.equal(await browserWindow.webContents.executeJavaScript(`window.__settingsUpdateTest.confirmCalls`), 3);

  process.stdout.write(`Renderer settings/update UI smoke passed.\nModel screenshot: ${modelScreenshot}\nUpdate screenshot: ${updateScreenshot}\n${employeeScreenshotDir ? `Employee screenshots: ${employeeScreenshotDir}\n` : ''}`);
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-settings-update', stateExpression: 'window.__settingsUpdateTest?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

async function captureEmployeeScreenshot(browserWindow, filename) {
  if (!employeeScreenshotDir) return;
  mkdirSync(employeeScreenshotDir, { recursive: true });
  writeFileSync(path.join(employeeScreenshotDir, filename), (await browserWindow.capturePage()).toPNG());
}
