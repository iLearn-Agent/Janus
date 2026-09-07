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
const smokeHome = mkdtempSync(path.join(process.platform === 'linux' ? '/tmp' : os.tmpdir(), 'janus-message-preview-sender-'));
const port = await availableTcpPort();
const screenshotPath = process.env.JANUS_MESSAGE_PREVIEW_SCREENSHOT || path.join(root, 'test-artifacts', 'message-preview-sender-real-ui.png');
const stateEntry = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'state.js')).href;
const electronBinary = process.platform === 'win32' ? 'electron.exe' : 'electron';
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', electronBinary);
const childEnv = {
  ...process.env,
  ELECTRON_DISABLE_SANDBOX: '1',
  JANUS_MODEL_REFRESH_ENABLED: '0',
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
  await cdp.send('Page.enable');
  await waitForRenderer(cdp, `document.querySelector('#network-panel[data-page-kind="messages"]') && document.querySelector('[data-message-groups-toggle]')`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });

  await evaluate(cdp, `(async () => {
    const { state } = await import(${JSON.stringify(stateEntry)});
    const currentUserId = 'message-preview-current-user';
    state.currentUser = { id: currentUserId, displayName: '管理员', username: 'manager' };
    state.sessions = [];
    state.pendingAgentRuns = [];
    state.friendOverview = {
      friends: [
        { friend: { id: 'preview-liu', displayName: '刘烨', username: 'liuye' } },
        { friend: { id: 'preview-lin', displayName: '林晓雨', username: 'linxiaoyu' } },
      ],
      requests: { incoming: [], outgoing: [] },
      organizations: [],
    };
    state.socialThreads = [
      { friend: { id: 'preview-liu', displayName: '刘烨', username: 'liuye' }, messages: [{
        id: 'preview-incoming-direct', senderUserId: 'preview-liu', recipientUserId: currentUserId,
        status: 'sent', content: '321314', updatedAt: '2026-08-05T09:20:00.000Z',
      }] },
      { friend: { id: 'preview-lin', displayName: '林晓雨', username: 'linxiaoyu' }, messages: [{
        id: 'preview-outgoing-direct', senderUserId: currentUserId, recipientUserId: 'preview-lin',
        status: 'read', content: '111', updatedAt: '2026-08-05T09:19:00.000Z',
      }] },
    ];
    state.chatGroupsOverview = { capability: 'chat-groups-v2', groups: [
      {
        id: 'preview-incoming-group', title: '产品讨论群', status: 'active', memberCount: 3, unreadCount: 1,
        lastMessage: '刘烨：请确认最终时间', lastMessageContent: '请确认最终时间',
        lastMessageSenderUserId: 'preview-liu', lastMessageSenderName: '刘烨', updatedAt: '2026-08-05T09:18:00.000Z',
      },
      {
        id: 'preview-outgoing-group', title: '项目同步群', status: 'active', memberCount: 4, unreadCount: 0,
        lastMessage: '管理员：我已处理完成', lastMessageContent: '我已处理完成',
        lastMessageSenderUserId: currentUserId, lastMessageSenderName: '管理员', updatedAt: '2026-08-05T09:17:00.000Z',
      },
    ] };
    state.collaborationOverview = { groups: [], tasks: [] };
    state.completedConversationKeys = [];
    state.markedConversationKeys = [];
    state.unreadConversationKeys = [];
    state.networkMessageListFilter = 'all';
    state.networkMessageSearchQuery = '';
    state.networkMessageHomeOpen = true;
    state.networkPanelView = 'messages';
    state.messageGroupSidebarOpen = true;
    document.querySelector('[data-message-groups-toggle]')?.click();
  })()`);

  await waitForRenderer(cdp, `document.querySelector('.direct-message-item[data-network-peer="preview-liu"]') && document.querySelector('[data-chat-group="preview-outgoing-group"]')`);
  const previews = await evaluate(cdp, `(() => {
    const read = (selector) => ({
      text: document.querySelector(selector)?.textContent?.trim() || '',
      prefix: document.querySelector(selector)?.querySelector('.im-conversation-preview-prefix')?.textContent?.trim() || '',
    });
    return {
      incomingDirect: read('.direct-message-item[data-network-peer="preview-liu"] .network-message-preview'),
      outgoingDirect: read('.direct-message-item[data-network-peer="preview-lin"] .network-message-preview'),
      incomingGroup: read('[data-chat-group="preview-incoming-group"] .network-message-preview'),
      outgoingGroup: read('[data-chat-group="preview-outgoing-group"] .network-message-preview'),
    };
  })()`);
  assert(previews.incomingDirect.text === '刘烨 · 321314' && previews.incomingDirect.prefix === '刘烨 ·', previews);
  assert(previews.outgoingDirect.text === '111' && previews.outgoingDirect.prefix === '', previews);
  assert(previews.incomingGroup.text === '刘烨 · 请确认最终时间' && previews.incomingGroup.prefix === '刘烨 ·', previews);
  assert(previews.outgoingGroup.text === '我已处理完成' && previews.outgoingGroup.prefix === '', previews);

  const panel = await evaluate(cdp, `(() => {
    const rect = document.querySelector('#network-panel')?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  })()`);
  if (!panel) throw new Error('消息面板不存在，无法截图。');
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: panel.x, y: panel.y, width: panel.width, height: panel.height, scale: 1 },
  });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  process.stdout.write(`${JSON.stringify({ ok: true, previews, screenshotPath }, null, 2)}\n`);
} catch (error) {
  failed = true;
  await captureSpawnedElectronFailureDiagnostics({ child, error, stderr, port, runtimeHome: smokeHome, name: 'message-preview-sender' });
  throw error;
} finally {
  await terminateSpawnedProcess(child);
  if (!failed || !process.env.JANUS_TEST_ARTIFACT_DIR) rmSync(smokeHome, { recursive: true, force: true });
}

function assert(condition, details) {
  if (!condition) throw new Error(`消息摘要发送者规则不正确：${JSON.stringify(details)}`);
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

async function waitForPageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
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
