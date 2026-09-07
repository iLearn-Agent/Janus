import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  availableTcpPort,
  captureSpawnedElectronFailureDiagnostics,
  terminateSpawnedProcess,
} from './lib/spawnedElectronDiagnostics.mjs';

const root = process.cwd();
const smokeHome = mkdtempSync(path.join(process.platform === 'linux' ? '/tmp' : os.tmpdir(), 'janus-global-ui-'));
const port = Number(process.env.JANUS_GLOBAL_UI_PORT || 0) || await availableTcpPort();
const screenshotDir = process.env.JANUS_GLOBAL_UI_SCREENSHOT_DIR || '';
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_UBUDDY_PROCESSING_MODE: 'fallback',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_HOME: smokeHome,
  JANUS_AUTH_URL: '',
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExe, [
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${path.join(smokeHome, 'profile')}`,
  `--remote-debugging-port=${port}`,
  '.',
], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
let failed = false;
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 15_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await waitForRenderer(cdp, `document.querySelector('.shell.network-panel-open [data-page-kind="messages"]')`);

  const messages = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell');
    const nav = [...document.querySelectorAll('[data-app-navigation] [data-app-nav]')];
    const active = nav.filter((item) => item.getAttribute('aria-current') === 'page');
    const first = nav[0];
    first?.focus();
    first?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const keyboardMoved = document.activeElement === nav[1];
    const focusOutline = getComputedStyle(nav[1]).outlineStyle;
    const shortcuts = [...document.querySelectorAll('.im-message-shortcut-avatar')];
    const shortcutButtons = [...document.querySelectorAll('.im-message-shortcut')];
    return {
      viewportWidth: innerWidth,
      pageKind: document.querySelector('#network-panel')?.dataset.pageKind || '',
      navCount: nav.length,
      activeCount: active.length,
      activeView: active[0]?.dataset.appNav || '',
      keyboardMoved,
      focusOutline,
      messageDefault: Boolean(document.querySelector('[data-message-default-page]')),
      employeeHomeRemoved: !document.querySelector('[data-message-employee-home], [data-message-employee-card]'),
      shortcutCount: shortcuts.length,
      shortcutBadgesRemoved: !document.querySelector('[data-network-peer="self-secretary"] .im-message-shortcut-badge')
        && !document.querySelector('[data-network-peer="self-private-assistant"] .im-message-shortcut-badge'),
      shortcutsInline: shortcutButtons.length === 2 && Math.abs(shortcutButtons[0].getBoundingClientRect().top - shortcutButtons[1].getBoundingClientRect().top) < 2,
      shortcutsCircular: shortcuts.every((item) => {
        const rect = item.getBoundingClientRect();
        return Math.abs(rect.width - rect.height) < 1 && Number.parseFloat(getComputedStyle(item).borderRadius) >= rect.width / 2 - 1;
      }),
      sharedAccent: getComputedStyle(shell).getPropertyValue('--ui-accent').trim(),
      headerHeight: document.querySelector('.network-panel-head')?.getBoundingClientRect().height || 0,
      messageSearchRemoved: !document.querySelector('[data-conversation-search-toggle], #network-conversation-search-popover, #network-conversation-search'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  })()`);
  assert(messages.pageKind === 'messages', `Messages page did not render: ${JSON.stringify(messages)}`);
  assert(messages.navCount === 3 && messages.activeCount === 1 && messages.activeView === 'messages', `Primary navigation state is inconsistent: ${JSON.stringify(messages)}`);
  assert(messages.keyboardMoved && messages.focusOutline !== 'none', `Primary navigation keyboard focus is incomplete: ${JSON.stringify(messages)}`);
  assert(messages.messageDefault && messages.employeeHomeRemoved, `Messages did not open on the quiet default page: ${JSON.stringify(messages)}`);
  assert(messages.shortcutCount === 2 && messages.shortcutBadgesRemoved && messages.shortcutsCircular && messages.shortcutsInline, `Message shortcuts are not compact inline entries: ${JSON.stringify(messages)}`);
  assert(messages.sharedAccent && messages.headerHeight >= 46 && messages.headerHeight <= 50 && messages.messageSearchRemoved && messages.noHorizontalOverflow, `Messages page does not use the shared frame: ${JSON.stringify(messages)}`);
  await evaluate(cdp, `document.querySelector('#account-card')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.account-area.is-open .account-menu')`);
  const accountMenuBounds = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const menu = document.querySelector('.account-menu')?.getBoundingClientRect();
    return {
      contained: Boolean(sidebar && menu && menu.left >= sidebar.left + 4 && menu.right <= sidebar.right - 4),
      sidebarWidth: Math.round(sidebar?.width || 0),
      menuWidth: Math.round(menu?.width || 0),
    };
  })()`);
  assert(accountMenuBounds.contained && accountMenuBounds.menuWidth <= accountMenuBounds.sidebarWidth - 8, `Account menu crosses into the main window: ${JSON.stringify(accountMenuBounds)}`);
  await evaluate(cdp, `document.querySelector('#account-card')?.click()`);
  await capture(cdp, 'messages-light.png');

  await evaluate(cdp, `document.querySelector('[data-network-peer="self-secretary"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-home-back]') && document.querySelector('#chat-input')`);
  await evaluate(cdp, `document.activeElement?.blur()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 220))`);
  const uBuddyComposerVisual = await evaluate(cdp, `(() => {
    const composer = document.querySelector('.composer.is-ubuddy-mode');
    const rect = composer?.getBoundingClientRect();
    return {
      border: composer ? getComputedStyle(composer).borderColor : '',
      x: rect ? rect.left + rect.width / 2 : 0,
      y: rect ? rect.top + rect.height / 2 : 0,
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: uBuddyComposerVisual.x, y: uBuddyComposerVisual.y });
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 220))`);
  const uBuddyComposerHoverBorder = await evaluate(cdp, `getComputedStyle(document.querySelector('.composer.is-ubuddy-mode')).borderColor`);
  assert(['rgb(216, 207, 247)', 'rgb(165, 139, 232)'].includes(uBuddyComposerVisual.border)
    && uBuddyComposerHoverBorder === 'rgb(165, 139, 232)',
    `uBuddy composer border colors are inconsistent: ${JSON.stringify({ uBuddyComposerVisual, uBuddyComposerHoverBorder })}`);
  const composerFocus = await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input?.focus();
    return {
      outline: input ? getComputedStyle(input).outlineStyle : '',
      homeOpen: Boolean(document.querySelector('[data-message-default-page]')),
      backVisible: Boolean(document.querySelector('[data-message-home-back]')),
    };
  })()`);
  assert(composerFocus.outline === 'none' && !composerFocus.homeOpen && composerFocus.backVisible, `Message chat switching or composer focus is inconsistent: ${JSON.stringify(composerFocus)}`);
  const uBuddyInitialComposerBounds = await evaluate(cdp, `(() => {
    const composer = document.querySelector('.composer.is-ubuddy-mode');
    const input = composer?.querySelector('#chat-input');
    const composerRect = composer?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    return {
      top: composerRect?.top || 0,
      width: composerRect?.width || 0,
      height: composerRect?.height || 0,
      inputTop: inputRect?.top || 0,
    };
  })()`);
  await evaluate(cdp, `document.querySelector('.project-mention-picker [data-social-mention-toggle]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-select-project-reference-workspace]')`);
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 180))`);
  const noProjectMention = await evaluate(cdp, `(() => {
    const button = document.querySelector('.project-reference-disabled');
    return {
      visible: Boolean(button && button.getBoundingClientRect().width > 0),
      text: button?.innerText || '',
      hasAddMark: Boolean(button?.querySelector('.project-reference-disabled-add')),
      hasAnyPlus: (button?.innerText || '').includes('+'),
    };
  })()`);
  assert(noProjectMention.visible && (noProjectMention.text.includes('选择文件夹后可以 @ 引用项目文件') || noProjectMention.text.includes('Choose a folder to @ mention project files'))
    && !noProjectMention.hasAddMark && !noProjectMention.hasAnyPlus,
  `uBuddy project-file entry must ask for a fresh folder without an add mark: ${JSON.stringify(noProjectMention)}`);
  await capture(cdp, 'ubuddy-mention-no-project.png');
  await evaluate(cdp, `document.querySelector('.project-mention-picker [data-social-mention-toggle]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-page]')`);

  await evaluate(cdp, `document.querySelector('[data-network-peer="self-private-assistant"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-image-entry-source="private_assistant"]') && document.querySelector('#chat-input')`);
  await evaluate(cdp, `document.activeElement?.blur()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 220))`);
  const privateComposerVisual = await evaluate(cdp, `(() => {
    const composer = document.querySelector('.composer.is-private-assistant-mode');
    const rect = composer?.getBoundingClientRect();
    return {
      border: composer ? getComputedStyle(composer).borderColor : '',
      x: rect ? rect.left + rect.width / 2 : 0,
      y: rect ? rect.top + rect.height / 2 : 0,
    };
  })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: privateComposerVisual.x, y: privateComposerVisual.y });
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 220))`);
  const privateComposerHoverBorder = await evaluate(cdp, `getComputedStyle(document.querySelector('.composer.is-private-assistant-mode')).borderColor`);
  assert(['rgb(168, 215, 204)', 'rgb(99, 184, 168)'].includes(privateComposerVisual.border)
    && privateComposerHoverBorder === 'rgb(99, 184, 168)',
    `Private assistant composer border colors are inconsistent: ${JSON.stringify({ privateComposerVisual, privateComposerHoverBorder })}`);
  const privateInitialComposerLayout = await evaluate(cdp, `(() => {
    const composer = document.querySelector('.composer.is-private-assistant-mode');
    const input = composer?.querySelector('#chat-input');
    const context = composer?.querySelector('.composer-context');
    const composerRect = composer?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const contextRect = context?.getBoundingClientRect();
    return {
      contextLabel: context?.textContent?.trim() || '',
      top: composerRect?.top || 0,
      width: composerRect?.width || 0,
      height: composerRect?.height || 0,
      inputTop: inputRect?.top || 0,
      contextBottom: contextRect?.bottom || 0,
    };
  })()`);
  assert((privateInitialComposerLayout.contextLabel.includes('私人助理') || privateInitialComposerLayout.contextLabel.includes('Private'))
    && Math.abs(privateInitialComposerLayout.top - uBuddyInitialComposerBounds.top) <= 1
    && Math.abs(privateInitialComposerLayout.width - uBuddyInitialComposerBounds.width) <= 1
    && privateInitialComposerLayout.contextBottom + 3 <= privateInitialComposerLayout.inputTop
    && privateInitialComposerLayout.inputTop > uBuddyInitialComposerBounds.inputTop,
  `Private assistant context label overlaps the input or the composers do not align horizontally: ${JSON.stringify({ uBuddyInitialComposerBounds, privateInitialComposerLayout })}`);
  await evaluate(cdp, `document.querySelector('[data-image-entry-source="private_assistant"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.composer.is-private-assistant-mode #image-model-trigger') && document.querySelector('[data-composer-image-mode].active')`);
  const inlineImageMode = await evaluate(cdp, `(() => {
    const composer = document.querySelector('.composer.is-private-assistant-mode');
    const modelLabel = document.querySelector('#image-model-trigger .config-model-label');
    const context = composer?.querySelector('.composer-context');
    return {
      privateComposer: Boolean(composer),
      imageModel: modelLabel?.textContent?.trim() || '',
      modelFullyVisible: Boolean(modelLabel && modelLabel.scrollWidth <= modelLabel.clientWidth + 1),
      contextCurrent: Boolean(context?.textContent?.includes('私人助理') || context?.textContent?.includes('Private')),
      stayedInMessageChat: Boolean(document.querySelector('[data-message-home-back]')),
      dedicatedImageHome: Boolean(document.querySelector('.image-home')),
      privateHeaderShield: Boolean(document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private svg')),
      privateHeaderAbbreviation: (document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private')?.textContent || '').includes('私助'),
    };
  })()`);
  assert(inlineImageMode.privateComposer && inlineImageMode.imageModel === 'GPT Image-2' && inlineImageMode.modelFullyVisible && inlineImageMode.contextCurrent
    && inlineImageMode.stayedInMessageChat && !inlineImageMode.dedicatedImageHome && inlineImageMode.privateHeaderShield && !inlineImageMode.privateHeaderAbbreviation,
  `Private assistant inline image layout is inconsistent: ${JSON.stringify(inlineImageMode)}`);
  await evaluate(cdp, `document.querySelector('#image-model-trigger')?.click()`);
  await waitForRenderer(cdp, `(() => {
    const trigger = document.querySelector('#image-model-trigger')?.getBoundingClientRect();
    const menu = document.querySelector('.image-model-menu')?.getBoundingClientRect();
    return Boolean(trigger && menu && menu.bottom <= trigger.top + 1);
  })()`);
  const imageModelMenu = await evaluate(cdp, `(() => {
    const trigger = document.querySelector('#image-model-trigger')?.getBoundingClientRect();
    const menu = document.querySelector('.image-model-menu')?.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    return {
      opensUp: Boolean(trigger && menu && menu.bottom <= trigger.top + 1),
      leftContained: Boolean(menu && main && menu.left >= Math.max(0, main.left) + 8),
      rightContained: Boolean(menu && main && menu.right <= Math.min(innerWidth, main.right) - 8),
    };
  })()`);
  assert(imageModelMenu.opensUp && imageModelMenu.leftContained && imageModelMenu.rightContained, `Image model menu is clipped or opens downward: ${JSON.stringify(imageModelMenu)}`);
  await capture(cdp, 'private-assistant-inline-image.png');
  await evaluate(cdp, `document.querySelector('#image-model-trigger')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-composer-image-mode]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.composer.is-private-assistant-mode #model-picker-trigger') && !document.querySelector('[data-composer-image-mode].active')`);
  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-page]')`);

  await evaluate(cdp, `document.querySelector('[data-message-default-variant="2"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-action="talent-market"]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-action="talent-market"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employees-view .talent-directory-installed.is-message-home-spotlight') && document.querySelector('.employees-view .talent-directory-section.is-message-home-spotlight') && document.activeElement?.id === 'employee-market-search'`);
  const talentArrival = await evaluate(cdp, `({
    activeView: document.querySelector('[data-app-nav][aria-current="page"]')?.dataset.appNav || '',
    spotlightCount: document.querySelectorAll('.employees-view .is-message-home-spotlight').length,
    searchFocused: document.activeElement?.id === 'employee-market-search',
  })`);
  assert(talentArrival.activeView === 'employees' && talentArrival.spotlightCount === 2 && talentArrival.searchFocused, `Message default action did not spotlight the talent market: ${JSON.stringify(talentArrival)}`);
  await capture(cdp, 'talent-arrival-spotlight.png');

  await evaluate(cdp, `document.querySelector('[data-app-nav="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#network-panel[data-page-kind="friends"] .im-directory-nav') && document.querySelector('.contacts-workspace')`);
  const contacts = await evaluate(cdp, `(() => ({
    pageKind: document.querySelector('#network-panel')?.dataset.pageKind || '',
    regionLabel: document.querySelector('.contacts-workspace')?.getAttribute('aria-label') || '',
    activeView: document.querySelector('[data-app-nav][aria-current="page"]')?.dataset.appNav || '',
    searchHeight: document.querySelector('#network-panel .directory-add-search')?.getBoundingClientRect().height || 0,
    searchInput: Boolean(document.querySelector('#network-panel #friend-search-query')),
    emptyStateLive: [...document.querySelectorAll('.contacts-workspace .im-list-empty')].every((item) => item.getAttribute('role') === 'status' && item.getAttribute('aria-live') === 'polite'),
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
  }))()`);
  assert(contacts.pageKind === 'friends' && contacts.regionLabel && contacts.activeView === 'friends', `Contacts page switching is inconsistent: ${JSON.stringify(contacts)}`);
  assert(contacts.searchInput && contacts.searchHeight >= 34 && contacts.emptyStateLive && contacts.noHorizontalOverflow, `Contacts page components are inconsistent: ${JSON.stringify(contacts)}`);
  await capture(cdp, 'contacts-light.png');

  await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.theme-dark .contacts-workspace')`);
  const contactsDark = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.theme-dark');
    const nav = document.querySelector('.im-directory-nav');
    const workspace = document.querySelector('.contacts-workspace');
    const list = document.querySelector('.contacts-list-pane');
    const search = document.querySelector('.directory-add-search label');
    const input = document.querySelector('#friend-search-query');
    const navText = document.querySelector('.im-directory-nav-item strong');
    const fixture = document.createElement('div');
    fixture.innerHTML = '<article class="contact-profile-card"><div class="contact-profile-cover"></div><div class="contact-profile-body"><span class="contact-profile-avatar">测</span><h2>测试联系人</h2><p>@contact</p><div class="contact-profile-actions"><button>备注</button></div></div></article>';
    shell.append(fixture);
    const card = fixture.querySelector('.contact-profile-card');
    const cardTitle = fixture.querySelector('h2');
    const secondary = fixture.querySelector('.contact-profile-actions button');
    const result = {
      dark: Boolean(shell),
      navBackground: getComputedStyle(nav).backgroundColor,
      workspaceBackground: getComputedStyle(workspace).backgroundColor,
      listBackground: getComputedStyle(list).backgroundColor,
      searchBackground: getComputedStyle(search).backgroundColor,
      inputContrast: contrastRatio(getComputedStyle(input).color, getComputedStyle(search).backgroundColor),
      navContrast: contrastRatio(getComputedStyle(navText).color, getComputedStyle(nav).backgroundColor),
      cardBackground: getComputedStyle(card).backgroundColor,
      cardContrast: contrastRatio(getComputedStyle(cardTitle).color, getComputedStyle(card).backgroundColor),
      secondaryBackground: getComputedStyle(secondary).backgroundColor,
      secondaryContrast: contrastRatio(getComputedStyle(secondary).color, getComputedStyle(secondary).backgroundColor),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    };
    fixture.remove();
    return result;
    function contrastRatio(foreground, background) {
      const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (rgb) => {
        const values = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const first = luminance(parse(foreground));
      const second = luminance(parse(background));
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
  })()`);
  const whiteSurface = 'rgb(255, 255, 255)';
  assert(contactsDark.dark && contactsDark.navBackground !== whiteSurface && contactsDark.workspaceBackground !== whiteSurface && contactsDark.listBackground !== whiteSurface && contactsDark.searchBackground !== whiteSurface && contactsDark.cardBackground !== whiteSurface && contactsDark.secondaryBackground !== whiteSurface, `Contacts dark surfaces remained white: ${JSON.stringify(contactsDark)}`);
  assert(contactsDark.inputContrast >= 4.5 && contactsDark.navContrast >= 4.5 && contactsDark.cardContrast >= 4.5 && contactsDark.secondaryContrast >= 4.5 && contactsDark.noHorizontalOverflow, `Contacts dark contrast is insufficient: ${JSON.stringify(contactsDark)}`);
  await capture(cdp, 'contacts-dark.png');
  await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell:not(.theme-dark) .contacts-workspace')`);

  await evaluate(cdp, `document.querySelector('[data-app-nav="employees"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employees-view[data-page-kind="employees"] #employees-page-title')`);
  const talentLight = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell');
    const view = document.querySelector('.employees-view');
    const card = document.querySelector('.talent-directory-card');
    const primary = document.querySelector('.talent-directory-primary');
    const stateChip = document.querySelector('.talent-directory-state');
    return {
      activeView: document.querySelector('[data-app-nav][aria-current="page"]')?.dataset.appNav || '',
      regionRole: view?.getAttribute('role') || '',
      labelledBy: view?.getAttribute('aria-labelledby') || '',
      themeButton: Boolean(document.querySelector('#theme-toggle-btn')),
      pageBackground: getComputedStyle(view).backgroundColor,
      cardCount: document.querySelectorAll('.talent-directory-card').length,
      rosterCardCount: document.querySelectorAll('.talent-directory-card.is-roster').length,
      cardRadius: card ? Number.parseFloat(getComputedStyle(card).borderRadius) : 0,
      cardBackground: card ? getComputedStyle(card).backgroundColor : '',
      primaryHeight: primary?.getBoundingClientRect().height || 0,
      stateFontSize: stateChip ? Number.parseFloat(getComputedStyle(stateChip).fontSize) : 0,
      browserSearchHeight: document.querySelector('.talent-directory-search')?.getBoundingClientRect().height || 0,
      installedListsGrid: [...document.querySelectorAll('.talent-directory-installed-list')].every((item) => getComputedStyle(item).display === 'grid'),
      installedListsNoOverflow: [...document.querySelectorAll('.talent-directory-installed-list')].every((item) => item.scrollWidth <= item.clientWidth + 1),
      emptyStateVisible: Boolean(document.querySelector('.talent-directory-empty')),
      emptyStatesLive: [...document.querySelectorAll('.talent-directory-empty')].every((item) => item.getAttribute('role') === 'status' && item.getAttribute('aria-live') === 'polite'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      sharedSurface: getComputedStyle(shell).getPropertyValue('--ui-surface').trim(),
    };
  })()`);
  assert(talentLight.activeView === 'employees' && talentLight.regionRole === 'region' && talentLight.labelledBy === 'employees-page-title', `Talent page structure is inconsistent: ${JSON.stringify(talentLight)}`);
  const talentContentValid = talentLight.cardCount
    ? talentLight.cardRadius >= 10 && talentLight.primaryHeight >= 30 && (!talentLight.rosterCardCount || talentLight.stateFontSize >= 10)
    : talentLight.emptyStateVisible && talentLight.browserSearchHeight >= 34;
  assert(talentLight.themeButton && talentContentValid && talentLight.installedListsGrid && talentLight.installedListsNoOverflow && talentLight.emptyStatesLive && talentLight.noHorizontalOverflow, `Talent components are inconsistent: ${JSON.stringify(talentLight)}`);
  await capture(cdp, 'talent-light.png');

  await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.theme-dark .employees-view')`);
  const talentDark = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.theme-dark');
    const view = document.querySelector('.employees-view');
    const card = document.querySelector('.talent-directory-card');
    const title = document.querySelector('#employees-page-title');
    return {
      dark: Boolean(shell),
      pageBackground: getComputedStyle(view).backgroundColor,
      cardBackground: card ? getComputedStyle(card).backgroundColor : '',
      titleColor: getComputedStyle(title).color,
      pageContrast: contrastRatio(getComputedStyle(title).color, getComputedStyle(view).backgroundColor),
      cardContrast: card ? contrastRatio(getComputedStyle(card).color, getComputedStyle(card).backgroundColor) : 7,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    };
    function contrastRatio(foreground, background) {
      const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (rgb) => {
        const values = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const first = luminance(parse(foreground));
      const second = luminance(parse(background));
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
  })()`);
  assert(talentDark.dark && talentDark.pageBackground !== talentLight.pageBackground && (!talentLight.cardCount || talentDark.cardBackground !== talentLight.cardBackground), `Dark theme surfaces did not change: ${JSON.stringify({ talentLight, talentDark })}`);
  assert(talentDark.pageContrast >= 4.5 && talentDark.cardContrast >= 4.5 && talentDark.noHorizontalOverflow, `Dark theme contrast is insufficient: ${JSON.stringify(talentDark)}`);
  await capture(cdp, 'talent-dark.png');

  const finalState = await evaluate(cdp, `({
    activeView: document.querySelector('[data-app-nav][aria-current="page"]')?.dataset.appNav || '',
    dark: Boolean(document.querySelector('.shell.theme-dark')),
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
  })`);
  assert(finalState.activeView === 'employees' && finalState.dark && finalState.noHorizontalOverflow, `Theme or page state was lost during switching: ${JSON.stringify(finalState)}`);

  console.log(`global UI consistency smoke passed (${messages.viewportWidth}px, inline image mode, messages/contacts/talent, light/dark, keyboard navigation)`);
  cdp.close();
} catch (error) {
  failed = true;
  await captureSpawnedElectronFailureDiagnostics({ child, error, stderr, port, runtimeHome: smokeHome, name: 'global-ui' });
  throw error;
} finally {
  await terminateSpawnedProcess(child);
  if (!failed || !process.env.JANUS_TEST_ARTIFACT_DIR) rmSync(smokeHome, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function capture(cdp, filename) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(screenshotDir, filename), Buffer.from(screenshot.data, 'base64'));
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Electron renderer did not start: ${stderr.slice(-1600)}`);
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() { socket.close(); },
  };
}
