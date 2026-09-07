import { escapeAttr, escapeHtml, formatMessageTime } from '../../utils/format.js';
import { iconSvg } from '../../ui/icons.js';
import { followerText } from './i18n/index.js';
import { modelCatalogEntry, reasoningOptionsForModel, textModelOptions } from '../../constants.js';
import { renderCodexTranscript } from '../../views/codexTranscriptView.js';

const FOLLOWER_KINDS = Object.freeze([
  { kind: 'daily_brief', icon: 'sun', title: 'run.dailyTitle', description: 'run.dailyDescription' },
  { kind: 'weekly_review', icon: 'clipboard', title: 'run.weeklyTitle', description: 'run.weeklyDescription' },
  { kind: 'growth_guidance', icon: 'evolution', title: 'run.growthTitle', description: 'run.growthDescription' },
]);

const FOLLOWER_REPORT_FILTERS = Object.freeze([
  ['all', 'reports.filter.all'],
  ['daily_brief', 'reports.filter.daily'],
  ['weekly_review', 'reports.filter.weekly'],
  ['growth_guidance', 'reports.filter.growth'],
  ['failed', 'reports.filter.failed'],
]);
const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled_authorization_changed', 'cancelled_user_changed']);

function followerDraftValue(state, key, fallback) {
  return Object.prototype.hasOwnProperty.call(state.followerFormDraft || {}, key)
    ? state.followerFormDraft[key]
    : fallback;
}

function scheduleWithDraft(state, schedule) {
  const prefix = `schedule:${schedule.kind}`;
  const hour = followerDraftValue(state, `${prefix}:hour`, String(schedule.localTime || '00:00').split(':')[0] || '00');
  const minute = followerDraftValue(state, `${prefix}:minute`, String(schedule.localTime || '00:00').split(':')[1] || '00');
  return {
    ...schedule,
    daysOfWeek: followerDraftValue(state, `${prefix}:days`, schedule.daysOfWeek || []),
    localTime: `${hour}:${minute}`,
  };
}

export function renderFollowerWorkspace(state) {
  const t = (key, params) => followerText(key, state.languageMode, params);
  const overview = state.followerOverview;
  const requestedSection = state.followerActiveSection || 'overview';
  const active = requestedSection === 'schedules' ? 'settings'
    : ['overview', 'reports', 'settings', 'capability'].includes(requestedSection) ? requestedSection : 'overview';
  const workspaceMode = state.followerSelectedReport || state.followerSelectedRun ? 'report' : active;
  const railCollapsed = Boolean(state.followerRailCollapsed);
  return `<div class="view follower-workspace is-${escapeAttr(workspaceMode)} ${railCollapsed ? 'is-rail-collapsed' : ''}" data-follower-workspace>
    <header class="follower-header">
      <div class="follower-header-leading">
        <button type="button" class="follower-icon-button follower-header-close" data-follower-close title="${escapeAttr(t('header.close'))}" aria-label="${escapeAttr(t('header.close'))}">${iconSvg(state.responsiveLayoutMode === 'single' ? 'chevronLeft' : 'x')}</button>
        <div class="follower-identity"><span class="follower-avatar">${iconSvg('telescope')}<small class="im-message-shortcut-beta" data-no-localize>Beta</small></span><span><strong>${escapeHtml(t('header.title'))}</strong><small>${escapeHtml(t('header.subtitle'))}</small></span></div>
      </div>
      <div class="follower-header-actions">
        <span class="follower-presence"><i></i>${escapeHtml(overview?.status?.activeRun ? t('status.working') : t('status.ready'))}</span>
        <button type="button" class="follower-icon-button follower-refresh-button" data-follower-refresh title="${escapeAttr(t('header.refresh'))}" aria-label="${escapeAttr(t('header.refresh'))}">${iconSvg('refresh')}</button>
      </div>
    </header>
    <div class="follower-shell">
      ${renderFollowerRail(state, t, active, railCollapsed)}
      <main class="follower-content" data-follower-scroll-region="content:${escapeAttr(workspaceMode)}" data-preserve-scroll data-scroll-key="follower-content:${escapeAttr(workspaceMode)}">${renderFollowerContent(state, t, active)}</main>
    </div>
    ${state.followerSourceDrawer ? renderSourceDrawer(state, t) : ''}
  </div>`;
}

function renderFollowerRail(state, t, active, collapsed) {
  const overview = state.followerOverview || {};
  const schedules = new Map((overview.schedules || []).map((item) => [item.kind, item]));
  const reports = state.followerReports || [];
  const available = FOLLOWER_KINDS.filter((item) => !schedules.get(item.kind)?.enabled);
  const scheduled = FOLLOWER_KINDS.filter((item) => schedules.get(item.kind)?.enabled);
  return `<aside class="follower-rail ${collapsed ? 'is-collapsed' : ''}">
    <nav class="follower-tabs" aria-label="${escapeAttr(t('header.title'))}">
      <button type="button" data-follower-section="overview" class="${active === 'overview' ? 'active' : ''}" title="${escapeAttr(t('section.overview'))}">${iconSvg('tasks')}<span>${escapeHtml(t('section.overview'))}</span></button>
      <button type="button" data-follower-section="reports" class="${active === 'reports' ? 'active' : ''}" title="${escapeAttr(t('section.reports'))}">${iconSvg('message')}<span>${escapeHtml(t('section.reports'))}</span>${overview.unreadCount ? `<b>${overview.unreadCount > 99 ? '99+' : overview.unreadCount}</b>` : ''}</button>
      <button type="button" data-follower-rail-toggle title="${escapeAttr(t(collapsed ? 'rail.expand' : 'rail.collapse'))}" aria-label="${escapeAttr(t(collapsed ? 'rail.expand' : 'rail.collapse'))}">${iconSvg(collapsed ? 'panelRightOpen' : 'panelRightClose')}</button>
    </nav>
    <section class="follower-rail-section follower-capabilities">
      <header><h2>${escapeHtml(t('capabilities.title'))}</h2><small>${escapeHtml(t('capabilities.subtitle'))}</small></header>
      <div class="follower-capability-list">${available.map((item) => renderCapability(item, overview.status?.activeRun, state.followerSelectedReport ? '' : state.followerSelectedKind, t)).join('') || `<p class="follower-rail-empty">${escapeHtml(t('capabilities.allScheduled'))}</p>`}</div>
    </section>
    <section class="follower-rail-section follower-scheduled">
      <header><h2>${escapeHtml(t('capabilities.arranged'))}</h2><small>${scheduled.length}</small></header>
      <div class="follower-scheduled-list">${scheduled.map((item) => renderScheduledCapability(item, schedules.get(item.kind), reports, state, t)).join('') || `<p class="follower-rail-empty">${escapeHtml(t('capabilities.noneScheduled'))}</p>`}</div>
    </section>
    <footer><span>${iconSvg('shield')}</span><p>${escapeHtml(t('rail.privacy'))}</p></footer>
  </aside>`;
}

function renderCapability(item, activeRun, selectedKind, t) {
  const running = activeRun?.kind === item.kind;
  const meta = running ? t('run.runningShort') : t('capabilities.manual');
  return `<button type="button" class="follower-capability ${running ? 'is-running' : ''} ${selectedKind === item.kind ? 'active' : ''}" data-follower-capability="${escapeAttr(item.kind)}">
    <span class="follower-capability-icon is-${escapeAttr(item.kind)}">${running ? '<span class="follower-spinner"></span>' : iconSvg(item.icon)}</span>
    <span class="follower-capability-copy"><strong>${escapeHtml(t(item.title))}</strong><small>${escapeHtml(t(item.description))}</small><em>${escapeHtml(meta)}</em></span>
  </button>`;
}

function renderScheduledCapability(item, schedule, reports, state, t) {
  const running = state.followerOverview?.status?.activeRun?.kind === item.kind;
  const hasUnread = reports.some((report) => report.kind === item.kind && !report.readAt);
  return `<button type="button" class="follower-scheduled-item ${running ? 'is-running' : ''} ${!state.followerSelectedReport && state.followerSelectedKind === item.kind ? 'active' : ''}" data-follower-capability="${escapeAttr(item.kind)}">
    <span class="follower-capability-icon is-${escapeAttr(item.kind)}">${running ? '<span class="follower-spinner"></span>' : iconSvg(item.icon)}</span>
    <span><strong>${escapeHtml(t(item.title))}</strong><small>${escapeHtml(t('capabilities.scheduled', { time: schedule.localTime || '--:--' }))}</small></span>
    ${hasUnread ? '<i></i>' : iconSvg('chevronRight')}
  </button>`;
}

function renderFollowerContent(state, t, activeSection) {
  if (state.followerOverviewLoading && !state.followerOverview) return `<div class="follower-state-card"><span class="follower-spinner"></span><strong>${escapeHtml(t('status.loading'))}</strong></div>`;
  if (state.followerOverviewError && !state.followerOverview) return `<div class="follower-state-card is-error"><strong>${escapeHtml(t('status.failed'))}</strong><p>${escapeHtml(state.followerOverviewError)}</p><button class="btn secondary" data-follower-refresh>${escapeHtml(t('action.retry'))}</button></div>`;
  const overview = state.followerOverview || {};
  if (state.followerSelectedReport) return renderReportDetail(
    state.followerSelectedReport,
    t,
    state.followerFollowup,
    state.followerFollowupBusy,
    state.followerFollowupStopping,
    state.followerReportFeedback?.[state.followerSelectedReport.id] || null,
    state.followerFollowupDrafts?.[state.followerSelectedReport.id] || '',
  );
  if (state.followerSelectedRun) return renderRunDetail(state.followerSelectedRun, t);
  if (activeSection === 'capability' && state.followerSelectedKind) return renderCapabilitySettings(state, overview, t, state.languageMode);
  if (activeSection === 'reports') return renderReports(state, t);
  if (activeSection === 'settings') return renderSettings(state, overview, t, state.languageMode);
  return renderOverview(overview, state.followerReports || [], t);
}

function renderOverview(overview, reports, t) {
  const run = overview.status?.activeRun;
  const timeline = overviewReportTimeline(overview.latestReport, reports);
  return `<section class="follower-overview">
    <header class="follower-pane-header"><span><small>${escapeHtml(t('overview.latest'))} · ${escapeHtml(t('overview.eyebrow'))}</small><h1>${escapeHtml(t('overview.title'))}</h1><p>${escapeHtml(t('overview.description'))}</p></span></header>
    <div class="follower-conversation-preview">
      ${run ? `<article class="follower-run-card is-${escapeAttr(run.status)}"><span class="follower-spinner"></span><button type="button" class="follower-run-card-open" data-follower-run-open="${escapeAttr(run.id)}"><strong>${escapeHtml(t('run.running'))}</strong><small>${escapeHtml(t('run.runningDescription'))}</small></button><button type="button" data-follower-run-cancel="${escapeAttr(run.id)}">${escapeHtml(t('run.cancel'))}</button></article>` : ''}
      ${timeline.length ? renderOverviewReportTimeline(timeline, t) : renderEmptyConversation(t)}
    </div>
  </section>`;
}

function overviewReportTimeline(latestReport, reports) {
  const byId = new Map();
  for (const report of reports || []) {
    if (report?.id && !byId.has(report.id)) byId.set(report.id, report);
  }
  if (latestReport?.id && !byId.has(latestReport.id)) byId.set(latestReport.id, latestReport);
  return [...byId.values()].sort((left, right) => reportTimestamp(right) - reportTimestamp(left));
}

function renderOverviewReportTimeline(reports, t) {
  let previousDay = '';
  return reports.map((report, index) => {
    const day = reportDayKey(report.createdAt);
    const showDate = day !== previousDay;
    previousDay = day;
    return renderReportPreview(report, t, { showDate, latest: index === 0 });
  }).join('');
}

function renderEmptyConversation(t) {
  return `<div class="follower-empty-conversation"><span class="follower-avatar is-large">${iconSvg('telescope')}</span><h2>${escapeHtml(t('overview.emptyTitle'))}</h2><p>${escapeHtml(t('overview.emptyBody'))}</p></div>`;
}

function renderReportPreview(report, t, { showDate = true, latest = false } = {}) {
  const data = report.report || {};
  return `${showDate ? `<div class="follower-date-separator"><span>${escapeHtml(formatReportDate(report.createdAt, t))}</span></div>` : ''}
    <article class="follower-message is-assistant ${latest ? 'is-latest-report' : ''}" data-follower-overview-report="${escapeAttr(report.id)}">
      <span class="follower-message-avatar">${iconSvg('telescope')}</span>
      <div class="follower-message-stack"><header><strong>${escapeHtml(t('followup.follower'))}</strong><span>${escapeHtml(reportTitle(report, t))}</span><time>${escapeHtml(formatMessageTime(report.createdAt))}</time></header>
        <div class="follower-message-bubble follower-report-preview"><p>${escapeHtml(reportDisplayText(data.summary, t('status.noActivity')))}</p><div class="follower-report-counts">${claimCounts(data.claims || [], t)}</div><button type="button" data-follower-report-open="${escapeAttr(report.id)}">${escapeHtml(t('action.openReport'))}${iconSvg('chevronRight')}</button></div>
      </div>
    </article>`;
}

function renderReports(state, t) {
  const reports = state.followerReports || [];
  const runs = (state.followerRuns || []).filter((run) => !['completed', 'skipped_no_activity'].includes(run.status) || !run.reportId);
  const requestedFilter = state.followerReportFilter || 'all';
  const filter = FOLLOWER_REPORT_FILTERS.some(([value]) => value === requestedFilter) ? requestedFilter : 'all';
  const visibleRuns = filter === 'failed' ? runs.filter((run) => FAILED_RUN_STATUSES.has(run.status))
    : filter === 'all' ? runs.filter((run) => !FAILED_RUN_STATUSES.has(run.status))
      : runs.filter((run) => run.kind === filter && !FAILED_RUN_STATUSES.has(run.status));
  const visibleReports = filter === 'failed' ? [] : filter === 'all' ? reports : reports.filter((report) => report.kind === filter);
  const count = visibleReports.length + visibleRuns.length;
  const records = `${visibleRuns.map((run) => renderRunCard(run, t)).join('')}${visibleReports.map((report) => renderReportCard(report, t)).join('')}`;
  return `<section class="follower-section follower-report-index">
    <header class="follower-pane-header"><button type="button" class="follower-icon-button follower-pane-mobile-back" data-follower-mobile-home title="${escapeAttr(t('action.backToFollower'))}" aria-label="${escapeAttr(t('action.backToFollower'))}">${iconSvg('chevronLeft')}</button><span><small>${escapeHtml(t('reports.eyebrow'))}</small><h1>${escapeHtml(t('reports.title'))}</h1><p>${escapeHtml(t('reports.description'))}</p></span><b>${count}</b></header>
    <div class="follower-report-filters" role="tablist" aria-label="${escapeAttr(t('reports.filter.label'))}">${FOLLOWER_REPORT_FILTERS.map(([value, key]) => `<button type="button" role="tab" aria-selected="${filter === value ? 'true' : 'false'}" class="${filter === value ? 'active' : ''}" data-follower-report-filter="${escapeAttr(value)}">${escapeHtml(t(key))}</button>`).join('')}</div>
    <div class="follower-report-list">${records || `<div class="follower-state-card"><p>${escapeHtml(t('reports.filter.empty'))}</p></div>`}</div>
  </section>`;
}

function renderRunCard(run, t) {
  const active = !['failed', 'cancelled_authorization_changed', 'cancelled_user_changed'].includes(run.status);
  return `<button type="button" class="follower-report-card follower-run-record is-${escapeAttr(run.status)}" data-follower-run-open="${escapeAttr(run.id)}">
    <span class="follower-report-card-icon">${active ? '<span class="follower-spinner"></span>' : iconSvg('flag')}</span>
    <span class="follower-report-card-body"><small>${escapeHtml(reportKindLabel(run.kind, t))} · ${escapeHtml(runStatusLabel(run.status, t))}</small><strong>${escapeHtml(active ? t('run.runningDescription') : run.errorText || t('run.failedDescription'))}</strong><span>${escapeHtml(t('run.processUpdates', { count: run.processEvents?.length || 0 }))}</span></span>
    <span class="follower-report-card-meta"><time>${escapeHtml(formatMessageTime(run.startedAt || run.createdAt))}</time>${iconSvg('chevronRight')}</span>
  </button>`;
}

function renderRunDetail(run, t) {
  const events = Array.isArray(run.processEvents) ? run.processEvents : [];
  const streaming = runActive(run);
  const transcript = renderCodexTranscript(events, {
    messageId: run.id,
    streaming,
    startedAt: Date.parse(run.startedAt || run.createdAt || '') || 0,
  });
  return `<section class="follower-report-detail follower-run-detail">
    <header class="follower-conversation-header"><button type="button" class="follower-icon-button follower-mobile-back" data-follower-run-back title="${escapeAttr(t('report.back'))}" aria-label="${escapeAttr(t('report.back'))}">${iconSvg('chevronLeft')}</button><span class="follower-message-avatar">${iconSvg('telescope')}</span><span><h1>${escapeHtml(reportKindLabel(run.kind, t))}</h1><small><i></i>${escapeHtml(runStatusLabel(run.status, t))} · ${escapeHtml(formatMessageTime(run.startedAt || run.createdAt))}</small></span>${streaming ? `<div class="follower-conversation-actions"><button type="button" class="btn secondary" data-follower-run-cancel="${escapeAttr(run.id)}">${escapeHtml(t('run.cancel'))}</button></div>` : ''}</header>
    <div class="follower-run-conversation">
      <div class="follower-run-stages" aria-label="${escapeAttr(t('run.processUpdate'))}">${renderRunStages(run, t)}</div>
      <div class="follower-message-timeline" data-follower-scroll-region="run:${escapeAttr(run.id)}" data-preserve-scroll data-scroll-key="follower-run:${escapeAttr(run.id)}">
        <div class="follower-date-separator"><span>${escapeHtml(formatReportDate(run.startedAt || run.createdAt, t))}</span></div>
        <article class="follower-message is-assistant follower-process-message">
          <span class="follower-message-avatar">${iconSvg('telescope')}</span>
          <div class="follower-message-stack"><header><strong>${escapeHtml(t('followup.follower'))}</strong><span>${escapeHtml(runStatusLabel(run.status, t))}</span><time>${escapeHtml(formatMessageTime(run.startedAt || run.createdAt))}</time></header>
            <div class="follower-process-transcript">${transcript || `<div class="follower-process-waiting"><span class="follower-spinner"></span><p>${escapeHtml(t('run.waitingForProcess'))}</p></div>`}</div>
          </div>
        </article>
      </div>
    </div>
  </section>`;
}

function renderRunStages(run, t) {
  const stages = ['queued', 'collecting', 'generating', 'validating', 'committing'];
  const current = stages.indexOf(run.status);
  return stages.map((stage, index) => {
    const complete = index < current || run.status === 'completed';
    const active = index === current && runActive(run);
    return `<div class="follower-run-stage ${complete ? 'is-complete' : active ? 'is-active' : ''}"><span>${complete ? iconSvg('check') : active ? '<span class="follower-spinner"></span>' : String(index + 1)}</span><strong>${escapeHtml(t(`run.stage.${stage}`))}</strong></div>`;
  }).join('');
}

function runActive(run) { return ['queued', 'collecting', 'generating', 'validating', 'committing', 'retry_wait'].includes(run?.status); }

function runStatusLabel(status, t) { return t(`run.status.${status}`); }

function renderReportCard(report, t) {
  const data = report.report || {};
  const sourceCount = data.claims?.reduce((ids, claim) => new Set([...ids, ...(claim.sourceRefs || [])]), new Set()).size || 0;
  return `<button type="button" class="follower-report-card ${report.readAt ? '' : 'is-unread'}" data-follower-report-open="${escapeAttr(report.id)}">
    <span class="follower-report-card-icon">${iconSvg(report.kind === 'weekly_review' ? 'clipboard' : report.kind === 'growth_guidance' ? 'evolution' : 'sun')}</span>
    <span class="follower-report-card-body"><small>${escapeHtml(reportTitle(report, t))}${report.remoteProjection ? ` · ${escapeHtml(t('report.remote'))}` : ''}</small><strong>${escapeHtml(reportDisplayText(data.summary, t('status.noActivity')))}</strong><span class="follower-report-counts">${claimCounts(data.claims || [], t)}</span></span>
    <span class="follower-report-card-meta"><time>${escapeHtml(formatMessageTime(report.createdAt))}</time><small>${escapeHtml(t('report.sources', { count: sourceCount }))}</small>${iconSvg('chevronRight')}</span>
  </button>`;
}

function renderReportDetail(report, t, followup, followupBusy, followupStopping, feedback = null, followupDraft = '') {
  const data = report.report || {};
  const messages = followup?.messages || [];
  return `<section class="follower-report-detail">
    <header class="follower-conversation-header">
      <button type="button" class="follower-icon-button follower-mobile-back" data-follower-report-back title="${escapeAttr(t('report.back'))}" aria-label="${escapeAttr(t('report.back'))}">${iconSvg('chevronLeft')}</button>
      <span class="follower-message-avatar">${iconSvg('telescope')}</span><span><h1>${escapeHtml(reportTitle(report, t))}</h1><small><i></i>${escapeHtml(t('conversation.reportReady'))} · ${escapeHtml(formatMessageTime(report.createdAt))}</small></span>
      <div class="follower-conversation-actions"><button type="button" class="follower-icon-button" data-follower-report-read="${escapeAttr(report.id)}" title="${escapeAttr(t('report.markRead'))}" aria-label="${escapeAttr(t('report.markRead'))}">${iconSvg('check')}</button><button type="button" class="follower-icon-button is-danger" data-follower-report-delete="${escapeAttr(report.id)}" title="${escapeAttr(t('report.delete'))}" aria-label="${escapeAttr(t('report.delete'))}">${iconSvg('trash')}</button></div>
    </header>
    <div class="follower-message-timeline" data-follower-scroll-region="report:${escapeAttr(report.id)}" data-preserve-scroll data-scroll-key="follower-report:${escapeAttr(report.id)}">
      <div class="follower-date-separator"><span>${escapeHtml(formatReportDate(report.createdAt, t))}</span></div>
      <article class="follower-message is-assistant">
        <span class="follower-message-avatar">${iconSvg('telescope')}</span>
        <div class="follower-message-stack"><header><strong>${escapeHtml(t('followup.follower'))}</strong><span>${escapeHtml(reportTitle(report, t))}</span><time>${escapeHtml(formatMessageTime(report.createdAt))}</time></header>
          <div class="follower-message-bubble follower-report-document"><h2>${escapeHtml(reportDisplayText(data.summary, t('status.noActivity')))}</h2>${renderClaimGroups(data.claims || [], t, report.id)}${renderSuggestions(data.suggestions || [], report.id, t)}</div>
          ${report.remoteProjection ? '' : `<div class="follower-message-tools"><span>${escapeHtml(t('report.wasHelpful'))}</span><button type="button" class="${feedback?.rating === 'helpful' ? 'is-selected' : ''}" data-follower-feedback="helpful" data-report-id="${escapeAttr(report.id)}" ${feedback?.status === 'submitting' ? 'disabled' : ''}>${iconSvg('check')}${escapeHtml(t('report.helpful'))}</button><button type="button" class="${feedback?.rating === 'not_helpful' ? 'is-selected' : ''}" data-follower-feedback="not_helpful" data-report-id="${escapeAttr(report.id)}" ${feedback?.status === 'submitting' ? 'disabled' : ''}>${escapeHtml(t('report.notHelpful'))}</button></div>`}
        </div>
      </article>
      ${messages.map((message) => renderFollowupMessage(message, t)).join('')}
      ${followupBusy ? `<article class="follower-message is-assistant follower-followup-pending"><span class="follower-message-avatar">${iconSvg('telescope')}</span><div class="follower-message-stack"><header><strong>${escapeHtml(t('followup.follower'))}</strong><span>${escapeHtml(t('followup.replying'))}</span></header><div class="follower-message-bubble"><span class="follower-spinner"></span><p>${escapeHtml(t('followup.replyingDescription'))}</p></div></div></article>` : ''}
    </div>
    ${report.remoteProjection ? `<div class="follower-remote-notice">${iconSvg('lock')}<span>${escapeHtml(t('conversation.remoteReadonly'))}</span></div>` : renderFollowupComposer(report, followupBusy, Boolean(followupStopping), t, followupDraft)}
  </section>`;
}

function renderFollowupMessage(message, t) {
  if (message.role === 'system_error') return `<article class="follower-followup-error"><span>${escapeHtml(message.content || t('followup.failed'))}</span><button type="button" data-follower-followup-retry>${escapeHtml(t('action.retry'))}</button></article>`;
  const isUser = message.role === 'user';
  return `<article class="follower-message ${isUser ? 'is-user' : 'is-assistant'}" data-follower-followup-message="${escapeAttr(message.id || '')}">
    <span class="follower-message-avatar">${isUser ? escapeHtml(t('followup.youAvatar')) : iconSvg('telescope')}</span>
    <div class="follower-message-stack"><header><strong>${escapeHtml(t(isUser ? 'followup.you' : 'followup.follower'))}</strong>${message.createdAt ? `<time>${escapeHtml(formatMessageTime(message.createdAt))}</time>` : ''}</header><div class="follower-message-bubble"><p>${escapeHtml(reportDisplayText(message.content))}</p></div></div>
  </article>`;
}

function renderFollowupComposer(report, busy, stopping, t, draft = '') {
  const mode = busy ? 'stop' : 'send';
  const label = busy ? t('followup.stop') : t('followup.send');
  return `<form class="follower-composer" data-follower-followup-form data-report-id="${escapeAttr(report.id)}" data-followup-busy="${busy ? 'true' : 'false'}"><textarea rows="1" data-follower-followup-input placeholder="${escapeAttr(t('followup.placeholder'))}" aria-label="${escapeAttr(t('followup.placeholder'))}">${escapeHtml(draft)}</textarea><button class="follower-send-button ${busy ? 'is-stop' : ''}" type="submit" data-follower-followup-action data-mode="${mode}" data-send-label="${escapeAttr(t('followup.send'))}" data-stop-label="${escapeAttr(t('followup.stop'))}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" ${stopping ? 'disabled' : ''}><span class="follower-send-icon">${iconSvg('followerSend')}</span><span class="follower-stop-icon">${iconSvg('stop')}</span></button></form>`;
}

function renderSettings(state, overview, t, language) {
  const prefs = overview.preferences || {};
  const models = textModelOptions(state.modelCatalog);
  const modelDraft = followerDraftValue(state, 'preferences:model', prefs.model);
  const selectedModel = models.some(([value]) => value === modelDraft) ? modelDraft : (modelDraft || state.model || models[0]?.[0] || '');
  const reasoningOptions = reasoningOptionsForModel(state.modelCatalog, selectedModel);
  const reasoningDraft = followerDraftValue(state, 'preferences:reasoningEffort', prefs.reasoningEffort);
  const selectedReasoning = reasoningOptions.some(([value]) => value === reasoningDraft) ? reasoningDraft : (modelCatalogEntry(state.modelCatalog, selectedModel)?.defaultReasoningEffort || reasoningOptions[0]?.[0] || 'medium');
  const selectedVerbosity = followerDraftValue(state, 'preferences:verbosity', prefs.verbosity || 'standard');
  return `<section class="follower-settings-page">
    <header class="follower-pane-header"><button type="button" class="follower-icon-button follower-pane-mobile-back" data-follower-mobile-home title="${escapeAttr(t('action.backToFollower'))}" aria-label="${escapeAttr(t('action.backToFollower'))}">${iconSvg('chevronLeft')}</button><span><small>${escapeHtml(t('settings.eyebrow'))}</small><h1>${escapeHtml(t('settings.title'))}</h1><p>${escapeHtml(t('settings.description'))}</p></span></header>
    <div class="follower-settings-group"><header><span class="follower-setting-icon">${iconSvg('shield')}</span><span><h2>${escapeHtml(t('settings.sources'))}</h2><p>${escapeHtml(t('settings.sourcesDescription'))}</p></span></header>
      <div class="follower-source-grid">${fixedSource(t('setup.tasks'), t('setup.tasksDescription'), 'tasks', t)}${fixedSource(t('setup.conversations'), t('setup.conversationsDescription'), 'message', t)}${fixedSource(t('setup.projectMetadata'), t('setup.projectMetadataDescription'), 'folder', t)}${fixedSource(t('setup.projectContent'), t('setup.projectContentDescription'), 'document', t)}</div>
    </div>
    <div class="follower-settings-group follower-personalization"><header><span class="follower-setting-icon">${iconSvg('sliders')}</span><span><h2>${escapeHtml(t('settings.preferences'))}</h2><p>${escapeHtml(t('settings.preferencesDescription'))}</p></span></header>
      <div class="follower-setting-grid"><label class="follower-setting-field"><span><strong>${escapeHtml(t('settings.model'))}</strong><small>${escapeHtml(t('settings.modelDescription'))}</small></span><select data-follower-model>${models.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selectedModel ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label class="follower-setting-field"><span><strong>${escapeHtml(t('settings.reasoningEffort'))}</strong><small>${escapeHtml(t('settings.reasoningEffortDescription'))}</small></span><select data-follower-reasoning-effort>${reasoningOptions.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selectedReasoning ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label class="follower-setting-field"><span><strong>${escapeHtml(t('settings.verbosity'))}</strong><small>${escapeHtml(t('settings.verbosityDescription'))}</small></span><select data-follower-verbosity><option value="short" ${selectedVerbosity === 'short' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityShort'))}</option><option value="standard" ${selectedVerbosity === 'standard' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityStandard'))}</option><option value="detailed" ${selectedVerbosity === 'detailed' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityDetailed'))}</option></select></label></div>
      <section class="follower-prompt-settings"><header><h3>${escapeHtml(t('settings.prompts'))}</h3><p>${escapeHtml(t('settings.promptsDescription'))}</p></header>${FOLLOWER_KINDS.map((item) => { const prompt = followerDraftValue(state, `preferences:prompt:${item.kind}`, prefs.prompts?.[item.kind] || t(`settings.defaultPrompt.${item.kind}`)); return `<label class="follower-prompt-field"><span><strong>${escapeHtml(t(item.title))}</strong><small>${escapeHtml(t(item.description))}</small></span><textarea rows="3" maxlength="2000" data-follower-prompt="${escapeAttr(item.kind)}">${escapeHtml(prompt)}</textarea><em><b data-follower-prompt-count="${escapeAttr(item.kind)}">${String(prompt).length}</b>/2000</em></label>`; }).join('')}</section>
      <footer><button class="btn primary" type="button" data-follower-preferences-save>${escapeHtml(t('settings.save'))}</button></footer>
    </div>
    ${renderSchedules(state, overview, t, language)}
  </section>`;
}

function fixedSource(title, description, icon, t) {
  return `<div class="follower-source-choice is-fixed"><span class="follower-source-icon">${iconSvg(icon)}</span><span class="follower-choice-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span><span class="follower-source-status">${iconSvg('lock')}${escapeHtml(t('settings.readOnly'))}</span></div>`;
}

function renderCapabilitySettings(state, overview, t, language) {
  const item = FOLLOWER_KINDS.find(({ kind }) => kind === state.followerSelectedKind) || FOLLOWER_KINDS[0];
  const prefs = overview.preferences || {};
  const models = textModelOptions(state.modelCatalog);
  const modelDraft = followerDraftValue(state, 'preferences:model', prefs.model);
  const selectedModel = models.some(([value]) => value === modelDraft) ? modelDraft : (modelDraft || state.model || models[0]?.[0] || '');
  const reasoningOptions = reasoningOptionsForModel(state.modelCatalog, selectedModel);
  const reasoningDraft = followerDraftValue(state, 'preferences:reasoningEffort', prefs.reasoningEffort);
  const selectedReasoning = reasoningOptions.some(([value]) => value === reasoningDraft) ? reasoningDraft : (modelCatalogEntry(state.modelCatalog, selectedModel)?.defaultReasoningEffort || reasoningOptions[0]?.[0] || 'medium');
  const selectedVerbosity = followerDraftValue(state, 'preferences:verbosity', prefs.verbosity || 'standard');
  const schedule = scheduleWithDraft(state, scheduleForKind(overview, item.kind));
  const prompt = followerDraftValue(state, `preferences:prompt:${item.kind}`, prefs.prompts?.[item.kind] || t(`settings.defaultPrompt.${item.kind}`));
  const history = (state.followerReports || []).filter((report) => report.kind === item.kind);
  const running = overview.status?.activeRun?.kind === item.kind;
  return `<section class="follower-capability-page" data-follower-capability-page="${escapeAttr(item.kind)}">
    <header class="follower-capability-header"><span><small><i></i>${escapeHtml(running ? t('status.working') : schedule.enabled ? t('capabilities.arranged') : t('capabilities.available'))}</small><h1>${escapeHtml(t(item.title))}</h1><p>${escapeHtml(t(item.description))}</p></span></header>
    <label class="follower-capability-prompt"><span>${escapeHtml(t('capabilities.request'))}</span><textarea rows="4" maxlength="2000" data-follower-capability-prompt>${escapeHtml(prompt)}</textarea><small><b data-follower-capability-prompt-count>${prompt.length}</b>/2000</small></label>
    <div class="follower-capability-config">
      <section><header><h2>${escapeHtml(t('capabilities.details'))}</h2></header><label><span>${escapeHtml(t('settings.model'))}</span><select data-follower-capability-model>${models.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selectedModel ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label><span>${escapeHtml(t('settings.reasoningEffort'))}</span><select data-follower-capability-reasoning-effort>${reasoningOptions.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selectedReasoning ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label><span>${escapeHtml(t('settings.verbosity'))}</span><select data-follower-capability-verbosity><option value="short" ${selectedVerbosity === 'short' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityShort'))}</option><option value="standard" ${selectedVerbosity === 'standard' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityStandard'))}</option><option value="detailed" ${selectedVerbosity === 'detailed' ? 'selected' : ''}>${escapeHtml(t('settings.verbosityDetailed'))}</option></select></label></section>
      <section><header><h2>${escapeHtml(t('schedule.title'))}</h2><label class="follower-switch"><input type="checkbox" data-schedule-enabled ${schedule.enabled ? 'checked' : ''}><span></span><em>${escapeHtml(t('schedule.enabled'))}</em></label></header><div class="follower-config-schedule" data-follower-schedule-card="${escapeAttr(item.kind)}" data-frequency="${escapeAttr(schedule.frequency)}"><div class="follower-day-field"><span>${escapeHtml(t('schedule.days'))}</span><div class="follower-day-picker">${[1, 2, 3, 4, 5, 6, 7].map((day) => `<label title="${escapeAttr(weekdayLabel(day, language, 'long'))}"><input type="checkbox" data-schedule-day value="${day}" ${(schedule.daysOfWeek || []).includes(day) ? 'checked' : ''} ${schedule.frequency === 'weekly' ? 'data-single-day' : ''}><span>${escapeHtml(weekdayLabel(day, language, 'narrow'))}</span></label>`).join('')}</div></div><label class="follower-time-field"><span>${escapeHtml(t('schedule.time'))}</span><span class="follower-time-picker">${timeSelect(schedule.localTime, 'hour')}${timeSelect(schedule.localTime, 'minute')}</span></label><p>${iconSvg('clock')}${escapeHtml(t('schedule.localTimezone', { timezone: schedule.timezone }))}</p></div></section>
    </div>
    <footer class="follower-capability-footer"><button type="button" class="btn secondary" data-follower-capability-save="${escapeAttr(item.kind)}">${escapeHtml(t('capabilities.save'))}</button></footer>
    <section class="follower-capability-history"><header><h2>${escapeHtml(t('capabilities.history'))}</h2><small>${escapeHtml(t('capabilities.historyDescription'))}</small></header>${history.length ? `<div class="follower-capability-history-list">${history.map((report) => `<button type="button" class="follower-latest-report" data-follower-report-open="${escapeAttr(report.id)}"><span><strong>${escapeHtml(reportTitle(report, t))}</strong><small>${escapeHtml(reportDisplayText(report.report?.summary, t('status.noActivity')))}</small></span>${iconSvg('chevronRight')}</button>`).join('')}</div>` : `<p>${escapeHtml(t('capabilities.noHistory'))}</p>`}</section>
  </section>`;
}

function scheduleForKind(overview, kind) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const defaults = {
    daily_brief: { frequency: 'daily', daysOfWeek: [1, 2, 3, 4, 5], localTime: '18:00' },
    weekly_review: { frequency: 'weekly', daysOfWeek: [5], localTime: '18:30' },
    growth_guidance: { frequency: 'weekly', daysOfWeek: [1], localTime: '09:30' },
  };
  return { kind, timezone, enabled: false, ...defaults[kind], ...(overview.schedules || []).find((entry) => entry.kind === kind) };
}

function renderSchedules(state, overview, t, language) {
  const defaults = FOLLOWER_KINDS.map(({ kind }) => scheduleWithDraft(state, scheduleForKind(overview, kind)));
  return `<div class="follower-settings-group follower-schedules"><header><span class="follower-setting-icon">${iconSvg('clock')}</span><span><h2>${escapeHtml(t('schedule.title'))}</h2><p>${escapeHtml(t('schedule.description'))}</p></span></header><div class="follower-schedule-list">${defaults.map((fallback) => {
    const schedule = fallback;
    const nextLabel = schedule.nextOccurrenceAt ? new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: schedule.timezone }).format(new Date(schedule.nextOccurrenceAt)) : t('schedule.notScheduled');
    return `<article class="follower-schedule-card" data-follower-schedule-card="${escapeAttr(schedule.kind)}" data-frequency="${escapeAttr(schedule.frequency)}">
      <header><span><strong>${escapeHtml(reportKindLabel(schedule.kind, t))}</strong><small>${escapeHtml(t('schedule.nextRun', { time: nextLabel }))}</small></span><label class="follower-switch"><input type="checkbox" data-schedule-enabled ${schedule.enabled ? 'checked' : ''}><span></span><em>${escapeHtml(t('schedule.enabled'))}</em></label></header>
      <div class="follower-schedule-fields"><div class="follower-day-field"><span>${escapeHtml(t('schedule.days'))}</span><div class="follower-day-picker">${[1, 2, 3, 4, 5, 6, 7].map((day) => `<label title="${escapeAttr(weekdayLabel(day, language, 'long'))}"><input type="checkbox" data-schedule-day value="${day}" ${(schedule.daysOfWeek || []).includes(day) ? 'checked' : ''} ${schedule.frequency === 'weekly' ? 'data-single-day' : ''}><span>${escapeHtml(weekdayLabel(day, language, 'narrow'))}</span></label>`).join('')}</div></div><label class="follower-time-field"><span>${escapeHtml(t('schedule.time'))}</span><span class="follower-time-picker">${timeSelect(schedule.localTime, 'hour')}${timeSelect(schedule.localTime, 'minute')}</span></label></div>
      <p class="follower-schedule-note">${iconSvg('clock')}${escapeHtml(t('schedule.localTimezone', { timezone: schedule.timezone }))}</p>
      <footer><button type="button" class="btn secondary" data-follower-schedule-save="${escapeAttr(schedule.kind)}">${escapeHtml(t('schedule.save'))}</button></footer>
    </article>`;
  }).join('')}</div></div>`;
}

function renderClaimGroups(claims, t, reportId) {
  const groups = [['completed', 'report.completed', 'check'], ['in_progress', 'report.inProgress', 'clock'], ['blocked', 'report.blocked', 'flag'], ['waiting_for_input', 'report.waiting', 'helpCircle'], ['discussed_not_executed', 'report.discussed', 'message']];
  return groups.map(([status, key, icon]) => {
    const items = claims.filter((item) => item.status === status);
    return items.length ? `<section class="follower-claim-group is-${escapeAttr(status)}"><header><span>${iconSvg(icon)}</span><h3>${escapeHtml(t(key))}</h3><b>${items.length}</b></header>${items.map((item) => `<article class="follower-claim"><p>${escapeHtml(reportDisplayText(item.text))}</p>${sourceButton(reportId, item.sourceRefs || [], t)}</article>`).join('')}</section>` : '';
  }).join('');
}

function renderSuggestions(suggestions, reportId, t) {
  return suggestions.length ? `<section class="follower-claim-group is-suggestion"><header><span>${iconSvg('spark')}</span><h3>${escapeHtml(t('report.suggestions'))}</h3><b>${suggestions.length}</b></header>${suggestions.map((item) => `<article class="follower-claim"><strong>${escapeHtml(reportDisplayText(item.title))}</strong><p>${escapeHtml(reportDisplayText(item.perspective || item.researchQuestion || item.rationale || item.expectedValue))}</p>${sourceButton(reportId, item.sourceRefs || [], t)}</article>`).join('')}</section>` : '';
}

function sourceButton(reportId, sourceRefs, t) {
  const refs = (sourceRefs || []).filter(Boolean);
  return refs.length ? `<button type="button" class="follower-source-link" data-follower-sources-open data-report-id="${escapeAttr(reportId)}" data-follower-source-refs="${escapeAttr(refs.join(','))}">${iconSvg('external')}${escapeHtml(t('report.sources', { count: refs.length }))}</button>` : '';
}

function renderSourceDrawer(state, t) {
  const drawer = state.followerSourceDrawer || {};
  const sources = drawer.sources || [];
  return `<div class="follower-source-layer" data-follower-sources-close><aside class="follower-source-drawer" role="dialog" aria-modal="true" aria-label="${escapeAttr(t('sources.title'))}">
    <header><span><strong>${escapeHtml(t('sources.title'))}</strong><small>${escapeHtml(t('sources.revalidated'))}</small></span><button type="button" data-follower-sources-close aria-label="${escapeAttr(t('sources.close'))}">${iconSvg('x')}</button></header>
    <div class="follower-source-list">${state.followerSourceDrawerLoading ? `<div class="follower-state-card"><span class="follower-spinner"></span><strong>${escapeHtml(t('sources.loading'))}</strong></div>` : drawer.error ? `<div class="follower-state-card is-error"><p>${escapeHtml(drawer.error)}</p></div>` : renderSourceGroups(sources, t) || `<div class="follower-state-card"><p>${escapeHtml(t('sources.empty'))}</p></div>`}</div>
  </aside></div>`;
}

function renderSourceGroups(sources, t) {
  return groupReportSources(sources).map((group) => {
    const state = groupedAvailability(group.sources);
    const conversation = group.sourceKind === 'agent_message';
    const title = conversation ? conversationSourceTitle(group, t) : reportDisplayText(group.title, t('sources.unknown'));
    const metadata = sourceGroupMetadata(group, t);
    const icon = conversation ? 'message' : group.sourceKind === 'task_run' ? 'tasks'
      : group.sourceKind === 'project_change' ? 'folder' : group.sourceKind === 'project_file_excerpt' ? 'document' : 'external';
    return `<article class="follower-source-group is-${escapeAttr(state)}">
      <span class="follower-source-group-icon">${iconSvg(icon)}</span>
      <span class="follower-source-group-copy"><strong>${escapeHtml(title)}</strong><small>${metadata.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</small></span>
      <span class="follower-source-group-state"><b>${escapeHtml(t('sources.evidenceCount', { count: group.sources.length }))}</b><em>${escapeHtml(t(`sources.state.${state}`))}</em></span>
    </article>`;
  }).join('');
}

function groupReportSources(sources) {
  const groups = new Map();
  (sources || []).forEach((source, index) => {
    const key = source.groupKey || source.refId || `source:${index}`;
    const group = groups.get(key) || { sourceKind: source.sourceKind || '', title: source.title || '', agentLabel: source.agentLabel || '', sources: [] };
    group.sources.push(source);
    if (!group.title && source.title) group.title = source.title;
    if (!group.agentLabel && source.agentLabel) group.agentLabel = source.agentLabel;
    groups.set(key, group);
  });
  return [...groups.values()];
}

function conversationSourceTitle(group, t) {
  const title = reportDisplayText(group.title);
  const generic = !title || /^(?:新对话(?:\s*\d+)?|未命名|untitled|new (?:chat|conversation)|agent conversation)$/i.test(title);
  if (!generic) return title;
  return group.agentLabel ? t('sources.conversationWithAgent', { agent: group.agentLabel }) : t('sources.conversation');
}

function sourceGroupMetadata(group, t) {
  const items = [];
  const customConversationTitle = group.sourceKind === 'agent_message'
    && !/^(?:新对话(?:\s*\d+)?|未命名|untitled|new (?:chat|conversation)|agent conversation)$/i.test(reportDisplayText(group.title));
  if (customConversationTitle && group.agentLabel) items.push(group.agentLabel);
  if (group.sourceKind === 'agent_message') {
    for (const role of ['user', 'assistant']) {
      const count = group.sources.filter((source) => source.role === role).length;
      if (count) items.push(`${t(`sources.role.${role}`)}${count > 1 ? ` ${count}` : ''}`);
    }
  } else {
    items.push(sourceKindLabel(group.sourceKind, t));
  }
  const times = group.sources.map((source) => source.occurredAt).filter((value) => Number.isFinite(Date.parse(value))).sort();
  if (times.length) {
    const first = formatMessageTime(times[0]);
    const last = formatMessageTime(times[times.length - 1]);
    items.push(first === last ? first : `${first} – ${last}`);
  }
  return items.filter(Boolean);
}

function groupedAvailability(sources) {
  const priority = ['permission_changed', 'withdrawn', 'deleted', 'local_unavailable', 'changed', 'available'];
  const states = new Set((sources || []).map((source) => source.availabilityState || 'local_unavailable'));
  return priority.find((state) => states.has(state)) || 'local_unavailable';
}

function reportDisplayText(value = '', fallback = '') {
  let text = String(value || '').replace(
    /[（(\[]\s*source_[a-z0-9_-]+(?:\s*[,，、;；]\s*source_[a-z0-9_-]+)*\s*[）)\]]/gi,
    '',
  );
  text = text.replace(/source_[a-z0-9_-]+/gi, '')
    .replace(/[（(\[]\s*[,，、;；\s]*[）)\]]/g, '')
    .replace(/\s+([,，。.!！？?；;：:])/g, '$1')
    .replace(/([,，、;；])\s*(?=[,，、;；]|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text || String(fallback || '');
}

function sourceKindLabel(kind, t) {
  const key = ['task_run', 'agent_message', 'project_change', 'project_file_excerpt'].includes(kind) ? `sources.kind.${kind}` : 'sources.unknown';
  return t(key);
}

function claimCounts(claims, t) {
  const entries = [['completed', 'report.completed'], ['in_progress', 'report.inProgress'], ['blocked', 'report.blocked'], ['waiting_for_input', 'report.waiting']];
  return entries.map(([status, key]) => { const count = claims.filter((item) => item.status === status).length; return count ? `<span class="is-${escapeAttr(status)}"><i></i>${escapeHtml(t(key))} <b>${count}</b></span>` : ''; }).join('');
}

function reportKindLabel(kind, t) {
  return kind === 'weekly_review' ? t('run.weeklyTitle') : kind === 'growth_guidance' ? t('run.growthTitle') : t('run.dailyTitle');
}

function reportTitle(report, t) {
  const date = new Date(report?.createdAt);
  const valid = Number.isFinite(date.getTime());
  const monthDay = valid ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date).replace('/', '-') : '';
  const time = valid ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date) : '';
  return `${reportKindLabel(report?.kind, t)}-${monthDay}${monthDay ? ' ' : ''}${time}`;
}

function reportTimestamp(report) {
  const value = Date.parse(report?.createdAt || report?.updatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function reportDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value || 'unknown');
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatReportDate(value, t) {
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString() ? t('conversation.today') : date.toLocaleDateString();
}

function weekdayLabel(day, language, width = 'short') {
  const date = new Date(Date.UTC(2026, 7, 3 + Number(day) - 1));
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { weekday: width, timeZone: 'UTC' }).format(date);
}

function timeSelect(localTime, part) {
  const [hour = '00', minute = '00'] = String(localTime || '').split(':');
  const values = Array.from({ length: part === 'hour' ? 24 : 60 }, (_, value) => String(value).padStart(2, '0'));
  const selected = part === 'hour' ? hour : minute;
  return `<select data-schedule-${part} aria-label="${part}">${values.map((value) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}</option>`).join('')}</select>${part === 'hour' ? '<b>:</b>' : ''}`;
}
