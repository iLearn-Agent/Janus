import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { createUpdateService } from '../network/clients/updateService.js';

const previousAppImage = process.env.APPIMAGE;
const previousUpdatesEnabled = process.env.JANUS_UPDATES_ENABLED;
const previousUpdateUrl = process.env.JANUS_UPDATE_URL;
process.env.APPIMAGE = process.env.APPIMAGE || '/tmp/Janus-startup-update-smoke.AppImage';
delete process.env.JANUS_UPDATES_ENABLED;
process.env.JANUS_UPDATE_URL = 'http://updates.example.test/janus/releases';

try {
  const updater = new EventEmitter();
  let checkCount = 0;
  updater.setFeedURL = () => {};
  updater.checkForUpdates = async () => {
    checkCount += 1;
    updater.emit('checking-for-update');
    updater.emit('update-not-available');
    return null;
  };
  updater.downloadUpdate = async () => null;
  updater.quitAndInstall = () => {};

  const service = createUpdateService({
    app: { whenReady: async () => {}, getPath: () => '', quit: () => {} },
    windowProvider: () => null,
    isDev: false,
    updater,
  });

  assert.equal(service.status().enabled, true);
  await service.scheduleInitialCheck();
  assert.equal(checkCount, 1, 'application startup must immediately check for updates once');
  assert.ok(service.status().lastCheckAt, 'startup update check must record its check time');
  assert.equal(service.status().checking, false);
  updater.emit('update-available', { version: '9.9.9' });
  assert.equal(service.status().available, true);
  assert.equal(service.status().version, '9.9.9');
  updater.emit('update-not-available');
  assert.equal(service.status().available, false, 'a no-update result must clear stale availability');
  assert.equal(service.status().downloaded, false, 'a no-update result must clear stale download state');
  assert.equal(service.status().version, '', 'a no-update result must not keep advertising an old package version');

  const windowsUpdater = new EventEmitter();
  const installCalls = [];
  const beforeInstallCalls = [];
  let windowsFeed = null;
  windowsUpdater.setFeedURL = (feed) => { windowsFeed = feed; };
  windowsUpdater.checkForUpdates = async () => null;
  windowsUpdater.downloadUpdate = async () => null;
  windowsUpdater.quitAndInstall = (...args) => installCalls.push(args);
  const windowsService = createUpdateService({
    app: { whenReady: async () => {}, getPath: () => 'C:\\Program Files\\Janus\\Janus.exe', quit: () => {} },
    windowProvider: () => null,
    isDev: false,
    updater: windowsUpdater,
    platform: 'win32',
    verifyPackage: async () => ({ valid: true }),
    signingPublicKeyLoader: () => 'test-public-key',
    onBeforeInstall: () => beforeInstallCalls.push('windows'),
  });
  assert.deepEqual(windowsFeed, {
    provider: 'generic',
    url: 'http://updates.example.test/janus/releases/windows',
  }, 'Windows must append its platform route even when JANUS_UPDATE_URL is the shared release root');
  windowsUpdater.emit('update-available', { version: '9.9.9' });
  windowsUpdater.emit('update-downloaded', { version: '9.9.9', downloadedFile: 'Janus Setup 9.9.9.exe' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(installCalls, [], 'downloading an update must not close the application before the user confirms installation');
  assert.equal(windowsService.status().installing, false);
  assert.equal(windowsService.status().downloaded, true);
  await windowsService.installNow();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(installCalls, [[false, true]], 'a separately confirmed Windows install must show progress and restart into the verified update');
  assert.deepEqual(beforeInstallCalls, ['windows'], 'update installation must release close interception before quitAndInstall');
  assert.equal(windowsService.status().installing, true);
  assert.equal(windowsService.status().downloaded, false);

  delete process.env.JANUS_UPDATE_URL;
  const testUpdater = new EventEmitter();
  let testFeed = null;
  testUpdater.setFeedURL = (feed) => { testFeed = feed; };
  testUpdater.checkForUpdates = async () => null;
  testUpdater.downloadUpdate = async () => null;
  testUpdater.quitAndInstall = () => {};
  createUpdateService({
    app: { whenReady: async () => {}, getPath: () => 'C:\\Program Files\\Janus Test\\Janus Test.exe', quit: () => {} },
    windowProvider: () => null,
    isDev: false,
    updater: testUpdater,
    platform: 'win32',
    releaseChannel: 'test',
  });
  assert.deepEqual(testFeed, {
    provider: 'generic',
    url: 'http://your-janus.example/janus/test_releases/windows',
  }, 'Janus Test must use the isolated test release feed');
  assert.equal(testUpdater.allowPrerelease, true, 'Janus Test must accept prerelease updates');
  assert.equal(testUpdater.channel, 'latest', 'Janus Test must use the latest manifest inside its isolated release root');
  console.log('startup update check smoke passed');
} finally {
  if (previousAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = previousAppImage;
  if (previousUpdatesEnabled === undefined) delete process.env.JANUS_UPDATES_ENABLED;
  else process.env.JANUS_UPDATES_ENABLED = previousUpdatesEnabled;
  if (previousUpdateUrl === undefined) delete process.env.JANUS_UPDATE_URL;
  else process.env.JANUS_UPDATE_URL = previousUpdateUrl;
}
