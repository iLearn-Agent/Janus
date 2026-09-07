import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureElectronFailureDiagnostics } from './lib/electronFailureDiagnostics.mjs';

const { app, BrowserWindow } = globalThis.__janusElectron;

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-renderer-attachment-'));
const rendererEntry = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'app.js')).href;
const rendererStyles = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;
const imageActionsScreenshot = String(process.env.JANUS_IMAGE_ACTIONS_SCREENSHOT || '').trim();
const attachmentPath = path.join(tempRoot, '自进化流程详解.txt');
const imagePath = path.join(tempRoot, '上传图片.png');
const projectRoot = path.join(tempRoot, 'testing');
const todoPath = path.join(projectRoot, 'outputs', 'TODO.md');
const delegatedReportPath = path.join(tempRoot, 'downloaded', 'Agent系统技术地图.md');
writeFileSync(attachmentPath, '自进化的第一句话。\n第二句话。', 'utf8');
writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4VQAAAAASUVORK5CYII=', 'base64'));
mkdirSync(path.dirname(todoPath), { recursive: true });
writeFileSync(todoPath, '# TODO\n\n项目待办内容', 'utf8');
mkdirSync(path.dirname(delegatedReportPath), { recursive: true });
writeFileSync(delegatedReportPath, '# Agent 系统技术地图\n\n跨用户交付内容', 'utf8');

const bootstrap = {
  root: tempRoot,
  workspaceRoot: projectRoot,
  org: {
    departments: [{ id: 'general', name: '通用部门' }],
    agents: [{ id: 'general_agent', name: '通用 Agent', departmentId: 'general', routable: true }],
    hrs: [],
  },
  sessions: [
    { id: 'renderer-session-existing', departmentId: 'general', agentId: 'general_agent', agentInstanceId: 'renderer-general-instance', projectId: 'renderer-project-testing', workspaceRoot: projectRoot, title: '已有图片的会话', updatedAt: new Date().toISOString() },
    { id: 'renderer-session-other', departmentId: 'general', agentId: 'general_agent', agentInstanceId: 'renderer-general-instance', title: '另一个会话', updatedAt: new Date(Date.now() - 3600000).toISOString() },
    ...Array.from({ length: 32 }, (_, index) => ({
      id: `renderer-session-old-${index}`,
      departmentId: 'general',
      agentId: 'general_agent',
      agentInstanceId: 'renderer-general-instance',
      title: `较早的历史会话 ${index + 1}`,
      updatedAt: new Date(Date.now() - (index + 1) * 86400000).toISOString(),
    })),
  ],
  projects: [{ id: 'renderer-project-testing', title: 'testing', workspaceRoot: projectRoot, status: 'active' }],
  tasks: [],
  agentStatuses: [],
  evolution: null,
  currentUser: { id: 'renderer-smoke-user', name: 'Renderer Smoke', role: 'user', permissions: {} },
  adminUsers: [],
  friendOverview: { friends: [], requests: { incoming: [], outgoing: [] } },
  socialInbox: [],
  agentDelegations: [],
  socialStatus: null,
  codexConfig: { model: 'gpt-5.5', reasoningEffort: 'medium' },
  codexConfigFiles: null,
  cloudSync: null,
  employees: {
    quota: { used: 1, limit: 10 },
    roster: [{ id: 'renderer-general-instance', agentFamilyId: 'general_agent', employmentState: 'active', routeEligible: true,
      family: { id: 'general_agent', name: '通用 Agent', departmentId: 'general' } }],
  },
  modelCatalog: {
    models: [{ id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' }],
  },
};

const selectedFile = {
  id: 'renderer-native-text',
  name: '自进化流程详解.txt',
  filename: '自进化流程详解.txt',
  content_type: 'text/plain',
  size: 42,
  path: attachmentPath,
  relative_path: 'files/renderer-native-text/自进化流程详解.txt',
  kind: 'text',
};

const selectedImage = {
  id: 'renderer-uploaded-image',
  name: '上传图片.png',
  filename: '上传图片.png',
  content_type: 'image/png',
  size: 68,
  path: imagePath,
  kind: 'image',
  file_url: pathToFileURL(imagePath).href,
};

const htmlPath = path.join(tempRoot, 'renderer-attachment-submit.html');
writeFileSync(htmlPath, `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>Renderer attachment submit smoke</title><link rel="stylesheet" href="${rendererStyles}"></head>
  <body>
    <div id="app"></div>
    <script>
      localStorage.setItem('janus-theme-mode', 'dark');
      const bootstrap = ${JSON.stringify(bootstrap)};
      const selectedFile = ${JSON.stringify(selectedFile)};
      const selectedImage = ${JSON.stringify(selectedImage)};
      const eventSubscription = () => () => {};
      window.__janusTest = { sent: [], errors: [], uploads: [], downloads: [], imageCopies: [], openedFiles: [], sendResolvers: [], completed: [], updated: [], searchQueries: [], renderedFiles: [], approvals: [], rewrites: [], confirmMessages: [], codexListener: null, failNextSend: false, failedMessages: {} };
      window.confirm = (message) => { window.__janusTest.confirmMessages.push(String(message || '')); return true; };
      window.addEventListener('error', (event) => {
        window.__janusTest.errors.push(String(event.error?.stack || event.message || event.error || 'renderer error'));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__janusTest.errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
      });
      window.janus = {
        bootstrap: async () => bootstrap,
        updateStatus: async () => ({ status: 'idle' }),
        agentUpdateStatus: async () => ({ status: 'idle' }),
        onCodexEvent: (listener) => {
          window.__janusTest.codexListener = listener;
          return () => { window.__janusTest.codexListener = null; };
        },
        onUpdateStatus: eventSubscription,
        onAgentUpdateStatus: eventSubscription,
        onEvolutionProgress: eventSubscription,
        onModelsUpdated: eventSubscription,
        onSocialUpdated: eventSubscription,
        selectFiles: async () => ({ canceled: false, files: [selectedFile], errors: [] }),
        uploadFile: async (payload) => {
          window.__janusTest.uploads.push(payload);
          return {
            id: 'renderer-pasted-image', filename: payload.filename, content_type: payload.contentType,
            size: 8, path: ${JSON.stringify(tempRoot)} + '/' + payload.filename, relative_path: 'files/renderer-pasted-image/' + payload.filename,
            kind: 'image',
          };
        },
        downloadCollaborationFile: async (payload) => {
          window.__janusTest.downloads.push(payload);
          return { path: ${JSON.stringify(delegatedReportPath)}, name: payload.name, filename: payload.filename, sha256: payload.sha256 };
        },
        writeClipboardImage: async (payload) => {
          window.__janusTest.imageCopies.push(payload);
          return { ok: true, size: { width: 1, height: 1 } };
        },
        resolveChatApproval: async (payload) => {
          window.__janusTest.approvals.push(payload);
          return { ok: true };
        },
        sendChat: async (payload) => {
          window.__janusTest.sent.push(payload);
          const sessionId = payload.sessionId || ('renderer-session-new-' + window.__janusTest.sent.length);
          if (window.__janusTest.failNextSend) {
            window.__janusTest.failNextSend = false;
            window.__janusTest.failedMessages[sessionId] = {
              id: 'renderer-failed-user-' + window.__janusTest.sent.length,
              role: 'user', content: payload.message, departmentId: 'general', createdAt: new Date().toISOString(), metadata: {},
            };
            window.__janusTest.codexListener?.({ channelId: payload.channelId, event: { kind: 'start', sessionId, departmentId: 'general', targetKind: 'normal' } });
            throw new Error('CodexUnavailable: exceeded retry limit, last status: 429 Too Many Requests');
          }
          await new Promise((resolve) => {
            window.__janusTest.sendResolvers.push(() => {
              window.__janusTest.completed.push(sessionId);
              resolve();
            });
          });
          return { session: { id: sessionId, departmentId: 'general', agentId: '' }, answer: 'ok' };
        },
        rewriteLastUserTurn: async (payload) => {
          window.__janusTest.rewrites.push(payload);
          const messages = await window.janus.listMessages(payload.sessionId);
          const supersededMessageIds = payload.messageId.startsWith('renderer-failed-user-')
            ? [payload.messageId]
            : ['renderer-user-' + payload.sessionId, 'renderer-message-' + payload.sessionId];
          return {
            messages: messages.filter((item) => !supersededMessageIds.includes(item.id)),
            supersededMessageIds,
          };
        },
        listMessages: async (sessionId) => window.__janusTest.completed.includes(sessionId) ? [{
          id: 'renderer-older-user-' + sessionId, role: 'user', content: '更早的一条用户消息', departmentId: 'general', createdAt: new Date(Date.now() - 3000).toISOString(),
        }, {
          id: 'renderer-older-answer-' + sessionId, role: 'assistant', content: '更早的回答', departmentId: 'general', createdAt: new Date(Date.now() - 2000).toISOString(),
        }, {
          id: 'renderer-user-' + sessionId, role: 'user', content: sessionId === 'renderer-session-existing' ? '这个文本的第一句话是什么？' : '并行的新对话消息', departmentId: 'general', createdAt: new Date(Date.now() - 1000).toISOString(),
          metadata: sessionId === 'renderer-session-existing' ? { attachments: [selectedFile] } : {},
        }, {
          id: 'renderer-message-' + sessionId, role: 'assistant', content: 'ok', departmentId: 'general', createdAt: new Date().toISOString(),
        }] : sessionId === 'renderer-session-existing' ? [{
          id: 'renderer-existing-image', role: 'system', departmentId: 'image_generation', createdAt: new Date().toISOString(),
          content: '__JANUS_ARTIFACT__' + JSON.stringify({ kind: 'image', data: { name: '小狗.png', file_url: 'data:image/png;base64,iVBORw0KGgo=' } }),
        }, {
          id: 'renderer-uploaded-image-message', role: 'user', departmentId: 'general', createdAt: new Date().toISOString(),
          content: '这是和图片一起发送的说明文字', metadata: { attachments: [selectedImage] },
        }, {
          id: 'renderer-local-markdown', role: 'assistant', departmentId: 'general', createdAt: new Date().toISOString(),
          content: '已生成：[查看 TODO.md](TODO.md) 参考：[Janus 文档](https://example.com/docs?q=janus)',
          metadata: { outputArtifacts: [{ name: 'TODO.md', filename: 'TODO.md', path: ${JSON.stringify(todoPath)}, kind: 'markdown', size: 18 }] },
        }, {
          id: 'renderer-delegation-draft', role: 'assistant', departmentId: 'agent_delegation', createdAt: new Date().toISOString(),
          content: '完整中文 Markdown 报告已生成：[Agent系统技术地图.md](reports/Agent系统技术地图.md)',
          metadata: { publishCandidate: true },
        }, {
          id: 'renderer-delegation-files', role: 'system', departmentId: 'agent_delegation', createdAt: new Date().toISOString(),
          content: 'uBuddy 已生成 1 个可编辑交付文件。',
          metadata: { generatedTaskFiles: true, candidateMessageId: 'renderer-delegation-draft', attachments: [{
            name: 'Agent系统技术地图.md', filename: 'Agent系统技术地图.md', relative_path: 'reports/Agent系统技术地图.md',
            remote_file_id: 'collab_file_agent_map', remote_file_kind: 'collaboration_task', sha256: 'report-sha256',
          }] },
        }] : [],
        listMessagePage: async ({ sessionId }) => {
          const items = await window.janus.listMessages(sessionId);
          const failed = window.__janusTest.failedMessages[sessionId];
          return { items: failed ? [...items.filter((item) => item.id !== failed.id), failed] : items, nextCursor: null, hasMore: false };
        },
        listSessions: async () => bootstrap.sessions,
        chatContextStatus: async () => null,
        listProjects: async () => bootstrap.projects,
        searchSessions: async (payload) => {
          window.__janusTest.searchQueries.push(payload.query);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return bootstrap.sessions.slice(0, 2);
        },
        listTasks: async () => [],
        renderFile: async (payload) => {
          window.__janusTest.renderedFiles.push(payload);
          return { kind: 'markdown', name: 'TODO.md', filename: 'TODO.md', path: payload.path, text: '# TODO\\n\\n项目待办内容' };
        },
        openFile: async (payload) => {
          window.__janusTest.openedFiles.push(payload);
          return '';
        },
        updateSession: async (payload) => {
          window.__janusTest.updated.push(payload);
          const session = bootstrap.sessions.find((item) => item.id === payload.sessionId) || { id: payload.sessionId };
          return {
            ...session,
            interactionMode: Object.prototype.hasOwnProperty.call(payload, 'interactionMode') ? payload.interactionMode : session.interactionMode || '',
            status: payload.action === 'delete' ? 'deleted' : 'active',
          };
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
const openedWebLinks = [];
const rendererConsole = [];

async function waitFor(expression, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await browserWindow.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: Boolean(process.env.JANUS_ATTACHMENT_REEDIT_SCREENSHOT || imageActionsScreenshot),
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  browserWindow.webContents.on('console-message', (_event, details, legacyMessage) => {
    const payload = details && typeof details === 'object' ? details : { level: details, message: legacyMessage };
    rendererConsole.push(`[${payload.level}] ${payload.message} (${payload.sourceId || 'renderer'}:${payload.lineNumber || 0})`);
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    openedWebLinks.push(url);
    return { action: 'deny' };
  });
  await browserWindow.loadFile(htmlPath);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      const session = document.querySelector('[data-network-session="renderer-session-existing"]');
      if (session) { session.click(); return resolve(true); }
      if (Date.now() > deadline) return reject(new Error('existing chat session did not render: ' + JSON.stringify({
        errors: window.__janusTest?.errors || [],
        body: document.body?.innerText?.slice(0, 1000) || '',
      })));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (document.querySelector('#chat-form') && document.querySelector('.composer-plus')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('chat composer did not render: ' + JSON.stringify(window.__janusTest.errors)));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const outputFilesCollapsed = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      const files = document.querySelector('.message-output-artifacts');
      if (files) return resolve(Boolean(files.tagName === 'DETAILS' && !files.open && files.querySelector('summary')?.textContent.includes('输出文件')));
      if (Date.now() > deadline) return reject(new Error('generated output files did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(outputFilesCollapsed, true, 'generated output files should be collapsible and collapsed by default');
  const conversationAvatarSize = await browserWindow.webContents.executeJavaScript(`(() => {
    const avatar = document.querySelector('.im-conversation-item .network-message-avatar, .im-conversation-item .network-user-avatar, .im-conversation-item .network-secretary-avatar');
    const style = avatar ? getComputedStyle(avatar) : null;
    return style ? [style.width, style.height] : [];
  })()`);
  assert.deepEqual(conversationAvatarSize, ['35px', '35px'], 'left conversation avatars should be enlarged by about ten percent');
  const workspaceSelection = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    let detachedModeWorked = false;
    const trigger = document.querySelector('[data-workspace-menu-toggle]');
    if (!trigger) return reject(new Error('workspace trigger missing: ' + document.querySelector('.composer-stack')?.innerHTML));
    trigger.click();
    const waitForMenu = () => {
      const option = document.querySelector('[data-workspace-none]');
      if (option) {
        option.click();
        return waitForDetached();
      }
      if (Date.now() > deadline) return reject(new Error('workspace menu did not open'));
      setTimeout(waitForMenu, 20);
    };
    const waitForDetached = () => {
      const label = document.querySelector('[data-workspace-menu-toggle] span')?.textContent || '';
      if (label === '无项目') {
        if (document.querySelector('.input-tag')) return reject(new Error('detached workspace should not add a general input tag'));
        document.querySelector('[data-composer-tool-menu-toggle]')?.click();
        return waitForDetachedGoalOption();
      }
      if (Date.now() > deadline) return reject(new Error('workspace could not return to the detached state'));
      setTimeout(waitForDetached, 20);
    };
    const waitForDetachedGoalOption = () => {
      const option = document.querySelector('[data-composer-interaction-mode="goal"]');
      if (option) {
        option.click();
        return waitForDetachedGoalIndicator();
      }
      if (Date.now() > deadline) return reject(new Error('goal mode was not available without a project'));
      setTimeout(waitForDetachedGoalOption, 20);
    };
    const waitForDetachedGoalIndicator = () => {
      const indicator = document.querySelector('.composer-interaction-indicator.mode-goal');
      if (indicator) {
        detachedModeWorked = true;
        indicator.click();
        return waitForDetachedGoalClosed();
      }
      if (Date.now() > deadline) return reject(new Error('goal mode could not start without a project'));
      setTimeout(waitForDetachedGoalIndicator, 20);
    };
    const waitForDetachedGoalClosed = () => {
      if (!document.querySelector('.composer-interaction-indicator')) {
        document.querySelector('[data-workspace-menu-toggle]').click();
        return waitForProjectOption();
      }
      if (Date.now() > deadline) return reject(new Error('detached goal mode could not be closed'));
      setTimeout(waitForDetachedGoalClosed, 20);
    };
    const waitForProjectOption = () => {
      const option = document.querySelector('[data-workspace-project="renderer-project-testing"]');
      if (option) {
        option.click();
        return waitForProject();
      }
      if (Date.now() > deadline) return reject(new Error('project options did not reopen'));
      setTimeout(waitForProjectOption, 20);
    };
    const waitForProject = () => {
      const label = document.querySelector('[data-workspace-menu-toggle] span')?.textContent || '';
      if (label === 'testing') return resolve({ label, hasInputTag: Boolean(document.querySelector('.input-tag')), detachedModeWorked });
      if (Date.now() > deadline) return reject(new Error('existing project could not be selected from the workspace menu'));
      setTimeout(waitForProject, 20);
    };
    waitForMenu();
  })`);
  assert.equal(workspaceSelection.label, 'testing');
  assert.equal(workspaceSelection.hasInputTag, false, 'project chat should not add a general tag to the composer');
  assert.equal(workspaceSelection.detachedModeWorked, true, 'goal mode should work without selecting a project');
  const composerModes = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('[data-composer-tool-menu-toggle]')?.click();
    const deadline = Date.now() + 5000;
    const waitForMenu = () => {
      const menu = document.querySelector('.composer-tool-menu');
      const goal = document.querySelector('[data-composer-interaction-mode="goal"]');
      const plan = document.querySelector('[data-composer-interaction-mode="plan"]');
      const files = document.querySelector('[data-composer-add-files]');
      if (menu && goal && plan && files) {
        const menuText = menu.innerText;
        goal.click();
        return waitForGoal(menuText);
      }
      if (Date.now() > deadline) return reject(new Error('composer tool menu did not render the Goal, Plan, and file options'));
      setTimeout(waitForMenu, 20);
    };
    const waitForGoal = (menuText) => {
      const indicator = document.querySelector('.composer-interaction-indicator.mode-goal');
      if (indicator) {
        const metaItems = Array.from(document.querySelector('.composer-meta-bar').children);
        const permissionIndex = metaItems.findIndex((item) => item.querySelector?.('#sandbox-permission-trigger'));
        const indicatorIndex = metaItems.indexOf(indicator);
        indicator.click();
        return resolve({ menuText, permissionIndex, indicatorIndex });
      }
      if (Date.now() > deadline) return reject(new Error('goal indicator did not appear'));
      setTimeout(() => waitForGoal(menuText), 20);
    };
    waitForMenu();
  })`);
  assert.ok(composerModes.menuText.includes('文件和文件夹'));
  assert.ok(composerModes.menuText.includes('目标'));
  assert.ok(composerModes.menuText.includes('计划模式'));
  assert.equal(composerModes.indicatorIndex, composerModes.permissionIndex + 1, 'goal indicator should appear immediately after permissions');
  const fullAccessConfirmation = await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#sandbox-permission-trigger')?.click();
    document.querySelector('[data-sandbox-permission="full-access"]')?.click();
    const message = window.__janusTest.confirmMessages.at(-1) || '';
    document.querySelector('#sandbox-permission-trigger')?.click();
    document.querySelector('[data-sandbox-permission="request-approval"]')?.click();
    return message;
  })()`);
  assert.match(fullAccessConfirmation, /Janus/);
  assert.doesNotMatch(fullAccessConfirmation, /Codex/);
  const chineseSearch = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const waitForTrigger = () => {
      const trigger = document.querySelector('#sidebar-chat-search-trigger');
      if (trigger) {
        trigger.click();
        return waitForInput();
      }
      if (Date.now() > deadline) return reject(new Error('chat search trigger was not available after switching projects'));
      setTimeout(waitForTrigger, 20);
    };
    const waitForInput = () => {
      const input = document.querySelector('#chat-search-modal-input');
      if (!input) {
        if (Date.now() > deadline) return reject(new Error('chat search input did not open'));
        return setTimeout(waitForInput, 20);
      }
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      input.value = '中文';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '文', inputType: 'insertCompositionText', isComposing: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
      waitForFirstResult();
    };
    const waitForFirstResult = () => {
      const input = document.querySelector('#chat-search-modal-input');
      if (window.__janusTest.searchQueries.includes('中文') && input && document.activeElement === input && input.value === '中文') {
        input.setSelectionRange(1, 1);
        input.setRangeText('对话', 1, 1, 'end');
        const expectedCaret = input.selectionStart;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '对话', inputType: 'insertText' }));
        return waitForSecondResult(expectedCaret);
      }
      if (Date.now() > deadline) return reject(new Error('Chinese IME search did not complete with focus preserved'));
      setTimeout(waitForFirstResult, 20);
    };
    const waitForSecondResult = (expectedCaret) => {
      const input = document.querySelector('#chat-search-modal-input');
      if (window.__janusTest.searchQueries.includes('中对话文') && input && document.activeElement === input) {
        return resolve({ value: input.value, caret: input.selectionStart, expectedCaret });
      }
      if (Date.now() > deadline) return reject(new Error('search result render lost input focus'));
      setTimeout(() => waitForSecondResult(expectedCaret), 20);
    };
    waitForTrigger();
  })`);
  assert.equal(chineseSearch.value, '中对话文', 'Chinese search text should survive real-time result rendering');
  assert.equal(chineseSearch.caret, chineseSearch.expectedCaret, 'search caret position should survive result rendering');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-chat-search-btn').click()`);
  const activeMessageSession = await browserWindow.webContents.executeJavaScript(`({
    active: Boolean(document.querySelector('[data-network-session="renderer-session-existing"].active')),
    panelVisible: Boolean(document.querySelector('.network-content.network-messages')),
  })`);
  assert.equal(activeMessageSession.active, true, 'opened conversation should remain active in the message panel');
  assert.equal(activeMessageSession.panelVisible, true, 'message conversation panel should remain visible');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.body.innerText.includes('小狗.png') && document.querySelector('#chat-form')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('existing conversation did not open'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const darkTextColors = await browserWindow.webContents.executeJavaScript(`(() => {
    const sessionTitle = getComputedStyle(document.querySelector('[data-network-session="renderer-session-existing"] strong')).color;
    const placeholder = getComputedStyle(document.querySelector('#chat-input'), '::placeholder').color;
    document.querySelector('#model-picker-trigger').click();
    const modelOption = getComputedStyle(document.querySelector('[data-reasoning-option="high"]')).color;
    document.querySelector('#model-picker-trigger').click();
    return { sessionTitle, placeholder, modelOption };
  })()`);
  assert.equal(darkTextColors.sessionTitle, 'rgb(237, 243, 251)', 'dark active message-panel titles need high-contrast text');
  assert.equal(darkTextColors.placeholder, 'rgb(127, 141, 160)', 'dark composer placeholders should use the shared faint-text token');
  assert.equal(darkTextColors.modelOption, 'rgb(230, 237, 246)', 'dark model menu options need light text');
  const imageContextMenu = await browserWindow.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('[data-message-id="renderer-uploaded-image-message"] [data-image-context-file]');
    if (!target) throw new Error('uploaded message image did not expose an image context target');
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 360, clientY: 260 }));
    return {
      hasCopyImage: Boolean(document.querySelector('[data-message-context-action="copy-image"]')),
      hasPreviewImage: Boolean(document.querySelector('[data-message-context-action="preview-image"]')),
      hasSaveImage: Boolean(document.querySelector('[data-message-context-action="save-image"]')),
      hasMessageCopy: Boolean(document.querySelector('[data-message-context-action="copy"]')),
      hasQuote: Boolean(document.querySelector('[data-message-context-action="quote"]')),
      label: document.querySelector('.message-context-menu')?.textContent || '',
    };
  })()`);
  assert.equal(imageContextMenu.hasCopyImage, true, 'right-clicking an uploaded image must expose copy image');
  assert.equal(imageContextMenu.hasPreviewImage, true, 'image context menu must expose preview');
  assert.equal(imageContextMenu.hasSaveImage, true, 'image context menu must expose save as');
  assert.equal(imageContextMenu.hasMessageCopy, false, 'image right-click must not fall through to message text copy');
  assert.equal(imageContextMenu.hasQuote, false, 'image right-click must not fall through to message quote');
  assert.match(imageContextMenu.label, /复制图片/);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-context-action="copy-image"]').click()`);
  await waitFor('window.__janusTest.imageCopies.length === 1', 'image context copy did not reach the clipboard bridge');
  const copiedImagePayload = await browserWindow.webContents.executeJavaScript('window.__janusTest.imageCopies[0]');
  assert.equal(copiedImagePayload.path, imagePath);
  assert.equal(copiedImagePayload.sessionId, 'renderer-session-existing');
  assert.equal(copiedImagePayload.projectId, 'renderer-project-testing');

  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-id="renderer-uploaded-image-message"] [data-preview-file]').click()`);
  await waitFor("document.querySelector('.preview-image') && document.querySelector('[data-copy-image]')", 'image preview did not expose direct copy');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-copy-image]').click()`);
  await waitFor('window.__janusTest.imageCopies.length === 2', 'preview toolbar copy did not reach the clipboard bridge');
  const previewImageContext = await browserWindow.webContents.executeJavaScript(`(() => {
    const image = document.querySelector('.preview-image');
    image.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 360 }));
    const layer = document.querySelector('.message-context-layer');
    return {
      hasCopyImage: Boolean(document.querySelector('[data-message-context-action="copy-image"]')),
      previewContext: layer?.classList.contains('is-preview-context'),
      layerZIndex: Number(getComputedStyle(layer).zIndex || 0),
      previewZIndex: Number(getComputedStyle(document.querySelector('.preview-overlay')).zIndex || 0),
    };
  })()`);
  assert.equal(previewImageContext.hasCopyImage, true, 'right-clicking the preview image must expose copy image');
  assert.equal(previewImageContext.previewContext, true, 'preview image context menu needs preview-level stacking');
  assert.ok(previewImageContext.layerZIndex > previewImageContext.previewZIndex, 'preview image context menu must render above the preview overlay');
  if (imageActionsScreenshot) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    writeFileSync(imageActionsScreenshot, (await browserWindow.capturePage()).toPNG());
  }
  await browserWindow.webContents.executeJavaScript(`document.querySelector('[data-message-context-action="copy-image"]').click()`);
  await waitFor('window.__janusTest.imageCopies.length === 3', 'preview context copy did not reach the clipboard bridge');
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-preview-btn').click()`);
  const attachmentCardPreview = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const details = document.querySelector('.message-output-artifacts');
    if (details) details.open = true;
    const trigger = details?.querySelector('[data-preview-file]');
    if (!trigger) return reject(new Error('main-chat attachment preview trigger did not render'));
    trigger.click();
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.preview-modal')?.textContent.includes('项目待办内容')) {
        return resolve({
          hasPreview: true,
          renderedFile: window.__janusTest.renderedFiles.at(-1),
        });
      }
      if (Date.now() > deadline) return reject(new Error('main-chat data-preview-file action was not wired'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(attachmentCardPreview.hasPreview, true);
  assert.equal(attachmentCardPreview.renderedFile?.path, todoPath);
  await browserWindow.webContents.executeJavaScript(`document.querySelector('#close-preview-btn').click()`);
  const localMarkdownOpen = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const trigger = document.querySelector('[data-preview-local-file]');
    if (!trigger) return reject(new Error('local Markdown preview trigger did not render: ' + document.querySelector('#message-list')?.innerText));
    trigger.click();
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusTest.openedFiles.length) return resolve(window.__janusTest.openedFiles.at(-1));
      if (Date.now() > deadline) return reject(new Error('local Markdown link did not open the file'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(localMarkdownOpen.path, todoPath);
  assert.equal(localMarkdownOpen.messageId, 'renderer-local-markdown');
  assert.equal(localMarkdownOpen.sessionId, 'renderer-session-existing');
  assert.equal(localMarkdownOpen.projectId, 'renderer-project-testing');
  const delegatedMarkdownOpen = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const trigger = document.querySelector('[data-message-id="renderer-delegation-draft"] [data-preview-local-file]');
    if (!trigger) return reject(new Error('delegation Markdown link did not render'));
    trigger.click();
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusTest.downloads.length && window.__janusTest.openedFiles.length >= 2) {
        return resolve({
          download: window.__janusTest.downloads.at(-1),
          openedFile: window.__janusTest.openedFiles.at(-1),
        });
      }
      if (Date.now() > deadline) return reject(new Error('delegation Markdown link did not download and open its linked attachment'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(delegatedMarkdownOpen.download.fileId, 'collab_file_agent_map');
  assert.equal(delegatedMarkdownOpen.openedFile.path, delegatedReportPath);
  assert.equal(delegatedMarkdownOpen.openedFile.messageId, '', 'remote delivery links must not use the draft message local-file ownership check');
  assert.equal(delegatedMarkdownOpen.openedFile.sessionId, 'renderer-session-existing');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll('#message-list a')]
      .find((item) => item.textContent.includes('Janus 文档'));
    if (!link) throw new Error('HTTPS Markdown link did not render');
    link.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(openedWebLinks, ['https://example.com/docs?q=janus']);
  assert.equal(BrowserWindow.getAllWindows().length, 1, 'HTTPS links must not create an in-app child window');
  const multilinePaste = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const input = document.querySelector('#chat-input');
    const paste = (text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    };
    paste(Array.from({ length: 7 }, (_, index) => '粘贴内容第 ' + (index + 1) + ' 行').join('\\n'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const expandedHeight = input.getBoundingClientRect().height;
      input.value = '';
      input.setSelectionRange(0, 0);
      paste(Array.from({ length: 30 }, (_, index) => '较长的粘贴段落第 ' + (index + 1) + ' 行').join('\\n'));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(5, 5);
        const result = {
          expandedHeight,
          height: input.getBoundingClientRect().height,
          scrollHeight: input.scrollHeight,
          overflowY: getComputedStyle(input).overflowY,
          selectionStart: input.selectionStart,
        };
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (result.expandedHeight <= 80) return reject(new Error('multiline paste did not expand the composer'));
        resolve(result);
      }));
    }));
  })`);
  assert.ok(multilinePaste.scrollHeight > multilinePaste.height, 'very long pasted text should remain scrollable');
  assert.equal(multilinePaste.overflowY, 'auto', 'long pasted text should enable textarea scrolling');
  assert.equal(multilinePaste.selectionStart, 5, 'the caret should remain movable inside pasted text');
  const imagePaste = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const input = document.querySelector('#chat-input');
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], '', { type: 'image/png' }));
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    const deadline = Date.now() + 5000;
    const poll = () => {
      const card = document.querySelector('.attachment-card');
      if (card && !card.classList.contains('is-uploading') && !card.classList.contains('is-error')) {
        const noticeElement = document.querySelector('.app-notice');
        const notice = noticeElement?.getBoundingClientRect();
        const send = document.querySelector('.send-btn')?.getBoundingClientRect();
        const main = document.querySelector('.main')?.getBoundingClientRect();
        const noticeCenterDelta = notice && main ? Math.abs((notice.left + notice.width / 2) - (main.left + main.width / 2)) : -1;
        const result = {
          name: card.getAttribute('title') || card.querySelector('strong')?.textContent || '',
          focused: document.activeElement?.id === 'chat-input',
          noticeBottomCenter: Boolean(noticeElement?.classList.contains('is-chat-bottom-center') && notice && send
            && noticeCenterDelta <= 2 && notice.bottom <= send.top - 8),
          noticeAvoidsSend: Boolean(notice && send && (notice.right <= send.left || notice.left >= send.right || notice.bottom <= send.top || notice.top >= send.bottom)),
          noticeGeometry: { className: noticeElement?.className || '', centerDelta: noticeCenterDelta, bottom: notice?.bottom || 0, sendTop: send?.top || 0 },
        };
        card.querySelector('[data-remove-attachment]')?.click();
        return resolve(result);
      }
      if (Date.now() > deadline) return reject(new Error('pasted image did not become an attachment: ' + JSON.stringify({ errors: window.__janusTest.errors, uploads: window.__janusTest.uploads.length, cards: [...document.querySelectorAll('.attachment-card')].map((item) => item.textContent.trim()) })));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.match(imagePaste.name, /^粘贴附件-.+\.png$/, 'clipboard screenshots need a generated supported filename');
  assert.equal(imagePaste.focused, true, 'pasting an attachment must restore composer focus');
  assert.equal(imagePaste.noticeBottomCenter, true, `attachment-added notices must appear above the composer at the bottom-center of the chat pane: ${JSON.stringify(imagePaste.noticeGeometry)}`);
  assert.equal(imagePaste.noticeAvoidsSend, true, 'attachment-added notices must not cover the send button');
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('[data-composer-tool-menu-toggle]')?.click();
    const deadline = Date.now() + 3000;
    const clickFileOption = () => {
      const option = document.querySelector('[data-composer-add-files]');
      if (option) {
        option.click();
        return resolve(true);
      }
      if (Date.now() > deadline) return reject(new Error('composer tool menu did not expose the file option'));
      setTimeout(clickFileOption, 20);
    };
    clickFileOption();
  })`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (document.querySelector('.attachment-card')?.textContent.includes('已就绪')) return resolve(true);
      if (Date.now() > deadline) return reject(new Error('native TXT attachment did not become ready'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const attachmentTextColor = await browserWindow.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.attachment-main strong')).color`);
  assert.equal(attachmentTextColor, 'rgb(241, 245, 249)', 'dark attachment filenames need high-contrast text');
  await browserWindow.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#chat-input');
    input.value = '这个文本的第一句话是什么？';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chat-form').requestSubmit();
  })()`);
  const pendingResult = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (window.__janusTest.errors.length) return resolve({ errors: window.__janusTest.errors });
      if (window.__janusTest.sent.length && window.__janusTest.sendResolvers.length && !document.querySelector('.attachment-card')) {
        return resolve({ errors: [], busy: Boolean(document.querySelector('#cancel-chat-btn')) });
      }
      if (Date.now() > deadline) return reject(new Error('attachment card did not disappear immediately after submit'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(pendingResult.errors, [], `renderer errors before send completion:\n${pendingResult.errors.join('\n')}`);
  assert.equal(pendingResult.busy, true, 'chat should still be running when the attachment card disappears');
  const lockedPermission = await browserWindow.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('#sandbox-permission-trigger');
    trigger?.click();
    return {
      disabled: Boolean(trigger?.disabled),
      label: trigger?.textContent?.replace(/\\s+/g, ' ').trim() || '',
      title: trigger?.getAttribute('title') || '',
      menuVisible: Boolean(document.querySelector('.sandbox-permission-menu')),
      sentPermission: window.__janusTest.sent[0]?.sandboxPermission || '',
    };
  })()`);
  assert.equal(lockedPermission.disabled, true, 'permission selection must lock while the current reply is running');
  assert.match(lockedPermission.label, /本轮.*请求批准/);
  assert.match(lockedPermission.title, /当前回复正在使用.*请求批准/);
  assert.equal(lockedPermission.menuVisible, false, 'a locked permission control must not open its menu');
  assert.equal(lockedPermission.sentPermission, 'request-approval', 'the displayed run permission must match the IPC payload snapshot');
  const englishStreamingStatus = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    document.querySelector('#language-toggle-btn')?.click();
    document.querySelector('[data-language-choice="en"]')?.click();
    const channelId = window.__janusTest.sent[0]?.channelId;
    window.__janusTest.codexListener?.({ channelId, event: {
      kind: 'activity', activityId: 'renderer-english-streaming-status', activityType: 'command', eventOrigin: 'codex', status: 'completed',
      title: 'Completed test operation', command: 'node scripts/check.mjs', output: 'ok', exitCode: 0,
    } });
    const deadline = Date.now() + 5000;
    const poll = () => {
      const label = document.querySelector('.codex-live-status span')?.textContent?.trim() || '';
      if (document.documentElement.lang === 'en' && label) {
        const transcript = document.querySelector('.codex-transcript');
        return resolve({ label, ariaLabel: transcript?.getAttribute('aria-label') || '' });
      }
      if (Date.now() > deadline) return reject(new Error('English streaming process status did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.equal(englishStreamingStatus.label, 'Processed', 'streaming process status must be localized before the partial DOM update is shown');
  assert.equal(englishStreamingStatus.ariaLabel, 'Janus Activity', 'streaming process attributes must be localized during the same partial DOM update');
  await browserWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('#language-toggle-btn')?.click();
    document.querySelector('[data-language-choice="zh-CN"]')?.click();
  })()`);
  await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
    const poll = () => {
      if (document.documentElement.lang === 'zh-CN') return resolve(true);
      if (Date.now() > deadline) return reject(new Error('renderer did not switch back to Chinese after the English streaming probe'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  const approvalResult = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const channelId = window.__janusTest.sent[0]?.channelId;
    const input = document.querySelector('#chat-input');
    input.focus();
    window.__janusTest.codexListener?.({ channelId, event: {
      kind: 'approval-request', approvalId: 'renderer-approval-1', itemId: 'renderer-approval-item-1', runId: 'renderer-run-1',
      command: 'node scripts/check.mjs', cwd: '/workspace/testing', reason: 'Codex needs permission to run a local check.',
    } });
    const deadline = Date.now() + 5000;
    const poll = () => {
      const prompt = document.querySelector('.chat-approval-prompt');
      const currentInput = document.querySelector('#chat-input');
      if (prompt && currentInput) {
        currentInput.focus();
        currentInput.value = '审批等待时仍可输入';
        currentInput.dispatchEvent(new Event('input', { bubbles: true }));
        const result = {
          title: prompt.textContent.replace(/\\s+/g, ' ').trim(),
          detailOpen: prompt.querySelector('details')?.open === true,
          focused: document.activeElement === currentInput,
          editable: currentInput.value === '审批等待时仍可输入',
          initialDuration: document.querySelector('[data-process-duration]')?.textContent || '',
        };
        return setTimeout(() => {
          const nextDuration = document.querySelector('[data-process-duration]')?.textContent || '';
          document.querySelector('[data-chat-approval="approve"]')?.click();
          window.__janusTest.codexListener?.({ channelId, event: {
            kind: 'approval-request', approvalId: 'renderer-approval-2', itemId: 'renderer-approval-item-2', runId: 'renderer-run-1',
            command: 'node scripts/fake_codex_e2e.mjs', cwd: '/workspace/testing', reason: 'Second approval must remain visible.',
          } });
          setTimeout(() => resolve({
            ...result,
            nextDuration,
            approvals: window.__janusTest.approvals,
            nextApproval: document.querySelector('.chat-approval-prompt')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
          }), 50);
        }, 1150);
      }
      if (Date.now() > deadline) return reject(new Error('non-blocking approval prompt did not render'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.match(approvalResult.title, /Janus 需要确认一项操作/);
  assert.match(approvalResult.title, /Janus needs permission to run a local check\./);
  assert.doesNotMatch(approvalResult.title, /Codex/);
  assert.equal(approvalResult.detailOpen, false, 'approval command details should stay collapsed by default');
  assert.equal(approvalResult.focused && approvalResult.editable, true, 'approval UI must not block composer focus or typing');
  assert.notEqual(approvalResult.nextDuration, approvalResult.initialDuration, 'visible process duration should refresh every second without rerendering the composer');
  assert.equal(approvalResult.approvals[0]?.approved, true, 'inline approval must resolve the pending request');
  assert.match(approvalResult.nextApproval, /Second approval must remain visible\./,
    'an older approval IPC response must not clear a newer queued approval');
  await browserWindow.webContents.executeJavaScript(`window.__janusTest.sendResolvers[0]()`);
  const result = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const poll = () => {
      if (window.__janusTest.errors.length || (window.__janusTest.sent.length && !document.querySelector('#cancel-chat-btn') && !document.querySelector('.attachment-card'))) {
        return resolve({
          sent: window.__janusTest.sent,
          errors: window.__janusTest.errors,
          busy: Boolean(document.querySelector('#cancel-chat-btn')),
          permissionDisabled: Boolean(document.querySelector('#sandbox-permission-trigger')?.disabled),
          permissionLabel: document.querySelector('#sandbox-permission-trigger')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
          text: document.body.innerText,
        });
      }
      if (Date.now() > deadline) return reject(new Error('form submit did not reach IPC'));
      setTimeout(poll, 20);
    };
    poll();
  })`);
  assert.deepEqual(result.errors, [], `renderer errors:\n${result.errors.join('\n')}\n${rendererConsole.join('\n')}`);
  assert.equal(result.sent.length, 1, 'attachment submit should invoke sendChat once');
  assert.equal(result.permissionDisabled, false, 'permission selection must unlock after the reply finishes');
  assert.doesNotMatch(result.permissionLabel, /本轮/);
  const payload = result.sent[0];
  assert.equal(payload.message, '这个文本的第一句话是什么？');
  assert.equal(payload.sessionId, 'renderer-session-existing', 'attachment submit must preserve the current conversation id');
  assert.equal(payload.attachments.length, 1);
  assert.equal(payload.attachments[0].filename, selectedFile.filename);
  assert.equal(payload.attachments[0].path, selectedFile.path);
  assert.equal(payload.attachments[0].relative_path, selectedFile.relative_path);
  assert.equal(payload.attachments[0].content_type, selectedFile.content_type);
  const reEditResult = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const openMenu = (id) => document.querySelector('[data-message-id="' + id + '"]')?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 240, clientY: 240,
    }));
    const poll = () => {
      const olderId = 'renderer-older-user-renderer-session-existing';
      const latestId = 'renderer-user-renderer-session-existing';
      if (!document.querySelector('[data-message-id="' + latestId + '"]')) {
        if (Date.now() > deadline) return reject(new Error('completed conversation messages did not render'));
        return setTimeout(poll, 20);
      }
      openMenu(olderId);
      const olderEditable = Boolean(document.querySelector('[data-message-context-action="edit"]'));
      document.querySelector('[data-message-context-dismiss]')?.click();
      openMenu(latestId);
      const latestEdit = document.querySelector('[data-message-context-action="edit"]');
      if (!latestEdit) return reject(new Error('latest user message did not expose re-edit'));
      latestEdit.click();
      const waitForEditor = () => {
        const editor = document.querySelector('[data-message-rewrite-input]');
        if (editor?.value === '这个文本的第一句话是什么？') {
          document.querySelector('[data-message-rewrite-form]')?.requestSubmit();
          return waitForResend(editor.value);
        }
        if (Date.now() > deadline) return reject(new Error('re-edit form did not stabilize'));
        setTimeout(waitForEditor, 20);
      };
      const waitForResend = (value) => {
        const resent = window.__janusTest.sent[1];
        if (resent) {
          window.__janusTest.sendResolvers[1]?.();
          return resolve({
            olderEditable,
            value,
            rewriteCount: window.__janusTest.rewrites.length,
            attachmentName: resent.attachments?.[0]?.filename || resent.attachments?.[0]?.name || '',
          });
        }
        if (Date.now() > deadline) return reject(new Error('re-edited message did not resend with restored attachments'));
        setTimeout(() => waitForResend(value), 20);
      };
      waitForEditor();
    };
    poll();
  })`);
  assert.equal(reEditResult.olderEditable, false, 'only the latest user message may be re-edited');
  assert.equal(reEditResult.value, '这个文本的第一句话是什么？', 'latest user text should enter the inline rewrite form');
  assert.equal(reEditResult.rewriteCount, 1, 're-edit must invalidate the old turn exactly once');
  assert.match(reEditResult.attachmentName, /自进化流程详解\.txt/, 're-generated turns must resend the original attachment');
  const failedReplyRewrite = await browserWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const pollUntilIdle = () => {
      if (Date.now() > deadline) return reject(new Error('re-generated turn did not settle before failure check'));
      if (document.querySelector('#cancel-chat-btn')) return setTimeout(pollUntilIdle, 20);
      window.__janusTest.failNextSend = true;
      const input = document.querySelector('#chat-input');
      input.value = '失败后仍可修改';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#chat-form')?.requestSubmit();
      pollForFailure();
    };
    const pollForFailure = () => {
      const localMessage = [...document.querySelectorAll('[data-message-id]')].find((node) => (
        node.dataset.messageId.startsWith('local-') && node.textContent.includes('失败后仍可修改')
      ));
      if (localMessage && document.body.innerText.includes('429 Too Many Requests') && !document.querySelector('#cancel-chat-btn')) {
        localMessage.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 240, clientY: 240 }));
        document.querySelector('[data-message-context-action="edit"]')?.click();
        return pollForEditor();
      }
      if (Date.now() > deadline) return reject(new Error('failed Codex turn did not expose the local user message'));
      setTimeout(pollForFailure, 20);
    };
    const pollForEditor = () => {
      const editor = document.querySelector('[data-message-rewrite-input]');
      if (editor?.value === '失败后仍可修改') {
        editor.value = '失败后修改成功';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-message-rewrite-form]')?.requestSubmit();
        return pollForRewrite();
      }
      if (Date.now() > deadline) return reject(new Error('failed turn editor did not open'));
      setTimeout(pollForEditor, 20);
    };
    const pollForRewrite = () => {
      const rewrite = window.__janusTest.rewrites[1];
      if (rewrite) {
        window.__janusTest.sendResolvers[2]?.();
        return resolve({ messageId: rewrite.messageId, errorText: document.querySelector('.message-inline-editor-error')?.textContent || '' });
      }
      if (Date.now() > deadline) return reject(new Error('failed turn rewrite did not reach IPC'));
      setTimeout(pollForRewrite, 20);
    };
    pollUntilIdle();
  })`);
  assert.equal(failedReplyRewrite.messageId, 'renderer-failed-user-3', 'failed Codex turns must rewrite the persisted user message instead of the local optimistic id');
  assert.equal(failedReplyRewrite.errorText, '', 'failed Codex turns should remain editable without an unavailable-message error');
  if (process.env.JANUS_ATTACHMENT_REEDIT_SCREENSHOT) {
    mkdirSync(path.dirname(process.env.JANUS_ATTACHMENT_REEDIT_SCREENSHOT), { recursive: true });
    const screenshot = await browserWindow.capturePage();
    writeFileSync(process.env.JANUS_ATTACHMENT_REEDIT_SCREENSHOT, screenshot.toPNG());
  }
  process.stdout.write('Renderer native TXT attachment submit smoke passed.\n');
} catch (error) {
  if (rendererConsole.length) process.stderr.write(`Renderer console:\n${rendererConsole.join('\n')}\n`);
  await captureElectronFailureDiagnostics({ browserWindow, error, name: 'renderer-attachment', stateExpression: 'window.__attachmentTest?.errors || window.__attachmentSubmitTest?.errors || []' });
  throw error;
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
