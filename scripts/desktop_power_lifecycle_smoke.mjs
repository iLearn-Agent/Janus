import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDesktopMenuController } from '../src/renderer/app/features/shell/desktopMenuController.js';

const mainSource = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const runtimeSource = readFileSync(new URL('../src/main/runtime.js', import.meta.url), 'utf8');
const overlaysSource = readFileSync(new URL('../src/renderer/app/components/overlays.js', import.meta.url), 'utf8');
const menuControllerSource = readFileSync(new URL('../src/renderer/app/features/shell/desktopMenuController.js', import.meta.url), 'utf8');
const chatStyles = readFileSync(new URL('../src/renderer/styles/chat.css', import.meta.url), 'utf8');

assert.match(mainSource, /powerMonitor/);
for (const eventName of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-battery', 'on-ac']) {
  assert.match(mainSource, new RegExp(`powerMonitor\\.on\\('${eventName}'`));
}
assert.match(mainSource, /deriveDesktopActivityState/);
assert.match(mainSource, /createAdaptiveDesktopLoop/);
assert.match(mainSource, /desktopLoopDelay\('social'/);
assert.match(mainSource, /taskUpdateRequiresImmediateSocialPoll\(payload\)/);
assert.match(mainSource, /socialRelayLoop\?\.reschedule\(\{ immediate: true \}\)/);
assert.match(mainSource, /pollSocialNetwork\(\{\s*autoProcess: true,\s*onProjection\(projection\)/);
assert.match(mainSource, /sendWebContentsSafely\(mainWindow, 'social:updated', projection\)/);
assert.match(mainSource, /desktopLoopDelay\('task_recovery'/);
assert.match(mainSource, /'verifying'/);
assert.match(mainSource, /waitingNodeCount/);
assert.match(mainSource, /recordDesktopPowerTransition/);
assert.match(mainSource, /event\.preventDefault\(\);[\s\S]*runtime\?\.close\(\)[\s\S]*waitForDesktopShutdown\(pendingShutdown\)/);
assert.ok(mainSource.indexOf('runtime?.close()') < mainSource.indexOf('terminateActiveCodexProcesses();'),
  'shutdown must persist resumable Agent work before force-terminating remaining Codex children');
assert.match(mainSource, /shouldQuitWhenAllWindowsClosed\(process\.platform,\s*\{/);
assert.match(mainSource, /role: 'quit', accelerator: 'Command\+Q'/);
assert.match(mainSource, /role: 'close', accelerator: 'Command\+W'/);
assert.doesNotMatch(mainSource, /powerSaveBlocker\.start/);
assert.match(chatStyles, /\.composer:is\(\.is-ubuddy-mode, \.is-private-assistant-mode\) \.composer-controls \.model-trigger/);
assert.match(chatStyles, /width: 176px;[\s\S]*min-width: 176px;[\s\S]*max-width: 176px;/);

assert.match(runtimeSource, /setDesktopActivityState/);
assert.match(runtimeSource, /uBuddyRecoveryDelay/);
assert.doesNotMatch(runtimeSource, /setInterval\(scheduleUBuddyAllocationMatch,\s*5_000\)/);
assert.doesNotMatch(runtimeSource, /setInterval\(scheduleUBuddyPlanningDrain,\s*5_000\)/);

assert.match(overlaysSource, /desktopShortcutLabel/);
assert.match(overlaysSource, /action: 'close-window'/);
assert.match(menuControllerSource, /case 'close-window':/);
assert.doesNotMatch(menuControllerSource, /close-windowRef/);

const menuCalls = [];
const menuController = createDesktopMenuController({
  state: {},
  render() {},
  closeChatSearch() {},
  enterSettings() {},
  logoutAccount() {},
  windowRef: { janus: {
    closeWindow() { menuCalls.push('close'); },
    async appMenuCommand(command) { menuCalls.push(command); return true; },
  } },
  documentRef: {},
  historyRef: {},
  getComputedStyleFn() { return {}; },
  requestFrame(callback) { callback(); },
  editHistory: {},
  EventCtor: Event,
  startNewPlainChat() {},
  selectWorkspaceDirectory() {},
  saveRunLogVisible() {},
  openChatSearch() {},
  effectiveJanusVersion() { return ''; },
  pathBasename(value) { return value; },
  compareSessionsForDisplay() { return 0; },
  openSession() {},
  notify() {},
  openUpdateChangelog() {},
});
await menuController.handleDesktopMenuAction('close-window');
await menuController.handleDesktopMenuAction('exit');
assert.deepEqual(menuCalls, ['close', 'exit']);

console.log('desktop power lifecycle smoke passed');
