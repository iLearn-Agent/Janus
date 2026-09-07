import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createFollowerController } from '../../src/renderer/app/features/follower/followerController.js';
import { renderFollowerWorkspace } from '../../src/renderer/app/features/follower/followerView.js';

const state = { languageMode: 'zh', followerActiveSection: 'settings', followerOverviewLoading: false, followerOverviewError: '',
  model: 'gpt-5.6-sol', modelCatalog: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }, { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' }] },
  followerOverview: { setup: { configured: true, disclosureConfirmed: true, grants: { task_activity: true } }, status: { state: 'idle' },
    unreadCount: 0, preferences: { verbosity: 'standard' }, preferenceRevision: 1, schedules: [],
    cloud: { configured: true, reportSyncEnabled: true, evolutionEnabled: false } } };
const html = renderFollowerWorkspace(state);
assert.match(html, /data-follower-workspace/);
assert.match(html, /data-follower-close/);
assert.match(html, /follower-refresh-button/);
assert.match(html, /follower-avatar[\s\S]*im-message-shortcut-beta[\s\S]*Beta/);
assert.equal((html.match(/data-follower-section=/g) || []).length, 2);
assert.doesNotMatch(html, /data-follower-section="schedules"/);
assert.equal((html.match(/data-follower-schedule-card=/g) || []).length, 3);
assert.doesNotMatch(html, /type="checkbox" checked disabled/);
assert.match(html, /data-follower-rail-toggle/);
assert.doesNotMatch(html, /data-follower-section="settings"/);
assert.doesNotMatch(html, /data-follower-run-menu|立即生成|data-follower-run="weekly_review"|data-follower-run="growth_guidance"/);
assert.doesNotMatch(html, /follower-choice-control/);
assert.equal((html.match(/data-follower-prompt=/g) || []).length, 3);
assert.match(html, /data-follower-model/);
assert.equal((html.match(/data-schedule-hour/g) || []).length, 3);
assert.equal((html.match(/data-schedule-minute/g) || []).length, 3);
assert.doesNotMatch(html, /data-schedule-timezone|type="time"|data-schedule-days/);
assert.doesNotMatch(html, /私人助理|社交私聊|社交群聊|data-follower-disclosure|data-follower-grant/);
const legacyScheduleHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'schedules' });
assert.equal((legacyScheduleHtml.match(/data-follower-schedule-card=/g) || []).length, 3);
assert.doesNotMatch(html, /data-follower-report-sync|data-follower-evolution|data-follower-cloud-sync/);
assert.doesNotMatch(html, /云同步|上传|脱敏|进化证据/);
assert.doesNotMatch(html, /data-network-peer="self-follower"/);
const css = fs.readFileSync('src/renderer/app/features/follower/styles.css', 'utf8');
assert.match(css, /@media \(max-width: 720px\)/);
assert.match(css, /follower-source-choice[\s\S]*grid-template-columns:minmax\(0,1fr\) auto/);
assert.match(css, /is-rail-collapsed[\s\S]*grid-template-columns: 64px/);
const defaultHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'overview', followerOverview: { setup: { configured: false, grants: {} },
  preferences: { verbosity: 'standard' }, schedules: [] } });
assert.match(defaultHtml, /报告时间线/);
assert.match(defaultHtml, /follower-shell/);
assert.match(defaultHtml, /follower-capability-list/);
assert.equal((defaultHtml.match(/data-follower-run=/g) || []).length, 0);
for (const kind of ['daily_brief', 'weekly_review', 'growth_guidance']) {
  assert.equal((defaultHtml.match(new RegExp(`data-follower-capability="${kind}"`, 'g')) || []).length, 1, `${kind} should open its configuration`);
}
assert.doesNotMatch(defaultHtml, /follower-rail-reports|最近报告/);
assert.match(defaultHtml, /已安排/);
const capabilityHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'capability', followerSelectedKind: 'daily_brief' });
assert.match(capabilityHtml, /is-capability/);
assert.match(capabilityHtml, /data-follower-capability-page="daily_brief"/);
assert.match(capabilityHtml, /data-follower-capability-save="daily_brief"/);
assert.doesNotMatch(capabilityHtml, /data-follower-capability-start|>启动<|立即生成/);
assert.match(capabilityHtml, /data-follower-capability-reasoning-effort/);
assert.match(capabilityHtml, /follower-capability-history/);
assert.equal((capabilityHtml.match(/data-follower-schedule-card=/g) || []).length, 1);
const capabilityDraftHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'capability', followerSelectedKind: 'daily_brief',
  followerFormDraft: {
    'preferences:model': 'gpt-5.4-mini', 'preferences:verbosity': 'detailed',
    'preferences:prompt:daily_brief': '保留未保存的草稿',
    'schedule:daily_brief:days': [2, 4], 'schedule:daily_brief:hour': '07', 'schedule:daily_brief:minute': '05',
  } });
assert.match(capabilityDraftHtml, /value="gpt-5\.4-mini" selected/);
assert.match(capabilityDraftHtml, /value="detailed" selected/);
assert.match(capabilityDraftHtml, />保留未保存的草稿<\/textarea>/);
assert.match(capabilityDraftHtml, /data-schedule-day value="2" checked/);
assert.match(capabilityDraftHtml, /data-schedule-day value="4" checked/);
assert.match(capabilityDraftHtml, /data-schedule-hour[^>]*>[\s\S]*value="07" selected/);
assert.match(capabilityDraftHtml, /data-schedule-minute[^>]*>[\s\S]*value="05" selected/);
const scheduledHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'overview', followerOverview: {
  ...state.followerOverview, schedules: [{ kind: 'daily_brief', enabled: true, frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5], localTime: '18:00', timezone: 'Asia/Shanghai' }],
} });
assert.doesNotMatch(scheduledHtml, /class="follower-capability [^"]*" data-follower-capability="daily_brief"/);
assert.match(scheduledHtml, /follower-scheduled-item[\s\S]*今日简报[\s\S]*已安排/);
assert.match(scheduledHtml, /data-follower-capability="daily_brief"/);
assert.doesNotMatch(scheduledHtml, /data-follower-report-open/);
const runningScheduledHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'capability', followerSelectedKind: 'daily_brief', followerOverview: {
  ...state.followerOverview, status: { state: 'generating', activeRun: { id: 'run_daily', kind: 'daily_brief', status: 'generating' } },
  schedules: [{ kind: 'daily_brief', enabled: true, frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5], localTime: '18:00', timezone: 'Asia/Shanghai' }],
} });
assert.match(runningScheduledHtml, /follower-scheduled-item is-running[\s\S]*follower-spinner/);
const legacyToolRunHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedRun: {
  id: 'legacy_tool_run', kind: 'daily_brief', status: 'generating', createdAt: '2026-08-12T10:00:00.000Z', processEvents: [
    { kind: 'activity', activityId: 'reasoning-visible', activityType: 'reasoning', status: 'completed',
      title: '思考摘要', detail: '先整理已授权来源。', reasoningText: '再核对事实、阻塞和建议之间的边界。' },
    { kind: 'activity', activityId: 'legacy-tool', activityType: 'tool', status: 'completed',
      title: '工具调用', toolServer: 'oplith_follower', toolName: 'list_activity' },
  ],
} });
assert.match(legacyToolRunHtml, /Janus Follower/,
  'historical Follower tool namespaces must use the current Janus brand in the transcript');
assert.doesNotMatch(legacyToolRunHtml, /oplith_follower/i);
assert.match(legacyToolRunHtml, /再核对事实、阻塞和建议之间的边界/,
  'Follower transcripts must disclose the sanitized Codex reasoning text');
const disabledScheduleHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'capability', followerSelectedKind: 'daily_brief', followerOverview: {
  ...state.followerOverview, schedules: [{ kind: 'daily_brief', enabled: false, frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5], localTime: '18:00', timezone: 'Asia/Shanghai' }],
} });
assert.match(disabledScheduleHtml, /follower-capability [^\"]*active[^\"]*" data-follower-capability="daily_brief"/);
assert.doesNotMatch(disabledScheduleHtml, /follower-scheduled-item[^>]*data-follower-capability="daily_brief"/);
const collapsedHtml = renderFollowerWorkspace({ ...state, followerRailCollapsed: true });
assert.match(collapsedHtml, /is-rail-collapsed/);
const report = { id: 'follower_report_renderer', kind: 'daily_brief', createdAt: '2026-08-12T10:00:00.000Z',
  report: { summary: '工作进展摘要（source_abc, source_def）', claims: [{ status: 'completed', text: '完成界面调整 source_abc', sourceRefs: ['source_abc', 'source_def'] }], suggestions: [] } };
const latestOverviewReport = { id: 'follower_report_latest', kind: 'growth_guidance', createdAt: '2026-08-14T11:00:00.000Z',
  report: { summary: '最新成长建议', claims: [], suggestions: [] } };
const overviewHistoryHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'overview',
  followerReports: [report, latestOverviewReport], followerOverview: { ...state.followerOverview, latestReport: latestOverviewReport } });
assert.equal((overviewHistoryHtml.match(/data-follower-overview-report=/g) || []).length, 2,
  'overview must render the full report history without duplicating latestReport');
assert.ok(overviewHistoryHtml.indexOf('data-follower-overview-report="follower_report_latest"')
  < overviewHistoryHtml.indexOf('data-follower-overview-report="follower_report_renderer"'),
  'overview reports must be ordered newest first');
assert.match(overviewHistoryHtml, /最新成长建议/);
assert.match(overviewHistoryHtml, /工作进展摘要/);
const reportHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedReport: report,
  followerReports: [report], followerFollowup: { messages: [{ role: 'user', content: '下一步是什么？' }, { role: 'assistant', content: '继续验证。' }] },
  followerOverview: { ...state.followerOverview, latestReport: report, unreadCount: 1 } });
assert.match(reportHtml, /follower-message-timeline/);
assert.match(reportHtml, /data-follower-scroll-region="report:follower_report_renderer"/);
assert.match(reportHtml, /data-preserve-scroll data-scroll-key="follower-content:report"/);
assert.match(reportHtml, /data-scroll-key="follower-report:follower_report_renderer"/);
assert.match(reportHtml, /follower-report-document/);
assert.doesNotMatch(reportHtml.replace(/<[^>]*>/g, ' '), /source_(?:abc|def)/,
  'internal evidence identifiers must not appear in user-visible report prose');
assert.match(reportHtml, /data-follower-source-refs="source_abc,source_def"/,
  'structured evidence references must remain available to the source action');
assert.match(reportHtml, /data-follower-followup-form/);
assert.match(reportHtml, /data-follower-followup-input/);
assert.match(reportHtml, /M4 4\.8 20 12 4 19\.2/);
assert.equal((reportHtml.match(/follower-message is-/g) || []).length, 3);
assert.match(reportHtml, /data-follower-report-delete/);
const followupDraftHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedReport: report,
  followerReports: [report], followerFollowup: { messages: [] }, followerFollowupDrafts: { [report.id]: '<继续检查 & 验证>' },
  followerOverview: { ...state.followerOverview, latestReport: report } });
assert.match(followupDraftHtml, /data-follower-followup-input[^>]*>&lt;继续检查 &amp; 验证&gt;<\/textarea>/);
assert.match(reportHtml, /今日简报-/);
assert.match(reportHtml, /今日简报-08-12 18:00/);
assert.doesNotMatch(reportHtml, /追问保存在本机/);
assert.match(css, /follower-message\.is-user \{ justify-self: start/);
assert.match(reportHtml, /follower-message is-user[\s\S]*follower-message-avatar[\s\S]*<strong>你<\/strong>/);
assert.match(reportHtml, /follower-message is-assistant[\s\S]*follower-message-avatar[\s\S]*<strong>Follower<\/strong>/);
const busyReportHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedReport: report,
  followerReports: [report], followerFollowupBusy: true, followerFollowup: { messages: [
    { id: 'pending_user', role: 'user', content: '你好', createdAt: '2026-08-12T10:35:00.000Z' },
  ] }, followerOverview: { ...state.followerOverview, latestReport: report } });
assert.match(busyReportHtml, /data-follower-followup-message="pending_user"/);
assert.match(busyReportHtml, /follower-followup-pending[\s\S]*正在回复/);
assert.match(busyReportHtml, /data-follower-followup-action data-mode="stop"/);
assert.match(busyReportHtml, /<rect x="7\.5" y="7\.5" width="9" height="9"/);
assert.doesNotMatch(busyReportHtml, /data-follower-followup-input[^>]*disabled|follower-send-button[^>]*disabled/);
const reportIndexHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerReportFilter: 'failed',
  followerReports: [report], followerRuns: [
    { id: 'failed_daily', kind: 'daily_brief', status: 'failed', errorText: 'model is required', createdAt: '2026-08-12T09:00:00.000Z' },
    { id: 'active_weekly', kind: 'weekly_review', status: 'generating', createdAt: '2026-08-12T09:30:00.000Z' },
  ] });
assert.equal((reportIndexHtml.match(/data-follower-report-filter=/g) || []).length, 5);
assert.match(reportIndexHtml, /data-follower-report-filter="failed"[^>]*>失败记录<\/button>/);
assert.match(reportIndexHtml, /data-follower-run-open="failed_daily"/);
assert.doesNotMatch(reportIndexHtml, /data-follower-run-open="active_weekly"|data-follower-report-open="follower_report_renderer"/);
assert.doesNotMatch(reportIndexHtml, /这个分类下还没有记录/,
  'a visible failed run must suppress the report-list empty state');
const dailyIndexHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerReportFilter: 'daily_brief',
  followerReports: [report], followerRuns: [
    { id: 'failed_daily', kind: 'daily_brief', status: 'failed', errorText: 'model is required', createdAt: '2026-08-12T09:00:00.000Z' },
  ] });
assert.doesNotMatch(dailyIndexHtml, /data-follower-run-open="failed_daily"/,
  'failed runs must not appear in their ordinary report-kind filter');
const allIndexHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerReportFilter: 'all',
  followerReports: [report], followerRuns: [
    { id: 'failed_daily', kind: 'daily_brief', status: 'failed', errorText: 'model is required', createdAt: '2026-08-12T09:00:00.000Z' },
  ] });
assert.doesNotMatch(allIndexHtml, /data-follower-run-open="failed_daily"/,
  'failed runs must remain exclusive to the failed-records filter');
const emptyFailedIndexHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerReportFilter: 'failed',
  followerReports: [report], followerRuns: [], followerOverview: { ...state.followerOverview, latestReport: report } });
assert.match(emptyFailedIndexHtml, /这个分类下还没有记录/,
  'the report-list empty state must remain visible when the selected filter has no records');
const selectedFeedbackHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedReport: report,
  followerReports: [report], followerFollowup: { messages: [] },
  followerReportFeedback: { [report.id]: { rating: 'helpful', status: 'accepted' } },
  followerOverview: { ...state.followerOverview, latestReport: report } });
assert.match(selectedFeedbackHtml, /class="is-selected" data-follower-feedback="helpful"/);
const sourceDrawerHtml = renderFollowerWorkspace({ ...state, followerActiveSection: 'reports', followerSelectedReport: report,
  followerReports: [report], followerFollowup: { messages: [] }, followerOverview: { ...state.followerOverview, latestReport: report },
  followerSourceDrawer: { reportId: report.id, sourceRefs: ['source_abc', 'source_def'], sources: [
    { refId: 'source_abc', sourceKind: 'agent_message', title: '新对话', agentLabel: 'Generalist A', role: 'user',
      groupKey: 'session:opaque', occurredAt: '2026-08-12T09:58:00.000Z', availabilityState: 'available' },
    { refId: 'source_def', sourceKind: 'agent_message', title: '新对话', agentLabel: 'Generalist A', role: 'assistant',
      groupKey: 'session:opaque', occurredAt: '2026-08-12T10:00:00.000Z', availabilityState: 'available' },
  ] } });
assert.equal((sourceDrawerHtml.match(/follower-source-group is-available/g) || []).length, 1,
  'messages from the same conversation must be grouped into one source card');
assert.match(sourceDrawerHtml, /与 Generalist A 的对话/);
assert.match(sourceDrawerHtml, /用户提问/);
assert.match(sourceDrawerHtml, /Agent 回复/);
assert.match(sourceDrawerHtml, /2 条证据/);
assert.doesNotMatch(sourceDrawerHtml.replace(/<[^>]*>/g, ' '), /source_(?:abc|def)|<small>Agent 对话<\/small>/,
  'source cards must not expose evidence identifiers or generic repeated labels');
const previousDocument = globalThis.document;
let filterHandler = null;
let scrollRegion = { dataset: { followerScrollRegion: 'report:scroll_test' }, scrollTop: 284, scrollLeft: 0 };
const filterButton = { dataset: { followerReportFilter: 'daily_brief' }, addEventListener: (_type, handler) => { filterHandler = handler; } };
globalThis.document = {
  querySelector() { return null; },
  querySelectorAll(selector) {
    if (selector === '[data-follower-scroll-region]') return [scrollRegion];
    if (selector === '[data-follower-report-filter]') return [filterButton];
    return [];
  },
};
try {
  const filterState = { followerReportFilter: 'all' };
  const controller = createFollowerController({ api: {}, state: filterState,
    render: () => { scrollRegion = { dataset: { followerScrollRegion: 'report:scroll_test' }, scrollTop: 0, scrollLeft: 0 }; },
    notify: () => {}, userVisibleErrorMessage: (_error, fallback) => fallback });
  controller.wire(globalThis.document);
  filterHandler();
  assert.equal(filterState.followerReportFilter, 'daily_brief');
  assert.equal(scrollRegion.scrollTop, 284, 'Follower rerenders must preserve the selected report scroll position');
} finally {
  globalThis.document = previousDocument;
}

let resolvePersonalOverview;
const workspaceRequests = [];
const workspaceRaceState = {
  languageMode: 'zh', activeAccountWorkspace: { id: 'workspace_personal' }, workspaceSwitchGeneration: 1,
  followerWorkspaceId: 'workspace_personal', followerWorkspaceOpen: true, followerOverview: null,
  followerOverviewLoading: false, followerOverviewError: '', followerReports: [], followerRuns: [],
};
const workspaceRaceController = createFollowerController({
  api: {
    followerOverview(payload) {
      workspaceRequests.push(['overview', payload.workspaceId]);
      if (payload.workspaceId === 'workspace_personal') {
        return new Promise((resolve) => { resolvePersonalOverview = resolve; });
      }
      return Promise.resolve({ setup: { configured: true }, status: { state: 'idle' }, schedules: [] });
    },
    followerReportsList(payload) {
      workspaceRequests.push(['reports', payload.workspaceId]);
      return Promise.resolve([{ id: `report_${payload.workspaceId}`, kind: 'daily_brief' }]);
    },
    followerRunsList(payload) {
      workspaceRequests.push(['runs', payload.workspaceId]);
      return Promise.resolve([]);
    },
  },
  state: workspaceRaceState,
  render: () => {},
  notify: () => {},
  userVisibleErrorMessage: (_error, fallback) => fallback,
});
const stalePersonalRefresh = workspaceRaceController.refresh();
workspaceRaceState.activeAccountWorkspace = { id: 'workspace_org_test' };
workspaceRaceState.workspaceSwitchGeneration = 2;
workspaceRaceController.resetWorkspace('workspace_org_test');
resolvePersonalOverview({ setup: { configured: true }, latestReport: { id: 'stale_personal_report' } });
await stalePersonalRefresh;
assert.equal(workspaceRaceState.followerOverview, null,
  'a completed refresh from the previous Workspace must not overwrite the newly selected Workspace');
assert.deepEqual(workspaceRaceState.followerReports, [],
  'reports from the previous Workspace must be cleared during a Workspace switch');
await workspaceRaceController.refresh();
assert.equal(workspaceRaceState.followerReports[0]?.id, 'report_workspace_org_test');
assert.deepEqual(workspaceRequests, [
  ['overview', 'workspace_personal'],
  ['overview', 'workspace_org_test'],
  ['reports', 'workspace_org_test'],
  ['runs', 'workspace_org_test'],
], 'Follower reads must stay explicitly scoped to the Workspace that initiated them');

const preload = fs.readFileSync('src/preload/follower.js', 'utf8');
const ipc = fs.readFileSync('src/main/ipc/registerIpcHandlers.js', 'utf8');
assert.doesNotMatch(preload, /followerRunNow|follower:run-now/);
assert.doesNotMatch(ipc, /follower:run-now/);
const networkCss = fs.readFileSync('src/renderer/app/features/network/styles.css', 'utf8');
assert.match(networkCss, /repeat\(3/);
const rendererApp = fs.readFileSync('src/renderer/app/core/rendererApp.js', 'utf8');
const followerController = fs.readFileSync('src/renderer/app/features/follower/followerController.js', 'utf8');
assert.match(followerController, /followupInputFocused\) nextInput\.focus\(\{ preventScroll: true \}\)/,
  'Follower rerenders must restore input focus without moving the report timeline');
assert.match(followerController, /const shouldFollowBottom = followupTimelineShouldFollowBottom\(\);[\s\S]*if \(shouldFollowBottom\) scrollFollowupToEnd\(\)/,
  'a delayed Follower reply must not pull the user back to the bottom after they scroll away');
assert.match(followerController, /event\.key !== 'Enter' \|\| event\.shiftKey \|\| event\.isComposing/);
assert.match(followerController, /input\.form\?\.requestSubmit\(\)/);
const preferencesSaveHandler = followerController.slice(followerController.indexOf("'[data-follower-preferences-save]'"),
  followerController.indexOf("'[data-follower-prompt]'"));
assert.doesNotMatch(preferencesSaveHandler, /requestId/,
  'preference save failures must not reference the follow-up request id');
assert.match(followerController, /setFormDraft\(`schedule:\$\{kind\}:days`/,
  'schedule controls must persist their unsaved values in renderer state');
assert.match(rendererApp, /isSettings \|\| state\.followerWorkspaceOpen \? '' : renderTopbar/,
  'Follower must merge close navigation into its own header instead of rendering a separate top utility row');
assert.match(rendererApp, /followerEditingControlActive\(\)[\s\S]*followerControlRenderDeferred = true/,
  'background renderer updates must defer while a Follower form control is being edited');
assert.match(rendererApp, /render: \(\) => render\(\{ allowFollowerFollowupRender: true \}\)/,
  'Follower-managed follow-up renders must remain immediate while external refreshes are deferred');
assert.match(rendererApp, /element\.matches\('select, textarea,/,
  'external renderer updates must preserve focus for every Follower text-editing control');
const agentInboxHandler = rendererApp.slice(rendererApp.indexOf("document.querySelectorAll('[data-agent-inbox]')"),
  rendererApp.indexOf("document.querySelectorAll('[data-contact-profile]')"));
assert.match(agentInboxHandler, /followerController\.close\(\)/,
  'every Agent inbox branch, including unsaved conversations, must leave Follower first');
const chatGroupOpener = rendererApp.slice(rendererApp.indexOf('async function openChatGroup('),
  rendererApp.indexOf('async function openGroupDirectoryProfile('));
assert.match(chatGroupOpener, /followerController\.close\(\)/,
  'opening an empty contact group must leave Follower inside the shared group entry point');
assert.match(rendererApp, /followerController\.resetWorkspace\(nextWorkspaceId \|\| 'workspace_personal'\)/,
  'switching account Workspaces must invalidate the previous Follower cache');
console.log('Follower renderer workspace and responsive smoke passed');
