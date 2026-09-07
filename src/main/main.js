import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createRuntime } from './runtime.js';
import { configureCodexProviderRelay, configureCodexSystemProxy, terminateActiveCodexProcesses } from './codex.js';
import { codexConfigStatus } from './codexConfig.js';
import { createCodexProviderRelay } from './codexProviderRelay.js';
import { createUpdateService } from './updates.js';
import { createAgentBundleService } from './agentBundles.js';
import { prepareCodexStyleUserDataRoot, resolveRuntimeRoot } from './paths.js';
import { terminateFileChangeSnapshotWorkers } from './fileChangeSnapshots.js';
import { importStableProfileForTest } from './testProfileMigration.js';
import { installBrokenPipeGuards, sendWebContentsSafely } from '../shared/electronProcessSafety.js';
import { desktopReleaseChannel, desktopUserDataDirectoryName, TEST_DESKTOP_RELEASE_CHANNEL } from '../shared/desktopReleaseChannel.js';
import { registerIpcHandlers } from './ipc/registerIpcHandlers.js';
import { registerDatabaseRecoveryIpc } from './ipc/registerDatabaseRecoveryIpc.js';
import { createFeishuChannelService } from './modules/remoteChannels/application/feishuChannelService.js';
import { ElectronCredentialCodec } from './modules/remoteChannels/infrastructure/electronCredentialCodec.js';
import { FeishuClient } from './modules/remoteChannels/infrastructure/feishu/feishuClient.js';
import { FeishuConfigRepository } from './modules/remoteChannels/infrastructure/feishu/feishuConfigRepository.js';
import { parseFeishuMessageEvent } from './modules/remoteChannels/infrastructure/feishu/feishuMessageParser.js';
import { repairDatabase } from './databaseRecovery.js';
import { isDatabaseMaintenanceError } from './modules/persistence/infrastructure/databaseMaintenance.js';
import {
  agentBundleUpdateNotificationContent,
  agentDeliveryNotificationContent,
  applicationUpdateNotificationContent,
  collaborationTaskNotificationContent,
  createNativeNotificationOptions,
  createSystemNotificationAvailabilityChecker,
  socialMessageNotificationContent,
} from './systemNotifications.js';
import { installDesktopContextMenu } from './desktopContextMenu.js';
import { installExternalNavigation } from './externalNavigation.js';
import { createDesktopTrayController } from './desktopTrayController.js';
import { createMobileGateway } from './mobileGateway.js';
import {
  createTaskUiUpdatePublisher,
  taskUiUpdateDelayMs,
  taskUpdateAffectsAvailability,
} from './taskUiUpdatePublisher.js';
import {
  DESKTOP_ACTIVITY_STATE,
  deriveDesktopActivityState,
  desktopLoopDelay,
  shouldQuitWhenAllWindowsClosed,
  socialPollHadActivity,
  taskUpdateRequiresImmediateSocialPoll,
} from './desktopActivityPolicy.js';
import { logDeprecatedEvolutionEnvironment } from '../shared/evolution/index.js';
import { diagnosticsEnabled } from '../shared/diagnostics.js';
import { normalizeUiLanguage, uiText } from '../shared/uiLanguage.js';
import {
  applicationLoggingStatus,
  flushApplicationLogs,
  getApplicationLogger,
  initializeApplicationLogging,
  resolveApplicationLogDirectory,
} from '../shared/logging/index.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Menu, Tray, ipcMain, screen, session: electronSession, shell, dialog, clipboard, nativeImage, Notification, crashReporter, powerMonitor, safeStorage } = require('electron');
const systemNotificationsAvailable = createSystemNotificationAvailabilityChecker({ notificationApi: Notification });
if (process.platform === 'win32') app.setAppUserModelId('local.janus.desktop');
const windowsFallbackLocale = 'en-US';
if (process.platform === 'win32' && !app.commandLine.getSwitchValue('lang').trim()) {
  // Blink's native form-validation tooltip crashes in locale_win.cc when a
  // renderer is launched with a bare `--lang` switch and no locale value.
  app.commandLine.appendSwitch('lang', windowsFallbackLocale);
}
const hardwareAccelerationOptIn = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.JANUS_ENABLE_HARDWARE_ACCELERATION || '').trim().toLowerCase());
if (process.platform === 'win32' && !hardwareAccelerationOptIn) app.disableHardwareAcceleration();
// Use the renderer-owned title bar on every platform. Windows paints the
// native caption with the OS focus color, which can turn an inactive Janus
// window black even while the app is using its light theme. The shared custom
// frame keeps the caption and body on the same app-controlled theme whether
// the window is focused or not.
const nativeWindowFrame = false;
let uiLanguage = 'en';
let closePromptResolver = null;
let uiLanguageReadyResolved = false;
let resolveUiLanguageReady;
const uiLanguageReady = new Promise((resolve) => { resolveUiLanguageReady = resolve; });
const getUiLanguage = () => uiLanguage;
const t = (zh, en) => uiText(zh, en, uiLanguage);
function setUiLanguage(value = 'en') {
  uiLanguage = normalizeUiLanguage(value);
  if (!uiLanguageReadyResolved) {
    uiLanguageReadyResolved = true;
    resolveUiLanguageReady(uiLanguage);
  }
  installApplicationMenu();
  desktopTrayController?.refreshMenu();
  return uiLanguage;
}

function waitForInitialUiLanguage(timeoutMs = 5_000) {
  if (uiLanguageReadyResolved) return Promise.resolve(uiLanguage);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(uiLanguage), Math.max(0, Number(timeoutMs || 0)));
    timer.unref?.();
    uiLanguageReady.then((language) => {
      clearTimeout(timer);
      resolve(language);
    });
  });
}
const releaseChannel = desktopReleaseChannel({ appName: app.getName() });
if (app.isPackaged) {
  const legacyUserDataDir = app.getPath('userData');
  const userDataRoot = prepareCodexStyleUserDataRoot({
    legacyUserDataDir,
    explicitRoot: process.env.JANUS_HOME || '',
    homeDir: os.homedir(),
    directoryName: desktopUserDataDirectoryName(releaseChannel),
  });
  if (releaseChannel === TEST_DESKTOP_RELEASE_CHANNEL) {
    const stableUserDataRoot = prepareCodexStyleUserDataRoot({
      legacyUserDataDir: '',
      explicitRoot: '',
      homeDir: os.homedir(),
      directoryName: desktopUserDataDirectoryName('stable'),
    });
    try {
      importStableProfileForTest({
        targetRoot: userDataRoot,
        stableRoot: stableUserDataRoot,
        appVersion: app.getVersion(),
      });
    } catch (error) {
      console.warn(`[janus-test] stable profile import skipped: ${error?.message || error}`);
    }
  }
  app.setPath('userData', userDataRoot);
}
const loggingDirectory = resolveApplicationLogDirectory({ userDataDir: app.getPath('userData') });
initializeApplicationLogging({
  directory: loggingDirectory,
  appVersion: app.getVersion(),
  releaseChannel,
  processType: 'electron-main',
  level: process.env.JANUS_LOG_LEVEL || (app.isPackaged ? 'info' : 'debug'),
});
const mainLogger = getApplicationLogger('electron-main', { testFileName: 'desktop-main.jsonl' });
installBrokenPipeGuards();
logDeprecatedEvolutionEnvironment({
  processName: 'janus-desktop',
  logger: { warn: (message) => mainLogger.warn('deprecated-environment', { message }) },
});
try {
  const crashDirectory = path.join(loggingDirectory, 'crashes');
  fs.mkdirSync(crashDirectory, { recursive: true, mode: 0o700 });
  app.setPath('crashDumps', crashDirectory);
  if (!app.commandLine.hasSwitch('disable-crash-reporter') && !app.commandLine.hasSwitch('disable-breakpad')) {
    crashReporter.start({
      productName: app.getName(),
      companyName: 'Janus',
      uploadToServer: false,
      compress: false,
    });
  }
} catch (error) {
  mainLogger.warn('crash-reporter-unavailable', { error });
}
mainLogger.info('logging-initialized', { data: { level: applicationLoggingStatus().level, packaged: app.isPackaged } });
process.on('uncaughtExceptionMonitor', (error, origin) => {
  mainLogger.fatal('uncaught-exception', { error, data: { origin } });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  mainLogger.error('unhandled-rejection', { error });
});
const hasSingleInstanceLock = process.env.JANUS_TEST_ALLOW_MULTIPLE_INSTANCES === '1' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nativeSystemNotificationIcon = process.platform === 'win32'
  ? path.join(__dirname, '../../assets/icons/icon.ico')
  : process.platform === 'linux' ? path.join(__dirname, '../../assets/icons/icon.png') : '';
let mainWindow = null;
let recoveryWindow = null;
let startupWindow = null;
let startupWindowCreatedAt = 0;
let runtime = null;
let startupFailure = null;
let desktopShutdownPromise = null;
let desktopShutdownReady = false;
let maintenanceLoop = null;
let cloudSyncLoop = null;
let modelCatalogLoop = null;
let socialRelayLoop = null;
let presenceHeartbeatLoop = null;
let taskRecoveryLoop = null;
let updateService = null;
let agentBundleService = null;
let codexProviderRelay = null;
let feishuChannelService = null;
let desktopTrayController = null;
let taskUiUpdatePublisher = null;
let mobileGateway = null;
const notifiedCollaborationTasks = new Set();
const notifiedSocialMessages = new Set();
const notifiedAgentDeliveries = new Set();
const notifiedApplicationUpdates = new Set();
const notifiedAgentBundleUpdates = new Set();
const DESKTOP_NOTIFICATION_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.JANUS_DESKTOP_NOTIFICATION_MAX_AGE_HOURS || 24) * 60 * 60 * 1000,
);
const PERSISTENT_NOTIFICATION_LEDGER_KEY = 'desktop:notification_ledger_v1';
let persistentNotificationLedger = null;
let desktopSuspended = false;
let desktopSuspendedAt = 0;
let desktopScreenLocked = false;
let desktopOnBattery = false;
let desktopActivityState = DESKTOP_ACTIVITY_STATE.FOREGROUND;
let socialIdleRounds = 0;
let socialHasActiveWork = false;

function createAdaptiveDesktopLoop({ name = 'desktop-loop', run, delay, onError = null } = {}) {
  let timer = null;
  let running = false;
  let stopped = true;
  let rerunImmediately = false;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (overrideDelay = undefined) => {
    clearTimer();
    if (stopped) return;
    const nextDelay = overrideDelay === undefined ? delay() : overrideDelay;
    if (nextDelay === null || nextDelay === undefined || !Number.isFinite(Number(nextDelay))) return;
    timer = setTimeout(execute, Math.max(0, Number(nextDelay)));
    timer.unref?.();
  };
  const execute = async () => {
    timer = null;
    if (stopped) return;
    if (running) {
      rerunImmediately = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      if (typeof onError === 'function') onError(error);
      else mainLogger.warn(`${name}-failed`, { error });
    } finally {
      running = false;
      if (stopped) return;
      const immediate = rerunImmediately;
      rerunImmediately = false;
      schedule(immediate ? 0 : undefined);
    }
  };
  return {
    start({ immediate = true } = {}) {
      stopped = false;
      schedule(immediate ? 0 : undefined);
    },
    reschedule({ immediate = false } = {}) {
      if (stopped) return;
      if (running) {
        rerunImmediately ||= immediate;
        return;
      }
      schedule(immediate ? 0 : undefined);
    },
    stop() {
      stopped = true;
      rerunImmediately = false;
      clearTimer();
    },
  };
}

function hasVisibleApplicationWindow() {
  return BrowserWindow.getAllWindows().some((window) => (
    !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  ));
}

function hasRuntimeBackgroundWork() {
  if (!runtime) return false;
  if (Number(runtime.activeRuns?.size || 0) > 0) return true;
  if (socialHasActiveWork) return true;
  try {
    const currentUserId = runtime.currentUser?.()?.id || '';
    if (!currentUserId) return false;
    const activeTasks = runtime.store?.listTaskRuns?.({ userId: currentUserId, allWorkspaces: true, limit: 200 }) || [];
    if (activeTasks.some((task) => {
      const status = String(task.status || '');
      if (['pending', 'ready', 'queued', 'running', 'verifying', 'cancelling'].includes(status)) return true;
      if (Number(task.retryingNodeCount || 0) > 0) return true;
      return status === 'waiting'
        && Number(task.waitingNodeCount || 0) > 0
        && task.metadata?.failureReport?.userActionRequired !== true;
    })) return true;
    const activeAgentWork = runtime.store?.listAgentWorkQueue?.({
      userId: currentUserId, allWorkspaces: true, statuses: ['queued', 'running'], limit: 1,
    }) || [];
    return activeAgentWork.length > 0;
  } catch {
    return false;
  }
}

function rescheduleDesktopLoops({ immediate = false } = {}) {
  socialRelayLoop?.reschedule({ immediate });
  taskRecoveryLoop?.reschedule({ immediate });
  maintenanceLoop?.reschedule();
  cloudSyncLoop?.reschedule();
  modelCatalogLoop?.reschedule();
}

function refreshDesktopActivityState(reason = 'unknown', { immediate = false } = {}) {
  const next = deriveDesktopActivityState({
    suspended: desktopSuspended,
    locked: desktopScreenLocked,
    hasVisibleWindow: hasVisibleApplicationWindow(),
    hasBackgroundWork: hasRuntimeBackgroundWork(),
  });
  const changed = next !== desktopActivityState;
  desktopActivityState = next;
  runtime?.setDesktopActivityState?.(next);
  if (changed) {
    if (next === DESKTOP_ACTIVITY_STATE.FOREGROUND) socialIdleRounds = 0;
    mainLogger.info('desktop-activity-state-changed', { data: {
      reason, state: next, onBattery: desktopOnBattery, hasVisibleWindow: hasVisibleApplicationWindow(),
    } });
  }
  if (changed || immediate) rescheduleDesktopLoops({ immediate: immediate || next === DESKTOP_ACTIVITY_STATE.FOREGROUND });
  return next;
}

function scheduleDesktopActivityRefresh(reason = 'window-event', { immediate = false } = {}) {
  queueMicrotask(() => refreshDesktopActivityState(reason, { immediate }));
}

function installDesktopPowerMonitoring() {
  try { desktopOnBattery = Boolean(powerMonitor.isOnBatteryPower?.()); } catch { desktopOnBattery = false; }
  powerMonitor.on('suspend', () => {
    desktopSuspended = true;
    desktopSuspendedAt = Date.now();
    runtime?.recordDesktopPowerTransition?.({ state: 'suspended', occurredAt: new Date(desktopSuspendedAt).toISOString() });
    refreshDesktopActivityState('system-suspend');
  });
  powerMonitor.on('resume', () => {
    const resumedAt = Date.now();
    const suspendedDurationMs = desktopSuspendedAt > 0 ? Math.max(0, resumedAt - desktopSuspendedAt) : 0;
    desktopSuspended = false;
    desktopSuspendedAt = 0;
    runtime?.recordDesktopPowerTransition?.({
      state: 'resumed', occurredAt: new Date(resumedAt).toISOString(), suspendedDurationMs,
    });
    refreshDesktopActivityState('system-resume', { immediate: true });
  });
  powerMonitor.on('lock-screen', () => {
    desktopScreenLocked = true;
    refreshDesktopActivityState('screen-locked');
  });
  powerMonitor.on('unlock-screen', () => {
    desktopScreenLocked = false;
    refreshDesktopActivityState('screen-unlocked', { immediate: true });
  });
  powerMonitor.on('on-battery', () => {
    desktopOnBattery = true;
    mainLogger.info('desktop-power-source-changed', { data: { onBattery: true } });
    rescheduleDesktopLoops();
  });
  powerMonitor.on('on-ac', () => {
    desktopOnBattery = false;
    mainLogger.info('desktop-power-source-changed', { data: { onBattery: false } });
    rescheduleDesktopLoops();
  });
}

function rememberNotificationKey(bucket, key, limit = 500) {
  const cleanKey = String(key || '').trim();
  if (!bucket || !cleanKey) return;
  bucket.add(cleanKey);
  while (bucket.size > limit) bucket.delete(bucket.values().next().value);
}

function notificationItemIsFresh(item = {}, now = Date.now()) {
  const timestamp = Date.parse(item.updatedAt || item.updated_at || item.createdAt || item.created_at || '');
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp <= DESKTOP_NOTIFICATION_MAX_AGE_MS;
}

function loadPersistentNotificationLedger() {
  if (persistentNotificationLedger) return persistentNotificationLedger;
  try {
    const parsed = JSON.parse(runtime?.store?.settingGet?.(PERSISTENT_NOTIFICATION_LEDGER_KEY, '{}') || '{}');
    persistentNotificationLedger = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    persistentNotificationLedger = {};
  }
  return persistentNotificationLedger;
}

function persistentNotificationSeen(key = '') {
  const cleanKey = String(key || '').trim();
  return Boolean(cleanKey && loadPersistentNotificationLedger()[cleanKey]);
}

function rememberPersistentNotification(key = '', limit = 1000) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey || !runtime?.store?.settingSet) return;
  const ledger = loadPersistentNotificationLedger();
  ledger[cleanKey] = new Date().toISOString();
  const entries = Object.entries(ledger).sort((left, right) => Date.parse(left[1] || 0) - Date.parse(right[1] || 0));
  while (entries.length > limit) {
    const [oldestKey] = entries.shift();
    delete ledger[oldestKey];
  }
  runtime.store.settingSet(PERSISTENT_NOTIFICATION_LEDGER_KEY, JSON.stringify(ledger));
}

function focusMainApplicationWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = desktopTrayController?.firstApplicationWindow?.() || createAppWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function createDesktopTrayImage(platform = process.platform) {
  const iconPath = path.join(__dirname, platform === 'win32'
    ? '../../assets/icons/icon.ico'
    : '../../assets/icons/512x512-transparent.png');
  const source = nativeImage.createFromPath(iconPath);
  if (platform === 'win32' || source.isEmpty?.()) return source;
  const size = platform === 'darwin' ? 18 : 24;
  const image = source.resize({ width: size, height: size, quality: 'best' });
  if (platform === 'darwin') image.setTemplateImage?.(true);
  return image;
}

function initializeDesktopTrayController({ refresh = true } = {}) {
  if (desktopTrayController) return refresh ? desktopTrayController.refresh() : desktopTrayController;
  desktopTrayController = createDesktopTrayController({
    app,
    Tray,
    Menu,
    platform: process.platform,
    appName: app.getName(),
    createTrayImage: createDesktopTrayImage,
    getSetting: (key, fallback) => runtime?.store?.settingGet?.(key, fallback) ?? fallback,
    setSetting: (key, value) => runtime?.store?.settingSet?.(key, value),
    focusApplication: focusMainApplicationWindow,
    translate: t,
    async promptCloseBehavior({ window, closeBehavior }) {
      const backgroundFirst = closeBehavior === 'background';
      const response = await new Promise((resolve) => {
        const token = `close_prompt_${Date.now()}`;
        closePromptResolver = (payload = {}) => {
          closePromptResolver = null;
          window?.webContents?.executeJavaScript?.(`document.getElementById(${JSON.stringify(token)})?.remove()`).catch?.(() => {});
          resolve({ closeBehavior: payload.closeBehavior, remember: Boolean(payload.remember) });
        };
        const en = getUiLanguage() === 'en';
        const labels = en
          ? { title: 'Close Janus', message: 'What should Janus do when its last window is closed?', detail: 'Keep Running continues local tasks. Quit Janus stops local tasks and exits.', remember: 'Remember my choice and do not ask again', cancel: 'Cancel', background: 'Keep Running', quit: 'Quit Janus' }
          : { title: '关闭 Janus', message: '关闭最后一个窗口时，Janus 应该如何处理？', detail: '选择“后台运行”可继续本机任务；选择“退出 Janus”将结束本机任务并退出。', remember: '记住我的选择并不再询问', cancel: '取消', background: '后台运行', quit: '退出 Janus' };
        const payloadJson = JSON.stringify({ token, ...labels, backgroundFirst });
        window?.webContents?.executeJavaScript?.(`(() => { const p=${payloadJson}; if(document.getElementById(p.token)) return; const o=document.createElement('div'); o.id=p.token; o.className=document.querySelector('.shell.theme-dark')?'is-dark':''; o.innerHTML='<style>#'+p.token+'{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-start;justify-content:flex-start;padding:clamp(28px,8vh,88px) clamp(20px,7vw,104px);background:rgba(20,32,51,.32);backdrop-filter:blur(3px)}#'+p.token+' .janus-close-card{position:relative;width:min(390px,calc(100vw - 32px));padding:18px 20px 15px;border:1px solid var(--ui-border,#d9e2ef);border-radius:10px;background:var(--ui-surface,#fff);color:var(--ui-text,#24324a);box-shadow:0 14px 36px rgba(24,52,91,.2);font-family:inherit}#'+p.token+' h2{margin:0 28px 8px 0;font-size:17px;line-height:1.3}#'+p.token+' p{margin:6px 0;color:var(--ui-muted,#63738a);line-height:1.45;font-size:12px}#'+p.token+' .close-x{position:absolute;top:8px;right:9px;width:25px;height:25px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--ui-muted,#63738a);font-size:20px;line-height:23px;cursor:pointer}#'+p.token+' .close-x:hover,#'+p.token+' .close-x:focus-visible{background:var(--ui-border,#e5ebf3);color:inherit;outline:none}#'+p.token+' footer{display:flex;justify-content:flex-end;gap:7px;margin-top:15px}#'+p.token+' button{border:1px solid var(--ui-border,#cbd7e6);border-radius:6px;padding:7px 11px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}#'+p.token+' button.primary{border-color:#3277df;background:#3277df;color:#fff}#'+p.token+' .remember{display:flex;align-items:center;gap:6px;width:100%;margin:13px 0 0;color:var(--ui-muted,#52647b);font-size:11px;line-height:15px;cursor:pointer}#'+p.token+' .remember input{appearance:none;-webkit-appearance:none;width:13px;height:13px;min-width:13px;margin:0;border:1px solid var(--ui-border,#b9c8da);border-radius:3px;background:var(--ui-surface,#fff);accent-color:#3277df}#'+p.token+' .remember input:checked{background:#3277df;box-shadow:inset 0 0 0 3px var(--ui-surface,#fff)}#'+p.token+'.is-dark .janus-close-card{--ui-border:#3c506b;--ui-surface:#1b2839;--ui-text:#e8eef8;--ui-muted:#aebbd0;background:#1b2839;color:#e8eef8}#'+p.token+'.is-dark .remember input{background:#25364b;border-color:#526985}#'+p.token+'.is-dark .remember input:checked{background:#4a8df0}#'+p.token+'.is-dark button{border-color:#40516a;color:#e8eef8}#'+p.token+'.is-dark button.primary{border-color:#4a8df0;background:#3f82e8;color:#fff}</style><section class="janus-close-card"><button class="close-x" type="button" aria-label="'+p.cancel+'" title="'+p.cancel+'" data-close="cancel">×</button><h2>'+p.title+'</h2><p>'+p.message+'</p><p>'+p.detail+'</p><label class="remember"><input type="checkbox">'+p.remember+'</label><footer><button data-close="cancel">'+p.cancel+'</button><button data-close="background">'+p.background+'</button><button class="primary" data-close="quit">'+p.quit+'</button></footer></section>'; document.body.appendChild(o); o.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>window.janus.respondClosePrompt({token:p.token,closeBehavior:b.dataset.close,remember:o.querySelector('input').checked})); })()`).catch?.(() => resolve({ closeBehavior: 'cancel', remember: false }));
      });
      return {
        closeBehavior: response.closeBehavior || (backgroundFirst ? 'background' : 'cancel'),
        remember: response.remember,
      };
    },
    onWindowHidden: () => scheduleDesktopActivityRefresh('window-hidden-to-tray'),
    logger: mainLogger,
  });
  return refresh ? desktopTrayController.refresh() : desktopTrayController;
}

function sendSystemNotificationNavigation(channel, payload = {}) {
  const window = focusMainApplicationWindow();
  if (!window) return false;
  const send = () => sendWebContentsSafely(window, channel, payload);
  if (!window.webContents.getURL() || window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', send);
    return true;
  }
  return send();
}

async function showNativeSystemNotification({ bucket = null, key = '', title = '', body = '', onClick = null } = {}) {
  const cleanKey = String(key || '').trim();
  if (bucket && cleanKey && bucket.has(cleanKey)) return false;
  if (!(await systemNotificationsAvailable())) return false;
  try {
    const notice = new Notification(createNativeNotificationOptions({
      title,
      body,
      platform: process.platform,
      icon: nativeSystemNotificationIcon,
    }));
    if (typeof onClick === 'function') notice.on('click', () => {
      focusMainApplicationWindow();
      try { onClick(); } catch {}
    });
    notice.show();
    rememberNotificationKey(bucket, cleanKey);
    return true;
  } catch (error) {
    mainLogger.warn('system-notification-failed', { data: { title, key: cleanKey }, error });
    return false;
  }
}

function janusWindowIsFocused() {
  const focused = BrowserWindow.getFocusedWindow?.();
  if (!focused || focused.isDestroyed?.()) return false;
  return focused === mainWindow || focused === desktopTrayController?.firstApplicationWindow?.();
}

async function routeDesktopNotification(payload = {}) {
  if (janusWindowIsFocused() && mainWindow && !mainWindow.isDestroyed()) {
    sendWebContentsSafely(mainWindow, 'desktop:notification', payload);
    return true;
  }
  return showNativeSystemNotification(payload);
}

async function drainFollowerNotifications() {
  if (!runtime?.followerNotificationIntents) return 0;
  const intents = runtime.followerNotificationIntents({ statuses: ['pending'], limit: 20 }) || [];
  let shownCount = 0;
  for (const intent of intents) {
    if (intent.category !== 'follower_report_ready') continue;
    const shown = await routeDesktopNotification({
      id: intent.id,
      target: { channel: 'system:open-follower', payload: { reportId: intent.targetId } },
      key: intent.id,
      title: t('Follower 报告已就绪', 'Follower Report Ready'),
      body: t('新的工作跟进报告已经生成，点击查看。', 'A new work follow-up report is ready. Click to open it.'),
      onClick: () => sendSystemNotificationNavigation('system:open-follower', { reportId: intent.targetId }),
    });
    if (!shown) continue;
    runtime.followerNotificationSettle({ id: intent.id, status: 'shown' });
    shownCount += 1;
  }
  return shownCount;
}

function directSocialMessageForNotification(message = {}) {
  const metadata = message.metadata || {};
  return message.id
    && !metadata.taskGroupId
    && !metadata.groupId
    && !metadata.delegationId
    && metadata.type !== 'agent_delegation'
    && message.kind !== 'system';
}

function installApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: t(`\u5173\u4e8e ${app.name}`, `About ${app.name}`), role: 'about' },
        { type: 'separator' },
        { label: t(`\u9690\u85cf ${app.name}`, `Hide ${app.name}`), role: 'hide' },
        { label: t('\u9690\u85cf\u5176\u4ed6', 'Hide Others'), role: 'hideOthers' },
        { label: t('\u5168\u90e8\u663e\u793a', 'Show All'), role: 'unhide' },
        { type: 'separator' },
        { label: t(`\u9000\u51fa ${app.name}`, `Quit ${app.name}`), role: 'quit', accelerator: 'Command+Q' },
      ],
    },
    {
      label: t('\u6587\u4ef6', 'File'),
      submenu: [{ label: t('\u5173\u95ed\u7a97\u53e3', 'Close Window'), role: 'close', accelerator: 'Command+W' }],
    },
    {
      label: t('\u7f16\u8f91', 'Edit'),
      submenu: [
        { label: t('\u64a4\u9500', 'Undo'), role: 'undo' },
        { label: t('\u91cd\u505a', 'Redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('\u526a\u5207', 'Cut'), role: 'cut' },
        { label: t('\u590d\u5236', 'Copy'), role: 'copy' },
        { label: t('\u7c98\u8d34', 'Paste'), role: 'paste' },
        { label: t('\u5168\u9009', 'Select All'), role: 'selectAll' },
      ],
    },
    {
      label: t('\u7a97\u53e3', 'Window'),
      submenu: [
        { label: t('\u6700\u5c0f\u5316', 'Minimize'), role: 'minimize' },
        { label: t('\u7f29\u653e', 'Zoom'), role: 'zoom' },
        { type: 'separator' },
        { label: t('\u524d\u7f6e\u5168\u90e8\u7a97\u53e3', 'Bring All to Front'), role: 'front' },
        { type: 'separator' },
        { label: t('\u5207\u6362\u8bed\u8a00', 'Switch Language'), click: () => setUiLanguage(uiLanguage === 'en' ? 'zh-CN' : 'en') },
      ],
    },
    {
      label: t('\u5e2e\u52a9', 'Help'),
      submenu: [
        { label: t('\u6587\u6863', 'Documentation'), click: () => shell.openExternal('https://github.com/iLearn-Agent/Janus#readme') },
        { label: t('\u53d1\u9001\u53cd\u9988', 'Send Feedback'), click: () => shell.openExternal('https://github.com/iLearn-Agent/Janus/issues/new') },
      ],
    },
  ]));
}

function createStartupWindow() {
  if (app.commandLine.hasSwitch('remote-debugging-port') && process.env.JANUS_TEST_STARTUP_SPLASH !== '1') return null;
  if (startupWindow && !startupWindow.isDestroyed()) return startupWindow;
  startupWindowCreatedAt = Date.now();
  startupWindow = new BrowserWindow({
    width: 460,
    height: 330,
    minWidth: 460,
    minHeight: 330,
    center: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#f3f6fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupWindow.loadFile(path.join(__dirname, '../renderer/startup.html'), { query: { platform: process.platform } });
  startupWindow.on('closed', () => { startupWindow = null; });
  return startupWindow;
}

function updateStartupStage(message = '') {
  if (!startupWindow || startupWindow.isDestroyed()) return;
  const script = `window.setStartupStage?.(${JSON.stringify(String(message || t('正在启动…', 'Starting…')))})`;
  startupWindow.webContents.executeJavaScript(script).catch(() => {});
}

function closeStartupWindow({ minimumVisibleMs = 500 } = {}) {
  const window = startupWindow;
  if (!window || window.isDestroyed()) return;
  const wait = Math.max(0, Number(minimumVisibleMs || 0) - (Date.now() - startupWindowCreatedAt));
  setTimeout(() => {
    if (window.isDestroyed()) return;
    window.close();
  }, wait).unref?.();
}

function notifyAgentDeliveryTerminal(payload = {}) {
  const content = agentDeliveryNotificationContent(payload, uiLanguage);
  const receipt = payload.receipt || {};
  if (!content || receipt.metadata?.surface === 'delegation_workspace') return;
  const key = `${receipt.workId || receipt.id || ''}:${receipt.deliveryStatus || ''}:${receipt.updatedAt || ''}`;
  void routeDesktopNotification({
    id: key,
    target: { channel: 'system:open-agent-session', payload: { sessionId: receipt.targetSessionId || payload.session?.id || '' } },
    bucket: notifiedAgentDeliveries,
    key,
    ...content,
    onClick: () => sendSystemNotificationNavigation('system:open-agent-session', {
      sessionId: receipt.targetSessionId || payload.session?.id || '',
    }),
  });
}

function notifyApplicationUpdate(current = {}, previous = {}) {
  const content = applicationUpdateNotificationContent(current, previous, uiLanguage);
  if (!content) return;
  const phase = current.downloaded ? 'downloaded' : 'available';
  void routeDesktopNotification({
    id: `${phase}:${current.version || 'unknown'}`,
    target: { channel: 'system:open-updates', payload: {} },
    bucket: notifiedApplicationUpdates,
    key: `${phase}:${current.version || 'unknown'}`,
    ...content,
    onClick: () => sendSystemNotificationNavigation('system:open-updates', {}),
  });
}

function notifyAgentBundleUpdate(current = {}, previous = {}) {
  const content = agentBundleUpdateNotificationContent(current, previous, uiLanguage);
  if (!content) return;
  const bundle = current.current?.bundleId || current.candidate?.artifact?.bundleId || 'unknown';
  const phase = previous.applying && !current.applying ? 'applied' : 'available';
  void routeDesktopNotification({
    id: `${phase}:${bundle}`,
    target: { channel: 'system:open-updates', payload: {} },
    bucket: notifiedAgentBundleUpdates,
    key: `${phase}:${bundle}`,
    ...content,
    onClick: () => sendSystemNotificationNavigation('system:open-updates', {}),
  });
}
const databaseRepairRequested = app.commandLine.hasSwitch('repair-database') || process.argv.some((argument) => argument.startsWith('--repair-database'));
const databaseRepairHeadless = databaseRepairRequested && (
  app.commandLine.getSwitchValue('repair-database') === 'headless'
  || app.commandLine.hasSwitch('repair-headless')
  || process.argv.includes('--repair-headless')
  || process.argv.includes('--headless')
);

function createAppWindow({ secondary = false } = {}) {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workAreaSize;
  const scaleFactor = display.scaleFactor || 1;
  const usableWidth = Math.floor(workArea.width / scaleFactor);
  const usableHeight = Math.floor(workArea.height / scaleFactor);
  const initialWidth = Math.min(1440, Math.max(1120, usableWidth - 32));
  const initialHeight = Math.min(960, Math.max(760, usableHeight - 32));
  const window = new BrowserWindow({
    width: secondary ? Math.min(1280, initialWidth) : initialWidth,
    height: secondary ? Math.min(880, initialHeight) : initialHeight,
    minWidth: 820,
    minHeight: 600,
    center: true,
    title: app.getName(),
    frame: nativeWindowFrame,
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#f6f7f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  recordDesktopDiagnostic('window-created', { secondary, windowId: window.id });
  if (diagnosticsEnabled()) {
    window.webContents.on('console-message', (_event, details, legacyMessage, legacyLine, legacySourceId) => {
      const payload = details && typeof details === 'object'
        ? details
        : { level: details, message: legacyMessage, lineNumber: legacyLine, sourceId: legacySourceId };
      const level = Number(payload.level || 0);
      recordDesktopDiagnostic('renderer-console', { ...payload, windowId: window.id }, level >= 3 ? 'error' : level === 2 ? 'warn' : 'info');
    });
  }
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    recordDesktopDiagnostic('preload-error', { preloadPath, windowId: window.id }, 'error', error);
  });
  installDesktopContextMenu(window, { Menu, getLanguage: getUiLanguage });
  installExternalNavigation(window, {
    shell,
    onError: (error, url) => mainLogger.warn('external-navigation-failed', { error, data: { url } }),
  });
  installWindowRecovery(window);
  desktopTrayController?.registerWindow(window);
  window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { platform: process.platform } });
  for (const eventName of ['show', 'hide', 'minimize', 'restore', 'focus', 'blur']) {
    window.on(eventName, () => scheduleDesktopActivityRefresh(`window-${eventName}`, {
      immediate: ['show', 'restore', 'focus'].includes(eventName),
    }));
  }
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = desktopTrayController?.firstApplicationWindow?.() || null;
    scheduleDesktopActivityRefresh('window-closed');
  });
  return window;
}

function createRecoveryWindow() {
  if (recoveryWindow && !recoveryWindow.isDestroyed()) {
    recoveryWindow.show();
    recoveryWindow.focus();
    return recoveryWindow;
  }
  recoveryWindow = new BrowserWindow({
    width: 760, height: 640, minWidth: 640, minHeight: 520, center: true,
    title: t('Janus 数据库恢复', 'Janus Database Recovery'), frame: nativeWindowFrame, autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icons/icon.png'), backgroundColor: '#f3f5f8',
    webPreferences: {
      preload: path.join(__dirname, '../preload/recoveryPreload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  recoveryWindow.loadFile(path.join(__dirname, '../renderer/recovery/index.html'), {
    query: { language: uiLanguage, platform: process.platform },
  });
  recoveryWindow.on('closed', () => { recoveryWindow = null; });
  installApplicationMenu();
  return recoveryWindow;
}

async function createMainWindow() {
  const startupStartedAt = Date.now();
  createStartupWindow();
  updateStartupStage(t('正在检查本地数据…', 'Checking local data…'));
  recordDesktopDiagnostic('desktop-startup-begin', { packaged: app.isPackaged, releaseChannel });
  taskUiUpdatePublisher?.close();
  taskUiUpdatePublisher = createTaskUiUpdatePublisher({
    delayMs: taskUiUpdateDelayMs(),
    publish(payload) {
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) sendWebContentsSafely(window, 'task:updated', payload);
      const userId = payload?.task?.ownerUserId || '';
      const workspaceId = payload?.task?.workspaceId || payload?.task?.accountWorkspaceId || '';
      const statuses = userId && taskUpdateAffectsAvailability(payload)
        ? runtime?.store?.listAgentAvailability?.({ userId, workspaceId }) || []
        : [];
      if (statuses.length) {
        const agentStatuses = runtime?.agentStatuses?.() || [];
        for (const window of windows) sendWebContentsSafely(window, 'agent-availability:changed', {
          statuses,
          agentStatuses,
          taskRunId: payload?.task?.id || '',
          accountWorkspaceId: payload?.task?.workspaceId || payload?.task?.accountWorkspaceId || '',
        });
      }
      if (taskUpdateRequiresImmediateSocialPoll(payload)) {
        socialRelayLoop?.reschedule({ immediate: true });
      }
      void feishuChannelService?.handleTaskUpdated?.(payload)?.catch?.((error) => {
        mainLogger.warn("Feishu task update delivery failed.", error);
      });
      scheduleDesktopActivityRefresh('task-updated');
    },
    onFlush({ taskRunId, coalescedCount, delayMs }) {
      if (coalescedCount < 2) return;
      mainLogger.debug('task-ui-updates-coalesced', {
        context: { taskRunId },
        data: { coalescedCount, delayMs },
      });
    },
    onError(error, publication = {}) {
      mainLogger.warn('task-ui-update-publication-failed', {
        error,
        context: { taskRunId: publication.taskRunId || '' },
        data: {
          coalescedCount: Number(publication.coalescedCount || 0),
          immediate: Boolean(publication.immediate),
        },
      });
    },
  });
  runtime = await createRuntime({
    isDev: !app.isPackaged,
    userDataDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    organizationResearchCredentialCodec: new ElectronCredentialCodec({ safeStorage }),
    getUiLanguage,
    requireExplicitAuthentication: true,
    onEmployeeIdentityUpdated(payload = {}) {
      const user = runtime?.currentUser?.() || null;
      const accountWorkspaceId = user
        ? runtime?.store?.activeAccountWorkspace?.({
          userId: user.id,
          deviceId: runtime?.store?.contextDeviceId?.() || 'local',
        })?.id || 'workspace_personal'
        : '';
      const update = {
        ...payload,
        userId: user?.id || '',
        accountWorkspaceId,
      };
      for (const window of BrowserWindow.getAllWindows()) {
        sendWebContentsSafely(window, 'employees:updated', update);
      }
    },
    onNativePluginCatalogChanged(payload = {}) {
      for (const window of BrowserWindow.getAllWindows()) {
        sendWebContentsSafely(window, 'codex-plugins:changed', payload);
      }
    },
    onAttachedSkillCatalogChanged(payload = {}) {
      for (const window of BrowserWindow.getAllWindows()) {
        sendWebContentsSafely(window, 'skills:attached-changed', payload);
      }
    },
    onFollowerUpdated(payload = {}) {
      for (const window of BrowserWindow.getAllWindows()) {
        sendWebContentsSafely(window, 'follower:updated', payload);
      }
      scheduleDesktopActivityRefresh('follower-updated');
      if (payload.kind === 'report_ready') void drainFollowerNotifications();
    },
    onAgentDeliveryUpdated(payload) {
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) sendWebContentsSafely(window, 'agent-delivery:updated', payload);
      const agentInstanceId = payload?.receipt?.targetAgentInstanceId || payload?.event?.agentInstanceId || '';
      const userId = payload?.receipt?.userId || runtime?.auth?.currentUser?.()?.id || '';
      const status = agentInstanceId && userId
        ? runtime?.store?.getAgentAvailability?.({
            userId, agentInstanceId,
            workspaceId: payload?.receipt?.accountWorkspaceId || payload?.receipt?.workspaceId || '',
          })
        : null;
      if (status) {
        for (const window of windows) sendWebContentsSafely(window, 'agent-availability:changed', {
          statuses: [status],
          accountWorkspaceId: payload?.receipt?.accountWorkspaceId || payload?.receipt?.workspaceId || '',
        });
      }
      notifyAgentDeliveryTerminal(payload);
      scheduleDesktopActivityRefresh('agent-delivery-updated');
    },
    onAgentAvailabilityChanged(payload = {}) {
      const windows = BrowserWindow.getAllWindows();
      const agentStatuses = runtime?.agentStatuses?.() || [];
      const visiblePayload = agentStatuses.length ? { ...payload, agentStatuses } : payload;
      for (const window of windows) sendWebContentsSafely(window, 'agent-availability:changed', visiblePayload);
      scheduleDesktopActivityRefresh('agent-availability-changed');
    },
    onTaskUpdated(payload) {
      taskUiUpdatePublisher?.enqueue(payload);
    },
  });
  mobileGateway = createMobileGateway({ runtime, port: Number(process.env.JANUS_MOBILE_PORT || 3210), logger: mainLogger });
  try { await mobileGateway.start(); } catch (error) { mobileGateway = null; mainLogger.warn('mobile-gateway-unavailable', { error }); }
  const feishuCredentialCodec = new ElectronCredentialCodec({ safeStorage });
  feishuChannelService = createFeishuChannelService({
    runtime,
    credentialCodec: feishuCredentialCodec,
    configRepository: new FeishuConfigRepository({ store: runtime.store, codec: feishuCredentialCodec }),
    clientFactory: (options) => new FeishuClient(options),
    parseMessageEvent: parseFeishuMessageEvent,
    onSessionUpdated: (payload) => {
      for (const window of BrowserWindow.getAllWindows()) {
        sendWebContentsSafely(window, 'chat-session:updated', payload);
      }
    },
    logger: mainLogger,
  });
  await feishuChannelService.reconcile();
  initializeDesktopTrayController({ refresh: false });
  persistentNotificationLedger = null;
  recordDesktopDiagnostic('desktop-startup-runtime-ready', { durationMs: Date.now() - startupStartedAt });
  updateStartupStage(t('正在载入工作区…', 'Loading workspace…'));
  try {
    codexProviderRelay = await createCodexProviderRelay({
      electronSession: electronSession.defaultSession,
      getBaseUrl: () => runtime?.root ? codexConfigStatus(runtime.root).baseUrl || '' : '',
    });
    configureCodexProviderRelay(codexProviderRelay.url);
  } catch (error) {
    codexProviderRelay = null;
    configureCodexProviderRelay('', error?.message || String(error));
    mainLogger.warn('codex-provider-relay-unavailable', { error });
  }
  updateStartupStage(t('正在准备界面…', 'Preparing the interface…'));
  await refreshCodexSystemProxy();
  mainWindow = createAppWindow();
  void drainFollowerNotifications();
  desktopTrayController.refresh();
  mainWindow.webContents.once('did-finish-load', () => closeStartupWindow());
  setTimeout(() => closeStartupWindow({ minimumVisibleMs: 0 }), 15_000).unref?.();
  installApplicationMenu();
  updateService = createUpdateService({
    app,
    isDev: !app.isPackaged,
    releaseChannel,
    windowProvider: () => mainWindow,
    onStatusChanged: ({ current, previous }) => notifyApplicationUpdate(current, previous),
    onBeforeInstall: () => desktopTrayController?.markQuitting('application-update'),
  });
  agentBundleService = createAgentBundleService({
    root: runtime.root,
    appVersion: app.getVersion(),
    channel: releaseChannel === TEST_DESKTOP_RELEASE_CHANNEL ? 'test' : undefined,
    windowProvider: () => mainWindow,
    fetchImpl: electronSession.defaultSession.fetch.bind(electronSession.defaultSession),
    onStatusChanged: ({ current, previous }) => notifyAgentBundleUpdate(current, previous),
  });
  void waitForInitialUiLanguage().then(() => updateService.scheduleInitialCheck());
  agentBundleService.scheduleInitialCheck();
  startModelCatalogRefresh();
  startMaintenanceLoop();
  startCloudSyncLoop();
  startSocialRelayLoop();
  startTaskRecoveryLoop();
  refreshDesktopActivityState('desktop-startup', { immediate: true });
  recordDesktopDiagnostic('desktop-startup-complete', {
    windowId: mainWindow?.id || null, runtimeRoot: runtime?.root || '', durationMs: Date.now() - startupStartedAt,
  });
}

registerIpcHandlers({
  ipcMain,
  app,
  BrowserWindow,
  screen,
  dialog,
  shell,
  clipboard,
  nativeImage,
  getRuntime: () => runtime,
  getMainWindow: () => mainWindow,
  getUpdateService: () => updateService,
  getAgentBundleService: () => agentBundleService,
  getFeishuChannelService: () => feishuChannelService,
  getDesktopTrayController: () => desktopTrayController,
  getMobileGateway: () => mobileGateway,
  onAuthenticationChanged: ({ authenticated } = {}) => {
    if (authenticated) startSocialRelayLoop();
    else runtime?.stopSocialRealtime?.();
  },
  requestAppQuit: (reason) => {
    if (desktopTrayController) return desktopTrayController.requestQuit(reason);
    return app.quit();
  },
  createAppWindow,
  refreshCodexSystemProxy,
  refreshModelCatalog,
  getUiLanguage,
  setUiLanguage,
  onClosePromptResponse: (payload) => closePromptResolver?.(payload),
});

registerDatabaseRecoveryIpc({
  ipcMain, app, BrowserWindow, dialog, shell,
  getRoot: recoveryRuntimeRoot,
  getStartupError: () => startupFailure,
  getUiLanguage,
  setUiLanguage,
  restart() {
    if (process.env.JANUS_TEST_RECOVERY_NO_RESTART === '1') return { status: 'restarting', suppressedForTest: true };
    app.relaunch(); app.exit(0); return { status: 'restarting' };
  },
});

app.on('second-instance', () => {
  if (runtime) {
    focusMainApplicationWindow();
    refreshDesktopActivityState('second-instance', { immediate: true });
    return;
  }
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow
    : recoveryWindow && !recoveryWindow.isDestroyed() ? recoveryWindow : startupWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.show();
  targetWindow.focus();
});

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    installDesktopPowerMonitoring();
    if (databaseRepairHeadless) return runHeadlessDatabaseRepair();
    if (databaseRepairRequested) return createRecoveryWindow();
    return createMainWindow();
  }).catch(handleStartupFailure);
}

app.on('window-all-closed', () => {
  const trayStatus = desktopTrayController?.status?.() || {};
  if (shouldQuitWhenAllWindowsClosed(process.platform, {
    keepAlive: desktopTrayController?.shouldKeepRunningWithoutWindows?.() === true,
    closeBehavior: trayStatus.closeBehavior,
  })) app.quit();
});

app.on('activate', () => {
  if (databaseRepairRequested || startupFailure) createRecoveryWindow();
  else if (runtime) {
    focusMainApplicationWindow();
    refreshDesktopActivityState('application-activated', { immediate: true });
  }
  else createMainWindow().catch(handleStartupFailure);
});

app.on('child-process-gone', (_event, details = {}) => {
  recordDesktopDiagnostic('child-process-gone', details, details.reason === 'clean-exit' ? 'info' : 'error');
});

app.on('before-quit', (event) => {
  if (desktopShutdownReady) return;
  event.preventDefault();
  if (desktopShutdownPromise) return;
  desktopTrayController?.markQuitting('before-quit');
  recordDesktopDiagnostic('desktop-before-quit');
  maintenanceLoop?.stop();
  cloudSyncLoop?.stop();
  modelCatalogLoop?.stop();
  socialRelayLoop?.stop();
  presenceHeartbeatLoop?.stop();
  taskRecoveryLoop?.stop();
  feishuChannelService?.stop();
  taskUiUpdatePublisher?.close();
  taskUiUpdatePublisher = null;
  const pendingShutdown = [];
  try { const pendingMobileGatewayClose = mobileGateway?.stop(); if (pendingMobileGatewayClose?.then) pendingShutdown.push(pendingMobileGatewayClose); } catch (error) { mainLogger.warn('mobile-gateway-close-failed', { error }); }
  closeStartupWindow({ minimumVisibleMs: 0 });
  try {
    const pendingRuntimeClose = runtime?.close();
    if (pendingRuntimeClose?.then) pendingShutdown.push(pendingRuntimeClose);
  } catch (error) {
    mainLogger.warn('desktop-runtime-close-failed', { error });
  }
  try {
    const pendingRelayClose = codexProviderRelay?.close();
    if (pendingRelayClose?.then) pendingShutdown.push(pendingRelayClose);
  } catch (error) {
    mainLogger.warn('desktop-provider-relay-close-failed', { error });
  }
  desktopShutdownPromise = waitForDesktopShutdown(pendingShutdown).finally(async () => {
    try {
      terminateActiveCodexProcesses();
      terminateFileChangeSnapshotWorkers();
      desktopTrayController?.dispose();
      await flushApplicationLogs().catch(() => {});
    } catch (error) {
      mainLogger.warn('desktop-final-shutdown-cleanup-failed', { error });
    } finally {
      desktopShutdownReady = true;
      app.quit();
    }
  });
});

function waitForDesktopShutdown(pending = [], timeoutMs = 5_000) {
  let timeout = null;
  const deadline = new Promise((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), Math.max(0, Number(timeoutMs || 0)));
  });
  return Promise.race([Promise.allSettled(pending), deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function refreshModelCatalog(reason = 'scheduled') {
  if (!runtime) return {};
  await refreshCodexSystemProxy();
  const catalog = await runtime.refreshModelCatalog();
  runtime.store.settingSet('models:last_refresh_reason', reason);
  runtime.store.settingSet('models:last_refresh_at', catalog.updatedAt || new Date().toISOString());
  runtime.store.settingSet('models:last_refresh_error', catalog.error || '');
  sendWebContentsSafely(mainWindow, 'models:updated', catalog);
  mainLogger.info('model-catalog-refreshed', { data: { reason, modelCount: catalog.models?.length || 0, hasError: Boolean(catalog.error) } });
  return catalog;
}

function startTaskRecoveryLoop() {
  taskRecoveryLoop?.stop();
  const enabled = !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_TASK_RECOVERY_ENABLED || '1').toLowerCase());
  if (!enabled) return;
  const intervalMs = Math.max(1_000, Number(process.env.JANUS_TASK_RECOVERY_INTERVAL_MS || 5_000));
  const configuredMaxRunningMs = Number(process.env.JANUS_TASK_NODE_TIMEOUT_MS);
  const maxRunningMs = Number.isFinite(configuredMaxRunningMs) && configuredMaxRunningMs > 0
    ? Math.max(5_000, configuredMaxRunningMs)
    : null;
  const sweep = async () => {
    if (!runtime?.scheduler?.recoverActiveTasks) return;
    const result = await runtime.scheduler.recoverActiveTasks({ maxRunningMs });
    runtime.store.settingSet('task_recovery:last_sweep_at', new Date().toISOString());
    runtime.store.settingSet('task_recovery:last_sweep_error', '');
    mainLogger.debug('task-recovery-sweep-complete', { data: { recoveredCount: result?.recovered?.length || 0, skipped: Boolean(result?.skipped) } });
    refreshDesktopActivityState('task-recovery-sweep');
    return result;
  };
  taskRecoveryLoop = createAdaptiveDesktopLoop({
    name: 'task-recovery-sweep',
    run: sweep,
    delay: () => desktopLoopDelay('task_recovery', { state: desktopActivityState, configuredMs: intervalMs }),
    onError(error) {
      runtime?.store.settingSet('task_recovery:last_sweep_error', String(error?.message || error));
      mainLogger.error('task-recovery-sweep-failed', { error });
    },
  });
  taskRecoveryLoop.start({ immediate: true });
}

async function refreshCodexSystemProxy() {
  if (!runtime || !electronSession?.defaultSession) return {};
  const baseUrl = String(codexConfigStatus(runtime.root)?.baseUrl || '').trim() || 'https://api.openai.com/';
  try {
    const proxyRules = await electronSession.defaultSession.resolveProxy(baseUrl);
    return configureCodexSystemProxy(proxyRules);
  } catch {
    return configureCodexSystemProxy('DIRECT');
  }
}

function installWindowRecovery(window) {
  let recoveryScheduled = false;
  let stableRendererTimer = null;
  const recoveryTimestamps = [];
  const recoveryWindowMs = 60_000;
  const stableRendererMs = 30_000;
  const maxRecoveriesPerWindow = 2;
  const recoverRenderer = (reason) => {
    if (recoveryScheduled || window.isDestroyed()) return;
    const now = Date.now();
    while (recoveryTimestamps.length && now - recoveryTimestamps[0] > recoveryWindowMs) recoveryTimestamps.shift();
    if (recoveryTimestamps.length >= maxRecoveriesPerWindow) {
      recordRendererDiagnostic('recovery-stopped', { reason, recoveryTimestamps });
      return;
    }
    recoveryScheduled = true;
    recoveryTimestamps.push(now);
    recordRendererDiagnostic('recovery-requested', { reason, recoveryTimestamps });
    setTimeout(() => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.reload();
      recoveryScheduled = false;
    }, 250);
  };
  window.webContents.on('did-finish-load', () => {
    if (stableRendererTimer) clearTimeout(stableRendererTimer);
    stableRendererTimer = setTimeout(() => {
      recoveryTimestamps.length = 0;
      stableRendererTimer = null;
    }, stableRendererMs);
  });
  window.webContents.on('render-process-gone', (_event, details = {}) => {
    recordRendererDiagnostic('render-process-gone', details);
    if (details.reason !== 'clean-exit') recoverRenderer(`render-process-gone:${details.reason || 'unknown'}`);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    recordRendererDiagnostic('did-fail-load', { errorCode, errorDescription, isMainFrame });
    if (isMainFrame && errorCode !== -3) recoverRenderer(`did-fail-load:${errorCode}:${errorDescription || ''}`);
  });
  window.on('unresponsive', () => recordRendererDiagnostic('window-unresponsive'));
  window.on('closed', () => {
    if (stableRendererTimer) clearTimeout(stableRendererTimer);
  });
}

function recordRendererDiagnostic(event, details = {}) {
  recordDesktopDiagnostic(event, details, ['render-process-gone', 'did-fail-load', 'window-unresponsive', 'recovery-stopped'].includes(event) ? 'error' : 'warn');
}

function handleStartupFailure(error) {
  mainLogger.fatal('desktop-startup-failed', { error });
  if (startupWindow && !startupWindow.isDestroyed()) startupWindow.hide();
  startupFailure = error;
  if (isDatabaseFailure(error)) {
    try {
      createRecoveryWindow();
      closeStartupWindow({ minimumVisibleMs: 0 });
      return;
    }
    catch (recoveryError) { mainLogger.fatal('database-recovery-window-failed', { error: recoveryError }); }
  }
  try {
    const detail = String(error?.message || error || t('应用启动失败，请重试。', 'The application failed to start. Please try again.'));
    dialog.showErrorBox(t('Janus 启动失败', 'Janus Failed to Start'), uiLanguage === 'en' && /[\u3400-\u9fff]/.test(detail)
      ? 'The application failed to start. Review the diagnostic logs for details.'
      : detail);
  } catch {}
  app.quit();
}

function recoveryRuntimeRoot() {
  return resolveRuntimeRoot({ isDev: !app.isPackaged, userDataDir: app.getPath('userData') });
}

function isDatabaseFailure(error) {
  if (isDatabaseMaintenanceError(error)) return true;
  return /sqlite|database|no such column|unique constraint|message_session_agent_mismatch/i.test(String(error?.message || error || ''));
}

function runHeadlessDatabaseRepair() {
  try {
    const result = repairDatabase(recoveryRuntimeRoot(), { appVersion: app.getVersion() });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    const exitCode = result.status === 'not_needed' ? 2 : 0;
    process.exitCode = exitCode;
    app.exit(exitCode);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ code: error?.code || 'DB_REPAIR_FAILED', message: error?.message || String(error) })}\n`);
    const exitCodes = { DB_INTEGRITY_FAILED: 10, DB_BACKUP_FAILED: 11, DB_MIGRATION_FAILED: 12, DB_INVARIANT_FAILED: 13, DB_RESTORE_FAILED: 14, DB_DISK_SPACE: 15 };
    const exitCode = exitCodes[error?.code] || 12;
    process.exitCode = exitCode;
    app.exit(exitCode);
  }
}

function recordDesktopDiagnostic(event, data = {}, level = 'info', error = null) {
  const method = ['debug', 'info', 'warn', 'error', 'fatal'].includes(level) ? level : 'info';
  mainLogger[method](event, {
    message: event,
    data,
    error: error || undefined,
  });
}

function startModelCatalogRefresh() {
  modelCatalogLoop?.stop();
  refreshModelCatalog('startup').catch((error) => {
    runtime?.store.settingSet('models:last_refresh_error', String(error.message || error));
    mainLogger.error('model-catalog-refresh-failed', { data: { reason: 'startup' }, error });
  });
  const enabled = !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_MODEL_REFRESH_ENABLED || '1').toLowerCase());
  const hasConfiguredTime = process.env.JANUS_MODEL_REFRESH_HOUR !== undefined && process.env.JANUS_MODEL_REFRESH_MINUTE !== undefined;
  if (!enabled || !hasConfiguredTime) return;
  const hour = Number(process.env.JANUS_MODEL_REFRESH_HOUR);
  const minute = Number(process.env.JANUS_MODEL_REFRESH_MINUTE);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    runtime?.store.settingSet('models:last_refresh_error', 'Invalid JANUS_MODEL_REFRESH_HOUR or JANUS_MODEL_REFRESH_MINUTE.');
    return;
  }
  const nextScheduledAt = (from = new Date()) => {
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  };
  const scheduleTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (runtime.store.settingGet('models:schedule_time', '') !== scheduleTime) {
    runtime.store.settingSet('models:schedule_time', scheduleTime);
    runtime.store.settingSet('models:next_due_at', nextScheduledAt().toISOString());
  } else if (!runtime.store.settingGet('models:next_due_at', '')) {
    runtime.store.settingSet('models:next_due_at', nextScheduledAt().toISOString());
  }
  const check = async () => {
    const dueAt = Date.parse(runtime?.store.settingGet('models:next_due_at', '') || '');
    if (!Number.isFinite(dueAt) || Date.now() < dueAt) return;
    await refreshModelCatalog('daily');
    runtime.store.settingSet('models:next_due_at', nextScheduledAt().toISOString());
  };
  modelCatalogLoop = createAdaptiveDesktopLoop({
    name: 'model-catalog-refresh',
    run: check,
    delay: () => desktopLoopDelay('model_catalog', {
      state: desktopActivityState, onBattery: desktopOnBattery, configuredMs: 60_000,
    }),
    onError(error) {
      runtime?.store.settingSet('models:last_refresh_error', String(error.message || error));
      mainLogger.error('model-catalog-refresh-failed', { data: { reason: 'scheduled' }, error });
    },
  });
  modelCatalogLoop.start({ immediate: true });
}

function startMaintenanceLoop() {
  maintenanceLoop?.stop();
  const hour = Number(process.env.JANUS_EVOLVE_HOUR || 2);
  const minute = Number(process.env.JANUS_EVOLVE_MINUTE || 0);
  const retryDelayMs = Math.max(60_000, Number(process.env.JANUS_EVOLVE_RETRY_DELAY_MS || 15 * 60_000));
  const nextScheduledAt = (from = new Date()) => {
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  };
  if (!runtime.store.settingGet('maintenance:next_due_at', '')) {
    runtime.store.settingSet('maintenance:next_due_at', nextScheduledAt(new Date(Date.now() - 24 * 60 * 60 * 1000)).toISOString());
  }
  const check = async () => {
    if (!runtime) return;
    const now = new Date();
    const dueAt = Date.parse(runtime.store.settingGet('maintenance:retry_at', '') || runtime.store.settingGet('maintenance:next_due_at', ''));
    if (Number.isFinite(dueAt) && now.getTime() < dueAt) return;
    const result = await runtime.runMaintenanceSafely({ wait: true, system: true });
    mainLogger.info('maintenance-run-complete', { data: { status: result?.status || 'unknown' } });
    if (result.status === 'deferred') {
      const retryCount = Number(runtime.store.settingGet('maintenance:retry_count', '0') || 0) + 1;
      runtime.store.settingSet('maintenance:retry_count', String(retryCount));
      runtime.store.settingSet('maintenance:retry_at', new Date(now.getTime() + retryDelayMs).toISOString());
    } else {
      runtime.store.settingSet('maintenance:retry_count', '0');
      runtime.store.settingSet('maintenance:retry_at', '');
      runtime.store.settingSet('maintenance:next_due_at', nextScheduledAt(now).toISOString());
    }
  };
  maintenanceLoop = createAdaptiveDesktopLoop({
    name: 'maintenance-run',
    run: check,
    delay: () => desktopLoopDelay('maintenance', {
      state: desktopActivityState, onBattery: desktopOnBattery, configuredMs: 60_000,
    }),
    onError(error) {
      runtime?.store.settingSet('maintenance:last_error', String(error.message || error));
      mainLogger.error('maintenance-run-failed', { error });
    },
  });
  maintenanceLoop.start({ immediate: true });
}

function startCloudSyncLoop() {
  cloudSyncLoop?.stop();
  const recoverEmployeeLifecycle = async () => {
    if (!runtime?.cloudSync?.drainEmployeeCommandOutbox) return;
    const status = runtime.cloudSync.status?.() || {};
    if (!status.configured || Number(status.pendingEmployeeCommandCount || 0) < 1) return;
    const result = await runtime.cloudSync.drainEmployeeCommandOutbox();
    if (result?.status !== 'completed') {
      runtime.store.settingSet('cloud_sync:last_employee_recovery_status', JSON.stringify({
        status: result?.status || 'unknown',
        processed: Number(result?.processed || 0),
        remaining: Number(result?.remaining || 0),
      }));
    } else {
      runtime.store.settingSet('cloud_sync:last_employee_recovery_status', '');
    }
  };
  const enabled = !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_CLOUD_AUTO_SYNC_ENABLED || '1').toLowerCase());
  if (!enabled) {
    recoverEmployeeLifecycle().catch((error) => {
      runtime?.store.settingSet('cloud_sync:last_startup_error', String(error.message || error));
    });
    return;
  }
  const intervalMs = Math.max(60_000, Number(process.env.JANUS_CLOUD_SYNC_INTERVAL_MS || 15 * 60_000));
  const sync = async (reason) => {
    if (!runtime) return;
    const result = await runtime.triggerAutoSync(reason, { delayMs: 0 });
    mainLogger.info('cloud-sync-complete', { data: { reason, status: result?.status || 'unknown' } });
    if (result?.status === 'failed') {
      runtime.store.settingSet('cloud_sync:last_timer_error', String(result.error || 'sync failed'));
    }
  };
  cloudSyncLoop = createAdaptiveDesktopLoop({
    name: 'cloud-sync',
    run: () => sync('timer'),
    delay: () => desktopLoopDelay('cloud_sync', {
      state: desktopActivityState, onBattery: desktopOnBattery, configuredMs: intervalMs,
    }),
    onError(error) {
      runtime?.store.settingSet('cloud_sync:last_timer_error', String(error.message || error));
      mainLogger.error('cloud-sync-failed', { data: { reason: 'timer' }, error });
    },
  });
  cloudSyncLoop.start({ immediate: false });
  recoverEmployeeLifecycle().then(() => sync('startup')).catch((error) => {
    runtime?.store.settingSet('cloud_sync:last_startup_error', String(error.message || error));
    mainLogger.error('cloud-sync-failed', { data: { reason: 'startup' }, error });
  });
}

function startSocialRelayLoop() {
  socialRelayLoop?.stop();
  presenceHeartbeatLoop?.stop();
  runtime?.stopSocialRealtime?.();
  const idleIntervalMs = Math.max(60_000, Number(process.env.JANUS_SOCIAL_POLL_INTERVAL_MS || 5 * 60_000));
  const activeIntervalMs = Math.max(30_000, Number(process.env.JANUS_SOCIAL_ACTIVE_POLL_INTERVAL_MS || 60_000));
  const poll = async () => {
    if (!runtime) return;
    if (!runtime.currentUser?.()) return { skipped: true, reason: 'authentication_required' };
    let result;
    try {
      result = await runtime.pollSocialNetwork({
        autoProcess: true,
        onProjection(projection) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendWebContentsSafely(mainWindow, 'social:updated', projection);
          }
        },
      });
    } catch (error) {
      result = { skipped: true, reason: 'social_poll_failed', error: String(error?.message || error) };
      mainLogger.warn('social-poll-failed', { error });
    }
    const workMemoryPublications = await runtime.flushWorkMemoryPublications?.({ limit: 20 });
    const updateResult = workMemoryPublications ? { ...(result || {}), workMemoryPublications } : result;
    if (!result?.skipped) {
      if (mainWindow && !mainWindow.isDestroyed()) sendWebContentsSafely(mainWindow, 'social:updated', updateResult);
      const currentUserId = runtime.currentUser()?.id || '';
      for (const message of (result?.historyCatchUp ? [] : result?.incomingMessages || [])) {
        if (!directSocialMessageForNotification(message)) continue;
        const peerId = String(message.senderUserId || message.sender_user_id || '').trim();
        if (!peerId || peerId === currentUserId) continue;
        const persistentKey = `social:${currentUserId}:${String(message.id || '')}`;
        if (persistentNotificationSeen(persistentKey)) continue;
        const content = socialMessageNotificationContent(message, uiLanguage);
        const shown = await routeDesktopNotification({
          id: String(message.id || ''),
          target: { channel: 'system:open-conversation', payload: { peerId } },
          bucket: notifiedSocialMessages,
          key: String(message.id || ''),
          ...content,
          onClick: () => sendSystemNotificationNavigation('system:open-conversation', { peerId }),
        });
        if (shown) rememberPersistentNotification(persistentKey);
      }
      for (const task of (result?.delegationHistoryCatchUp ? [] : result?.collaboration?.tasks || [])) {
        if ((task.recipientUserId || task.recipient_user_id) !== currentUserId) continue;
        if (!['assigned', 'preparing', 'draft_ready', 'revision_requested', 'blocked'].includes(String(task.status || ''))) continue;
        if (!notificationItemIsFresh(task)) continue;
        const notificationKey = `${task.id}:${task.status}`;
        const persistentKey = `collaboration:${currentUserId}:${notificationKey}`;
        if (persistentNotificationSeen(persistentKey)) continue;
        const content = collaborationTaskNotificationContent(task, uiLanguage);
        const shown = await routeDesktopNotification({
          id: notificationKey,
          target: task.metadata?.ownerSecretarySessionId
            ? { channel: 'system:open-agent-session', payload: { sessionId: task.metadata.ownerSecretarySessionId } }
            : { channel: 'social:open-task', payload: { delegationId: task.id } },
          bucket: notifiedCollaborationTasks,
          key: notificationKey,
          ...content,
          onClick: () => task.metadata?.ownerSecretarySessionId
            ? sendSystemNotificationNavigation('system:open-agent-session', { sessionId: task.metadata.ownerSecretarySessionId })
            : sendSystemNotificationNavigation('social:open-task', { delegationId: task.id }),
        });
        if (shown) rememberPersistentNotification(persistentKey);
      }
    }
    if (updateResult?.historyCatchUp || updateResult?.delegationHistoryCatchUp) {
      // Do not immediately enter the high-frequency active poll cadence while
      // a freshly seeded profile is still replaying historical messages.
      socialIdleRounds = Math.min(3, socialIdleRounds + 1);
    } else if (desktopActivityState === DESKTOP_ACTIVITY_STATE.BACKGROUND_IDLE) {
      socialIdleRounds = socialPollHadActivity(updateResult) ? 0 : Math.min(3, socialIdleRounds + 1);
    } else {
      socialIdleRounds = 0;
    }
    socialHasActiveWork = (result?.collaboration?.tasks || []).some((task) => ![
      'result_accepted', 'completed', 'closed', 'withdrawn', 'declined', 'rejected', 'failed',
    ].includes(String(task.status || '')));
    refreshDesktopActivityState('social-poll');
    return updateResult;
  };
  socialRelayLoop = createAdaptiveDesktopLoop({
    name: 'social-poll',
    run: poll,
    delay: () => desktopLoopDelay('social', {
      state: desktopActivityState,
      idleRounds: socialIdleRounds,
      foregroundIdleMs: hasRuntimeBackgroundWork() ? activeIntervalMs : idleIntervalMs,
      foregroundActiveMs: activeIntervalMs,
    }),
  });
  socialRelayLoop.start({ immediate: true });
  presenceHeartbeatLoop = createAdaptiveDesktopLoop({
    name: 'presence-heartbeat',
    run: () => runtime?.socialPresenceHeartbeat?.(),
    delay: () => desktopActivityState === DESKTOP_ACTIVITY_STATE.SUSPENDED ? null : 15_000,
  });
  presenceHeartbeatLoop.start({ immediate: true });
  runtime?.startSocialRealtime?.({
    onEvent(event = {}) {
      runtime?.store?.settingSet?.('social:last_realtime_event', JSON.stringify({
        id: event.id || '', sequence: Number(event.sequence || 0), type: event.type || event.event || '',
        aggregateId: event.aggregateId || '', receivedAt: new Date().toISOString(),
      }));
      socialRelayLoop?.reschedule({ immediate: true });
      if (['voice_call.signal', 'voice_call.chat', 'voice_call.participant_left', 'voice_call.invite', 'voice_call.ended'].includes(String(event.type || '')))
        for (const window of BrowserWindow.getAllWindows()) if (window && !window.isDestroyed()) sendWebContentsSafely(window, 'voice-call:event', { type: event.type, ...(event.payload || {}) });
    },
    onStatus(status = {}) {
      runtime?.store?.settingSet?.('social:realtime_status', JSON.stringify({ ...status, updatedAt: new Date().toISOString() }));
    },
  }).catch((error) => {
    runtime?.store?.settingSet?.('social:realtime_error', String(error?.message || error));
  });
}
