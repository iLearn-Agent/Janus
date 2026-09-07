import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const smokeHome = mkdtempSync(path.join(os.tmpdir(), 'janus-network-layout-'));
const stateEntry = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'state.js')).href;
const port = Number(process.env.JANUS_NETWORK_LAYOUT_PORT || 9444);
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_LOCAL_EVOLUTION_ENABLED: '0',
  JANUS_MODEL_REFRESH_ENABLED: '0',
  JANUS_UBUDDY_PROCESSING_MODE: 'fallback',
  JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
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
  const result = await cdp.send('Runtime.evaluate', {
    expression: `
      new Promise((resolve, reject) => {
        let attempts = 0;
        let openedMessages = false;
        let openedUBuddy = false;
        let initialCaptured = false;
        let defaultMessages = false;
        let messageWorkspaceReset = false;
        let defaultLatestModel = false;
        let defaultMediumReasoning = false;
        let defaultUBuddyHidden = false;
        let imageIconColor = '';
        let composerControlsSeparated = false;
        const tick = () => {
          if (!initialCaptured) {
            const initialModelTrigger = document.querySelector('#model-picker-trigger');
            const imageIcon = document.querySelector('[data-composer-image-mode] svg');
            if (!document.querySelector('.chat-view') || !initialModelTrigger || !imageIcon) {
              const uBuddyEntry = document.querySelector('[data-network-peer="self-secretary"]');
              if (!openedUBuddy && document.querySelector('[data-message-default-page]') && uBuddyEntry) {
                openedUBuddy = true;
                uBuddyEntry.addEventListener('click', () => { window.__janusSmokeUBuddyClicks = Number(window.__janusSmokeUBuddyClicks || 0) + 1; }, { once: true });
                uBuddyEntry.click();
              }
              attempts += 1;
              if (attempts > 120) {
                return import(${JSON.stringify(stateEntry)}).then(({ state }) => reject(new Error('messages workspace did not render: ' + JSON.stringify({
                  chatView: Boolean(document.querySelector('.chat-view')),
                  modelTrigger: Boolean(initialModelTrigger),
                  imageIcon: Boolean(imageIcon),
                  uBuddyClicks: Number(window.__janusSmokeUBuddyClicks || 0),
                  uBuddyBusy: document.querySelector('[data-network-peer="self-secretary"]')?.getAttribute('aria-busy') || '',
                  currentTab: state.currentTab,
                  currentSessionId: state.currentSessionId,
                  currentChatKey: state.currentChatKey,
                  homeMode: state.homeMode,
                  networkPanelView: state.networkPanelView,
                  networkMessageHomeOpen: state.networkMessageHomeOpen,
                  uBuddyConversationOpening: state.uBuddyConversationOpening,
                  bodyText: (document.body?.innerText || '').slice(0, 500),
                }))));
              }
              return setTimeout(tick, 100);
            }
            defaultMessages = Boolean(document.querySelector('.shell')?.classList.contains('network-panel-open'))
              && Boolean(document.querySelector('.network-panel .network-messages'));
            messageWorkspaceReset = Boolean(document.querySelector('[data-message-section="conversations"]'))
              && document.querySelectorAll('[data-network-peer="self-secretary"]').length === 1
              && document.querySelectorAll('[data-network-peer="self-private-assistant"]').length === 1
              && !document.querySelector('[data-message-private-assistant]')
              && !document.querySelector('.talent-market-panel');
            defaultLatestModel = Boolean(initialModelTrigger.dataset.modelCurrent) && initialModelTrigger.dataset.modelCurrent === initialModelTrigger.dataset.modelLatest;
            defaultMediumReasoning = initialModelTrigger.dataset.reasoningCurrent === 'medium';
            defaultUBuddyHidden = !document.querySelector('.main [data-composer-ubuddy-mode]');
            imageIconColor = getComputedStyle(imageIcon).color;
            const composerControlRects = [...document.querySelectorAll('.main #chat-form .composer-quick-actions button, .main #chat-form .composer-controls button')]
              .map((item) => item.getBoundingClientRect())
              .filter((rect) => rect.width > 0 && rect.height > 0);
            composerControlsSeparated = composerControlRects.every((rect, index) => composerControlRects.slice(index + 1).every((next) => (
              rect.right <= next.left + 0.5 || next.right <= rect.left + 0.5 || rect.bottom <= next.top + 0.5 || next.bottom <= rect.top + 0.5
            )));
            initialCaptured = true;
          }
          const button = document.querySelector('[data-network-peer="self-secretary"]');
          const main = document.querySelector('.main');
          const panel = document.querySelector('.network-panel');
          if (!button || !main || !panel) {
            if (!openedMessages) {
              document.querySelector('[data-network-view="messages"]')?.click();
              openedMessages = true;
            }
            attempts += 1;
            if (attempts > 120) return reject(new Error('uBuddy message entry did not render'));
            return setTimeout(tick, 100);
          }
          const before = main.getBoundingClientRect();
          button.click();
          setTimeout(() => {
            const nextMain = document.querySelector('.main')?.getBoundingClientRect();
            const nextPanel = document.querySelector('.network-panel')?.getBoundingClientRect();
            const text = document.querySelector('.network-panel')?.textContent || '';
            const conversation = document.querySelector('.network-panel .network-conversation');
            const composerButton = document.querySelector('.main [data-composer-ubuddy-mode]');
            const input = document.querySelector('.main #chat-input');
            const activeState = {
              buttonAbsent: !composerButton,
              placeholder: input?.getAttribute('placeholder') || '',
              mention: Boolean(document.querySelector('.main [data-social-mention-toggle]')),
            };
            resolve({
              mainLeftBefore: before.left,
              mainLeftAfter: nextMain?.left || 0,
              mainWidthAfter: nextMain?.width || 0,
              panelWidth: nextPanel?.width || 0,
              messagePanelStillOpen: Boolean(nextPanel),
              conversationInsideMessagePanel: Boolean(conversation),
              standardChatOpen: Boolean(document.querySelector('.main .chat-view #chat-form')),
              uBuddyComposerButtonAbsent: activeState.buttonAbsent,
              uBuddyPlaceholder: activeState.placeholder,
              uBuddyMention: activeState.mention,
              pinnedUBuddyLabel: document.querySelector('[data-network-peer="self-secretary"] strong')?.textContent?.trim() === 'uBuddy',
              pptShortcutRemoved: !document.querySelector('[data-composer-ppt-mode]'),
              hasUBuddy: text.includes('uBuddy'),
              hasLocalTag: text.includes('本机'),
              defaultMessages,
              messageWorkspaceReset,
              defaultLatestModel,
              defaultMediumReasoning,
              defaultUBuddyHidden,
              imageIconColor,
              composerControlsSeparated,
              composerMoreRemoved: !document.querySelector('.composer-more') && !document.querySelector('[data-composer-more-toggle]'),
            });
          }, 500);
        };
        tick();
      })
    `,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`Layout probe failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown renderer exception'}`);
  }
  const metrics = result.result?.value || {};
  if (process.env.JANUS_MESSAGE_LAYOUT_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_MESSAGE_LAYOUT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  if (!metrics.defaultMessages) throw new Error(`Application did not start on the messages view: ${JSON.stringify(metrics)}`);
  if (!metrics.messageWorkspaceReset) throw new Error(`Messages workspace reset is incomplete: ${JSON.stringify(metrics)}`);
  if (!metrics.composerControlsSeparated) throw new Error(`Composer controls overlap at the default window width: ${JSON.stringify(metrics)}`);
  if (!metrics.composerMoreRemoved) throw new Error('Composer More control still exists.');
  if (!metrics.defaultLatestModel || !metrics.defaultMediumReasoning) throw new Error('Default model is not latest or reasoning is not medium.');
  if (!metrics.defaultUBuddyHidden) throw new Error(`uBuddy still renders as a composer feature button: ${JSON.stringify(metrics)}`);
  if (metrics.imageIconColor !== 'rgb(14, 165, 233)') throw new Error('Image composer icon color is incorrect.');
  if (!metrics.pptShortcutRemoved) throw new Error('PPT still appears as a generic composer shortcut.');
  if (!metrics.messagePanelStillOpen || metrics.conversationInsideMessagePanel || !metrics.standardChatOpen) {
    throw new Error(`uBuddy did not stay in the three-column message layout: ${JSON.stringify(metrics)}`);
  }
  if (!metrics.uBuddyComposerButtonAbsent || !metrics.uBuddyPlaceholder.includes('告诉 uBuddy') || !metrics.uBuddyMention || !metrics.pinnedUBuddyLabel) {
    throw new Error(`uBuddy did not open as a persistent chat correctly: ${JSON.stringify(metrics)}`);
  }
  if (!metrics.hasUBuddy || metrics.hasLocalTag) throw new Error('uBuddy label or removed local tag is incorrect.');

  await evaluate(cdp, `document.querySelector('[data-tab="employees"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.talent-directory-view')`);
  const uBuddyTalentUi = await evaluate(cdp, `({
    absent: ![...document.querySelectorAll('.talent-directory-card')].some((item) => item.textContent.includes('uBuddy')),
  })`);
  if (!uBuddyTalentUi.absent) {
    throw new Error(`uBuddy must remain a single Messages entry instead of a talent-market employee: ${JSON.stringify(uBuddyTalentUi)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-app-nav="messages"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-peer="self-secretary"]')`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-peer="self-secretary"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-peer="self-secretary"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-peer="self-secretary"].active') && !document.querySelector('[data-composer-ubuddy-mode]') && document.querySelector('[data-social-mention-toggle]')`);

  const db = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'));
  const searchableAgentIdentity = db.prepare(`SELECT instance.id AS agent_instance_id,
      instance.agent_family_id, family.department_id
    FROM user_agent_instances instance JOIN agent_families family ON family.id=instance.agent_family_id
    WHERE instance.user_id='local_admin' AND instance.agent_family_id!='secretary_agent'
    ORDER BY instance.created_at LIMIT 1`).get();
  if (!searchableAgentIdentity?.agent_instance_id) throw new Error('No active employee identity was available for conversation full-text search verification.');
  const searchableAgentSessionId = 'smoke_searchable_agent_session';
  db.prepare(`INSERT INTO sessions(id,user_id,title,department_id,agent_id,agent_instance_id,status)
    VALUES(?,?,?,?,?,?,'active')`).run(
    searchableAgentSessionId, 'local_admin', 'Searchable employee conversation', searchableAgentIdentity.department_id,
    searchableAgentIdentity.agent_family_id, searchableAgentIdentity.agent_instance_id,
  );
  db.prepare(`INSERT INTO auth_users (id, email, display_name, username, role, email_verified, remote_id) VALUES (?, ?, ?, ?, 'member', 1, ?)`)
    .run('smoke_friend', 'smoke.friend@janus.test', 'Smoke Friend', 'smoke_friend', 'local:smoke_friend');
  db.prepare(`INSERT INTO auth_users (id, email, display_name, username, role, email_verified, remote_id) VALUES (?, ?, ?, ?, 'member', 1, ?)`)
    .run('smoke_requester', 'requester@janus.test', 'Pending Requester', 'pending_requester', 'local:smoke_requester');
  db.prepare(`INSERT INTO friendships (id, user_a_id, user_b_id, status) VALUES (?, ?, ?, 'accepted')`)
    .run('smoke_friendship', 'local_admin', 'smoke_friend');
  db.prepare(`INSERT INTO friend_requests (id, requester_id, recipient_id, status, message) VALUES (?, ?, ?, 'pending', ?)`)
    .run('smoke_friend_request', 'smoke_requester', 'local_admin', '请通过好友申请');
  const socialConversationId = 'social_direct:personal_direct:personal:local_admin:smoke_friend';
  const localAccountId = 'account_personal_local_admin';
  const friendAccountId = 'account_personal_smoke_friend';
  db.prepare(`INSERT OR IGNORE INTO accounts(id,account_kind,owner_user_id,name,status)
    VALUES(?,'personal',?,'个人账号','active')`).run(localAccountId, 'local_admin');
  db.prepare(`INSERT OR IGNORE INTO accounts(id,account_kind,owner_user_id,name,status)
    VALUES(?,'personal',?,'个人账号','external')`).run(friendAccountId, 'smoke_friend');
  db.prepare(`INSERT OR IGNORE INTO account_memberships(account_id,user_id,role,status)
    VALUES(?,?,'owner','active')`).run(friendAccountId, 'smoke_friend');
  db.prepare(`INSERT INTO social_direct_conversations(id,conversation_kind,anchor_account_id,user_a_id,user_b_id,status)
    VALUES(?,'personal_direct','',?,?,'active')`).run(socialConversationId, 'local_admin', 'smoke_friend');
  db.prepare(`INSERT INTO conversation_account_bindings(conversation_id,account_id,binding_role,access_status)
    VALUES(?,?,'participant','active')`).run(socialConversationId, localAccountId);
  db.prepare(`INSERT INTO conversation_account_bindings(conversation_id,account_id,binding_role,access_status)
    VALUES(?,?,'participant','active')`).run(socialConversationId, friendAccountId);
  db.prepare(`INSERT INTO social_messages (id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, kind, content, status)
    VALUES (?, 'workspace_personal', ?, ?, ?, 'friend', ?, 'unread')`)
    .run('smoke_incoming', socialConversationId, 'smoke_friend', 'local_admin', '之前的聊天记录');
  db.prepare(`INSERT INTO social_messages (id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, kind, content, status, created_at, updated_at)
    VALUES (?, 'workspace_personal', ?, ?, ?, 'friend', ?, 'sent', ?, ?)`)
    .run('smoke_outgoing_latest', socialConversationId, 'local_admin', 'smoke_friend', '项目协作人最新消息', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  db.prepare(`INSERT INTO messages (
      id,session_id,role,content,agent_id,agent_instance_id,department_id,visible,created_at
    ) VALUES (?,?,'user',?,?,?,?,1,?)`).run(
    'smoke_agent_search_message', searchableAgentSessionId, '仅存在于 Agent 历史消息中的月光石关键词',
    searchableAgentIdentity.agent_family_id, searchableAgentIdentity.agent_instance_id,
    searchableAgentIdentity.department_id, '2099-01-01T00:00:00.000Z',
  );
  db.close();
  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    state.sessions = await window.janus.listSessions();
    document.querySelector('#theme-toggle-btn')?.click();
  })()`);

  const newCollaborationUi = await evaluate(cdp, `Boolean(document.querySelector('[data-message-section="conversations"]'))`);
  if (newCollaborationUi) {
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.contacts-workspace') && document.querySelector('[data-friend-directory-category="new"]')`);
    await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.network-message-item[data-network-peer="smoke_friend"]')`);
    const initialConversationUi = await evaluate(cdp, `({
      unreadCount: document.querySelector('.direct-message-item[data-network-peer="smoke_friend"]')?.dataset.unreadCount || '',
      unreadClass: Boolean(document.querySelector('.direct-message-item[data-network-peer="smoke_friend"].is-unread')),
      unreadBadge: document.querySelector('.message-panel-title b')?.getAttribute('aria-label') || '',
      searchRemoved: !document.querySelector('[data-conversation-search-toggle], #network-conversation-search-popover, #network-conversation-search'),
      removedEmptyRow: !document.querySelector('[data-conversation-search-empty]'),
    })`);
    if (initialConversationUi.unreadCount !== '1' || !initialConversationUi.unreadClass || !initialConversationUi.unreadBadge.includes('1 条未读消息')
      || !initialConversationUi.searchRemoved || !initialConversationUi.removedEmptyRow) {
      throw new Error(`Initial conversation unread state is incorrect: ${JSON.stringify(initialConversationUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('#friend-search-query') && document.querySelector('[data-friend-directory-category="new"] .im-directory-nav-badge') && document.querySelector('[data-friend-directory-category="external"]')`);
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="external"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="smoke_friend"]')`);
    const initialDirectoryUi = await evaluate(cdp, `({
      categories: [...document.querySelectorAll('[data-friend-directory-category]')].map((item) => item.dataset.friendDirectoryCategory),
      requestBadge: document.querySelector('[data-friend-directory-category="new"] .im-directory-nav-badge')?.textContent || '',
      contactUnread: document.querySelector('[data-contact-profile="smoke_friend"] .im-directory-unread:not(.is-empty)')?.textContent || '',
      localSearchPresent: Boolean(document.querySelector('#friend-search-query')),
      addButtonPresent: Boolean(document.querySelector('[data-contact-add-open="contact"]')),
      legacySectionsRemoved: !document.querySelector('[data-directory-section], #friend-search-form'),
    })`);
    if (initialDirectoryUi.categories.join(',') !== 'internal,external,new,starred,groups'
      || initialDirectoryUi.requestBadge !== '1' || initialDirectoryUi.contactUnread !== '1'
      || !initialDirectoryUi.localSearchPresent || !initialDirectoryUi.addButtonPresent || !initialDirectoryUi.legacySectionsRemoved) {
      throw new Error(`Current contacts navigation or unread state is incorrect: ${JSON.stringify(initialDirectoryUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="new"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.contact-requests-pane')?.textContent.includes('Pending Requester')`);
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="external"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="smoke_friend"]')`);
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-search-query'); input.focus(); input.value = 'Smoke Friend'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="smoke_friend"]')?.getClientRects().length && document.activeElement === document.querySelector('#friend-search-query')`);
    const localSearchUi = await evaluate(cdp, `({
      value: document.querySelector('#friend-search-query')?.value || '',
      remoteResultsAbsent: !document.querySelector('.network-user-search-results'),
      contactVisible: Boolean(document.querySelector('[data-contact-profile="smoke_friend"]')?.getClientRects().length),
    })`);
    if (localSearchUi.value !== 'Smoke Friend' || !localSearchUi.remoteResultsAbsent || !localSearchUi.contactVisible) {
      throw new Error(`Local directory filtering is incorrect: ${JSON.stringify(localSearchUi)}`);
    }
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-search-query'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-contact-add-open="contact"]')?.click(); })()`);
    await waitForRenderer(cdp, `document.querySelector('#contact-add-search-form') && document.querySelector('#friend-add-search-query')`);
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-add-search-query'); input.value = 'Smoke Friend'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#contact-add-search-form')?.requestSubmit(); })()`);
    await waitForRenderer(cdp, `document.querySelector('.network-user-search-results [data-network-ubuddy-target="smoke_friend"]')`);
    const remoteSearchUi = await evaluate(cdp, `({
      heading: document.querySelector('.network-user-search-results .network-section-title')?.textContent || '',
      insideAddDialog: Boolean(document.querySelector('[data-contact-add-dialog] .network-user-search-results')),
      taskLabel: document.querySelector('.network-user-search-results [data-network-ubuddy-target="smoke_friend"]')?.textContent || '',
    })`);
    if (!remoteSearchUi.heading.includes('查找新用户') || !remoteSearchUi.heading.includes('Smoke Friend') || !remoteSearchUi.insideAddDialog || remoteSearchUi.taskLabel.trim() !== 'uBuddy 发任务') {
      throw new Error(`Remote user search hierarchy is incorrect: ${JSON.stringify(remoteSearchUi)}`);
    }
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-add-search-query'); input.focus(); input.value = 'Smoke Fri'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitForRenderer(cdp, `!document.querySelector('.network-user-search-results') && document.querySelector('#friend-add-search-query')?.value === 'Smoke Fri' && document.activeElement === document.querySelector('#friend-add-search-query')`);
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-add-search-query'); input.value = 'janus-no-such-user'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#contact-add-search-form')?.requestSubmit(); })()`);
    await waitForRenderer(cdp, `document.querySelector('.network-user-search-results .im-list-empty.compact')?.textContent.includes('未找到可添加的用户')`);
    await evaluate(cdp, `(() => { const input = document.querySelector('#friend-add-search-query'); input.value = 'Smoke Friend'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#contact-add-search-form')?.requestSubmit(); })()`);
    await waitForRenderer(cdp, `document.querySelector('.network-user-search-results [data-network-ubuddy-target="smoke_friend"]')`);
    await evaluate(cdp, `document.querySelector('[data-network-ubuddy-target="smoke_friend"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.direct-social-panel #chat-form') && document.querySelector('#chat-input')?.value.includes('@我的uBuddy')`);
    await waitForRenderer(cdp, `document.querySelector('.direct-message-item[data-network-peer="smoke_friend"].active:not(.is-unread)')`);
    const activeDirectConversationUi = await evaluate(cdp, `({
      unreadCount: document.querySelector('.direct-message-item[data-network-peer="smoke_friend"]')?.dataset.unreadCount || '',
      unreadBadgeRemoved: !document.querySelector('.message-panel-title b'),
    })`);
    if (activeDirectConversationUi.unreadCount !== '0' || !activeDirectConversationUi.unreadBadgeRemoved) {
      throw new Error(`Active direct conversation did not clear unread state: ${JSON.stringify(activeDirectConversationUi)}`);
    }
    const searchDispatchDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
    const searchDispatchGroupCount = searchDispatchDb.prepare('SELECT count(*) count FROM collaboration_groups').get().count;
    searchDispatchDb.close();
    if (searchDispatchGroupCount !== 0) throw new Error('Friend search uBuddy action still created a legacy group before draft confirmation.');
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-profile="smoke_friend"]')`);
    const clearedContactUnreadUi = await evaluate(cdp, `({
      badgeCleared: !document.querySelector('[data-contact-profile="smoke_friend"] .im-directory-unread:not(.is-empty)'),
      contactPresent: Boolean(document.querySelector('[data-contact-profile="smoke_friend"]')),
    })`);
    if (!clearedContactUnreadUi.badgeCleared || !clearedContactUnreadUi.contactPresent) {
      throw new Error(`Opening a direct conversation did not clear its directory unread state: ${JSON.stringify(clearedContactUnreadUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-contact-profile="smoke_friend"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))`);
    await waitForRenderer(cdp, `document.querySelector('.direct-social-panel #chat-form')`);
    const directUi = await evaluate(cdp, `({
      subtitle: document.querySelector('.direct-social-header')?.textContent || '',
      previousMessage: document.querySelector('.direct-social-panel .message-list')?.textContent || '',
      headerAtTop: (() => { const panel = document.querySelector('.direct-social-panel')?.getBoundingClientRect(); const header = document.querySelector('.direct-social-header')?.getBoundingClientRect(); return Boolean(panel && header && header.top - panel.top < 8); })(),
      firstMessageInTopHalf: (() => { const panel = document.querySelector('.direct-social-panel')?.getBoundingClientRect(); const message = document.querySelector('.direct-social-message')?.getBoundingClientRect(); return Boolean(panel && message && message.top < panel.top + panel.height / 2); })(),
      noGroupCreated: true,
    })`);
    if (!directUi.subtitle.includes('双人私聊') || !directUi.previousMessage.includes('之前的聊天记录') || !directUi.headerAtTop || !directUi.firstMessageInTopHalf) {
      throw new Error(`Friend click did not open a direct chat: ${JSON.stringify(directUi)}`);
    }
    const directDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
    const initialGroupCount = directDb.prepare('SELECT count(*) count FROM collaboration_groups').get().count;
    directDb.close();
    if (initialGroupCount !== 0) throw new Error('Opening a friend chat unexpectedly created a collaboration group.');

    await submitMainComposer(cdp, '这是一条普通双人消息');
    await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE content = '这是一条普通双人消息' AND json_extract(metadata_json, '$.type') = 'direct_message'").get().count === 1);
    await submitMainComposer(cdp, '@我的uBuddy 请让 Smoke Friend 制作一份测试汇报', ['@我的uBuddy']);
    await waitForRenderer(cdp, `document.querySelector('.direct-private-task-thread') && document.querySelector('.ubuddy-published-task-card[data-task-workspace-id]')`, 30_000);
    const publishedTaskUi = await evaluate(cdp, `({
      privateText: document.querySelector('.direct-private-task-thread')?.textContent || '',
      taskText: document.querySelector('.ubuddy-published-task-card')?.textContent || '',
      openWorkspace: Boolean(document.querySelector('.ubuddy-published-task-card [data-task-card-action="open_workspace"]')),
      openFlow: Boolean(document.querySelector('.ubuddy-published-task-card [data-task-card-action="open_flow_graph"]')),
      legacyDraftRemoved: !document.querySelector('.private-dispatch-draft, [data-collaboration-draft-confirm]'),
    })`);
    if (!publishedTaskUi.privateText.includes('仅自己可见') || !publishedTaskUi.privateText.includes('请让 Smoke Friend 制作一份测试汇报')
      || !publishedTaskUi.taskText.includes('任务已发布') || !publishedTaskUi.openWorkspace || !publishedTaskUi.openFlow
      || !publishedTaskUi.legacyDraftRemoved) {
      throw new Error(`Direct uBuddy task publication is incorrect: ${JSON.stringify(publishedTaskUi)}`);
    }
    if (process.env.JANUS_DRAFT_LAYOUT_SCREENSHOT) {
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(process.env.JANUS_DRAFT_LAYOUT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
    await waitForDatabase(smokeHome, (database) => database.prepare('SELECT count(*) count FROM collaboration_groups').get().count === 1
      && database.prepare("SELECT count(*) count FROM agent_delegations WHERE group_id <> '' AND instruction LIKE '%制作一份测试汇报%'").get().count === 1, 30_000);
    const trueGroupDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
    const trueCollaborationGroupId = trueGroupDb.prepare("SELECT id FROM collaboration_groups ORDER BY created_at ASC LIMIT 1").get().id;
    trueGroupDb.close();
    await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-collaboration-group="${trueCollaborationGroupId}"]')`);
    await evaluate(cdp, `document.querySelector('[data-collaboration-group="${trueCollaborationGroupId}"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.collaboration-group-chat-view')`);
    const groupUi = await evaluate(cdp, `({
      participants: document.querySelectorAll('.collaboration-group-chat-view .social-participant').length,
      taskCards: document.querySelectorAll('.collaboration-group-chat-view .ubuddy-published-task-card[data-task-workspace-id]').length,
      text: document.querySelector('.collaboration-group-chat-view')?.textContent || '',
      closeButton: Boolean(document.querySelector('[data-collaboration-group-close]')),
      renameButton: Boolean(document.querySelector('[data-collaboration-group-rename]')),
    })`);
    if (groupUi.participants !== 4 || groupUi.taskCards !== 1 || !groupUi.closeButton || !groupUi.renameButton || !groupUi.text.includes('制作一份测试汇报')) {
      throw new Error(`True collaboration group did not render correctly: ${JSON.stringify(groupUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-collaboration-group-rename]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('#social-edit-form') && document.querySelector('#social-edit-input')`);
    await evaluate(cdp, `(() => { const input = document.querySelector('#social-edit-input'); input.value = '群主修改后的测试群'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#social-edit-form')?.requestSubmit(); })()`);
    await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM collaboration_groups WHERE title = '群主修改后的测试群'").get().count === 1);
    await waitForRenderer(cdp, `document.querySelector('.collaboration-group-chat-view .social-group-title strong')?.textContent === '群主修改后的测试群'`);
    const legacyTaskDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'));
    legacyTaskDb.prepare(`INSERT INTO agent_delegations (
      id, requester_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
      title, instruction, status, metadata_json
    ) VALUES (?, 'local_admin', 'smoke_friend', 'secretary_agent', 'secretary_agent', ?, ?, 'accepted', ?)`)
      .run('legacy_outgoing_task', '兼容接口发布的进行中任务', '这项任务没有新版群组 ID，但必须显示在我发起的任务中。', JSON.stringify({ type: 'agent_delegation' }));
    legacyTaskDb.prepare(`INSERT INTO social_messages (
      id, account_workspace_id, conversation_id, sender_user_id, recipient_user_id, sender_agent_id, recipient_agent_id,
      kind, title, content, status, metadata_json
    ) VALUES (?, 'workspace_personal', ?, 'local_admin', 'smoke_friend', 'secretary_agent', 'secretary_agent', 'agent', ?, ?, 'unread', ?)`)
      .run('legacy_outgoing_message', socialConversationId, 'uBuddy 委托：兼容接口任务', '兼容接口任务通知', JSON.stringify({ type: 'agent_delegation', delegationId: 'legacy_outgoing_task', status: 'accepted' }));
    legacyTaskDb.close();
    await submitMainComposer(cdp, '@我的uBuddy 请根据当前群聊总结任务状态', ['@我的uBuddy']);
    await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM collaboration_group_messages WHERE content LIKE '@我的uBuddy%' AND sender_agent_id = ''").get().count === 1
      && database.prepare("SELECT count(*) count FROM collaboration_group_messages WHERE sender_agent_id = 'secretary_agent' AND json_extract(metadata_json, '$.type') = 'ubuddy_context_reply' AND json_extract(metadata_json, '$.inReplyTo') <> ''").get().count === 1);
    const removedNavigationUi = await evaluate(cdp, `({
      taskNavRemoved: !document.querySelector('[data-network-view="tasks"]'),
      projectAccordionRemoved: !document.querySelector('[data-sidebar-section="projects"]'),
      chatAccordionRemoved: !document.querySelector('[data-sidebar-section="chats"]'),
    })`);
    if (!removedNavigationUi.taskNavRemoved || !removedNavigationUi.projectAccordionRemoved || !removedNavigationUi.chatAccordionRemoved) {
      throw new Error(`Removed navigation modules reappeared: ${JSON.stringify(removedNavigationUi)}`);
    }

    const orderingDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'));
    orderingDb.prepare(`INSERT INTO collaboration_groups (id, owner_user_id, title, status, client_request_id, updated_at)
      VALUES ('smoke_active_group', 'local_admin', '较早的进行中群聊', 'active', 'smoke_active_ordering', '2000-01-01T00:00:00.000Z')`).run();
    orderingDb.prepare(`INSERT INTO collaboration_group_members (group_id, user_id, role, status, last_read_at)
      VALUES ('smoke_active_group', 'local_admin', 'owner', 'active', '1999-01-01T00:00:00.000Z')`).run();
    orderingDb.prepare(`INSERT INTO collaboration_group_messages (id, group_id, sender_user_id, kind, content, created_at, updated_at)
      VALUES ('smoke_active_group_message', 'smoke_active_group', 'smoke_friend', 'friend', '未读的进行中消息', '2000-01-01T00:00:01.000Z', '2000-01-01T00:00:01.000Z')`).run();
    orderingDb.close();

    await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-collaboration-group="${trueCollaborationGroupId}"]')`);
    const legacyMisclassification = await evaluate(cdp, `({
      legacySection: Boolean(document.querySelector('.legacy-social-group-list')),
      bodyText: document.querySelector('.network-messages')?.textContent || '',
    })`);
    if (legacyMisclassification.legacySection || legacyMisclassification.bodyText.includes('旧版进行中群聊')) {
      throw new Error(`An ungrouped active delegation was misclassified as read-only history: ${JSON.stringify(legacyMisclassification)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-collaboration-group="${trueCollaborationGroupId}"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-collaboration-group-close]')`);
    await evaluate(cdp, `(() => { window.confirm = () => true; document.querySelector('[data-collaboration-group-close]')?.click(); })()`);
    await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM collaboration_groups WHERE status = 'closed'").get().count === 1
      && database.prepare("SELECT count(*) count FROM agent_delegations WHERE status = 'withdrawn'").get().count === 1);
    await waitForRenderer(cdp, `document.querySelector('.social-group-ended') && !document.querySelector('.collaboration-group-chat-view #chat-form') && document.querySelector('.collaboration-group-chat-view')?.textContent.includes('制作一份测试汇报')`);
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-friend-directory-category="groups"]')`);
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="groups"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.contacts-groups-pane') && document.querySelector('[data-contact-group-tab="work"]')`);
    await evaluate(cdp, `document.querySelector('[data-contact-group-tab="work"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.im-group-directory-row.is-ended[data-contact-group-kind="work"]') && document.querySelector('[data-contact-group-profile="smoke_active_group"][data-contact-group-kind="work"]')`);
    const archivedUi = await evaluate(cdp, `({
      groupCount: document.querySelectorAll('.im-group-directory-row[data-contact-group-kind="work"]').length,
      header: document.querySelector('.contacts-groups-head')?.textContent || '',
      endedText: document.querySelector('.im-group-directory-row.is-ended[data-contact-group-kind="work"]')?.textContent || '',
      activeUnread: document.querySelector('[data-contact-group-profile="smoke_active_group"] .im-directory-unread:not(.is-empty)')?.textContent || '',
      titles: [...document.querySelectorAll('.im-group-directory-row[data-contact-group-kind="work"] .im-directory-main strong')].map((item) => item.textContent || ''),
      workTabActive: document.querySelector('[data-contact-group-tab="work"]')?.classList.contains('active') === true,
    })`);
    if (archivedUi.groupCount !== 2 || !archivedUi.header.includes('2 个') || !archivedUi.endedText.includes('已结束')
      || archivedUi.activeUnread !== '1' || archivedUi.titles[0] !== '群主修改后的测试群'
      || archivedUi.titles[1] !== '较早的进行中群聊' || !archivedUi.workTabActive) {
      throw new Error(`Current work-group directory ordering or unread state is incorrect: ${JSON.stringify(archivedUi)}`);
    }
    if (process.env.JANUS_DIRECTORY_LAYOUT_SCREENSHOT) {
      const screenshotPath = path.parse(process.env.JANUS_DIRECTORY_LAYOUT_SCREENSHOT);
      const lightScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(process.env.JANUS_DIRECTORY_LAYOUT_SCREENSHOT, Buffer.from(lightScreenshot.data, 'base64'));
      await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
      await waitForRenderer(cdp, `document.querySelector('.shell.theme-dark')`);
      const darkScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(path.join(screenshotPath.dir, `${screenshotPath.name}-dark${screenshotPath.ext || '.png'}`), Buffer.from(darkScreenshot.data, 'base64'));
    }
    await evaluate(cdp, `document.querySelector('[data-contact-group-profile="smoke_active_group"][data-contact-group-kind="work"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))`);
    await waitForRenderer(cdp, `document.querySelector('.collaboration-group-chat-view')?.textContent.includes('较早的进行中群聊')`);
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-friend-directory-category="groups"]')`);
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="groups"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-group-tab="work"]')`);
    await evaluate(cdp, `document.querySelector('[data-contact-group-tab="work"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-group-profile="smoke_active_group"]') && !document.querySelector('[data-contact-group-profile="smoke_active_group"] .im-directory-unread:not(.is-empty)')`);
    const clearedGroupUnreadUi = await evaluate(cdp, `({
      groupHeader: document.querySelector('.contacts-groups-head')?.textContent || '',
      present: Boolean(document.querySelector('[data-contact-group-profile="smoke_active_group"]')),
      unreadCleared: !document.querySelector('[data-contact-group-profile="smoke_active_group"] .im-directory-unread:not(.is-empty)'),
    })`);
    if (!clearedGroupUnreadUi.present || !clearedGroupUnreadUi.unreadCleared) {
      throw new Error(`Opening a group did not immediately clear its unread directory state: ${JSON.stringify(clearedGroupUnreadUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
    try {
      await waitForRenderer(cdp, `document.querySelector('.collaboration-group-item[data-collaboration-group="smoke_active_group"]') && document.querySelector('.collaboration-group-item.is-ended')`);
    } catch (error) {
      const diagnostics = await evaluate(cdp, `(async () => {
        const { state } = await import(${JSON.stringify(stateEntry)});
        return {
          rows: [...document.querySelectorAll('.collaboration-group-item')].map((item) => ({ id: item.dataset.collaborationGroup || '', classes: item.className })),
          groups: (state.collaborationOverview?.groups || []).map((item) => ({ id: item.id, status: item.status, archived: item.archived })),
          networkPanelView: state.networkPanelView,
          networkPanelLoading: state.networkPanelLoading,
          networkPanelError: state.networkPanelError,
          bodyText: (document.querySelector('.network-messages')?.textContent || '').slice(0, 800),
        };
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const settledConversationOrder = await evaluate(cdp, `[...document.querySelectorAll('.collaboration-group-item')].map((item) => ({ id: item.dataset.collaborationGroup || '', ended: item.classList.contains('is-ended'), active: item.classList.contains('active') }))`);
    if (settledConversationOrder[0]?.id !== 'smoke_active_group' || settledConversationOrder[0]?.ended || !settledConversationOrder.at(-1)?.ended) {
      throw new Error(`Running and ended conversation hierarchy is incorrect: ${JSON.stringify(settledConversationOrder)}`);
    }
    if (process.env.JANUS_CONVERSATION_LAYOUT_SCREENSHOT) {
      const screenshotPath = path.parse(process.env.JANUS_CONVERSATION_LAYOUT_SCREENSHOT);
      const lightScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(process.env.JANUS_CONVERSATION_LAYOUT_SCREENSHOT, Buffer.from(lightScreenshot.data, 'base64'));
      await evaluate(cdp, `document.querySelector('#theme-toggle-btn')?.click()`);
      await waitForRenderer(cdp, `document.querySelector('.shell.theme-dark')`);
      const darkScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(path.join(screenshotPath.dir, `${screenshotPath.name}-dark${screenshotPath.ext || '.png'}`), Buffer.from(darkScreenshot.data, 'base64'));
    }
    const uniformConversationRows = await evaluate(cdp, `[...document.querySelectorAll('.im-conversation-item')].map((item) => item.getBoundingClientRect().height)`);
    const conversationRowHeight = uniformConversationRows[0] || 0;
    if (!uniformConversationRows.length || conversationRowHeight < 64 || conversationRowHeight > 72
      || uniformConversationRows.some((height) => Math.abs(height - conversationRowHeight) > 0.5)) {
      throw new Error(`Conversation row heights are inconsistent: ${JSON.stringify(uniformConversationRows)}`);
    }
    const taskGroupCompactUi = await evaluate(cdp, `(() => {
      const row = document.querySelector('.collaboration-group-item');
      return {
        taskBadge: row?.querySelector('.im-conversation-badge.is-task')?.textContent || '',
        prefix: row?.querySelector('.im-conversation-preview-prefix')?.textContent || '',
        metaRemoved: !row?.querySelector('.network-message-meta'),
      };
    })()`);
    if (taskGroupCompactUi.taskBadge !== '工作群' || !taskGroupCompactUi.prefix.includes('人 ·') || !taskGroupCompactUi.metaRemoved) {
      throw new Error(`Task group compact row is incorrect: ${JSON.stringify(taskGroupCompactUi)}`);
    }
    const messageSearchRemoved = await evaluate(cdp, `!document.querySelector('[data-conversation-search-toggle], #network-conversation-search-popover, #network-conversation-search')`);
    if (!messageSearchRemoved) throw new Error('Message conversation search was not removed.');
    await evaluate(cdp, `document.querySelector('.direct-message-item[data-network-peer="smoke_friend"]')?.focus()`);
    const focusedConversationUi = await evaluate(cdp, `(() => { const item = document.querySelector('.direct-message-item[data-network-peer="smoke_friend"]'); const style = item ? getComputedStyle(item) : null; return { focused: document.activeElement === item, nativeButton: item?.tagName === 'BUTTON', outlineWidth: style?.outlineWidth || '' }; })()`);
    if (!focusedConversationUi.focused || !focusedConversationUi.nativeButton || focusedConversationUi.outlineWidth === '0px') {
      throw new Error(`Conversation keyboard focus semantics are incorrect: ${JSON.stringify(focusedConversationUi)}`);
    }
    await evaluate(cdp, `document.querySelector('.direct-message-item[data-network-peer="smoke_friend"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.direct-message-item[data-network-peer="smoke_friend"].active') && document.querySelector('.direct-social-panel #chat-form')`);
    await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-friend-directory-category="groups"]')`);
    await evaluate(cdp, `document.querySelector('[data-friend-directory-category="groups"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.contacts-groups-pane') && document.querySelector('[data-contact-group-tab="work"]')`);
    await evaluate(cdp, `document.querySelector('[data-contact-group-tab="work"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelectorAll('.im-group-directory-row[data-contact-group-kind="work"]').length >= 2`);
    const workGroupTabUi = await evaluate(cdp, `({
      workActive: document.querySelector('[data-contact-group-tab="work"]')?.classList.contains('active') === true,
      workRows: document.querySelectorAll('.im-group-directory-row[data-contact-group-kind="work"]').length,
      contactTabPresent: Boolean(document.querySelector('[data-contact-group-tab="contact"]')),
    })`);
    if (!workGroupTabUi.workActive || workGroupTabUi.workRows < 2 || !workGroupTabUi.contactTabPresent) {
      throw new Error(`Work-group tab did not render independently: ${JSON.stringify(workGroupTabUi)}`);
    }
    await evaluate(cdp, `document.querySelector('[data-contact-group-tab="contact"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('[data-contact-group-tab="contact"]')?.classList.contains('active') && !document.querySelector('.im-group-directory-row[data-contact-group-kind="work"]')`);
    await evaluate(cdp, `document.querySelector('[data-contact-group-tab="work"]')?.click()`);
    await waitForRenderer(cdp, `document.querySelector('.im-group-directory-row.is-ended[data-contact-group-kind="work"]')`);
    await evaluate(cdp, `document.querySelector('.im-group-directory-row.is-ended[data-contact-group-kind="work"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))`);
    await waitForRenderer(cdp, `document.querySelector('.social-group-ended') && !document.querySelector('.collaboration-group-chat-view #chat-form')`);
    await verifyPrivateAssistantUi(cdp);
    console.log(`network panel layout smoke passed (single uBuddy entry, private assistant isolation, default-recruited uBuddy talent, direct chat, direct private-task publishing, work groups, closed history, message panel ${Math.round(metrics.panelWidth)}px)`);
  } else {

  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.network-friend-row [data-network-ubuddy-target="smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.network-message-item[data-network-peer="smoke_friend"]')`);
  const messageListUi = await evaluate(cdp, `({
    friendCardsHidden: !document.querySelector('.network-messages .network-message-friend'),
    chatRecordText: document.querySelector('.network-message-item[data-network-peer="smoke_friend"]')?.textContent || '',
  })`);
  if (!messageListUi.friendCardsHidden || !messageListUi.chatRecordText.includes('之前的聊天记录')) {
    throw new Error(`Message panel did not render aggregated chat records: ${JSON.stringify(messageListUi)}`);
  }

  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-ubuddy-target="smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-ubuddy-target="smoke_friend"]')?.click()`);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE json_extract(metadata_json, '$.type') = 'social_task_group' AND json_extract(metadata_json, '$.action') = 'created'").get().count === 1);
  const firstGroupDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
  const firstGroupId = JSON.parse(firstGroupDb.prepare("SELECT metadata_json FROM social_messages WHERE json_extract(metadata_json, '$.type') = 'social_task_group' AND json_extract(metadata_json, '$.action') = 'created' ORDER BY created_at ASC LIMIT 1").get().metadata_json).taskGroupId;
  firstGroupDb.close();
  await waitForRenderer(cdp, `document.querySelector('.social-group-panel #chat-form')`);
  await waitForRenderer(cdp, `(() => { const input = document.querySelector('.social-group-composer #chat-input'); return input && input.value.endsWith(' ') && input.selectionStart === input.value.length && input.selectionEnd === input.value.length; })()`);
  const groupUi = await evaluate(cdp, `({
    participants: document.querySelectorAll('.social-group-participants .social-participant').length,
    groupText: document.querySelector('.social-group-message-list')?.textContent || '',
    mentionButton: Boolean(document.querySelector('[data-social-mention-toggle]')),
    attachmentButton: Boolean(document.querySelector('.social-group-composer .composer-plus')),
    ownUBuddyButtonRemoved: !document.querySelector('.social-group-composer .composer-ubuddy-action'),
    mentionCaretAtEnd: (() => {
      const input = document.querySelector('.social-group-composer #chat-input');
      return Boolean(input && input.value.endsWith(' ') && input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    })(),
    dissolveButton: Boolean(document.querySelector('[data-social-group-dissolve]')),
    renameButton: Boolean(document.querySelector('[data-social-group-rename]')),
    taskSectionRemoved: !document.querySelector('[data-sidebar-section="tasks"]'),
    sendHintRemoved: !document.querySelector('.social-send-hint'),
    mentionOverlay: Boolean(document.querySelector('.social-mention-highlight')),
    participantBetaCount: document.querySelectorAll('.social-group-participants .ubuddy-beta-badge').length,
    standardComposerShape: Boolean(document.querySelector('.social-group-composer.compact-composer')),
    composerContained: (() => {
      const composer = document.querySelector('.social-group-composer')?.getBoundingClientRect();
      const panel = document.querySelector('.social-group-panel')?.getBoundingClientRect();
      return Boolean(composer && panel && composer.left >= panel.left - 1 && composer.right <= panel.right + 1);
    })(),
    dedicatedPanel: Boolean(document.querySelector('.network-panel .network-conversation')),
  })`);
  if (groupUi.participants !== 4 || !groupUi.groupText.includes('创建了四方任务群聊') || !groupUi.mentionButton
    || !groupUi.attachmentButton || !groupUi.ownUBuddyButtonRemoved || !groupUi.mentionCaretAtEnd || !groupUi.dissolveButton || !groupUi.renameButton || !groupUi.taskSectionRemoved
    || !groupUi.sendHintRemoved || !groupUi.mentionOverlay || groupUi.participantBetaCount !== 2 || !groupUi.standardComposerShape || !groupUi.composerContained || groupUi.dedicatedPanel) {
    throw new Error(`Four-role group conversation did not render correctly: ${JSON.stringify(groupUi)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-tab="chat"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.chat-view.home') && !document.querySelector('.social-group-panel')`);
  const newChatAfterGroup = await evaluate(cdp, `({
    home: Boolean(document.querySelector('.chat-view.home')),
    groupHidden: !document.querySelector('.social-group-panel'),
    networkPanelClosed: !document.querySelector('.shell')?.classList.contains('network-panel-open'),
    standardComposer: Boolean(document.querySelector('.chat-view.home #chat-form')),
  })`);
  if (!newChatAfterGroup.home || !newChatAfterGroup.groupHidden || !newChatAfterGroup.networkPanelClosed || !newChatAfterGroup.standardComposer) {
    throw new Error(`New chat reused the previous social group conversation: ${JSON.stringify(newChatAfterGroup)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-group="${firstGroupId}"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-group="${firstGroupId}"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.social-group-panel #chat-form')`);
  if (process.env.JANUS_GROUP_LAYOUT_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_GROUP_LAYOUT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }

  const mentionToken = '@Smoke Friend的uBuddy';
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(`${'@Smoke Friend的uBuddy'} 正文`)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const mentionUi = await evaluate(cdp, `({
    highlighted: document.querySelector('.social-mention-token')?.textContent || '',
    authorWeight: getComputedStyle(document.querySelector('.social-message-actor > span') || document.body).fontWeight,
  })`);
  if (mentionUi.highlighted !== mentionToken) throw new Error(`@ mention was not highlighted: ${JSON.stringify(mentionUi)}`);

  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(`${'@Smoke Friend的uBuddy'} `)};
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  for (let index = 0; index < 2; index += 1) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  }
  const afterMentionDelete = await evaluate(cdp, `document.querySelector('#chat-input')?.value || ''`);
  if (afterMentionDelete !== '') throw new Error(`@ mention was not removed with two backspaces: ${JSON.stringify(afterMentionDelete)}`);

  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${JSON.stringify(`${'@Smoke Friend的uBuddy'} `)};
    input.setSelectionRange(0, 0);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  const afterMentionForwardDelete = await evaluate(cdp, `document.querySelector('#chat-input')?.value || ''`);
  if (afterMentionForwardDelete !== ' ') throw new Error(`Forward Delete must remove the whole @ mention but keep its space: ${JSON.stringify(afterMentionForwardDelete)}`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  const afterMentionSpaceDelete = await evaluate(cdp, `document.querySelector('#chat-input')?.value || ''`);
  if (afterMentionSpaceDelete !== '') throw new Error(`Forward Delete must remove the remaining space separately: ${JSON.stringify(afterMentionSpaceDelete)}`);

  await submitMainComposer(cdp, '这是一条普通群组消息');
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE content = '这是一条普通群组消息'").get().count === 1);
  const afterNormalDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
  const delegationCountAfterNormal = afterNormalDb.prepare('SELECT count(*) count FROM agent_delegations').get().count;
  afterNormalDb.close();
  if (delegationCountAfterNormal !== 0) throw new Error('A normal group message unexpectedly created a delegation.');

  await submitMainComposer(cdp, '@Smoke Friend的uBuddy 请整理一份测试摘要', ['@Smoke Friend的uBuddy']);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE content = '@Smoke Friend的uBuddy 请整理一份测试摘要' AND json_extract(metadata_json, '$.type') = 'social_task_group_message' AND json_extract(metadata_json, '$.mentions[0]') = 'friend_ubuddy'").get().count === 1);
  const afterMentionDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
  const delegationCountAfterMention = afterMentionDb.prepare('SELECT count(*) count FROM agent_delegations').get().count;
  afterMentionDb.close();
  if (delegationCountAfterMention !== 0) throw new Error('@ friend uBuddy unexpectedly created a work-order delegation.');

  await submitMainComposer(cdp, '@我的uBuddy @Smoke Friend的uBuddy 帮我汇报近期工作', ['@我的uBuddy', '@Smoke Friend的uBuddy']);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE json_extract(metadata_json, '$.processedByOwnUBuddy') = 1 AND json_extract(metadata_json, '$.type') = 'social_task_group_message'").get().count === 1);
  const ownUBuddyDb = new DatabaseSync(path.join(smokeHome, 'data', 'janus.db'), { readOnly: true });
  const ownUBuddyMessage = ownUBuddyDb.prepare("SELECT content, metadata_json FROM social_messages WHERE json_extract(metadata_json, '$.processedByOwnUBuddy') = 1 LIMIT 1").get();
  ownUBuddyDb.close();
  const ownUBuddyMetadata = JSON.parse(ownUBuddyMessage?.metadata_json || '{}');
  if (!String(ownUBuddyMessage?.content || '').includes('任务目标：帮我汇报近期工作')
    || !String(ownUBuddyMetadata.originalContent || '').includes('帮我汇报近期工作')) {
    throw new Error(`Own uBuddy did not improve the group message: ${JSON.stringify(ownUBuddyMessage)}`);
  }
  const messagePresentation = await evaluate(cdp, `(() => {
    const actor = document.querySelector('.social-message-actor > span');
    const style = actor ? getComputedStyle(actor) : null;
    return {
      actorSize: style?.fontSize || '',
      actorWeight: Number(style?.fontWeight || 0),
      highlightedMentions: document.querySelectorAll('.social-group-message .social-mention-token').length,
      workOrderFooterRemoved: !document.querySelector('.social-delegation-footer') && !document.querySelector('.social-group-message [data-network-delegation]'),
    };
  })()`);
  if (messagePresentation.actorSize !== '15px' || messagePresentation.actorWeight < 700
    || messagePresentation.highlightedMentions < 1 || !messagePresentation.workOrderFooterRemoved) {
    throw new Error(`Group message presentation is incorrect: ${JSON.stringify(messagePresentation)}`);
  }
  if (process.env.JANUS_NETWORK_LAYOUT_SCREENSHOT) {
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.JANUS_NETWORK_LAYOUT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }

  await evaluate(cdp, `(() => { window.prompt = () => '第一期工作汇报群'; document.querySelector('[data-social-group-rename]')?.click(); })()`);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE json_extract(metadata_json, '$.type') = 'social_task_group' AND json_extract(metadata_json, '$.action') = 'renamed' AND json_extract(metadata_json, '$.groupTitle') = '第一期工作汇报群'").get().count === 1);
  await waitForRenderer(cdp, `document.querySelector('.social-group-title strong')?.textContent === '第一期工作汇报群'`);

  await evaluate(cdp, `(() => { window.confirm = () => true; document.querySelector('[data-social-group-dissolve]')?.click(); })()`);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE json_extract(metadata_json, '$.type') = 'social_task_group' AND json_extract(metadata_json, '$.action') = 'dissolved'").get().count === 1);
  await waitForRenderer(cdp, `document.querySelector('.social-group-ended') && !document.querySelector('.social-group-panel #chat-form') && document.querySelector('.social-group-message-list')?.textContent.includes('这是一条普通群组消息')`);

  await evaluate(cdp, `document.querySelector('[data-network-view="friends"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-ubuddy-target="smoke_friend"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-ubuddy-target="smoke_friend"]')?.click()`);
  await waitForDatabase(smokeHome, (database) => database.prepare("SELECT count(*) count FROM social_messages WHERE json_extract(metadata_json, '$.type') = 'social_task_group' AND json_extract(metadata_json, '$.action') = 'created'").get().count === 2);
  await waitForRenderer(cdp, `document.querySelector('.social-group-panel #chat-form')`);
  const secondGroupText = await evaluate(cdp, `document.querySelector('.social-group-message-list')?.textContent || ''`);
  if (secondGroupText.includes('这是一条普通群组消息') || secondGroupText.includes('第一期工作汇报群')) {
    throw new Error(`New group reused the dissolved group history: ${JSON.stringify(secondGroupText)}`);
  }

  await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-social-group-section="active"]') && document.querySelector('[data-social-group-section="ended"]')`);
  const groupedListUi = await evaluate(cdp, `({
    activeCount: document.querySelector('[data-social-group-section="active"] b')?.textContent || '',
    endedCount: document.querySelector('[data-social-group-section="ended"] b')?.textContent || '',
    oldGroupVisible: Boolean(document.querySelector('[data-network-group="${firstGroupId}"]')),
    oldGroupTitle: document.querySelector('[data-network-group="${firstGroupId}"] .network-message-line strong')?.textContent || '',
  })`);
  if (groupedListUi.activeCount !== '1' || groupedListUi.endedCount !== '1' || !groupedListUi.oldGroupVisible || groupedListUi.oldGroupTitle !== '第一期工作汇报群') {
    throw new Error(`Active/ended group records were not separated correctly: ${JSON.stringify(groupedListUi)}`);
  }
  await evaluate(cdp, `document.querySelector('[data-social-group-section="ended"]')?.click()`);
  await waitForRenderer(cdp, `!document.querySelector('[data-network-group="${firstGroupId}"]')`);
  await evaluate(cdp, `document.querySelector('[data-social-group-section="ended"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-group="${firstGroupId}"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-group="${firstGroupId}"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('.social-group-ended') && document.querySelector('.social-group-message-list')?.textContent.includes('这是一条普通群组消息')`);

  await verifyPrivateAssistantUi(cdp);
  console.log(`network panel layout smoke passed (private assistant isolation, multi-group history, active/ended folding, rename, @ highlight/delete, initiator dissolve, message panel ${Math.round(metrics.panelWidth)}px)`);
  }
  await cdp.close();
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
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

async function verifyPrivateAssistantUi(cdp) {
  await evaluate(cdp, `document.querySelector('[data-network-view="messages"]')?.click()`);
  await waitForRenderer(cdp, `document.querySelector('[data-network-peer="self-private-assistant"]')`);
  await evaluate(cdp, `document.querySelector('[data-network-peer="self-private-assistant"]')?.click()`);
  try {
    await waitForRenderer(cdp, `document.querySelector('.composer.is-private-assistant-mode')`, 20_000);
  } catch (error) {
    const debug = await evaluate(cdp, `(async () => { const { state } = await import('./app/state.js'); return {
      notice: document.querySelector('.notice')?.textContent || '',
      body: (document.body?.innerText || '').slice(-1200),
      homeMode: state.homeMode,
      currentSessionId: state.currentSessionId,
      sessions: (state.sessions || []).filter((item) => item.departmentId === 'private_assistant'),
      panelView: state.networkPanelView,
    }; })()`);
    throw new Error(`Private assistant did not open: ${JSON.stringify({ debug, cause: error.message })}`);
  }
  await waitForRenderer(cdp, `document.querySelector('[data-private-assistant-usage]') && document.querySelector('[data-private-assistant-reset-context]')`);
  const ui = await evaluate(cdp, `({
    activeEntry: Boolean(document.querySelector('[data-network-peer="self-private-assistant"].active')),
    placeholder: document.querySelector('.main #chat-input')?.getAttribute('placeholder') || '',
    quotaText: document.querySelector('[data-private-assistant-usage]')?.textContent || '',
    privacyTitle: document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private')?.getAttribute('title') || '',
    hasPersistentPrivacyCard: Boolean(document.querySelector('.private-assistant-privacy')),
    hasResetContext: Boolean(document.querySelector('[data-private-assistant-reset-context]')),
    contextText: document.querySelector('.composer-context')?.textContent || '',
    hasUBuddyMention: Boolean(document.querySelector('.main [data-social-mention-toggle]')),
    hasWorkspacePicker: Boolean(document.querySelector('.main [data-workspace-menu-toggle]')),
    hasSandboxPicker: Boolean(document.querySelector('.main #sandbox-permission-trigger')),
    entryPrivacyTitle: document.querySelector('[data-network-peer="self-private-assistant"]')?.getAttribute('title') || '',
  })`);
  const composerLayout = await evaluate(cdp, `(() => {
    const context = document.querySelector('.composer.is-private-assistant-mode .composer-context');
    const input = document.querySelector('.composer.is-private-assistant-mode #chat-input');
    const contextRect = context?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    return {
      contextVisible: Boolean(contextRect?.width && contextRect?.height),
      inputVisible: Boolean(inputRect?.width && inputRect?.height),
      contextBottom: contextRect?.bottom || 0,
      inputTop: inputRect?.top || 0,
      separated: Boolean(contextRect && inputRect && contextRect.bottom + 3 <= inputRect.top),
    };
  })()`);
  if (!ui.activeEntry || !ui.placeholder.includes('私人空间')
    || !ui.quotaText.includes('Token')
    || !ui.privacyTitle.includes('不与其他 Agent 通信')
    || !ui.privacyTitle.includes('模型服务')
    || !ui.entryPrivacyTitle.includes('不占员工额度')
    || ui.hasPersistentPrivacyCard || !ui.hasResetContext
    || !ui.contextText.includes('私人助理')
    || ui.hasUBuddyMention || ui.hasWorkspacePicker || !ui.hasSandboxPicker) {
    throw new Error(`Private assistant entry or isolation UI is incorrect: ${JSON.stringify(ui)}`);
  }
  if (!composerLayout.contextVisible || !composerLayout.inputVisible || !composerLayout.separated) {
    throw new Error(`Private assistant context label overlaps the input placeholder: ${JSON.stringify(composerLayout)}`);
  }
}

async function waitForRenderer(cdp, expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for renderer expression: ${expression}`);
}

async function submitMainComposer(cdp, content, mentionTokens = []) {
  await waitForRenderer(cdp, `document.querySelector('#chat-form .send-btn:not([disabled])')`);
  let remainingContent = String(content || '');
  for (const mentionToken of mentionTokens) {
    const cleanToken = String(mentionToken || '').trim();
    if (!cleanToken) continue;
    remainingContent = remainingContent.replace(cleanToken, '').trim();
    await evaluate(cdp, `document.querySelector('[data-social-mention-toggle]')?.click()`);
    await waitForRenderer(cdp, `Boolean(document.querySelector('[data-social-mention=${JSON.stringify(cleanToken)}]'))`);
    await evaluate(cdp, `document.querySelector('[data-social-mention=${JSON.stringify(cleanToken)}]')?.click()`);
  }
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#chat-input');
    input.value = ${mentionTokens.length ? `[input.value.trim(), ${JSON.stringify(remainingContent)}].filter(Boolean).join(' ')` : JSON.stringify(remainingContent)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
  })()`);
}

async function waitForDatabase(home, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(path.join(home, 'data', 'janus.db'), { readOnly: true });
    try {
      if (predicate(database)) return;
    } finally {
      database.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for local social database state.');
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
