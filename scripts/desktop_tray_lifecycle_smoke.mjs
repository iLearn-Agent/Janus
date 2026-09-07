import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY,
  DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY,
  createDesktopTrayController,
  defaultDesktopCloseBehavior,
  normalizeDesktopCloseBehavior,
} from '../src/main/desktopTrayController.js';

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.hidden = 0;
  }

  isDestroyed() { return this.destroyed; }
  hide() { this.hidden += 1; }
  closeEvent() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.emit('close', event);
    return event;
  }
  finishClose() {
    this.destroyed = true;
    this.emit('closed');
  }
}

const settleClosePrompt = () => new Promise((resolve) => setImmediate(resolve));

class FakeTray extends EventEmitter {
  static instances = [];
  constructor(image) {
    super();
    this.image = image;
    this.destroyed = false;
    FakeTray.instances.push(this);
  }
  setContextMenu(menu) { this.menu = menu; }
  setToolTip(value) { this.tooltip = value; }
  destroy() { this.destroyed = true; }
}

const Menu = { buildFromTemplate: (template) => template };
const settings = new Map();
const appCalls = [];
const focusCalls = [];
const hiddenCalls = [];
let trayLanguage = 'zh-CN';
const controller = createDesktopTrayController({
  app: { quit: () => appCalls.push('quit') },
  Tray: FakeTray,
  Menu,
  platform: 'win32',
  appName: 'Janus Test',
  createTrayImage: () => 'tray-image',
  getSetting: (key, fallback) => settings.get(key) ?? fallback,
  setSetting: (key, value) => settings.set(key, value),
  focusApplication: () => focusCalls.push('focus'),
  translate: (zh, en) => trayLanguage === 'en' ? en : zh,
  onWindowHidden: (window) => hiddenCalls.push(window),
});

assert.equal(defaultDesktopCloseBehavior('win32'), 'quit');
assert.equal(defaultDesktopCloseBehavior('linux'), 'quit');
assert.equal(defaultDesktopCloseBehavior('darwin'), 'background');
assert.equal(normalizeDesktopCloseBehavior('invalid', 'win32'), 'quit');
assert.equal(normalizeDesktopCloseBehavior('invalid', 'linux'), 'quit');
assert.equal(normalizeDesktopCloseBehavior('invalid', 'darwin'), 'background');
assert.equal(controller.status().closeBehavior, 'quit');
assert.equal(controller.status().trayActive, false);

const first = controller.registerWindow(new FakeWindow());
assert.equal(first.closeEvent().prevented, false, 'Windows must preserve close-to-quit until background mode is selected');

const backgroundStatus = controller.setCloseBehavior('background');
assert.equal(settings.get(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY), 'background');
assert.equal(backgroundStatus.trayActive, true);
assert.equal(FakeTray.instances.length, 1);
assert.equal(FakeTray.instances[0].tooltip, 'Janus Test');
assert.deepEqual(FakeTray.instances[0].menu.map((item) => item.label).filter(Boolean), ['打开 Janus Test', '退出 Janus Test']);
trayLanguage = 'en';
controller.refreshMenu();
assert.deepEqual(FakeTray.instances[0].menu.map((item) => item.label).filter(Boolean), ['Open Janus Test', 'Quit Janus Test']);

const second = controller.registerWindow(new FakeWindow());
assert.equal(first.closeEvent().prevented, false, 'closing one of multiple application windows must not hide the whole app');
first.finishClose();
const finalClose = second.closeEvent();
assert.equal(finalClose.prevented, true, 'closing the final application window must be intercepted in background mode');
assert.equal(second.hidden, 1);
assert.deepEqual(hiddenCalls, [second]);
assert.equal(controller.firstApplicationWindow(), second);

FakeTray.instances[0].emit('click');
assert.deepEqual(focusCalls, ['focus']);
FakeTray.instances[0].menu[0].click();
assert.deepEqual(focusCalls, ['focus', 'focus']);
FakeTray.instances[0].menu.at(-1).click();
assert.deepEqual(appCalls, ['quit']);
assert.equal(controller.isQuitting(), true);
assert.equal(controller.quitReason(), 'tray-menu');
assert.equal(second.closeEvent().prevented, false, 'explicit quit must bypass close interception');

const priorTray = FakeTray.instances[0];
controller.setCloseBehavior('quit');
assert.equal(priorTray.destroyed, true);
assert.equal(controller.status().trayActive, false);
assert.throws(() => controller.setCloseBehavior('minimize'), /Unsupported desktop close behavior/);

class FailingTray {
  constructor() { throw new Error('indicator unavailable'); }
}
const failedSettings = new Map([[DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, 'background']]);
const failedWindowsController = createDesktopTrayController({
  app: { quit() {} }, Tray: FailingTray, Menu, platform: 'linux',
  createTrayImage: () => 'tray-image',
  getSetting: (key, fallback) => failedSettings.get(key) ?? fallback,
});
const linuxWindow = failedWindowsController.registerWindow(new FakeWindow());
assert.equal(failedWindowsController.refresh().backgroundAvailable, false);
assert.equal(linuxWindow.closeEvent().prevented, false, 'Linux must fall back to normal close when Tray creation fails');

const failedSelectionSettings = new Map([[DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, 'quit']]);
const failedSelectionController = createDesktopTrayController({
  app: { quit() {} }, Tray: FailingTray, Menu, platform: 'win32',
  createTrayImage: () => 'tray-image',
  getSetting: (key, fallback) => failedSelectionSettings.get(key) ?? fallback,
  setSetting: (key, value) => failedSelectionSettings.set(key, value),
});
assert.throws(() => failedSelectionController.setCloseBehavior('background'), /indicator unavailable/);
assert.equal(failedSelectionSettings.get(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY), 'quit', 'a failed Tray selection must restore the previous Windows close behavior');

const promptSettings = new Map();
const promptDecisions = [
  { closeBehavior: 'cancel', remember: false },
  { closeBehavior: 'background', remember: false },
  { closeBehavior: 'quit', remember: true },
];
const promptAppCalls = [];
const promptController = createDesktopTrayController({
  app: { quit: () => promptAppCalls.push('quit') }, Tray: FakeTray, Menu, platform: 'win32',
  createTrayImage: () => 'prompt-tray-image',
  getSetting: (key, fallback) => promptSettings.get(key) ?? fallback,
  setSetting: (key, value) => promptSettings.set(key, value),
  promptCloseBehavior: async () => promptDecisions.shift(),
});
const promptWindow = promptController.registerWindow(new FakeWindow());
assert.equal(promptWindow.closeEvent().prevented, true, 'the first final-window close must open the close behavior prompt');
await settleClosePrompt();
assert.equal(promptWindow.hidden, 0, 'cancel must keep the window open');
assert.equal(promptSettings.has(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY), false);
assert.equal(promptWindow.closeEvent().prevented, true);
await settleClosePrompt();
assert.equal(promptWindow.hidden, 1, 'an unremembered background choice applies to this close only');
assert.equal(promptSettings.has(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY), false, 'an unremembered choice must not overwrite Preferences');
assert.equal(promptSettings.has(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY), false, 'an unremembered choice must be asked again');
assert.equal(promptWindow.closeEvent().prevented, true);
await settleClosePrompt();
assert.equal(promptSettings.get(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY), 'quit');
assert.equal(promptSettings.get(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY), '1');
assert.deepEqual(promptAppCalls, ['quit']);

const configuredSettings = new Map();
let configuredPromptCount = 0;
const configuredController = createDesktopTrayController({
  app: { quit() {} }, Tray: FakeTray, Menu, platform: 'win32', createTrayImage: () => 'configured-tray-image',
  getSetting: (key, fallback) => configuredSettings.get(key) ?? fallback,
  setSetting: (key, value) => configuredSettings.set(key, value),
  promptCloseBehavior: async () => { configuredPromptCount += 1; return { closeBehavior: 'quit', remember: false }; },
});
configuredController.setCloseBehavior('background');
assert.equal(configuredSettings.get(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY), '1', 'an explicit Preferences choice must suppress the first-close prompt');
const configuredWindow = configuredController.registerWindow(new FakeWindow());
assert.equal(configuredWindow.closeEvent().prevented, true);
assert.equal(configuredWindow.hidden, 1);
assert.equal(configuredPromptCount, 0);
configuredController.dispose();

const macController = createDesktopTrayController({
  app: { quit() {} }, Tray: FailingTray, Menu, platform: 'darwin',
  createTrayImage: () => 'tray-image',
});
const macWindow = macController.registerWindow(new FakeWindow());
assert.equal(macController.refresh().closeBehavior, 'background');
assert.equal(macWindow.closeEvent().prevented, true, 'macOS Dock must remain a recovery path when the menu-bar Tray is unavailable');

for (const platform of ['win32', 'darwin', 'linux']) {
  const platformSettings = new Map([[DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, 'background']]);
  const platformController = createDesktopTrayController({
    app: { quit() {} }, Tray: FakeTray, Menu, platform, appName: 'Janus',
    createTrayImage: () => `${platform}-tray-image`,
    getSetting: (key, fallback) => platformSettings.get(key) ?? fallback,
    setSetting: (key, value) => platformSettings.set(key, value),
    translate: (_zh, en) => en,
  });
  const status = platformController.refresh();
  assert.equal(status.backgroundAvailable, true, `${platform} background mode must be available with a working Tray`);
  assert.equal(status.trayActive, true, `${platform} must create its Tray indicator`);
  const platformTray = FakeTray.instances.at(-1);
  assert.deepEqual(platformTray.menu.map((item) => item.label).filter(Boolean), ['Open Janus', 'Quit Janus'], `${platform} Tray menu must use English labels`);
  const platformWindow = platformController.registerWindow(new FakeWindow());
  assert.equal(platformWindow.closeEvent().prevented, true, `${platform} must hide its final window in background mode`);
  assert.equal(platformWindow.hidden, 1, `${platform} must keep the final window available for restoration`);
  platformController.dispose();
}

console.log('desktop tray lifecycle smoke passed');
