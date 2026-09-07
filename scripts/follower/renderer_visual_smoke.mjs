import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { app, BrowserWindow } = globalThis.__janusElectron;
const root = process.cwd();
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-follower-visual-'));
const htmlPath = path.join(tempRoot, 'index.html');
const styleUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'style.css')).href;
const viewUrl = pathToFileURL(path.join(root, 'src', 'renderer', 'app', 'features', 'follower', 'followerView.js')).href;
const screenshots = [];

writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="${styleUrl}"><style>html,body,#app{width:100%;height:100%;margin:0}body{overflow:hidden}</style></head><body><div id="app"></div><script type="module">
  import { renderFollowerWorkspace } from '${viewUrl}';
  const state = {
    languageMode: 'zh', followerActiveSection: 'capability', followerSelectedKind: 'daily_brief',
    followerOverviewLoading: false, followerOverviewError: '', followerReports: [], responsiveLayoutMode: 'dual',
    model: 'gpt-5.6-sol', modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }] },
    followerOverview: { status: { state: 'idle' }, unreadCount: 0, preferenceRevision: 1,
      preferences: { verbosity: 'standard', model: 'gpt-5.6-sol', prompts: {} },
      schedules: [{ kind: 'weekly_review', enabled: true, frequency: 'weekly', daysOfWeek: [5], localTime: '18:30', timezone: 'Asia/Shanghai' }] },
  };
  document.getElementById('app').innerHTML = '<div class="shell" style="width:100%;height:100%;display:block">' + renderFollowerWorkspace(state) + '</div>';
  window.renderFollowerTheme = (dark) => {
    document.querySelector('.shell')?.classList.toggle('theme-dark', dark);
  };
  window.renderFollowerReports = () => {
    state.followerActiveSection = 'reports';
    state.followerSelectedKind = '';
    state.followerReportFilter = 'all';
    state.followerRuns = [
      { id: 'run_failed_daily', kind: 'daily_brief', status: 'failed', errorText: 'model is required', createdAt: '2026-08-13T11:25:00.000Z', processEvents: [] },
      { id: 'run_failed_weekly', kind: 'weekly_review', status: 'failed', errorText: 'model is required', createdAt: '2026-08-12T08:30:00.000Z', processEvents: [] },
    ];
    state.followerReports = [
      { id: 'report_daily', kind: 'daily_brief', createdAt: '2026-08-13T15:46:00.000Z', readAt: '', report: { summary: 'Agent 自进化研究方向已有新的讨论证据，相关事项仍在推进中。（source_1, source_2）', claims: [{ status: 'in_progress', text: '已围绕评估机制展开讨论（source_1）。', sourceRefs: ['source_1', 'source_2'] }], suggestions: [] } },
      { id: 'report_growth', kind: 'growth_guidance', createdAt: '2026-08-11T09:20:00.000Z', readAt: '2026-08-11T10:00:00.000Z', report: { summary: '整理了下一阶段值得继续验证的研究方向。', claims: [], suggestions: [] } },
    ];
    document.getElementById('app').innerHTML = '<div class="shell" style="width:100%;height:100%;display:block">' + renderFollowerWorkspace(state) + '</div>';
  };
  window.renderFollowerOverviewHistory = () => {
    state.followerActiveSection = 'overview';
    state.followerSelectedKind = '';
    state.followerSelectedReport = null;
    state.followerSourceDrawer = null;
    state.followerReports = [
      { id: 'overview_newest', kind: 'daily_brief', createdAt: '2026-08-14T13:30:00.000Z', report: { summary: '最新简报：Follower 概览已支持完整报告时间线。', claims: [{ status: 'completed', text: '完成报告历史展示。', sourceRefs: ['source_task'] }], suggestions: [] } },
      { id: 'overview_same_day', kind: 'growth_guidance', createdAt: '2026-08-14T09:20:00.000Z', report: { summary: '成长建议：继续验证空会话导航的一致性。', claims: [{ status: 'in_progress', text: '正在验证导航。', sourceRefs: ['source_chat'] }], suggestions: [] } },
      { id: 'overview_older', kind: 'weekly_review', createdAt: '2026-08-13T10:00:00.000Z', report: { summary: '较早的周报仍保留在概览时间线中。', claims: [{ status: 'completed', text: '完成前一阶段检查。', sourceRefs: ['source_old'] }], suggestions: [] } },
    ];
    state.followerOverview = { ...state.followerOverview, latestReport: state.followerReports[0] };
    document.getElementById('app').innerHTML = '<div class="shell" style="width:100%;height:100%;display:block">' + renderFollowerWorkspace(state) + '</div>';
  };
  window.renderFollowerSourceDrawer = () => {
    state.followerSelectedReport = state.followerReports[0];
    state.followerFollowup = { messages: [] };
    state.followerSourceDrawer = { reportId: 'report_daily', sourceRefs: ['source_1', 'source_2', 'source_task'], sources: [
      { refId: 'source_1', sourceKind: 'agent_message', title: '新对话', agentLabel: 'Generalist A', role: 'user', groupKey: 'session:generalist-a', occurredAt: '2026-08-13T15:38:00.000Z', availabilityState: 'available' },
      { refId: 'source_2', sourceKind: 'agent_message', title: '新对话', agentLabel: 'Generalist A', role: 'assistant', groupKey: 'session:generalist-a', occurredAt: '2026-08-13T15:42:00.000Z', availabilityState: 'available' },
      { refId: 'source_task', sourceKind: 'task_run', title: '验证 Follower 报告引用', occurredAt: '2026-08-13T15:31:00.000Z', availabilityState: 'changed' },
    ] };
    document.getElementById('app').innerHTML = '<div class="shell" style="width:100%;height:100%;display:block">' + renderFollowerWorkspace(state) + '</div>';
  };
</script></body></html>`, 'utf8');

let win;
try {
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 820, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadFile(htmlPath);
  await win.webContents.executeJavaScript('document.fonts.ready');
  for (const width of [1280, 900, 600]) {
    win.setSize(width, 820);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const layout = await win.webContents.executeJavaScript(`(() => {
      const content = document.querySelector('.follower-content');
      const page = document.querySelector('.follower-capability-page');
      const save = document.querySelector('[data-follower-capability-save]');
      const followerBeta = document.querySelector('.follower-identity .follower-avatar > small')?.getBoundingClientRect();
      const elements = [...document.querySelectorAll('.follower-capability-page select, .follower-capability-page textarea, .follower-capability-page button')]
        .filter((element) => getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');
      const wide = [...document.querySelectorAll('.follower-capability-page, .follower-capability-page *')]
        .map((element) => ({ element: element.className || element.tagName, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }))
        .filter((entry) => entry.right > content.getBoundingClientRect().right + 1)
        .slice(0, 10);
      return {
        content: content && getComputedStyle(content).display !== 'none' && content.getBoundingClientRect().width > 0,
        pageHeight: page?.getBoundingClientRect().height || 0,
        saveWidth: save?.getBoundingClientRect().width || 0,
        overflow: elements.filter((element) => element.getBoundingClientRect().right > innerWidth + 1 || element.getBoundingClientRect().left < -1).length,
        horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
        contentHorizontalScroll: content.scrollWidth > content.clientWidth + 1,
        contentWidth: content.clientWidth,
        scrollWidth: content.scrollWidth,
        followerBadgeWidth: followerBeta?.width || 0,
        followerBadgeHeight: followerBeta?.height || 0,
        wide,
      };
    })()`);
    assert.equal(layout.content, true, `${width}px content must remain visible`);
    assert.ok(layout.pageHeight > 300, `${width}px capability page must be rendered`);
    assert.ok(layout.saveWidth > 110, `${width}px save button must not collapse vertically`);
    assert.equal(layout.overflow, 0, `${width}px controls must stay inside the viewport`);
    assert.equal(layout.horizontalScroll, false, `${width}px page must not scroll horizontally`);
    assert.equal(layout.contentHorizontalScroll, false, `${width}px content must not scroll horizontally: ${JSON.stringify(layout)}`);
    assert.ok(layout.followerBadgeWidth >= 20 && layout.followerBadgeHeight >= 14,
      `${width}px Follower Beta badge must reuse the message-shortcut sizing: ${JSON.stringify(layout)}`);
    const screenshot = path.join('/tmp', `janus-follower-capability-${width}.png`);
    writeFileSync(screenshot, (await win.capturePage()).toPNG());
    screenshots.push(screenshot);
  }
  win.setSize(1280, 820);
  await win.webContents.executeJavaScript('window.renderFollowerTheme(true)');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const darkColors = await win.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.follower-workspace');
    const content = document.querySelector('.follower-content');
    const capability = document.querySelector('.follower-capability.active');
    return { workspace: getComputedStyle(workspace).backgroundColor, content: getComputedStyle(content).backgroundColor,
      capability: getComputedStyle(capability).backgroundColor, capabilityOpacity: getComputedStyle(capability).opacity };
  })()`);
  assert.notEqual(darkColors.workspace, 'rgb(255, 255, 255)', 'dark workspace must not render white');
  assert.notEqual(darkColors.content, 'rgb(255, 255, 255)', 'dark content must not render white');
  assert.equal(darkColors.capabilityOpacity, '1', `dark capability must remain opaque: ${JSON.stringify(darkColors)}`);
  const darkScreenshot = path.join('/tmp', 'janus-follower-capability-dark.png');
  writeFileSync(darkScreenshot, (await win.capturePage()).toPNG());
  screenshots.push(darkScreenshot);
  win.setSize(1280, 820);
  await win.webContents.executeJavaScript('window.renderFollowerReports()');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const filterLayout = await win.webContents.executeJavaScript(`(() => ({
    filterCount: document.querySelectorAll('[data-follower-report-filter]').length,
    activeFilter: document.querySelector('[data-follower-report-filter].active')?.dataset.followerReportFilter || '',
    horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
  }))()`);
  assert.equal(filterLayout.filterCount, 5);
  assert.equal(filterLayout.activeFilter, 'all');
  assert.equal(filterLayout.horizontalScroll, false);
  const reportScreenshot = path.join('/path/to/ui-pictures', 'follower-report-filters.png');
  writeFileSync(reportScreenshot, (await win.capturePage()).toPNG());
  screenshots.push(reportScreenshot);
  await win.webContents.executeJavaScript('window.renderFollowerOverviewHistory()');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const overviewHistoryLayout = await win.webContents.executeJavaScript(`(() => ({
    reportIds: [...document.querySelectorAll('[data-follower-overview-report]')].map((item) => item.dataset.followerOverviewReport),
    dateSeparators: document.querySelectorAll('.follower-conversation-preview > .follower-date-separator').length,
    horizontalScroll: document.documentElement.scrollWidth > innerWidth + 1,
  }))()`);
  assert.deepEqual(overviewHistoryLayout.reportIds, ['overview_newest', 'overview_same_day', 'overview_older']);
  assert.equal(overviewHistoryLayout.dateSeparators, 2, 'reports on the same day must share one date separator');
  assert.equal(overviewHistoryLayout.horizontalScroll, false);
  const overviewHistoryScreenshot = path.join('/path/to/ui-pictures', 'follower-overview-history.png');
  writeFileSync(overviewHistoryScreenshot, (await win.capturePage()).toPNG());
  screenshots.push(overviewHistoryScreenshot);
  await win.webContents.executeJavaScript('window.renderFollowerReports()');
  await win.webContents.executeJavaScript('window.renderFollowerSourceDrawer()');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const sourceLayout = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.follower-source-drawer');
    const visibleText = drawer?.innerText || '';
    return {
      groups: document.querySelectorAll('.follower-source-group').length,
      conversationTitle: visibleText.includes('与 Generalist A 的对话'),
      roleSummary: visibleText.includes('用户提问') && visibleText.includes('Agent 回复'),
      internalRefVisible: visibleText.includes('source_'),
      horizontalScroll: drawer ? drawer.scrollWidth > drawer.clientWidth + 1 : true,
    };
  })()`);
  assert.equal(sourceLayout.groups, 2, 'two messages from one conversation plus one task must render as two source groups');
  assert.equal(sourceLayout.conversationTitle, true);
  assert.equal(sourceLayout.roleSummary, true);
  assert.equal(sourceLayout.internalRefVisible, false);
  assert.equal(sourceLayout.horizontalScroll, false);
  const sourceScreenshot = path.join('/path/to/ui-pictures', 'follower-report-sources-grouped.png');
  writeFileSync(sourceScreenshot, (await win.capturePage()).toPNG());
  screenshots.push(sourceScreenshot);
  win.setSize(420, 820);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const narrowSourceLayout = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.follower-source-drawer');
    return { horizontalScroll: drawer ? drawer.scrollWidth > drawer.clientWidth + 1 : true,
      clippedCards: [...document.querySelectorAll('.follower-source-group')].filter((card) => card.getBoundingClientRect().right > innerWidth + 1).length };
  })()`);
  assert.equal(narrowSourceLayout.horizontalScroll, false);
  assert.equal(narrowSourceLayout.clippedCards, 0);
  const narrowSourceScreenshot = path.join('/path/to/ui-pictures', 'follower-report-sources-grouped-mobile.png');
  writeFileSync(narrowSourceScreenshot, (await win.capturePage()).toPNG());
  screenshots.push(narrowSourceScreenshot);
  process.stdout.write(`Follower visual smoke passed: ${screenshots.join(', ')}\nDark colors: ${JSON.stringify(darkColors)}\n`);
} finally {
  win?.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}
