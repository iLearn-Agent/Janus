import { followerText } from './i18n/index.js';
import { modelCatalogEntry, reasoningOptionsForModel } from '../../constants.js';

export function createFollowerController({ api, state, render: renderApplication, notify, userVisibleErrorMessage, clearSocialChatSelection = null } = {}) {
  let refreshRequestId = 0;
  let updatedRefreshTimer = null;
  let followupRequestId = 0;
  const t = (key, params) => followerText(key, state.languageMode, params);
  const activeOwnerUserId = () => String(state.currentUser?.id || '').trim();
  const followerOwnerUserId = () => String(state.followerOwnerUserId || activeOwnerUserId()).trim();
  const activeWorkspaceId = () => String(state.activeAccountWorkspace?.id || 'workspace_personal').trim() || 'workspace_personal';
  const followerWorkspaceId = () => String(state.followerWorkspaceId || activeWorkspaceId()).trim() || 'workspace_personal';
  const workspacePayload = (payload = {}, workspaceId = followerWorkspaceId()) => ({ ...payload, workspaceId });
  const workspaceRequestIsCurrent = (workspaceId, generation) => (
    workspaceId === followerWorkspaceId()
    && followerOwnerUserId() === activeOwnerUserId()
    && Number(generation || 0) === Number(state.workspaceSwitchGeneration || 0)
  );
  const preferenceDraftKeys = (kind = '') => [
    'preferences:model', 'preferences:reasoningEffort', 'preferences:verbosity',
    ...(kind ? [`preferences:prompt:${kind}`] : ['daily_brief', 'weekly_review', 'growth_guidance'].map((item) => `preferences:prompt:${item}`)),
  ];
  const scheduleDraftKeys = (kind) => ['days', 'hour', 'minute'].map((part) => `schedule:${kind}:${part}`);
  const setFormDraft = (key, value) => {
    state.followerFormDraft = { ...(state.followerFormDraft || {}), [key]: value };
  };
  const clearFormDraft = (keys) => {
    const next = { ...(state.followerFormDraft || {}) };
    keys.forEach((key) => { delete next[key]; });
    state.followerFormDraft = next;
  };
  const setFollowupDraft = (reportId, value) => {
    if (!reportId) return;
    const next = { ...(state.followerFollowupDrafts || {}) };
    if (value) next[reportId] = value;
    else delete next[reportId];
    state.followerFollowupDrafts = next;
  };
  const applyPreferenceResult = (result) => {
    if (!result?.preferences) return;
    state.followerOverview = {
      ...(state.followerOverview || {}),
      preferences: result.preferences,
      preferenceRevision: result.preferenceRevision ?? state.followerOverview?.preferenceRevision,
    };
  };
  const applyScheduleResult = (schedule) => {
    if (!schedule?.kind) return;
    const schedules = (state.followerOverview?.schedules || []).filter((item) => item.kind !== schedule.kind);
    state.followerOverview = { ...(state.followerOverview || {}), schedules: [...schedules, schedule] };
  };
  const render = () => {
    const documentRef = globalThis.document;
    const previousInput = documentRef?.querySelector?.('[data-follower-followup-input]');
    const followupDraft = previousInput?.value || '';
    const followupInputFocused = previousInput === documentRef?.activeElement;
    const scrollPositions = new Map([...documentRef?.querySelectorAll?.('[data-follower-scroll-region]') || []]
      .map((element) => [element.dataset.followerScrollRegion, { top: element.scrollTop, left: element.scrollLeft }]));
    renderApplication?.();
    for (const element of documentRef?.querySelectorAll?.('[data-follower-scroll-region]') || []) {
      const position = scrollPositions.get(element.dataset.followerScrollRegion);
      if (!position) continue;
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
    }
    const nextInput = documentRef?.querySelector?.('[data-follower-followup-input]');
    if (nextInput && followupDraft) nextInput.value = followupDraft;
    if (nextInput) updateFollowupAction(nextInput.form);
    if (nextInput && followupInputFocused) nextInput.focus({ preventScroll: true });
  };
  function cancelFollowupRequest() {
    state.followerFollowupBusy = false;
    state.followerFollowupStopping = false;
    followupRequestId += 1;
  }

  function updateFollowupAction(form) {
    const input = form?.querySelector?.('[data-follower-followup-input]');
    const button = form?.querySelector?.('[data-follower-followup-action]');
    if (!input || !button) return;
    const mode = state.followerFollowupBusy && !String(input.value || '').trim() ? 'stop' : 'send';
    const label = mode === 'stop' ? button.dataset.stopLabel : button.dataset.sendLabel;
    button.dataset.mode = mode;
    button.classList.toggle('is-stop', mode === 'stop');
    button.title = label || '';
    button.setAttribute('aria-label', label || '');
    button.disabled = Boolean(state.followerFollowupStopping);
  }

  async function interruptFollowup(form) {
    const threadId = state.followerFollowup?.id || '';
    if (!threadId || !state.followerFollowupBusy || state.followerFollowupStopping) return;
    const requestId = ++followupRequestId;
    state.followerFollowupStopping = true;
    render();
    try {
      const nextFollowup = await api.followerFollowupCancel(workspacePayload({ threadId }));
      if (requestId === followupRequestId) state.followerFollowup = nextFollowup;
    } catch (error) {
      if (requestId === followupRequestId) notify(userVisibleErrorMessage(error, t('followup.stopFailed')), 'error');
    } finally {
      if (requestId === followupRequestId) {
        state.followerFollowupBusy = false;
        state.followerFollowupStopping = false;
        render();
        globalThis.document?.querySelector?.('[data-follower-followup-input]')?.focus?.();
      }
    }
  }

  function scrollFollowupToEnd() {
    const timeline = globalThis.document?.querySelector?.('.follower-report-detail .follower-message-timeline');
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }

  function followupTimelineShouldFollowBottom(tolerance = 48) {
    const timeline = globalThis.document?.querySelector?.('.follower-report-detail .follower-message-timeline');
    if (!timeline) return true;
    return Math.max(0, timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) <= tolerance;
  }

  function resetWorkspace(workspaceId = activeWorkspaceId()) {
    if (updatedRefreshTimer) clearTimeout(updatedRefreshTimer);
    updatedRefreshTimer = null;
    refreshRequestId += 1;
    cancelFollowupRequest();
    state.followerOwnerUserId = activeOwnerUserId();
    state.followerWorkspaceId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
    state.followerOverview = null;
    state.followerOverviewLoading = false;
    state.followerOverviewError = '';
    state.followerReports = [];
    state.followerRuns = [];
    state.followerActiveSection = 'overview';
    state.followerSelectedKind = '';
    state.followerSelectedReport = null;
    state.followerSelectedRun = null;
    state.followerSourceDrawer = null;
    state.followerSourceDrawerLoading = false;
    state.followerFollowup = null;
    state.followerFollowupDrafts = {};
    state.followerFormDraft = {};
    state.followerReportFeedback = {};
  }

  async function open() {
    const workspaceId = activeWorkspaceId();
    if (followerOwnerUserId() !== activeOwnerUserId() || followerWorkspaceId() !== workspaceId || !state.followerWorkspaceId) {
      resetWorkspace(workspaceId);
    }
    state.currentTab = 'chat';
    state.networkPanelOpen = true;
    state.networkPanelView = 'messages';
    state.networkMessageHomeOpen = false;
    state.messageActivePane = 'conversation';
    state.followerWorkspaceOpen = true;
    clearSocialChatSelection?.();
    render();
    await refresh({ workspaceId });
  }

  function close() {
    if (updatedRefreshTimer) clearTimeout(updatedRefreshTimer);
    updatedRefreshTimer = null;
    state.followerWorkspaceOpen = false;
    state.followerSourceDrawer = null;
    state.followerSelectedReport = null;
    state.followerSelectedRun = null;
    cancelFollowupRequest();
    state.followerFollowup = null;
    state.followerSelectedKind = '';
    state.followerFormDraft = {};
    state.followerFollowupDrafts = {};
    state.networkMessageHomeOpen = true;
    state.messageActivePane = 'list';
  }

  async function refresh({ reports = true, workspaceId = followerWorkspaceId() } = {}) {
    const scopedWorkspaceId = String(workspaceId || 'workspace_personal').trim() || 'workspace_personal';
    const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
    if (!state.followerOwnerUserId) state.followerOwnerUserId = activeOwnerUserId();
    if (!state.followerWorkspaceId) state.followerWorkspaceId = scopedWorkspaceId;
    const requestId = ++refreshRequestId;
    state.followerOverviewLoading = !state.followerOverview;
    state.followerOverviewError = '';
    if (state.followerOverviewLoading) render();
    try {
      const overview = await api.followerOverview(workspacePayload({}, scopedWorkspaceId));
      if (requestId !== refreshRequestId || !workspaceRequestIsCurrent(scopedWorkspaceId, workspaceGeneration)) return;
      state.followerOverview = overview;
      if (reports && overview?.setup?.configured) {
        const selectedRunId = String(state.followerSelectedRun?.id || '');
        const selectedRunWasActive = Boolean(selectedRunId && !['completed', 'failed', 'skipped_no_activity',
          'cancelled_authorization_changed', 'cancelled_user_changed'].includes(state.followerSelectedRun?.status));
        const [nextReports, nextRuns] = await Promise.all([
          api.followerReportsList(workspacePayload({ limit: 100 }, scopedWorkspaceId)),
          api.followerRunsList(workspacePayload({ limit: 100 }, scopedWorkspaceId)),
        ]);
        if (requestId !== refreshRequestId || !workspaceRequestIsCurrent(scopedWorkspaceId, workspaceGeneration)) return;
        state.followerReports = nextReports;
        state.followerRuns = nextRuns;
        if (selectedRunId) {
          const nextSelectedRun = state.followerRuns.find((run) => run.id === selectedRunId) || state.followerSelectedRun;
          state.followerSelectedRun = nextSelectedRun;
          const completedReportId = selectedRunWasActive && nextSelectedRun?.status === 'completed'
            ? String(nextSelectedRun.reportId || '') : '';
          if (completedReportId && state.followerReports.some((report) => report.id === completedReportId)) {
            await openReport(completedReportId);
          }
        }
      }
    } catch (error) {
      if (requestId === refreshRequestId && workspaceRequestIsCurrent(scopedWorkspaceId, workspaceGeneration)) {
        state.followerOverviewError = userVisibleErrorMessage(error, t('status.failed'));
      }
    } finally {
      if (requestId === refreshRequestId && workspaceRequestIsCurrent(scopedWorkspaceId, workspaceGeneration)) {
        state.followerOverviewLoading = false;
        render();
      }
    }
  }

  function capabilityPayload(page, kind, { forceEnabled = null } = {}) {
    const card = page?.querySelector('[data-follower-schedule-card]');
    const hour = card?.querySelector('[data-schedule-hour]')?.value || '00';
    const minute = card?.querySelector('[data-schedule-minute]')?.value || '00';
    return {
      preferences: {
        ...(state.followerOverview?.preferences || {}),
        model: page?.querySelector('[data-follower-capability-model]')?.value || '',
        reasoningEffort: page?.querySelector('[data-follower-capability-reasoning-effort]')?.value || 'medium',
        verbosity: page?.querySelector('[data-follower-capability-verbosity]')?.value || 'standard',
        prompts: {
          ...(state.followerOverview?.preferences?.prompts || {}),
          [kind]: page?.querySelector('[data-follower-capability-prompt]')?.value.trim() || '',
        },
      },
      schedule: {
        kind,
        enabled: forceEnabled ?? Boolean(page?.querySelector('[data-schedule-enabled]')?.checked),
        frequency: card?.dataset.frequency || 'daily',
        daysOfWeek: [...(card?.querySelectorAll('[data-schedule-day]:checked') || [])].map((input) => Number(input.value)),
        localTime: `${hour}:${minute}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      },
    };
  }

  async function saveCapability(page, kind, { forceEnabled = null } = {}) {
    const payload = capabilityPayload(page, kind, { forceEnabled });
    const preferenceResult = await api.followerPreferencesUpdate(workspacePayload({ preferences: payload.preferences, expectedRevision: state.followerOverview?.preferenceRevision || 0 }));
    applyPreferenceResult(preferenceResult);
    const scheduleResult = await api.followerScheduleUpsert(workspacePayload({ schedule: payload.schedule }));
    applyScheduleResult(scheduleResult);
  }

  function schedulePayload(card, kind, enabled) {
    const hour = card?.querySelector('[data-schedule-hour]')?.value || '00';
    const minute = card?.querySelector('[data-schedule-minute]')?.value || '00';
    return {
      kind,
      enabled,
      frequency: card?.dataset.frequency || 'daily',
      daysOfWeek: [...(card?.querySelectorAll('[data-schedule-day]:checked') || [])].map((input) => Number(input.value)),
      localTime: `${hour}:${minute}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    };
  }

  function scheduleCardForControl(control) {
    const container = control?.closest?.('[data-follower-capability-page], [data-follower-schedule-card]');
    return container?.matches?.('[data-follower-schedule-card]')
      ? container
      : container?.querySelector?.('[data-follower-schedule-card]');
  }

  function captureScheduleDraft(control) {
    const card = scheduleCardForControl(control);
    const kind = card?.dataset.followerScheduleCard || state.followerSelectedKind || '';
    if (!card || !kind) return;
    setFormDraft(`schedule:${kind}:days`, [...card.querySelectorAll('[data-schedule-day]:checked')].map((input) => Number(input.value)));
    setFormDraft(`schedule:${kind}:hour`, card.querySelector('[data-schedule-hour]')?.value || '00');
    setFormDraft(`schedule:${kind}:minute`, card.querySelector('[data-schedule-minute]')?.value || '00');
  }

  async function openReport(reportId) {
    const workspaceId = followerWorkspaceId();
    const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
    try {
      state.followerSourceDrawer = null;
      cancelFollowupRequest();
      state.followerActiveSection = 'reports';
      state.followerSelectedKind = state.followerReports?.find((report) => report.id === reportId)?.kind || '';
      state.followerSelectedRun = null;
      const report = await api.followerReportOpen(workspacePayload({ reportId }, workspaceId));
      if (!workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) return;
      state.followerSelectedReport = report;
      await api.followerReportMarkRead(workspacePayload({ reportId }, workspaceId));
      if (!workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) return;
      state.followerFollowup = report?.remoteProjection ? null : await api.followerFollowupOpen(workspacePayload({ reportId }, workspaceId));
      if (!workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) return;
      state.followerFollowupBusy = Boolean(state.followerFollowup?.active);
      state.followerFollowupStopping = false;
      render();
    } catch (error) {
      if (workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) {
        notify(userVisibleErrorMessage(error, t('status.failed')), 'error');
      }
    }
  }

  function openRun(runId) {
    const run = state.followerRuns?.find((item) => item.id === runId)
      || (state.followerOverview?.status?.activeRun?.id === runId ? state.followerOverview.status.activeRun : null);
    if (!run) return;
    cancelFollowupRequest();
    state.followerActiveSection = 'reports';
    state.followerSelectedReport = null;
    state.followerSelectedRun = run;
    state.followerFollowup = null;
    render();
  }

  async function openSources(reportId, sourceRefs = []) {
    const workspaceId = followerWorkspaceId();
    const workspaceGeneration = Number(state.workspaceSwitchGeneration || 0);
    state.followerSourceDrawerLoading = true;
    state.followerSourceDrawer = { reportId, sources: [], sourceRefs };
    render();
    try {
      const allSources = await api.followerReportSources(workspacePayload({ reportId }, workspaceId));
      if (!workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) return;
      const allowed = new Set(sourceRefs);
      state.followerSourceDrawer = { reportId, sourceRefs, sources: (allSources || []).filter((item) => allowed.has(item.refId)) };
    } catch (error) {
      if (workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) {
        state.followerSourceDrawer = { reportId, sourceRefs, sources: [], error: userVisibleErrorMessage(error, t('status.failed')) };
      }
    } finally {
      if (workspaceRequestIsCurrent(workspaceId, workspaceGeneration)) {
        state.followerSourceDrawerLoading = false;
        render();
      }
    }
  }

  function wire(documentRef) {
    documentRef.querySelectorAll('[data-message-system-entry="follower"]').forEach((button) => button.addEventListener('click', open));
    documentRef.querySelectorAll('[data-follower-close]').forEach((button) => button.addEventListener('click', () => { close(); render(); }));
    documentRef.querySelectorAll('[data-follower-refresh]').forEach((button) => button.addEventListener('click', () => refresh()));
    documentRef.querySelectorAll('[data-follower-rail-toggle]').forEach((button) => button.addEventListener('click', () => {
      state.followerRailCollapsed = !state.followerRailCollapsed;
      render();
    }));
    documentRef.querySelectorAll('[data-follower-section]').forEach((button) => button.addEventListener('click', async () => {
      cancelFollowupRequest();
      state.followerActiveSection = button.dataset.followerSection || 'overview';
      state.followerSelectedKind = '';
      state.followerSelectedReport = null;
      state.followerSelectedRun = null;
      if (state.followerActiveSection === 'reports' && !state.followerReports?.length) await refresh();
      else render();
    }));
    documentRef.querySelectorAll('[data-follower-show-reports]').forEach((button) => button.addEventListener('click', async () => {
      cancelFollowupRequest();
      state.followerActiveSection = 'reports';
      state.followerSelectedKind = '';
      state.followerSelectedReport = null;
      state.followerSelectedRun = null;
      state.followerFollowup = null;
      if (!state.followerReports?.length) await refresh();
      else render();
    }));
    documentRef.querySelectorAll('[data-follower-report-filter]').forEach((button) => button.addEventListener('click', () => {
      state.followerReportFilter = button.dataset.followerReportFilter || 'all';
      render();
    }));
    documentRef.querySelectorAll('[data-follower-mobile-home]').forEach((button) => button.addEventListener('click', () => {
      cancelFollowupRequest();
      state.followerActiveSection = 'overview';
      state.followerSelectedKind = '';
      state.followerSelectedReport = null;
      state.followerSelectedRun = null;
      state.followerFollowup = null;
      state.followerSourceDrawer = null;
      render();
    }));
    documentRef.querySelectorAll('[data-follower-capability]').forEach((button) => button.addEventListener('click', () => {
      cancelFollowupRequest();
      state.followerActiveSection = 'capability';
      state.followerSelectedKind = button.dataset.followerCapability || 'daily_brief';
      state.followerSelectedReport = null;
      state.followerSelectedRun = null;
      state.followerFollowup = null;
      state.followerSourceDrawer = null;
      render();
    }));
    documentRef.querySelectorAll('[data-follower-run-cancel]').forEach((button) => button.addEventListener('click', async () => { await api.followerRunCancel(workspacePayload({ runId: button.dataset.followerRunCancel || '' })); await refresh(); }));
    documentRef.querySelectorAll('[data-follower-run-open]').forEach((button) => button.addEventListener('click', () => openRun(button.dataset.followerRunOpen || '')));
    documentRef.querySelectorAll('[data-follower-run-back]').forEach((button) => button.addEventListener('click', () => { state.followerSelectedRun = null; render(); }));
    documentRef.querySelectorAll('[data-follower-report-open]').forEach((button) => button.addEventListener('click', () => openReport(button.dataset.followerReportOpen || '')));
    documentRef.querySelectorAll('[data-follower-report-back]').forEach((button) => button.addEventListener('click', () => { cancelFollowupRequest(); state.followerSelectedReport = null; state.followerFollowup = null; state.followerSourceDrawer = null; render(); }));
    documentRef.querySelectorAll('[data-follower-sources-open]').forEach((button) => button.addEventListener('click', () => {
      const refs = String(button.dataset.followerSourceRefs || '').split(',').map((item) => item.trim()).filter(Boolean);
      openSources(button.dataset.reportId || state.followerSelectedReport?.id || '', refs);
    }));
    documentRef.querySelectorAll('[data-follower-sources-close]').forEach((button) => button.addEventListener('click', () => { state.followerSourceDrawer = null; render(); }));
    documentRef.querySelectorAll('[data-follower-report-read]').forEach((button) => button.addEventListener('click', async () => { await api.followerReportMarkRead(workspacePayload({ reportId: button.dataset.followerReportRead || '' })); await refresh(); }));
    documentRef.querySelectorAll('[data-follower-report-delete]').forEach((button) => button.addEventListener('click', async () => {
      if (!globalThis.confirm(t('action.confirmDelete'))) return;
      const reportId = button.dataset.followerReportDelete || '';
      await api.followerReportDelete(workspacePayload({ reportId }));
      setFollowupDraft(reportId, '');
      state.followerSelectedReport = null;
      await refresh();
    }));
    documentRef.querySelectorAll('[data-follower-preferences-save]').forEach((button) => button.addEventListener('click', async () => {
      const verbosity = documentRef.querySelector('[data-follower-verbosity]')?.value || 'standard';
      const model = documentRef.querySelector('[data-follower-model]')?.value || '';
      const reasoningEffort = documentRef.querySelector('[data-follower-reasoning-effort]')?.value || 'medium';
      const prompts = Object.fromEntries([...documentRef.querySelectorAll('[data-follower-prompt]')]
        .map((input) => [input.dataset.followerPrompt || '', input.value.trim()]).filter(([kind]) => kind));
      try {
        const result = await api.followerPreferencesUpdate(workspacePayload({ preferences: { ...(state.followerOverview?.preferences || {}), verbosity, model, reasoningEffort, prompts }, expectedRevision: state.followerOverview?.preferenceRevision || 0 }));
        applyPreferenceResult(result);
        clearFormDraft(preferenceDraftKeys());
        await refresh();
        notify(t('settings.saved'), 'success');
      } catch (error) {
        notify(userVisibleErrorMessage(error, t('status.failed')), 'error');
      }
    }));
    [
      ['[data-follower-model], [data-follower-capability-model]', 'preferences:model'],
      ['[data-follower-reasoning-effort], [data-follower-capability-reasoning-effort]', 'preferences:reasoningEffort'],
      ['[data-follower-verbosity], [data-follower-capability-verbosity]', 'preferences:verbosity'],
    ].forEach(([selector, key]) => documentRef.querySelectorAll(selector).forEach((input) => input.addEventListener('change', () => {
      setFormDraft(key, input.value);
    })));
    documentRef.querySelectorAll('[data-follower-prompt]').forEach((input) => input.addEventListener('input', () => {
      setFormDraft(`preferences:prompt:${input.dataset.followerPrompt || ''}`, input.value);
      const counter = documentRef.querySelector(`[data-follower-prompt-count="${input.dataset.followerPrompt || ''}"]`);
      if (counter) counter.textContent = String(input.value.length);
    }));
    documentRef.querySelectorAll('[data-follower-capability-prompt]').forEach((input) => input.addEventListener('input', () => {
      setFormDraft(`preferences:prompt:${state.followerSelectedKind || 'daily_brief'}`, input.value);
      const counter = documentRef.querySelector('[data-follower-capability-prompt-count]');
      if (counter) counter.textContent = String(input.value.length);
    }));
    documentRef.querySelectorAll('[data-schedule-day], [data-schedule-hour], [data-schedule-minute]').forEach((input) => {
      input.addEventListener('change', () => captureScheduleDraft(input));
    });
    wireReasoningSelector(documentRef.querySelector('[data-follower-model]'), documentRef.querySelector('[data-follower-reasoning-effort]'));
    wireReasoningSelector(documentRef.querySelector('[data-follower-capability-model]'), documentRef.querySelector('[data-follower-capability-reasoning-effort]'));
    documentRef.querySelectorAll('[data-follower-capability-save]').forEach((button) => button.addEventListener('click', async () => {
      const kind = button.dataset.followerCapabilitySave || state.followerSelectedKind || 'daily_brief';
      const page = button.closest('[data-follower-capability-page]');
      try {
        await saveCapability(page, kind);
        clearFormDraft([...preferenceDraftKeys(kind), ...scheduleDraftKeys(kind)]);
        await refresh();
        notify(t('capabilities.saved'), 'success');
      } catch (error) { notify(userVisibleErrorMessage(error, t('status.failed')), 'error'); }
    }));
    documentRef.querySelectorAll('[data-schedule-enabled]').forEach((input) => input.addEventListener('change', async () => {
      const container = input.closest('[data-follower-capability-page], [data-follower-schedule-card]');
      const card = container?.matches?.('[data-follower-schedule-card]')
        ? container
        : container?.querySelector?.('[data-follower-schedule-card]');
      const kind = card?.dataset.followerScheduleCard || state.followerSelectedKind || 'daily_brief';
      const enabled = Boolean(input.checked);
      input.disabled = true;
      try {
        const result = await api.followerScheduleUpsert(workspacePayload({ schedule: schedulePayload(card, kind, enabled) }));
        applyScheduleResult(result);
        clearFormDraft(scheduleDraftKeys(kind));
        await refresh();
        notify(t('schedule.saved'), 'success');
      } catch (error) {
        input.checked = !enabled;
        input.disabled = false;
        notify(userVisibleErrorMessage(error, t('status.failed')), 'error');
      }
    }));
    documentRef.querySelectorAll('[data-follower-feedback]').forEach((button) => button.addEventListener('click', async () => {
      const reportId = button.dataset.reportId || '';
      const rating = button.dataset.followerFeedback || '';
      const previous = state.followerReportFeedback?.[reportId] || null;
      state.followerReportFeedback = { ...(state.followerReportFeedback || {}), [reportId]: { rating, status: 'submitting' } };
      render();
      try {
        const result = await api.followerFeedbackRecord(workspacePayload({ reportId, rating }));
        const uploadStatus = result?.upload?.status || 'pending';
        state.followerReportFeedback = { ...(state.followerReportFeedback || {}), [reportId]: { rating, status: uploadStatus } };
        render();
        notify(t(['accepted', 'duplicate'].includes(uploadStatus) ? 'feedback.uploaded' : 'feedback.pending'), 'success');
      } catch (error) {
        state.followerReportFeedback = { ...(state.followerReportFeedback || {}) };
        if (previous) state.followerReportFeedback[reportId] = previous;
        else delete state.followerReportFeedback[reportId];
        render();
        notify(userVisibleErrorMessage(error, t('status.failed')), 'error');
      }
    }));
    documentRef.querySelectorAll('[data-follower-followup-form]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.querySelector('[data-follower-followup-input]');
      const content = String(input?.value || '').trim();
      if (!content && state.followerFollowupBusy) {
        await interruptFollowup(form);
        return;
      }
      if (!content) return;
      if (state.followerFollowupStopping) return;
      const requestId = ++followupRequestId;
      const optimisticMessage = { id: `follower_pending_${requestId}`, role: 'user', content, createdAt: new Date().toISOString(), pending: true };
      state.followerFollowup = { ...(state.followerFollowup || {}), messages: [
        ...(state.followerFollowup?.messages || []).filter((message) => message.role !== 'system_error'), optimisticMessage,
      ] };
      state.followerFollowupBusy = true;
      input.value = '';
      setFollowupDraft(form.dataset.reportId || state.followerSelectedReport?.id || '', '');
      render();
      scrollFollowupToEnd();
      try {
        const nextFollowup = await api.followerFollowupSend(workspacePayload({ threadId: state.followerFollowup?.id || '', reportId: form.dataset.reportId || '', content }));
        if (requestId === followupRequestId) state.followerFollowup = nextFollowup;
      } catch (error) {
        if (requestId === followupRequestId) {
          const message = userVisibleErrorMessage(error, t('followup.failed'));
          state.followerFollowup = { ...(state.followerFollowup || {}), messages: [
            ...(state.followerFollowup?.messages || []), { id: `follower_error_${requestId}`, role: 'system_error', content: message, createdAt: new Date().toISOString() },
          ] };
          notify(message, 'error');
        }
      } finally {
        if (requestId === followupRequestId) {
          const shouldFollowBottom = followupTimelineShouldFollowBottom();
          state.followerFollowupBusy = false;
          render();
          if (shouldFollowBottom) scrollFollowupToEnd();
        }
      }
    }));
    documentRef.querySelectorAll('[data-follower-followup-input]').forEach((input) => {
      input.addEventListener('input', () => {
        setFollowupDraft(input.form?.dataset.reportId || state.followerSelectedReport?.id || '', input.value);
        updateFollowupAction(input.form);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        input.form?.requestSubmit();
      });
      updateFollowupAction(input.form);
    });
    documentRef.querySelectorAll('[data-follower-followup-retry]').forEach((button) => button.addEventListener('click', () => {
      const messages = state.followerFollowup?.messages || [];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const input = documentRef.querySelector('[data-follower-followup-input]');
      if (!lastUser?.content || !input) return;
      input.value = lastUser.content;
      setFollowupDraft(input.form?.dataset.reportId || state.followerSelectedReport?.id || '', input.value);
      state.followerFollowup = { ...(state.followerFollowup || {}), messages: messages.filter((message) => message.role !== 'system_error') };
      input.form?.requestSubmit();
    }));
    documentRef.querySelectorAll('[data-follower-schedule-save]').forEach((button) => button.addEventListener('click', async () => {
      const card = button.closest('[data-follower-schedule-card]');
      try {
        const result = await api.followerScheduleUpsert(workspacePayload({ schedule: schedulePayload(card, button.dataset.followerScheduleSave,
          Boolean(card?.querySelector('[data-schedule-enabled]')?.checked)) }));
        applyScheduleResult(result);
        clearFormDraft(scheduleDraftKeys(button.dataset.followerScheduleSave));
        await refresh();
        notify(t('schedule.saved'), 'success');
      } catch (error) { notify(userVisibleErrorMessage(error, t('status.failed')), 'error'); }
    }));
    documentRef.querySelectorAll('[data-single-day]').forEach((input) => input.addEventListener('change', () => {
      if (!input.checked) return;
      const card = input.closest('[data-follower-schedule-card]');
      card?.querySelectorAll('[data-single-day]').forEach((item) => { if (item !== input) item.checked = false; });
      captureScheduleDraft(input);
    }));
  }

  function wireReasoningSelector(modelSelect, reasoningSelect) {
    if (!modelSelect || !reasoningSelect) return;
    modelSelect.addEventListener('change', () => {
      const previous = reasoningSelect.value;
      const options = reasoningOptionsForModel(state.modelCatalog, modelSelect.value);
      const fallback = modelCatalogEntry(state.modelCatalog, modelSelect.value)?.defaultReasoningEffort || options[0]?.[0] || 'medium';
      reasoningSelect.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
      reasoningSelect.value = options.some(([value]) => value === previous) ? previous : fallback;
      setFormDraft('preferences:reasoningEffort', reasoningSelect.value);
    });
  }

  const removeUpdatedListener = api.onFollowerUpdated?.((payload = {}) => {
    const eventOwnerUserId = String(payload.ownerUserId || '').trim();
    const eventWorkspaceId = String(payload.workspaceId || '').trim();
    const currentWorkspaceId = state.followerWorkspaceOpen ? followerWorkspaceId() : activeWorkspaceId();
    if (eventOwnerUserId && eventOwnerUserId !== activeOwnerUserId()) return;
    if (eventWorkspaceId && eventWorkspaceId !== currentWorkspaceId) return;
    if (!state.followerWorkspaceOpen) {
      if (['report_ready', 'run_failed'].includes(payload.kind)) refresh({ reports: false, workspaceId: currentWorkspaceId }).catch(() => {});
      return;
    }
    if (updatedRefreshTimer) clearTimeout(updatedRefreshTimer);
    updatedRefreshTimer = setTimeout(() => {
      updatedRefreshTimer = null;
      refresh({ workspaceId: currentWorkspaceId }).catch(() => {});
    }, 60);
  });

  return { open, close, refresh, resetWorkspace, wire, removeUpdatedListener };
}
