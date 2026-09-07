import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDatabase } from '../../src/main/db.js';
import { Store } from '../../src/main/store.js';
import { FollowerService } from '../../src/main/modules/follower/application/FollowerService.js';

const { app, BrowserWindow, ipcMain } = globalThis.__janusElectron;
const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'janus-follower-start-ui-'));
const htmlPath = path.join(tempRoot, 'index.html');
const preloadPath = path.join(tempRoot, 'preload.cjs');
const styleUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'style.css')).href;
const viewUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'features', 'follower', 'followerView.js')).href;
const controllerUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'features', 'follower', 'followerController.js')).href;
const user = { id: 'follower_renderer_start_user' };
let db;
let service;
let win;
let releaseReportModel = null;
const feedbackPayloads = [];

fs.writeFileSync(preloadPath, `const { contextBridge, ipcRenderer } = require('electron');
const listeners = new Set();
ipcRenderer.on('follower:test-updated', (_event, payload) => { for (const listener of listeners) listener(payload); });
contextBridge.exposeInMainWorld('followerTestApi', {
  call: (method, payload = {}) => ipcRenderer.invoke('follower:test-call', method, payload),
  onUpdated: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
});`, 'utf8');

fs.writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="${styleUrl}"><style>html,body,#app,.shell{width:100%;height:100%;margin:0}.shell{display:block}</style></head><body><div id="app"></div><script type="module">
import { renderFollowerWorkspace } from '${viewUrl}';
import { createFollowerController } from '${controllerUrl}';
const bridge = window.followerTestApi;
const api = {
  followerOverview: (payload) => bridge.call('overview', payload), followerReportsList: (payload) => bridge.call('reports', payload),
  followerRunsList: (payload) => bridge.call('runs', payload),
  followerPreferencesUpdate: (payload) => bridge.call('preferences', payload), followerScheduleUpsert: (payload) => bridge.call('schedule', payload),
  followerRunNow: (payload) => bridge.call('run', payload), followerRunCancel: (payload) => bridge.call('cancel', payload),
  followerReportOpen: (payload) => bridge.call('report', payload), followerReportMarkRead: (payload) => bridge.call('markRead', payload),
  followerFollowupOpen: (payload) => bridge.call('followup', payload), followerFollowupSend: (payload) => bridge.call('followupSend', payload),
  followerFollowupCancel: (payload) => bridge.call('followupCancel', payload), onFollowerUpdated: (callback) => bridge.onUpdated(callback),
  followerFeedbackRecord: (payload) => bridge.call('feedback', payload),
};
const state = { languageMode: 'zh', responsiveLayoutMode: 'wide', followerWorkspaceOpen: true,
  currentUser: { id: 'follower_renderer_start_user' }, activeAccountWorkspace: { id: 'workspace_personal' },
  followerActiveSection: 'capability', followerSelectedKind: 'daily_brief', followerOverview: null,
  followerOverviewLoading: false, followerOverviewError: '', followerReports: [], followerRuns: [], followerSelectedReport: null, followerSelectedRun: null,
  followerSourceDrawer: null, followerFollowup: null, followerRailCollapsed: false,
  model: 'gpt-5.6-sol', modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] } };
let controller;
function render() { document.getElementById('app').innerHTML = '<div class="shell theme-dark">' + renderFollowerWorkspace(state) + '</div>'; controller?.wire(document); }
controller = createFollowerController({ api, state, render, notify: () => {}, userVisibleErrorMessage: (error, fallback) => error?.message || fallback });
window.followerTest = { state, controller, render, runNow: () => api.followerRunNow({ kind: 'daily_brief', clientRequestId: 'smoke_' + Date.now() }) };
await controller.refresh();
state.followerActiveSection = 'capability'; state.followerSelectedKind = 'daily_brief'; render();
</script></body></html>`, 'utf8');

try {
  db = openDatabase(tempRoot, { appVersion: '1.0.0' });
  const store = new Store(db, { root: tempRoot });
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: false } });
  service = new FollowerService({
    root: tempRoot, store, auth: { requireUser: () => user, currentUser: () => user },
    org: { agent: () => ({ id: 'follower_agent' }), readSkill: () => '# Follower' },
    contextBroker: { collect: () => ({ sources: [{ refId: 'task:completed:1', sourceKind: 'task_run', status: 'completed',
      title: 'Follower 启动链路验证', text: '已完成 Follower 启动、安排迁移和报告对话验证。', occurredAt: new Date().toISOString() }],
      coverage: [{ category: 'task_activity', itemCount: 1, truncated: false, warningCode: '' }] }), resolveSources: () => [] },
    executeModel: async (options) => {
      if (options.role === 'follower-followup') {
        await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'read_report', arguments: {} });
        return new Promise((resolve, reject) => {
          options.onTurnControlReady?.({
            threadId: 'renderer-followup-thread', turnId: `renderer-followup-turn-${options.executionContext.requestMessageId}`,
            steer: async ({ text }) => {
              resolve(`Follower 已按追加引导继续处理：${text}`);
              return { threadId: 'renderer-followup-thread', turnId: `renderer-followup-turn-${options.executionContext.requestMessageId}` };
            },
            interrupt: async () => {
              const error = new Error('Follower follow-up interrupted by the user.');
              error.code = 'codex_turn_interrupted';
              reject(error);
            },
          });
        });
      }
      store.beginModelExecution({ id: options.executionContext.id, userId: user.id, accountWorkspaceId: 'workspace_personal',
        agentId: 'follower_agent', executionKind: 'follower_report' });
      await options.onDynamicToolCall({ namespace: 'janus_follower', tool: 'list_activity', arguments: {} });
      options.onEvent?.({ kind: 'activity', activityId: 'tool-ui-1', activityType: 'tool', status: 'completed',
        title: '正在调用 Janus 工具', detail: 'janus_follower / list_activity',
        toolServer: 'janus_follower', toolName: 'list_activity' });
      options.onEvent?.({ kind: 'activity', activityId: 'reasoning-ui-1', activityType: 'reasoning', status: 'running',
        title: '思考摘要', detail: '正在分析已收集的任务与对话记录。',
        reasoningText: '先核对来源覆盖范围，再把事实、阻塞和建议分别整理。' });
      await new Promise((resolve) => { releaseReportModel = resolve; });
      options.onEvent?.({ kind: 'activity', activityId: 'reasoning-ui-1', activityType: 'reasoning', status: 'completed',
        title: '思考摘要', detail: '已完成任务与对话记录分析。' });
      const kind = /Report kind: ([^\n]+)/.exec(options.prompt)?.[1]?.trim() || 'daily_brief';
      const window = JSON.parse(/Window: (\{[^\n]+\})/.exec(options.prompt)?.[1] || '{}');
      return JSON.stringify({ schemaVersion: 'follower_report_v2', kind, window,
        coverage: [{ category: 'task_activity', itemCount: 1, truncated: false, warningCode: '' }],
        claims: [{ id: 'claim_1', status: 'completed', text: '已完成 Follower 启动、安排迁移和报告对话验证。', sourceRefs: ['task:completed:1'] }],
        suggestions: [], summary: '今日简报已生成，并确认启动后的完整工作流正常。' });
    },
    onChanged: (payload) => { if (!win?.isDestroyed()) win.webContents.send('follower:test-updated', payload); },
  });
  service.updateAccess({ disclosureConfirmed: true, grants: { task_activity: true } });
  const methods = {
    overview: (payload) => service.overview(payload), reports: (payload) => service.reports(payload), runs: (payload) => service.runs(payload),
    preferences: (payload) => service.updatePreferences(payload), schedule: (payload) => service.upsertSchedule(payload),
    run: (payload) => service.runNow(payload), cancel: (payload) => service.cancelRun(payload),
    report: (payload) => service.report(payload), markRead: (payload) => service.markReportRead(payload),
    followup: (payload) => service.openFollowup(payload), followupSend: (payload) => service.sendFollowup(payload),
    followupCancel: (payload) => service.cancelFollowup(payload),
    feedback: (payload) => { feedbackPayloads.push(payload); return { upload: { status: 'accepted' } }; },
  };
  ipcMain.handle('follower:test-call', (_event, method, payload) => methods[method](payload));
  await win.loadFile(htmlPath);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-follower-capability-save="daily_brief"]'))`));
  const alignment = await win.webContents.executeJavaScript(`(() => { const day = document.querySelector('.follower-day-picker span')?.getBoundingClientRect(); const time = document.querySelector('.follower-time-picker select')?.getBoundingClientRect(); return { dayTop: day?.top || 0, timeTop: time?.top || 0, dayHeight: day?.height || 0, timeHeight: time?.height || 0, topDelta: Math.abs((day?.top || 0) - (time?.top || 0)), heightDelta: Math.abs((day?.height || 0) - (time?.height || 0)) }; })()`);
  assert.ok(alignment.topDelta < 1, `Run-day and local-time controls are vertically misaligned by ${alignment.topDelta}px`);
  assert.ok(alignment.heightDelta < 1, `Run-day and local-time controls differ: ${JSON.stringify(alignment)}`);
  const capabilityDraft = await win.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('[data-follower-capability-prompt]');
    const hour = document.querySelector('[data-schedule-hour]');
    const minute = document.querySelector('[data-schedule-minute]');
    const day = document.querySelector('[data-schedule-day][value="6"]');
    prompt.value = '刷新后仍保留的能力草稿'; prompt.dispatchEvent(new Event('input', { bubbles: true }));
    hour.value = '07'; hour.dispatchEvent(new Event('change', { bubbles: true }));
    minute.value = '05'; minute.dispatchEvent(new Event('change', { bubbles: true }));
    day.checked = true; day.dispatchEvent(new Event('change', { bubbles: true }));
    window.followerTest.render();
    return { prompt: document.querySelector('[data-follower-capability-prompt]')?.value,
      hour: document.querySelector('[data-schedule-hour]')?.value, minute: document.querySelector('[data-schedule-minute]')?.value,
      day: document.querySelector('[data-schedule-day][value="6"]')?.checked };
  })()`);
  assert.deepEqual(capabilityDraft, { prompt: '刷新后仍保留的能力草稿', hour: '07', minute: '05', day: true });
  await win.webContents.executeJavaScript(`document.querySelector('[data-schedule-enabled]').click()`);
  await waitFor(() => Promise.resolve(service.overview({}).schedules.some((item) => item.kind === 'daily_brief' && item.enabled)));
  await win.webContents.executeJavaScript('window.followerTest.runNow()');
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(window.followerTest.state.followerOverview?.status?.activeRun)`));
  await win.webContents.executeJavaScript(`window.followerTest.state.followerActiveSection='reports'; window.followerTest.controller.refresh()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-follower-run-open]'))`));
  await win.webContents.executeJavaScript(`document.querySelector('[data-follower-run-open]').click()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-run-conversation .codex-transcript'))`));
  const runningProcess = await win.webContents.executeJavaScript(`(() => { const stages=[...document.querySelectorAll('.follower-run-stage')].map((item)=>item.getBoundingClientRect()); return { text: document.querySelector('.follower-run-conversation')?.textContent || '', cancel: Boolean(document.querySelector('[data-follower-run-cancel]')), stageCount: stages.length, stageTopSpread: stages.length ? Math.max(...stages.map((item)=>item.top))-Math.min(...stages.map((item)=>item.top)) : 999, hasAssistantMessage: Boolean(document.querySelector('.follower-process-message .follower-message-stack')), hasTranscript: Boolean(document.querySelector('.follower-process-message .codex-transcript')) }; })()`);
  assert.match(runningProcess.text, /同步并收集工作记录/);
  assert.match(runningProcess.text, /正在分析已收集的任务与对话记录/);
  assert.match(runningProcess.text, /先核对来源覆盖范围/);
  assert.match(runningProcess.text, /Janus Follower/);
  assert.doesNotMatch(runningProcess.text, /oplith/i);
  assert.equal(runningProcess.cancel, true);
  assert.equal(runningProcess.stageCount, 5);
  assert.ok(runningProcess.stageTopSpread < 1, `Follower stages are not horizontal: ${JSON.stringify(runningProcess)}`);
  assert.equal(runningProcess.hasAssistantMessage, true);
  assert.equal(runningProcess.hasTranscript, true);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-run-conversation .codex-transcript')) && /正在分析已收集的任务与对话记录/.test(document.querySelector('.follower-run-conversation')?.textContent || '')`));
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync('/tmp/janus-follower-running-process.png', (await win.capturePage()).toPNG());
  releaseReportModel?.();
  await waitFor(() => Promise.resolve(service.reports({ kind: 'daily_brief' }).length === 1));
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-report-document')) && !document.querySelector('.follower-run-conversation')`));
  const completedTransition = await win.webContents.executeJavaScript(`({
    selectedRun: window.followerTest.state.followerSelectedRun?.id || '',
    selectedReport: window.followerTest.state.followerSelectedReport?.id || '',
    body: document.querySelector('.follower-report-document')?.textContent || '',
  })`);
  assert.equal(completedTransition.selectedRun, '', 'completed Follower runs must leave the running-process view');
  assert.ok(completedTransition.selectedReport, 'completed Follower runs must open their generated report automatically');
  assert.match(completedTransition.body, /今日简报已生成/);
  await win.webContents.executeJavaScript(`window.followerTest.controller.removeUpdatedListener?.(); window.followerTest.state.followerSelectedReport=null; window.followerTest.state.followerFollowup=null; window.followerTest.state.followerActiveSection='overview'; window.followerTest.controller.refresh()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-scheduled-item[data-follower-capability="daily_brief"]')) && !document.querySelector('.follower-capability[data-follower-capability="daily_brief"]') && !document.querySelector('.follower-state-card')`));
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync('/tmp/janus-follower-start-scheduled.png', (await win.capturePage()).toPNG());
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-scheduled-item[data-follower-capability="daily_brief"]'))`));
  await win.webContents.executeJavaScript(`document.querySelector('.follower-scheduled-item[data-follower-capability="daily_brief"]').click()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-follower-capability-page="daily_brief"]'))`));
  await win.webContents.executeJavaScript(`document.querySelector('[data-schedule-enabled]').click()`);
  await waitFor(() => Promise.resolve(service.overview({}).schedules.some((item) => item.kind === 'daily_brief' && !item.enabled)));
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-capability[data-follower-capability="daily_brief"]')) && !document.querySelector('.follower-scheduled-item[data-follower-capability="daily_brief"]')`));
  await win.webContents.executeJavaScript(`document.querySelector('[data-follower-report-open]').click()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('.follower-report-document'))`));
  const followupDraft = await win.webContents.executeJavaScript(`(() => {
    let input = document.querySelector('[data-follower-followup-input]');
    input.value = '刷新后仍保留的追问草稿'; input.dispatchEvent(new Event('input', { bubbles: true }));
    window.followerTest.render();
    input = document.querySelector('[data-follower-followup-input]');
    const value = input?.value || '';
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    return value;
  })()`);
  assert.equal(followupDraft, '刷新后仍保留的追问草稿');
  const reportId = service.reports({ kind: 'daily_brief' })[0].id;
  await win.webContents.executeJavaScript(`document.querySelector('[data-follower-feedback="helpful"]').click()`);
  await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('[data-follower-feedback="helpful"]')?.classList.contains('is-selected')`));
  assert.deepEqual(feedbackPayloads, [{ reportId, rating: 'helpful', workspaceId: 'workspace_personal' }],
    'renderer feedback must submit only the trusted report identity, rating, and owning Workspace');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-follower-followup-input]'); input.value = '第一行'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true })); })()`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await service.openFollowup({ reportId })).messages.length, 0, 'Shift+Enter must not send the follow-up');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('[data-follower-followup-input]'); input.value = '你好'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-follower-followup-message]')) && /你好/.test(document.querySelector('.follower-message-timeline')?.textContent || '') && Boolean(document.querySelector('.follower-followup-pending'))`));
  const pendingFollowup = await win.webContents.executeJavaScript(`({
    inputDisabled: Boolean(document.querySelector('[data-follower-followup-input]')?.disabled),
    sendDisabled: Boolean(document.querySelector('.follower-send-button')?.disabled),
    actionMode: document.querySelector('[data-follower-followup-action]')?.dataset.mode || '',
    text: document.querySelector('.follower-message-timeline')?.textContent || '',
  })`);
  assert.equal(pendingFollowup.inputDisabled, false, 'follow-up input must remain available while Follower replies');
  assert.equal(pendingFollowup.sendDisabled, false, 'follow-up send button must remain available while Follower replies');
  assert.equal(pendingFollowup.actionMode, 'stop', 'empty composer must expose the square stop action while Follower replies');
  assert.match(pendingFollowup.text, /你好/);
  assert.match(pendingFollowup.text, /正在回复/);
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync('/path/to/ui-pictures/follower-followup-pending.png', (await win.capturePage()).toPNG());
  const guidanceMode = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-follower-followup-input]');
    input.value = '重点说明下一项检查';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('[data-follower-followup-action]')?.dataset.mode || '';
  })()`);
  assert.equal(guidanceMode, 'send', 'typing during a reply must change the stop action back to send');
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync('/path/to/ui-pictures/follower-followup-steer-ready.png', (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`document.querySelector('[data-follower-followup-input]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await waitFor(async () => (await service.openFollowup({ reportId })).messages.length === 3);
  await waitFor(() => win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-follower-followup-input]')) && !document.querySelector('[data-follower-followup-input]').disabled`));
  const guidedMessages = (await service.openFollowup({ reportId })).messages;
  assert.deepEqual(guidedMessages.map((message) => message.role), ['user', 'user', 'assistant']);
  assert.match(guidedMessages[2].content, /重点说明下一项检查/);

  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('[data-follower-followup-input]');
    input.value = '请开始另一轮回复';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
  })()`);
  await waitFor(() => win.webContents.executeJavaScript(`document.querySelector('[data-follower-followup-action]')?.dataset.mode === 'stop'`));
  await win.webContents.executeJavaScript(`document.querySelector('[data-follower-followup-action]').click()`);
  await waitFor(() => win.webContents.executeJavaScript(`window.followerTest.state.followerFollowupBusy === false`));
  const interruptedMessages = (await service.openFollowup({ reportId })).messages;
  assert.deepEqual(interruptedMessages.map((message) => message.role), ['user', 'user', 'assistant', 'user']);
  win.setSize(1100, 500);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const scrollBeforeRefresh = await win.webContents.executeJavaScript(`(() => {
    const timeline = document.querySelector('[data-follower-scroll-region^="report:"]');
    const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
    timeline.scrollTop = Math.min(120, maximum);
    return { top: timeline.scrollTop, maximum };
  })()`);
  assert.ok(scrollBeforeRefresh.maximum > 20, `Report detail must be scrollable for refresh validation: ${JSON.stringify(scrollBeforeRefresh)}`);
  await win.webContents.executeJavaScript('window.followerTest.controller.refresh()');
  const scrollAfterRefresh = await win.webContents.executeJavaScript(`document.querySelector('[data-follower-scroll-region^="report:"]').scrollTop`);
  assert.ok(Math.abs(scrollAfterRefresh - scrollBeforeRefresh.top) < 2,
    `Report refresh reset the detail scroll position: before=${scrollBeforeRefresh.top}, after=${scrollAfterRefresh}`);
  win.setSize(1100, 820);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync('/tmp/janus-follower-start-report.png', (await win.capturePage()).toPNG());
  const result = await win.webContents.executeJavaScript(`({ scheduled: Boolean(document.querySelector('.follower-scheduled-item')), available: Boolean(document.querySelector('.follower-capability[data-follower-capability="daily_brief"]')), report: document.querySelector('.follower-report-document')?.textContent || '', conversation: Boolean(document.querySelector('.follower-message-timeline')) })`);
  assert.equal(result.scheduled, false);
  assert.equal(result.available, true);
  assert.equal(result.conversation, true);
  assert.match(result.report, /今日简报已生成/);
  assert.match(result.report, /已完成 Follower 启动、安排迁移和报告对话验证/);
  assert.equal(service.reports({ kind: 'daily_brief' }).length, 1);
  await win.webContents.executeJavaScript(`(() => {
    const state = window.followerTest.state;
    state.followerSelectedReport = null;
    state.followerFollowup = null;
    state.followerActiveSection = 'reports';
    state.followerReportFilter = 'failed';
    state.followerRuns = [{ id: 'failed_ui_record', kind: 'weekly_review', status: 'failed',
      errorText: '{"error":{"message":"model is required","type":"invalid_request_error"}}',
      createdAt: '2026-08-12T08:30:00.000Z', processEvents: [] }];
    window.followerTest.render();
  })()`);
  const failedFilterUi = await win.webContents.executeJavaScript(`({
    recordCount: document.querySelectorAll('[data-follower-run-open]').length,
    hasEmptyState: /这个分类下还没有记录/.test(document.querySelector('.follower-report-list')?.textContent || ''),
  })`);
  assert.equal(failedFilterUi.recordCount, 1);
  assert.equal(failedFilterUi.hasEmptyState, false);
  await win.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync('/path/to/ui-pictures/follower-report-failed-filter.png', (await win.capturePage()).toPNG());
  await win.webContents.executeJavaScript('window.followerTest.controller.close()');
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.stdout.write('Follower start flow smoke passed: running process opened, schedule enabled, item moved, toggle disabled it immediately, item returned, and history report opened. Screenshots: /tmp/janus-follower-running-process.png, /tmp/janus-follower-start-scheduled.png, /tmp/janus-follower-start-report.png\n');
} finally {
  win?.destroy();
  service?.close();
  ipcMain.removeHandler('follower:test-call');
  try { db?.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for Follower start flow.');
}
