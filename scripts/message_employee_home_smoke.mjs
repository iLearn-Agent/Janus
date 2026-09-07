import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  availableTcpPort,
  captureSpawnedElectronFailureDiagnostics,
  terminateSpawnedProcess,
} from './lib/spawnedElectronDiagnostics.mjs';

const root = process.cwd();
const smokeHome = mkdtempSync(path.join(process.platform === 'linux' ? '/tmp' : os.tmpdir(), 'janus-message-workspace-'));
const port = Number(process.env.JANUS_MESSAGE_EMPLOYEE_PORT || 0) || await availableTcpPort();
const screenshotDir = process.env.JANUS_MESSAGE_EMPLOYEE_SCREENSHOT_DIR || '';
const stateEntry = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'state.js')).href;
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
], { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
let failed = false;
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 15_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-page]') && document.querySelector('[data-message-groups-toggle]')`);

  const defaultPage = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.message-layout');
    const panel = document.querySelector('#network-panel[data-page-kind="messages"]');
    const page = document.querySelector('[data-message-default-page]');
    const shortcuts = [...document.querySelectorAll('.im-message-shortcut')];
    const avatars = shortcuts.map((item) => item.querySelector('.im-message-shortcut-avatar'));
    const panelList = document.querySelector('.im-conversation-list');
    const mainRect = document.querySelector('.main')?.getBoundingClientRect();
    const pageRect = page?.getBoundingClientRect();
    const contentRect = page?.querySelector('.message-default-content')?.getBoundingClientRect();
    return {
      shell: Boolean(shell),
      panel: Boolean(panel),
      defaultText: page?.textContent?.trim() || '',
      contentHeight: Math.round(page?.querySelector('.message-default-content')?.getBoundingClientRect().height || 0),
      employeeHomeRemoved: !document.querySelector('[data-message-employee-home], [data-message-employee-card]'),
      shortcutCount: shortcuts.length,
      pinnedRowMaxHeight: Math.max(...shortcuts.map((item) => item.getBoundingClientRect().height)),
      shortcutRowWidth: shortcuts.reduce((total, item) => total + item.getBoundingClientRect().width, 0),
      shortcutAreaHeight: Math.round(document.querySelector('.im-message-shortcuts')?.getBoundingClientRect().height || 0),
      headerShortcutGap: (() => {
        const header = document.querySelector('.message-panel-head')?.getBoundingClientRect();
        const shortcuts = document.querySelector('.im-message-shortcuts')?.getBoundingClientRect();
        return header && shortcuts ? Math.round(shortcuts.top - header.bottom) : -1;
      })(),
      inlineSearchRemoved: !document.querySelector('#network-conversation-search'),
      searchAtHeaderRight: (() => {
        const header = document.querySelector('.message-panel-head')?.getBoundingClientRect();
        const trigger = document.querySelector('.message-panel-head > #sidebar-chat-search-trigger')?.getBoundingClientRect();
        return Boolean(header && trigger && header.right - trigger.right >= 10 && header.right - trigger.right <= 14);
      })(),
      searchRemovedFromBrand: !document.querySelector('.brand #sidebar-chat-search-trigger'),
      messageHeaderDividerRemoved: getComputedStyle(document.querySelector('.network-panel-head')).borderBottomWidth === '0px',
      shortcutDividerRemoved: getComputedStyle(document.querySelector('.im-message-shortcuts')).borderBottomWidth === '0px',
      verticalShortcuts: shortcuts.every((item, index) => {
        const avatarRect = avatars[index]?.getBoundingClientRect();
        const copyRect = item.querySelector('.im-message-shortcut-copy')?.getBoundingClientRect();
        return avatarRect && copyRect && copyRect.top >= avatarRect.bottom;
      }),
      shortcutDefaultBadgesRemoved: shortcuts.every((item) => !item.querySelector('.im-message-shortcut-badge')),
      shortcutContentCentered: shortcuts.every((item, index) => {
        const avatarRect = avatars[index]?.getBoundingClientRect();
        const copyRect = item.querySelector('.im-message-shortcut-copy')?.getBoundingClientRect();
        return avatarRect && copyRect && Math.abs((avatarRect.left + avatarRect.width / 2) - (copyRect.left + copyRect.width / 2)) <= 1;
      }),
      shortcutSummariesRemoved: shortcuts.every((item) => !item.querySelector('em')),
      circularAvatars: avatars.every((avatar) => {
        const rect = avatar?.getBoundingClientRect();
        return rect && Math.abs(rect.width - rect.height) < 1 && Number.parseFloat(getComputedStyle(avatar).borderRadius) >= rect.width / 2 - 1;
      }),
      listScroll: panelList ? getComputedStyle(panelList).overflowY : '',
      mainScrollSeparated: document.querySelector('.main') !== panel,
      resizerVisibleOnMessageHome: getComputedStyle(document.querySelector('[data-message-pane-resizer]')).display !== 'none',
      resizerCenteredOnMessageHome: (() => {
        const panelRect = panel?.getBoundingClientRect();
        const mainRect = document.querySelector('.main')?.getBoundingClientRect();
        const resizerRect = document.querySelector('[data-message-pane-resizer]')?.getBoundingClientRect();
        return Boolean(panelRect && mainRect && resizerRect
          && Math.abs((resizerRect.left + resizerRect.width / 2) - ((panelRect.right + mainRect.left) / 2)) <= 1);
      })(),
      resizerCoversPaneGap: (() => {
        const panelRect = panel?.getBoundingClientRect();
        const mainRect = document.querySelector('.main')?.getBoundingClientRect();
        const resizerRect = document.querySelector('[data-message-pane-resizer]')?.getBoundingClientRect();
        return Boolean(panelRect && mainRect && resizerRect && resizerRect.left <= panelRect.right && resizerRect.right >= mainRect.left);
      })(),
      resizerIdleOpacity: Number.parseFloat(getComputedStyle(document.querySelector('[data-message-pane-resizer]'), '::after').opacity),
      resizerCursor: getComputedStyle(document.querySelector('[data-message-pane-resizer]')).cursor,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
      noPhantomResponsiveHeader: !document.querySelector('.message-responsive-utility'),
      pageFillsMain: Boolean(mainRect && pageRect
        && Math.abs(pageRect.top - mainRect.top) <= 1
        && Math.abs(pageRect.bottom - mainRect.bottom) <= 1),
      contentVerticallyCentered: Boolean(pageRect && contentRect
        && Math.abs((pageRect.top + pageRect.height / 2) - (contentRect.top + contentRect.height / 2)) <= 80),
    };
  })()`);
  assert(defaultPage.shell && defaultPage.panel && (defaultPage.defaultText.includes('优秀的你，值得一朵小红花') || defaultPage.defaultText.includes('You deserve a little celebration.')), `Message default page is incomplete: ${JSON.stringify(defaultPage)}`);
  assert(defaultPage.employeeHomeRemoved && defaultPage.shortcutCount === 2 && defaultPage.pinnedRowMaxHeight <= 64 && defaultPage.shortcutAreaHeight <= 72 && defaultPage.shortcutRowWidth <= 210 && defaultPage.headerShortcutGap >= 0 && defaultPage.headerShortcutGap <= 2 && defaultPage.inlineSearchRemoved && defaultPage.searchAtHeaderRight && defaultPage.searchRemovedFromBrand && defaultPage.verticalShortcuts && defaultPage.shortcutDefaultBadgesRemoved && defaultPage.shortcutContentCentered && defaultPage.shortcutSummariesRemoved && defaultPage.circularAvatars && defaultPage.messageHeaderDividerRemoved && defaultPage.shortcutDividerRemoved, `Conversation list did not replace the employee home cleanly: ${JSON.stringify(defaultPage)}`);
  assert(defaultPage.listScroll === 'auto' && defaultPage.mainScrollSeparated && defaultPage.resizerVisibleOnMessageHome && defaultPage.resizerCenteredOnMessageHome && defaultPage.resizerCoversPaneGap && defaultPage.resizerIdleOpacity === 0 && defaultPage.resizerCursor === 'ew-resize' && defaultPage.noHorizontalOverflow, `Message columns do not scroll independently: ${JSON.stringify(defaultPage)}`);
  assert(defaultPage.noPhantomResponsiveHeader && defaultPage.pageFillsMain && defaultPage.contentVerticallyCentered,
    `Wide message default page is displaced or split by a hidden responsive header: ${JSON.stringify(defaultPage)}`);
  const defaultResizerCenter = await evaluate(cdp, `(() => {
    const rect = document.querySelector('[data-message-pane-resizer]')?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + Math.min(32, rect.height / 2) } : null;
  })()`);
  assert(defaultResizerCenter, 'Message pane resizer position is unavailable.');
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: defaultResizerCenter.x,
    y: defaultResizerCenter.y,
  });
  await waitForRenderer(cdp, `(() => {
    const style = getComputedStyle(document.querySelector('[data-message-pane-resizer]'), '::after');
    return Number.parseFloat(style.opacity) >= .99 && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  })()`, 3_000);
  const resizerHover = await evaluate(cdp, `(() => {
    const resizer=document.querySelector('[data-message-pane-resizer]');const style=getComputedStyle(resizer,'::after');
    return {opacity:Number.parseFloat(style.opacity),width:Number.parseFloat(style.width),background:style.backgroundColor};
  })()`);
  assert(resizerHover.opacity === 1 && resizerHover.width >= 2 && resizerHover.background !== 'rgba(0, 0, 0, 0)', `Message pane resizer hover affordance is incomplete: ${JSON.stringify(resizerHover)}`);
  await capture(cdp, 'message-resizer-hover.png');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  await capture(cdp, 'message-default.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-compact.message-pane-list') && document.querySelector('[data-message-default-page]')`);
  const compactDefault = await evaluate(cdp, `(() => {
    const main = document.querySelector('.main')?.getBoundingClientRect();
    const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
    const page = document.querySelector('[data-message-default-page]')?.getBoundingClientRect();
    const content = document.querySelector('.message-default-content')?.getBoundingClientRect();
    return {
      panelWidth: Math.round(panel?.width || 0),
      mainWidth: Math.round(main?.width || 0),
      noPhantomResponsiveHeader: !document.querySelector('.message-responsive-utility'),
      pageFillsMain: Boolean(main && page && Math.abs(page.top - main.top) <= 1 && Math.abs(page.bottom - main.bottom) <= 1),
      contentVerticallyCentered: Boolean(page && content && Math.abs((page.top + page.height / 2) - (content.top + content.height / 2)) <= 80),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert(compactDefault.panelWidth >= 280 && compactDefault.panelWidth <= 420 && compactDefault.mainWidth >= 360
    && compactDefault.noPhantomResponsiveHeader && compactDefault.pageFillsMain
    && compactDefault.contentVerticallyCentered && !compactDefault.horizontalOverflow,
  `Compact message default page is squeezed or displaced: ${JSON.stringify(compactDefault)}`);
  await capture(cdp, 'message-compact-default.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-wide.message-pane-list')`);

  const firstPageNavigation = await evaluate(cdp, `(() => {
    const page = document.querySelector('[data-message-default-page]')?.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('[data-message-default-step]')];
    return {
      previous: Boolean(document.querySelector('[data-message-default-step="previous"]')),
      next: Boolean(document.querySelector('[data-message-default-step="next"]')),
      verticalOffsets: page ? buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return Math.round((page.top + page.height / 2) - (rect.top + rect.height / 2));
      }) : [],
    };
  })()`);
  assert(firstPageNavigation.previous && firstPageNavigation.next, `Default page cyclic navigation is missing: ${JSON.stringify(firstPageNavigation)}`);
  assert(firstPageNavigation.verticalOffsets.length === 2
    && firstPageNavigation.verticalOffsets.every((offset) => offset >= 13 && offset <= 15),
  `Default page cyclic navigation was not raised by the intended amount: ${JSON.stringify(firstPageNavigation)}`);
  await evaluate(cdp, `document.querySelector('[data-message-default-step="previous"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="2"]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-step="next"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="0"]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-step="next"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="1"]') && document.querySelector('[data-message-default-step="previous"]') && document.querySelector('[data-message-default-step="next"]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-step="previous"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="0"]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-order-toggle]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-order-editor]') && document.querySelectorAll('[data-message-default-order-item]').length === 3`);
  const refreshedDefaultAnimation = await evaluate(cdp, `(() => {
    const content = document.querySelector('.message-default-content');
    const visual = content?.querySelector('.message-default-visual');
    return { refresh: content?.classList.contains('is-refresh'), animationName: visual ? getComputedStyle(visual).animationName : '' };
  })()`);
  assert(refreshedDefaultAnimation.refresh && refreshedDefaultAnimation.animationName === 'none',
    `A same-page refresh replayed the default-page entrance animation: ${JSON.stringify(refreshedDefaultAnimation)}`);
  await evaluate(cdp, `document.querySelector('.message-default-copy')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-message-default-order-editor]')`);
  await evaluate(cdp, `document.querySelector('[data-message-default-order-toggle]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-order-editor]') && document.querySelectorAll('[data-message-default-order-item]').length === 3`);
  const orderEditor = await evaluate(cdp, `({
    items: [...document.querySelectorAll('[data-message-default-order-item]')].map((item) => item.dataset.messageDefaultOrderItem),
    draggable: [...document.querySelectorAll('[data-message-default-order-item]')].every((item) => item.draggable),
  })`);
  assert(JSON.stringify(orderEditor.items) === JSON.stringify(['0', '1', '2']),
    `Default-page order thumbnails are wrong: ${JSON.stringify(orderEditor.items)}`);
  assert(orderEditor.draggable, 'Default-page order thumbnails must be draggable');
  await evaluate(cdp, `document.querySelector('[data-message-default-order-reset]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-message-default-order-editor]')`);

  await evaluate(cdp, `document.querySelector('[data-message-default-variant="1"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="1"]')`);
  const quietTaskDefault = await evaluate(cdp, `({
    title: document.querySelector('.message-default-copy h2')?.textContent || '',
    action: document.querySelector('[data-message-default-action="ubuddy"]')?.textContent || '',
    hasOrbit: Boolean(document.querySelector('.message-default-orbit')),
    contentHeight: Math.round(document.querySelector('.message-default-content')?.getBoundingClientRect().height || 0),
  })`);
  assert((quietTaskDefault.title.includes('复杂的事') || quietTaskDefault.title.includes('complex clear')) && quietTaskDefault.action.includes('uBuddy') && quietTaskDefault.hasOrbit, `Quiet task default-page variant is incomplete: ${JSON.stringify(quietTaskDefault)}`);
  await capture(cdp, 'message-default-quiet-task.png');

  await evaluate(cdp, `document.querySelector('[data-message-default-variant="2"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="2"]')`);
  const collaborationDefault = await evaluate(cdp, `({
    title: document.querySelector('.message-default-copy h2')?.textContent || '',
    action: document.querySelector('[data-message-default-action="talent-market"]')?.textContent || '',
    avatarCount: document.querySelectorAll('.message-default-collaboration .collaboration-avatar').length,
    contentHeight: Math.round(document.querySelector('.message-default-content')?.getBoundingClientRect().height || 0),
  })`);
  assert((collaborationDefault.title.includes('开始协作') || collaborationDefault.title.includes('collaborate')) && (collaborationDefault.action.includes('开始新会话') || collaborationDefault.action.includes('Start New Chat')) && collaborationDefault.avatarCount === 3, `Collaboration default-page variant is incomplete: ${JSON.stringify(collaborationDefault)}`);
  assert(Math.max(defaultPage.contentHeight, collaborationDefault.contentHeight, quietTaskDefault.contentHeight) - Math.min(defaultPage.contentHeight, collaborationDefault.contentHeight, quietTaskDefault.contentHeight) <= 1, `Default-page variants do not share one stable height: ${JSON.stringify({ flower: defaultPage.contentHeight, collaboration: collaborationDefault.contentHeight, quietTask: quietTaskDefault.contentHeight })}`);
  await capture(cdp, 'message-default-collaboration.png');
  await evaluate(cdp, `document.querySelector('[data-message-default-variant="0"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-variant-index="0"]')`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 560, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list') && getComputedStyle(document.querySelector('#network-panel')).display !== 'none'`);
  await evaluate(cdp, `document.querySelector('#network-panel [data-message-pane="conversation"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-conversation') && document.querySelector('[data-message-default-page]')`);
  const narrowDefault = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    const page = document.querySelector('[data-message-default-page]')?.getBoundingClientRect();
    const content = document.querySelector('.message-default-content')?.getBoundingClientRect();
    const heading = document.querySelector('.message-default-copy h2')?.getBoundingClientRect();
    const visual = document.querySelector('.message-default-visual')?.getBoundingClientRect();
    return {
      sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
      sidebarWidth: Math.round(sidebar?.width || 0),
      mainWidth: Math.round(main?.width || 0),
      pageContainsContent: Boolean(page && content && content.left >= page.left - 1 && content.right <= page.right + 1),
      headingContained: Boolean(page && heading && heading.left >= page.left - 1 && heading.right <= page.right + 1),
      visualDoesNotOverlapHeading: Boolean(visual && heading && visual.bottom <= heading.top - 4),
      visualBottom: Math.round(visual?.bottom || 0),
      headingTop: Math.round(heading?.top || 0),
      pageScroll: getComputedStyle(document.querySelector('[data-message-default-page]')).overflowY,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      conversationTabActive: Boolean(document.querySelector('.main [data-message-pane="conversation"].active')),
    };
  })()`);
  assert(narrowDefault.sidebarVisible && narrowDefault.sidebarWidth >= 64 && narrowDefault.sidebarWidth <= 76
    && narrowDefault.mainWidth >= 620 && narrowDefault.pageContainsContent && narrowDefault.headingContained
    && narrowDefault.visualDoesNotOverlapHeading
    && ['auto', 'scroll'].includes(narrowDefault.pageScroll) && !narrowDefault.horizontalOverflow
    && narrowDefault.conversationTabActive,
  `Narrow default message page is clipped or inaccessible: ${JSON.stringify(narrowDefault)}`);
  await capture(cdp, 'message-narrow-default.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 620, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-conversation') && document.querySelector('[data-message-default-page]')`);
  const ultraNarrowDefault = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    const page = document.querySelector('[data-message-default-page]')?.getBoundingClientRect();
    const content = document.querySelector('.message-default-content')?.getBoundingClientRect();
    const visual = document.querySelector('.message-default-visual')?.getBoundingClientRect();
    const heading = document.querySelector('.message-default-copy h2')?.getBoundingClientRect();
    const tabs = document.querySelector('.main .message-responsive-tabs')?.getBoundingClientRect();
    const visibleMenus = [...document.querySelectorAll('.desktop-menu')].filter((item) => getComputedStyle(item).display !== 'none');
    const lastMenu = visibleMenus.at(-1)?.getBoundingClientRect();
    const themeToggle = document.querySelector('.global-theme-toggle')?.getBoundingClientRect();
    const windowControls = document.querySelector('.window-controls')?.getBoundingClientRect();
    return {
      sidebarWidth: Math.round(sidebar?.width || 0),
      mainWidth: Math.round(main?.width || 0),
      contentContained: Boolean(page && content && content.left >= page.left - 1 && content.right <= page.right + 1),
      visualDoesNotOverlapHeading: Boolean(visual && heading && visual.bottom <= heading.top - 4),
      tabsContained: Boolean(main && tabs && tabs.left >= main.left && tabs.right <= main.right),
      titlebarContained: document.querySelector('.window-titlebar')?.scrollWidth <= document.querySelector('.window-titlebar')?.clientWidth + 1,
      titlebarControlsDoNotOverlap: Boolean(lastMenu && themeToggle && windowControls
        && lastMenu.right <= themeToggle.left - 4 && themeToggle.right <= windowControls.left),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert(ultraNarrowDefault.sidebarWidth >= 64 && ultraNarrowDefault.sidebarWidth <= 76
    && ultraNarrowDefault.mainWidth >= 380 && ultraNarrowDefault.contentContained
    && ultraNarrowDefault.visualDoesNotOverlapHeading
    && ultraNarrowDefault.tabsContained && ultraNarrowDefault.titlebarContained
    && ultraNarrowDefault.titlebarControlsDoNotOverlap
    && !ultraNarrowDefault.horizontalOverflow,
  `Ultra-narrow message default page is clipped: ${JSON.stringify(ultraNarrowDefault)}`);
  await capture(cdp, 'message-ultra-narrow-default.png');
  await evaluate(cdp, `document.querySelector('.main [data-message-pane="list"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list')`);
  const ultraNarrowList = await evaluate(cdp, `(() => {
    const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
    const tabs = document.querySelector('#network-panel .message-responsive-tabs')?.getBoundingClientRect();
    const navIcon = document.querySelector('[data-network-view="messages"] .nav-icon svg');
    const navIconRect = navIcon?.getBoundingClientRect();
    return {
      panelWidth: Math.round(panel?.width || 0),
      tabsContained: Boolean(panel && tabs && tabs.left >= panel.left && tabs.right <= panel.right),
      primaryNavIconVisible: Boolean(navIconRect && navIconRect.width >= 18 && navIconRect.height >= 18
        && getComputedStyle(navIcon).visibility === 'visible' && Number.parseFloat(getComputedStyle(navIcon).opacity) === 1),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert(ultraNarrowList.panelWidth >= 380 && ultraNarrowList.tabsContained && ultraNarrowList.primaryNavIconVisible
    && !ultraNarrowList.horizontalOverflow,
    `Ultra-narrow message list is clipped: ${JSON.stringify(ultraNarrowList)}`);
  await capture(cdp, 'message-ultra-narrow-list.png');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list')`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 901, height: 700, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-compact.message-pane-list')`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-wide.message-pane-list')`);

  await evaluate(cdp, `document.querySelector('.message-panel-head [data-message-groups-toggle]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.message-group-sidebar [data-message-filter="all"]')`);
  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.org = {
      ...(state.org || {}),
      departments: [...(state.org?.departments || []).filter((item) => item.id !== 'message_layout_department'), { id: 'message_layout_department', name: '消息布局测试' }],
      agents: [...(state.org?.agents || []).filter((item) => !['message_layout_agent', 'message_employee_agent'].includes(item.id)),
        { id: 'message_layout_agent', name: '布局 Agent', departmentId: 'message_layout_department', routable: true },
        { id: 'message_employee_agent', name: '员工 Agent', departmentId: 'message_layout_department', routable: true }],
    };
    state.employeeOverview = {
      ...(state.employeeOverview || {}),
      roster: [...(state.employeeOverview?.roster || []).filter((item) => item.id !== 'message_employee_instance'), {
        id: 'message_employee_instance', agentFamilyId: 'message_employee_agent', displayName: '无会话员工',
        employmentState: 'active', routeEligible: true, availability: 'working', workState: 'running',
        currentWork: { title: '整理需求清单', status: 'running' }, family: { departmentId: 'message_layout_department' },
      }],
    };
    state.sessions = (state.sessions || []).filter((item) => item.agentId !== 'message_layout_agent');
    state.chatRuns = [];
    state.activeChatRun = null;
    state.currentSessionId = '';
    state.currentChatKey = 'message-layout-selected-chat';
    state.currentDepartmentId = 'message_layout_department';
    state.currentAgentId = 'message_layout_agent';
    state.selectionSource = null;
    state.homeMode = 'department';
    state.networkMessageHomeOpen = false;
    state.chatGroupId = 'message-layout-source-group';
    state.chatGroupDetail = {
      group: { id: 'message-layout-source-group', title: 'Agent 跳转来源群聊', status: 'active', ownerUserId: state.currentUser?.id || '' },
      membership: { userId: state.currentUser?.id || '', role: 'owner', status: 'active' },
      members: [{ userId: state.currentUser?.id || '', role: 'owner', status: 'active', user: state.currentUser }],
      messages: [],
    };
    document.querySelector('[data-message-filter="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-inbox="message_layout_agent"]')`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-inbox-instance="message_employee_instance"]')`);
  await waitForRenderer(cdp, `document.querySelector('.natural-chat-group-view')?.textContent.includes('Agent 跳转来源群聊')`);
  const selectedAgentConversation = await evaluate(cdp, `(() => ({
    visible: Boolean(document.querySelector('[data-agent-inbox="message_layout_agent"]')),
    employeeWithoutSessionVisible: Boolean(document.querySelector('[data-agent-inbox-instance="message_employee_instance"]')),
    employeeWorkPreview: document.querySelector('[data-agent-inbox-instance="message_employee_instance"] .network-message-preview')?.textContent?.trim() || '',
    inlineSearchRemoved: !document.querySelector('#network-conversation-search'),
    messageSearchVisible: Boolean(document.querySelector('.message-panel-head > #sidebar-chat-search-trigger')),
    brandSearchRemoved: !document.querySelector('.brand #sidebar-chat-search-trigger'),
    hasStoredSessionTarget: Boolean(document.querySelector('[data-agent-message-row="message_layout_agent"][data-network-session]')),
    preview: document.querySelector('[data-agent-message-row="message_layout_agent"] .network-message-preview')?.textContent?.trim() || '',
  }))()`);
  assert(selectedAgentConversation.visible && selectedAgentConversation.employeeWithoutSessionVisible
    && selectedAgentConversation.employeeWorkPreview.includes('整理需求清单')
    && selectedAgentConversation.inlineSearchRemoved && selectedAgentConversation.messageSearchVisible
    && selectedAgentConversation.brandSearchRemoved && !selectedAgentConversation.hasStoredSessionTarget,
  `Messages did not include the full employee roster and live work state: ${JSON.stringify(selectedAgentConversation)}`);
  await evaluate(cdp, `document.querySelector('[data-message-system-entry="follower"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-follower-workspace]')`);
  await evaluate(cdp, `document.querySelector('[data-agent-inbox="message_layout_agent"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-inbox="message_layout_agent"].active') && !document.querySelector('.natural-chat-group-view') && document.querySelector('#chat-input')`);
  const composerFocusRefresh = await evaluate(cdp, `new Promise((resolve) => {
    const original = document.querySelector('#chat-input');
    original?.focus();
    const timeout = setTimeout(() => resolve({ timedOut: true }), 2000);
    const observer = new MutationObserver(() => {
      const input = document.querySelector('#chat-input');
      if (!input || input === original || document.activeElement !== input) return;
      clearTimeout(timeout);
      observer.disconnect();
      const composer = input.closest('.composer');
      resolve({
        timedOut: false,
        refreshing: document.documentElement.classList.contains('is-render-refreshing'),
        transitionDuration: composer ? getComputedStyle(composer).transitionDuration : '',
      });
    });
    observer.observe(document.querySelector('#app'), { childList: true, subtree: true });
    window.dispatchEvent(new Event('resize'));
  })`);
  assert(!composerFocusRefresh.timedOut && composerFocusRefresh.refreshing && composerFocusRefresh.transitionDuration === '0s',
    `Composer focus restoration replayed its highlight transition: ${JSON.stringify(composerFocusRefresh)}`);
  const selectedAgentFromGroup = await evaluate(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => ({
    chatGroupId: state.chatGroupId,
    chatGroupDetail: state.chatGroupDetail,
    currentAgentId: state.currentAgentId,
    followerWorkspaceOpen: state.followerWorkspaceOpen,
    agentRowActive: Boolean(document.querySelector('[data-agent-inbox="message_layout_agent"].active')),
  }))`);
  assert(selectedAgentFromGroup.chatGroupId === ''
    && selectedAgentFromGroup.chatGroupDetail === null
    && selectedAgentFromGroup.currentAgentId === 'message_layout_agent'
    && selectedAgentFromGroup.followerWorkspaceOpen === false
    && selectedAgentFromGroup.agentRowActive,
  `Follower or natural group state blocked an unsaved Agent conversation: ${JSON.stringify(selectedAgentFromGroup)}`);

  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    const session = {
      id: 'message-employee-history-session', title: '员工当前对话', agentId: 'message_employee_agent',
      agentInstanceId: 'message_employee_instance', departmentId: 'message_layout_department', status: 'active',
      conversationRole: 'primary', writeState: 'writable', updatedAt: '2026-08-03T10:00:00.000Z',
    };
    state.sessions = [session, ...(state.sessions || []).filter((item) => item.id !== session.id)];
    state.currentTab = 'chat';
    state.currentSessionId = session.id;
    state.currentChatKey = 'session:' + session.id;
    state.currentAgentId = 'message_employee_agent';
    state.currentAgentInstanceId = 'message_employee_instance';
    state.currentDepartmentId = 'message_layout_department';
    state.messages = [{ id: 'message-employee-current', role: 'assistant', content: '当前对话内容', createdAt: '2026-08-03T10:00:00.000Z', metadata: {} }];
    state.employeeConversationOverviewByInstanceId = {
      ...(state.employeeConversationOverviewByInstanceId || {}),
      message_employee_instance: {
        primarySession: session,
        activeWork: { route: 'none', sessionId: '', taskRunId: '' },
        historyGroups: [{ id: 'memory:history-memory', kind: 'memory', title: '旧 Memory', summary: '历史讨论摘要', messageCount: 2, lastMessageAt: '2026-08-02T09:00:00.000Z', memoryDocumentId: 'history-memory', readOnly: true }],
      },
    };
    state.employeeConversationHistoryViewer = null;
    state.networkMessageHomeOpen = false;
    document.querySelector('[data-message-filter="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-history-group="memory:history-memory"]') && document.querySelector('#message-list')?.textContent.includes('当前对话内容')`);
  const employeeHistoryEntry = await evaluate(cdp, `({
    historyVisible: Boolean(document.querySelector('[data-employee-history-group="memory:history-memory"]')),
    historyLabel: document.querySelector('.employee-conversation-history summary')?.textContent?.trim() || '',
    currentComposerVisible: Boolean(document.querySelector('#chat-input')),
  })`);
  assert(employeeHistoryEntry.historyVisible && /(?:历史对话|Conversation details)\s*·?\s*1/.test(employeeHistoryEntry.historyLabel) && employeeHistoryEntry.currentComposerVisible,
    `Employee history groups are not visible from the current conversation: ${JSON.stringify(employeeHistoryEntry)}`);
  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.employeeConversationHistoryViewer = {
      agentInstanceId: 'message_employee_instance', historyGroupId: 'memory:history-memory', loading: false, error: '',
      detail: {
        group: { id: 'memory:history-memory', kind: 'memory', title: '旧 Memory', messageCount: 2, readOnly: true },
        messages: [
          { id: 'employee-history-user', role: 'user', content: '以前的用户问题', createdAt: '2026-08-02T08:59:00.000Z', metadata: {} },
          { id: 'employee-history-agent', role: 'assistant', content: '以前的 Agent 回答', createdAt: '2026-08-02T09:00:00.000Z', metadata: {} },
        ],
        attachments: [],
      },
    };
    document.querySelector('[data-message-filter="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-history-back]') && document.querySelector('#message-list')?.textContent.includes('以前的 Agent 回答')`);
  const employeeHistoryViewer = await evaluate(cdp, `({
    viewerVisible: Boolean(document.querySelector('[data-employee-history-viewer="memory:history-memory"]')),
    readOnlyMessages: document.querySelectorAll('.employee-history-message').length,
    composerHidden: !document.querySelector('#chat-input'),
    backVisible: Boolean(document.querySelector('[data-employee-history-back]')),
  })`);
  assert(employeeHistoryViewer.viewerVisible && employeeHistoryViewer.readOnlyMessages === 2
    && employeeHistoryViewer.composerHidden && employeeHistoryViewer.backVisible,
  `Employee history viewer is not read-only or complete: ${JSON.stringify(employeeHistoryViewer)}`);
  await evaluate(cdp, `document.querySelector('[data-employee-history-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#chat-input') && document.querySelector('#message-list')?.textContent.includes('当前对话内容')`);

  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.currentAgentId = '';
    state.currentDepartmentId = '';
    state.currentChatKey = 'message-layout-away-chat';
    state.sessions = [{
      id: 'message-layout-older-session',
      title: '较早的布局会话',
      agentId: 'message_layout_agent',
      departmentId: 'message_layout_department',
      status: 'active',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }, ...(state.sessions || []).filter((item) => item.agentId !== 'message_layout_agent')];
    const pendingRun = {
      channelId: 'message-layout-pending-run',
      sessionId: '',
      displaySessionId: '',
      executionSessionId: '',
      chatKey: 'message-layout-pending-chat',
      departmentId: 'message_layout_department',
      agentId: 'message_layout_agent',
      userMessage: '等待恢复的生成中消息',
      sessionTitle: '等待恢复的生成中消息',
      statusMessageId: 'message-layout-pending-status',
      lastStatusStage: 'working',
      lastStatusText: '布局 Agent 正在生成',
      startedAt: Date.now(),
      terminal: false,
      nonBlocking: false,
      localUserMessage: {
        id: 'message-layout-pending-user',
        role: 'user',
        content: '等待恢复的生成中消息',
        agentId: 'message_layout_agent',
        departmentId: 'message_layout_department',
        createdAt: new Date().toISOString(),
      },
    };
    state.chatRuns = [pendingRun];
    state.activeChatRun = null;
    state.chatGroupId = 'message-layout-pending-source-group';
    state.chatGroupDetail = {
      group: { id: 'message-layout-pending-source-group', title: '运行中 Agent 跳转来源群聊', status: 'active', ownerUserId: state.currentUser?.id || '' },
      membership: { userId: state.currentUser?.id || '', role: 'owner', status: 'active' },
      members: [{ userId: state.currentUser?.id || '', role: 'owner', status: 'active', user: state.currentUser }],
      messages: [],
    };
    document.querySelector('[data-message-filter="all"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-inbox-run="message-layout-pending-run"]')`);
  await waitForRenderer(cdp, `document.querySelector('.natural-chat-group-view')?.textContent.includes('运行中 Agent 跳转来源群聊')`);
  const pendingAgentConversation = await evaluate(cdp, `(() => ({
    pendingTarget: Boolean(document.querySelector('[data-agent-inbox-run="message-layout-pending-run"]')),
    oldSessionTargetHidden: !document.querySelector('[data-network-session="message-layout-older-session"]'),
    preview: document.querySelector('[data-agent-message-row="message_layout_agent"] .network-message-preview')?.textContent?.trim() || '',
  }))()`);
  assert(pendingAgentConversation.pendingTarget && pendingAgentConversation.oldSessionTargetHidden && pendingAgentConversation.preview.includes('等待恢复的生成中消息'), `Pending Agent conversation did not take priority over its old session: ${JSON.stringify(pendingAgentConversation)}`);
  await evaluate(cdp, `document.querySelector('[data-agent-inbox-run="message-layout-pending-run"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-inbox-run="message-layout-pending-run"].active') && document.querySelector('#message-list')?.textContent.includes('等待恢复的生成中消息')`);
  const restoredPendingConversation = await evaluate(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => ({
    currentChatKey: state.currentChatKey,
    currentSessionId: state.currentSessionId,
    homeOpen: state.networkMessageHomeOpen,
    activeRun: state.activeChatRun?.channelId || '',
    chatGroupId: state.chatGroupId,
    chatGroupDetail: state.chatGroupDetail,
    localMessageVisible: document.querySelector('#message-list')?.textContent.includes('等待恢复的生成中消息') || false,
    pendingRowActive: Boolean(document.querySelector('[data-agent-inbox-run="message-layout-pending-run"].active')),
  }))`);
  assert(restoredPendingConversation.currentChatKey === 'message-layout-pending-chat'
    && restoredPendingConversation.currentSessionId === ''
    && !restoredPendingConversation.homeOpen
    && restoredPendingConversation.activeRun === 'message-layout-pending-run'
    && restoredPendingConversation.chatGroupId === ''
    && restoredPendingConversation.chatGroupDetail === null
    && restoredPendingConversation.localMessageVisible
    && restoredPendingConversation.pendingRowActive,
  `Pending Agent conversation could not be restored from Messages: ${JSON.stringify(restoredPendingConversation)}`);

  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.chatRuns = [];
    state.activeChatRun = null;
    state.currentSessionId = '';
    state.currentChatKey = 'message-layout-existing-chat';
    state.currentDepartmentId = '';
    state.currentAgentId = '';
    state.selectionSource = null;
    state.messages = [];
    state.sessions = [{
      id: 'message-layout-session',
      title: '需要完成的会话',
      lastMessage: '这才是最近一条 Agent 信息',
      lastMessageRole: 'assistant',
      agentId: 'message_layout_agent',
      departmentId: 'message_layout_department',
      status: 'active',
      unreadDeliveryCount: 2,
      unreadCount: 2,
      updatedAt: '2099-01-01T00:00:00.000Z',
    }, ...(state.sessions || []).filter((item) => item.id !== 'message-layout-session')];
    state.completedConversationKeys = [];
    state.markedConversationKeys = [];
    state.unreadConversationKeys = [];
    state.conversationContextMenu = null;
    document.querySelector('[data-message-home-back]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-message-row="message_layout_agent"]')`);
  const grouped = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.message-group-sidebar');
    const shell = document.querySelector('.shell.message-groups-open');
    const filters = [...document.querySelectorAll('[data-message-filter]')];
    return {
      sidebar: Boolean(sidebar),
      shell: Boolean(shell),
      filterCount: filters.length,
      activeFilter: document.querySelector('[data-message-filter][aria-pressed="true"]')?.dataset.messageFilter || '',
      fourColumns: getComputedStyle(shell).gridTemplateColumns.split(' ').filter(Boolean).length === 4,
      primaryNavigationVisible: Boolean(document.querySelector('[data-app-navigation]')),
      sidebarUnreadBadge: document.querySelector('[data-network-view="messages"] .sidebar-nav-unread')?.textContent?.trim() || '',
      sidebarUnreadDot: Boolean(document.querySelector('[data-network-view="messages"] .sidebar-nav-unread.is-dot')),
      agentUnreadBadge: document.querySelector('[data-agent-message-row="message_layout_agent"]')?.dataset.unreadCount || '',
      agentUnreadClass: Boolean(document.querySelector('[data-agent-message-row="message_layout_agent"]')?.classList.contains('is-unread')),
      agentPreview: document.querySelector('[data-agent-message-row="message_layout_agent"] .network-message-preview')?.textContent?.trim() || '',
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
    };
  })()`);
  assert(grouped.sidebar && grouped.shell && grouped.filterCount >= 9 && grouped.activeFilter === 'all' && grouped.fourColumns && grouped.primaryNavigationVisible && grouped.noHorizontalOverflow, `Message grouping rail is incomplete: ${JSON.stringify(grouped)}`);
  assert(grouped.sidebarUnreadDot && grouped.sidebarUnreadBadge === '' && grouped.agentUnreadBadge === '2' && grouped.agentUnreadClass, `Agent unread markers are missing: ${JSON.stringify(grouped)}`);
  assert(grouped.agentPreview.includes('这才是最近一条 Agent 信息') && !grouped.agentPreview.includes('需要完成的会话'),
    `Agent conversation preview must prefer the latest message over the original title: ${JSON.stringify(grouped)}`);
  await evaluate(cdp, `document.querySelector('[data-message-filter="agent"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-filter="agent"][aria-pressed="true"]')`);
  const filter = await evaluate(cdp, `({
    onlyAgents: [...document.querySelectorAll('.im-conversation-list .im-conversation-item')].every((item) => item.classList.contains('network-agent-item')),
  })`);
  assert(filter.onlyAgents, `Agent filter did not constrain the list: ${JSON.stringify(filter)}`);
  await evaluate(cdp, `document.querySelector('[data-message-filter="all"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-message-row="message_layout_agent"]')`);
  const conversationTextGeometry = await evaluate(cdp, `(() => {
    const item = document.querySelector('[data-agent-message-row="message_layout_agent"]');
    const avatar = item?.querySelector('.network-message-avatar')?.getBoundingClientRect();
    const list = document.querySelector('.im-conversation-list')?.getBoundingClientRect();
    const shortcutArea = document.querySelector('.im-message-shortcuts')?.getBoundingClientRect();
    const shortcutButtonElement = document.querySelector('.im-message-shortcut');
    const shortcutButton = shortcutButtonElement?.getBoundingClientRect();
    const shortcutAvatar = shortcutButtonElement?.querySelector('.im-message-shortcut-avatar')?.getBoundingClientRect();
    const shortcutCopyElement = shortcutButtonElement?.querySelector('.im-message-shortcut-copy');
    const shortcutCopy = shortcutCopyElement?.getBoundingClientRect();
    const title = item?.querySelector('.network-message-line')?.getBoundingClientRect();
    const preview = item?.querySelector('.network-message-preview')?.getBoundingClientRect();
    return {
      avatarDiameter: avatar?.height || 0,
      shortcutIconGap: shortcutArea && shortcutAvatar ? shortcutAvatar.left - shortcutArea.left : -1,
      conversationAvatarGap: list && avatar ? avatar.left - list.left : -1,
      shortcutHitAreaMatchesIcon: Boolean(shortcutButton && shortcutAvatar
        && Math.abs(shortcutButton.width - shortcutAvatar.width) <= 1
        && Math.abs(shortcutButton.height - shortcutAvatar.height) <= 1),
      shortcutLabelOutsideHitArea: Boolean(shortcutButton && shortcutCopy
        && shortcutCopy.top >= shortcutButton.bottom
        && getComputedStyle(shortcutCopyElement).pointerEvents === 'none'),
      textSpan: title && preview ? preview.bottom - title.top : 0,
      centersAligned: Boolean(avatar && title && preview && Math.abs((avatar.top + avatar.height / 2) - ((title.top + preview.bottom) / 2)) <= 1),
      summaryGap: title && preview ? preview.top - title.bottom : 0,
    };
  })()`);
  assert(Math.abs(conversationTextGeometry.avatarDiameter - 35) <= 1
    && conversationTextGeometry.shortcutIconGap >= 8
    && conversationTextGeometry.shortcutIconGap < conversationTextGeometry.conversationAvatarGap
    && conversationTextGeometry.conversationAvatarGap - conversationTextGeometry.shortcutIconGap <= 4
    && conversationTextGeometry.shortcutHitAreaMatchesIcon && conversationTextGeometry.shortcutLabelOutsideHitArea
    && conversationTextGeometry.textSpan >= conversationTextGeometry.avatarDiameter
    && conversationTextGeometry.centersAligned
    && conversationTextGeometry.summaryGap >= 0 && conversationTextGeometry.summaryGap <= 2,
  `Conversation shortcut or row geometry is incorrect: ${JSON.stringify(conversationTextGeometry)}`);
  const completionIdle = await evaluate(cdp, `(() => {
    const row = document.querySelector('[data-agent-message-row="message_layout_agent"]')?.closest('.im-conversation-row');
    const item = row?.querySelector('.im-conversation-item')?.getBoundingClientRect();
    const complete = row?.querySelector('[data-conversation-complete]');
    const completeRect = complete?.getBoundingClientRect();
    const time = row?.querySelector('.network-message-line time');
    const timeRect = time?.getBoundingClientRect();
    const titleLineRect = row?.querySelector('.im-conversation-title-line')?.getBoundingClientRect();
    return {
      completeHidden: complete ? Number.parseFloat(getComputedStyle(complete).opacity) === 0 : false,
      completeCentered: Boolean(item && completeRect && Math.abs((item.top + item.height / 2) - (completeRect.top + completeRect.height / 2)) <= 1),
      timeVisible: time ? Number.parseFloat(getComputedStyle(time).opacity) === 1 : false,
      timeCompleteDelta: timeRect && completeRect ? Math.abs(timeRect.right - (completeRect.left + completeRect.width / 2)) : null,
      timeAlignedWithComplete: Boolean(timeRect && completeRect && Math.abs(timeRect.right - (completeRect.left + completeRect.width / 2)) <= 18),
      titleDoesNotOverlapTime: Boolean(titleLineRect && timeRect && titleLineRect.right <= timeRect.left - 4),
    };
  })()`);
  assert(completionIdle.completeHidden && completionIdle.completeCentered && completionIdle.timeVisible && completionIdle.timeAlignedWithComplete && completionIdle.titleDoesNotOverlapTime, `Idle completion control or timestamp placement is incorrect: ${JSON.stringify(completionIdle)}`);
  const documentNode = await cdp.send('DOM.getDocument', { depth: 1 });
  const completionRowNode = await cdp.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '.im-conversation-row:has([data-agent-message-row="message_layout_agent"])',
  });
  await cdp.send('CSS.forcePseudoState', { nodeId: completionRowNode.nodeId, forcedPseudoClasses: ['hover'] });
  await evaluate(cdp, `new Promise((resolve) => setTimeout(resolve, 220))`);
  await capture(cdp, 'message-completion-hover.png');
  const completionHover = await evaluate(cdp, `(() => {
    const row = document.querySelector('[data-agent-message-row="message_layout_agent"]')?.closest('.im-conversation-row');
    const item = row?.querySelector('.im-conversation-item');
    const complete = row?.querySelector('[data-conversation-complete]');
    const list = row?.closest('.im-conversation-list');
    const rowRect = row?.getBoundingClientRect();
    const itemRect = item?.getBoundingClientRect();
    const completeRect = complete?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    const time = row?.querySelector('.network-message-line time');
    const completeStyle = complete ? getComputedStyle(complete) : null;
    const itemStyle = item ? getComputedStyle(item) : null;
    return {
      radius: item ? Number.parseFloat(getComputedStyle(item).borderRadius) : 0,
      shadow: item ? getComputedStyle(item).boxShadow : 'none',
      filledBackground: Boolean(itemStyle && itemStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'),
      completeOpacity: complete ? Number.parseFloat(getComputedStyle(complete).opacity) : 0,
      completeFrameless: Boolean(completeStyle && completeStyle.borderTopWidth === '0px' && completeStyle.boxShadow === 'none' && completeStyle.backgroundColor === 'rgba(0, 0, 0, 0)'),
      timeHidden: time ? Number.parseFloat(getComputedStyle(time).opacity) === 0 : false,
      completeKey: complete?.dataset.conversationComplete || '',
      compactRow: Boolean(rowRect && rowRect.height <= 84),
      rowFillsList: Boolean(itemRect && listRect && itemRect.width >= listRect.width - 20),
      completeCentered: Boolean(itemRect && completeRect && Math.abs((itemRect.top + itemRect.height / 2) - (completeRect.top + completeRect.height / 2)) <= 1),
      rowHeight: Math.round(rowRect?.height || 0),
      itemWidth: Math.round(itemRect?.width || 0),
      listWidth: Math.round(listRect?.width || 0),
      completeCenterOffset: itemRect && completeRect ? Math.round(Math.abs((itemRect.top + itemRect.height / 2) - (completeRect.top + completeRect.height / 2)) * 10) / 10 : -1,
    };
  })()`);
  assert(completionHover.radius === 0 && completionHover.shadow === 'none' && completionHover.filledBackground && completionHover.completeOpacity === 1 && completionHover.completeFrameless && completionHover.timeHidden && completionHover.completeKey === 'agent:message-layout-session' && completionHover.compactRow && completionHover.rowFillsList && completionHover.completeCentered, `Conversation completion affordance is incomplete: ${JSON.stringify(completionHover)}`);
  await evaluate(cdp, `document.querySelector('[data-agent-message-row="message_layout_agent"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 560, clientY: 240 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-conversation-context-key="agent:message-layout-session"]')`);
  const contextMenu = await evaluate(cdp, `(() => ({
    actionCount: document.querySelectorAll('[data-conversation-group-action]').length,
    labels: [...document.querySelectorAll('[data-conversation-group-action]')].map((item) => item.textContent.trim()),
  }))()`);
  assert(contextMenu.actionCount === 3 && contextMenu.labels.some((label) => label.includes('未读')) && contextMenu.labels.some((label) => label.includes('标记')) && contextMenu.labels.some((label) => label.includes('完成')), `Conversation context menu does not match message groups: ${JSON.stringify(contextMenu)}`);
  await capture(cdp, 'message-context-menu.png');
  await evaluate(cdp, `document.querySelector('[data-conversation-group-action="mark"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-conversation-row-key="agent:message-layout-session"].is-marked .im-conversation-flag')`);
  const markedLayout = await evaluate(cdp, `(() => {
    const row = document.querySelector('[data-conversation-row-key="agent:message-layout-session"]');
    const flag = row?.querySelector('.im-conversation-flag')?.getBoundingClientRect();
    const complete = row?.querySelector('[data-conversation-complete]')?.getBoundingClientRect();
    return {
      marked: row?.classList.contains('is-marked') || false,
      separated: Boolean(flag && complete && flag.bottom <= complete.top + 1),
      flagColor: row?.querySelector('.im-conversation-flag') ? getComputedStyle(row.querySelector('.im-conversation-flag')).color : '',
    };
  })()`);
  assert(markedLayout.marked && markedLayout.separated && markedLayout.flagColor.includes('239'), `Marked flag and completion control overlap: ${JSON.stringify(markedLayout)}`);
  await capture(cdp, 'message-marked-row.png');
  await evaluate(cdp, `document.querySelector('[data-agent-message-row="message_layout_agent"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 560, clientY: 240 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-conversation-group-action="unread"]')`);
  await evaluate(cdp, `document.querySelector('[data-conversation-group-action="unread"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-conversation-row-key="agent:message-layout-session"].is-manually-unread')`);
  await evaluate(cdp, `document.querySelector('[data-conversation-complete="agent:message-layout-session"]')?.click()`);
  await waitForRenderer(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => state.completedConversationKeys.includes('agent:message-layout-session')
    && !document.querySelector('[data-agent-message-row="message_layout_agent"]'))`);
  const completedInAll = await evaluate(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => ({
    filter: state.networkMessageListFilter,
    completed: state.completedConversationKeys.includes('agent:message-layout-session'),
    visible: Boolean(document.querySelector('[data-agent-message-row="message_layout_agent"]')),
  }))`);
  assert(completedInAll.filter === 'all' && completedInAll.completed && !completedInAll.visible, `Completed Agent conversations must leave the main message list: ${JSON.stringify(completedInAll)}`);
  await evaluate(cdp, `document.querySelector('[data-message-filter="completed"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-agent-message-row="message_layout_agent"]')`);
  const completed = await evaluate(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => ({
    filter: state.networkMessageListFilter,
    completed: state.completedConversationKeys.includes('agent:message-layout-session'),
    searchRemoved: !document.querySelector('[data-conversation-search-toggle], #network-conversation-search-popover, #network-conversation-search'),
    shortcutsInline: (() => {
      const items = [...document.querySelectorAll('.im-message-shortcut')];
      return items.length === 2 && Math.abs(items[0].getBoundingClientRect().top - items[1].getBoundingClientRect().top) < 2;
    })(),
  }))`);
  assert(completed.filter === 'completed' && completed.completed && completed.searchRemoved && completed.shortcutsInline, `Completed grouping or pinned entries are incomplete: ${JSON.stringify(completed)}`);
  await evaluate(cdp, `document.querySelector('[data-message-filter="all"]')?.click()`);
  await capture(cdp, 'message-groups.png');

  await evaluate(cdp, `document.querySelector('[data-network-peer="self-secretary"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-home-back]') && document.querySelector('#chat-input')`);
  const conversation = await evaluate(cdp, `(() => ({
    defaultHidden: !document.querySelector('[data-message-default-page]'),
    closeLabel: document.querySelector('[data-message-home-back]')?.getAttribute('aria-label') || '',
    title: document.querySelector('[data-chat-top-info] strong')?.textContent || '',
    agentStatus: document.querySelector('[data-chat-top-info] .chat-agent-status')?.textContent?.trim() || '',
    globalThemeToggle: Boolean(document.querySelector('.window-titlebar #theme-toggle-btn')),
    chatThemeToggleRemoved: !document.querySelector('.chat-utility #theme-toggle-btn'),
    selected: Boolean(document.querySelector('[data-network-peer="self-secretary"].active')),
    selectedWithoutBlueLine: !getComputedStyle(document.querySelector('[data-network-peer="self-secretary"]')).boxShadow.includes('inset'),
    chatScroll: getComputedStyle(document.querySelector('#message-list')).overflowY,
    panelStillOpen: Boolean(document.querySelector('#network-panel[data-page-kind="messages"]')),
    resizerVisible: getComputedStyle(document.querySelector('[data-message-pane-resizer]')).display !== 'none',
    resizerCenteredBetweenPanes: (() => {
      const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
      const main = document.querySelector('.main')?.getBoundingClientRect();
      const resizer = document.querySelector('[data-message-pane-resizer]')?.getBoundingClientRect();
      return Boolean(panel && main && resizer && resizer.width >= 12
        && Math.abs((resizer.left + resizer.width / 2) - ((panel.right + main.left) / 2)) <= 1
        && resizer.left <= panel.right && resizer.right >= main.left);
    })(),
    resizerGeometry: (() => {
      const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
      const resizer = document.querySelector('[data-message-pane-resizer]')?.getBoundingClientRect();
      return { panelRight: Math.round(panel?.right || 0), resizerLeft: Math.round(resizer?.left || 0), resizerWidth: Math.round(resizer?.width || 0) };
    })(),
  }))()`);
  assert(conversation.defaultHidden && conversation.closeLabel.includes('关闭') && conversation.title.includes('uBuddy') && conversation.agentStatus === '在线' && conversation.selected && conversation.selectedWithoutBlueLine && conversation.panelStillOpen && conversation.resizerVisible && conversation.resizerCenteredBetweenPanes, `Conversation selection did not open the normal chat view: ${JSON.stringify(conversation)}`);
  assert(conversation.globalThemeToggle && conversation.chatThemeToggleRemoved, `Theme control did not move to the global window layer: ${JSON.stringify(conversation)}`);
  assert(['auto', 'scroll'].includes(conversation.chatScroll), `Chat content does not scroll independently: ${JSON.stringify(conversation)}`);
  await evaluate(cdp, `import(${JSON.stringify(stateEntry)}).then(({ state }) => {
    state.messages = [
      { id: 'continuous-user-1', role: 'user', content: '第一条自己的消息', createdAt: '2026-07-31T08:00:00.000Z', metadata: {} },
      { id: 'continuous-user-2', role: 'user', content: '连续发送的第二条', createdAt: '2026-07-31T08:01:00.000Z', metadata: {} },
      { id: 'continuous-assistant-1', role: 'assistant', content: '第一条助手消息', createdAt: '2026-07-31T08:02:00.000Z', metadata: {} },
      { id: 'continuous-assistant-2', role: 'assistant', content: '连续回复的第二条', createdAt: '2026-07-31T08:03:00.000Z', metadata: {} },
    ];
    document.querySelector('#theme-toggle-btn')?.click();
  })`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-id="continuous-assistant-2"].is-consecutive-message')`);
  const continuousMessages = await evaluate(cdp, `(() => {
    const list = document.querySelector('#message-list')?.getBoundingClientRect();
    const userFirst = document.querySelector('[data-message-id="continuous-user-1"]');
    const userNext = document.querySelector('[data-message-id="continuous-user-2"]');
    const assistantFirst = document.querySelector('[data-message-id="continuous-assistant-1"]');
    const assistantNext = document.querySelector('[data-message-id="continuous-assistant-2"]');
    const body = (item) => item?.querySelector('.message-body')?.getBoundingClientRect();
    const userFirstBody = body(userFirst);
    const userNextBody = body(userNext);
    const assistantFirstBody = body(assistantFirst);
    const assistantNextBody = body(assistantNext);
    const userFirstRadius = userFirstBody ? getComputedStyle(userFirst.querySelector('.message-body')) : null;
    const userNextRadius = userNextBody ? getComputedStyle(userNext.querySelector('.message-body')) : null;
    return {
      realAvatars: document.querySelectorAll('#message-list .chat-message-avatar').length,
      spacers: document.querySelectorAll('#message-list .chat-message-avatar-spacer').length,
      userRightAligned: Boolean(userFirstBody && userNextBody && Math.abs(userFirstBody.right - userNextBody.right) <= 1),
      assistantLeftAligned: Boolean(assistantFirstBody && assistantNextBody && Math.abs(assistantFirstBody.left - assistantNextBody.left) <= 1),
      ownMessagesRemainRight: Boolean(list && userFirstBody && userFirstBody.left > (list.left + list.width / 2)),
      userGap: userFirst && userNext ? userNext.getBoundingClientRect().top - userFirst.getBoundingClientRect().bottom : 999,
      assistantGap: assistantFirst && assistantNext ? assistantNext.getBoundingClientRect().top - assistantFirst.getBoundingClientRect().bottom : 999,
      userFirstCorners: userFirstRadius ? {
        topLeft: Number.parseFloat(userFirstRadius.borderTopLeftRadius),
        topRight: Number.parseFloat(userFirstRadius.borderTopRightRadius),
        bottomRight: Number.parseFloat(userFirstRadius.borderBottomRightRadius),
        bottomLeft: Number.parseFloat(userFirstRadius.borderBottomLeftRadius),
      } : null,
      userNextCorners: userNextRadius ? {
        topLeft: Number.parseFloat(userNextRadius.borderTopLeftRadius),
        topRight: Number.parseFloat(userNextRadius.borderTopRightRadius),
        bottomRight: Number.parseFloat(userNextRadius.borderBottomRightRadius),
        bottomLeft: Number.parseFloat(userNextRadius.borderBottomLeftRadius),
      } : null,
    };
  })()`);
  assert(continuousMessages.realAvatars === 2 && continuousMessages.spacers === 2 && continuousMessages.userRightAligned && continuousMessages.assistantLeftAligned && continuousMessages.ownMessagesRemainRight && continuousMessages.userGap <= 7 && continuousMessages.assistantGap <= 7
    && continuousMessages.userFirstCorners?.topRight <= 3 && continuousMessages.userFirstCorners?.bottomRight <= 3
    && continuousMessages.userFirstCorners?.topLeft === 10 && continuousMessages.userFirstCorners?.bottomLeft === 10
    && continuousMessages.userNextCorners?.topRight <= 3 && continuousMessages.userNextCorners?.bottomRight === 10
    && continuousMessages.userNextCorners?.topLeft === 10 && continuousMessages.userNextCorners?.bottomLeft === 10,
  `Continuous message grouping is incorrect: ${JSON.stringify(continuousMessages)}`);
  await capture(cdp, 'message-continuous-groups.png');
  const resized = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.message-layout');
    const resizer = document.querySelector('[data-message-pane-resizer]');
    const before = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--network-panel-width'));
    const rect = resizer.getBoundingClientRect();
    resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.left + 2, clientY: rect.top + 80 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + 82, clientY: rect.top + 80 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.left + 82, clientY: rect.top + 80 }));
    const after = Number.parseFloat(getComputedStyle(shell).getPropertyValue('--network-panel-width'));
    return { before, after, ariaNow: Number(resizer.getAttribute('aria-valuenow')) };
  })()`);
  assert(resized.after > resized.before && resized.after <= 520 && resized.ariaNow === resized.after, `Message pane resizer did not update within limits: ${JSON.stringify(resized)}`);
  await capture(cdp, 'message-conversation.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-compact.message-conversation-open')`);
  const compactConversation = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
    const groupDrawer = document.querySelector('.message-group-sidebar');
    const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    return {
      sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
      listVisible: getComputedStyle(document.querySelector('#network-panel')).display !== 'none',
      mainVisible: getComputedStyle(document.querySelector('.main')).display !== 'none',
      panelWidth: Math.round(panel?.width || 0),
      mainWidth: Math.round(main?.width || 0),
      groupDrawerOverlay: !groupDrawer || getComputedStyle(groupDrawer).position === 'absolute',
      groupDrawerWithinViewport: !groupDrawer || groupDrawer.getBoundingClientRect().right <= innerWidth - 8,
      responsiveTabsHidden: [...document.querySelectorAll('.message-responsive-tabs')].every((item) => getComputedStyle(item).display === 'none'),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      sidebarWidth: Math.round(sidebar?.width || 0),
    };
  })()`);
  assert(compactConversation.sidebarVisible && compactConversation.listVisible && compactConversation.mainVisible
    && compactConversation.panelWidth >= 280 && compactConversation.panelWidth <= 420
    && compactConversation.mainWidth >= 360 && compactConversation.groupDrawerOverlay
    && compactConversation.groupDrawerWithinViewport && compactConversation.responsiveTabsHidden
    && !compactConversation.horizontalOverflow,
  `Compact selected conversation layout is unstable: ${JSON.stringify(compactConversation)}`);
  await capture(cdp, 'message-compact-conversation.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 800, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-conversation-open.message-pane-conversation') && innerWidth <= 760`);
  const narrowConversation = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.message-conversation-open');
    const sidebar = document.querySelector('.sidebar');
    const main = document.querySelector('.main');
    const back = document.querySelector('[data-message-home-back]');
    return {
      shell: Boolean(shell),
      sidebarVisible: getComputedStyle(sidebar).display !== 'none',
      sidebarWidth: Math.round(sidebar?.getBoundingClientRect().width || 0),
      sidebarLabelsHidden: [...document.querySelectorAll('.app-primary-nav .tab-btn > span:not(.nav-icon)')].every((item) => getComputedStyle(item).display === 'none'),
      listHidden: getComputedStyle(document.querySelector('#network-panel')).display === 'none',
      mainWidth: Math.round(main?.getBoundingClientRect().width || 0),
      viewportWidth: innerWidth,
      backLabel: back?.getAttribute('aria-label') || '',
      conversationTabActive: Boolean(document.querySelector('.main [data-message-pane="conversation"].active')),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert(narrowConversation.shell && narrowConversation.sidebarVisible && narrowConversation.sidebarWidth >= 64
    && narrowConversation.sidebarWidth <= 76 && narrowConversation.sidebarLabelsHidden && narrowConversation.listHidden,
  `Narrow conversation did not retain a usable icon navigation rail: ${JSON.stringify(narrowConversation)}`);
  assert(narrowConversation.mainWidth >= narrowConversation.viewportWidth - narrowConversation.sidebarWidth - 20
    && narrowConversation.backLabel.includes('返回消息列表') && narrowConversation.conversationTabActive
    && !narrowConversation.horizontalOverflow,
  `Narrow chat did not expose a robust page switch without overflow: ${JSON.stringify(narrowConversation)}`);

  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list') && getComputedStyle(document.querySelector('#network-panel')).display !== 'none'`);
  const narrowList = await evaluate(cdp, `({
    sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
    listVisible: getComputedStyle(document.querySelector('#network-panel')).display !== 'none',
    mainHidden: getComputedStyle(document.querySelector('.main')).display === 'none',
    selectionPreserved: Boolean(document.querySelector('[data-network-peer="self-secretary"].active')),
    listTabActive: Boolean(document.querySelector('#network-panel [data-message-pane="list"].active')),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  })`);
  assert(narrowList.sidebarVisible && narrowList.listVisible && narrowList.mainHidden && narrowList.selectionPreserved
    && narrowList.listTabActive && !narrowList.horizontalOverflow,
  `Narrow message list page did not preserve the selected conversation: ${JSON.stringify(narrowList)}`);
  await capture(cdp, 'message-narrow-list.png');
  await evaluate(cdp, `document.querySelector('#network-panel [data-message-pane="conversation"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-conversation') && document.querySelector('#chat-input')`);
  await capture(cdp, 'message-narrow-conversation.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-wide.message-pane-conversation')`);

  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-message-default-page]')`);
  const closed = await evaluate(cdp, `({
    defaultVisible: Boolean(document.querySelector('[data-message-default-page]')),
    selectedCleared: !document.querySelector('[data-network-peer="self-secretary"].active'),
    chatHidden: !document.querySelector('#chat-input'),
  })`);
  assert(closed.defaultVisible && closed.selectedCleared && closed.chatHidden, `Closing a conversation did not restore the default page: ${JSON.stringify(closed)}`);

  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    const testAgents = [
      { id: 'multi_general_agent', name: '通用 Agent', departmentId: 'multi_department', routable: true },
      { id: 'multi_design_agent', name: '设计助手', departmentId: 'multi_department', routable: true },
      { id: 'multi_data_agent', name: '数据分析师', departmentId: 'multi_department', routable: true },
    ];
    state.org = {
      ...(state.org || {}),
      departments: [...(state.org?.departments || []).filter((item) => item.id !== 'multi_department'), { id: 'multi_department', name: '项目团队' }],
      agents: [...(state.org?.agents || []).filter((item) => !testAgents.some((agent) => agent.id === item.id)), ...testAgents],
    };
    state.sessions = [
      { id: 'multi-session-general', title: '产品需求整理', agentId: 'multi_general_agent', departmentId: 'multi_department', status: 'active', unreadCount: 2, unreadDeliveryCount: 2, updatedAt: '2026-07-27T17:53:00.000Z' },
      { id: 'multi-session-design', title: '首页视觉方案', agentId: 'multi_design_agent', departmentId: 'multi_department', status: 'active', updatedAt: '2026-07-27T16:42:00.000Z' },
      { id: 'multi-session-data', title: '本周数据复盘', agentId: 'multi_data_agent', departmentId: 'multi_department', status: 'active', updatedAt: '2026-07-26T11:20:00.000Z' },
      ...(state.sessions || []).filter((item) => !String(item.id || '').startsWith('multi-') && item.id !== 'message-layout-session'),
    ];
    const currentUserId = state.currentUser?.id || 'current-user';
    state.friendOverview = {
      ...(state.friendOverview || {}),
      friends: [
        { friend: { id: 'friend-liu', displayName: '刘烨', username: 'liuye' } },
        { friend: { id: 'friend-zhou', displayName: '周恒骥', username: 'zhouhengji' } },
        { friend: { id: 'friend-lin', displayName: '林晓雨', username: 'linxiaoyu' } },
      ],
      requests: { incoming: [], outgoing: [] },
    };
    state.socialThreads = [
      { friend: { id: 'friend-liu', displayName: '刘烨', username: 'liuye' }, messages: [{ id: 'dm-liu', senderUserId: 'friend-liu', recipientUserId: currentUserId, status: 'sent', content: '现在修好了，麻烦你确认一下', updatedAt: '2026-07-27T17:48:00.000Z' }] },
      { friend: { id: 'friend-zhou', displayName: '周恒骥', username: 'zhouhengji' }, messages: [{ id: 'dm-zhou', senderUserId: 'friend-zhou', recipientUserId: currentUserId, status: 'read', content: '视频会议卡片已经发到群里', updatedAt: '2026-07-27T15:26:00.000Z' }] },
      { friend: { id: 'friend-lin', displayName: '林晓雨', username: 'linxiaoyu' }, messages: [{ id: 'dm-lin', senderUserId: currentUserId, recipientUserId: 'friend-lin', status: 'read', content: '好的，明天上午继续讨论', updatedAt: '2026-07-26T18:05:00.000Z' }] },
    ];
    state.collaborationOverview = {
      ...(state.collaborationOverview || {}),
      groups: [
        { id: 'group-product', title: '产品发布协作群', memberCount: 6, unreadCount: 4, lastMessage: '刘烨：请确认最终发布时间', status: 'active', updatedAt: '2026-07-27T17:35:00.000Z' },
        { id: 'group-research', title: '用户研究小组', memberCount: 5, unreadCount: 0, lastMessage: '访谈纪要已整理完成', status: 'active', updatedAt: '2026-07-27T14:12:00.000Z' },
        { id: 'group-weekly', title: '全员周会', memberCount: 12, unreadCount: 0, lastMessage: '下周议题征集中', status: 'active', updatedAt: '2026-07-25T09:30:00.000Z' },
      ],
      tasks: [],
    };
    state.completedConversationKeys = [];
    state.markedConversationKeys = ['direct:friend-zhou', 'task:group-research'];
    state.unreadConversationKeys = ['direct:friend-liu'];
    state.networkMessageListFilter = 'all';
    state.networkMessageHomeOpen = true;
    state.messageGroupSidebarOpen = true;
    document.querySelector('[data-message-groups-toggle]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelectorAll('.im-conversation-row').length >= 9 && !document.querySelector('.message-group-sidebar')`);
  const multiConversationLayout = await evaluate(cdp, `({
    rows: document.querySelectorAll('.im-conversation-row').length,
    directRows: document.querySelectorAll('.direct-message-item').length,
    groupRows: document.querySelectorAll('.collaboration-group-item').length,
    agentRows: document.querySelectorAll('.network-agent-item').length,
    markedRows: document.querySelectorAll('.im-conversation-row.is-marked').length,
  })`);
  assert(multiConversationLayout.rows >= 9 && multiConversationLayout.directRows === 3 && multiConversationLayout.groupRows === 3 && multiConversationLayout.agentRows >= 3 && multiConversationLayout.markedRows === 2, `Multi-conversation layout fixture is incomplete: ${JSON.stringify(multiConversationLayout)}`);
  await capture(cdp, 'message-multi-conversations.png');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 680, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list') && document.querySelector('#network-panel [data-message-pane="conversation"]')`);
  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.collaborationGroupId = 'group-product';
    state.collaborationGroupDetail = {
      group: { id: 'group-product', title: '产品发布协作群', status: 'active', memberCount: 2 },
      membership: { userId: state.currentUser?.id || '', role: 'member', status: 'active' },
      members: [{ userId: state.currentUser?.id || '', role: 'member', status: 'active', user: state.currentUser }],
      messages: [{ id: 'group-product-message', senderUserId: state.currentUser?.id || '', content: '群聊窄屏验证消息', createdAt: '2026-07-27T17:35:00.000Z', metadata: {} }],
    };
    document.querySelector('#network-panel [data-message-pane="conversation"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-conversation') && document.querySelector('.collaboration-group-chat-view')?.textContent.includes('产品发布协作群')`);
  const ultraNarrowGroup = await evaluate(cdp, `(() => ({
    sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
    listHidden: getComputedStyle(document.querySelector('#network-panel')).display === 'none',
    mainVisible: getComputedStyle(document.querySelector('.main')).display !== 'none',
    backLabel: document.querySelector('.collaboration-group-chat-view [data-message-home-back]')?.getAttribute('aria-label') || '',
    messageVisible: document.querySelector('.collaboration-group-chat-view')?.textContent.includes('群聊窄屏验证消息') || false,
    titleBeforeActions: (() => {
      const title = document.querySelector('.collaboration-group-chat-view .social-group-title')?.getBoundingClientRect();
      const actions = document.querySelector('.collaboration-group-chat-view .social-group-actions')?.getBoundingClientRect();
      return Boolean(title && actions && title.bottom <= actions.top + 1);
    })(),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }))()`);
  assert(ultraNarrowGroup.sidebarVisible && ultraNarrowGroup.listHidden && ultraNarrowGroup.mainVisible
    && ultraNarrowGroup.backLabel.includes('返回消息列表') && ultraNarrowGroup.messageVisible
    && ultraNarrowGroup.titleBeforeActions
    && !ultraNarrowGroup.horizontalOverflow,
  `Ultra-narrow group conversation is unstable: ${JSON.stringify(ultraNarrowGroup)}`);
  await capture(cdp, 'message-ultra-narrow-group.png');
  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.message-pane-list') && document.querySelector('[data-collaboration-group="group-product"].active')`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-wide.message-pane-list')`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 560, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.im-conversation-list')?.scrollHeight > document.querySelector('.im-conversation-list')?.clientHeight`);
  const scrollClickTarget = await evaluate(cdp, `(() => {
    const list = document.querySelector('.im-conversation-list');
    list.scrollTop = Math.min(180, list.scrollHeight - list.clientHeight);
    const row = document.querySelector('[data-network-peer="friend-zhou"]');
    row?.scrollIntoView({ block: 'center' });
    const rect = row?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    return {
      before: list.scrollTop,
      max: list.scrollHeight - list.clientHeight,
      x: rect ? rect.left + rect.width / 2 : 0,
      y: rect ? rect.top + rect.height / 2 : 0,
      visible: Boolean(rect && listRect && rect.top >= listRect.top && rect.bottom <= listRect.bottom),
      preservesActualScroller: list.matches('[data-preserve-scroll][data-scroll-key="network-panel:messages"]'),
    };
  })()`);
  assert(scrollClickTarget.before > 0 && scrollClickTarget.max >= scrollClickTarget.before && scrollClickTarget.x > 0 && scrollClickTarget.y > 0 && scrollClickTarget.visible && scrollClickTarget.preservesActualScroller, `Conversation scroll fixture is invalid: ${JSON.stringify(scrollClickTarget)}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: scrollClickTarget.x, y: scrollClickTarget.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: scrollClickTarget.x, y: scrollClickTarget.y });
  await waitForRenderer(cdp, `document.querySelector('[data-network-peer="friend-zhou"].active')`);
  const preservedConversationScroll = {
    before: scrollClickTarget.before,
    after: await evaluate(cdp, `document.querySelector('.im-conversation-list')?.scrollTop || 0`),
    afterMax: await evaluate(cdp, `(() => { const list = document.querySelector('.im-conversation-list'); return list ? list.scrollHeight - list.clientHeight : 0; })()`),
  };
  assert(Math.abs(preservedConversationScroll.after - Math.min(preservedConversationScroll.before, preservedConversationScroll.afterMax)) <= 1,
    `Opening a conversation reset the message list scroll position: ${JSON.stringify(preservedConversationScroll)}`);
  await capture(cdp, 'message-conversation-scroll-preserved.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  console.log('Message workspace smoke passed.');
} catch (error) {
  failed = true;
  await captureSpawnedElectronFailureDiagnostics({ child, error, stderr, port, runtimeHome: smokeHome, name: 'message-workspace' });
  throw error;
} finally {
  await terminateSpawnedProcess(child);
  if (!failed || !process.env.JANUS_TEST_ARTIFACT_DIR) rmSync(smokeHome, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function capture(cdp, name) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(screenshotDir, name), Buffer.from(result.data, 'base64'));
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
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
}
