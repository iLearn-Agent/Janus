import electronUpdater from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sendWebContentsSafely } from '../../src/shared/electronProcessSafety.js';
import { desktopReleaseRootUrl, STABLE_DESKTOP_RELEASE_CHANNEL, TEST_DESKTOP_RELEASE_CHANNEL } from '../../src/shared/desktopReleaseChannel.js';
import { getApplicationLogger } from '../../src/shared/logging/index.js';
import { desktopDeploymentConfig } from '../../src/main/desktopDeploymentConfig.js';
import { launchMacCustomInstaller, macAppBundleFromExecutable, verifyDesktopUpdatePackage } from './macosUpdateInstaller.js';

const SUPPORTED_DESKTOP_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
const updateLogger = getApplicationLogger('desktop-updates');

export function createUpdateService({
  app,
  windowProvider,
  isDev = false,
  updater = electronUpdater.autoUpdater,
  platform = process.platform,
  releaseChannel = STABLE_DESKTOP_RELEASE_CHANNEL,
  verifyPackage = verifyDesktopUpdatePackage,
  signingPublicKeyLoader = (file) => fs.readFileSync(file, 'utf8'),
  onStatusChanged = null,
} = {}) {
  const autoUpdater = updater;
  const deployment = desktopDeploymentConfig();
  const updateUrl = platformUpdateUrl(deployment.updateUrl || desktopReleaseRootUrl(releaseChannel), platform);
  const signingPublicKeyPath = deployment.signingPublicKeyPath || defaultSigningPublicKeyPath();
  const autoDownload = platform === 'linux'
    && !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_AUTO_DOWNLOAD_UPDATES || '1').toLowerCase());
  const platformReady = platformSupportsUpdates(platform);
  let pendingUpdate = null;
  let lastProgressSentAt = 0;
  const state = {
    enabled: Boolean(updateUrl)
      && platformReady
      && !isDev
      && deployment.updatesEnabled,
    autoDownload,
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    installing: false,
    downloadProgress: 0,
    version: '',
    releaseName: '',
    releaseDate: '',
    releaseNotes: '',
    installMode: '',
    updateUrl,
    lastCheckAt: '',
    lastError: '',
    message: isDev
      ? 'Updater is idle in development mode.'
      : platformReady
        ? 'Updater is ready.'
        : platform === 'linux'
          ? 'Linux application updates require the AppImage package.'
          : 'Updater is unavailable on this platform.',
  };

  const sendStatus = () => {
    const win = windowProvider?.();
    sendWebContentsSafely(win, 'updates:status', { ...state });
  };
  const setState = (patch) => {
    const previous = { ...state };
    Object.assign(state, patch);
    sendStatus();
    const current = { ...state };
    try { onStatusChanged?.({ current, previous, patch: { ...patch } }); } catch {}
    return current;
  };

  autoUpdater.autoDownload = autoDownload;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = releaseChannel === TEST_DESKTOP_RELEASE_CHANNEL;
  if (releaseChannel === TEST_DESKTOP_RELEASE_CHANNEL) autoUpdater.channel = 'latest';
  if (updateUrl) autoUpdater.setFeedURL({ provider: 'generic', url: updateUrl });

  const startInstall = async () => {
    if (!pendingUpdate?.verified) {
      return setState({ downloaded: false, installing: false, message: 'The downloaded update has not passed signature verification.' });
    }
    if (platform === 'darwin' && state.installMode === 'custom-macos') {
      if (!pendingUpdate.downloadedFile) {
        return setState({ downloaded: false, installing: false, message: 'The downloaded macOS update is unavailable.' });
      }
      try {
        setState({ downloading: false, downloaded: false, installing: true, lastError: '', message: 'Starting the macOS updater.' });
        await launchMacCustomInstaller({
          zipFile: pendingUpdate.downloadedFile,
          currentAppBundle: macAppBundleFromExecutable(app.getPath('exe')),
          appPid: process.pid,
        });
        updateLogger.info('update-install-started', { data: { platform, version: state.version, installMode: state.installMode } });
        setState({ message: 'Updater started. Janus will quit, replace the app, and restart.' });
        setTimeout(() => app.quit(), 250);
        return { ...state };
      } catch (error) {
        updateLogger.error('update-install-failed', { data: { platform, version: state.version, installMode: state.installMode }, error });
        return setState({ installing: false, lastError: String(error?.message || error), message: 'Unable to start the macOS updater.' });
      }
    }
    setState({ downloading: false, downloaded: false, installing: true, lastError: '', message: 'Installing update. Janus will restart.' });
    updateLogger.info('update-install-started', { data: { platform, version: state.version, installMode: state.installMode } });
    // Keep the Windows NSIS installer visible so upgrade progress and failures
    // remain observable after the Electron process exits. The installer include
    // handles the assisted-update restart when --force-run is present.
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 250);
    return { ...state };
  };

  autoUpdater.on('checking-for-update', () => {
    updateLogger.info('update-check-started', { data: { platform, releaseChannel } });
    setState({ checking: true, lastCheckAt: new Date().toISOString(), lastError: '', message: 'Checking for updates.' });
  });
  autoUpdater.on('update-available', (info = {}) => {
    updateLogger.info('update-available', { data: { platform, version: info.version || '', installMode: updateInstallMode(info, platform) } });
    pendingUpdate = { info, downloadedFile: '', verified: false };
    setState({
      checking: false,
      available: true,
      downloaded: false,
      installing: false,
      downloadProgress: 0,
      version: info.version || '',
      releaseName: String(info.releaseName || ''),
      releaseDate: String(info.releaseDate || ''),
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      installMode: updateInstallMode(info, platform),
      message: autoDownload
        ? `Update ${info.version || ''} is available and is downloading automatically.`.trim()
        : `Update ${info.version || ''} is available. Choose Download when you are ready.`.trim(),
    });
  });
  autoUpdater.on('update-not-available', () => {
    updateLogger.info('update-not-available', { data: { platform, releaseChannel } });
    pendingUpdate = null;
    setState({
      checking: false,
      available: false,
      downloading: false,
      downloaded: false,
      installing: false,
      downloadProgress: 0,
      version: '',
      releaseName: '',
      releaseDate: '',
      releaseNotes: '',
      installMode: '',
      lastError: '',
      message: 'No update is available.',
    });
  });
  autoUpdater.on('download-progress', (progress = {}) => {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
    const now = Date.now();
    Object.assign(state, {
      downloading: true,
      downloadProgress: percent,
      message: `Downloading update ${percent}%.`,
    });
    if (percent >= 100 || now - lastProgressSentAt >= 250) {
      lastProgressSentAt = now;
      sendStatus();
    }
  });
  autoUpdater.on('update-downloaded', (info = {}) => {
    const installMode = updateInstallMode(info, platform);
    const verifiesJanusSignature = SUPPORTED_DESKTOP_PLATFORMS.has(platform);
    pendingUpdate = { info, downloadedFile: info.downloadedFile || '', verified: !verifiesJanusSignature };
    if (!verifiesJanusSignature) {
      setState({
        checking: false,
        downloading: false,
        available: true,
        downloaded: true,
        installing: false,
        downloadProgress: 100,
        version: info.version || state.version,
        releaseName: String(info.releaseName || state.releaseName || ''),
        releaseDate: String(info.releaseDate || state.releaseDate || ''),
        releaseNotes: normalizeReleaseNotes(info.releaseNotes || state.releaseNotes),
        installMode,
        message: 'Update downloaded. Install it when you are ready to restart.',
      });
      return;
    }
    setState({ downloading: true, downloaded: false, installing: false, installMode, message: 'Verifying the signed desktop update package.' });
    Promise.resolve().then(() => verifyPackage({
      file: info.downloadedFile,
      updateInfo: info,
      publicKeyPem: signingPublicKeyLoader(signingPublicKeyPath),
      extension: updatePackageExtension(platform),
    })).then(() => {
      if (pendingUpdate?.downloadedFile !== info.downloadedFile) return;
      pendingUpdate.verified = true;
      updateLogger.info('update-package-verified', { data: { platform, version: info.version || state.version, installMode } });
      setState({
        checking: false,
        downloading: false,
        available: true,
        downloaded: true,
        installing: false,
        downloadProgress: 100,
        version: info.version || state.version,
        releaseName: String(info.releaseName || state.releaseName || ''),
        releaseDate: String(info.releaseDate || state.releaseDate || ''),
        releaseNotes: normalizeReleaseNotes(info.releaseNotes || state.releaseNotes),
        message: 'Signed update verified. Install it when you are ready to restart.',
      });
    }).catch((error) => {
      pendingUpdate = null;
      updateLogger.error('update-package-verification-failed', { data: { platform, version: info.version || state.version, installMode }, error });
      setState({
        checking: false,
        downloading: false,
        downloaded: false,
        installing: false,
        downloadProgress: 0,
        lastError: String(error?.message || error),
        message: 'Desktop update package signature verification failed.',
      });
    });
  });
  autoUpdater.on('error', (error) => {
    pendingUpdate = null;
    updateLogger.error('update-error', { data: { platform, releaseChannel }, error });
    setState({
      checking: false,
      available: false,
      downloading: false,
      downloaded: false,
      installing: false,
      downloadProgress: 0,
      installMode: '',
      lastError: String(error?.message || error),
      message: 'Update check failed.',
    });
  });

  return {
    status() {
      return { ...state };
    },
    async checkNow() {
      if (!state.enabled) {
        return setState({ message: isDev ? 'Updater is disabled in development mode.' : 'Updater is disabled.' });
      }
      if (state.checking) return { ...state };
      await autoUpdater.checkForUpdates();
      return { ...state };
    },
    async downloadNow() {
      if (!state.enabled) {
        return setState({ message: isDev ? 'Updater is disabled in development mode.' : 'Updater is disabled.' });
      }
      if (!state.available) return setState({ message: 'No update is available to download.' });
      if (state.downloaded) return { ...state };
      if (state.downloading || state.installing) return { ...state };
      lastProgressSentAt = 0;
      setState({ downloading: true, downloadProgress: 0, lastError: '', message: 'Downloading update.' });
      await autoUpdater.downloadUpdate();
      return { ...state };
    },
    async installNow() {
      return startInstall();
    },
    scheduleInitialCheck() {
      if (!state.enabled) return Promise.resolve({ ...state });
      return app.whenReady().then(() => this.checkNow()).catch((error) => {
        updateLogger.error('initial-update-check-failed', { data: { platform, releaseChannel }, error });
        return setState({
          checking: false,
          lastError: String(error?.message || error),
          message: 'Update check failed.',
        });
      });
    },
  };
}

function updateInstallMode(info = {}, platform = process.platform) {
  return platform === 'darwin' && info.janusInstallMode === 'custom-macos' ? 'custom-macos' : 'standard';
}

function platformUpdateUrl(baseUrl = '', platform = process.platform) {
  const normalized = String(baseUrl || '').replace(/\/+$/g, '');
  if (!normalized) return '';
  if (platform === 'darwin' && !normalized.endsWith('/macos')) return `${normalized}/macos`;
  if (platform === 'win32' && !normalized.endsWith('/windows')) return `${normalized}/windows`;
  if (platform === 'linux' && !normalized.endsWith('/linux')) return `${normalized}/linux`;
  return normalized;
}

function platformSupportsUpdates(platform = process.platform) {
  if (!SUPPORTED_DESKTOP_PLATFORMS.has(platform)) return false;
  return platform !== 'linux' || Boolean(process.env.APPIMAGE);
}

function updatePackageExtension(platform = process.platform) {
  if (platform === 'darwin') return '.zip';
  if (platform === 'linux') return '.AppImage';
  return '.exe';
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : String(item?.note || item?.notes || '')).filter(Boolean);
  return String(value || '');
}

function defaultSigningPublicKeyPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, '../..');
  const unpackedRoot = projectRoot.endsWith(`${path.sep}app.asar`) ? `${projectRoot}.unpacked` : projectRoot;
  return path.join(unpackedRoot, 'assets', 'release-signing-public.pem');
}
