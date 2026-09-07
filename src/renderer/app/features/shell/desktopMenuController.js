import { normalizeLanguage } from '../../i18n.js';
import { DESKTOP_MENU_SECTIONS } from '../../components/overlays.js';
import { desktopShortcutActionForEvent } from '../../platform/keyboardShortcuts.js';

const NATIVE_EDIT_SHORTCUT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'select-all']);
const MODAL_SAFE_SHORTCUT_ACTIONS = new Set(['close-window', 'exit', 'toggle-full-screen']);

function enabledDesktopShortcutItems() {
  return DESKTOP_MENU_SECTIONS.flatMap((section) => section.items)
    .flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [item])
    .filter((item) => item?.action && item.shortcut && !item.disabled);
}

const ENABLED_DESKTOP_SHORTCUT_ITEMS = enabledDesktopShortcutItems();
const DISPATCHED_DESKTOP_SHORTCUT_ACTIONS = ENABLED_DESKTOP_SHORTCUT_ITEMS
  .map((item) => item.action)
  .filter((action) => !NATIVE_EDIT_SHORTCUT_ACTIONS.has(action));
export function createDesktopMenuController({
  state,
  render,
  closeChatSearch,
  enterSettings,
  logoutAccount,
  setLanguageMode,
  windowRef,
  documentRef,
  historyRef,
  getComputedStyleFn,
  requestFrame,
  editHistory,
  EventCtor,
  startNewPlainChat,
  selectWorkspaceDirectory,
  saveRunLogVisible,
  openChatSearch,
  effectiveJanusVersion,
  pathBasename,
  compareSessionsForDisplay,
  openSession,
  notify,
  openUpdateChangelog,
}) {
  const desktopText = (zh, en) => normalizeLanguage(state.languageMode) === 'en' ? en : zh;

  function closeModelMenuOnOutsideClick(event) {
    if (!state.modelMenuOpen && !state.imageModelMenuOpen && !state.pptTemplateMenuOpen && !state.pptStyleMenuOpen && !state.agentMenuOpen && !state.sandboxMenuOpen && !state.workspaceMenuOpen && !state.composerMetaOverflowOpen && !state.composerToolMenuOpen && !state.composerEmojiPickerOpen && !state.composerMemoryMenuOpen && !state.networkDelegationMemoryMenuOpen) return;
    if (event.target?.closest?.('.model-picker')) return;
    if (event.target?.closest?.('.ppt-template-picker')) return;
    if (event.target?.closest?.('.ppt-style-picker')) return;
    if (event.target?.closest?.('.composer-tool-picker, .composer-emoji-picker')) return;
    if (event.target?.closest?.('.composer-meta-secondary, [data-composer-meta-overflow-toggle]')) return;
    const composerEmojiWasOpen = state.composerEmojiPickerOpen === true;
    state.modelMenuOpen = false;
    state.modelSubmenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.imageModelMenuOpen = false;
    state.agentMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.workspaceMenuOpen = false;
    state.composerMetaOverflowOpen = false;
    state.composerToolMenuOpen = false;
    state.composerEmojiPickerOpen = false;
    state.composerMemoryMenuOpen = false;
    state.networkDelegationMemoryMenuOpen = false;
    render();
    if (composerEmojiWasOpen) requestFrame(() => documentRef.getElementById('chat-input')?.focus());
  }

  function closeModelMenuOnEscape(event) {
    if (event.key !== 'Escape') return;
    if (state.chatSearchOpen) {
      closeChatSearch();
      return;
    }
    if (!state.modelMenuOpen && !state.imageModelMenuOpen && !state.pptTemplateMenuOpen && !state.pptStyleMenuOpen && !state.agentMenuOpen && !state.sandboxMenuOpen && !state.workspaceMenuOpen && !state.composerMetaOverflowOpen && !state.composerToolMenuOpen && !state.composerEmojiPickerOpen && !state.composerMemoryMenuOpen && !state.networkDelegationMemoryMenuOpen) return;
    const composerEmojiWasOpen = state.composerEmojiPickerOpen === true;
    state.modelMenuOpen = false;
    state.modelSubmenuOpen = false;
    state.imageModelMenuOpen = false;
    state.pptTemplateMenuOpen = false;
    state.pptStyleMenuOpen = false;
    state.sandboxMenuOpen = false;
    state.agentMenuOpen = false;
    state.workspaceMenuOpen = false;
    state.composerMetaOverflowOpen = false;
    state.composerToolMenuOpen = false;
    state.composerEmojiPickerOpen = false;
    state.composerMemoryMenuOpen = false;
    state.networkDelegationMemoryMenuOpen = false;
    render();
    if (composerEmojiWasOpen) requestFrame(() => documentRef.getElementById('chat-input')?.focus());
  }

  function closeSessionMenuOnOutsideClick(event) {
    if (!state.sessionMenuOpenId) return;
    if (event.target?.closest?.('[data-session-menu], .session-menu')) return;
    state.sessionMenuOpenId = '';
    state.sessionMenuPosition = null;
    render();
  }

  function closeSessionMenuOnEscape(event) {
    if (event.key !== 'Escape' || !state.sessionMenuOpenId) return;
    state.sessionMenuOpenId = '';
    state.sessionMenuPosition = null;
    render();
  }

  function toggleSessionMenu(button) {
    const sessionId = button?.dataset?.sessionMenu || '';
    if (!sessionId) return;
    if (state.sessionMenuOpenId === sessionId) {
      state.sessionMenuOpenId = '';
      state.sessionMenuPosition = null;
      render();
      return;
    }
    state.sessionMenuOpenId = sessionId;
    state.sessionMenuPosition = sessionMenuPositionFromButton(button);
    render();
  }

  function sessionMenuPositionFromButton(button) {
    const buttonRect = button.getBoundingClientRect();
    const rowRect = button.closest?.('.session-row')?.getBoundingClientRect?.() || buttonRect;
    const menuWidth = 188;
    const menuHeight = 184;
    const gap = 8;
    const margin = 10;
    const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 1024;
    const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 768;
    let x = buttonRect.left - menuWidth - gap;
    if (x < margin) x = buttonRect.right + gap;
    x = Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin));
    let y = rowRect.top;
    y = Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin));
    return { x, y };
  }

  function closeProjectMenuOnOutsideClick(event) {
    if (!state.projectMenuOpenId) return;
    if (event.target?.closest?.('.project-menu') || event.target?.closest?.('[data-project-menu]')) return;
    state.projectMenuOpenId = '';
    state.projectMenuKind = '';
    state.projectMenuPosition = null;
    render();
  }

  function closeProjectMenuOnEscape(event) {
    if (event.key !== 'Escape' || !state.projectMenuOpenId) return;
    state.projectMenuOpenId = '';
    state.projectMenuKind = '';
    state.projectMenuPosition = null;
    render();
  }

  function toggleProjectMenu(button) {
    const id = button?.dataset?.projectMenu || '';
    const kind = button?.dataset?.projectMenuKind || '';
    if (!id || !kind) return;
    if (state.projectMenuOpenId === id && state.projectMenuKind === kind) {
      state.projectMenuOpenId = '';
      state.projectMenuKind = '';
      state.projectMenuPosition = null;
      render();
      return;
    }
    state.projectMenuOpenId = id;
    state.projectMenuKind = kind;
    state.projectMenuPosition = projectMenuPositionFromButton(button);
    render();
  }

  function projectMenuPositionFromButton(button) {
    const buttonRect = button.getBoundingClientRect();
    const rowRect = button.closest?.('.sidebar-root-row, .sidebar-project-row')?.getBoundingClientRect?.() || buttonRect;
    const menuWidth = 196;
    const menuHeight = 152;
    const gap = 8;
    const margin = 10;
    const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 1024;
    const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 768;
    let x = buttonRect.left - menuWidth - gap;
    if (x < margin) x = buttonRect.right + gap;
    x = Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin));
    let y = rowRect.top;
    y = Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin));
    return { x, y };
  }

  function closePluginMenuOnOutsideClick(event) {
    if (!state.pluginMenuOpen) return;
    if (event.target?.closest?.('[data-plugin-more], .plugin-menu')) return;
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    render();
  }

  function closePluginMenuOnEscape(event) {
    if (event.key !== 'Escape' || !state.pluginMenuOpen) return;
    state.pluginMenuOpen = false;
    state.pluginMenuOpenId = '';
    state.pluginMenuPosition = null;
    render();
  }

  function pluginMenuPositionFromButton(button) {
    const rect = button.getBoundingClientRect();
    const menuWidth = 176;
    const menuHeight = 116;
    const gap = 8;
    const margin = 12;
    const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 1024;
    const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 768;
    const x = Math.max(margin, Math.min(rect.right - menuWidth, viewportWidth - menuWidth - margin));
    const preferredY = rect.bottom + gap;
    const y = preferredY + menuHeight <= viewportHeight - margin
      ? preferredY
      : Math.max(margin, rect.top - menuHeight - gap);
    return { x, y };
  }

  function closeAccountMenuOnOutsideClick(event) {
    if (!state.accountMenuOpen && !state.accountMenuWorkspaceOpen) return;
    if (event.target?.closest?.('.account-area, .sidebar-profile-area')) return;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    render();
  }

  function handleAccountMenuActionClick(event) {
    const btn = event.target?.closest?.('[data-account-menu-action]');
    if (!btn) return;
    handleAccountMenuAction(btn.dataset.accountMenuAction, event);
  }

  function handleAccountMenuAction(action, event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    if (action === 'settings') {
      enterSettings('account');
      return;
    }
    if (action === 'logout') {
      logoutAccount();
      return;
    }
    render();
  }

  function handleLocationHashAction(options = {}) {
    if (!['#settings', '#account-settings'].includes(windowRef.location.hash)) return;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    state.currentTab = 'settings';
    state.currentSettingsSection = 'account';
    if (options.replace !== false) {
      historyRef.replaceState(null, '', windowRef.location.pathname);
    }
    render();
  }

  function closeAccountMenuOnEscape(event) {
    if (event.key !== 'Escape' || !state.accountMenuOpen) return;
    state.accountMenuOpen = false;
    state.accountMenuWorkspaceOpen = false;
    render();
  }

  function autoResizeChatInput(input = documentRef.getElementById('chat-input')) {
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyleFn(input).maxHeight) || 130;
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function autoResizeDraftTextarea(input) {
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyleFn(input).maxHeight) || 260;
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function updateInputTagIndent() {
    const line = documentRef.querySelector('.composer-input-line.has-tags');
    if (!line) return;
    const tags = line.querySelector('.input-tags');
    if (!tags) return;
    const gap = cssPixelVar('--input-tag-text-gap', 12);
    line.style.setProperty('--input-tag-indent', `${Math.ceil(tags.getBoundingClientRect().width + gap)}px`);
  }

  function scheduleModelMenuPlacement() {
    requestFrame(updateModelMenuPlacement);
  }

  function updateModelMenuPlacement() {
    if (!state.modelMenuOpen) return;
    const trigger = documentRef.getElementById('model-picker-trigger');
    const menu = documentRef.querySelector('.model-menu');
    const submenu = documentRef.querySelector('.model-submenu');
    const currentRow = documentRef.querySelector('.model-current-row');
    if (!trigger || !menu) return;
    const viewportWidth = documentRef.documentElement.clientWidth || windowRef.innerWidth || 0;
    const viewportHeight = documentRef.documentElement.clientHeight || windowRef.innerHeight || 0;
    const gap = cssPixelVar('--model-submenu-gap', 10);
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = Math.min(menu.offsetWidth || 260, Math.max(180, viewportWidth - 24));
    const submenuWidth = Math.min(submenu?.offsetWidth || 260, Math.max(180, viewportWidth - 24));
    const menuHeight = Math.min(menu.offsetHeight || menu.scrollHeight || 232, Math.max(160, viewportHeight - 24));
    const submenuHeight = Math.min(submenu?.offsetHeight || submenu?.scrollHeight || 216, Math.max(140, viewportHeight - 24));
    const menuLeftIfLeftAligned = triggerRect.left;
    const menuLeftIfRightAligned = triggerRect.right - menuWidth;
    const menuPlacement = menuLeftIfLeftAligned + menuWidth + gap <= viewportWidth ? 'left' : 'right';
    const menuVertical = triggerRect.top >= menuHeight + gap ? 'above' : 'below';
    const menuLeft = menuPlacement === 'left' ? menuLeftIfLeftAligned : Math.max(12, menuLeftIfRightAligned);
    const menuRight = menuLeft + menuWidth;
    const submenuFitsLeft = menuLeft - submenuWidth - gap >= 0;
    const submenuFitsRight = menuRight + submenuWidth + gap <= viewportWidth;
    let submenuPlacement = submenuFitsLeft ? 'left' : submenuFitsRight ? 'right' : 'down';
    if (submenuPlacement === 'down') {
      const rowRect = currentRow?.getBoundingClientRect();
      const belowSpace = rowRect ? viewportHeight - rowRect.bottom - gap : 0;
      const aboveSpace = rowRect ? rowRect.top - gap : 0;
      if (belowSpace < submenuHeight && aboveSpace > belowSpace) submenuPlacement = 'up';
    }
    const next = { menu: menuPlacement, submenu: submenuPlacement, vertical: menuVertical };
    const current = state.modelMenuPlacement || {};
    if (current.menu !== next.menu || current.submenu !== next.submenu || current.vertical !== next.vertical) {
      state.modelMenuPlacement = next;
      applyModelMenuPlacementToDom(next);
    }
  }

  function applyModelMenuPlacementToDom(placement = state.modelMenuPlacement || {}) {
    const picker = documentRef.querySelector('.model-picker');
    if (!picker) return;
    picker.classList.toggle('menu-align-left', placement.menu === 'left');
    picker.classList.toggle('menu-align-right', placement.menu !== 'left');
    picker.classList.toggle('menu-above', placement.vertical === 'above');
    picker.classList.toggle('menu-below', placement.vertical !== 'above');
    picker.classList.toggle('submenu-left', placement.submenu === 'left');
    picker.classList.toggle('submenu-down', placement.submenu === 'down');
    picker.classList.toggle('submenu-up', placement.submenu === 'up');
    picker.classList.toggle('submenu-right', !['left', 'down', 'up'].includes(placement.submenu));
  }

  function cssPixelVar(name, fallback) {
    const value = getComputedStyleFn(documentRef.documentElement).getPropertyValue(name).trim();
    const numeric = Number.parseFloat(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  function showDesktopDialog(dialog) {
    state.desktopDialog = dialog || null;
    render();
  }

  function closeDesktopDialog() {
    if (!state.desktopDialog) return;
    state.desktopDialog = null;
    render();
  }

  async function pasteClipboardText() {
    let text = '';
    try {
      text = await windowRef.janus.readClipboardText?.();
    } catch {
      text = '';
    }
    if (!text) {
      documentRef.execCommand('paste');
      return;
    }
    const active = documentRef.activeElement;
    const target = editHistory.isEditableElement(active)
      ? active
      : editHistory.lastEditableElement()?.isConnected ? editHistory.lastEditableElement() : null;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) {
      target.focus();
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      target.setRangeText(text, start, end, 'end');
      target.dispatchEvent(new EventCtor('input', { bubbles: true }));
      editHistory.remember(target);
      return;
    }
    if (target?.isContentEditable) {
      target.focus();
      documentRef.execCommand('insertText', false, text);
      editHistory.remember(target);
      return;
    }
    const chatInput = documentRef.getElementById('chat-input');
    if (chatInput) {
      chatInput.focus();
      const start = chatInput.selectionStart ?? chatInput.value.length;
      const end = chatInput.selectionEnd ?? chatInput.value.length;
      chatInput.setRangeText(text, start, end, 'end');
      chatInput.dispatchEvent(new EventCtor('input', { bubbles: true }));
      editHistory.remember(chatInput);
      return;
    }
    documentRef.execCommand('insertText', false, text);
  }

  function closeDesktopMenus(except = null) {
    documentRef.querySelectorAll('.desktop-menu.is-open').forEach((menu) => {
      if (menu === except) return;
      setDesktopMenuOpen(menu, false);
    });
  }

  function toggleDesktopMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const menu = event.currentTarget.closest('.desktop-menu');
    const willOpen = !menu?.classList.contains('is-open');
    closeDesktopMenus(menu);
    if (!menu) return;
    setDesktopMenuOpen(menu, willOpen);
  }

  function setDesktopMenuOpen(menu, isOpen) {
    if (!menu) return;
    menu.classList.toggle('is-open', Boolean(isOpen));
    menu.querySelector('[data-desktop-menu-trigger]')?.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function switchDesktopMenuOnHover(event) {
    const menu = event.currentTarget;
    if (!documentRef.querySelector('.desktop-menu.is-open') || menu.classList.contains('is-open')) return;
    closeDesktopMenus(menu);
    setDesktopMenuOpen(menu, true);
  }

  function closeDesktopMenuOnOutsideClick(event) {
    if (event.target?.closest?.('.desktop-menubar')) return;
    closeDesktopMenus();
  }

  function closeDesktopMenuOnEscape(event) {
    if (event.key !== 'Escape') return;
    closeDesktopMenus();
  }

  async function handleDesktopMenuActionClick(event) {
    const button = event.currentTarget;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    event.stopPropagation();
    closeDesktopMenus();
    await handleDesktopMenuAction(button.dataset.desktopMenuAction || '');
  }

  async function handleDesktopMenuAction(action) {
    switch (action) {
      case 'new-task':
        startNewPlainChat();
        return;
      case 'new-projectless-task':
        state.activeProjectId = '';
        startNewPlainChat();
        return;
      case 'open-folder':
        await selectWorkspaceDirectory();
        return;
      case 'close-window':
        windowRef.janus.closeWindow();
        return;
      case 'settings':
        enterSettings('account');
        return;
      case 'logout':
        await logoutAccount();
        return;
      case 'toggle-sidebar':
        state.sidebarCollapsed = !state.sidebarCollapsed;
        render();
        return;
      case 'toggle-bottom-panel':
        state.runLogVisible = !state.runLogVisible;
        saveRunLogVisible(state.runLogVisible);
        render();
        return;
      case 'toggle-side-panel':
        state.networkPanelOpen = !state.networkPanelOpen;
        render();
        return;
      case 'toggle-language':
        if (typeof setLanguageMode === 'function') setLanguageMode(normalizeLanguage(state.languageMode) === 'en' ? 'zh-CN' : 'en');
        return;
      case 'set-language-zh-CN':
        if (typeof setLanguageMode === 'function') setLanguageMode('zh-CN');
        return;
      case 'set-language-en':
        if (typeof setLanguageMode === 'function') setLanguageMode('en');
        return;
      case 'find':
        openChatSearch();
        return;
      case 'keyboard-shortcuts':
        showDesktopDialog({
          title: desktopText('\u952e\u76d8\u5feb\u6377\u952e', 'Keyboard Shortcuts'),
          subtitle: desktopText('\u5f53\u524d\u7cfb\u7edf\u4e0a\u53ef\u7528\u7684\u83dc\u5355\u64cd\u4f5c', 'Available menu actions on this system'),
          icon: 'settings',
          rows: ENABLED_DESKTOP_SHORTCUT_ITEMS.map((item) => ({
            label: desktopText(item.label?.zh, item.label?.en),
            value: item.shortcut,
          })),
        });
        return;
      case 'previous-task':
        await selectAdjacentSession(-1);
        return;
      case 'next-task':
        await selectAdjacentSession(1);
        return;
      case 'about':
        showDesktopDialog({
          title: 'Janus Desktop',
          subtitle: desktopText('\u672c\u5730\u4f18\u5148\u7684 Agent \u5de5\u4f5c\u53f0', 'A local-first Agent workspace'),
          icon: 'spark',
          rows: [
            { label: desktopText('\u7248\u672c', 'Version'), value: effectiveJanusVersion() },
            { label: desktopText('\u8fd0\u884c\u6a21\u5f0f', 'Theme'), value: state.themeMode === 'dark' ? desktopText('\u6df1\u8272', 'Dark') : desktopText('\u6d45\u8272', 'Light') },
            { label: desktopText('\u5de5\u4f5c\u533a', 'Workspace'), value: pathBasename(state.workspaceRoot || state.root || 'workspace') },
          ],
        });
        return;
      case 'whats-new':
        openUpdateChangelog?.(effectiveJanusVersion());
        return;
      case 'troubleshooting':
        enterSettings('diagnostics');
        return;
      case 'undo':
      case 'redo':
      case 'cut':
      case 'copy':
        runNativeEditCommand(action);
        return;
      case 'paste':
        await pasteClipboardText();
        return;
      case 'delete':
      case 'select-all':
        runNativeEditCommand(action);
        return;
      default:
        if (windowRef.janus.appMenuCommand && await windowRef.janus.appMenuCommand(action)) return;
        notify('\u8be5\u83dc\u5355\u9879\u5f53\u524d\u4e0d\u53ef\u7528\u3002', 'warning');
    }
  }

  function handleDesktopShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
      || event.target?.dataset?.imeComposing === 'true') return;
    const platform = windowRef?.janus?.platform || '';
    const action = desktopShortcutActionForEvent(event, DISPATCHED_DESKTOP_SHORTCUT_ACTIONS, platform);
    if (!action) return;
    const visibleModal = [...documentRef.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .find((element) => element.getClientRects?.().length && getComputedStyleFn(element).visibility !== 'hidden');
    if (visibleModal && !MODAL_SAFE_SHORTCUT_ACTIONS.has(action)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleDesktopMenuAction(action);
  }

  function runNativeEditCommand(action) {
    if (editHistory.applyCommand(action)) return;
    const target = editHistory.commandTarget();
    if (target) {
      target.focus();
      editHistory.remember(target);
    }
    const commands = {
      undo: 'undo',
      redo: 'redo',
      cut: 'cut',
      copy: 'copy',
      paste: 'paste',
      delete: 'delete',
      'select-all': 'selectAll',
    };
    const command = commands[action];
    if (!command) return;
    documentRef.execCommand(command);
    if (target && (action === 'undo' || action === 'redo' || action === 'cut' || action === 'delete')) {
      target.dispatchEvent(new EventCtor('input', { bubbles: true }));
    }
  }

  async function selectAdjacentSession(direction) {
    const sessions = [...(state.sessions || [])].sort(compareSessionsForDisplay);
    if (!sessions.length) return;
    const currentIndex = sessions.findIndex((session) => session.id === state.currentSessionId);
    const fallback = direction > 0 ? 0 : sessions.length - 1;
    const nextIndex = currentIndex >= 0
      ? Math.min(sessions.length - 1, Math.max(0, currentIndex + direction))
      : fallback;
    const next = sessions[nextIndex];
    if (!next || next.id === state.currentSessionId) return;
    await openSession(next.id);
  }

  return {
    closeModelMenuOnOutsideClick,
    closeModelMenuOnEscape,
    closeSessionMenuOnOutsideClick,
    closeSessionMenuOnEscape,
    toggleSessionMenu,
    sessionMenuPositionFromButton,
    closeProjectMenuOnOutsideClick,
    closeProjectMenuOnEscape,
    toggleProjectMenu,
    projectMenuPositionFromButton,
    closePluginMenuOnOutsideClick,
    closePluginMenuOnEscape,
    pluginMenuPositionFromButton,
    closeAccountMenuOnOutsideClick,
    handleAccountMenuActionClick,
    handleAccountMenuAction,
    handleLocationHashAction,
    closeAccountMenuOnEscape,
    autoResizeChatInput,
    autoResizeDraftTextarea,
    updateInputTagIndent,
    scheduleModelMenuPlacement,
    updateModelMenuPlacement,
    applyModelMenuPlacementToDom,
    cssPixelVar,
    showDesktopDialog,
    closeDesktopDialog,
    pasteClipboardText,
    closeDesktopMenus,
    toggleDesktopMenu,
    setDesktopMenuOpen,
    switchDesktopMenuOnHover,
    closeDesktopMenuOnOutsideClick,
    closeDesktopMenuOnEscape,
    handleDesktopMenuActionClick,
    handleDesktopMenuAction,
    handleDesktopShortcut,
    runNativeEditCommand,
    selectAdjacentSession,
  };
}
