import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const root = process.cwd();
const smokeHome = mkdtempSync(path.join(os.tmpdir(), 'janus-contacts-workspace-'));
const port = Number(process.env.JANUS_CONTACTS_WORKSPACE_PORT || 9461);
const organizationTransferUiOnly = process.env.JANUS_CONTACTS_ORGANIZATION_TRANSFER_UI_ONLY === '1';
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const seedRuntime = await createRuntime({ root: smokeHome, isDev: true, requireExplicitAuthentication: true });
try {
  seedRuntime.authRegister({
    email: 'contacts-renderer-smoke@example.com',
    password: 'contacts-renderer-smoke-password',
    displayName: 'Contacts Renderer Smoke',
  });
} finally {
  seedRuntime.close();
}
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
  JANUS_TEST_ALLOW_MULTIPLE_INSTANCES: '1',
  JANUS_HOME: smokeHome,
  JANUS_AUTH_URL: '',
};
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExe, ['--no-sandbox', `--user-data-dir=${path.join(smokeHome, 'profile')}`, `--remote-debugging-port=${port}`, '.'], {
  cwd: root,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  const target = await waitForPageTarget(port, 15_000);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('[data-network-view="friends"]')`);
  await evaluate(cdp, `document.head.insertAdjacentHTML('beforeend', '<style data-contacts-smoke-motion>.employee-memory-drawer{animation:none!important}</style>')`);
  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-workspace') && document.querySelectorAll('[data-friend-directory-category]').length === 5`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-employees-pane')?.getAttribute('aria-busy') === 'false'`, 20_000);

  const initialEmpty = await evaluate(cdp, `(() => {
    const pane = document.querySelector('.contacts-list-scroll')?.getBoundingClientRect();
    const empty = document.querySelector('.im-contact-empty')?.getBoundingClientRect();
    return {
      present: Boolean(empty),
      centeredX: Boolean(pane && empty && Math.abs((pane.left + pane.right) / 2 - (empty.left + empty.right) / 2) < 2),
      fillsWidth: Boolean(pane && empty && Math.abs(pane.width - empty.width) < 2),
      fillsHeight: Boolean(pane && empty && Math.abs(pane.height - empty.height) < 2),
      borderStyle: empty ? getComputedStyle(document.querySelector('.im-contact-empty')).borderStyle : '',
      pane: pane ? { left: pane.left, top: pane.top, width: pane.width, height: pane.height } : null,
      empty: empty ? { left: empty.left, top: empty.top, width: empty.width, height: empty.height } : null,
    };
  })()`);
  if (!initialEmpty.present || !initialEmpty.centeredX || !initialEmpty.fillsWidth || !initialEmpty.fillsHeight || initialEmpty.borderStyle !== 'none') {
    throw new Error(`Contact empty state is not centered across the full pane: ${JSON.stringify(initialEmpty)}`);
  }

  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    const friend = {
      id: 'contacts_smoke_friend',
      displayName: '很长的联系人名称用于验证省略提示',
      username: 'contacts-smoke-account',
      email: 'contacts-smoke@example.com',
    };
    const secondFriend = {
      id: 'contacts_smoke_friend_second',
      displayName: '第二位联系人',
      username: 'contacts-smoke-second',
      email: 'contacts-smoke-second@example.com',
    };
    const organizationOnlyFriend = {
      id: 'contacts_smoke_organization_only',
      displayName: '仅组织内联系人',
      username: 'contacts-smoke-organization-only',
      email: 'contacts-smoke-organization-only@example.com',
    };
    state.friendOverview = {
      friends: [{ friend, remark: '' }, { friend: secondFriend, remark: '' }],
      requests: { incoming: [{ id: 'request_smoke', user: { id: 'request_user', displayName: '新联系人' }, message: '申请协作' }], outgoing: [] },
      organizations: [{
        id: 'organization_smoke',
        organizationNumber: 'SMOKE-2026',
        name: '通讯录测试组织',
        role: 'owner',
        memberCount: 3,
        owner: { id: state.currentUser?.id || 'local_admin', displayName: 'Admin', username: 'admin' },
        members: [
          { role: 'owner', user: { id: state.currentUser?.id || 'local_admin', displayName: 'Admin', username: 'admin' } },
          { role: 'member', user: friend },
          { role: 'member', user: organizationOnlyFriend },
        ],
      }, {
        id: 'organization_smoke_second',
        organizationNumber: 'SECOND-2026',
        name: '第二测试组织',
        role: 'member',
        memberCount: 2,
        owner: friend,
        members: [
          { role: 'owner', user: friend },
          { role: 'member', user: { id: state.currentUser?.id || 'local_admin', displayName: 'Admin', username: 'admin' } },
        ],
      }],
    };
    state.socialThreads = [{
      friend,
      messages: [{
        id: 'message_smoke',
        senderUserId: friend.id,
        recipientUserId: state.currentUser?.id || 'local_admin',
        content: '最近联系消息',
        status: 'sent',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      }],
    }];
    state.collaborationOverview = {
      ...(state.collaborationOverview || {}),
      groups: [{ id: 'group_smoke', title: '通讯录测试群组', status: 'active', memberCount: 3, updatedAt: new Date().toISOString() }],
    };
    state.employeeOverview = {
      quota: { limit: 10 },
      roster: [
        {
          id: 'employee_active_smoke',
          agentFamilyId: 'general_agent',
          family: { name: '方案助理', departmentId: 'general_department' },
          employmentState: 'active',
          routeEligible: true,
          queueDepth: 0,
          stateRevision: 1,
          performance: {},
          leadership: {},
          currentContext: {},
          availableMarketVersions: [],
        },
        {
          id: 'employee_inactive_smoke',
          agentFamilyId: 'research_agent',
          family: { name: '研究助理', departmentId: 'research_department' },
          employmentState: 'inactive',
          routeEligible: false,
          queueDepth: 0,
          stateRevision: 1,
          performance: {},
          leadership: {},
          currentContext: {},
          availableMarketVersions: [],
        },
      ],
    };
    state.employeeOverviewError = '';
    state.friendDirectoryError = '';
    state.friendDirectoryCategory = 'internal';
    state.friendDirectoryView = 'contacts';
    state.contactsActivePane = 'contacts';
    document.querySelector('[data-friend-directory-category="internal"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]') && document.querySelectorAll('[data-contacts-employee-card]').length === 1`);

  await evaluate(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-directory-menu] [data-organization-action="transfer_owner"]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-directory-menu] [data-organization-action="transfer_owner"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form') && document.querySelector('#organization-transfer-retain-admin')?.value === 'true' && [...document.querySelectorAll('#organization-transfer-retain-admin option')].map((item) => item.value).join(',') === 'true,false' && document.querySelector('#organization-action-code') && document.querySelector('#organization-action-password') && !document.querySelector('#organization-owner-exit-mode')`);
  await evaluate(cdp, `document.querySelector('[data-organization-action-close]')?.click()`);

  if (organizationTransferUiOnly) {
    console.log('organization owner transfer renderer smoke passed');
    cdp.close();
  } else {
  const wide = await evaluate(cdp, `(() => {
    const shell = document.querySelector('.shell.contacts-layout')?.getBoundingClientRect();
    const nav = document.querySelector('.network-panel')?.getBoundingClientRect();
    const main = document.querySelector('.shell.contacts-layout > .main')?.getBoundingClientRect();
    const list = document.querySelector('.contacts-list-pane')?.getBoundingClientRect();
    const employees = document.querySelector('.contacts-employees-pane')?.getBoundingClientRect();
    const activeCard = document.querySelector('[data-contacts-employee-card="employee_active_smoke"]');
    const inactiveCard = document.querySelector('[data-contacts-employee-card="employee_inactive_smoke"]');
    const search = document.querySelector('.directory-add-search label')?.getBoundingClientRect();
    const searchInputElement = document.querySelector('.directory-add-search input');
    const searchInput = searchInputElement?.getBoundingClientRect();
    const add = document.querySelector('.directory-add-search button')?.getBoundingClientRect();
    const directoryHead = document.querySelector('.shell.contacts-layout .network-panel-head')?.getBoundingClientRect();
    const contactsHead = document.querySelector('.contacts-list-pane .contacts-pane-head')?.getBoundingClientRect();
    const employeesHead = document.querySelector('.contacts-employees-head')?.getBoundingClientRect();
    const employeeGrid = document.querySelector('.contacts-employee-grid');
    const firstEmployeeCard = activeCard?.getBoundingClientRect();
    const employeeChatButtonElement = activeCard?.querySelector('[data-contacts-employee-chat="employee_active_smoke"]');
    const employeeChatButton = employeeChatButtonElement?.getBoundingClientRect();
    return {
      categories: [...document.querySelectorAll('[data-friend-directory-category]')].map((item) => item.textContent.trim()),
      bottomGap: {
        nav: shell && nav ? shell.bottom - nav.bottom : Number.POSITIVE_INFINITY,
        main: shell && main ? shell.bottom - main.bottom : Number.POSITIVE_INFINITY,
      },
      navWidth: nav?.width || 0,
      listWidth: list?.width || 0,
      employeeWidth: employees?.width || 0,
      alphaRemoved: !document.querySelector('.contacts-alpha-rail, .contact-alpha-group, [data-contact-initial]'),
      agentTagRemoved: !document.querySelector('.chat-utility-conversation'),
      topbarRemoved: !document.querySelector('.contacts-topbar, .contacts-topbar-title'),
      sharedFrameRemoved: getComputedStyle(document.querySelector('.contacts-workspace')).borderTopWidth === '0px',
      panesAligned: Boolean(list && employees && Math.abs(list.top - employees.top) < 1),
      headingsAligned: Boolean(directoryHead && contactsHead && employeesHead
        && Math.abs(directoryHead.top - contactsHead.top) < 1 && Math.abs(contactsHead.top - employeesHead.top) < 1
        && Math.abs(directoryHead.bottom - contactsHead.bottom) < 1 && Math.abs(contactsHead.bottom - employeesHead.bottom) < 1),
      headingRects: {
        directory: directoryHead ? { top: directoryHead.top, bottom: directoryHead.bottom, height: directoryHead.height } : null,
        contacts: contactsHead ? { top: contactsHead.top, bottom: contactsHead.bottom, height: contactsHead.height } : null,
        employees: employeesHead ? { top: employeesHead.top, bottom: employeesHead.bottom, height: employeesHead.height } : null,
      },
      employeeHeaderActionRemoved: !document.querySelector('.contacts-employees-head > button'),
      contactHeaderActionRemoved: !document.querySelector('.contacts-list-pane .contacts-pane-head > button'),
      contactInset: getComputedStyle(document.querySelector('.contacts-list-scroll')).padding,
      employeeInset: getComputedStyle(document.querySelector('.contacts-employees-scroll')).padding,
      employeeColumns: employeeGrid ? getComputedStyle(employeeGrid).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      employeeCardWidth: firstEmployeeCard?.width || 0,
      employeeCardHeight: firstEmployeeCard?.height || 0,
      employeeCardPadding: activeCard ? getComputedStyle(activeCard).padding : '',
      employeeAvatarSize: activeCard?.querySelector('.contacts-employee-avatar')?.getBoundingClientRect().width || 0,
      searchAligned: Boolean(search && add && Math.abs(search.top - add.top) < 1 && Math.abs(search.bottom - add.bottom) < 1),
      searchInputContained: Boolean(search && searchInput && searchInput.top >= search.top && searchInput.bottom <= search.bottom && searchInput.left >= search.left && searchInput.right <= search.right),
      searchInputPaddingLeft: Number.parseFloat(getComputedStyle(searchInputElement).paddingLeft),
      activeCardText: activeCard?.textContent.trim() || '',
      activeCardAvatar: activeCard?.querySelector('.contacts-employee-avatar')?.textContent?.trim() || '',
      activeCardAvatarImage: (() => {
        const image = activeCard?.querySelector('.contacts-employee-avatar .agent-avatar-image');
        return image ? { src: image.getAttribute('src'), complete: image.complete, naturalWidth: image.naturalWidth } : null;
      })(),
      activeCardTone: [...(activeCard?.classList || [])].find((name) => name.startsWith('tone-')) || '',
      inactiveCardRemoved: !inactiveCard,
      employeeChatButtonPresent: Boolean(employeeChatButtonElement),
      employeeChatButtonSize: employeeChatButton ? { width: employeeChatButton.width, height: employeeChatButton.height } : null,
      employeeChatButtonBorderWidth: employeeChatButtonElement ? getComputedStyle(employeeChatButtonElement).borderWidth : '',
      employeeChatButtonRadius: employeeChatButtonElement ? Number.parseFloat(getComputedStyle(employeeChatButtonElement).borderRadius) : 0,
      employeeChatButtonBackground: employeeChatButtonElement ? getComputedStyle(employeeChatButtonElement).backgroundColor : '',
      employeeChatButtonContained: Boolean(firstEmployeeCard && employeeChatButton
        && employeeChatButton.left >= firstEmployeeCard.left && employeeChatButton.right <= firstEmployeeCard.right
        && employeeChatButton.top >= firstEmployeeCard.top && employeeChatButton.bottom <= firstEmployeeCard.bottom),
      contactTitle: document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.getAttribute('title') || '',
      splitBarPresent: Boolean(document.querySelector('[data-contacts-pane-resizer]')),
    };
  })()`);
  const categoryLabels = wide.categories.map((text) => text.match(/^\D+/)?.[0]?.trim() || text);
  const chineseCategories = ['组织内联系人', '外部联系人', '新的联系人', '星标联系人', '我的群组'];
  const englishCategories = ['Members', 'External', 'Requests', 'Starred', 'Groups'];
  if (wide.categories.length !== 5
    || (!chineseCategories.every((label) => categoryLabels.includes(label))
      && !englishCategories.every((label) => categoryLabels.includes(label)))) {
    throw new Error(`Contact navigation categories are incomplete: ${JSON.stringify(wide)}`);
  }
  if (wide.navWidth / wide.listWidth < .72 || wide.navWidth / wide.listWidth > 1.35
    || wide.employeeWidth / wide.listWidth < 1.55 || wide.employeeWidth / wide.listWidth > 1.78) {
    throw new Error(`Contacts 1:1.2:2 ratio is incorrect: ${JSON.stringify(wide)}`);
  }
  if (!wide.alphaRemoved || !wide.agentTagRemoved || !wide.topbarRemoved || !wide.sharedFrameRemoved
    || wide.bottomGap.nav < 0 || wide.bottomGap.nav > 12
    || wide.bottomGap.main < 0 || wide.bottomGap.main > 12
    || !wide.panesAligned || !wide.headingsAligned || !wide.employeeHeaderActionRemoved || !wide.contactHeaderActionRemoved || wide.contactInset !== '0px'
    || !wide.employeeInset.startsWith('16px 20px') || wide.employeeColumns !== 2 || wide.employeeCardWidth < 220
    || wide.employeeCardHeight < 102 || wide.employeeCardHeight > 130 || !wide.employeeCardPadding.startsWith('13px 14px') || Math.abs(wide.employeeAvatarSize - 42) > 1
    || !wide.searchAligned || !wide.searchInputContained || wide.searchInputPaddingLeft < 3 || !wide.splitBarPresent) {
    throw new Error(`Contacts hierarchy cleanup is incomplete: ${JSON.stringify(wide)}`);
  }
  if (!wide.activeCardText.includes('方案助理') || wide.activeCardText.includes('部门') || wide.activeCardText.includes('开始聊天')
    || wide.activeCardAvatar !== '' || wide.activeCardAvatarImage?.src !== '../../assets/system_agents/general_agent/avatar.png'
    || !wide.activeCardAvatarImage?.complete || wide.activeCardAvatarImage.naturalWidth !== 512 || wide.activeCardTone !== 'tone-0'
    || !wide.employeeChatButtonPresent || !wide.employeeChatButtonContained
    || wide.employeeChatButtonSize.width < 30 || wide.employeeChatButtonSize.width > 36
    || wide.employeeChatButtonSize.height < 30 || wide.employeeChatButtonSize.height > 36
    || wide.employeeChatButtonBorderWidth !== '0px' || wide.employeeChatButtonRadius < 15
    || wide.employeeChatButtonBackground !== 'rgba(0, 0, 0, 0)'
    || !wide.inactiveCardRemoved
    || !wide.contactTitle.includes('contacts-smoke-account')) {
    throw new Error(`Compact employee cards or contact tooltip are incorrect: ${JSON.stringify(wide)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="groups"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-groups-pane .contacts-group-tabs') && document.querySelector('.contacts-groups-pane .contacts-list-scroll')`);
  const groupDirectoryLayout = await evaluate(cdp, `(() => {
    const pane = document.querySelector('.contacts-groups-pane')?.getBoundingClientRect();
    const head = document.querySelector('.contacts-groups-head')?.getBoundingClientRect();
    const tabs = document.querySelector('.contacts-group-tabs')?.getBoundingClientRect();
    const scroll = document.querySelector('.contacts-groups-pane .contacts-list-scroll')?.getBoundingClientRect();
    const create = document.querySelector('.contacts-groups-head [data-chat-group-create-open]')?.getBoundingClientRect();
    return { pane, head, tabs, scroll, create };
  })()`);
  if (!groupDirectoryLayout.pane || !groupDirectoryLayout.tabs || !groupDirectoryLayout.scroll || !groupDirectoryLayout.create
    || groupDirectoryLayout.tabs.height < 36 || groupDirectoryLayout.tabs.height > 60
    || groupDirectoryLayout.tabs.height > groupDirectoryLayout.pane.height * .2
    || Math.abs(groupDirectoryLayout.tabs.bottom - groupDirectoryLayout.scroll.top) > 1
    || groupDirectoryLayout.scroll.height < 180 || groupDirectoryLayout.create.width < 72) {
    throw new Error(`My Groups tabs consumed the middle pane or the create action collapsed: ${JSON.stringify(groupDirectoryLayout)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')`);
  const splitKeyboard = await evaluate(cdp, `(() => {
    const bar = document.querySelector('[data-contacts-pane-resizer]');
    const before = document.querySelector('.contacts-list-pane')?.getBoundingClientRect().width || 0;
    bar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    const after = document.querySelector('.contacts-list-pane')?.getBoundingClientRect().width || 0;
    const stored = Number(localStorage.getItem('janus-contacts-list-ratio-v1'));
    bar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    return { before, after, stored };
  })()`);
  if (!(splitKeyboard.after < splitKeyboard.before - 10) || !Number.isFinite(splitKeyboard.stored)) {
    throw new Error(`Contacts split bar keyboard resizing or persistence failed: ${JSON.stringify(splitKeyboard)}`);
  }

  const separatedAdd = await evaluate(cdp, `(() => ({
    directorySearchPresent: Boolean(document.querySelector('#friend-search-query')),
    legacyCombinedFormRemoved: !document.querySelector('#friend-search-form'),
    addButtonPresent: Boolean(document.querySelector('[data-contact-add-open="contact"]')),
  }))()`);
  if (!separatedAdd.directorySearchPresent || !separatedAdd.legacyCombinedFormRemoved || !separatedAdd.addButtonPresent) {
    throw new Error(`Directory search and add action are not separated: ${JSON.stringify(separatedAdd)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-contact-add-open="contact"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-add-dialog]') && document.querySelectorAll('[data-contact-add-tab]').length === 3 && document.querySelector('#contact-add-search-form')`);
  const contactDialogHeight = await evaluate(cdp, `document.querySelector('[data-contact-add-dialog]')?.getBoundingClientRect().height || 0`);
  await evaluate(cdp, `document.querySelector('[data-contact-add-tab="join-organization"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-join-form') && document.querySelector('#organization-join-link-form') && document.querySelector('#organization-join-link') && document.querySelector('[data-contact-add-dialog]')?.textContent.includes('任选一种方式即可加入')`);
  const joinDialogHeight = await evaluate(cdp, `document.querySelector('[data-contact-add-dialog]')?.getBoundingClientRect().height || 0`);
  await evaluate(cdp, `document.querySelector('[data-contact-add-tab="create-organization"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-create-form') && !document.querySelector('#organization-create-number')?.required`);
  const createDialog = await evaluate(cdp, `(() => ({
    height: document.querySelector('[data-contact-add-dialog]')?.getBoundingClientRect().height || 0,
    hint: document.querySelector('#organization-create-form')?.textContent || '',
    placeholder: document.querySelector('#organization-create-number')?.placeholder || '',
  }))()`);
  if (Math.abs(contactDialogHeight - joinDialogHeight) > 1 || Math.abs(contactDialogHeight - createDialog.height) > 1
    || !createDialog.hint.includes('ORG-0001') || !createDialog.hint.includes('后续可生成分享链接') || !createDialog.placeholder.includes('自动生成')) {
    throw new Error(`Contact add dialog sizing or default organization number guidance is incorrect: ${JSON.stringify({ contactDialogHeight, joinDialogHeight, createDialog })}`);
  }
  await evaluate(cdp, `document.querySelector('[data-contact-add-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-contact-add-dialog]')`);

  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-star-toggle="contacts_smoke_friend"]')?.textContent.includes('设为星标联系人')`);
  await evaluate(cdp, `document.querySelector('[data-contact-star-toggle="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.classList.contains('is-starred') && document.querySelector('.contact-row-star')`);
  const persistedContactStar = await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    const stored = JSON.parse(localStorage.getItem('janus-directory-stars-v1:' + state.currentUser.id) || '{}');
    return stored.contacts?.contacts_smoke_friend === true;
  })()`);
  if (!persistedContactStar) throw new Error('Contact star preference was not persisted for the current account.');
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="starred"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"].is-starred')`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contact-profile-drawer [data-contact-star-toggle="contacts_smoke_friend"]')?.textContent.trim() === '已星标'`);
  await evaluate(cdp, `document.querySelector('.contact-profile-drawer [data-contact-star-toggle="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contact-profile-drawer [data-contact-star-toggle="contacts_smoke_friend"]')?.textContent.trim() === '星标' && document.querySelector('[data-directory-empty="contacts"]')?.textContent.includes('暂无星标联系人')`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile-close]')?.click(); document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]') && !document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.classList.contains('is-starred')`);

  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await waitForRenderer(cdp, `document.querySelectorAll('[data-contact-directory-menu] [data-contact-add-open]').length === 3 && document.querySelector('[data-contact-directory-menu] [data-chat-group-create-open]') && document.querySelector('[data-contact-star-toggle="contacts_smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-directory-menu] [data-chat-group-create-open]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-chat-group-create-overlay]') && document.querySelector('.chat-group-create-close') && document.querySelector('.chat-group-create-members .network-user-avatar') && document.querySelector('[data-chat-group-create-member][value="contacts_smoke_friend"]')?.checked === true && !document.querySelector('[data-contact-directory-menu]')`);
  const chatGroupCreateUi = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.chat-group-create-dialog')?.getBoundingClientRect();
    const close = document.querySelector('.chat-group-create-close')?.getBoundingClientRect();
    const avatar = document.querySelector('.chat-group-create-members .network-user-avatar');
    const style = avatar ? getComputedStyle(avatar) : null;
    return { dialog, close, avatarColor: style?.color || '', avatarBackground: style?.backgroundImage || '' };
  })()`);
  if (!chatGroupCreateUi.dialog || !chatGroupCreateUi.close || chatGroupCreateUi.close.width < 30
    || !chatGroupCreateUi.avatarBackground.includes('gradient') || chatGroupCreateUi.avatarColor === 'rgb(255, 255, 255, 0)') {
    throw new Error(`Chat-group creation dialog styling is incomplete: ${JSON.stringify(chatGroupCreateUi)}`);
  }
  await evaluate(cdp, `document.querySelector('.chat-group-create-close')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-chat-group-create-overlay]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await evaluate(cdp, `document.querySelector('[data-contact-directory-menu] [data-contact-add-open="contact"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#friend-add-search-query')?.value === 'contacts-smoke@example.com' && document.querySelector('[data-contact-add-tab="contact"]')?.classList.contains('active')`);
  await evaluate(cdp, `document.querySelector('[data-contact-add-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-contact-add-dialog]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await evaluate(cdp, `document.querySelector('[data-contact-directory-menu] [data-contact-add-open="join-organization"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-join-form')?.textContent.includes('组织邀请码') && !document.querySelector('#organization-join-form')?.textContent.includes('组织验证码') && document.querySelector('#organization-join-link-form')?.textContent.includes('分享链接') && document.querySelector('[data-contact-add-dialog]')?.textContent.includes('不需要同时填写') && document.querySelector('#organization-join-default')?.checked === true && document.querySelector('[data-contact-add-tab="join-organization"]')?.classList.contains('active')`);
  await evaluate(cdp, `document.querySelector('[data-contact-add-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-contact-add-dialog]')`);

  await evaluate(cdp, `document.querySelector('.im-directory-organization')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.organization-settings-pane')?.textContent.includes('当前组织') && document.querySelector('.organization-settings-pane')?.textContent.includes('组织信息') && document.querySelector('.organization-settings-pane')?.textContent.includes('SMOKE-2026') && !document.querySelector('[data-organization-member]')`);
  await evaluate(cdp, `(() => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'janus://organization/join?organization=INVITED-2026&code=invite-code&name=%E5%8F%97%E9%82%80%E7%BB%84%E7%BB%87&owner=%E9%82%80%E8%AF%B7%E5%88%9B%E5%BB%BA%E8%80%85&v=1');
    document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-organization-invite-dialog]')?.textContent.includes('受邀组织') && document.querySelector('[data-organization-invite-dialog]')?.textContent.includes('INVITED-2026') && document.querySelector('[data-organization-invite-dialog]')?.textContent.includes('邀请创建者') && document.querySelector('#organization-invite-default')?.checked === true && document.querySelector('[data-organization-invite-confirm]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-invite-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-organization-invite-dialog]')`);
  await evaluate(cdp, `document.querySelector('.im-directory-organization')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.organization-settings-pane') && document.querySelector('[data-organization-share-generate="organization_smoke"]') && document.querySelector('[data-organization-action="update_invitation_code"]') && document.querySelector('[data-organization-set-default]')`);
  const organizationSettingsUi = await evaluate(cdp, `(() => ({
    title: document.querySelector('.organization-settings-pane')?.textContent || '',
    helpCount: document.querySelectorAll('.organization-settings-pane .organization-help').length,
    memberRows: document.querySelectorAll('[data-organization-member]').length,
  }))()`);
  if (!organizationSettingsUi.title.includes('通讯录测试组织') || !organizationSettingsUi.title.includes('SMOKE-2026')
    || !organizationSettingsUi.title.includes('默认组织') || organizationSettingsUi.helpCount < 3 || organizationSettingsUi.memberRows !== 0) {
    throw new Error(`Current organization settings are incomplete: ${JSON.stringify(organizationSettingsUi)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-organization-share-generate="organization_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('生成组织分享链接') && document.querySelector('.organization-share-code-field #organization-share-invitation-code') && document.querySelector('.organization-share-url-field #organization-share-link-value') && document.querySelector('[data-organization-share-link-copy]')?.disabled === true && document.querySelector('[data-organization-invitation-reset-from-share]')`);
  const organizationShareLayout = await evaluate(cdp, `(() => {
    const codeField = document.querySelector('.organization-share-code-field')?.getBoundingClientRect();
    const codeInput = document.querySelector('#organization-share-invitation-code')?.getBoundingClientRect();
    const linkField = document.querySelector('.organization-share-url-field')?.getBoundingClientRect();
    const linkInput = document.querySelector('#organization-share-link-value')?.getBoundingClientRect();
    return { codeField, codeInput, linkField, linkInput };
  })()`);
  if (!organizationShareLayout.codeField || !organizationShareLayout.linkField
    || organizationShareLayout.codeField.bottom > organizationShareLayout.linkField.top + 1
    || organizationShareLayout.codeInput.width >= organizationShareLayout.linkInput.width) {
    throw new Error(`Organization share fields must be vertically stacked with a compact invitation-code input: ${JSON.stringify(organizationShareLayout)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-organization-action-close]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-organization-detail-head') && !document.querySelector('.contacts-organization-switch') && !document.querySelector('[data-organization-switch]') && document.querySelector('[data-contact-profile="contacts_smoke_friend"]')`);
  const selectedOrganizationDetail = await evaluate(cdp, `(() => ({
    header: document.querySelector('.contacts-organization-detail-head')?.textContent || '',
    members: [...document.querySelectorAll('[data-organization-member="organization_smoke"]')].map((item) => ({ id: item.dataset.contactProfile || '', role: item.dataset.organizationRole || '' })),
  }))()`);
  if (!selectedOrganizationDetail.header.includes('组织内联系人')
    || !selectedOrganizationDetail.members.some((item) => item.id === 'contacts_smoke_friend')
    || selectedOrganizationDetail.members.some((item) => item.id === 'contacts_smoke_user')) {
    throw new Error(`Organization detail did not preserve its members: ${JSON.stringify(selectedOrganizationDetail)}`);
  }
  const organizationGovernanceUi = await evaluate(cdp, `(() => ({
    switchRemoved: !document.querySelector('.contacts-organization-switch') && !document.querySelector('[data-organization-switch]'),
    headerText: document.querySelector('.contacts-organization-detail-head')?.textContent.trim() || '',
    memberTag: document.querySelector('[data-contact-profile="contacts_smoke_friend"] .organization-role-tag')?.textContent.trim() || '',
  }))()`);
  if (!organizationGovernanceUi.switchRemoved || !organizationGovernanceUi.headerText.includes('组织内联系人')
    || organizationGovernanceUi.memberTag !== '成员') {
    throw new Error(`Organization contact header or role tags are incorrect: ${JSON.stringify(organizationGovernanceUi)}`);
  }
  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    state.organizationShareLinks = { organization_smoke: 'janus://organization/join?organization=SMOKE-2026&code=smoke-invite&name=%E9%80%9A%E8%AE%AF%E5%BD%95%E6%B5%8B%E8%AF%95%E7%BB%84%E7%BB%87&owner=Admin&v=1' };
    document.querySelector('.im-directory-organization')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-organization-share-view="organization_smoke"]')?.textContent.includes('查看分享链接') && !document.querySelector('[data-organization-share-generate="organization_smoke"]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-share-view="organization_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('查看组织分享链接') && document.querySelector('#organization-share-invitation-code')?.value === 'smoke-invite' && document.querySelector('#organization-share-link-value')?.value.includes('SMOKE-2026') && document.querySelector('[data-organization-share-link-copy]')?.disabled === false && document.querySelector('[data-organization-share-regenerate]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-share-regenerate]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('重新生成组织分享链接') && document.querySelector('#organization-share-invitation-code')?.value === 'smoke-invite' && document.querySelector('#organization-action-form button[type="submit"]')?.textContent.includes('重新生成')`);
  await evaluate(cdp, `document.querySelector('[data-organization-action-close]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-organization-action="update_invitation_code"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('修改邀请码') && document.querySelector('#organization-action-form')?.textContent.includes('验证当前身份') && document.querySelector('#organization-action-form')?.textContent.includes('无需邮箱验证') && document.querySelector('#organization-new-invitation-code') && document.querySelector('#organization-confirm-invitation-code') && document.querySelector('#organization-action-code') && document.querySelector('#organization-action-password') && document.querySelector('#organization-remember-secondary-verification') && document.querySelector('[data-organization-invitation-reset-open]') && !document.querySelector('[data-organization-invitation-reset-send-code]')`);
  const invitationDialogLayout = await evaluate(cdp, `(() => {
    const dialog = document.querySelector('.organization-action-dialog');
    const body = document.querySelector('.organization-action-body');
    return {
      rows: dialog ? getComputedStyle(dialog).gridTemplateRows : '',
      overflowY: body ? getComputedStyle(body).overflowY : '',
      help: Boolean(document.querySelector('.organization-invitation-help [role="tooltip"]')),
    };
  })()`);
  if (!invitationDialogLayout.rows || invitationDialogLayout.overflowY !== 'auto' || !invitationDialogLayout.help) {
    throw new Error(`Invitation-code dialog must keep its body scrollable and explanations in help tooltips: ${JSON.stringify(invitationDialogLayout)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-organization-invitation-reset-open]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('重置邀请码') && document.querySelector('#organization-action-form')?.textContent.includes('使用邮箱重置') && document.querySelector('#organization-invitation-reset-email-code')?.required === true && !document.querySelector('#organization-action-code') && !document.querySelector('#organization-action-password') && document.querySelector('[data-organization-invitation-reset-send-code]') && document.querySelector('[data-organization-invitation-reset-back]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-invitation-reset-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form')?.textContent.includes('修改邀请码') && document.querySelector('[data-organization-invitation-reset-open]') && !document.querySelector('[data-organization-invitation-reset-send-code]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-action-close]')?.click()`);
  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    state.organizationSecondaryVerificationById = { organization_smoke: true };
  })()`);
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 620, clientY: 420 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-directory-menu] [data-organization-action="promote_admin"]') && document.querySelector('[data-contact-directory-menu] [data-organization-action="transfer_owner"]') && document.querySelector('[data-contact-directory-menu] [data-organization-action="remove_member"]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-directory-menu] [data-organization-action="transfer_owner"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#organization-action-form') && document.querySelector('#organization-transfer-retain-admin')?.value === 'true' && [...document.querySelectorAll('#organization-transfer-retain-admin option')].map((item) => item.value).join(',') === 'true,false' && document.querySelector('#organization-action-form')?.textContent.includes('本次登录已完成二次验证') && !document.querySelector('#organization-action-code') && !document.querySelector('#organization-action-password')`);
  await evaluate(cdp, `document.querySelector('[data-organization-action-close]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contact-profile-drawer')?.textContent.includes('消息') && document.querySelector('.contact-profile-drawer')?.textContent.includes('备注') && document.querySelector('.contact-profile-organization-actions > header')`);
  const organizationProfileUi = await evaluate(cdp, `(() => {
    const panel = document.querySelector('.contact-profile-organization-actions');
    const action = panel?.querySelector('div > button');
    const icon = action?.querySelector('svg')?.getBoundingClientRect();
    return {
      title: panel?.querySelector('header')?.textContent || '',
      buttonCount: panel?.querySelectorAll('div > button').length || 0,
      actionHeight: action?.getBoundingClientRect().height || 0,
      iconSize: icon?.width || 0,
      profileDescriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.contact-profile-body > p')).fontSize),
      profileActionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.contact-profile-actions button')).fontSize),
      profileActionWhiteSpace: getComputedStyle(document.querySelector('.contact-profile-actions button')).whiteSpace,
      organizationActionFontSize: Number.parseFloat(getComputedStyle(action).fontSize),
      duplicateRemarkLinksRemoved: !document.querySelector('.contact-profile-links') && !document.querySelector('.contact-profile-drawer')?.textContent.includes('备注与描述') && !document.querySelector('.contact-profile-drawer')?.textContent.includes('编辑内容'),
      starLabel: document.querySelector('.contact-profile-drawer [data-contact-star-toggle] span')?.textContent?.trim() || '',
      uBuddyLabel: document.querySelector('.contact-profile-drawer [data-contact-collaboration] span')?.textContent?.trim() || '',
      uBuddyTitle: document.querySelector('.contact-profile-drawer [data-contact-collaboration]')?.title || '',
    };
  })()`);
  if (!organizationProfileUi.title.includes('组织管理') || !organizationProfileUi.title.includes('通讯录测试组织')
    || organizationProfileUi.buttonCount < 2 || organizationProfileUi.actionHeight < 44 || organizationProfileUi.iconSize < 28
    || organizationProfileUi.profileDescriptionFontSize < 15 || organizationProfileUi.profileActionFontSize < 14
    || organizationProfileUi.profileActionWhiteSpace !== 'nowrap' || organizationProfileUi.organizationActionFontSize < 14
    || !organizationProfileUi.duplicateRemarkLinksRemoved || !['星标', '已星标'].includes(organizationProfileUi.starLabel)
    || organizationProfileUi.uBuddyLabel !== 'uBuddy' || !organizationProfileUi.uBuddyTitle.includes('@很长的联系人名称用于验证省略提示')) {
    throw new Error(`Contact profile actions or organization management layout is incomplete: ${JSON.stringify(organizationProfileUi)}`);
  }
  if (process.env.JANUS_CONTACT_PROFILE_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACT_PROFILE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate(cdp, `document.querySelector('.contact-profile-drawer [data-friend-remark="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('#social-edit-input') && document.querySelector('.contact-profile-drawer')`);
  await evaluate(cdp, `document.querySelector('#social-edit-input')?.focus(); document.querySelector('#social-edit-input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitForRenderer(cdp, `document.activeElement === document.querySelector('#social-edit-input') && Boolean(document.querySelector('.contact-profile-drawer'))`);
  await evaluate(cdp, `document.querySelector('#social-edit-cancel')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('#social-edit-input') && Boolean(document.querySelector('.contact-profile-drawer'))`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('.contact-profile-drawer')`);
  if (process.env.JANUS_CONTACTS_ORGANIZATION_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_ORGANIZATION_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await waitForRenderer(cdp, `!document.querySelector('.contacts-organization-switch') && !document.querySelector('[data-organization-switch]')`);
  await evaluate(cdp, `document.querySelector('.im-directory-organization')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.organization-settings-pane')?.textContent.includes('通讯录测试组织') && !document.querySelector('.contacts-organization-detail-head')`);
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')`);
  if (process.env.JANUS_CONTACTS_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }

  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contact-profile-drawer')`);
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="external"]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend_second"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile-id="contacts_smoke_friend_second"]')`);
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile-id="contacts_smoke_friend"]')`);
  await waitForRenderer(cdp, `(() => {
    const employeePane = document.querySelector('.contacts-employees-pane')?.getBoundingClientRect();
    const panel = document.querySelector('.contact-profile-drawer')?.getBoundingClientRect();
    const workspace = document.querySelector('.contacts-workspace')?.getBoundingClientRect();
    return Boolean(employeePane && panel && workspace
      && Math.abs(employeePane.left - panel.left) < 3
      && Math.abs(workspace.right - panel.right) < 3);
  })()`, 5_000);
  await waitForRenderer(cdp, `getComputedStyle(document.querySelector('.contact-profile-drawer')).animationName === 'none'`);
  const drawer = await evaluate(cdp, `(() => {
    const item = document.querySelector('.contacts-employees-pane')?.getBoundingClientRect();
    const panelElement = document.querySelector('.contact-profile-drawer');
    const panel = panelElement?.getBoundingClientRect();
    const workspace = document.querySelector('.contacts-workspace')?.getBoundingClientRect();
    const selectedContact = document.querySelector('[data-contact-profile="contacts_smoke_friend"]');
    return {
      coversEmployeeStart: Boolean(item && panel && Math.abs(item.left - panel.left) < 3),
      rightAligned: Boolean(workspace && panel && Math.abs(workspace.right - panel.right) < 3),
      fullHeight: Boolean(workspace && panel && Math.abs(workspace.height - panel.height) < 3),
      employeeLeft: item?.left || 0,
      panelLeft: panel?.left || 0,
      workspaceRight: workspace?.right || 0,
      panelRight: panel?.right || 0,
      workspaceHeight: workspace?.height || 0,
      panelHeight: panel?.height || 0,
      animationName: panelElement ? getComputedStyle(panelElement).animationName : '',
      selectedContactPresent: Boolean(selectedContact),
      selectedContactHasBlueLine: selectedContact ? getComputedStyle(selectedContact).boxShadow.includes('inset') : false,
    };
  })()`);
  if (!drawer.coversEmployeeStart || !drawer.rightAligned || !drawer.fullHeight || drawer.animationName !== 'none'
    || !drawer.selectedContactPresent || drawer.selectedContactHasBlueLine) {
    throw new Error(`Contact profile is not a right employee-area drawer: ${JSON.stringify(drawer)}`);
  }
  await evaluate(cdp, `document.querySelector('.contacts-workspace-tabs')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('.contact-profile-drawer') && !document.querySelector('[data-contact-profile="contacts_smoke_friend"]')?.classList.contains('active')`);

  await evaluate(cdp, `document.querySelector('[data-contacts-employee-card="employee_active_smoke"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 980, clientY: 420 }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-employee-context-action="toggle-star"]')?.textContent.includes('设为星标员工')`);
  await evaluate(cdp, `document.querySelector('[data-employee-context-action="toggle-star"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-contacts-employee-card="employee_active_smoke"]')?.classList.contains('is-starred') && document.querySelector('[data-contacts-employee-card="employee_active_smoke"] .contacts-employee-star')`);
  await evaluate(cdp, `document.querySelector('[data-contacts-employee-card="employee_active_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer')`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer [data-employee-star-toggle="employee_active_smoke"]')?.textContent.includes('取消星标员工')`);
  await evaluate(cdp, `document.querySelector('.employee-overview-drawer [data-employee-star-toggle="employee_active_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer [data-employee-star-toggle="employee_active_smoke"]')?.textContent.includes('设为星标员工') && !document.querySelector('[data-contacts-employee-card="employee_active_smoke"]')?.classList.contains('is-starred')`);
  const employeeDrawer = await evaluate(cdp, `(() => ({
    width: document.querySelector('.employee-overview-drawer')?.getBoundingClientRect().width || 0,
    tabFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-detail-tabs button')).fontSize),
    headerDescriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-overview-drawer > header p')).fontSize),
    overviewDescriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.employee-overview-grid span')).fontSize),
    actionWhiteSpace: getComputedStyle(document.querySelector('.employee-overview-actions .btn')).whiteSpace,
    scrollbarGutter: getComputedStyle(document.querySelector('.employee-overview-drawer')).scrollbarGutter,
    avatar: document.querySelector('.employee-overview-hero .talent-directory-avatar')?.textContent?.trim() || '',
    avatarTone: [...(document.querySelector('.employee-overview-hero .talent-directory-avatar')?.classList || [])].find((name) => name.startsWith('tone-')) || '',
  }))()`);
  if (employeeDrawer.width < 660 || employeeDrawer.tabFontSize < 13 || employeeDrawer.headerDescriptionFontSize < 15
    || employeeDrawer.overviewDescriptionFontSize < 13 || employeeDrawer.actionWhiteSpace !== 'nowrap'
    || employeeDrawer.scrollbarGutter !== 'stable'
    || employeeDrawer.avatar !== '通用' || employeeDrawer.avatarTone !== 'tone-0') {
    throw new Error(`Employee detail typography is still too small: ${JSON.stringify(employeeDrawer)}`);
  }
  await evaluate(cdp, `document.querySelector('.employee-overview-drawer [data-employee-market="employee_active_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-market-drawer [data-employee-market-back="employee_active_smoke"]')`);
  await evaluate(cdp, `document.querySelector('[data-employee-market-back="employee_active_smoke"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer') && !document.querySelector('.employee-market-drawer')`);
  await evaluate(cdp, `(() => {
    const drawer = document.querySelector('.employee-overview-drawer');
    if (!drawer) return;
    drawer.dataset.stabilityProbe = 'employee-detail-stable';
    const editor = drawer.querySelector('.employee-profile-editor');
    if (editor) editor.open = true;
    drawer.scrollTop = 72;
    drawer.dataset.stabilityScrollTop = String(drawer.scrollTop);
    document.querySelector('#theme-toggle-btn')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer')?.dataset.stabilityProbe === 'employee-detail-stable'`);
  await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-overview-drawer')?.dataset.stabilityProbe === 'employee-detail-stable'`);
  const stableEmployeeDrawer = await evaluate(cdp, `(() => ({
    retained: document.querySelector('.employee-overview-drawer')?.dataset.stabilityProbe === 'employee-detail-stable',
    scrollTop: document.querySelector('.employee-overview-drawer')?.scrollTop || 0,
    expectedScrollTop: Number(document.querySelector('.employee-overview-drawer')?.dataset.stabilityScrollTop || 0),
    editorOpen: Boolean(document.querySelector('.employee-overview-drawer .employee-profile-editor')?.open),
  }))()`);
  if (!stableEmployeeDrawer.retained || !stableEmployeeDrawer.editorOpen
    || Math.abs(stableEmployeeDrawer.scrollTop - stableEmployeeDrawer.expectedScrollTop) > 1) {
    throw new Error(`Employee detail drawer was rebuilt by an unrelated render: ${JSON.stringify(stableEmployeeDrawer)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-employee-detail-tab="memory"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.employee-memory-runtime-note')`);
  const runtimeNote = await evaluate(cdp, `(() => {
    const note = document.querySelector('.employee-memory-runtime-note');
    const style = getComputedStyle(note);
    const toolbarProbe = document.createElement('div');
    toolbarProbe.className = 'employee-drawer-toolbar';
    toolbarProbe.innerHTML = '<span>Memory</span><div><button>清除</button><button>新建</button></div>';
    note?.insertAdjacentElement('afterend', toolbarProbe);
    const toolbarGap = note ? toolbarProbe.getBoundingClientRect().top - note.getBoundingClientRect().bottom : 0;
    toolbarProbe.remove();
    return {
      width: note?.getBoundingClientRect().width || 0,
      height: note?.getBoundingClientRect().height || 0,
      parentWidth: note?.parentElement?.getBoundingClientRect().width || 0,
      borderWidth: style.borderWidth,
      borderStyle: style.borderStyle,
      fontSize: Number.parseFloat(style.fontSize),
      collapsed: Boolean(note && note.tagName === 'DETAILS' && !note.open),
      summaryText: note?.querySelector('summary')?.textContent?.trim() || '',
      toolbarGap,
    };
  })()`);
  if (runtimeNote.borderWidth !== '1px' || runtimeNote.borderStyle !== 'solid' || runtimeNote.fontSize < 11
    || runtimeNote.width < runtimeNote.parentWidth - 66 || runtimeNote.height < 36 || runtimeNote.height > 72
    || !runtimeNote.collapsed || !runtimeNote.summaryText.includes('Memory 如何工作') || runtimeNote.toolbarGap < 12) {
    throw new Error(`Memory runtime explanation is not compact and collapsible: ${JSON.stringify(runtimeNote)}`);
  }
  if (process.env.JANUS_CONTACTS_MEMORY_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_MEMORY_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate(cdp, `document.querySelector('[data-employee-detail-close]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('.employee-overview-drawer')`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 780, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `getComputedStyle(document.querySelector('.contacts-workspace-tabs')).display !== 'none'`);
  const compactContactsTabs = await evaluate(cdp, `({
    visibleLabels: [...document.querySelectorAll('.contacts-workspace-tabs [data-contacts-pane]')]
      .filter((item) => getComputedStyle(item).display !== 'none').map((item) => item.textContent.trim()),
    directoryTabHidden: getComputedStyle(document.querySelector('.contacts-workspace-tabs [data-contacts-pane="directory"]')).display === 'none',
    activeLabel: document.querySelector('.contacts-workspace-tabs [data-contacts-pane].active')?.textContent.trim() || '',
  })`);
  if (compactContactsTabs.visibleLabels.join('|') !== '联系人|我的员工' || !compactContactsTabs.directoryTabHidden
    || !['联系人', '我的员工'].includes(compactContactsTabs.activeLabel)) {
    throw new Error(`Compact contacts tabs expose a misleading directory page: ${JSON.stringify(compactContactsTabs)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-contacts-pane="employees"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.contacts-workspace')?.dataset.activePane === 'employees' && getComputedStyle(document.querySelector('.contacts-employees-pane')).display !== 'none' && getComputedStyle(document.querySelector('.contacts-list-pane')).display === 'none'`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 740, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.contacts-workspace')?.dataset.activePane === 'employees' && getComputedStyle(document.querySelector('.contacts-employees-pane')).display !== 'none'`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-employees') && getComputedStyle(document.querySelector('.network-panel')).display === 'none'`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 901, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-compact.contacts-pane-employees') && getComputedStyle(document.querySelector('.network-panel')).display !== 'none'`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 700, deviceScaleFactor: 1, mobile: false });
  await evaluate(cdp, `document.querySelector('[data-contacts-pane="directory"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-directory') && getComputedStyle(document.querySelector('.network-panel')).display !== 'none'`);
  const narrowDirectory = await evaluate(cdp, `(() => {
    const sidebar = document.querySelector('.sidebar');
    return {
      sidebarVisible: getComputedStyle(sidebar).display !== 'none',
      sidebarWidth: Math.round(sidebar?.getBoundingClientRect().width || 0),
      mainHidden: getComputedStyle(document.querySelector('.main')).display === 'none',
      tabs: [...document.querySelectorAll('#network-panel [data-contacts-pane]')].map((item) => item.textContent.trim()),
      directoryActive: Boolean(document.querySelector('#network-panel [data-contacts-pane="directory"].active')),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  if (!narrowDirectory.sidebarVisible || narrowDirectory.sidebarWidth < 64 || narrowDirectory.sidebarWidth > 76
    || !narrowDirectory.mainHidden || narrowDirectory.tabs.join('|') !== '通讯录|联系人|我的员工'
    || !narrowDirectory.directoryActive || narrowDirectory.horizontalOverflow) {
    throw new Error(`Narrow directory page is not a switchable single-pane layout: ${JSON.stringify(narrowDirectory)}`);
  }
  if (process.env.JANUS_CONTACTS_NARROW_DIRECTORY_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_NARROW_DIRECTORY_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 680, deviceScaleFactor: 1, mobile: false });
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-directory')`);
  const ultraNarrowDirectory = await evaluate(cdp, `(() => {
    const panel = document.querySelector('#network-panel')?.getBoundingClientRect();
    const tabs = document.querySelector('#network-panel .contacts-responsive-tabs')?.getBoundingClientRect();
    const search = document.querySelector('.directory-add-search')?.getBoundingClientRect();
    const visibleMenus = [...document.querySelectorAll('.desktop-menu')].filter((item) => getComputedStyle(item).display !== 'none');
    const lastMenu = visibleMenus.at(-1)?.getBoundingClientRect();
    const themeToggle = document.querySelector('.global-theme-toggle')?.getBoundingClientRect();
    const windowControls = document.querySelector('.window-controls')?.getBoundingClientRect();
    return {
      panelWidth: Math.round(panel?.width || 0),
      tabsContained: Boolean(panel && tabs && tabs.left >= panel.left && tabs.right <= panel.right),
      searchContained: Boolean(panel && search && search.left >= panel.left && search.right <= panel.right),
      titlebarContained: document.querySelector('.window-titlebar')?.scrollWidth <= document.querySelector('.window-titlebar')?.clientWidth + 1,
      titlebarControlsDoNotOverlap: Boolean(lastMenu && themeToggle && windowControls
        && lastMenu.right <= themeToggle.left - 4 && themeToggle.right <= windowControls.left),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  if (ultraNarrowDirectory.panelWidth < 380 || !ultraNarrowDirectory.tabsContained
    || !ultraNarrowDirectory.searchContained || !ultraNarrowDirectory.titlebarContained
    || !ultraNarrowDirectory.titlebarControlsDoNotOverlap
    || ultraNarrowDirectory.horizontalOverflow) {
    throw new Error(`Ultra-narrow directory page is clipped: ${JSON.stringify(ultraNarrowDirectory)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-friend-directory-category="internal"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-contacts') && getComputedStyle(document.querySelector('.network-panel')).display === 'none'`);
  await evaluate(cdp, `document.querySelector('.main [data-contacts-pane="employees"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-employees') && getComputedStyle(document.querySelector('.contacts-employees-pane')).display !== 'none'`);
  const ultraNarrowEmployees = await evaluate(cdp, `(() => {
    const pane = document.querySelector('.contacts-employees-pane')?.getBoundingClientRect();
    const card = document.querySelector('[data-contacts-employee-card]')?.getBoundingClientRect();
    return {
      cardContained: Boolean(pane && card && card.left >= pane.left && card.right <= pane.right),
      cardWidth: Math.round(card?.width || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  if (!ultraNarrowEmployees.cardContained || ultraNarrowEmployees.cardWidth < 250 || ultraNarrowEmployees.horizontalOverflow) {
    throw new Error(`Ultra-narrow employee page is clipped: ${JSON.stringify(ultraNarrowEmployees)}`);
  }
  if (process.env.JANUS_CONTACTS_NARROW_EMPLOYEES_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_NARROW_EMPLOYEES_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate(cdp, `document.querySelector('.main [data-contacts-pane="contacts"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.shell.layout-single.contacts-pane-contacts') && getComputedStyle(document.querySelector('.contacts-list-pane')).display !== 'none'`);
  if (process.env.JANUS_CONTACTS_NARROW_CONTACTS_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACTS_NARROW_CONTACTS_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await waitForRenderer(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_friend"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))`);
  await waitForRenderer(cdp, `document.querySelector('.direct-social-header [data-message-home-back]') && document.querySelector('.direct-social-panel #chat-form')`);
  await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    state.networkConversationMessages = [
      { id: 'direct_peer_1', senderUserId: 'contacts_smoke_friend', content: '对方连续消息一', createdAt: '2026-07-31T09:00:00.000Z', metadata: {} },
      { id: 'direct_peer_2', senderUserId: 'contacts_smoke_friend', content: '对方连续消息二', createdAt: '2026-07-31T09:01:00.000Z', metadata: {} },
      { id: 'direct_mine_1', senderUserId: state.currentUser.id, content: '自己的连续消息一', createdAt: '2026-07-31T09:02:00.000Z', metadata: {} },
      { id: 'direct_mine_2', senderUserId: state.currentUser.id, content: '自己的连续消息二', createdAt: '2026-07-31T09:03:00.000Z', metadata: {} },
    ];
    document.querySelector('#theme-toggle-btn')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelectorAll('.direct-social-message').length === 4 && document.querySelectorAll('.direct-social-message.is-consecutive-message').length === 2`);
  const directChatHeader = await evaluate(cdp, `(() => {
    const title = document.querySelector('.direct-social-header .social-group-title')?.getBoundingClientRect();
    const close = document.querySelector('.direct-social-header [data-message-home-back]')?.getBoundingClientRect();
    const placeholder = document.querySelector('.social-chat-utility-placeholder')?.getBoundingClientRect();
    const main = document.querySelector('.main')?.getBoundingClientRect();
    const peerMessages = [...document.querySelectorAll('.direct-social-message.assistant')];
    const ownMessages = [...document.querySelectorAll('.direct-social-message.user')];
    const bodyRect = (message) => message?.querySelector('.message-body')?.getBoundingClientRect();
    const bodyStyle = (message) => message ? getComputedStyle(message.querySelector('.message-body')) : null;
    const peerFirst = bodyRect(peerMessages[0]);
    const peerNext = bodyRect(peerMessages[1]);
    const ownFirst = bodyRect(ownMessages[0]);
    const ownNext = bodyRect(ownMessages[1]);
    const peerFirstStyle = bodyStyle(peerMessages[0]);
    const peerNextStyle = bodyStyle(peerMessages[1]);
    const ownFirstStyle = bodyStyle(ownMessages[0]);
    const ownNextStyle = bodyStyle(ownMessages[1]);
    return {
      sameRow: Boolean(title && close && Math.abs((title.top + title.height / 2) - (close.top + close.height / 2)) <= 1),
      placeholderHeight: placeholder?.height ?? -1,
      closeCount: document.querySelectorAll('[data-message-home-back]').length,
      sidebarVisible: getComputedStyle(document.querySelector('.sidebar')).display !== 'none',
      sidebarWidth: Math.round(document.querySelector('.sidebar')?.getBoundingClientRect().width || 0),
      messageListHidden: getComputedStyle(document.querySelector('#network-panel')).display === 'none',
      mainFillsRemainingWidth: Boolean(main && main.width >= innerWidth - (document.querySelector('.sidebar')?.getBoundingClientRect().width || 0) - 20),
      backLabel: document.querySelector('.direct-social-header [data-message-home-back]')?.getAttribute('aria-label') || '',
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      peerEdgesAligned: Boolean(peerFirst && peerNext && Math.abs(peerFirst.left - peerNext.left) <= 1),
      ownEdgesAligned: Boolean(ownFirst && ownNext && Math.abs(ownFirst.right - ownNext.right) <= 1),
      peerCorners: peerFirstStyle && peerNextStyle ? [
        Number.parseFloat(peerFirstStyle.borderTopLeftRadius),
        Number.parseFloat(peerFirstStyle.borderBottomLeftRadius),
        Number.parseFloat(peerNextStyle.borderTopLeftRadius),
        Number.parseFloat(peerNextStyle.borderBottomLeftRadius),
      ] : [],
      ownCorners: ownFirstStyle && ownNextStyle ? [
        Number.parseFloat(ownFirstStyle.borderTopRightRadius),
        Number.parseFloat(ownFirstStyle.borderBottomRightRadius),
        Number.parseFloat(ownNextStyle.borderTopRightRadius),
        Number.parseFloat(ownNextStyle.borderBottomRightRadius),
      ] : [],
    };
  })()`);
  if (!directChatHeader.sameRow || directChatHeader.placeholderHeight !== 0 || directChatHeader.closeCount !== 1
    || !directChatHeader.sidebarVisible || directChatHeader.sidebarWidth < 64 || directChatHeader.sidebarWidth > 76
    || !directChatHeader.messageListHidden || !directChatHeader.mainFillsRemainingWidth
    || !directChatHeader.backLabel.includes('返回消息列表') || directChatHeader.horizontalOverflow
    || !directChatHeader.peerEdgesAligned || !directChatHeader.ownEdgesAligned
    || directChatHeader.peerCorners.join(',') !== '3,3,3,10'
    || directChatHeader.ownCorners.join(',') !== '3,3,3,10') {
    throw new Error(`Direct chat close control still occupies a separate header row: ${JSON.stringify(directChatHeader)}`);
  }
  if (process.env.JANUS_CONTACT_DIRECT_CHAT_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_CONTACT_DIRECT_CHAT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  const doubleClickState = await evaluate(cdp, `(async () => { const { state } = await import('./app/state.js'); return { panel: state.networkPanelView, peerId: state.networkConversationPeerId, profileOpen: state.networkContactProfileOpen }; })()`);
  if (doubleClickState.panel !== 'messages' || doubleClickState.peerId !== 'contacts_smoke_friend' || doubleClickState.profileOpen) {
    throw new Error(`Organization contact double-click did not open messaging: ${JSON.stringify(doubleClickState)}`);
  }

  await evaluate(cdp, `document.querySelector('[data-message-home-back]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-view="friends"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await evaluate(cdp, `(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const { state } = await import('./app/state.js');
    const organizationOnlyFriend = {
      id: 'contacts_smoke_organization_only',
      displayName: '仅组织内联系人',
      username: 'contacts-smoke-organization-only',
      email: 'contacts-smoke-organization-only@example.com',
    };
    const organizations = [...(state.friendOverview?.organizations || [])];
    const organizationIndex = organizations.findIndex((item) => item.id === 'organization_smoke');
    const organization = organizationIndex >= 0 ? organizations[organizationIndex] : {
      id: 'organization_smoke',
      organizationNumber: 'SMOKE-2026',
      name: '通讯录测试组织',
      role: 'owner',
      members: [],
    };
    const members = [...(organization.members || [])].filter((item) => item?.user?.id !== organizationOnlyFriend.id);
    organizations.splice(Math.max(0, organizationIndex), organizationIndex >= 0 ? 1 : 0, {
      ...organization,
      memberCount: members.length + 1,
      members: [...members, { role: 'member', user: organizationOnlyFriend }],
    });
    state.friendOverview = { ...(state.friendOverview || {}), organizations };
    state.friendDirectoryCategory = 'internal';
    state.contactsSelectedOrganizationId = 'organization_smoke';
    document.querySelector('[data-friend-directory-category="internal"]')?.click();
  })()`);
  await waitForRenderer(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_organization_only"]')`);
  await evaluate(cdp, `document.querySelector('[data-organization-member="organization_smoke"][data-contact-profile="contacts_smoke_organization_only"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  await waitForRenderer(cdp, `document.querySelector('[data-contact-profile-message="contacts_smoke_organization_only"]')`);
  await evaluate(cdp, `document.querySelector('[data-contact-profile-message="contacts_smoke_organization_only"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.direct-social-header')?.textContent.includes('仅组织内联系人') && document.querySelector('.direct-social-panel #chat-form')`);
  const organizationOnlyMessageState = await evaluate(cdp, `(async () => {
    const { state } = await import('./app/state.js');
    return {
      peerId: state.networkConversationPeerId,
      mode: state.networkConversationMode,
      profileOpen: state.networkContactProfileOpen,
      selectedContactId: state.networkSelectedContactId,
      agentId: state.currentAgentId,
      sessionId: state.currentSessionId,
      directChat: Boolean(document.querySelector('.direct-social-chat-view')),
      agentHome: Boolean(document.querySelector('.home-stage')),
    };
  })()`);
  if (organizationOnlyMessageState.peerId !== 'contacts_smoke_organization_only'
    || organizationOnlyMessageState.mode !== 'person'
    || organizationOnlyMessageState.profileOpen
    || organizationOnlyMessageState.selectedContactId
    || organizationOnlyMessageState.agentId
    || organizationOnlyMessageState.sessionId
    || !organizationOnlyMessageState.directChat
    || organizationOnlyMessageState.agentHome) {
    throw new Error(`Organization-only contact profile message action opened the wrong surface: ${JSON.stringify(organizationOnlyMessageState)}`);
  }

  console.log('contacts workspace smoke passed (organization drill-down, stable contact drawer, dual-column context menus, organization-only profile messaging, double-click messaging)');
  cdp.close();
  }
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-4000)}`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
  try { rmSync(smokeHome, { recursive: true, force: true }); } catch {}
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitForRenderer(cdp, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Electron is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer.');
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const request = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) request.reject(new Error(payload.error.message || 'CDP request failed'));
    else request.resolve(payload.result || {});
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = nextId++;
        const response = new Promise((requestResolve, requestReject) => pending.set(id, { resolve: requestResolve, reject: requestReject }));
        socket.send(JSON.stringify({ id, method, params }));
        return response;
      },
      close() { socket.close(); },
    }), { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
  });
}
