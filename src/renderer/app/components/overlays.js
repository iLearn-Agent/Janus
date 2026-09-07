import { state } from '../state.js';
import { normalizeLanguage } from '../i18n.js';
import { iconSvg } from '../ui/icons.js';
import { escapeAttr, escapeHtml, formatBytes, formatNumber } from '../utils/format.js';
import { filePayloadAttr } from '../utils/filePayload.js';
import { desktopShortcutLabel } from '../platform/keyboardShortcuts.js';

const desktopPlatform = globalThis.window?.janus?.platform || globalThis.process?.platform || '';
const desktopShortcut = (action) => desktopShortcutLabel(action, desktopPlatform);

export const DESKTOP_MENU_SECTIONS = [
  {
    id: 'file',
    label: { zh: '\u6587\u4ef6', en: 'File' },
    items: [
      { label: { zh: '\u65b0\u5efa\u7a97\u53e3', en: 'New Window' }, shortcut: desktopShortcut('new-window'), action: 'new-window' },
      { label: { zh: '\u65b0\u5efa\u4efb\u52a1', en: 'New Task' }, shortcut: desktopShortcut('new-task'), action: 'new-task' },
      { label: { zh: '\u65b0\u5efa\u65e0\u9879\u76ee\u4efb\u52a1', en: 'New Projectless Task' }, shortcut: desktopShortcut('new-projectless-task'), action: 'new-projectless-task' },
      { separator: true },
      { label: { zh: '\u6253\u5f00\u6587\u4ef6\u5939...', en: 'Open Folder...' }, shortcut: desktopShortcut('open-folder'), action: 'open-folder' },
      { separator: true },
      { label: { zh: '\u5173\u95ed', en: 'Close' }, shortcut: desktopShortcut('close-window'), action: 'close-window' },
      { separator: true },
      { label: { zh: '\u8bbe\u7f6e...', en: 'Settings...' }, shortcut: desktopShortcut('settings'), action: 'settings' },
      { separator: true },
      { label: { zh: '\u9000\u51fa\u767b\u5f55', en: 'Log Out' }, action: 'logout' },
      { label: { zh: '\u9000\u51fa', en: 'Exit' }, shortcut: desktopShortcut('exit'), action: 'exit' },
    ],
  },
  {
    id: 'edit',
    label: { zh: '\u7f16\u8f91', en: 'Edit' },
    items: [
      { label: { zh: '\u64a4\u9500', en: 'Undo' }, shortcut: desktopShortcut('undo'), action: 'undo' },
      { label: { zh: '\u91cd\u505a', en: 'Redo' }, shortcut: desktopShortcut('redo'), action: 'redo' },
      { separator: true },
      { label: { zh: '\u526a\u5207', en: 'Cut' }, shortcut: desktopShortcut('cut'), action: 'cut' },
      { label: { zh: '\u590d\u5236', en: 'Copy' }, shortcut: desktopShortcut('copy'), action: 'copy' },
      { label: { zh: '\u7c98\u8d34', en: 'Paste' }, shortcut: desktopShortcut('paste'), action: 'paste' },
      { label: { zh: '\u5220\u9664', en: 'Delete' }, action: 'delete' },
      { separator: true },
      { label: { zh: '\u5168\u9009', en: 'Select All' }, shortcut: desktopShortcut('select-all'), action: 'select-all' },
    ],
  },
  {
    id: 'view',
    label: { zh: '\u89c6\u56fe', en: 'View' },
    items: [
      { label: { zh: '\u5207\u6362\u4fa7\u8fb9\u680f', en: 'Toggle Sidebar' }, shortcut: desktopShortcut('toggle-sidebar'), action: 'toggle-sidebar' },
      { label: { zh: '\u5207\u6362\u5e95\u90e8\u9762\u677f', en: 'Toggle Bottom Panel' }, shortcut: desktopShortcut('toggle-bottom-panel'), action: 'toggle-bottom-panel', disabled: true },
      { label: { zh: '\u5207\u6362\u7f6e\u9876\u6458\u8981', en: 'Toggle Pinned Summary' }, action: 'toggle-pinned-summary', disabled: true },
      { label: { zh: '\u6253\u5f00\u7ec8\u7aef', en: 'Open Terminal' }, shortcut: desktopShortcut('open-terminal'), action: 'open-terminal', disabled: true },
      { label: { zh: '\u5207\u6362\u6587\u4ef6\u6811', en: 'Toggle File Tree' }, shortcut: desktopShortcut('toggle-file-tree'), action: 'toggle-file-tree', disabled: true },
      { label: { zh: '\u5207\u6362\u4fa7\u9762\u677f', en: 'Toggle Side Panel' }, shortcut: desktopShortcut('toggle-side-panel'), action: 'toggle-side-panel' },
      { label: { zh: '\u5207\u6362\u8bed\u8a00', en: 'Switch Language' }, submenu: [
        { label: { zh: '\u4e2d\u6587', en: 'Chinese' }, language: 'zh-CN', action: 'set-language-zh-CN' },
        { label: { zh: 'English', en: 'English' }, language: 'en', action: 'set-language-en' },
      ] },
      { separator: true },
      { label: { zh: '\u6253\u5f00\u6d4f\u89c8\u5668\u6807\u7b7e\u9875', en: 'Open Browser Tab' }, shortcut: desktopShortcut('open-browser-tab'), action: 'open-browser-tab', disabled: true },
      { label: { zh: '\u805a\u7126\u6d4f\u89c8\u5668\u5730\u5740\u680f', en: 'Focus Browser Address Bar' }, action: 'focus-browser-address', disabled: true },
      { label: { zh: '\u91cd\u65b0\u52a0\u8f7d\u9875\u9762', en: 'Reload Browser Page' }, shortcut: desktopShortcut('reload-browser-page'), action: 'reload-browser-page' },
      { separator: true },
      { label: { zh: '\u67e5\u627e', en: 'Find' }, shortcut: desktopShortcut('find'), action: 'find' },
      { separator: true },
      { label: { zh: '\u4e0a\u4e00\u4e2a\u4efb\u52a1', en: 'Previous Task' }, shortcut: desktopShortcut('previous-task'), action: 'previous-task' },
      { label: { zh: '\u4e0b\u4e00\u4e2a\u4efb\u52a1', en: 'Next Task' }, shortcut: desktopShortcut('next-task'), action: 'next-task' },
      { label: { zh: '\u540e\u9000', en: 'Back' }, shortcut: desktopShortcut('back'), action: 'back' },
      { label: { zh: '\u524d\u8fdb', en: 'Forward' }, shortcut: desktopShortcut('forward'), action: 'forward' },
      { separator: true },
      { label: { zh: '\u653e\u5927', en: 'Zoom In' }, shortcut: desktopShortcut('zoom-in'), action: 'zoom-in' },
      { label: { zh: '\u7f29\u5c0f', en: 'Zoom Out' }, shortcut: desktopShortcut('zoom-out'), action: 'zoom-out' },
      { label: { zh: '\u5b9e\u9645\u5927\u5c0f', en: 'Actual Size' }, shortcut: desktopShortcut('actual-size'), action: 'actual-size' },
      { separator: true },
      { label: { zh: '\u5207\u6362\u5168\u5c4f', en: 'Toggle Full Screen' }, shortcut: desktopShortcut('toggle-full-screen'), action: 'toggle-full-screen' },
    ],
  },
  {
    id: 'help',
    label: { zh: '\u5e2e\u52a9', en: 'Help' },
    items: [
      { label: { zh: '\u6587\u6863', en: 'Documentation' }, action: 'documentation' },
      { label: { zh: '\u952e\u76d8\u5feb\u6377\u952e', en: 'Keyboard Shortcuts' }, shortcut: desktopShortcut('keyboard-shortcuts'), action: 'keyboard-shortcuts' },
      { label: { zh: '\u66f4\u65b0\u5185\u5bb9', en: "What's New" }, action: 'whats-new' },
      { separator: true },
      { label: { zh: '\u6545\u969c\u6392\u9664', en: 'Troubleshooting' }, action: 'troubleshooting' },
      { label: { zh: '\u7cfb\u7edf\u72b6\u6001', en: 'System Status' }, action: 'system-status' },
      { label: { zh: '\u53d1\u9001\u53cd\u9988', en: 'Send Feedback' }, action: 'send-feedback' },
      { separator: true },
      { label: { zh: '\u542f\u52a8\u6027\u80fd\u5206\u6790', en: 'Start Performance Trace' }, action: 'start-performance-trace' },
      { separator: true },
      { label: { zh: '\u5173\u4e8e Janus', en: 'About Janus' }, action: 'about' },
    ],
  },
];

function isEnglishUi() {
  return normalizeLanguage(state.languageMode) === 'en';
}

function desktopMenuText(label) {
  if (!label || typeof label !== 'object') return String(label || '');
  return isEnglishUi() ? label.en : label.zh;
}

function renderDesktopMenuItem(item) {
  if (item.separator) return '<div class="desktop-menu-separator" role="separator"></div>';
  const selected = item.language && normalizeLanguage(state.languageMode) === item.language;
  const disabled = item.disabled ? ' disabled aria-disabled="true"' : '';
  const role = item.language ? 'menuitemradio' : 'menuitem';
  const checked = item.language ? ` aria-checked="${selected ? 'true' : 'false'}"` : '';
  if (Array.isArray(item.submenu) && item.submenu.length) {
    return `
      <div class="desktop-menu-submenu" role="none">
        <button class="desktop-menu-item desktop-menu-submenu-trigger" type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false"${disabled}>
          <span>${escapeHtml(desktopMenuText(item.label))}</span>
          <kbd class="desktop-menu-submenu-arrow" aria-hidden="true">${iconSvg('chevronRight')}</kbd>
        </button>
        <div class="desktop-menu-submenu-popover" role="menu">
          ${item.submenu.map(renderDesktopMenuItem).join('')}
        </div>
      </div>
    `;
  }
  return `
    <button class="desktop-menu-item" data-desktop-menu-action="${escapeAttr(item.action)}" type="button" role="${role}"${checked}${disabled}>
      <span>${escapeHtml(desktopMenuText(item.label))}</span>
      ${item.language ? `<kbd class="desktop-menu-choice-mark">${selected ? iconSvg('check') : ''}</kbd>` : item.shortcut ? `<kbd>${escapeHtml(item.shortcut)}</kbd>` : '<kbd></kbd>'}
    </button>
  `;
}

function renderDesktopMenu(section) {
  return `
    <div class="desktop-menu" data-desktop-menu="${escapeAttr(section.id)}">
      <button class="desktop-menu-trigger" data-desktop-menu-trigger="${escapeAttr(section.id)}" type="button" aria-haspopup="menu" aria-expanded="false">${escapeHtml(desktopMenuText(section.label))}</button>
      <div class="desktop-menu-popover" role="menu">
        ${section.items.map(renderDesktopMenuItem).join('')}
      </div>
    </div>
  `;
}

export function renderWindowTitlebar({ nativeFrame = false } = {}) {
  const activeWorkspace = state.activeAccountWorkspace;
  const workspaces = Array.isArray(state.accountWorkspaces) ? state.accountWorkspaces : [];
  const showTitlebarWorkspaceSwitcher = false;
  const workspaceSwitcher = showTitlebarWorkspaceSwitcher && state.currentUser && activeWorkspace ? `
    <div class="account-workspace-switcher ${state.accountWorkspaceMenuOpen ? 'is-open' : ''}">
      <button class="account-workspace-trigger" type="button" data-account-workspace-toggle aria-haspopup="menu"
        aria-expanded="${state.accountWorkspaceMenuOpen ? 'true' : 'false'}" ${state.workspaceSwitchBusy ? 'disabled' : ''}>
        <span class="account-workspace-avatar">${escapeHtml(workspaceInitial(activeWorkspace))}</span>
        <span class="account-workspace-label">${escapeHtml(activeWorkspace.kind === 'personal' ? '个人' : activeWorkspace.name || '组织')}</span>
        ${state.workspaceSwitchBusy ? '<span class="account-workspace-spinner" aria-hidden="true"></span>' : iconSvg('chevronDown')}
      </button>
      ${state.accountWorkspaceMenuOpen ? `<div class="account-workspace-menu" role="menu">
        <div class="account-workspace-menu-heading">
          <small>切换工作空间</small>
          <span class="account-workspace-help" tabindex="0" aria-label="工作空间说明" title="切换后，消息、通讯录、项目、任务和 Memory 会随当前工作空间切换；登录账号和个人 Agent 不会改变。">
            ${iconSvg('helpCircle')}
            <span role="tooltip">消息、通讯录、项目、任务和 Memory 会随当前组织切换。</span>
          </span>
        </div>
        ${workspaces.map((workspace) => `<button type="button" role="menuitem" data-account-workspace-id="${escapeAttr(workspace.id)}"
          class="account-workspace-option ${workspace.id === activeWorkspace.id ? 'is-active' : ''}">
          <span class="account-workspace-avatar">${escapeHtml(workspaceInitial(workspace))}</span>
          <span><strong>${escapeHtml(workspace.kind === 'personal' ? '个人' : workspace.name || '组织')}</strong><small>${workspace.kind === 'organization' ? '组织' : '个人'} · ${escapeHtml(workspace.role || 'member')}</small></span>
          ${workspace.id === activeWorkspace.id ? iconSvg('check') : ''}
        </button>`).join('')}
        <div class="account-workspace-menu-actions" role="group" aria-label="工作空间与组织管理">
          <button type="button" data-account-organization-action="join">${iconSvg('plus')}<span>加入组织</span></button>
          <button type="button" data-account-organization-action="create">${iconSvg('building')}<span>创建组织</span></button>
          ${activeWorkspace.kind === 'organization' ? `<button type="button" data-account-organization-action="manage">${iconSvg('settings')}<span>管理当前组织</span></button>` : ''}
        </div>
      </div>` : ''}
    </div>` : '';
  return `
    <header class="window-titlebar ${nativeFrame ? 'native-window-frame' : ''}">
      <div class="window-drag-region">
        <div class="window-leading-controls">
          <button class="titlebar-icon-btn" data-desktop-menu-action="toggle-sidebar" type="button" title="\u5207\u6362\u4fa7\u8fb9\u680f">${iconSvg('sidebar')}</button>
          <button class="titlebar-icon-btn" data-desktop-menu-action="back" type="button" title="\u540e\u9000">${iconSvg('chevronLeft')}</button>
          <button class="titlebar-icon-btn" data-desktop-menu-action="forward" type="button" title="\u524d\u8fdb">${iconSvg('chevronRight')}</button>
        </div>
        <nav class="desktop-menubar" aria-label="\u5e94\u7528\u83dc\u5355">
          ${DESKTOP_MENU_SECTIONS.map(renderDesktopMenu).join('')}
        </nav>
        <div class="window-drag-handle" aria-hidden="true"></div>
        <div class="window-brand">
          <img class="window-brand-icon" src="../../assets/icons/icon.png" alt="" />
          <strong>Janus</strong>
        </div>
        ${workspaceSwitcher}
        <div class="global-language-switch ${state.languageMenuOpen ? 'is-open' : ''}" data-no-localize>
          <button class="titlebar-icon-btn global-language-toggle" id="language-toggle-btn" type="button" title="${state.languageMode === 'en' ? 'Language' : '语言'}" aria-label="${state.languageMode === 'en' ? 'Choose language' : '选择语言'}" aria-haspopup="menu" aria-expanded="${state.languageMenuOpen ? 'true' : 'false'}">
            <span>${state.languageMode === 'en' ? 'EN' : '中'}</span>
          </button>
          ${state.languageMenuOpen ? `<div class="global-language-menu" role="menu" aria-label="Language">
            <button type="button" role="menuitemradio" aria-checked="${state.languageMode === 'en' ? 'true' : 'false'}" class="${state.languageMode === 'en' ? 'active' : ''}" data-language-choice="en"><strong>English</strong><small>EN</small></button>
            <button type="button" role="menuitemradio" aria-checked="${state.languageMode === 'zh-CN' ? 'true' : 'false'}" class="${state.languageMode === 'zh-CN' ? 'active' : ''}" data-language-choice="zh-CN"><strong>中文</strong><small>中</small></button>
          </div>` : ''}
        </div>
        <button class="titlebar-icon-btn global-theme-toggle ${state.themeMode === 'dark' ? 'active' : ''}" id="theme-toggle-btn" type="button" title="切换主题" aria-label="切换明暗主题">
          ${iconSvg(state.themeMode === 'dark' ? 'moon' : 'sun')}
        </button>
      </div>
      ${nativeFrame ? '' : `<div class="window-controls">
        <button class="window-control" id="window-minimize-btn" type="button" title="\u6700\u5c0f\u5316">${iconSvg('minimize')}</button>
        <button class="window-control" id="window-maximize-btn" type="button" title="\u6700\u5927\u5316">${iconSvg('maximize')}</button>
        <button class="window-control close" id="window-close-btn" type="button" title="\u5173\u95ed">${iconSvg('x')}</button>
      </div>`}
    </header>
  `;
}

function workspaceInitial(workspace = {}) {
  return String(workspace.name || (workspace.kind === 'organization' ? '组' : '我')).trim().slice(0, 1).toUpperCase() || 'W';
}


export function renderDesktopDialog() {
  const dialog = state.desktopDialog;
  if (!dialog) return '';
  const rows = Array.isArray(dialog.rows) ? dialog.rows : [];
  return `
    <div class="desktop-dialog-overlay" id="desktop-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="desktop-dialog-title">
      <article class="desktop-dialog-card">
        <header>
          <div class="desktop-dialog-emblem">${iconSvg(dialog.icon || 'spark')}</div>
          <div>
            <h2 id="desktop-dialog-title">${escapeHtml(dialog.title || 'Janus')}</h2>
            ${dialog.subtitle ? `<p>${escapeHtml(dialog.subtitle)}</p>` : ''}
          </div>
          <button class="desktop-dialog-close" id="desktop-dialog-close" type="button" title="\u5173\u95ed">${iconSvg('x')}</button>
        </header>
        ${dialog.message ? `<p class="desktop-dialog-message">${escapeHtml(dialog.message)}</p>` : ''}
        ${rows.length ? `
          <div class="desktop-dialog-list">
            ${rows.map((row) => `
              <div class="desktop-dialog-row">
                <span>${escapeHtml(row.label || '')}</span>
                <strong>${escapeHtml(row.value || '')}</strong>
              </div>
            `).join('')}
          </div>
        ` : ''}
        <footer>
          <button class="btn primary desktop-dialog-dismiss" type="button">\u77e5\u9053\u4e86</button>
        </footer>
      </article>
    </div>
  `;
}

export function renderRenameSessionModal() {
  const item = state.renameSessionDialog;
  if (!item) return '';
  const isProject = item.type === 'project';
  const title = isProject ? '重命名项目' : '重命名对话';
  const label = isProject ? '项目名称' : '对话名称';
  return `
    <div class="dialog-overlay" id="rename-session-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-session-title">
      <form class="dialog-card rename-session-dialog" id="rename-session-form">
        <header>
          <div>
            <h2 id="rename-session-title">${escapeHtml(title)}</h2>
          </div>
          <button class="icon-btn" id="rename-session-close" type="button" title="关闭">${iconSvg('x')}</button>
        </header>
        <label>
          <span>${escapeHtml(label)}</span>
          <input id="rename-session-input" value="${escapeAttr(item.draft || '')}" maxlength="120" autocomplete="off" />
        </label>
        <footer>
          <button class="btn secondary" id="rename-session-cancel" type="button">取消</button>
          <button class="btn primary" type="submit">保存</button>
        </footer>
      </form>
    </div>
  `;
}

export function renderMemoryNameModal() {
  const item = state.memoryNameDialog;
  if (!item) return '';
  const english = normalizeLanguage(state.languageMode) === 'en';
  const renaming = item.mode === 'rename';
  const title = renaming ? (english ? 'Rename Memory' : '重命名 Memory') : (english ? 'Create Memory' : '新建 Memory');
  const description = renaming
    ? (english ? 'Only the display name changes; messages, files, and context identity stay the same.' : '只修改显示名称；消息、文件和上下文身份保持不变。')
    : (english ? 'Create an independent chat-context branch and switch to it immediately.' : '创建一条独立的对话上下文分支，并立即切换到它。');
  const label = english ? 'Memory name' : 'Memory 名称';
  return `
    <div class="dialog-overlay" id="memory-name-overlay" role="dialog" aria-modal="true" aria-labelledby="memory-name-title">
      <form class="dialog-card memory-name-dialog" id="memory-name-form">
        <header>
          <div>
            <h2 id="memory-name-title">${escapeHtml(title)}</h2>
            <p>${escapeHtml(description)}</p>
          </div>
          <button class="icon-btn" id="memory-name-close" type="button" title="${escapeAttr(english ? 'Close' : '关闭')}" ${item.busy ? 'disabled' : ''}>${iconSvg('x')}</button>
        </header>
        <label>
          <span>${escapeHtml(label)}</span>
          <input id="memory-name-input" name="displayName" value="${escapeAttr(item.draft || '')}" maxlength="60" autocomplete="off" required />
        </label>
        ${item.error ? `<div class="dialog-error" role="alert">${escapeHtml(item.error)}</div>` : ''}
        <footer>
          <button class="btn secondary" id="memory-name-cancel" type="button" ${item.busy ? 'disabled' : ''}>${escapeHtml(english ? 'Cancel' : '取消')}</button>
          <button class="btn primary" type="submit" ${item.busy ? 'disabled' : ''}>${escapeHtml(item.busy ? (renaming ? (english ? 'Saving…' : '保存中…') : (english ? 'Creating…' : '创建中…')) : (renaming ? (english ? 'Save' : '保存') : (english ? 'Create and Switch' : '创建并切换')))}</button>
        </footer>
      </form>
    </div>
  `;
}

export function renderSocialEditModal() {
  const item = state.socialEditDialog;
  if (!item) return '';
  const isFriendRemark = item.type === 'friend-remark';
  const isGroupRemark = item.type === 'chat-group-remark';
  const isDisplayName = ['organization-display-name', 'group-display-name'].includes(item.type);
  const isGroupRename = !isFriendRemark && !isDisplayName;
  const title = isFriendRemark ? '设置联系人备注'
    : isGroupRemark ? '设置群聊备注'
    : item.type === 'organization-display-name' ? '修改组织内显示名'
      : item.type === 'group-display-name' ? '修改群内显示名' : '修改群聊名称';
  const label = isFriendRemark || isGroupRemark ? '备注名称' : isDisplayName ? '显示名称' : '群聊名称';
  const placeholder = isFriendRemark ? '留空则恢复显示联系人原名'
    : isGroupRemark ? '留空则恢复显示群聊原名'
    : isDisplayName ? '留空则恢复账号名称' : '请输入群聊名称';
  const maxLength = isFriendRemark ? 40 : 80;
  return `
    <div class="dialog-overlay" id="social-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="social-edit-title">
      <form class="dialog-card social-edit-dialog" id="social-edit-form">
        <header>
          <div>
            <h2 id="social-edit-title">${escapeHtml(title)}</h2>
            ${item.subtitle ? `<p>${escapeHtml(item.subtitle)}</p>` : ''}
          </div>
          <button class="icon-btn" id="social-edit-close" type="button" title="关闭" ${item.busy ? 'disabled' : ''}>${iconSvg('x')}</button>
        </header>
        <label>
          <span>${escapeHtml(label)}</span>
          <input id="social-edit-input" value="${escapeAttr(item.draft || '')}" maxlength="${maxLength}" placeholder="${escapeAttr(placeholder)}" autocomplete="off" ${isGroupRename ? 'required' : ''} ${item.busy ? 'disabled' : ''} />
        </label>
        ${item.error ? `<div class="dialog-error" role="alert">${escapeHtml(item.error)}</div>` : ''}
        <footer>
          <button class="btn secondary" id="social-edit-cancel" type="button" ${item.busy ? 'disabled' : ''}>取消</button>
          <button class="btn primary" type="submit" ${item.busy ? 'disabled' : ''}>${item.busy ? '正在保存…' : '保存'}</button>
        </footer>
      </form>
    </div>
  `;
}

export function renderNotice() {
  if (!state.notice) return '';
  const actionable = typeof state.notice.action?.onClick === 'function';
  const actionLabel = state.notice.action?.label || '打开对应界面';
  return `
    <div class="app-notice ${escapeAttr(state.notice.tone || 'info')} is-${escapeAttr(state.notice.phase || 'visible')} ${state.notice.placement === 'chat-bottom-center' ? 'is-chat-bottom-center' : state.notice.placement === 'chat-bottom-right' ? 'is-chat-bottom-right' : ''} ${actionable ? 'is-actionable' : ''}" role="${actionable ? 'button' : 'status'}" tabindex="0"${actionable ? ` title="${escapeAttr(actionLabel)}" aria-label="${escapeAttr(`${state.notice.message}，${actionLabel}`)}"` : ''}>
      <span class="app-notice-message">${escapeHtml(state.notice.message)}</span>
      ${actionable ? `<span class="app-notice-action" aria-hidden="true">${iconSvg('chevronRight')}</span>` : ''}
    </div>
  `;
}

export function renderPreviewModal() {
  if (!state.preview) return '';
  const item = state.preview;
  const actionItem = item.action_file || item;
  const payload = filePayloadAttr(actionItem);
  return `
    <div class="preview-overlay" role="dialog" aria-modal="true">
      <div class="preview-modal">
        <header>
          <div>
            <strong>${escapeHtml(item.name || '文件预览')}</strong>
            <span>${escapeHtml(item.kind || '')}${item.size ? ` / ${escapeHtml(formatBytes(item.size))}` : ''}</span>
          </div>
          <div class="preview-actions">
            ${item.kind === 'image' && (actionItem.path || actionItem.id || actionItem.remote_file_id) ? `<button class="icon-btn" data-copy-image="${payload}" type="button" title="复制图片" aria-label="复制图片">${iconSvg('copy')}</button>` : ''}
            ${actionItem.path ? `
              <button class="icon-btn" data-save-file="${payload}" type="button" title="另存为">${iconSvg('download')}</button>
              <button class="icon-btn" data-show-file="${payload}" type="button" title="在文件夹中显示">${iconSvg('folder')}</button>
              <button class="icon-btn" data-open-file="${payload}" type="button" title="打开文件">${iconSvg('external')}</button>
            ` : ''}
            <button class="icon-btn" id="close-preview-btn" type="button" title="关闭">${iconSvg('x')}</button>
          </div>
        </header>
        <div class="preview-body ${escapeAttr(previewBodyClass(item))}">${renderPreviewBody(item)}</div>
      </div>
    </div>
  `;
}

export function previewBodyClass(item) {
  if (item.preview_loading) return 'is-loading';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(item.kind)
    && (item.preview_error || item.previewError || item.preview_error_code || item.previewErrorCode)) return 'is-document';
  if (item.kind === 'pptx') return 'is-deck';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt'].includes(item.kind) && (item.office_pdf_url || item.officePdfUrl)) return 'is-pdf is-document';
  if (['xls', 'xlsx'].includes(item.kind) && Array.isArray(item.sheets) && item.sheets.length) return 'is-spreadsheet';
  if (item.kind === 'docx' && Array.isArray(item.blocks) && item.blocks.length) return 'is-docx';
  if (item.kind === 'pdf') return 'is-pdf';
  if (item.kind === 'image') return 'is-image';
  return '';
}

function previewPdfFrameUrl(url = '') {
  if (!url) return '';
  if (String(url).includes('#')) return String(url);
  return `${url}#toolbar=0&navpanes=0&scrollbar=1`;
}


function documentPageImageUrls(item = {}) {
  const direct = item.page_image_urls || item.pageImageUrls || item.preview_page_urls || item.previewPageUrls || [];
  return Array.isArray(direct) ? direct.filter(Boolean) : [];
}

function documentPageCount(item = {}) {
  const urls = documentPageImageUrls(item);
  const explicit = Number(item.page_count || item.pageCount || item.pages || 0);
  return Math.max(1, urls.length || (Number.isFinite(explicit) ? explicit : 0) || 1);
}

function renderDocumentPdfPreview(item, officePdfUrl = '') {
  const pageUrls = documentPageImageUrls(item);
  const pageImages = item.page_image_render_mode === 'thumbnails' ? [] : pageUrls;
  const pageCount = documentPageCount(item);
  const frameUrl = previewPdfFrameUrl(officePdfUrl);
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    const pageUrl = pageUrls[index] || '';
    const href = pageImages.length
      ? `#preview-document-page-${page}`
      : `${officePdfUrl}${String(officePdfUrl).includes('#') ? '&' : '#'}page=${page}&toolbar=0&navpanes=0&scrollbar=1`;
    return `<a class="preview-page-thumb ${page === 1 ? 'is-active' : ''}" href="${escapeAttr(href)}" ${pageImages.length ? '' : 'target="preview-document-frame" ' }title="第 ${page} 页">${pageUrl ? `<img src="${escapeAttr(pageUrl)}" alt="第 ${page} 页" loading="lazy" />` : '<span class="preview-page-placeholder"></span>'}<small>${page}</small></a>`;
  }).join('');
  const content = pageImages.length
    ? `<main class="preview-document-main is-pages" data-preserve-scroll data-scroll-key="office-preview:${escapeAttr(item.path || item.name || officePdfUrl)}"><div class="preview-document-pages">${pageImages.map((url, index) => `<figure id="preview-document-page-${index + 1}" class="preview-document-page"><img src="${escapeAttr(url)}" alt="第 ${index + 1} 页" loading="${index === 0 ? 'eager' : 'lazy'}" /></figure>`).join('')}</div></main>`
    : `<main class="preview-document-main is-frame"><iframe class="preview-frame preview-office-pdf" name="preview-document-frame" src="${escapeAttr(frameUrl)}" title="${escapeAttr(item.name || 'Office preview')}"></iframe></main>`;
  return `<section class="preview-document-shell"><input class="preview-document-sidebar-check" id="preview-document-sidebar-toggle" type="checkbox" checked /><aside class="preview-document-sidebar" aria-label="页面缩略图"><div class="preview-document-sidebar-head"><span>${pageCount} 页</span><label class="preview-document-sidebar-toggle" for="preview-document-sidebar-toggle" title="收起/展开缩略图">${iconSvg('chevronLeft')}</label></div><div class="preview-document-thumbs">${pages}</div></aside>${content}</section>`;
}

export function renderPreviewBody(item) {
  if (item.preview_loading) {
    return `<div class="preview-loading" role="status" aria-live="polite"><span class="preview-loading-spinner" aria-hidden="true"></span><strong>正在准备文件预览</strong></div>`;
  }
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(item.kind)
    && (item.preview_error || item.previewError || item.preview_error_code || item.previewErrorCode)) return renderOfficeDocumentPreview(item);
  if (item.kind === 'image') {
    const payload = filePayloadAttr(item.action_file || item);
    return `<img class="preview-image" src="${escapeAttr(item.fileUrl || item.file_url || item.url || item.download_url || '')}" alt="${escapeAttr(item.name || '')}" decoding="async" data-image-context-file="${payload}" />`;
  }
  if (item.kind === 'pptx') return renderPptxPreview(item);
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt'].includes(item.kind)) return renderOfficeDocumentPreview(item);
  if (item.kind === 'docx' && Array.isArray(item.blocks) && item.blocks.length) return renderDocxPreview(item);
  if (item.kind === 'pdf' && (item.fileUrl || item.file_url)) {
    if (documentPageImageUrls(item).length) return renderDocumentPdfPreview(item, item.fileUrl || item.file_url);
    return `<iframe class="preview-frame" src="${escapeAttr(previewPdfFrameUrl(item.fileUrl || item.file_url))}" title="${escapeAttr(item.name || 'PDF 预览')}"></iframe>`;
  }
  if (['text', 'markdown', 'docx', 'pdf'].includes(item.kind)) {
    const className = item.kind === 'markdown' ? 'preview-text preview-markdown' : 'preview-text';
    return `
      <article class="preview-paper">
        <pre class="${className}">${escapeHtml(item.text || '')}</pre>
        ${item.truncated ? '<div class="preview-truncated">文件较长，预览已截断。</div>' : ''}
      </article>
    `;
  }
  if (item.kind === 'archive') {
    return `<div class="empty large"><strong>压缩包仅提供安全传输与元数据预览</strong><p>${escapeHtml(item.safety_note || '文件不会自动解压。请保存后使用可信工具检查内容。')}</p>${item.sha256 ? `<code>SHA-256: ${escapeHtml(item.sha256)}</code>` : ''}</div>`;
  }
  if (item.kind === 'installer') {
    return `<div class="empty large"><strong>这是安装包或可执行文件</strong><p>${escapeHtml(item.safety_note || 'Janus 不会自动运行该文件。仅在确认发送者可信后手动打开。')}</p>${item.sha256 ? `<code>SHA-256: ${escapeHtml(item.sha256)}</code>` : ''}</div>`;
  }
  return `<div class="empty large">该文件格式暂不支持内嵌预览，可以打开本地文件查看。</div>`;
}

export function renderOfficeDocumentPreview(item) {
  const officePdfUrl = item.office_pdf_url || item.officePdfUrl || '';
  if (officePdfUrl && item.preview_render_mode !== 'fallback') {
    return renderDocumentPdfPreview(item, officePdfUrl);
  }
  if (item.kind === 'docx' && Array.isArray(item.blocks) && item.blocks.length) return renderDocxPreview(item);
  if (['xls', 'xlsx'].includes(item.kind) && Array.isArray(item.sheets) && item.sheets.length) return renderSpreadsheetPreview(item);
  if (item.preview_error || item.previewError || item.preview_error_code || item.previewErrorCode) {
    const message = item.preview_error || item.previewError || item.text || '当前文件无法生成内嵌预览。';
    const converter = item.preview_converter || item.previewConverter || '';
    return `
      <article class="preview-office-fallback" role="status">
        <strong>无法生成内嵌预览</strong>
        <p>${escapeHtml(message)}</p>
        ${converter ? `<small>已尝试：${escapeHtml(converter)}</small>` : ''}
        <small>源文件没有被修改，你仍可使用右上角按钮下载、在文件夹中显示或用本机应用打开。</small>
      </article>
    `;
  }
  const className = ['xls', 'xlsx'].includes(item.kind) ? 'preview-text preview-spreadsheet-text' : 'preview-text';
  return `
    <article class="preview-paper ${['xls', 'xlsx'].includes(item.kind) ? 'preview-spreadsheet-paper' : ''}">
      <pre class="${className}">${escapeHtml(item.text || '\u5f53\u524d\u73af\u5883\u65e0\u6cd5\u751f\u6210\u89c6\u89c9\u9884\u89c8\uff0c\u53ef\u4ee5\u70b9\u51fb\u53f3\u4e0a\u89d2\u6253\u5f00\u6587\u4ef6\u67e5\u770b\u3002')}</pre>
    </article>
  `;
}

export function renderDocxPreview(item) {
  return `
    <article class="preview-docx">
      ${(item.blocks || []).map((block) => {
        if (block.type === 'table') return renderDocxTable(block);
        if (block.type === 'image') return renderDocxImage(block);
        if (block.type === 'truncated') return `<div class="preview-truncated">${escapeHtml(block.text || '文档较长，预览已截断。')}</div>`;
        if (block.type === 'list') return `<p class="preview-docx-list">${escapeHtml(block.text || '')}</p>`;
        if (block.type === 'heading') {
          const level = Math.min(Math.max(Number(block.level || 2), 1), 3);
          return `<h${level}>${escapeHtml(block.text || '')}</h${level}>`;
        }
        return `<p>${escapeHtml(block.text || '')}</p>`;
      }).join('')}
    </article>
  `;
}

export function renderDocxTable(block) {
  return `
    <table class="preview-docx-table">
      <tbody>
        ${(block.rows || []).map((row) => `
          <tr>${(row || []).map((cell) => `<td>${escapeHtml(cell || '')}</td>`).join('')}</tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

export function renderDocxImage(block) {
  if (!block.src) return '';
  return `<figure class="preview-docx-image"><img src="${escapeAttr(block.src)}" alt="${escapeAttr(block.alt || '')}" loading="lazy" />${block.alt ? `<figcaption>${escapeHtml(block.alt)}</figcaption>` : ''}</figure>`;
}

export function renderSpreadsheetPreview(item) {
  const sheets = item.sheets || [];
  return `<section class="preview-spreadsheet-workbook">
    <div class="preview-spreadsheet-tabs" role="tablist" aria-label="工作表">
      ${sheets.map((sheet, index) => `<a href="#preview-sheet-${index + 1}" class="preview-spreadsheet-tab ${index === 0 ? 'is-active' : ''}">${escapeHtml(sheet.name || `Sheet ${index + 1}`)}</a>`).join('')}
    </div>
    ${sheets.map((sheet, index) => {
      const rows = sheet.rows || [];
      const columnCount = Math.max(Number(sheet.column_count || 0), ...rows.map((row) => (row || []).length), 1);
      const widths = Array.isArray(sheet.column_widths) ? sheet.column_widths : [];
      const colgroup = Array.from({ length: columnCount }, (_, columnIndex) => `<col style="width:${Math.max(72, Math.min(280, Number(widths[columnIndex] || 120)))}px" />`).join('');
      return `
        <article class="preview-spreadsheet-sheet" id="preview-sheet-${index + 1}">
          <header><strong>${escapeHtml(sheet.name || `Sheet ${index + 1}`)}</strong><small>${escapeHtml(`${Number(sheet.row_count || rows.length)} 行 · ${columnCount} 列${sheet.truncated ? ' · 预览已截断' : ''}`)}</small></header>
          <div class="preview-spreadsheet-scroll">
            <table class="preview-spreadsheet-table">
              <colgroup><col class="preview-spreadsheet-rownum-col" />${colgroup}</colgroup>
              <thead><tr><th class="preview-spreadsheet-corner"></th>${Array.from({ length: columnCount }, (_, columnIndex) => `<th>${escapeHtml(spreadsheetColumnLabel(columnIndex))}</th>`).join('')}</tr></thead>
              <tbody>
                ${rows.map((row, rowIndex) => `<tr><th>${rowIndex + 1}</th>${Array.from({ length: columnCount }, (_, columnIndex) => `<td>${escapeHtml(row?.[columnIndex] || '')}</td>`).join('')}</tr>`).join('')}
              </tbody>
            </table>
          </div>
        </article>
      `;
    }).join('')}
  </section>`;
}

function spreadsheetColumnLabel(index = 0) {
  let value = Number(index) + 1;
  let label = '';
  while (value > 0) {
    const mod = (value - 1) % 26;
    label = String.fromCharCode(65 + mod) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label || 'A';
}

export function renderPptxPreview(item) {
  const slideImageUrls = Array.isArray(item.slide_image_urls || item.slideImageUrls)
    ? (item.slide_image_urls || item.slideImageUrls).filter(Boolean)
    : [];
  if (slideImageUrls.length) {
    return `
      <div class="preview-deck preview-deck-images">
        ${slideImageUrls.map((url, index) => `
          <section class="preview-deck-page">
            <div class="preview-slide-number">Slide ${formatNumber(index + 1)}</div>
            <img src="${escapeAttr(url)}" alt="${escapeAttr(`Slide ${index + 1}`)}" />
          </section>
        `).join('')}
      </div>
    `;
  }
  const officePdfUrl = item.office_pdf_url || item.officePdfUrl || '';
  if (officePdfUrl) {
    return `<iframe class="preview-frame preview-ppt-pdf" src="${escapeAttr(previewPdfFrameUrl(officePdfUrl))}" title="${escapeAttr(item.name || 'PPT 预览')}"></iframe>`;
  }
  if (item.preview_render_mode === 'fallback') {
    return `
      <div class="preview-deck-unavailable">
        <strong>当前环境无法生成与 PowerPoint 一致的视觉预览</strong>
        <p>为避免展示与真实 PPT 不一致的模拟页面，这里不再使用文本或兜底封面代替。请点击右上角“打开文件”查看真实效果。</p>
      </div>
    `;
  }
  const coverUrl = item.cover_url || item.coverUrl || item.deck_cover_url || '';
  return `
    <div class="preview-deck">
      ${coverUrl ? `
        <section class="preview-deck-cover">
          <img src="${escapeAttr(coverUrl)}" alt="${escapeAttr(item.name || 'PPT 封面预览')}" />
        </section>
      ` : ''}
      ${(item.slides || []).map((slide) => {
        const lines = Array.isArray(slide.text) ? slide.text : [];
        const elements = Array.isArray(slide.elements) ? slide.elements : [];
        const text = lines.length ? lines : elements.map((entry) => entry.text).filter(Boolean);
        return `
          <section class="preview-slide">
            <div class="preview-slide-number">Slide ${formatNumber(slide.index)}</div>
            <div class="preview-slide-content">
              ${text.map((line, index) => `<p class="${index === 0 ? 'lead' : ''}">${escapeHtml(line)}</p>`).join('') || '<p>无法解析该页文本。</p>'}
            </div>
          </section>
        `;
      }).join('') || (coverUrl ? '' : '<div class="empty small">无法解析 PPTX 文本预览。</div>')}
    </div>
  `;
}

export function shouldShowAccountUpdateButton() {
  const updates = state.updates;
  const agentUpdates = state.agentUpdates;
  return Boolean(
    updates?.available
    || updates?.downloaded
    || updates?.checking
    || updates?.downloading
    || agentUpdates?.available
    || agentUpdates?.downloaded
    || agentUpdates?.checking
    || agentUpdates?.downloading
    || agentUpdates?.applying,
  );
}
