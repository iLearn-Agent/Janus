const LETTER_CODES = new Map([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => [`Key${letter}`, letter.toLowerCase()]),
  ['Comma', ','], ['Slash', '/'], ['Equal', '='], ['Minus', '-'], ['Backquote', '`'],
  ['BracketLeft', '['], ['BracketRight', ']'], ['F11', 'F11'],
]);

const SHORTCUTS = Object.freeze({
  'new-window': { code: 'KeyN', primary: true, shift: true, display: { mac: 'Cmd+Shift+N', other: 'Ctrl+Shift+N' } },
  'new-task': { code: 'KeyN', primary: true, display: { mac: 'Cmd+N', other: 'Ctrl+N' } },
  'new-projectless-task': { code: 'KeyO', primary: true, alt: true, display: { mac: 'Cmd+Option+O', other: 'Ctrl+Alt+O' } },
  'open-folder': { code: 'KeyO', primary: true, display: { mac: 'Cmd+O', other: 'Ctrl+O' } },
  'close-window': { code: 'KeyW', primary: true, display: { mac: 'Cmd+W', other: 'Ctrl+W' } },
  settings: { code: 'Comma', primary: true, display: { mac: 'Cmd+,', other: 'Ctrl+,' } },
  exit: { code: 'KeyQ', primary: true, display: { mac: 'Cmd+Q', other: 'Ctrl+Q' } },
  undo: { code: 'KeyZ', primary: true, display: { mac: 'Cmd+Z', other: 'Ctrl+Z' } },
  redo: { code: 'KeyZ', primary: true, shift: true, display: { mac: 'Cmd+Shift+Z', other: 'Ctrl+Shift+Z' }, aliases: [{ code: 'KeyY', primary: true }] },
  cut: { code: 'KeyX', primary: true, display: { mac: 'Cmd+X', other: 'Ctrl+X' } },
  copy: { code: 'KeyC', primary: true, display: { mac: 'Cmd+C', other: 'Ctrl+C' } },
  paste: { code: 'KeyV', primary: true, display: { mac: 'Cmd+V', other: 'Ctrl+V' } },
  'select-all': { code: 'KeyA', primary: true, display: { mac: 'Cmd+A', other: 'Ctrl+A' } },
  'toggle-sidebar': { code: 'KeyB', primary: true, display: { mac: 'Cmd+B', other: 'Ctrl+B' } },
  'toggle-bottom-panel': { code: 'KeyJ', primary: true, display: { mac: 'Cmd+J', other: 'Ctrl+J' } },
  'open-terminal': { code: 'Backquote', primary: true, display: { mac: 'Cmd+`', other: 'Ctrl+`' } },
  'toggle-file-tree': { code: 'KeyE', primary: true, shift: true, display: { mac: 'Cmd+Shift+E', other: 'Ctrl+Shift+E' } },
  'toggle-side-panel': { code: 'KeyB', primary: true, alt: true, display: { mac: 'Option+Cmd+B', other: 'Ctrl+Alt+B' } },
  'reload-browser-page': { code: 'KeyR', primary: true, display: { mac: 'Cmd+R', other: 'Ctrl+R' } },
  'open-browser-tab': { code: 'KeyT', primary: true, display: { mac: 'Cmd+T', other: 'Ctrl+T' } },
  find: { code: 'KeyF', primary: true, display: { mac: 'Cmd+F', other: 'Ctrl+F' } },
  'previous-task': { code: 'BracketLeft', primary: true, shift: true, display: { mac: 'Cmd+Shift+[', other: 'Ctrl+Shift+[' } },
  'next-task': { code: 'BracketRight', primary: true, shift: true, display: { mac: 'Cmd+Shift+]', other: 'Ctrl+Shift+]' } },
  back: { code: 'BracketLeft', primary: true, display: { mac: 'Cmd+[', other: 'Ctrl+[' } },
  forward: { code: 'BracketRight', primary: true, display: { mac: 'Cmd+]', other: 'Ctrl+]' } },
  'zoom-in': { code: 'Equal', primary: true, display: { mac: 'Cmd+Shift+=', other: 'Ctrl+Shift+=' }, allowEitherShift: true, aliases: [{ code: 'NumpadAdd', primary: true }] },
  'zoom-out': { code: 'Minus', primary: true, display: { mac: 'Cmd+-', other: 'Ctrl+-' }, aliases: [{ code: 'NumpadSubtract', primary: true }] },
  'actual-size': { code: 'Digit0', primary: true, display: { mac: 'Cmd+0', other: 'Ctrl+0' }, aliases: [{ code: 'Numpad0', primary: true }] },
  'toggle-full-screen': { code: 'F11', display: { mac: 'Ctrl+Cmd+F', other: 'F11' }, mac: { code: 'KeyF', primary: true, ctrl: true } },
  'keyboard-shortcuts': { code: 'Slash', primary: true, shift: true, display: { mac: 'Cmd+Shift+/', other: 'Ctrl+Shift+/' } },
});

export const desktopShortcutSpec = (action = '') => SHORTCUTS[action] || null;

export function desktopShortcutLabel(action = '', platform = '') {
  const spec = desktopShortcutSpec(action);
  if (!spec) return '';
  return spec.display[platform === 'darwin' ? 'mac' : 'other'];
}

function eventCode(event = {}) {
  if (event.code) return String(event.code);
  const key = String(event.key || '').toLowerCase();
  for (const [code, value] of LETTER_CODES) if (value === key) return code;
  return key === '0' ? 'Digit0' : key;
}

function matchesSpec(event, spec, platform) {
  const mac = platform === 'darwin';
  const primary = Boolean(spec.primary);
  const expectedMeta = primary && mac;
  const expectedCtrl = primary && !mac;
  if (Boolean(event.metaKey) !== expectedMeta) return false;
  if (Boolean(event.ctrlKey) !== Boolean(spec.ctrl || expectedCtrl)) return false;
  if (Boolean(event.altKey) !== Boolean(spec.alt)) return false;
  if (spec.allowEitherShift ? false : Boolean(event.shiftKey) !== Boolean(spec.shift)) return false;
  return eventCode(event) === spec.code;
}

export function desktopShortcutMatches(event, action = '', platform = '') {
  const spec = desktopShortcutSpec(action);
  if (!spec) return false;
  const activePlatform = platform || globalThis.window?.janus?.platform || globalThis.process?.platform || '';
  const candidates = [spec, ...(spec.aliases || [])];
  if (activePlatform === 'darwin' && spec.mac) candidates.unshift({ ...spec, ...spec.mac });
  return candidates.some((candidate) => matchesSpec(event, candidate, activePlatform));
}

export function desktopShortcutActionForEvent(event, actions = [], platform = '') {
  return actions.find((action) => desktopShortcutMatches(event, action, platform)) || '';
}
