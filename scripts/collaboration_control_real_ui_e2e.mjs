import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const projectRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-collaboration-control-ui-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const profileRoot = path.join(tempRoot, 'profile');
const screenshotRoot = path.join(projectRoot, 'test-artifacts', 'collaboration-control-ui');
const screenshot = path.join(screenshotRoot, 'collaboration-control-fixed.png');
const collapsedScreenshot = path.join(screenshotRoot, 'collaboration-control-collapsed.png');
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const debugPort = Number(process.env.JANUS_COLLABORATION_CONTROL_UI_PORT || 9593);
const account = { email: 'collaboration-control-ui@example.com', password: 'Collaboration-Control-UI-1!' };
let groupId = '';

let child = null;
let cdp = null;
let stderr = '';

mkdirSync(screenshotRoot, { recursive: true });
rmSync(screenshot, { force: true });
rmSync(collapsedScreenshot, { force: true });

try {
  assert.ok(existsSync(electronBinary), `Electron binary not found: ${electronBinary}`);
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true, requireExplicitAuthentication: true });
  runtime.authRegister({ email: account.email, password: account.password, displayName: '项目发起人' });
  await runtime.authUpdateProfile({ displayName: '项目发起人', username: 'project_owner' });
  const owner = runtime.currentUser();
  const peers = [
    ['collab_ui_researcher', '林然'],
    ['collab_ui_writer', '周宁'],
    ['collab_ui_reviewer', '陈曦'],
    ['collab_ui_pending', '顾言'],
  ];
  for (const [id, displayName] of peers) {
    runtime.db.prepare(`INSERT INTO auth_users(id,email,display_name,username,role,password_hash,email_verified,auth_provider,remote_id)
      VALUES(?,?,?,?, 'member','',1,'local_mock','')`).run(id, `${id}@example.test`, displayName, id);
    const [userA, userB] = [owner.id, id].sort();
    runtime.db.prepare("INSERT INTO friendships(id,user_a_id,user_b_id,status) VALUES(?,?,?,'accepted')")
      .run(`friend_${id}`, userA, userB);
  }

  const created = runtime.auth.createCollaborationGroup({
    title: '新品发布方案协作组',
    clientRequestId: 'collaboration-control-visual-v1',
    plannedRecipientIds: peers.map(([id]) => id),
    metadata: {
      plannedRecipientIds: peers.map(([id]) => id),
      taskSummary: {
        version: 1,
        objective: '完成新品发布方案、传播文案与上线前风险复核',
        deliverables: ['市场研究摘要', '发布文案', '风险复核清单'],
        acceptanceCriteria: ['结论可核验', '风险项有明确负责人'],
        constraints: ['本周五前完成', '统一使用中文'],
      },
    },
    assignments: [
      { recipientId: 'collab_ui_researcher', title: '市场与竞品研究', instruction: '整理目标市场、用户画像和竞品差异。' },
      { recipientId: 'collab_ui_writer', title: '发布文案与渠道素材', instruction: '输出发布文案和渠道素材清单。' },
      { recipientId: 'collab_ui_reviewer', title: '上线风险复核', instruction: '复核上线风险、依赖和回滚预案。' },
    ],
  });
  groupId = created.group.id;
  assert.ok(groupId);
  const tasks = Object.fromEntries(created.tasks.map((task) => [task.recipientUserId, task]));
  const timestamp = '2026-08-15T09:30:00.000Z';
  const progressByRecipient = {
    collab_ui_researcher: {
      status: 'working',
      progress: {
        phase: 'executing', message: '正在汇总竞品定位和用户访谈结论', completed: 3, total: 5, updatedAt: timestamp,
        currentStep: { title: '核对三家主要竞品的定价与能力差异', status: 'running', agentName: '研究 Agent' },
        nodes: [
          { id: 'research-1', title: '确认研究范围', status: 'completed', updatedAt: '2026-08-15T09:05:00.000Z' },
          { id: 'research-2', title: '收集用户访谈', status: 'completed', updatedAt: '2026-08-15T09:15:00.000Z' },
          { id: 'research-3', title: '竞品能力对比', status: 'running', updatedAt: timestamp },
        ],
        milestones: [
          { key: 'scope', title: '研究范围已确认', detail: '聚焦核心客群与三家主要竞品。', status: 'completed', occurredAt: '2026-08-15T09:05:00.000Z' },
          { key: 'interviews', title: '访谈材料已归档', detail: '已整理 12 份有效访谈记录。', status: 'completed', occurredAt: '2026-08-15T09:15:00.000Z' },
          { key: 'pricing', title: '定价信息已核对', detail: '价格口径与公开资料一致。', status: 'completed', occurredAt: '2026-08-15T09:22:00.000Z' },
          { key: 'comparison', title: '正在形成竞品结论', detail: '正在提炼差异化卖点。', status: 'running', occurredAt: timestamp },
        ],
      },
    },
    collab_ui_writer: {
      status: 'failed',
      progress: {
        phase: 'failed', message: '渠道素材依赖的最终产品截图尚未提供', completed: 1, total: 3, updatedAt: '2026-08-15T09:26:00.000Z',
        blocker: { summary: '缺少最终产品截图，暂时无法完成渠道素材。', suggestedNextStep: '补充产品截图后重新执行文案适配。' },
        milestones: [{ key: 'outline', title: '文案结构已完成', detail: '主标题、卖点与行动指引已形成。', status: 'completed', occurredAt: '2026-08-15T09:12:00.000Z' }],
      },
    },
    collab_ui_reviewer: {
      status: 'completed',
      progress: {
        phase: 'delivered', message: '风险复核已完成，共确认 6 项风险和对应负责人', completed: 4, total: 4, terminal: true, updatedAt: '2026-08-15T09:20:00.000Z',
        nodes: [{ id: 'review-1', title: '风险清单与回滚预案', status: 'completed', updatedAt: '2026-08-15T09:20:00.000Z' }],
        milestones: [{ key: 'risk-done', title: '风险复核已完成', detail: '6 项风险均已明确负责人和处理时限。', status: 'completed', occurredAt: '2026-08-15T09:20:00.000Z' }],
      },
    },
  };
  for (const [recipientId, fixture] of Object.entries(progressByRecipient)) {
    runtime.db.prepare('UPDATE agent_delegations SET status=?,metadata_json=?,updated_at=? WHERE id=?').run(
      fixture.status,
      JSON.stringify({ executionProgress: fixture.progress }),
      fixture.progress.updatedAt,
      tasks[recipientId].id,
    );
  }
  runtime.db.prepare('UPDATE agent_delegations SET requester_user_id=? WHERE id=?')
    .run('collab_ui_researcher', tasks.collab_ui_writer.id);
  const groupMessages = [
    ['collab_ui_message_1', '请各位按分工推进，关键风险及时同步。', '2026-08-15T09:00:00.000Z'],
    ['collab_ui_message_2', '市场研究已启动，先核对用户访谈和竞品价格。', '2026-08-15T09:08:00.000Z'],
    ['collab_ui_message_3', '风险复核已经完成，清单已放入共享工作区。', '2026-08-15T09:21:00.000Z'],
  ];
  for (const [id, content, createdAt] of groupMessages) {
    runtime.db.prepare(`INSERT INTO collaboration_group_messages
      (id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,created_at,updated_at)
      VALUES(?, 'workspace_personal', ?, ?, 'secretary_agent', 'agent', ?, '{}', ?, ?)`).run(
      id, groupId, owner.id, content, createdAt, createdAt,
    );
  }
  for (const [id, content, createdAt] of [
    ['collab_ui_human_message_1', '收到，我会继续跟进。', '2026-08-15T09:23:00.000Z'],
    ['collab_ui_human_message_2', '好的', '2026-08-15T09:24:00.000Z'],
  ]) {
    runtime.db.prepare(`INSERT INTO collaboration_group_messages
      (id,account_workspace_id,group_id,sender_user_id,sender_agent_id,kind,content,metadata_json,created_at,updated_at)
      VALUES(?, 'workspace_personal', ?, ?, '', 'message', ?, '{}', ?, ?)`).run(
      id, groupId, owner.id, content, createdAt, createdAt,
    );
  }
  await runtime.close();

  const env = {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    JANUS_HOME: runtimeRoot,
    JANUS_AUTH_URL: '',
    JANUS_CLOUD_AUTO_SYNC_ENABLED: '0',
    JANUS_MODEL_REFRESH_ENABLED: '0',
    JANUS_LOCAL_EVOLUTION_ENABLED: '0',
    JANUS_UPDATES_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(electronBinary, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${profileRoot}`, `--remote-debugging-port=${debugPort}`, '.'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const target = await waitForPageTarget(debugPort, 30_000);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelector('#login-form') || document.querySelector('[data-network-view="messages"]')`, 30_000);
  if (await evaluate(`Boolean(document.querySelector('#login-form'))`)) {
    await waitFor(`document.querySelector('#login-identifier') && document.querySelector('#login-password')`, 10_000);
    await evaluate(`(() => {
      document.querySelector('#login-identifier').value = ${JSON.stringify(account.email)};
      document.querySelector('#login-password').value = ${JSON.stringify(account.password)};
      document.querySelector('#login-form').requestSubmit();
    })()`);
  }
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);
  await evaluate(`localStorage.setItem('janus-language-mode', 'zh-CN'); window.janus.setUiLanguage('zh-CN')`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);
  await evaluate(`(() => {
    const appNavigation = document.querySelector('[data-app-nav="messages"]');
    if (appNavigation?.getClientRects().length) appNavigation.click();
    else document.querySelector('[data-network-view="messages"]')?.click();
  })()`);
  await waitFor(`document.querySelector('[data-collaboration-group="${groupId}"]')`, 20_000);
  await click(`[data-collaboration-group="${groupId}"]`);
  await waitFor(`document.querySelector('.collaboration-group-chat-view') && document.querySelector('[data-collaboration-details-toggle]')`, 30_000);
  assert.equal(await evaluate(`Boolean(document.querySelector('.collaboration-side-pane.is-open'))`), false,
    'Task details should be collapsed when the work group opens.');
  const collapsedProbe = await evaluate(`(() => {
    const visible = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight + 1;
    };
    return {
      detailsBarVisible: visible('.collaboration-details-bar'),
      composerVisible: visible('.collaboration-public-pane .composer'),
      documentOverflow: document.documentElement.scrollHeight > innerHeight + 1,
      shortHumanWidth: Math.round(document.querySelector('[data-message-id="collab_ui_human_message_2"] .message-shell')?.getBoundingClientRect().width || 0),
      shortHumanHeight: Math.round(document.querySelector('[data-message-id="collab_ui_human_message_2"] .message-shell')?.getBoundingClientRect().height || 0),
      firstHumanLeft: Math.round(document.querySelector('[data-message-id="collab_ui_human_message_1"]')?.getBoundingClientRect().left || 0),
      secondHumanLeft: Math.round(document.querySelector('[data-message-id="collab_ui_human_message_2"]')?.getBoundingClientRect().left || 0),
      humanNameFontSize: getComputedStyle(document.querySelector('[data-message-id="collab_ui_human_message_1"] .social-message-actor > span')).fontSize,
      humanBodyFontSize: getComputedStyle(document.querySelector('[data-message-id="collab_ui_human_message_2"] .message-body')).fontSize,
    };
  })()`);
  assert.equal(collapsedProbe.detailsBarVisible, true);
  assert.equal(collapsedProbe.composerVisible, true);
  assert.equal(collapsedProbe.documentOverflow, false);
  assert.ok(collapsedProbe.shortHumanWidth > 0 && collapsedProbe.shortHumanWidth < 180,
    `A short human message should fit its content, received width ${collapsedProbe.shortHumanWidth}.`);
  assert.ok(collapsedProbe.shortHumanHeight > 0 && collapsedProbe.shortHumanHeight < 60,
    `A short human message should not reserve a hidden action row, received height ${collapsedProbe.shortHumanHeight}.`);
  assert.ok(Math.abs(collapsedProbe.firstHumanLeft - collapsedProbe.secondHumanLeft) < 4,
    `All task-group human messages should stay on the same left timeline, received ${collapsedProbe.firstHumanLeft} and ${collapsedProbe.secondHumanLeft}.`);
  assert.equal(collapsedProbe.humanNameFontSize, '13px');
  assert.equal(collapsedProbe.humanBodyFontSize, '14px');
  await capture(collapsedScreenshot);
  await click('[data-collaboration-details-toggle]');
  await waitFor(`document.querySelector('.collaboration-side-pane.is-open') && document.querySelectorAll('.collaboration-progress-participant').length === 4`, 30_000);
  await evaluate(`document.querySelector('.collaboration-more-menu > summary')?.click()`);
  await waitFor(`document.querySelector('.collaboration-more-menu[open] [data-collaboration-group-close]')`, 10_000);

  const probe = await evaluate(`(() => {
    const pane = document.querySelector('.collaboration-side-pane');
    const cards = [...document.querySelectorAll('.collaboration-progress-participant')];
    const completed = document.querySelector('[data-ubuddy-owner-user-id="collab_ui_reviewer"]');
    return {
      cardCount: cards.length,
      ownerIds: cards.map((card) => card.dataset.ubuddyOwnerUserId),
      historyLabels: [...document.querySelectorAll('.collaboration-progress-history > summary')].map((item) => item.textContent.trim()),
      runningStop: Boolean(document.querySelector('[data-ubuddy-owner-user-id="collab_ui_researcher"] [data-collaboration-task-action="withdraw"]')),
      failedArchive: document.querySelector('[data-ubuddy-owner-user-id="collab_ui_writer"] [data-collaboration-task-action="withdraw"]')?.textContent.trim() || '',
      completedHasStop: Boolean(completed?.querySelector('[data-collaboration-task-action="withdraw"]')),
      waitingSummary: [...document.querySelectorAll('.collaboration-progress-summary b')].some((item) => item.textContent.trim() === '1 等待中'),
      closeAllVisible: Boolean(document.querySelector('.collaboration-more-menu[open] [data-collaboration-group-close]')?.getClientRects().length),
      horizontalOverflow: pane ? pane.scrollWidth > pane.clientWidth + 1 : true,
      sidePosition: pane ? getComputedStyle(pane).position : '',
      sideOpen: pane?.classList.contains('is-open') || false,
      timelineRule: getComputedStyle(document.querySelector('.collaboration-progress-timeline'), '::before').content,
      nextStepCount: [...document.querySelectorAll('.collaboration-progress-task footer strong')].filter((item) => item.textContent.trim() === '下一步').length,
      publicBorderRight: getComputedStyle(document.querySelector('.collaboration-public-pane')).borderRightWidth,
      messageFontSize: getComputedStyle(document.querySelector('.collaboration-group-chat-view .social-group-message .message-body')).fontSize,
      messageListPaddingLeft: getComputedStyle(document.querySelector('.collaboration-public-pane > .social-group-message-list')).paddingLeft,
    };
  })()`);
  assert.equal(probe.cardCount, 4, 'Each participant must render exactly one progress summary.');
  assert.equal(new Set(probe.ownerIds).size, 4, 'Progress summaries must not duplicate a uBuddy owner.');
  assert.ok(probe.historyLabels.some((label) => Number(label.match(/查看 (\d+) 条进展记录/)?.[1] || 0) >= 4),
    `Expected folded progress history, received: ${JSON.stringify(probe.historyLabels)}`);
  assert.equal(probe.runningStop, true);
  assert.equal(probe.failedArchive, '撤回并归档');
  assert.equal(probe.completedHasStop, false, 'Completed tasks must not expose a stop action.');
  assert.equal(probe.waitingSummary, true);
  assert.equal(probe.closeAllVisible, true);
  assert.equal(probe.horizontalOverflow, false);
  assert.equal(probe.sidePosition, 'absolute');
  assert.equal(probe.sideOpen, true);
  assert.equal(probe.timelineRule, 'none');
  assert.equal(probe.nextStepCount, 0);
  assert.equal(probe.publicBorderRight, '0px');
  assert.equal(probe.messageFontSize, '12px');
  assert.equal(probe.messageListPaddingLeft, '16px');
  await click('.collaboration-more-menu > summary');
  await waitFor(`!document.querySelector('.collaboration-more-menu[open]')`, 10_000);
  await capture(screenshot);
  assert.ok(existsSync(screenshot));

  await click('.collaboration-progress-pane [data-collaboration-details-close]');
  await waitFor(`!document.querySelector('.collaboration-side-pane.is-open')`, 10_000);
  await click('.collaboration-more-menu > summary');
  await waitFor(`document.querySelector('.collaboration-more-menu[open] [data-collaboration-group-close]')`, 10_000);
  await evaluate(`window.confirm = () => true`);
  await click('.collaboration-more-menu[open] [data-collaboration-group-close]');
  await waitFor(`document.querySelector('.social-group-ended')?.textContent.includes('工作群已解散')`, 30_000);
  assert.equal(await evaluate(`document.querySelector('#message-list')?.textContent.includes('请各位按分工推进')`), true,
    'Closing the group must keep pre-close messages visible.');
  await click('[data-message-home-back]');
  await waitFor(`document.querySelector('[data-collaboration-group="${groupId}"]')`, 20_000);
  await click(`[data-collaboration-group="${groupId}"]`);
  await waitFor(`document.querySelector('.social-group-ended')?.textContent.includes('工作群已解散')`, 30_000);
  const closedHistory = await evaluate(`({
    preserved: document.querySelector('#message-list')?.textContent.includes('请各位按分工推进') || false,
    closeEvent: document.querySelector('#message-list')?.textContent.includes('发起人已停止未完成任务并结束工作群') || false,
    composerAbsent: !document.querySelector('.collaboration-public-pane .composer'),
  })`);
  assert.deepEqual(closedHistory, { preserved: true, closeEvent: true, composerAbsent: true });
  console.log(JSON.stringify({ passed: true, screenshots: { collapsed: collapsedScreenshot, expanded: screenshot }, probe }, null, 2));
} catch (error) {
  throw new Error(`${error.message}\nElectron stderr:\n${stderr.slice(-8000)}`);
} finally {
  cdp?.close?.();
  if (child?.exitCode === null) {
    child.kill();
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2_000); });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
  if (!point || point.width <= 0 || point.height <= 0) throw new Error(`Unable to click selector: ${selector}`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function capture(filePath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function waitFor(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean(${expression})`)) return;
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
      const page = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for Electron renderer target.');
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result || {});
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
