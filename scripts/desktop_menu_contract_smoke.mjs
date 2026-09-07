import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DESKTOP_MENU_SECTIONS, renderWindowTitlebar } from '../src/renderer/app/components/overlays.js';
import { createDesktopMenuController } from '../src/renderer/app/features/shell/desktopMenuController.js';
import { state } from '../src/renderer/app/state.js';
import { desktopShortcutActionForEvent, desktopShortcutLabel, desktopShortcutSpec } from '../src/renderer/app/platform/keyboardShortcuts.js';

const rendererHandlerSource = readFileSync(new URL('../src/renderer/app/features/shell/desktopMenuController.js', import.meta.url), 'utf8');
const mainHandlerSource = readFileSync(new URL('../src/main/ipc/registerIpcHandlers.js', import.meta.url), 'utf8');
const nativeMenuSource = readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8');
const rendererAppSource = readFileSync(new URL('../src/renderer/app/core/rendererApp.js', import.meta.url), 'utf8');

const topLevelItems = DESKTOP_MENU_SECTIONS.flatMap((section) => section.items.filter((item) => !item.separator));
const items = topLevelItems.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [item]);
const actions = items.map((item) => item.action);
assert.equal(new Set(actions).size, actions.length, 'desktop menu actions must be unique');

for (const item of items.filter((entry) => entry.shortcut)) {
  assert.ok(desktopShortcutSpec(item.action), `${item.action} shortcut needs a registry entry`);
  assert.equal(item.shortcut, desktopShortcutLabel(item.action, process.platform), `${item.action} label must come from the current platform shortcut registry`);
}
assert.equal(desktopShortcutActionForEvent({ key: 'n', code: 'KeyN', ctrlKey: true }, ['new-task'], 'linux'), 'new-task');
assert.equal(desktopShortcutActionForEvent({ key: 'n', code: 'KeyN', metaKey: true }, ['new-task'], 'darwin'), 'new-task');
assert.equal(desktopShortcutActionForEvent({ key: 'f', code: 'KeyF', ctrlKey: true, metaKey: true }, ['toggle-full-screen'], 'darwin'), 'toggle-full-screen');
assert.equal(desktopShortcutActionForEvent({ key: 'f', code: 'KeyF', ctrlKey: true }, ['toggle-full-screen'], 'linux'), '');
assert.equal(desktopShortcutActionForEvent({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }, ['redo'], 'darwin'), 'redo');
assert.equal(desktopShortcutActionForEvent({ key: 'y', code: 'KeyY', ctrlKey: true }, ['redo'], 'linux'), 'redo');
assert.equal(desktopShortcutActionForEvent({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }, ['keyboard-shortcuts'], 'linux'), 'keyboard-shortcuts');

let newTaskCount = 0;
let renderCount = 0;
const shortcutController = createDesktopMenuController({
  state,
  render: () => { renderCount += 1; },
  closeChatSearch: () => {},
  enterSettings: () => {},
  logoutAccount: async () => {},
  setLanguageMode: () => {},
  windowRef: { janus: { platform: 'linux', appMenuCommand: async () => true, closeWindow: () => {} } },
  documentRef: { querySelectorAll: () => [] },
  historyRef: {},
  getComputedStyleFn: () => ({ visibility: 'visible', getPropertyValue: () => '' }),
  requestFrame: (callback) => callback(),
  editHistory: { applyCommand: () => false, commandTarget: () => null },
  EventCtor: Event,
  startNewPlainChat: () => { newTaskCount += 1; },
  selectWorkspaceDirectory: async () => {},
  saveRunLogVisible: () => {},
  openChatSearch: () => {},
  effectiveJanusVersion: () => 'test',
  pathBasename: (value) => value,
  compareSessionsForDisplay: () => 0,
  openSession: async () => {},
  notify: () => {},
  openUpdateChangelog: () => {},
});
const shortcutEvent = (overrides = {}) => ({
  key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  defaultPrevented: false, repeat: false, isComposing: false, keyCode: 0, target: {},
  preventDefault() { this.defaultPrevented = true; },
  stopImmediatePropagation() { this.propagationStopped = true; },
  ...overrides,
});
const newTaskEvent = shortcutEvent({ key: 'n', code: 'KeyN', ctrlKey: true });
shortcutController.handleDesktopShortcut(newTaskEvent);
assert.equal(newTaskCount, 1, 'Ctrl+N must dispatch the existing new-task action');
assert.equal(newTaskEvent.defaultPrevented, true);
state.sidebarCollapsed = false;
const sidebarEvent = shortcutEvent({ key: 'b', code: 'KeyB', ctrlKey: true });
shortcutController.handleDesktopShortcut(sidebarEvent);
assert.equal(state.sidebarCollapsed, true, 'Ctrl+B must dispatch the existing sidebar action');
assert.ok(renderCount > 0);
const disabledEvent = shortcutEvent({ key: 'j', code: 'KeyJ', ctrlKey: true });
shortcutController.handleDesktopShortcut(disabledEvent);
assert.equal(disabledEvent.defaultPrevented, false, 'disabled menu shortcuts must remain unregistered');
const composingEvent = shortcutEvent({ key: 'n', code: 'KeyN', ctrlKey: true, isComposing: true });
shortcutController.handleDesktopShortcut(composingEvent);
assert.equal(newTaskCount, 1, 'IME composition must suppress global shortcuts');

for (const section of DESKTOP_MENU_SECTIONS) {
  assert.ok(section.label?.zh && section.label?.en, `${section.id} menu needs Chinese and English labels`);
  for (const item of section.items.filter((entry) => !entry.separator)) {
    assert.ok(item.label?.zh && item.label?.en, `${item.action} needs Chinese and English labels`);
    if (Array.isArray(item.submenu)) {
      for (const child of item.submenu) {
        assert.ok(child.label?.zh && child.label?.en, `${child.action} needs Chinese and English labels`);
      }
      continue;
    }
    if (item.disabled) continue;
    const actionCase = `case '${item.action}':`;
    assert.ok(rendererHandlerSource.includes(actionCase) || mainHandlerSource.includes(actionCase), `${item.action} has no handler`);
  }
}

assert.deepEqual(items.filter((item) => item.disabled).map((item) => item.action).sort(), [
  'focus-browser-address',
  'open-browser-tab',
  'open-terminal',
  'toggle-bottom-panel',
  'toggle-file-tree',
  'toggle-pinned-summary',
]);

state.languageMode = 'zh-CN';
const chineseMarkup = renderWindowTitlebar();
for (const label of ['文件', '编辑', '视图', '语言', '帮助', '新建窗口', '打开文件夹...', '撤销', '切换侧边栏', '切换语言', '中文', 'English', '文档', '发送反馈']) {
  assert.ok(chineseMarkup.includes(label), `Chinese desktop menu is missing ${label}`);
}
assert.match(chineseMarkup, /data-desktop-menu-action="set-language-zh-CN"[^>]+aria-checked="true"/);

state.languageMode = 'en';
const englishMarkup = renderWindowTitlebar();
for (const label of ['File', 'Edit', 'View', 'Language', 'Help', 'New Window', 'Open Folder...', 'Undo', 'Toggle Sidebar', 'Switch Language', 'Chinese', 'English', 'Documentation', 'Send Feedback']) {
  assert.ok(englishMarkup.includes(label), `English desktop menu is missing ${label}`);
}
assert.match(englishMarkup, /data-desktop-menu-action="set-language-en"[^>]+aria-checked="true"/);

assert.match(mainHandlerSource, /https:\/\/github\.com\/iLearn-Agent\/Janus#readme/);
assert.match(mainHandlerSource, /https:\/\/github\.com\/iLearn-Agent\/Janus\/issues\/new/);
assert.doesNotMatch(mainHandlerSource, /github\.com\/(?:iLearn-Agent)\/Janus/);
assert.doesNotMatch(mainHandlerSource, /janus\.local|github\.com\/openai\/codex/);
assert.ok(nativeMenuSource.includes("label: t('\\u7f16\\u8f91', 'Edit')"));
assert.ok(nativeMenuSource.includes("label: t('\\u7a97\\u53e3', 'Window')"));

const resizeHandlerStart = rendererAppSource.indexOf("window.addEventListener('resize'");
const resizeHandlerEnd = rendererAppSource.indexOf('installFileDropHandlers()', resizeHandlerStart);
const resizeHandlerSource = rendererAppSource.slice(resizeHandlerStart, resizeHandlerEnd);
const synchronousModeBranch = resizeHandlerSource.indexOf('if (nextMode !== state.responsiveLayoutMode)');
const deferredSameModeRender = resizeHandlerSource.indexOf('responsiveLayoutTimer = setTimeout');
assert.ok(synchronousModeBranch >= 0 && synchronousModeBranch < deferredSameModeRender, 'responsive breakpoint changes must render before the debounced same-mode layout pass');

console.log('Desktop menu bilingual labels and action contract smoke passed.');
