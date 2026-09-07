import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';
import { formatChatCardMessageTime } from '../src/renderer/app/utils/format.js';

const projectRoot = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-ubuddy-centers-ui-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const profileRoot = path.join(tempRoot, 'profile');
const workspaceRoot = path.join(tempRoot, 'workspace');
const screenshotRoot = path.join(projectRoot, 'test-artifacts', 'ubuddy-centers-ui');
const electronBinary = path.join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const debugPort = Number(process.env.JANUS_UBUDDY_CENTERS_UI_PORT || 9587);
const account = { email: 'ubuddy-centers-ui@example.com', password: 'uBuddy-Centers-UI-Password1!' };
const screenshots = {
  card: path.join(screenshotRoot, '01-delivery-card.png'),
  tasks: path.join(screenshotRoot, '02-all-tasks.png'),
  deliveries: path.join(screenshotRoot, '03-delivery-center.png'),
  accepted: path.join(screenshotRoot, '04-accepted-in-place.png'),
  mobile: path.join(screenshotRoot, '05-mobile-delivery-center.png'),
  dark: path.join(screenshotRoot, '06-dark-delivery-center.png'),
  failureDetails: path.join(screenshotRoot, '07-failure-details.png'),
  messageTime: path.join(screenshotRoot, '08-message-time.png'),
  composerMode: path.join(screenshotRoot, '09-composer-mode-menu.png'),
  publishProcess: path.join(screenshotRoot, '10-task-publish-process.png'),
  resultDark: path.join(screenshotRoot, '11-delivery-result-dark.png'),
};

let child = null;
let cdp = null;
let stderr = '';

mkdirSync(workspaceRoot, { recursive: true });
mkdirSync(screenshotRoot, { recursive: true });
Object.values(screenshots).forEach((file) => rmSync(file, { force: true }));

try {
  assert.ok(existsSync(electronBinary), `Electron binary not found: ${electronBinary}`);
  const runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true, requireExplicitAuthentication: true });
  runtime.authRegister({ email: account.email, password: account.password, displayName: '交付验收用户' });
  await runtime.authUpdateProfile({ displayName: '交付验收用户', username: 'delivery_reviewer' });
  const user = runtime.currentUser();
  const workspaceId = runtime.store.activeAccountWorkspace({ userId: user.id })?.id || 'workspace_personal';
  const session = runtime.ensureSecretarySession({ accountWorkspaceId: workspaceId });

  const reportFile = path.join(workspaceRoot, '2026-image-inspection-report.docx');
  const notesFile = path.join(workspaceRoot, 'report-notes.md');
  const comparisonFile = path.join(workspaceRoot, 'competitor-comparison.xlsx');
  writeFileSync(reportFile, 'DOCX fixture for uBuddy delivery center visual validation.\n');
  writeFileSync(notesFile, '# 交付说明\n\n视觉验收用交付说明。\n');
  writeFileSync(comparisonFile, 'XLSX fixture for completed task card file actions.\n');

  const pendingTask = runtime.store.createTaskRun({
    id: 'ui-center-delivery-task',
    ownerUserId: user.id,
    workspaceId,
    title: '2026年图像检测技术发展报告',
    prompt: '完成图像检测技术发展报告，并交付 Word 与 Markdown 文件。',
    initialStatus: 'completed',
    metadata: {
      source: 'ubuddy_dispatch',
      sourceSecretarySessionId: session.id,
      sourceSecretaryMessageId: 'ui-center-source-message',
    },
  });
  const submission = runtime.store.recordTaskDeliverySubmission({
    taskRunId: pendingTask.id,
    submissionKey: 'ui-center-delivery-v1',
    bodySnapshot: '报告已完成，共生成 2 个交付文件，等待你查看和验收。',
    artifactManifest: [
      { name: path.basename(reportFile), path: reportFile, snapshotPath: reportFile },
      { name: path.basename(notesFile), path: notesFile, snapshotPath: notesFile },
    ],
  });
  const deliveredAt = '2026-08-13T08:40:00.000Z';
  const deliverableResult = {
    title: pendingTask.title,
    summary: '报告已完成，共生成 2 个交付文件，等待你查看和验收。',
    body: '报告正文与说明均已完成。',
    files: [
      { name: path.basename(reportFile), path: reportFile, snapshotPath: reportFile },
      { name: path.basename(notesFile), path: notesFile, snapshotPath: notesFile },
    ],
    selectedSubmissionId: submission.id,
    selectedSubmissionNo: submission.submissionNo,
    resultState: 'delivered',
  };
  runtime.store.updateTaskRunMetadata(pendingTask.id, {
    source: 'ubuddy_dispatch',
    sourceSecretarySessionId: session.id,
    sourceSecretaryMessageId: 'ui-center-source-message',
    deliverableResult,
    resultState: 'delivered',
    executionState: 'completed',
    selectedDeliverySubmissionId: submission.id,
    selectedDeliverySubmissionNo: submission.submissionNo,
    finalDelivery: { state: 'delivered', deliveredAt, updatedAt: deliveredAt },
  });
  runtime.store.updateTaskRunStatus(pendingTask.id, 'completed', '报告已完成，等待最终验收。');
  runtime.store.addMessage({
    id: 'ui-center-source-message',
    sessionId: session.id,
    role: 'user',
    content: '请制作一份 2026 年图像检测技术发展报告。',
    agentId: 'secretary_agent',
    departmentId: 'secretary_department',
  });
  const publishProcessEvents = [
    ['intake', '确认任务信息', '已识别 1 项交付要求，并整理验收标准与执行约束。', 0, 700],
    ['readiness', '检查派发条件', '派发条件检查通过，没有未解决的关键问题。', 700, 1_200],
    ['planning', '规划任务与选择 Agent', '已规划 2 个执行节点，由通用 Agent 承担。', 1_200, 2_300],
    ['dispatching', '创建任务并安排执行', '任务图已创建并保存，通用 Agent 已接管执行。', 2_300, 3_200],
  ].map(([stage, title, detail, startedOffset, completedOffset], summaryIndex) => ({
    kind: 'activity', activityId: `ubuddy-task-publish:${stage}`, activityType: 'status', eventOrigin: 'janus',
    status: 'completed', title, detail, startedAtMs: 1_786_704_000_000 + startedOffset,
    completedAtMs: 1_786_704_000_000 + completedOffset, durationMs: completedOffset - startedOffset, summaryIndex,
  }));
  runtime.store.addMessage({
    id: 'ui-center-terminal-message',
    sessionId: session.id,
    taskRunId: pendingTask.id,
    role: 'assistant',
    content: '任务已交付：2026年图像检测技术发展报告',
    agentId: 'secretary_agent',
    departmentId: 'secretary_department',
    metadata: {
      secretaryControl: true,
      terminal: true,
      uBuddyFinalDeliveryMessage: true,
      uBuddyTaskTerminalTaskRunId: pendingTask.id,
      taskRunId: pendingTask.id,
      sourceSecretarySessionId: session.id,
      deliverableResult,
      resultState: 'delivered',
      uBuddyTaskPublishProcess: {
        version: 'ubuddy_task_publish_process_v1', status: 'completed',
        startedAt: '2026-08-14T08:00:00.000Z', completedAt: '2026-08-14T08:00:03.200Z',
        durationMs: 3_200, events: publishProcessEvents,
      },
      processEvents: publishProcessEvents,
      processDurationMs: 3_200,
      expanded: false,
    },
  });
  runtime.db.prepare('UPDATE messages SET created_at=?, updated_at=? WHERE session_id=? AND content=?').run(
    '2026-08-13T08:00:00.000Z', '2026-08-13T08:00:00.000Z', session.id,
    '请制作一份 2026 年图像检测技术发展报告。',
  );
  runtime.db.prepare('UPDATE messages SET created_at=?, updated_at=? WHERE session_id=? AND content=?').run(
    '2026-08-13T08:03:01.000Z', '2026-08-13T08:03:01.000Z', session.id,
    '任务已交付：2026年图像检测技术发展报告',
  );

  const taskFixtures = [
    ['ui-center-active-task', '梳理产品发布计划与风险', 'running', '正在整合里程碑、负责人和风险清单。'],
    ['ui-center-waiting-task', '整理客户访谈结论', 'waiting', '等待联系人补充最后一轮访谈记录。'],
    ['ui-center-closed-task', '竞品能力对比表', 'completed', '已完成主要竞品的能力与定价对比。'],
  ];
  for (const [id, title, status, summary] of taskFixtures) {
    const task = runtime.store.createTaskRun({
      id, ownerUserId: user.id, workspaceId, title, prompt: summary, initialStatus: status,
      metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id },
    });
    if (id === 'ui-center-closed-task') runtime.store.updateTaskRunMetadata(task.id, {
      source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id,
      generatedTaskFiles: [{ name: path.basename(comparisonFile), path: comparisonFile, size: 48 }],
    });
    runtime.store.updateTaskRunStatus(task.id, status, summary);
  }
  const failedTask = runtime.store.createTaskRun({
    id: 'ui-center-failed-task', ownerUserId: user.id, workspaceId,
    title: '行业分析报告', prompt: '生成行业分析报告并导出文件。', initialStatus: 'running',
    metadata: { source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id },
  });
  const failedNode = runtime.store.createTaskNode({
    taskRunId: failedTask.id, title: '生成报告文件', objective: '调用模型并导出报告。',
    status: 'running', deferAgentInstanceBinding: true,
  });
  for (let index = 0; index < 24; index += 1) {
    runtime.store.recordTaskEvent({
      eventId: `ui-center-failed-progress-${index}`,
      taskRunId: failedTask.id,
      taskNodeId: failedNode.id,
      eventType: 'node_progress',
      actorId: 'general_agent',
      status: 'completed',
      summary: `行业资料整理进度 ${index + 1}`,
      payload: { activityId: `failed-progress-${index}`, activityType: 'reasoning' },
    });
  }
  runtime.store.updateTaskNode(failedNode.id, {
    status: 'failed', errorText: '模型服务连续超时，未能生成报告文件。',
    lastErrorCode: 'model_unavailable', completedAt: '2026-08-13T09:10:00.000Z',
  });
  runtime.store.updateTaskRunMetadata(failedTask.id, {
    source: 'ubuddy_dispatch', sourceSecretarySessionId: session.id,
    failureReport: {
      nodeId: failedNode.id,
      summary: '模型服务连续超时，未能生成报告文件。',
      cause: '上游模型服务未在限定时间内返回结果。',
      suggestedNextStep: '检查网络或模型服务状态后重新执行。',
    },
  });
  runtime.store.updateTaskRunStatus(failedTask.id, 'failed', '行业分析报告未能完成。');
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
  await setViewport(1440, 900);
  await waitFor(`document.querySelector('#login-form') || document.querySelector('.account-avatar')`, 30_000);
  if (await evaluate(`Boolean(document.querySelector('#login-form'))`)) {
    await evaluate(`(() => {
      document.querySelector('#login-identifier').value = ${JSON.stringify(account.email)};
      document.querySelector('#login-password').value = ${JSON.stringify(account.password)};
      document.querySelector('#login-form').requestSubmit();
    })()`);
  }
  await waitFor(`document.querySelector('.account-avatar') && !document.querySelector('#login-form')`, 30_000);
  await evaluate(`localStorage.setItem('janus-language-mode', 'zh-CN'); window.janus.setUiLanguage('zh-CN')`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await waitFor(`document.querySelector('[data-network-view="messages"]')`, 30_000);
  await click('[data-network-view="messages"]');
  await click('[data-network-peer="self-secretary"]');
  await waitFor(`document.querySelector('.ubuddy-chat-delivery-card.is-pending') && Array.from(document.querySelectorAll('.codex-process-disclosure > summary span')).some((item) => item.textContent === '任务已发布') && document.querySelector('[data-ubuddy-center-open="tasks"]')`, 30_000);
  await evaluate(`Array.from(document.querySelectorAll('.codex-process-disclosure')).find((item) => item.textContent.includes('任务已发布'))?.scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const cardProbe = await layoutProbe();
  assert.equal(cardProbe.horizontalOverflow, false, 'Desktop chat has horizontal overflow.');
  assert.equal(cardProbe.cardVisible, true);
  assert.equal(cardProbe.oldTaskStripVisible, false);
  assert.equal(cardProbe.deliveryCardCount, 3, 'Terminal uBuddy results should share the delivery-card template.');
  assert.equal(cardProbe.resultCardCount, 2);
  assert.equal(cardProbe.failedCardCount, 1);
  assert.equal(cardProbe.failureActionVisible, true);
  assert.equal(cardProbe.durationBadgeCount, 3);
  assert.equal(cardProbe.legacyCardTypeLabelCount, 0, 'Terminal cards should not retain task-delivery/task-result type labels.');
  assert.equal(cardProbe.cardTitleIsFirstRow, true, 'The task title and status should form the card first row.');
  assert.equal(cardProbe.cardMessageTimeCount, 2,
    `Only cards more than two minutes after the previous message should show a timestamp. ${JSON.stringify(cardProbe.cardMessageTimes)}`);
  assert.equal(cardProbe.pendingDeliveryMessageTimeCount, 1,
    'The pending delivery card should have one centered timestamp.');
  assert.equal(cardProbe.pendingDeliveryLegacyTimeCount, 0,
    'The delivery card should not retain the legacy hover timestamp.');
  assert.equal(cardProbe.modeTriggerRightOfPlus, true, 'The Task/Ask picker should sit immediately to the right of the plus button.');
  assert.equal(cardProbe.standaloneTaskReferenceVisible, false, 'The standalone task-reference button should be removed.');
  assert.equal(cardProbe.completedFileVisible, true);
  assert.equal(cardProbe.completedFileOpenAction, true);
  assert.equal(cardProbe.completedFileDownloadAction, true);
  assert.equal(cardProbe.completedFileIconVisible, true);
  assert.equal(cardProbe.cardWidthsAligned, true,
    `Delivery and task-result cards should have the same rendered width (${cardProbe.deliveryCardWidth}px vs ${cardProbe.resultCardWidth}px).`);
  assert.equal(cardProbe.legacyProgressCardCount, 0);
  assert.equal(cardProbe.publishProcessCount, 1);
  assert.equal(cardProbe.publishProcessCollapsed, true);
  assert.equal(cardProbe.publishProcessAboveTaskCard, true);
  assert.equal(cardProbe.publishProcessAvatarCount, 1);
  assert.equal(cardProbe.publishProcessSharesMessageWithCard, true);
  assert.equal(cardProbe.removedWelcomeVisible, false);
  await capture(screenshots.card);
  await evaluate(`Array.from(document.querySelectorAll('.codex-process-disclosure')).find((item) => item.textContent.includes('任务已发布'))?.scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await click('.codex-process-disclosure > summary');
  await waitFor(`document.querySelector('.codex-process-disclosure[open]')`);
  const expandedPublishProcessProbe = await evaluate(`(() => {
    const details = document.querySelector('.codex-process-disclosure[open]');
    const text = details?.textContent || '';
    return {
      stageCount: details?.querySelectorAll('.codex-system-status').length || 0,
      hasAllStages: ['确认任务信息', '检查派发条件', '规划任务与选择 Agent', '创建任务并安排执行']
        .every((label) => text.includes(label)),
      leaksPrivateData: /reasoningText|rawAnswer|workspaceRoot/.test(text),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  })()`);
  assert.equal(expandedPublishProcessProbe.stageCount, 4);
  assert.equal(expandedPublishProcessProbe.hasAllStages, true);
  assert.equal(expandedPublishProcessProbe.leaksPrivateData, false);
  assert.equal(expandedPublishProcessProbe.horizontalOverflow, false);
  await capture(screenshots.publishProcess);
  await click('.codex-process-disclosure > summary');
  await evaluate(`document.querySelector('.ubuddy-chat-delivery-card.is-pending')?.scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await evaluate(`document.querySelector('.ubuddy-chat-card-message-time')?.textContent || ''`),
    formatChatCardMessageTime('2026-08-13T08:03:01.000Z'));
  await capture(screenshots.messageTime);
  await click('[data-ubuddy-message-mode-toggle]');
  await waitFor(`document.querySelector('.ubuddy-message-mode-menu')`);
  assert.equal(await evaluate(`document.querySelector('.ubuddy-message-mode-menu')?.getBoundingClientRect().bottom <= document.querySelector('[data-ubuddy-message-mode-toggle]')?.getBoundingClientRect().top`), true,
    'The Task/Ask menu should open above its trigger.');
  await capture(screenshots.composerMode);
  await click('[data-ubuddy-message-mode="ask"]');
  await waitFor(`document.querySelector('[data-ubuddy-message-mode-toggle] span')?.textContent === '讨论'`);
  assert.equal(await evaluate(`document.querySelector('#chat-input')?.getAttribute('placeholder') || ''`), '和 uBuddy 讨论');
  await click('[data-ubuddy-message-mode-toggle]');
  await click('[data-ubuddy-message-mode="task"]');
  await click('[data-composer-tool-menu-toggle]');
  await waitFor(`Array.from(document.querySelectorAll('.composer-tool-option strong')).some((item) => item.textContent === '关联任务')`);
  await click('[data-task-reference-toggle]');
  await waitFor(`document.querySelector('.task-reference-menu')`);
  await click('#chat-input');

  await click('[data-task-progress-run="ui-center-failed-task"] [data-task-card-action="open_workspace"]');
  await waitFor(`document.querySelector('[data-task-run-workspace="ui-center-failed-task"] .local-task-failure-diagnostics')`, 20_000);
  const failureProbe = await evaluate(`(() => ({
    activitySelected: document.querySelector('[data-task-workspace-view="activity"]')?.getAttribute('aria-pressed') === 'true',
    diagnosticText: document.querySelector('.local-task-failure-diagnostics')?.textContent || '',
  }))()`);
  assert.equal(failureProbe.activitySelected, true);
  assert.match(failureProbe.diagnosticText, /模型服务连续超时/);
  assert.match(failureProbe.diagnosticText, /失败节点：生成报告文件/);
  await click('[data-collab-event-history]');
  await waitFor(`document.querySelector('.local-task-workspace-body')?.scrollHeight > document.querySelector('.local-task-workspace-body')?.clientHeight + 200`);
  const workspaceScrollBefore = await evaluate(`(() => {
    const body = document.querySelector('.local-task-workspace-body');
    const max = body.scrollHeight - body.clientHeight;
    body.scrollTop = Math.min(240, Math.floor(max / 2));
    return { top: body.scrollTop, max };
  })()`);
  await click('#theme-toggle-btn');
  await waitFor(`document.querySelector('.shell.theme-dark')`);
  await click('#theme-toggle-btn');
  await waitFor(`document.querySelector('.shell.theme-light')`);
  const workspaceScrollAfter = await evaluate(`(() => {
    const body = document.querySelector('.local-task-workspace-body');
    return { top: body.scrollTop, max: body.scrollHeight - body.clientHeight };
  })()`);
  assert.ok(Math.abs(workspaceScrollAfter.top - workspaceScrollBefore.top) <= 2,
    `Task workspace rerenders must preserve the active scroll position: ${JSON.stringify({ workspaceScrollBefore, workspaceScrollAfter })}`);
  assert.ok(workspaceScrollAfter.top < workspaceScrollAfter.max - 48,
    `Task workspace rerenders must not force the viewport to the bottom: ${JSON.stringify({ workspaceScrollBefore, workspaceScrollAfter })}`);
  await capture(screenshots.failureDetails);
  await click('.local-task-workspace-back');
  await waitFor(`document.querySelector('.ubuddy-chat-delivery-card.is-pending') && document.querySelector('[data-task-progress-run="ui-center-failed-task"]')`, 20_000);

  await click('[data-ubuddy-center-open="tasks"]');
  await waitFor(`document.querySelector('[data-ubuddy-center-layer] .ubuddy-center-drawer') && document.querySelectorAll('.ubuddy-center-row').length >= 4`, 20_000);
  const taskProbe = await layoutProbe();
  assert.equal(taskProbe.drawerWithinStage, true);
  assert.equal(taskProbe.drawerOverflow, false);
  assert.equal(taskProbe.filterOverflow, false);
  await evaluate(`document.querySelector('[data-ubuddy-task-center-search]')?.focus()`);
  await evaluate(`(() => {
    const input = document.querySelector('[data-ubuddy-task-center-search]');
    input.value = '图像检测';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelectorAll('.ubuddy-center-row').length === 1 && document.querySelector('.ubuddy-center-row')?.textContent.includes('图像检测')`, 20_000);
  assert.equal(await evaluate(`document.activeElement === document.querySelector('[data-ubuddy-task-center-search]')`), true,
    'Task search should retain focus after its asynchronous result renders.');
  await evaluate(`(() => {
    const input = document.querySelector('[data-ubuddy-task-center-search]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelectorAll('.ubuddy-center-row').length >= 4`, 20_000);
  const stopButtonProbe = await evaluate(`(() => ({
    active: document.querySelector('[data-task-workspace-id="ui-center-active-task"][data-task-card-action="cancel_task"]')?.textContent.trim() || '',
    waiting: document.querySelector('[data-task-workspace-id="ui-center-waiting-task"][data-task-card-action="cancel_task"]')?.textContent.trim() || '',
    completed: Boolean(document.querySelector('[data-task-workspace-id="ui-center-closed-task"][data-task-card-action="cancel_task"]')),
    failed: Boolean(document.querySelector('[data-task-workspace-id="ui-center-failed-task"][data-task-card-action="cancel_task"]')),
  }))()`);
  assert.deepEqual(stopButtonProbe, { active: '结束任务', waiting: '结束任务', completed: false, failed: false });
  await capture(screenshots.tasks);

  await click('[data-ubuddy-center-open="deliveries"]');
  await waitFor(`document.querySelector('[data-ubuddy-center-layer] .ubuddy-center-drawer') && document.querySelector('.ubuddy-delivery-row.is-pending')`, 20_000);
  const deliveryProbe = await layoutProbe();
  assert.equal(deliveryProbe.drawerWithinStage, true);
  assert.equal(deliveryProbe.drawerOverflow, false);
  await capture(screenshots.deliveries);

  await click('.ubuddy-center-drawer [data-ubuddy-center-close]');
  await click('[data-ubuddy-quick-accept="ui-center-delivery-task"]');
  await waitFor(`document.querySelector('.ubuddy-chat-delivery-card.is-accepted') && !document.querySelector('[data-ubuddy-quick-accept]')`, 30_000);
  const acceptedProbe = await evaluate(`window.janus.listMessages(${JSON.stringify(session.id)}).then((messages) => ({
    cards: document.querySelectorAll('.ubuddy-chat-delivery-card').length,
    accepted: document.querySelector('.ubuddy-chat-delivery-card.is-accepted')?.textContent || '',
    terminalMessages: messages.filter((message) => message.metadata?.uBuddyTaskTerminalTaskRunId === 'ui-center-delivery-task').length,
    pendingBadge: document.querySelector('[data-ubuddy-center-open="deliveries"] b')?.textContent || '',
  }))`);
  assert.equal(acceptedProbe.cards, 3, 'Acceptance must update the original delivery card without creating another card.');
  assert.equal(acceptedProbe.terminalMessages, 1, 'Acceptance created a second terminal message.');
  assert.match(acceptedProbe.accepted, /已验收|Accepted/);
  assert.match(acceptedProbe.accepted, /2026年图像检测技术发展报告/);
  assert.equal(acceptedProbe.pendingBadge, '');
  await capture(screenshots.accepted);

  await setViewport(480, 760);
  await click('[data-ubuddy-center-open="deliveries"]');
  await waitFor(`document.querySelector('[data-ubuddy-center-layer] .ubuddy-center-drawer')`, 20_000);
  const mobileProbe = await layoutProbe();
  assert.equal(mobileProbe.horizontalOverflow, false, 'Narrow layout has horizontal overflow.');
  assert.equal(mobileProbe.drawerWithinStage, true);
  assert.equal(mobileProbe.drawerOverflow, false);
  assert.equal(mobileProbe.topbarOverlap, false);
  assert.equal(mobileProbe.iconOnlyTriggers, true);
  const mobileLabels = await evaluate(`Array.from(document.querySelectorAll('.ubuddy-center-trigger')).map((item) => item.getAttribute('aria-label'))`);
  assert.equal(mobileLabels.every(Boolean), true, 'Icon-only center buttons need accessible names.');
  await capture(screenshots.mobile);

  await click('.ubuddy-center-drawer [data-ubuddy-center-close]');
  await setViewport(1440, 900);
  await click('#theme-toggle-btn');
  await waitFor(`document.querySelector('.shell.theme-dark, .app-frame.theme-dark')`, 10_000);
  await click('[data-ubuddy-center-open="deliveries"]');
  await waitFor(`document.querySelector('[data-ubuddy-center-layer] .ubuddy-center-drawer')`, 20_000);
  const darkProbe = await layoutProbe();
  assert.equal(darkProbe.horizontalOverflow, false);
  assert.equal(darkProbe.drawerWithinStage, true);
  assert.equal(darkProbe.drawerOverflow, false);
  await capture(screenshots.dark);

  await click('[data-ubuddy-center-filter="accepted"]');
  await waitFor(`document.querySelector('.ubuddy-delivery-row.is-accepted [data-delivery-submission-id="${submission.id}"]')`, 20_000);
  await click(`.ubuddy-delivery-row.is-accepted [data-delivery-submission-id="${submission.id}"]`);
  await waitFor(`document.querySelector('.network-task-result-view') && document.querySelector('[data-delivery-submission-id="${submission.id}"]')`, 20_000);
  const historyProbe = await evaluate(`(() => ({
    resultView: Boolean(document.querySelector('.network-task-result-view')),
    genericTopbarAbsent: !document.querySelector('.topbar'),
    workspaceHeading: document.querySelector('.local-task-workspace-heading h2')?.textContent || '',
    statusShadow: getComputedStyle(document.querySelector('.final-delivery-status')).boxShadow,
    statusBackground: getComputedStyle(document.querySelector('.final-delivery-status')).backgroundColor,
    sendButton: (() => {
      const button = document.querySelector('.local-task-workspace-composer .send-btn');
      const rect = button?.getBoundingClientRect();
      return button ? { width: rect.width, height: rect.height, radius: getComputedStyle(button).borderRadius, label: button.getAttribute('aria-label'), text: button.textContent.trim() } : null;
    })(),
    selectedVersion: document.querySelector('.network-task-selected-delivery-version')?.textContent || '',
    deliveryText: document.querySelector('.network-task-result-view .final-deliverable-card')?.textContent || '',
  }))()`);
  assert.equal(historyProbe.resultView, true);
  assert.equal(historyProbe.genericTopbarAbsent, true);
  assert.match(historyProbe.workspaceHeading, /查看交付/);
  assert.equal(historyProbe.statusShadow, 'none');
  assert.notEqual(historyProbe.statusBackground, 'rgba(0, 0, 0, 0)');
  assert.deepEqual(historyProbe.sendButton, { width: 34, height: 34, radius: '50%', label: '发送', text: '' });
  assert.match(historyProbe.selectedVersion, /正在查看版本 1/);
  assert.match(historyProbe.selectedVersion, /当前交付版本/);
  assert.match(historyProbe.deliveryText, /2026年图像检测技术发展报告/);
  assert.match(historyProbe.deliveryText, /report-notes\.md/);
  await capture(screenshots.resultDark);

  await click('.local-task-workspace-back');
  await waitFor(`document.querySelector('[data-ubuddy-center-open="tasks"]')`, 20_000);
  await click('[data-ubuddy-center-open="tasks"]');
  await waitFor(`document.querySelector('[data-task-workspace-id="ui-center-active-task"][data-task-card-action="cancel_task"]')`, 20_000);
  await evaluate(`window.confirm = () => true`);
  await click('[data-task-workspace-id="ui-center-active-task"][data-task-card-action="cancel_task"]');
  await waitFor(`document.querySelector('[data-ubuddy-center-layer]') && !document.querySelector('[data-task-workspace-id="ui-center-active-task"][data-task-card-action="cancel_task"]')`, 20_000);
  assert.equal(await evaluate(`window.janus.getTask('ui-center-active-task').then((task) => task.status)`), 'cancelled');

  console.log(JSON.stringify({
    passed: true,
    screenshots,
    probes: { card: cardProbe, tasks: taskProbe, deliveries: deliveryProbe, accepted: acceptedProbe, mobile: mobileProbe, dark: darkProbe, history: historyProbe },
  }, null, 2));
} catch (error) {
  let renderer = null;
  try {
    renderer = cdp ? await evaluate(`({
      href: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 2400),
      html: (document.body?.innerHTML || '').slice(0, 1200),
    })`) : null;
  } catch {}
  throw new Error(`${error.message}\nRenderer:\n${JSON.stringify(renderer)}\nElectron stderr:\n${stderr.slice(-8000)}`);
} finally {
  cdp?.close?.();
  if (child?.exitCode === null) {
    child.kill();
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 2_000); });
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

async function setViewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function layoutProbe() {
  return evaluate(`(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect() || null;
    const stage = rect('.conversation-content-stage');
    const drawer = rect('.ubuddy-center-drawer');
    const actions = rect('.chat-utility-actions');
    const identity = rect('.chat-utility-conversation');
    const deliveryCard = rect('.ubuddy-chat-delivery-card:not(.ubuddy-chat-task-result-card)');
    const resultCard = rect('.ubuddy-chat-task-result-card');
    const filters = document.querySelector('.ubuddy-center-controls nav, .ubuddy-delivery-center-filters');
    const pendingCard = document.querySelector('.ubuddy-chat-delivery-card.is-pending');
    const modeTrigger = document.querySelector('[data-ubuddy-message-mode-toggle]');
    const plusTrigger = document.querySelector('[data-composer-tool-menu-toggle]');
    const publishDisclosure = Array.from(document.querySelectorAll('.codex-process-disclosure'))
      .find((item) => item.textContent.includes('任务已发布'));
    const publishProcess = publishDisclosure?.closest('.message');
    const publishedTaskCard = publishProcess?.querySelector('.ubuddy-chat-delivery-card');
    const visible = (selector) => {
      const item = document.querySelector(selector); if (!item) return false;
      const box = item.getBoundingClientRect(); const style = getComputedStyle(item);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      cardVisible: visible('.ubuddy-chat-delivery-card'),
      deliveryCardCount: document.querySelectorAll('.ubuddy-chat-delivery-card').length,
      resultCardCount: document.querySelectorAll('.ubuddy-chat-task-result-card').length,
      failedCardCount: document.querySelectorAll('.ubuddy-chat-task-result-card.is-failed').length,
      failureActionVisible: Boolean(document.querySelector('.ubuddy-chat-task-result-card.is-failed [data-task-card-action="open_workspace"]')),
      durationBadgeCount: document.querySelectorAll('.ubuddy-chat-task-duration').length,
      legacyCardTypeLabelCount: document.querySelectorAll('.ubuddy-chat-delivery-card > header').length,
      cardTitleIsFirstRow: Array.from(document.querySelectorAll('.ubuddy-chat-delivery-card')).every((card) => (
        card.firstElementChild?.classList.contains('ubuddy-chat-delivery-title')
        && Boolean(card.firstElementChild.querySelector(':scope > strong'))
        && Boolean(card.firstElementChild.querySelector('.ubuddy-chat-delivery-title-meta > em'))
      )),
      cardMessageTimeCount: document.querySelectorAll('.ubuddy-chat-card-message-time').length,
      cardMessageTimes: Array.from(document.querySelectorAll('.ubuddy-chat-card-message-time')).map((item) => ({
        text: item.textContent || '',
        html: item.outerHTML,
        parentClass: item.parentElement?.className || '',
        messageId: item.closest('[data-message-id]')?.getAttribute('data-message-id') || '',
      })),
      pendingDeliveryMessageTimeCount: document.querySelector('.ubuddy-chat-delivery-card.is-pending')
        ?.parentElement?.querySelectorAll(':scope > .ubuddy-chat-card-message-time').length || 0,
      pendingDeliveryLegacyTimeCount: document.querySelector('.ubuddy-chat-delivery-card.is-pending')
        ?.closest('.message-shell')?.querySelectorAll(':scope > .message-head .message-time').length || 0,
      modeTriggerRightOfPlus: !modeTrigger || !plusTrigger
        ? false : modeTrigger.getBoundingClientRect().left >= plusTrigger.getBoundingClientRect().right - 1,
      standaloneTaskReferenceVisible: visible('.task-reference-trigger'),
      completedFileVisible: Boolean(Array.from(document.querySelectorAll('.ubuddy-chat-task-files strong')).find((item) => item.textContent.includes('competitor-comparison.xlsx'))),
      completedFileOpenAction: Boolean(document.querySelector('.ubuddy-chat-task-files [data-open-file]')),
      completedFileDownloadAction: Boolean(document.querySelector('.ubuddy-chat-task-files [data-save-file]')),
      completedFileIconVisible: Boolean(document.querySelector('.ubuddy-chat-task-file-icon.is-excel')),
      deliveryCardWidth: deliveryCard?.width || 0,
      resultCardWidth: resultCard?.width || 0,
      cardWidthsAligned: !deliveryCard || !resultCard || Math.abs(deliveryCard.width - resultCard.width) <= 1,
      legacyProgressCardCount: document.querySelectorAll('.collaboration-run-card').length,
      publishProcessCount: Array.from(document.querySelectorAll('.codex-process-disclosure > summary span'))
        .filter((item) => item.textContent === '任务已发布').length,
      publishProcessCollapsed: Boolean(publishDisclosure && !publishDisclosure.open),
      publishProcessAboveTaskCard: Boolean(publishProcess && publishedTaskCard
        && publishProcess.getBoundingClientRect().top < publishedTaskCard.getBoundingClientRect().top),
      publishProcessAvatarCount: publishProcess?.querySelectorAll(':scope > .chat-message-avatar').length || 0,
      publishProcessSharesMessageWithCard: Boolean(publishProcess && publishedTaskCard),
      removedWelcomeVisible: (document.body?.innerText || '').includes('我是 uBuddy。你可以直接告诉我目标、交付物和截止要求'),
      oldTaskStripVisible: visible('.ubuddy-task-strip-host') || visible('.ubuddy-task-strip'),
      drawerWithinStage: !drawer || !stage || (drawer.left >= stage.left - 1 && drawer.right <= stage.right + 1 && drawer.top >= stage.top - 1 && drawer.bottom <= stage.bottom + 1),
      drawerOverflow: Boolean(drawer && (drawer.left < -1 || drawer.right > innerWidth + 1 || drawer.top < -1 || drawer.bottom > innerHeight + 1)),
      filterOverflow: Boolean(filters && filters.scrollWidth > filters.clientWidth + 1),
      topbarOverlap: Boolean(actions && identity && actions.left < identity.right - 1),
      iconOnlyTriggers: innerWidth > 720 || Array.from(document.querySelectorAll('.ubuddy-center-trigger > span')).every((item) => getComputedStyle(item).display === 'none'),
    };
  })()`);
}

async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height };
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed.');
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
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result || {});
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
