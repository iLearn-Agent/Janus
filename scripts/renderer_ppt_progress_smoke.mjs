import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-ppt-progress-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStateEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app', 'state.js')).href;
const rendererStyle = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const session = { id: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt', title: 'Existing PPT conversation' };
const history = Array.from({ length: 36 }, (_, index) => ({
  id: `history-${index + 1}`,
  role: index % 2 ? 'assistant' : 'user',
  content: `历史消息 ${index + 1}：用于形成足够长的对话区域，验证 PPT 更新期间滚动容器不会被替换。`,
  departmentId: 'general',
  agentId: '',
  createdAt: new Date(Date.now() - (36 - index) * 60_000).toISOString(),
}));
const bootstrap = {
  root: tempRoot,
  org: {
    departments: [{ id: 'ppt_department', name: 'PPT 部门', description: '制作演示文稿' }],
    agents: [
      { id: 'ppt', name: 'PPT Agent', departmentId: 'ppt_department', routable: true },
    ],
    hrs: [],
  },
  sessions: [session],
  projects: [], tasks: [], agentStatuses: [], evolution: null,
  currentUser: { id: 'ppt-smoke-user', name: 'PPT Smoke', role: 'user', permissions: {} },
  adminUsers: [], friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [], agentDelegations: [], socialStatus: null,
  codexConfig: { model: 'gpt-5.5', reasoningEffort: 'medium' },
  codexConfigFiles: null, cloudSync: null,
  managedProviderUsage: {
    enabled: true, managedProvider: true, limited: true, dailyTokenLimit: 20000000,
    dailyTokensUsed: 1864200, dailyTokensRemaining: 8135800, usagePercent: 18.64, exhausted: false,
    dailyImageLimit: 5, dailyImagesUsed: 2, dailyImagesRemaining: 3, imageGenerationExhausted: false,
    resetAt: '2026-08-08T16:00:00.000Z', timezone: 'Asia/Shanghai',
    lastTurnTokens: 17483, lastTurnInputTokens: 17463, lastTurnOutputTokens: 20,
    lastTurnCachedInputTokens: 12000, usageSource: 'provider_last',
  },
  pptxPluginStatus: { id: 'ppt_creation', installed: true, available: true, ready: true },
  privateAssistant: {
    agentId: 'private_assistant', departmentId: 'private_assistant', localOnly: true, quotaExempt: true,
    weeklyTokenLimit: 20000000, weeklyTokensUsed: 6400000, weeklyTokensRemaining: 13600000,
    usagePercent: 32, exhausted: false, resetAt: '2026-07-27T00:00:00.000Z',
    lastTurnTokens: 17483, lastTurnInputTokens: 17463, lastTurnOutputTokens: 20,
    lastTurnCachedInputTokens: 12000, usageSource: 'provider',
  },
  modelCatalog: { models: [{ id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] },
};
const hiddenAnswer = [
  'PPT 页面结构已整理，共 5 页：',
  '',
  '- 第 1 页：封面',
  '- 第 2 页：背景',
  '- 第 3 页：方法',
  '- 第 4 页：结果',
  '- 第 5 页：总结',
  '',
  '页面结构已完成，正在生成和校验可编辑 PPTX。',
  '',
  '```janus-slide-plan',
  '| layout_id | title | message | visual |',
  '|---|---|---|---|',
  '| cover | 封面 | 主题 | 封面视觉 |',
  '| challenge_map | 背景 | 背景内容 | 挑战图 |',
  '| method_pipeline | 方法 | 方法内容 | 流程图 |',
  '| result_big_numbers | 结果 | 结果内容 | 指标卡 |',
  '| summary_takeaways | 总结 | 总结内容 | 总结卡 |',
  '```',
  '',
  '```janus-deck-spec',
  '{"schema_version":"janus-multifunction-v1","slides":[]}',
  '```',
].join('\n');

const htmlPath = path.join(tempRoot, 'renderer-ppt-progress-smoke.html');
writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <title>PPT progress smoke</title>
    <link rel="stylesheet" href="${rendererStyle}">
  </head>
  <body>
    <div id="app"></div>
    <script>
      localStorage.setItem('janus-theme-mode', 'dark');
      const bootstrap = ${JSON.stringify(bootstrap)};
      const session = ${JSON.stringify(session)};
      const history = ${JSON.stringify(history)};
      window.__pptUiTest = { errors: [], sent: [], privateAssistantEnsureCalls: [], codexListener: null, resolveSend: null, originalList: null, initialScrollTop: 0 };
      window.addEventListener('error', (event) => window.__pptUiTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
      window.addEventListener('unhandledrejection', (event) => window.__pptUiTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
      const eventSubscription = () => () => {};
      window.janus = {
        bootstrap: async () => bootstrap,
        updateStatus: async () => ({ status: 'idle' }),
        agentUpdateStatus: async () => ({ status: 'idle' }),
        onCodexEvent: (callback) => { window.__pptUiTest.codexListener = callback; return () => {}; },
        onUpdateStatus: eventSubscription,
        onAgentUpdateStatus: eventSubscription,
        onEvolutionProgress: eventSubscription,
        onModelsUpdated: eventSubscription,
        onSocialUpdated: eventSubscription,
        listMessages: async () => history,
        listSessions: async () => [session],
        ensurePrivateAssistantSession: async (payload = {}) => {
          window.__pptUiTest.privateAssistantEnsureCalls.push(payload);
          return { id: 'private-assistant-session', departmentId: 'private_assistant', agentId: 'private_assistant', title: '私人助理', status: 'active' };
        },
        listTasks: async () => [],
        employeeOverview: async () => ({
          capabilities: { multiMemory: { enabled: false, readOnly: true } },
          quota: { used: 0, limit: 10 },
          roster: [],
          recruitableFamilies: [],
        }),
        chatContextStatus: async () => null,
        sendChat: async (payload) => {
          window.__pptUiTest.sent.push(payload);
          return new Promise((resolve) => { window.__pptUiTest.resolveSend = resolve; });
        },
        minimizeWindow: async () => null,
        toggleMaximizeWindow: async () => null,
        closeWindow: async () => null,
      };
    </script>
    <script type="module" src="${rendererEntry}"></script>
  </body>
</html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: Boolean(process.env.JANUS_PRIVATE_ASSISTANT_SCREENSHOT),
    width: 1000,
    height: 640,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  await browserWindow.loadFile(htmlPath);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (document.querySelector('[data-network-session="ppt-progress-session"]')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('PPT Agent message entry did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-network-session="ppt-progress-session"]').click()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('#message-list') && document.querySelector('#chat-input')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('PPT conversation did not open'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const conversationBeforePpt = await browserWindow.webContents.executeJavaScript(`({
    messageCount: document.querySelectorAll('#message-list .message').length,
    activeSession: Boolean(document.querySelector('[data-network-session="ppt-progress-session"]')?.classList.contains('active')),
  })`);
  const conversationAfterPpt = await browserWindow.webContents.executeJavaScript(`({
    messageCount: document.querySelectorAll('#message-list .message').length,
    activeSession: Boolean(document.querySelector('[data-network-session="ppt-progress-session"]')?.classList.contains('active')),
    pptComposer: Boolean(document.querySelector('.composer.is-ppt-mode')),
    pptShortcutRemoved: !document.querySelector('[data-composer-ppt-mode]'),
    stayedInConversation: Boolean(document.querySelector('.chat-view.with-messages')) && !document.querySelector('.chat-view.home'),
  })`);
  assert.ok(conversationBeforePpt.messageCount > 0);
  assert.equal(conversationAfterPpt.messageCount, conversationBeforePpt.messageCount, 'PPT mode must preserve current conversation messages');
  assert.equal(conversationAfterPpt.activeSession, true, 'PPT mode must preserve the active sidebar conversation');
  assert.equal(conversationAfterPpt.pptComposer, true, 'PPT Agent conversations should retain PPT composer controls');
  assert.equal(conversationAfterPpt.pptShortcutRemoved, true, 'PPT should no longer appear as a generic composer shortcut');
  assert.equal(conversationAfterPpt.stayedInConversation, true, 'PPT mode must not jump to the new-chat home');
  const compactPptMeta = await browserWindow.webContents.executeJavaScript(`(() => {
    const template = document.querySelector('#ppt-template-trigger')?.getBoundingClientRect();
    const style = document.querySelector('#ppt-style-trigger')?.getBoundingClientRect();
    return {
      templateWidth: template?.width || 0,
      styleWidth: style?.width || 0,
      primaryGap: template && style ? style.left - template.right : Infinity,
    };
  })()`);
  assert.ok(compactPptMeta.templateWidth >= 100 && compactPptMeta.templateWidth <= 180, `PPT template control should stay compact: ${JSON.stringify(compactPptMeta)}`);
  assert.ok(compactPptMeta.styleWidth >= 100 && compactPptMeta.styleWidth <= 160, `PPT style control should stay compact: ${JSON.stringify(compactPptMeta)}`);
  assert.ok(compactPptMeta.primaryGap >= 0 && compactPptMeta.primaryGap <= 6,
    `PPT composer controls should be tightly spaced: ${JSON.stringify(compactPptMeta)}`);
  const mutuallyExclusiveMenus = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('#ppt-template-trigger').click();
    setTimeout(() => {
      const templateOpenedAlone = Boolean(document.querySelector('.ppt-template-menu'))
        && !document.querySelector('.workspace-picker-menu');
      document.querySelector('[data-workspace-menu-toggle]').click();
      setTimeout(() => {
        const workspaceOpenedAlone = Boolean(document.querySelector('.workspace-picker-menu'))
          && !document.querySelector('.ppt-template-menu')
          && !document.querySelector('.ppt-style-menu');
        document.querySelector('#ppt-style-trigger').click();
        setTimeout(() => resolve({
          templateOpenedAlone,
          workspaceOpenedAlone,
          styleOpenedAlone: Boolean(document.querySelector('.ppt-style-menu'))
            && !document.querySelector('.workspace-picker-menu')
            && !document.querySelector('.ppt-template-menu'),
        }), 80);
      }, 80);
    }, 80);
  })`);
  assert.deepEqual(mutuallyExclusiveMenus, {
    templateOpenedAlone: true,
    workspaceOpenedAlone: true,
    styleOpenedAlone: true,
  }, 'PPT template/style and project menus must be mutually exclusive');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#ppt-style-trigger').click()`);
  const styleMenu = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('#ppt-style-trigger').click();
    setTimeout(() => resolve({
      optionCount: document.querySelectorAll('.ppt-style-option').length,
      text: document.querySelector('.ppt-style-menu')?.innerText || '',
    }), 80);
  })`);
  assert.equal(styleMenu.optionCount, 3, 'PPT style menu should expose exactly the three user-facing styles');
  assert.ok(styleMenu.text.includes('通用PPT'));
  assert.ok(styleMenu.text.includes('学术汇报风'));
  assert.ok(styleMenu.text.includes('重大项目风'));
  assert.ok(!styleMenu.text.includes('Research Scout'), 'internal PPT research scout must not appear as a visual style');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-ppt-style-option="academic_report"]').click()`);
  browserWindow.setSize(520, 640);
  const narrowComposer = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const inspect = () => {
      const template = document.querySelector('#ppt-template-trigger');
      const style = document.querySelector('#ppt-style-trigger');
      const overflow = document.querySelector('[data-composer-meta-overflow-toggle]');
      const secondary = document.querySelector('[data-composer-meta-secondary]');
      if (!template || !style || !overflow || !secondary) {
        if (Date.now() > deadline) return reject(new Error('responsive PPT composer controls did not render'));
        return setTimeout(inspect, 30);
      }
      const templateRect = template.getBoundingClientRect();
      const styleRect = style.getBoundingClientRect();
      const overflowRect = overflow.getBoundingClientRect();
      const overflowDisplay = getComputedStyle(overflow).display;
      const initialSecondaryDisplay = getComputedStyle(secondary).display;
      overflow.click();
      setTimeout(() => {
        const openSecondary = document.querySelector('[data-composer-meta-secondary]');
        const toggle = document.querySelector('[data-composer-meta-overflow-toggle]');
        const result = {
          templateWidth: templateRect.width,
          styleWidth: styleRect.width,
          sameRow: Math.abs(templateRect.top - styleRect.top) <= 1,
          nonOverlapping: templateRect.right <= styleRect.left + 1,
          overflowVisible: overflowRect.width > 0 && overflowDisplay !== 'none',
          secondaryInitiallyHidden: initialSecondaryDisplay === 'none',
          secondaryOpen: getComputedStyle(openSecondary).display !== 'none',
          workspaceVisible: Boolean(openSecondary?.querySelector('[data-workspace-menu-toggle]')),
          permissionVisible: Boolean(openSecondary?.querySelector('#sandbox-permission-trigger')),
        };
        toggle?.click();
        resolve(result);
      }, 100);
    };
    inspect();
  })`);
  assert.ok(narrowComposer.templateWidth >= 100 && narrowComposer.styleWidth >= 100, `PPT primary controls were squeezed: ${JSON.stringify(narrowComposer)}`);
  assert.equal(narrowComposer.sameRow, true, 'PPT template and style must remain on the same row in narrow chat panes');
  assert.equal(narrowComposer.nonOverlapping, true, 'PPT template and style controls must not overlap');
  assert.equal(narrowComposer.overflowVisible, true, 'narrow PPT composer must expose a secondary-settings overflow button');
  assert.equal(narrowComposer.secondaryInitiallyHidden, true, 'secondary controls should collapse before PPT template/style controls');
  assert.equal(narrowComposer.secondaryOpen, true, 'secondary controls must remain reachable from the overflow menu');
  assert.equal(narrowComposer.workspaceVisible, true);
  assert.equal(narrowComposer.permissionVisible, true);
  browserWindow.setSize(1000, 640);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 120))`);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sandbox-permission-trigger').click()`);
  const permissionLayering = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => {
    const menu = document.querySelector('.sandbox-permission-menu');
    const metaBar = document.querySelector('.composer-meta-bar');
    const quickActions = document.querySelector('.composer-quick-actions');
    const menuRect = menu.getBoundingClientRect();
    const quickRect = quickActions.getBoundingClientRect();
    const intersection = {
      left: Math.max(menuRect.left, quickRect.left),
      right: Math.min(menuRect.right, quickRect.right),
      top: Math.max(menuRect.top, quickRect.top),
      bottom: Math.min(menuRect.bottom, quickRect.bottom),
    };
    const overlaps = intersection.right > intersection.left && intersection.bottom > intersection.top;
    const topElement = overlaps
      ? document.elementFromPoint((intersection.left + intersection.right) / 2, (intersection.top + intersection.bottom) / 2)
      : null;
    resolve({
      overlaps,
      menuOnTop: !overlaps || menu.contains(topElement),
      metaBarZIndex: getComputedStyle(metaBar).zIndex,
    });
  }, 120))`);
  assert.equal(permissionLayering.menuOnTop, true, 'permission menu should paint above composer quick actions');
  assert.equal(permissionLayering.metaBarZIndex, '1000');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#sandbox-permission-trigger').click()`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#ppt-template-trigger').click();
    document.querySelector('[data-ppt-template-option="scut"]').click();
    const input = document.querySelector('#chat-input');
    input.value = '生成一份 5 页测试 PPT';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
    document.querySelector('#ppt-template-trigger').click();
    document.querySelector('[data-ppt-template-option="hitsz"]').click();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__pptUiTest.sent.length && window.__pptUiTest.codexListener) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('PPT send did not start'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const sentPptPayload = await browserWindow.webContents.executeJavaScript(`window.__pptUiTest.sent[0]`);
  assert.equal(sentPptPayload.agentId, 'ppt');
  assert.equal(sentPptPayload.chatContext?.styleId, 'academic_report');
  assert.equal(sentPptPayload.chatContext?.styleAgentId, undefined);
  assert.equal(sentPptPayload.chatContext?.templateId, 'scut', 'PPT send must use the template snapshot from submit time');
  assert.equal(sentPptPayload.chatContext?.templateSelection, 'explicit');
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => { window.__pptUiTest.rendererState = state; })`);
  const crossPageRun = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('[data-tab="employees"]')?.click();
    const deadline = Date.now() + 5000;
    const waitForEmployees = () => {
      if (!document.querySelector('.talent-directory-view')) {
        if (Date.now() > deadline) return reject(new Error('employee page did not open during active run'));
        return setTimeout(waitForEmployees, 20);
      }
      const channelId = window.__pptUiTest.sent[0].channelId;
      window.__pptUiTest.codexListener({ channelId, event: {
        kind: 'activity', activityId: 'offscreen-reasoning', activityType: 'reasoning', eventOrigin: 'codex', status: 'running',
        title: '思考摘要', detail: '切页期间仍在检查页面结构与交付要求。',
        sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
      }});
      document.querySelector('[data-network-view="messages"]')?.click();
      const waitForChat = () => {
        const processText = document.querySelector('.codex-transcript')?.textContent || '';
        const processMessage = document.querySelector('[data-message-id^="run-"][data-message-id$="-process"]');
        const processRestored = Boolean(processMessage)
          && window.__pptUiTest.rendererState?.chatRuns?.[0]?.processEvents?.some((item) => item.detail === '切页期间仍在检查页面结构与交付要求。');
        if (document.querySelector('#message-list') && processRestored) {
          return resolve({
            activeSession: Boolean(document.querySelector('[data-network-session="ppt-progress-session"]')?.classList.contains('active')),
            processText,
            processRestored,
            hasCancel: Boolean(document.querySelector('#cancel-chat-btn')),
            pptComposer: Boolean(document.querySelector('.composer.is-ppt-mode')),
          });
        }
        if (Date.now() > deadline) return reject(new Error('active run did not restore after returning from employee page: ' + JSON.stringify({
          hasMessagesTab: Boolean(document.querySelector('[data-network-view="messages"]')),
          hasMessageList: Boolean(document.querySelector('#message-list')),
          activeSession: document.querySelector('[data-network-session].active')?.getAttribute('data-network-session') || '',
          processText,
          state: {
            currentTab: window.__pptUiTest.rendererState?.currentTab || '',
            currentSessionId: window.__pptUiTest.rendererState?.currentSessionId || '',
            currentChatKey: window.__pptUiTest.rendererState?.currentChatKey || '',
            activeRunChannel: window.__pptUiTest.rendererState?.activeChatRun?.channelId || '',
            runCount: window.__pptUiTest.rendererState?.chatRuns?.length || 0,
            runProcessEvents: window.__pptUiTest.rendererState?.chatRuns?.[0]?.processEvents?.map((item) => item.detail || item.title) || [],
            messageIds: window.__pptUiTest.rendererState?.messages?.map((item) => item.id) || [],
            networkConversationPeerId: window.__pptUiTest.rendererState?.networkConversationPeerId || '',
          },
          bodyText: (document.body?.innerText || '').slice(0, 1200),
        })));
        setTimeout(waitForChat, 20);
      };
      waitForChat();
    };
    waitForEmployees();
  })`);
  assert.equal(crossPageRun.activeSession, true, 'returning to chat must preserve the running conversation');
  assert.equal(crossPageRun.processRestored, true, 'returning to chat must restore the active process message and its event state');
  assert.equal(crossPageRun.processText.includes('切页期间仍在检查页面结构与交付要求'), true,
    'restored live processing must continue showing the latest reasoning summary');
  assert.equal(crossPageRun.hasCancel, true, 'restored active run must remain cancellable');
  assert.equal(crossPageRun.pptComposer, true, 'returning from another page must preserve the active Agent composer');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = async () => {
      const { state } = await import(${JSON.stringify(rendererStateEntry)});
      if (!state.networkPanelLoading && !state.employeeRefreshBusy) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('message navigation did not settle before PPT progress verification'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.scrollTop = Math.max(80, Math.floor((list.scrollHeight - list.clientHeight) / 2));
    window.__pptUiTest.originalList = list;
    window.__pptUiTest.initialScrollTop = list.scrollTop;
    list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    const channelId = window.__pptUiTest.sent[0].channelId;
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'activity', activityId: 'commentary-1', activityType: 'commentary', eventOrigin: 'codex',
      nativeSource: 'codex_app_server', status: 'completed', detail: '正在整理页面规划与生成顺序。',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
    }});
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'activity', activityId: 'reasoning-1', activityType: 'reasoning', eventOrigin: 'codex', status: 'running',
      title: '思考摘要', detail: '正在检查页面结构与交付要求。',
      summaryParts: [{ index: 0, text: '正在检查页面结构与交付要求。' }],
      reasoningText: 'RAW_REASONING_MUST_STAY_HIDDEN', nativeSource: 'codex_app_server',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
    }});
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'activity', activityId: 'command-1', activityType: 'command', eventOrigin: 'codex', status: 'completed',
      title: '命令执行', detail: '验证页面计划和渲染输入',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
    }});
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'activity', activityId: 'browser-1', activityType: 'tool', eventOrigin: 'codex', status: 'completed',
      title: '浏览器检索', detail: '检索参考页面', toolServer: 'browser', toolName: 'search',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
    }});
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'activity', activityId: 'browser-2', activityType: 'tool', eventOrigin: 'codex', status: 'completed',
      title: '浏览器读取', detail: '读取参考页面', toolServer: 'browser', toolName: 'openPage',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
    }});
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'answer', eventOrigin: 'codex', content: ${JSON.stringify(hiddenAnswer)}, streaming: false,
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
      pptArtifactPending: true
    }});
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })()`);
  const pendingGap = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => {
    const status = document.querySelector('[data-transient-kind="run-status"]') || document.querySelector('.run-status-message');
    const statusLine = status?.querySelector('.run-inline-status');
    const statusText = statusLine?.querySelector('span:last-child');
    const pptProgress = status?.querySelector('.ppt-run-progress');
    const pptProgressTrack = pptProgress?.querySelector('.ppt-run-progress-track');
    const statusLineRect = statusLine?.getBoundingClientRect();
    const statusTextRect = statusText?.getBoundingClientRect();
    const pptProgressRect = pptProgress?.getBoundingClientRect();
    const pptProgressTrackRect = pptProgressTrack?.getBoundingClientRect();
    resolve({
      bodyText: document.body.innerText,
      statusText: status?.textContent || '',
      hasCancel: Boolean(document.querySelector('#cancel-chat-btn')),
      verticalPptProgress: Boolean(statusLineRect && pptProgressRect && pptProgressRect.top >= statusLineRect.bottom - 1),
      alignedPptProgress: Boolean(statusTextRect && pptProgressTrackRect && Math.abs(statusTextRect.left - pptProgressTrackRect.left) <= 1),
      statusAfterAnswer: Boolean(status && document.querySelector('.streaming-message')
        && (document.querySelector('.streaming-message').compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)),
    });
  }, 1250))`);
  const wheelScroll = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const list = document.querySelector('#message-list');
    const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.max(0, maxTop - 320);
    list.dispatchEvent(new Event('scroll'));
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -36 }));
    list.scrollTop = Math.max(0, list.scrollTop - 32);
    list.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const expectedTop = list.scrollTop;
      const listRect = list.getBoundingClientRect();
      const anchor = [...list.querySelectorAll(':scope > [data-message-id]')]
        .find((item) => item.getBoundingClientRect().bottom > listRect.top + 1) || null;
      const anchorMessageId = anchor?.dataset?.messageId || '';
      const anchorOffset = anchor ? anchor.getBoundingClientRect().top - listRect.top : null;
      const channelId = window.__pptUiTest.sent[0].channelId;
      window.__pptUiTest.codexListener({ channelId, event: {
        kind: 'progress', eventOrigin: 'codex', stage: 'working', message: '滚轮浏览期间继续生成内容',
        sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
        pptArtifactPending: true,
        pptProgress: { phase: 'render', currentSlide: 4, totalSlides: 5, phaseCurrent: 4, phaseTotal: 5, overallPercent: 66, slideTitle: '结果', attempt: 1, message: '滚轮浏览期间继续生成内容' }
      }});
      setTimeout(() => {
        const currentList = document.querySelector('#message-list');
        const currentAnchor = anchorMessageId
          ? [...currentList.querySelectorAll(':scope > [data-message-id]')].find((item) => item.dataset.messageId === anchorMessageId)
          : null;
        const currentAnchorOffset = currentAnchor
          ? currentAnchor.getBoundingClientRect().top - currentList.getBoundingClientRect().top
          : null;
        resolve({
          maxTop,
          expectedTop,
          actualTop: currentList.scrollTop,
          sameList: currentList === list,
          anchorMessageId,
          anchorDelta: anchorOffset == null || currentAnchorOffset == null ? null : Math.abs(currentAnchorOffset - anchorOffset),
          distanceFromBottom: Math.max(0, currentList.scrollHeight - currentList.clientHeight - currentList.scrollTop),
        });
      }, 300);
    }));
  })`);
  assert.ok(wheelScroll.maxTop > 80, `PPT scroll fixture must be tall enough to exercise wheel detachment: ${JSON.stringify(wheelScroll)}`);
  assert.ok(wheelScroll.anchorMessageId && wheelScroll.anchorDelta <= 2, `upward wheel scrolling must preserve the visible message anchor during streamed updates: ${JSON.stringify(wheelScroll)}`);
  assert.ok(wheelScroll.distanceFromBottom > 2, `wheel scrolling must remain detached from bottom-follow mode: ${JSON.stringify(wheelScroll)}`);
  const disclosureScroll = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const list = document.querySelector('#message-list');
    const details = document.querySelector('.codex-process-disclosure');
    const summary = details?.querySelector(':scope > summary');
    if (!list || !details || !summary) return reject(new Error('process disclosure fixture is unavailable'));
    details.open = false;
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
    const message = details.closest('[data-message-id]');
    const messageId = message?.dataset?.messageId || '';
    const beforeOffset = message ? message.getBoundingClientRect().top - list.getBoundingClientRect().top : null;
    const beforeTop = list.scrollTop;
    summary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    const pointerTop = list.scrollTop;
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    summary.click();
    setTimeout(() => {
      const expandedList = document.querySelector('#message-list');
      const expandedMessage = messageId
        ? [...expandedList.querySelectorAll(':scope > [data-message-id]')].find((item) => item.dataset.messageId === messageId)
        : null;
      const expandedOffset = expandedMessage ? expandedMessage.getBoundingClientRect().top - expandedList.getBoundingClientRect().top : null;
      const channelId = window.__pptUiTest.sent[0].channelId;
      window.__pptUiTest.codexListener({ channelId, event: {
        kind: 'progress', eventOrigin: 'codex', stage: 'working', message: '展开过程面板后继续更新',
        sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
        pptArtifactPending: true,
        pptProgress: { phase: 'render', currentSlide: 4, totalSlides: 5, phaseCurrent: 4, phaseTotal: 5, overallPercent: 68, slideTitle: '结果', attempt: 1, message: '展开过程面板后继续更新' }
      }});
      setTimeout(() => {
        const currentList = document.querySelector('#message-list');
        const currentMessage = messageId
          ? [...currentList.querySelectorAll(':scope > [data-message-id]')].find((item) => item.dataset.messageId === messageId)
          : null;
        const afterOffset = currentMessage ? currentMessage.getBoundingClientRect().top - currentList.getBoundingClientRect().top : null;
        resolve({
          open: document.querySelector('.codex-process-disclosure')?.open === true,
          messageId,
          beforeTop,
          pointerTop,
          expandedTop: expandedList.scrollTop,
          expandAnchorDelta: beforeOffset == null || expandedOffset == null ? null : Math.abs(expandedOffset - beforeOffset),
          updateAnchorDelta: expandedOffset == null || afterOffset == null ? null : Math.abs(afterOffset - expandedOffset),
          distanceFromBottom: Math.max(0, currentList.scrollHeight - currentList.clientHeight - currentList.scrollTop),
        });
      }, 350);
    }, 80);
  })`);
  assert.equal(disclosureScroll.open, true, `process disclosure must remain expanded after a streamed update: ${JSON.stringify(disclosureScroll)}`);
  assert.ok(disclosureScroll.messageId && disclosureScroll.expandAnchorDelta <= 2, `expanding a process disclosure must preserve its visible message anchor: ${JSON.stringify(disclosureScroll)}`);
  assert.ok(disclosureScroll.updateAnchorDelta <= 2, `a streamed update must preserve the expanded disclosure anchor: ${JSON.stringify(disclosureScroll)}`);
  assert.ok(disclosureScroll.distanceFromBottom > 2, `expanding a process disclosure must detach automatic bottom following: ${JSON.stringify(disclosureScroll)}`);
  await browserWindow.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#message-list');
    list.scrollTop = window.__pptUiTest.initialScrollTop;
    list.dispatchEvent(new Event('scroll'));
  })()`);
  assert.equal(pendingGap.hasCancel, true, 'PPT run must remain cancellable after the page-plan answer appears');
  assert.equal(pendingGap.verticalPptProgress, true, `PPT progress must render below the heartbeat text instead of beside it: ${JSON.stringify(pendingGap)}`);
  assert.equal(pendingGap.alignedPptProgress, true, `PPT progress must align below the processed-status text: ${JSON.stringify(pendingGap)}`);
  assert.equal(pendingGap.statusAfterAnswer, true, 'PPT heartbeat must render below the page-plan answer');
  assert.match(pendingGap.statusText, /PPTX.*已处理|正在启动 PPTX/, `PPT heartbeat stopped between the page-plan answer and first renderer progress: ${JSON.stringify(pendingGap)}`);
  const progressListTimeline = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const before = document.querySelector('#message-list');
    const channelId = window.__pptUiTest.sent[0].channelId;
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'progress', eventOrigin: 'codex', stage: 'working', message: '正在制作第 4/5 页：结果',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
      pptArtifactPending: true,
      pptProgress: { phase: 'render', currentSlide: 4, totalSlides: 5, phaseCurrent: 4, phaseTotal: 5, overallPercent: 63, slideTitle: '结果', attempt: 1, message: '正在制作第 4/5 页：结果' }
    }});
    const timeline = { immediate: document.querySelector('#message-list') === before };
    setTimeout(() => { timeline.after25 = document.querySelector('#message-list') === before; }, 25);
    setTimeout(() => { timeline.after75 = document.querySelector('#message-list') === before; }, 75);
    setTimeout(() => { timeline.after150 = document.querySelector('#message-list') === before; }, 150);
    setTimeout(() => resolve(timeline), 200);
  })`);
  const metrics = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(() => {
    const list = document.querySelector('#message-list');
    resolve({
      sameList: list === window.__pptUiTest.originalList,
      scrollDelta: Math.abs(list.scrollTop - window.__pptUiTest.initialScrollTop),
      bodyText: document.body.innerText,
      hasProgress: Boolean(document.querySelector('.ppt-run-progress')),
      hasProcess: Boolean(document.querySelector('.codex-transcript')),
      processText: document.querySelector('.codex-transcript')?.textContent || '',
      toolSummary: document.querySelector('.codex-tool-group > summary strong')?.textContent || '',
      hasStageRail: Boolean(document.querySelector('.ppt-run-progress-stages')),
      progressText: document.querySelector('.ppt-run-progress')?.textContent || '',
      answerText: document.querySelector('.streaming-message')?.textContent || '',
      streaming: Boolean(document.querySelector('.streaming-message.is-streaming')),
      themeDark: document.querySelector('.shell')?.classList.contains('theme-dark') === true,
      errors: window.__pptUiTest.errors,
    });
  }, 250))`);
  assert.deepEqual(metrics.errors, []);
  assert.equal(Object.values(progressListTimeline).every(Boolean), true, `PPT run updates replaced the message-list during the throttled patch window: ${JSON.stringify({ pendingGap, wheelScroll, progressListTimeline, metrics })}`);
  assert.ok(metrics.scrollDelta <= 1, `scroll position changed while dragging (${metrics.scrollDelta}px)`);
  assert.equal(metrics.hasProgress, true);
  assert.equal(metrics.hasProcess, true, 'Codex activity events should render a process timeline');
  assert.equal(metrics.processText.includes('思考摘要'), false);
  assert.ok(metrics.processText.includes('正在检查页面结构与交付要求。'));
  assert.ok(!metrics.processText.includes('RAW_REASONING_MUST_STAY_HIDDEN'), 'raw reasoning text leaked into the default transcript');
  assert.match(metrics.processText, /已执行 \d+ 项操作|运行了 \d+ 个命令/);
  assert.equal(metrics.toolSummary, '已使用 浏览器运行了多个操作');
  assert.equal(metrics.hasStageRail, true);
  assert.ok(metrics.progressText.includes('4 / 5 页'));
  assert.ok(metrics.progressText.includes('总体 68%'), `PPT progress must remain monotonic after a lower out-of-order update: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.progressText.includes('结果'));
  assert.ok(metrics.answerText.includes('第 2 页：背景'));
  assert.ok(metrics.answerText.includes('第 4 页：结果'));
  assert.ok(!metrics.answerText.includes('layout_id'), 'hidden detailed slide plan leaked into the conversation');
  assert.ok(metrics.processText.includes('正在整理页面规划与生成顺序。'), 'native commentary must be retained inside the process transcript');
  assert.equal(metrics.themeDark, true, 'PPT renderer smoke should exercise dark mode');
  assert.equal(metrics.streaming, false, 'completed PPT summary should not keep a streaming cursor');
  const completeProcessHistory = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const channelId = window.__pptUiTest.sent[0].channelId;
    for (let index = 1; index <= 5; index += 1) {
      window.__pptUiTest.codexListener({ channelId, event: {
        kind: 'activity', activityId: 'lazy-history-' + index, activityType: 'reasoning', eventOrigin: 'codex', status: 'completed',
        title: '思考摘要', detail: '懒加载过程记录 ' + index,
        sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt'
      }});
    }
    const deadline = Date.now() + 5000;
    const waitForHistory = () => {
      const nextText = document.querySelector('.codex-transcript')?.textContent || '';
      if (nextText.includes('懒加载过程记录 1') && nextText.includes('懒加载过程记录 5')) {
        return resolve({ allEntriesVisible: true, hasLegacyHistoryControl: Boolean(document.querySelector('.process-history')) });
      }
      if (Date.now() > deadline) return reject(new Error('complete Codex transcript did not retain all entries'));
      setTimeout(waitForHistory, 20);
    };
    waitForHistory();
  })`);
  assert.equal(completeProcessHistory.allEntriesVisible, true, 'the Codex transcript must retain the complete ordered narrative');
  assert.equal(completeProcessHistory.hasLegacyHistoryControl, false, 'the legacy process-history container must be removed');
  const persistedStageOutput = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    const channelId = window.__pptUiTest.sent[0].channelId;
    window.__pptUiTest.codexListener({ channelId, event: {
      kind: 'progress', eventOrigin: 'codex', stage: 'working', message: '正在制作第 5/5 页：总结',
      sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
      pptProgress: { phase: 'render', currentSlide: 5, totalSlides: 5, phaseCurrent: 5, phaseTotal: 5, overallPercent: 72, slideTitle: '总结', attempt: 1, message: '正在制作第 5/5 页：总结' }
    }});
    setTimeout(() => resolve({
      visibleText: document.querySelector('.codex-transcript')?.textContent || '',
    }), 250);
  })`);
  assert.ok(persistedStageOutput.visibleText.includes('正在整理页面规划与生成顺序。'), 'native commentary should survive progress refreshes');
  const timeoutFailure = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('[data-tab="employees"]')?.click();
    const deadline = Date.now() + 5000;
    const finishOffscreen = () => {
      if (!document.querySelector('.talent-directory-view')) {
        if (Date.now() > deadline) return reject(new Error('employee page did not open before offscreen completion'));
        return setTimeout(finishOffscreen, 20);
      }
      const channelId = window.__pptUiTest.sent[0].channelId;
      window.__pptUiTest.codexListener({ channelId, event: {
        kind: 'done', eventOrigin: 'codex',
        sessionId: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt',
        answer: ${JSON.stringify(hiddenAnswer)}, pptArtifactPending: false,
        artifactErrorCode: 'ppt_render_timeout',
        artifactError: 'PPT 页面内容已经生成，但 PPTX 渲染超过 10 分钟，系统已自动停止本次渲染。页面结构已经保留。',
        artifactErrorDetail: 'PPT renderer timed out after 600 seconds.'
      }});
      document.querySelector('[data-network-view="messages"]')?.click();
      const waitForFailure = () => {
        const bodyText = document.body.textContent || '';
        if (bodyText.includes('PPTX 渲染超过 10 分钟')) {
          return resolve({
            bodyText,
            hasProgress: Boolean(document.querySelector('.ppt-run-progress')),
            hasCancel: Boolean(document.querySelector('#cancel-chat-btn')),
            activeSession: Boolean(document.querySelector('[data-network-session="ppt-progress-session"]')?.classList.contains('active')),
            failureCount: [...document.querySelectorAll('.message.assistant')].filter((item) => item.textContent.includes('PPTX 渲染超过 10 分钟')).length,
            failureDetail: document.querySelector('.ppt-render-failure-details')?.textContent || '',
          });
        }
        if (Date.now() > deadline) return reject(new Error('offscreen completion did not appear after returning to chat: ' + JSON.stringify({
          hasMessagesTab: Boolean(document.querySelector('[data-network-view="messages"]')),
          hasMessageList: Boolean(document.querySelector('#message-list')),
          activeSession: document.querySelector('[data-network-session].active')?.getAttribute('data-network-session') || '',
          bodyText: bodyText.slice(0, 1200),
        })));
        setTimeout(waitForFailure, 20);
      };
      waitForFailure();
    };
    finishOffscreen();
  })`);
  assert.ok(timeoutFailure.bodyText.includes('PPTX 渲染超过 10 分钟'), 'PPT artifact timeout was swallowed after the page plan');
  assert.equal(timeoutFailure.hasProgress, false, 'PPT progress must settle after artifact timeout');
  assert.equal(timeoutFailure.hasCancel, false, 'cancel control must disappear after artifact timeout');
  assert.equal(timeoutFailure.activeSession, true, 'offscreen completion must return to the original conversation');
  assert.equal(timeoutFailure.failureCount, 1, 'PPT artifact timeout should render exactly one visible failure message');
  assert.match(timeoutFailure.failureDetail, /PPT renderer timed out after 600 seconds/, 'PPT failure detail must be visible in an expandable disclosure');
  await browserWindow.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    window.__pptUiTest.resolveSend?.({
      session: { id: 'ppt-progress-session', departmentId: 'ppt_department', agentId: 'ppt' },
      answer: 'done'
    });
  })()`);
  const skillSettings = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const openSettings = () => {
      const account = document.querySelector('#account-card');
      if (!account) {
        if (Date.now() > deadline) return reject(new Error('account menu unavailable'));
        return setTimeout(openSettings, 30);
      }
      account.click();
      document.querySelector('[data-account-menu-action="settings"]')?.click();
      const openSkills = () => {
        const item = document.querySelector('[data-settings-section="skills"]');
        if (!item) {
          if (Date.now() > deadline) return reject(new Error('skill settings navigation unavailable'));
          return setTimeout(openSkills, 30);
        }
        item.click();
        setTimeout(() => resolve({
          title: document.querySelector('.settings-section-head h1')?.textContent || '',
          cardCount: document.querySelectorAll('.plugin-card').length,
          filterCount: document.querySelectorAll('[data-plugin-filter]').length,
          categoryControls: document.querySelectorAll('#plugin-category-select').length,
          sortControls: document.querySelectorAll('#plugin-sort-select').length,
          statusText: document.querySelector('.plugin-card-status')?.textContent || '',
          hasTopLevelPluginTab: Boolean(document.querySelector('[data-tab="plugins"]')),
        }), 80);
      };
      openSkills();
    };
    openSettings();
  })`);
  assert.equal(skillSettings.title, '技能与插件');
  assert.equal(skillSettings.cardCount, 1);
  assert.equal(skillSettings.filterCount, 3);
  assert.equal(skillSettings.categoryControls, 1);
  assert.equal(skillSettings.sortControls, 1);
  assert.ok(skillSettings.statusText.includes('技能已下载 · 3 种风格'), 'existing plugin status wording must remain unchanged');
  assert.equal(skillSettings.hasTopLevelPluginTab, true, 'plugin management must remain in settings and also be available from the primary sidebar');
  const pluginDetail = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('[data-plugin-detail="ppt_creation"]')?.click();
    setTimeout(() => resolve({
      visible: Boolean(document.querySelector('.plugin-detail-drawer')),
      text: document.querySelector('.plugin-detail-drawer')?.innerText || '',
      width: document.querySelector('.plugin-detail-drawer')?.getBoundingClientRect().width || 0,
      descriptionFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.plugin-detail-drawer > header p')).fontSize),
      sectionTitleFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.plugin-detail-drawer h3')).fontSize),
      factLabelFontSize: Number.parseFloat(getComputedStyle(document.querySelector('.plugin-detail-facts small')).fontSize),
      actionWhiteSpace: getComputedStyle(document.querySelector('.plugin-detail-drawer > footer .plugin-try-btn')).whiteSpace,
    }), 80);
  })`);
  assert.equal(pluginDetail.visible, true);
  assert.ok(pluginDetail.text.includes('提供能力'));
  assert.ok(pluginDetail.text.includes('提供的 Agent'));
  assert.ok(pluginDetail.text.includes('运行权限'));
  assert.ok(pluginDetail.width >= 580, 'skill detail drawer should give Chinese descriptions enough readable width');
  assert.ok(pluginDetail.descriptionFontSize >= 15, 'skill detail descriptions should use readable body text');
  assert.ok(pluginDetail.sectionTitleFontSize >= 16, 'skill detail section titles should be visually distinct');
  assert.ok(pluginDetail.factLabelFontSize >= 12, 'skill detail fact labels should not be tiny');
  assert.equal(pluginDetail.actionWhiteSpace, 'nowrap', 'skill detail action labels should stay on one line');
  const immediateUse = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('.plugin-detail-drawer [data-plugin-chat="pptx"]')?.click();
    setTimeout(() => resolve({
      inChat: Boolean(document.querySelector('.chat-view')),
      messageLayout: Boolean(document.querySelector('.shell.message-layout.network-panel-open')),
      messageNavActive: document.querySelector('[data-app-nav="messages"]')?.getAttribute('aria-current') === 'page',
      messagePanelVisible: document.querySelector('#network-panel')?.dataset.pageKind === 'messages',
      conversationOpen: Boolean(document.querySelector('.shell.message-conversation-open')),
      messageHomeHidden: !document.querySelector('[data-message-default-page]'),
      backToMessagesVisible: Boolean(document.querySelector('[data-message-home-back]')),
      startedFreshConversation: !document.querySelector('[data-network-session="ppt-progress-session"]')?.classList.contains('active'),
      styleLabel: document.querySelector('#ppt-style-trigger')?.innerText || '',
      draft: document.querySelector('#chat-input')?.value || '',
    }), 80);
  })`);
  assert.equal(immediateUse.inChat, true, 'immediate use should return to PPT chat');
  assert.equal(immediateUse.messageLayout, true, 'PPT skill immediate use must open the new Messages split layout');
  assert.equal(immediateUse.messageNavActive, true, 'PPT skill immediate use must keep Messages as the active primary page');
  assert.equal(immediateUse.messagePanelVisible, true, 'PPT skill immediate use must preserve the conversation list');
  assert.equal(immediateUse.conversationOpen, true, 'PPT skill immediate use must open the PPT Agent conversation pane');
  assert.equal(immediateUse.messageHomeHidden, true, 'PPT skill immediate use must not stop on the quiet Messages default page');
  assert.equal(immediateUse.backToMessagesVisible, true, 'PPT skill immediate use must expose the return-to-conversation-list control');
  assert.equal(immediateUse.startedFreshConversation, true, 'immediate use must not retain an unrelated active conversation');
  assert.ok(immediateUse.styleLabel.includes('学术汇报风'));
  assert.ok(immediateUse.draft.includes('PPT'));
  const privateAssistant = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('[data-network-view="messages"]')?.click();
    setTimeout(() => {
      document.querySelector('[data-network-peer="self-private-assistant"]')?.click();
      setTimeout(() => {
        document.querySelector('#account-card')?.click();
        resolve({
        active: Boolean(document.querySelector('[data-network-peer="self-private-assistant"].active')),
        privateComposer: Boolean(document.querySelector('.composer.is-private-assistant-mode')),
        placeholder: document.querySelector('#chat-input')?.getAttribute('placeholder') || '',
        quotaText: document.querySelector('[data-private-assistant-usage]')?.innerText || '',
        quotaTitle: document.querySelector('.private-assistant-quota-trigger')?.getAttribute('title') || '',
        quotaDetailText: document.querySelector('.private-assistant-quota-popover')?.textContent || '',
        managedQuotaPresent: Boolean(document.querySelector('[data-managed-provider-usage]')),
        quotaControlCount: document.querySelectorAll('[data-private-assistant-usage], [data-managed-provider-usage]').length,
        quotaControlMerged: document.querySelector('[data-private-assistant-usage]') === document.querySelector('[data-managed-provider-usage]'),
        quotaFits: (() => { const item = document.querySelector('[data-private-assistant-usage]'); return Boolean(item && item.scrollWidth <= item.clientWidth + 1); })(),
        weeklyProgressValue: Number(document.querySelector('[data-private-assistant-usage] .quota-fill.is-private')?.getAttribute('aria-valuenow')),
        weeklyProgressLabel: document.querySelector('[data-private-assistant-usage] .quota-fill.is-private')?.getAttribute('aria-label') || '',
        weeklyProgressWidth: document.querySelector('[data-private-assistant-usage] .quota-fill.is-private')?.style.width || '',
        sidebarQuotaPresent: Boolean(document.querySelector('.sidebar-model-usage')),
        entryText: document.querySelector('[data-network-peer="self-private-assistant"]')?.textContent || '',
        headerText: document.querySelector('[data-chat-top-info]')?.textContent || '',
        privacyTitle: document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private')?.getAttribute('title') || '',
        headerUsesShieldIcon: Boolean(document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private svg')),
        headerUsesPrivateAbbreviation: (document.querySelector('[data-chat-top-info] .chat-utility-avatar.is-private')?.textContent || '').includes('私助'),
        hasPersistentPrivacyCard: Boolean(document.querySelector('.private-assistant-privacy')),
        hasResetContext: Boolean(document.querySelector('[data-private-assistant-reset-context]')),
        hasWorkspacePicker: Boolean(document.querySelector('[data-workspace-menu-toggle]')),
        hasSandboxPicker: Boolean(document.querySelector('#sandbox-permission-trigger')),
        hasMentionPicker: Boolean(document.querySelector('[data-social-mention-toggle]')),
          ensureCalls: window.__pptUiTest.privateAssistantEnsureCalls,
        });
      }, 120);
    }, 80);
  })`);
  assert.equal(privateAssistant.active, true, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.ensureCalls.length, 1, 'opening the private assistant should establish its real session before composing');
  assert.equal(privateAssistant.privateComposer, true);
  assert.ok(privateAssistant.placeholder.includes('私人空间'));
  assert.ok(privateAssistant.quotaText.includes('本周 6.4M/20M'), JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.quotaText.includes('图片'), false, JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaTitle.includes('本周：6.4M / 20M'), JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaDetailText.includes('缓存 12K'), JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaDetailText.includes('图片使用独立'), JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaDetailText.includes('仍受默认模型服务每日额度限制'), JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaDetailText.includes('2 / 5'), JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.quotaDetailText.includes('已用 32%'), JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.managedQuotaPresent, false, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.quotaControlCount, 1, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.quotaControlMerged, false, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.quotaFits, true, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.weeklyProgressValue, 32, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.weeklyProgressLabel, '私人助理每周额度', JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.weeklyProgressWidth, '32%', JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.sidebarQuotaPresent, false, JSON.stringify(privateAssistant));
  assert.ok(privateAssistant.privacyTitle.includes('不与其他 Agent 通信'));
  assert.ok(privateAssistant.privacyTitle.includes('模型服务'));
  assert.equal(privateAssistant.headerText.includes('本地隔离'), true, JSON.stringify(privateAssistant));
  assert.equal(privateAssistant.headerUsesShieldIcon, true);
  assert.equal(privateAssistant.headerUsesPrivateAbbreviation, false);
  assert.equal(privateAssistant.hasPersistentPrivacyCard, false);
  assert.equal(privateAssistant.hasResetContext, true);
  assert.equal(privateAssistant.hasWorkspacePicker, false);
  assert.equal(privateAssistant.hasSandboxPicker, true);
  assert.equal(privateAssistant.hasMentionPicker, false);
  await browserWindow.webContents.executeJavaScript(`import(${JSON.stringify(rendererStateEntry)}).then(({ state }) => {
    state.managedProviderUsage = { ...state.managedProviderUsage, managedProvider: false, limited: false, dailyTokenLimit: null, dailyTokensRemaining: null, exhausted: false };
  })`);
  const englishPrivateQuota = await browserWindow.webContents.executeJavaScript(`new Promise((resolve) => {
    document.querySelector('#language-toggle-btn')?.click();
    setTimeout(() => {
      document.querySelector('[data-language-choice="en"]')?.click();
      setTimeout(() => {
        const quota = document.querySelector('[data-private-assistant-usage]');
        const title = quota?.querySelector('.private-assistant-quota-trigger')?.getAttribute('title') || '';
        const detail = quota?.querySelector('.private-assistant-quota-popover')?.textContent || '';
        const headline = quota?.querySelector('.private-assistant-quota strong');
        resolve({
          text: quota?.innerText || '',
          title,
          detail,
          chinese: /[\\u3400-\\u9fff]/.test([quota?.innerText, title, detail].join(' ')),
          headlineFits: Boolean(headline && headline.scrollWidth <= headline.clientWidth + 1),
          weeklyProgressValue: Number(quota?.querySelector('.quota-fill.is-private')?.getAttribute('aria-valuenow')),
          weeklyProgressLabel: quota?.querySelector('.quota-fill.is-private')?.getAttribute('aria-label') || '',
        });
      }, 100);
    }, 30);
  })`);
  assert.ok(englishPrivateQuota.text.includes('Week 6.4M/20M'), JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.text.includes('Img'), false, JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('This Week'), JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('32% used'), JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('no daily token limit'), JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('20M Private Assistant weekly allowance still applies'), JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('separate shared daily limit'), JSON.stringify(englishPrivateQuota));
  assert.ok(englishPrivateQuota.detail.includes('2 / 5'), JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.detail.includes('Overall Today'), false, JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.chinese, false, JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.headlineFits, true, JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.weeklyProgressValue, 32, JSON.stringify(englishPrivateQuota));
  assert.equal(englishPrivateQuota.weeklyProgressLabel, 'Private Assistant weekly allowance', JSON.stringify(englishPrivateQuota));
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#language-toggle-btn')?.click();document.querySelector('[data-language-choice="zh-CN"]')?.click()`);
  if (process.env.JANUS_PRIVATE_ASSISTANT_SCREENSHOT) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const screenshot = await browserWindow.capturePage();
    writeFileSync(process.env.JANUS_PRIVATE_ASSISTANT_SCREENSHOT, screenshot.toPNG());
  }
  process.stdout.write('Renderer PPT progress and scroll smoke passed.\n');
} catch (error) {
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-ppt-progress', stateExpression: 'window.__pptProgressTest?.errors || window.__privateAssistantTest?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
