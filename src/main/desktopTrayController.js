export const DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY = 'desktop:close_behavior_v1';
export const DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY = 'desktop:close_prompt_acknowledged_v1';
export const DESKTOP_CLOSE_BEHAVIOR = Object.freeze({
  BACKGROUND: 'background',
  QUIT: 'quit',
});

export function defaultDesktopCloseBehavior(platform = process.platform) {
  return String(platform || '') === 'darwin'
    ? DESKTOP_CLOSE_BEHAVIOR.BACKGROUND
    : DESKTOP_CLOSE_BEHAVIOR.QUIT;
}

export function normalizeDesktopCloseBehavior(value, platform = process.platform) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.values(DESKTOP_CLOSE_BEHAVIOR).includes(normalized)
    ? normalized
    : defaultDesktopCloseBehavior(platform);
}

export function createDesktopTrayController({
  app,
  Tray,
  Menu,
  platform = process.platform,
  appName = 'Janus',
  createTrayImage,
  getSetting = () => '',
  setSetting = () => {},
  focusApplication = () => {},
  translate = (_zh, en) => en,
  promptCloseBehavior = null,
  onWindowHidden = () => {},
  logger = null,
} = {}) {
  const applicationWindows = new Set();
  let tray = null;
  let quitting = false;
  let quitReason = '';
  let lastError = '';
  const closePrompts = new WeakSet();

  const closeBehavior = () => {
    let stored = '';
    try {
      stored = getSetting(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, '');
    } catch {}
    return normalizeDesktopCloseBehavior(stored, platform);
  };

  const liveWindows = () => [...applicationWindows].filter((window) => !window?.isDestroyed?.());
  const traySupported = () => typeof Tray === 'function' && typeof Menu?.buildFromTemplate === 'function';

  function destroyTray() {
    if (!tray) return;
    try { tray.destroy?.(); } catch {}
    tray = null;
  }

  function refreshMenu() {
    if (!tray) return false;
    const menu = Menu.buildFromTemplate([
      {
        label: translate(`打开 ${appName}`, `Open ${appName}`),
        click: () => focusApplication(),
      },
      { type: 'separator' },
      {
        label: translate(`退出 ${appName}`, `Quit ${appName}`),
        click: () => requestQuit('tray-menu'),
      },
    ]);
    tray.setContextMenu?.(menu);
    tray.setToolTip?.(appName);
    return true;
  }

  function ensureTray({ force = false } = {}) {
    if ((!force && closeBehavior() !== DESKTOP_CLOSE_BEHAVIOR.BACKGROUND) || !traySupported()) {
      destroyTray();
      return false;
    }
    if (tray) {
      refreshMenu();
      return true;
    }
    try {
      tray = new Tray(createTrayImage?.(platform));
      tray.on?.('click', () => focusApplication());
      tray.on?.('double-click', () => focusApplication());
      lastError = '';
      refreshMenu();
      return true;
    } catch (error) {
      tray = null;
      lastError = String(error?.message || error || 'Tray initialization failed.');
      logger?.warn?.('desktop-tray-unavailable', { error });
      return false;
    }
  }

  function canKeepRunningInBackground() {
    if (closeBehavior() !== DESKTOP_CLOSE_BEHAVIOR.BACKGROUND) return false;
    return String(platform || '') === 'darwin' || Boolean(tray || ensureTray());
  }

  function closePromptAcknowledged() {
    try { return getSetting(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY, '') === '1'; } catch { return false; }
  }

  function hideWindowInBackground(window, { force = false } = {}) {
    const available = String(platform || '') === 'darwin' || Boolean(tray || ensureTray({ force }));
    if (!available) return false;
    window.hide?.();
    onWindowHidden(window);
    return true;
  }

  async function resolveFirstClose(window) {
    if (closePrompts.has(window)) return;
    closePrompts.add(window);
    try {
      const decision = await promptCloseBehavior({
        window,
        closeBehavior: closeBehavior(),
        platform: String(platform || ''),
        backgroundAvailable: String(platform || '') === 'darwin' || traySupported(),
      });
      const behavior = String(decision?.closeBehavior || 'cancel').trim().toLowerCase();
      if (!Object.values(DESKTOP_CLOSE_BEHAVIOR).includes(behavior)) return;
      if (decision?.remember) setCloseBehavior(behavior, { acknowledgePrompt: true });
      if (behavior === DESKTOP_CLOSE_BEHAVIOR.QUIT) {
        requestQuit('window-close-choice');
        return;
      }
      hideWindowInBackground(window, { force: !decision?.remember });
    } catch (error) {
      logger?.warn?.('desktop-close-choice-failed', { error });
    } finally {
      closePrompts.delete(window);
    }
  }

  function registerWindow(window) {
    if (!window || applicationWindows.has(window)) return window;
    applicationWindows.add(window);
    window.on?.('close', (event) => {
      if (quitting) return;
      const otherWindows = liveWindows().filter((candidate) => candidate !== window);
      if (otherWindows.length) return;
      if (typeof promptCloseBehavior === 'function' && !closePromptAcknowledged()) {
        event?.preventDefault?.();
        void resolveFirstClose(window);
        return;
      }
      if (closeBehavior() !== DESKTOP_CLOSE_BEHAVIOR.BACKGROUND || !canKeepRunningInBackground()) return;
      event?.preventDefault?.();
      hideWindowInBackground(window);
    });
    window.on?.('closed', () => applicationWindows.delete(window));
    return window;
  }

  function status() {
    const behavior = closeBehavior();
    return {
      closeBehavior: behavior,
      defaultCloseBehavior: defaultDesktopCloseBehavior(platform),
      platform: String(platform || ''),
      traySupported: traySupported(),
      trayActive: Boolean(tray),
      backgroundAvailable: behavior !== DESKTOP_CLOSE_BEHAVIOR.BACKGROUND
        ? traySupported() || String(platform || '') === 'darwin'
        : canKeepRunningInBackground(),
      closePromptAcknowledged: closePromptAcknowledged(),
      lastError,
    };
  }

  function setCloseBehavior(value, { acknowledgePrompt = true } = {}) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!Object.values(DESKTOP_CLOSE_BEHAVIOR).includes(normalized)) {
      throw new Error('Unsupported desktop close behavior.');
    }
    const previous = closeBehavior();
    setSetting(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, normalized);
    if (normalized === DESKTOP_CLOSE_BEHAVIOR.BACKGROUND) {
      const available = ensureTray() || String(platform || '') === 'darwin';
      if (!available) {
        setSetting(DESKTOP_CLOSE_BEHAVIOR_SETTING_KEY, previous);
        throw new Error(lastError || 'System tray unavailable.');
      }
    }
    else {
      lastError = '';
      destroyTray();
    }
    if (acknowledgePrompt) setSetting(DESKTOP_CLOSE_PROMPT_ACK_SETTING_KEY, '1');
    return status();
  }

  function requestQuit(reason = 'explicit') {
    quitting = true;
    quitReason = String(reason || 'explicit');
    app?.quit?.();
  }

  function markQuitting(reason = 'application') {
    quitting = true;
    quitReason = String(reason || 'application');
  }

  function dispose() {
    markQuitting('dispose');
    destroyTray();
    applicationWindows.clear();
  }

  return {
    registerWindow,
    firstApplicationWindow: () => liveWindows()[0] || null,
    refresh: () => {
      ensureTray();
      return status();
    },
    refreshMenu,
    status,
    setCloseBehavior,
    canKeepRunningInBackground,
    shouldKeepRunningWithoutWindows: canKeepRunningInBackground,
    requestQuit,
    markQuitting,
    isQuitting: () => quitting,
    quitReason: () => quitReason,
    dispose,
  };
}
