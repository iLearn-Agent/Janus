import { escapeAttr, escapeHtml, formatChatCardMessageTime, formatMessageTime } from '../utils/format.js';
import { filePayloadAttr, normalizeFilePayload } from '../utils/filePayload.js';
import { iconSvg } from '../ui/icons.js';
import { TASK_CARD_ACTIONS } from '../../../shared/contracts/taskCard.js';
import { deriveTaskLifecycleProgress } from '../../../shared/contracts/uBuddyDeliveryReview.js';
import { state } from '../state.js';
import { agentInstanceDisplayNameForUi } from '../utils/agentIdentity.js';
import { coordinationForTask, normalizeCoordinationSnapshot } from '../features/ubuddy/coordinationState.js';
import { renderUBuddyCoordinationPanels } from './ubuddyCoordinationView.js';

export function renderTaskProgressCard({
  content = '',
  taskRunId = '',
  delegationId = '',
  taskType = '',
  objective = null,
  phase = 'executing',
  taskStatus = '',
  progress = {},
  activeNodes = [],
  nodes = [],
  milestones = [],
  blocker = null,
  deliverable = null,
  resultState = '',
  technicalDetails = null,
  coordinationSnapshot = null,
  continuedByTaskRunId = '',
  processOnly = false,
  terminal = false,
  open = true,
  compact = false,
  title = '',
  sourceContext = null,
  createdAt = '',
  updatedAt = '',
  showMessageTime = false,
  wrapperClass = 'message assistant run-status-message collaboration-run-message',
  controls = {},
  agentName = (value) => value || 'Agent',
  taskNodeStatusLabel = (value) => value || '处理中',
  taskTypeLabel = (value) => value || '协作任务',
} = {}) {
  const liveTask = taskForProgress(taskRunId);
  const total = Math.max(0, Number(progress.total || nodes.length || 0));
  const completed = Math.max(0, Number(progress.completed || nodes.filter((node) => node.status === 'completed').length || 0));
  const executionPercent = Number.isFinite(Number(progress.executionPercent))
    ? Math.max(Number(progress.executionPercent), total ? Math.round((completed / total) * 100) : 0)
    : total ? Math.round((completed / total) * 100)
      : Number.isFinite(Number(progress.percent)) ? Number(progress.percent) : 0;
  const effectiveTaskStatus = String(liveTask?.status || progress.taskStatus || taskStatus || '');
  const requestedLifecyclePhase = progress.lifecyclePhase || phase;
  const reviewState = String(progress.reviewState || liveTask?.deliveryReview?.state
    || liveTask?.metadata?.deliveryReview?.state || liveTask?.metadata?.deliveryReviewState || '').toLowerCase();
  const deliveryValidationState = String(progress.deliveryValidationState
    || liveTask?.metadata?.deliveryValidationState || deliverable?.validationState || '').toLowerCase();
  const deliveryValidationCode = String(progress.deliveryValidationCode
    || liveTask?.metadata?.deliveryValidationCode || deliverable?.failureCode || '').toLowerCase();
  const lifecycleProgress = deriveTaskLifecycleProgress({
    phase: effectiveTaskStatus === 'completed' && requestedLifecyclePhase === 'executing' && deliverable
      ? 'delivering' : requestedLifecyclePhase,
    taskStatus: effectiveTaskStatus,
    failureStage: progress.failureStage || liveTask?.metadata?.failurePhase || '',
    executionPercent,
    reviewState,
    finalDelivery: progress.finalDelivery || liveTask?.metadata?.finalDelivery || null,
    acceptanceSource: progress.acceptanceSource || liveTask?.metadata?.deliveryReviewOutcome || '',
    confirmationRequired: progress.confirmationRequired === true,
    hasConfirmationProtocol: progress.confirmationRequired === true || Boolean(
      liveTask?.metadata?.finalDelivery
      || liveTask?.deliveryReview
      || liveTask?.metadata?.deliveryReview
      || liveTask?.metadata?.deliveryReviewState,
    ),
  });
  const percent = lifecycleProgress.percent;
  const progressLabel = blocker?.displayLabel
    || (blocker?.userActionRequired || blocker?.requiresUserAction ? '等待你补充信息' : lifecycleProgress.label);
  const stageOrder = ['confirming', 'planning', 'executing', 'verifying', 'delivering'];
  const normalizedPhase = lifecycleProgress.phase;
  const activeStage = Math.max(0, stageOrder.indexOf(normalizedPhase));
  const taskTerminal = terminal || Boolean(progress.terminal) || ['completed', 'failed', 'cancelled'].includes(effectiveTaskStatus);
  const finished = taskTerminal && !lifecycleProgress.confirmationRequired;
  const needsRevision = resultState === 'needs_revision' || deliverable?.resultState === 'needs_revision' || deliverable?.validationState === 'failed';
  const reviewUnavailable = deliveryValidationState === 'unavailable'
    || ['delivery_review_uncertain', 'review_model_unavailable'].includes(deliveryValidationCode);
  const userActionRequired = reviewState === 'action_required'
    || blocker?.userActionRequired === true || blocker?.requiresUserAction === true;
  const qualityWarning = !reviewUnavailable && !userActionRequired && (
    deliveryValidationState === 'warning' || deliverable?.qualityWarning === true
  );
  const stageNotice = reviewUnavailable ? 'unavailable' : userActionRequired ? 'action-required' : qualityWarning ? 'warning' : '';
  const completedSuccessfully = lifecycleProgress.percent === 100 && !needsRevision;
  const continued = Boolean(String(continuedByTaskRunId || '').trim());
  const terminalFailure = !continued && (['failed', 'cancelled'].includes(effectiveTaskStatus)
    || (needsRevision && !stageNotice));
  const visibleNodes = Array.isArray(nodes) ? nodes.slice(0, 100) : [];
  const visibleMilestones = Array.isArray(milestones) ? milestones.slice(-12).reverse() : [];
  const retryNodes = controls.canRetry
    ? visibleNodes.filter((node) => ['failed', 'retry_wait'].includes(String(node.status || '')))
    : [];
  const cardTitle = String(title || liveTask?.title || objective?.summary
    || (taskTerminal ? '协作任务交付' : 'uBuddy 协作任务')).trim().slice(0, 120);
  const taskCreatedAt = liveTask?.createdAt || liveTask?.created_at || createdAt || '';
  const taskUpdatedAt = liveTask?.updatedAt || liveTask?.updated_at || updatedAt || taskCreatedAt;
  const messageSentAt = createdAt || taskUpdatedAt;
  const timing = terminalTaskTiming(liveTask, {
    createdAt: taskCreatedAt,
    completedAt: liveTask?.completedAt || liveTask?.completed_at || taskUpdatedAt,
    nodes: visibleNodes,
  });
  const completedFiles = terminalTaskFiles(liveTask, deliverable, visibleNodes);
  const taskMeta = [
    taskCreatedAt ? `创建 ${formatMessageTime(taskCreatedAt)}` : '',
    taskUpdatedAt && taskUpdatedAt !== taskCreatedAt ? `更新 ${formatMessageTime(taskUpdatedAt)}` : '',
    taskRunId ? `#${String(taskRunId).slice(-8)}` : '',
  ].filter(Boolean).join(' · ');
  const coordination = normalizeCoordinationSnapshot(coordinationSnapshot)
    || coordinationForTask(state, taskRunId, liveTask);
  const coordinationPanels = renderUBuddyCoordinationPanels({
    state,
    taskRunId,
    coordination,
    task: liveTask || (taskRunId ? { id: taskRunId, nodes: visibleNodes, metadata: {} } : null),
    nodes: visibleNodes,
    blocker,
  });
  const deliverySpecifications = taskDeliverySpecifications(liveTask);
  const technicalBody = renderTechnicalDetails({
    visibleNodes,
    visibleMilestones,
    blocker,
    diagnostics: technicalDetails?.diagnostics || [],
    agentName,
    taskNodeStatusLabel,
    disclosureKeyPrefix: String(taskRunId || delegationId || '').trim(),
  });
  const taskWorkspaceKind = delegationId ? 'delegation' : 'task_run';
  const taskWorkspaceId = delegationId || taskRunId;
  const progressDisclosureId = String(taskRunId || delegationId || '').trim();
  const hasExplicitOpenState = progressDisclosureId
    ? Object.prototype.hasOwnProperty.call(state.taskProgressOpenById || {}, progressDisclosureId)
    : false;
  const progressDisclosureOpen = hasExplicitOpenState
    ? Boolean(state.taskProgressOpenById[progressDisclosureId])
    : Boolean(compact ? false : open);
  const normalizedSourceContext = sourceContext && typeof sourceContext === 'object' ? sourceContext : {};
  const taskNavigationAttributes = `data-task-workspace-kind="${escapeAttr(taskWorkspaceKind)}" data-task-workspace-id="${escapeAttr(taskWorkspaceId)}" data-task-source-conversation-id="${escapeAttr(normalizedSourceContext.source_conversation_id || normalizedSourceContext.sourceConversationId || '')}" data-task-source-message-id="${escapeAttr(normalizedSourceContext.source_message_id || normalizedSourceContext.sourceMessageId || '')}" data-task-source-group-id="${escapeAttr(normalizedSourceContext.source_group_id || normalizedSourceContext.sourceGroupId || '')}" data-task-return-surface="${escapeAttr(normalizedSourceContext.returnSurface || '')}"`;
  if (compact && taskTerminal && !processOnly && !deliverable && !continued) {
    return renderChatTaskResultCard({
      taskRunId,
      title: cardTitle,
      summary: liveTask?.summary || content,
      status: effectiveTaskStatus,
      confirmationRequired: lifecycleProgress.confirmationRequired,
      messageSentAt,
      showMessageTime,
      durationLabel: timing.durationLabel,
      files: effectiveTaskStatus === 'completed' ? completedFiles : [],
      controls,
      taskNavigationAttributes,
    });
  }
  return `
    <article class="${escapeAttr(wrapperClass)} ${compact ? 'is-compact-task-card' : ''}" data-stage="${escapeAttr(normalizedPhase)}"${taskRunId ? ` data-task-progress-run="${escapeAttr(taskRunId)}"` : ''}${delegationId ? ` data-delegation-progress="${escapeAttr(delegationId)}"` : ''}>
      <details class="collaboration-run-card"${progressDisclosureId ? ` data-task-progress-toggle="${escapeAttr(progressDisclosureId)}"` : ''}${progressDisclosureOpen ? ' open' : ''}>
        <summary class="collaboration-run-head">
          <span class="run-pulse ${finished ? 'is-settled' : ''}" aria-hidden="true"></span>
          <span><strong>${escapeHtml(cardTitle)}</strong><small>${escapeHtml(content || '任务进度已更新')}</small>${taskMeta ? `<em class="collaboration-task-time">${escapeHtml(taskMeta)}</em>` : ''}</span>
          <b>${percent}%</b>
        </summary>
        <div class="collaboration-run-body">
          ${coordinationPanels}
          ${objective || deliverySpecifications.length ? `<section class="collaboration-objective"><div><strong>任务目标已确认</strong><span>${escapeHtml(taskTypeLabel(taskType))}</span></div>${objective?.summary ? `<p>${escapeHtml(objective.summary)}</p>` : ''}${objective?.deliverables?.length ? `<ul>${objective.deliverables.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}${deliverySpecifications.length ? `<div class="collaboration-delivery-spec"><b>交付规格</b><ul>${deliverySpecifications.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}</section>` : ''}
          <div class="collaboration-run-stages" aria-label="协作阶段">
            ${['确认目标', '规划', '执行', '验证', '交付'].map((label, index) => {
              const complete = completedSuccessfully || index < activeStage;
              const failed = terminalFailure && index === activeStage;
              const notice = !failed && index === activeStage ? stageNotice : '';
              const active = !finished && !complete && !failed && !notice && index === activeStage;
              const stageClass = complete ? 'is-complete' : failed ? 'is-failed' : notice ? `is-${notice}` : active ? 'is-active' : '';
              const stageIcon = complete ? '✓' : failed ? '!' : notice === 'warning' ? '!' : notice === 'unavailable' ? '?' : notice === 'action-required' ? '…' : index + 1;
              return `<span class="${stageClass}"><i>${stageIcon}</i>${label}</span>`;
            }).join('')}
          </div>
          <div class="collaboration-progress-meta"><span>总体进度</span><strong>${escapeHtml(progressLabel)} · ${percent}%${total ? ` · 执行节点 ${completed}/${total}` : ''}</strong></div>
          <div class="collaboration-progress-track"><i style="width:${Math.max(percent, total ? 3 : 0)}%"></i></div>
          <div class="collaboration-progress-counts">
            ${renderProgressCount('运行', progress.running)}${renderProgressCount('排队', progress.queued)}${renderProgressCount('等待', progress.waiting)}${renderProgressCount('失败', progress.failed, Number(progress.failed || 0) ? 'danger' : '')}
          </div>
          ${renderTaskTransparencySummary({ lifecycleProgress, activeNodes, blocker, taskTerminal })}
          ${renderTaskRecoveryStatus({ task: liveTask, nodes: visibleNodes, blocker })}
          ${activeNodes.length ? `<section class="collaboration-active-nodes"><strong>当前工作</strong>${activeNodes.slice(0, 5).map((node) => `<div><span>${escapeHtml(node.title || '任务节点')}</span><small>${escapeHtml(node.agentName || agentName(node.agentId))} · ${escapeHtml(taskNodeStatusLabel(node.status))}</small></div>`).join('')}</section>` : ''}
          ${continued ? renderTaskContinuationCard(continuedByTaskRunId) : taskTerminal && !processOnly ? (compact ? renderCompactDeliverableSummary(deliverable, { resultState }) : renderFinalDeliverableCard(deliverable, { resultState, fallback: content, disclosureKeyPrefix: progressDisclosureId })) : ''}
          ${technicalBody ? `<details class="collaboration-technical-details"${taskDisclosureAttributes(`${progressDisclosureId}:technical`)}><summary>查看技术详情</summary>${technicalBody}</details>` : ''}
          ${taskRunId && Object.values(controls).some(Boolean) ? `<div class="collaboration-task-actions">${controls.canOpenWorkspace ? `<button class="mini-btn collaboration-open-task" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>打开任务</button>` : ''}${controls.canOpenResult ? `<button class="mini-btn" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>查看结果</button>` : ''}${controls.canSupplement ? '<button class="mini-btn" type="button" data-focus-delegation-composer>补充要求</button>' : ''}${controls.canRerun ? `<button class="mini-btn" type="button" data-rerun-ubuddy-task="${escapeAttr(taskRunId)}">重新执行</button>` : ''}${retryNodes.map((node) => `<button class="mini-btn" type="button" data-retry-task-node="${escapeAttr(node.id || '')}" data-retry-task="${escapeAttr(taskRunId)}">${node.status === 'retry_wait' ? '立即重试' : `重试“${escapeHtml(node.title || '失败节点')}”`}</button>`).join('')}</div>` : ''}
        </div>
      </details>
      ${(compact && taskRunId && (controls.canOpenWorkspace || controls.canOpenResult || controls.canCancel)) || controls.canCancel ? `<div class="collaboration-task-actions collaboration-task-persistent-actions">${compact && controls.canOpenWorkspace ? `<button class="mini-btn" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>打开任务</button>` : ''}${compact && controls.canOpenResult ? `<button class="mini-btn" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>查看结果${deliverableFileCount(deliverable) ? ` · ${deliverableFileCount(deliverable)} 个文件` : ''}</button>` : ''}${controls.canCancel && taskRunId ? `<button class="mini-btn muted" type="button" data-task-card-action="${TASK_CARD_ACTIONS.CANCEL_TASK}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}${effectiveTaskStatus === 'cancelling' ? ' disabled' : ''}>${effectiveTaskStatus === 'cancelling' ? '正在停止…' : '停止整个任务'}</button>` : ''}</div>` : ''}
    </article>`;
}

function renderChatTaskResultCard({
  taskRunId = '', title = '', summary = '', status = '', confirmationRequired = false,
  messageSentAt = '', showMessageTime = false, durationLabel = '', files = [], controls = {}, taskNavigationAttributes = '',
} = {}) {
  const normalizedStatus = String(status || '').toLowerCase();
  const failed = normalizedStatus === 'failed';
  const statusLabel = confirmationRequired ? '待验收'
    : normalizedStatus === 'failed' ? '执行失败'
    : normalizedStatus === 'cancelled' ? '已停止'
      : '已完成';
  const tone = confirmationRequired ? 'is-pending'
    : normalizedStatus === 'failed' ? 'is-failed'
    : normalizedStatus === 'cancelled' ? 'is-cancelled'
      : 'is-completed';
  const fallback = confirmationRequired ? '任务结果已经就绪，等待你查看和验收。'
    : normalizedStatus === 'failed'
    ? '任务未能完成，请打开任务查看失败原因或重新执行。'
    : normalizedStatus === 'cancelled'
      ? '任务已经停止，已生成的过程记录仍会保留。'
      : '任务已经完成，可以查看结果和执行记录。';
  return `<article class="message assistant run-status-message ubuddy-chat-task-result-message" data-stage="${escapeAttr(normalizedStatus || 'completed')}"${taskRunId ? ` data-task-progress-run="${escapeAttr(taskRunId)}"` : ''}>
    ${renderChatMessageTime(messageSentAt, showMessageTime)}
    <section class="ubuddy-chat-delivery-card ubuddy-chat-task-result-card ${tone}" aria-label="${escapeAttr(statusLabel)}">
      <div class="ubuddy-chat-delivery-title"><strong>${escapeHtml(title || 'uBuddy 任务')}</strong><span class="ubuddy-chat-delivery-title-meta">${renderTaskDurationBadge(durationLabel)}<em>${escapeHtml(statusLabel)}</em></span></div>
      <p>${escapeHtml(summary || fallback)}</p>
      ${failed ? '<div class="ubuddy-chat-task-failure-signal" role="status"><b aria-hidden="true">!</b><span><strong>任务未完成</strong><small>打开任务可查看最后一次报错和失败节点。</small></span></div>' : ''}
      ${renderChatTaskFiles(files)}
      <footer><span></span><span class="ubuddy-chat-delivery-actions">
        ${controls.canOpenWorkspace ? `<button class="btn ${failed ? 'primary' : 'secondary'}" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_WORKSPACE}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>${failed ? '查看失败原因' : '打开任务'}</button>` : ''}
        ${!failed && controls.canOpenResult ? `<button class="btn primary" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-run-id="${escapeAttr(taskRunId)}" ${taskNavigationAttributes}>查看结果</button>` : ''}
        ${controls.canRerun ? `<button class="btn secondary" type="button" data-rerun-ubuddy-task="${escapeAttr(taskRunId)}">重新执行</button>` : ''}
      </span></footer>
    </section>
  </article>`;
}

function taskDeliverySpecifications(task = null) {
  const contract = task?.metadata?.deliverableContract;
  if (!contract || typeof contract !== 'object') return [];
  const deliverables = Array.isArray(contract.deliverables) && contract.deliverables.length
    ? contract.deliverables
    : [contract];
  return deliverables.filter((item) => (
    item?.requires_file === true && String(item.requested_output_type || '') !== 'code_change'
  )).map((item) => {
    const extensions = [...new Set((Array.isArray(item.required_extensions) ? item.required_extensions : [])
      .map((extension) => String(extension || '').trim().toUpperCase()).filter(Boolean))];
    const format = extensions.length > 1
      ? `${String(item.extension_rule || 'one_of') === 'all_of' ? '全部需要' : '任选一种'}：${extensions.join('、')}`
      : extensions[0] || '文件（格式未指定）';
    const source = String(item.format_source || '') === 'user_explicit' ? '用户指定'
      : String(item.format_source || '') === 'system_default' ? '系统默认' : '';
    return `${item.deliverable_title || item.title || '交付文件'}：${format}${source ? `（${source}）` : ''}`;
  });
}

function renderCompactDeliverableSummary(deliverable = null, { resultState = '' } = {}) {
  const count = deliverableFileCount(deliverable);
  const needsRevision = resultState === 'needs_revision' || deliverable?.resultState === 'needs_revision' || deliverable?.validationState === 'failed';
  return `<section class="final-deliverable-compact ${needsRevision ? 'is-needs-revision' : ''}"><span>${needsRevision ? '交付需要修正' : '交付结果已就绪'}</span><strong>${escapeHtml(deliverable?.title || '任务交付物')}</strong><small>${count ? `${count} 个交付文件 · 请在任务工作区查看` : '请在任务工作区查看完整结果'}</small></section>`;
}

function deliverableFileCount(deliverable = null) {
  return Array.isArray(deliverable?.files) ? deliverable.files.length : 0;
}

function renderTaskContinuationCard(successorTaskRunId = '') {
  return `<section class="final-deliverable-card is-continued"><header><span>已续接</span><strong>补充要求已进入后续任务轮次</strong></header><p>旧轮次作为历史记录保留，不代表用户取消；后续执行与交付会在新轮次继续。</p>${successorTaskRunId ? `<small>后续任务：${escapeHtml(String(successorTaskRunId).slice(-12))}</small>` : ''}</section>`;
}

function taskForProgress(taskRunId = '') {
  if (!taskRunId) return null;
  const hydrated = state.uBuddyTaskViewsById?.[taskRunId] || null;
  if (hydrated) return hydrated;
  if (state.taskDetail?.id === taskRunId) return state.taskDetail;
  const direct = (state.tasks || []).find((task) => task.id === taskRunId);
  if (direct) return direct;
  return Object.values(state.networkDelegationTaskById || {}).find((task) => task?.id === taskRunId) || null;
}

function renderProgressCount(label, value, tone = '') {
  return `<span class="${tone ? `is-${tone}` : ''}"><b>${Math.max(0, Number(value || 0))}</b>${escapeHtml(label)}</span>`;
}

function renderTaskTransparencySummary({ lifecycleProgress = {}, activeNodes = [], blocker = null, taskTerminal = false } = {}) {
  const current = blocker?.summary || activeNodes[0]?.title || (taskTerminal ? '任务执行已经结束' : lifecycleProgress.label || '任务正在推进');
  const reason = blocker
    ? '当前存在阻塞，系统会按恢复策略继续处理。'
    : ({
        confirming: '正在确认目标，避免误创建或误派发任务。',
        planning: '正在拆分步骤并匹配适合的 Agent。',
        executing: 'Agent 正在完成已经分配的执行节点。',
        verifying: '执行结果正在按原始要求进行验收。',
        delivering: lifecycleProgress.confirmationRequired ? '当前版本已交付，正在等待你的确认。' : '正在整理并交付最终结果。',
      })[lifecycleProgress.phase] || '任务状态已更新。';
  const next = blocker?.suggestedNextStep
    || (lifecycleProgress.confirmationRequired ? '查看结果后接受交付，或提出修改要求。'
      : taskTerminal ? '查看交付结果和执行记录。'
        : lifecycleProgress.phase === 'verifying' ? '结果会先交付；质量检查只提供通过或修改建议。'
          : lifecycleProgress.phase === 'delivering' ? '交付完成后等待用户确认。'
            : '完成当前节点后自动进入下一阶段。');
  return `<section class="collaboration-task-transparency" aria-label="任务情况说明"><span><b>当前</b>${escapeHtml(current)}</span><span><b>原因</b>${escapeHtml(reason)}</span><span><b>下一步</b>${escapeHtml(next)}</span></section>`;
}

function renderTaskRecoveryStatus({ task = null, nodes = [], blocker = null } = {}) {
  const retryNode = (Array.isArray(nodes) ? nodes : []).find((node) => String(node.status || '') === 'retry_wait') || null;
  const recovery = task?.metadata?.backgroundRecovery || null;
  const failure = task?.metadata?.failureReport || task?.metadata?.publicFailure || blocker || null;
  const attemptCount = Math.max(0, Number(retryNode?.attemptCount ?? recovery?.attemptCount ?? failure?.attemptCount ?? 0));
  const maxAttempts = Math.max(0, Number(retryNode?.maxAttempts ?? recovery?.maxAttempts ?? failure?.maxAttempts ?? 0));
  if (!retryNode && !recovery && !failure) return '';
  const nextRetryAt = retryNode?.nextRetryAt || failure?.nextRetryAt || '';
  const recovering = Boolean(recovery && !['failed', 'completed', 'cancelled'].includes(String(task?.status || '')));
  const requiresUserAction = Boolean(failure?.userActionRequired || failure?.requiresUserAction);
  const title = failure?.displayLabel || (requiresUserAction ? '需要你的操作'
    : retryNode ? '等待自动重试'
      : recovering ? 'uBuddy 正在恢复任务'
        : '最近一次执行问题');
  const latestRecoveryAction = Array.isArray(recovery?.attemptedActions) ? recovery.attemptedActions.at(-1) || '' : '';
  const summary = String(failure?.summary || failure?.cause || retryNode?.waitReason || retryNode?.errorText || latestRecoveryAction || '').trim();
  const next = String(failure?.suggestedNextStep || (retryNode
    ? nextRetryAt ? `系统将在 ${formatMessageTime(nextRetryAt)} 自动重试。` : '系统会按恢复策略自动重试。'
    : recovering ? 'uBuddy 已读取上一次错误上下文并安排有限恢复。'
      : '')).trim();
  return `<section class="collaboration-recovery-status ${requiresUserAction ? 'is-action-required' : retryNode || recovering ? 'is-recovering' : ''}" aria-label="任务恢复状态">
    <header><strong>${escapeHtml(title)}</strong>${maxAttempts ? `<span>第 ${Math.max(1, attemptCount)}/${maxAttempts} 次尝试</span>` : ''}</header>
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${next ? `<small>${escapeHtml(next)}</small>` : ''}
  </section>`;
}

function renderTechnicalDetails({ visibleNodes = [], visibleMilestones = [], blocker = null, diagnostics = [], agentName, taskNodeStatusLabel, disclosureKeyPrefix = '' }) {
  return [
    visibleNodes.length ? `<section class="collaboration-task-nodes"><strong>节点状态</strong>${visibleNodes.map((node) => `<div class="is-${escapeAttr(node.status || 'pending')}"><span><b>${escapeHtml(node.title || '任务节点')}</b><small>${escapeHtml(node.agentName || agentName(node.agentId))} · ${escapeHtml(taskNodeStatusLabel(node.status))}${node.contentType ? ` · ${escapeHtml(node.contentType)}` : ''}${Number(node.maxAttempts || 0) > 1 ? ` · ${Number(node.attemptCount || 0)}/${Number(node.maxAttempts || 0)} 次` : ''}</small>${node.summary ? `<em>${escapeHtml(node.summary)}</em>` : ''}</span>${node.detail ? `<details class="collaboration-node-output"${taskDisclosureAttributes(`${disclosureKeyPrefix}:node:${node.id || node.title || 'unknown'}`)}><summary>查看分类内容</summary><pre>${escapeHtml(node.detail)}</pre></details>` : ''}</div>`).join('')}</section>` : '',
    visibleMilestones.length ? `<section class="collaboration-milestones"><strong>最近进展</strong>${visibleMilestones.map((item) => `<div class="is-${escapeAttr(item.status || 'running')}"><i></i><span><b>${escapeHtml(item.title || '任务进展')}</b><small>${item.agentName || item.agentId ? `${escapeHtml(item.agentName || agentName(item.agentId))} · ` : ''}${escapeHtml(item.detail || taskNodeStatusLabel(item.status))}${item.createdAt || item.occurredAt ? ` · ${escapeHtml(formatMessageTime(item.createdAt || item.occurredAt))}` : ''}</small></span></div>`).join('')}</section>` : '',
    blocker ? `<section class="collaboration-blocker"><strong>任务受阻</strong><p>${escapeHtml(blocker.summary || '当前节点暂时无法继续。')}</p>${blocker.errorCode ? `<small>错误类型：${escapeHtml(blocker.errorCode)}</small>` : ''}${Number(blocker.maxAttempts || 0) ? `<small>执行尝试：${Number(blocker.attemptCount || 0)}/${Number(blocker.maxAttempts || 0)}</small>` : ''}${blocker.nextRetryAt ? `<small>下次自动重试：${escapeHtml(blocker.nextRetryAt)}</small>` : ''}${blocker.attemptedActions?.length ? `<small>已尝试：${escapeHtml(blocker.attemptedActions.join('；'))}</small>` : ''}<small>建议：${escapeHtml(blocker.suggestedNextStep || '查看任务详情并处理阻塞。')}</small></section>` : '',
    diagnostics.length ? `<section class="collaboration-diagnostics"><strong>诊断信息</strong>${diagnostics.map((item) => `<p>${escapeHtml(item.summary || item.type || '诊断记录')}</p>`).join('')}</section>` : '',
  ].filter(Boolean).join('');
}

export function renderFinalDeliverableCard(deliverable = null, {
  resultState = '', fallback = '', disclosureKeyPrefix = '', acceptedActionTaskRunId = '', chatTaskRunId = '', messageSentAt = '', showMessageTime = false,
} = {}) {
  const needsRevision = resultState === 'needs_revision' || deliverable?.resultState === 'needs_revision' || deliverable?.validationState === 'failed';
  if (!deliverable || needsRevision) {
    return `<section class="final-deliverable-card is-needs-revision"><header><span>需要修正</span><strong>${escapeHtml(deliverable?.title || '最终交付物未通过验收')}</strong></header><p>${escapeHtml(deliverable?.summary || fallback || '没有合格的 deliverable，任务不能标记为已完成。')}</p></section>`;
  }
  const files = Array.isArray(deliverable.files) ? deliverable.files : [];
  const qualityWarning = deliverable.qualityWarning === true;
  const previewVersion = deliverable.previewVersion === true;
  const deliveryFailedSnapshot = deliverable.deliveryFailedSnapshot === true;
  const ownerAccepted = deliverable.acceptanceSource === 'owner_override';
  if (chatTaskRunId) return renderChatDeliveryCard(deliverable, {
    taskRunId: chatTaskRunId,
    accepted: ownerAccepted,
    fallback,
    acceptedActionTaskRunId,
    messageSentAt,
    showMessageTime,
  });
  const label = deliveryFailedSnapshot ? '交付文件快照 · 当前交付失败'
    : previewVersion ? '当前保存版本 · 待验收'
    : ownerAccepted ? '已验收'
      : qualityWarning ? '已交付 · 等待用户确认 · 质量提示'
        : '已交付 · 等待用户确认';
  const warnings = deliverable.reviewWarnings?.failedChecks || [];
  return `<section class="final-deliverable-card ${deliveryFailedSnapshot ? 'is-needs-revision' : qualityWarning ? 'is-quality-warning' : previewVersion ? 'is-preview-version' : 'is-accepted'}" aria-label="${escapeAttr(label)}"><header><span>${escapeHtml(label)}</span><strong>${escapeHtml(deliverable.title || '任务交付物')}</strong></header><p>${escapeHtml(deliverable.summary || (deliveryFailedSnapshot ? '交付失败，已生成内容仍作为快照保留。' : previewVersion ? '当前版本已交付，质量检查仍在进行。' : ownerAccepted ? '本次交付已验收，任务已经关闭。' : qualityWarning ? '当前版本已交付，质量检查提示仅作为修改建议。' : '交付结果已可查看，等待你的最终确认。'))}</p>${warnings.length ? `<details class="final-deliverable-warnings"${taskDisclosureAttributes(`${disclosureKeyPrefix}:delivery-warnings`, true)}><summary>查看质量检查建议</summary><ul>${warnings.map((item) => `<li>${escapeHtml(item.summary || item.code || '检查未通过')}</li>`).join('')}</ul></details>` : ''}${files.length ? `<div class="final-deliverable-files">${files.map(renderDeliverableFile).join('')}</div>` : ''}${deliverable.body ? `<details class="final-deliverable-body"${taskDisclosureAttributes(`${disclosureKeyPrefix}:delivery-body`)}><summary>查看正文</summary><pre>${escapeHtml(deliverable.body)}</pre></details>` : ''}${ownerAccepted && acceptedActionTaskRunId ? `<footer class="final-delivery-actions"><button class="btn primary" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-workspace-kind="task_run" data-task-workspace-id="${escapeAttr(acceptedActionTaskRunId)}" data-task-run-id="${escapeAttr(acceptedActionTaskRunId)}">查看交付</button></footer>` : ''}</section>`;
}

function renderChatDeliveryCard(deliverable = {}, {
  taskRunId = '', accepted = false, fallback = '', acceptedActionTaskRunId = '', messageSentAt = '', showMessageTime = false,
} = {}) {
  const task = taskForProgress(taskRunId);
  const files = Array.isArray(deliverable.files) ? deliverable.files : [];
  const submissionId = String(deliverable.selectedSubmissionId
    || task?.metadata?.selectedDeliverySubmissionId
    || task?.deliveryReview?.selectedSubmissionId
    || task?.deliveryReview?.latestSubmissionId
    || '');
  const submissionNo = Math.max(1, Number(deliverable.selectedSubmissionNo
    || task?.metadata?.selectedDeliverySubmissionNo
    || task?.deliveryReview?.selectedSubmissionNo
    || task?.deliveryReview?.latestSubmissionNo
    || 1));
  const formatLabels = [...new Set(files.map(deliveryFileFormatLabel).filter(Boolean))];
  const deliveredAt = task?.metadata?.finalDelivery?.deliveredAt
    || task?.metadata?.deliveryValidatedAt || task?.updatedAt || task?.updated_at || '';
  const timing = terminalTaskTiming(task, {
    createdAt: task?.createdAt || task?.created_at || '',
    completedAt: task?.completedAt || task?.completed_at || deliveredAt,
    nodes: task?.nodes || [],
  });
  const title = deliverable.title || task?.title || '任务交付物';
  const summary = deliverable.summary || fallback || (accepted
    ? '本次交付已验收，任务已经关闭。'
    : `任务已经完成${files.length ? `，共生成 ${files.length} 个交付文件` : ''}，等待你查看和验收。`);
  const viewTaskRunId = acceptedActionTaskRunId || taskRunId;
  const deliveryFacts = chatDeliveryFacts(task, files);
  return `${renderChatMessageTime(messageSentAt || deliveredAt, showMessageTime)}<section class="ubuddy-chat-delivery-card ${accepted ? 'is-accepted' : 'is-pending'}" aria-label="${accepted ? '已验收' : '待验收'}">
    <div class="ubuddy-chat-delivery-title"><strong>${escapeHtml(title)}</strong><span class="ubuddy-chat-delivery-title-meta">${renderTaskDurationBadge(timing.durationLabel)}<em>${accepted ? '已验收' : '待验收'}</em></span></div>
    <p>${escapeHtml(summary)}</p>
    ${renderChatDeliveryFacts(deliveryFacts)}
    <footer><span class="ubuddy-chat-delivery-formats">${formatLabels.slice(0, 4).map((label) => `<i>${escapeHtml(shortDeliveryFormat(label))}</i>`).join('')}</span><span class="ubuddy-chat-delivery-actions">${!accepted && submissionId ? `<button class="btn secondary" type="button" data-ubuddy-quick-accept="${escapeAttr(taskRunId)}" data-delivery-submission-id="${escapeAttr(submissionId)}" data-delivery-submission-no="${submissionNo}">快速验收</button>` : ''}<button class="btn primary" type="button" data-task-card-action="${TASK_CARD_ACTIONS.OPEN_RESULT}" data-task-workspace-kind="task_run" data-task-workspace-id="${escapeAttr(viewTaskRunId)}" data-task-run-id="${escapeAttr(viewTaskRunId)}" data-delivery-submission-id="${escapeAttr(submissionId)}">查看交付详情${iconSvg('chevronRight')}</button></span></footer>
  </section>`;
}

function chatDeliveryFacts(task = null, rawFiles = []) {
  const intake = task?.metadata?.uBuddyTaskIntakeSpec || task?.metadata?.taskIntake || {};
  const files = normalizeTerminalTaskFiles(rawFiles);
  const objective = cleanDeliveryText(intake.objective || task?.metadata?.objective?.summary || task?.metadata?.globalTaskSummary);
  const requestedDeliverables = cleanDeliveryList(intake.deliverables);
  const acceptanceCriteria = cleanDeliveryList(intake.acceptanceCriteria || intake.acceptance_criteria);
  const constraints = cleanDeliveryList(intake.constraints);
  const actors = taskDeliveryActors(task);
  return [
    objective ? { label: '任务目标已达成', content: escapeHtml(objective) } : null,
    files.length ? { label: '交付物已完成', content: renderChatDeliveryFileLinks(files) }
      : requestedDeliverables.length ? { label: '交付物已完成', content: escapeHtml(requestedDeliverables.join('；')) }
        : null,
    acceptanceCriteria.length ? { label: '验收标准已满足', content: escapeHtml(acceptanceCriteria.join('；')) } : null,
    constraints.length ? { label: '执行约束已遵循', content: escapeHtml(constraints.join('；')) } : null,
    actors.length ? { label: '执行 Agent', content: escapeHtml(actors.join('；')) } : null,
  ].filter(Boolean);
}

function renderChatDeliveryFacts(facts = []) {
  if (!facts.length) return '';
  return `<section class="ubuddy-chat-delivery-facts" aria-label="交付达成情况">${facts.map((fact) => `<div><i aria-hidden="true">${iconSvg('check')}</i><span><strong>${escapeHtml(fact.label)}</strong><span>${fact.content}</span></span></div>`).join('')}</section>`;
}

function renderChatDeliveryFileLinks(files = []) {
  return `<span class="ubuddy-chat-delivery-file-links">${files.map((file) => {
    const payload = filePayloadAttr(file);
    return `<a href="#" data-codex-file-action data-open-file="${payload}" title="打开 ${escapeAttr(file.name)}">${iconSvg('paperclip')}<span>${escapeHtml(file.name)}</span></a>`;
  }).join('')}</span>`;
}

function taskDeliveryActors(task = null) {
  const nodes = Array.isArray(task?.nodes) ? task.nodes : [];
  const executedNodes = nodes.filter((node) => !['pending', 'cancelled', 'blocked'].includes(String(node?.status || '').toLowerCase()));
  const coordination = task?.metadata?.coordinationSnapshot || task?.metadata?.coordination || {};
  const participants = Array.isArray(coordination?.participants) ? coordination.participants : [];
  const sources = executedNodes.length ? executedNodes : nodes.length ? nodes : participants;
  const candidates = Array.isArray(task?.metadata?.candidateSnapshots) ? task.metadata.candidateSnapshots : [];
  const roster = Array.isArray(state.employeeOverview?.roster) ? state.employeeOverview.roster : [];
  const ownerUserId = String(task?.ownerUserId || task?.owner_user_id || task?.metadata?.userId || '').trim();
  const byAccount = new Map();
  for (const node of sources) {
    const instanceId = String(node?.agentInstanceId || node?.agent_instance_id || '').trim();
    const familyId = String(node?.agentId || node?.agent_id || node?.agentFamilyId || node?.agent_family_id || '').trim();
    if (!instanceId && !familyId) continue;
    const employee = roster.find((item) => String(item?.id || '') === instanceId) || {};
    const candidate = candidates.find((item) => String(item?.agentInstanceId || item?.agent_instance_id || '') === instanceId) || {};
    const fallbackName = node.agentName || node.agent_name || candidate.displayName || candidate.name
      || state.org?.agents?.find((agent) => agent.id === familyId)?.name || familyId || 'Agent';
    const agentName = agentInstanceDisplayNameForUi(employee, fallbackName);
    const accountId = String(node.ownerUserId || node.owner_user_id || candidate.ownerUserId || candidate.owner_user_id || ownerUserId).trim();
    const accountName = taskDeliveryAccountName(accountId);
    if (!byAccount.has(accountName)) byAccount.set(accountName, []);
    if (!byAccount.get(accountName).includes(agentName)) byAccount.get(accountName).push(agentName);
  }
  if (!byAccount.size) {
    const instanceId = String(task?.leadAgentInstanceId || task?.lead_agent_instance_id || '').trim();
    const familyId = String(task?.leadAgentId || task?.lead_agent_id || '').trim();
    const employee = roster.find((item) => String(item?.id || '') === instanceId) || {};
    const candidate = candidates.find((item) => String(item?.agentInstanceId || item?.agent_instance_id || '') === instanceId) || {};
    const fallbackName = candidate.displayName || candidate.name
      || state.org?.agents?.find((agent) => agent.id === familyId)?.name || familyId;
    if (fallbackName) byAccount.set(taskDeliveryAccountName(ownerUserId), [agentInstanceDisplayNameForUi(employee, fallbackName)]);
  }
  return [...byAccount].map(([accountName, agentNames]) => `${accountName} · ${agentNames.join('、')}`);
}

function taskDeliveryAccountName(userId = '') {
  const currentUser = state.currentUser || {};
  const currentUserId = String(currentUser.id || currentUser.userId || currentUser.user_id || '').trim();
  const friends = Array.isArray(state.friendOverview?.friends) ? state.friendOverview.friends : [];
  const user = userId && userId === currentUserId
    ? currentUser : friends.find((item) => String(item?.id || item?.userId || item?.user_id || '') === userId) || {};
  return cleanDeliveryText(user.remark || user.displayName || user.display_name || user.username || user.email)
    || (userId && userId !== currentUserId ? userId : '当前账号');
}

function cleanDeliveryList(value = []) {
  return (Array.isArray(value) ? value : value ? [value] : []).map((item) => cleanDeliveryText(
    typeof item === 'string' ? item : item?.title || item?.summary || item?.label,
  )).filter(Boolean).slice(0, 12);
}

function cleanDeliveryText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function renderTaskDurationBadge(durationLabel = '') {
  const text = state.languageMode === 'en'
    ? `Ran for ${durationLabel || 'unknown'}`
    : `已运行 ${durationLabel || '未知'}`;
  return `<span class="ubuddy-chat-task-duration">${iconSvg('clock')}<small>${escapeHtml(text)}</small></span>`;
}

function renderChatMessageTime(messageSentAt = '', visible = false) {
  const label = messageSentAt ? formatChatCardMessageTime(messageSentAt, { languageMode: state.languageMode }) : '';
  return visible && label ? `<time class="ubuddy-chat-card-message-time">${escapeHtml(label)}</time>` : '';
}

function renderChatTaskFiles(rawFiles = []) {
  const files = normalizeTerminalTaskFiles(rawFiles);
  if (!files.length) return '';
  return `<section class="ubuddy-chat-task-files" aria-label="完成文件"><header><strong>完成文件</strong><span>${files.length} 个</span></header>${files.map((file) => {
    const payload = filePayloadAttr(file);
    const visual = taskFileVisual(file);
    return `<article><button class="ubuddy-chat-task-file-name" type="button" data-open-file="${payload}" title="打开 ${escapeAttr(file.name)}"><span class="ubuddy-chat-task-file-icon is-${escapeAttr(visual.tone)}">${iconSvg(visual.icon)}<b>${escapeHtml(visual.badge)}</b></span><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(visual.label)}</small></span></button><span><button type="button" data-open-file="${payload}">${iconSvg('folder')}<span>打开</span></button><button type="button" data-save-file="${payload}">${iconSvg('download')}<span>下载</span></button></span></article>`;
  }).join('')}</section>`;
}

function taskFileVisual(file = {}) {
  const label = deliveryFileFormatLabel(file);
  if (label === 'Word') return { label, tone: 'word', icon: 'document', badge: 'W' };
  if (label === 'Excel' || label === 'CSV') return { label, tone: 'excel', icon: 'document', badge: 'X' };
  if (label === 'PowerPoint') return { label, tone: 'powerpoint', icon: 'presentation', badge: 'P' };
  if (label === 'PDF') return { label, tone: 'pdf', icon: 'document', badge: 'PDF' };
  if (label === 'Markdown') return { label, tone: 'markdown', icon: 'document', badge: 'MD' };
  if (['PNG', 'JPEG', 'WEBP'].includes(label)) return { label, tone: 'image', icon: 'image', badge: '' };
  return { label, tone: 'file', icon: 'file', badge: label.slice(0, 3) };
}

function terminalTaskTiming(task = null, { createdAt = '', completedAt = '', nodes = [] } = {}) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const explicitStart = firstTaskTimestamp(task?.metadata?.executionStartedAt, task?.startedAt);
  const nodeStarts = nodeList.map((node) => parseTaskTimestamp(node.startedAt)).filter(Number.isFinite);
  const createdAtMs = firstTaskTimestamp(task?.createdAt, task?.created_at, createdAt);
  const startedAtMs = Number.isFinite(explicitStart)
    ? explicitStart : nodeStarts.length ? Math.min(...nodeStarts) : createdAtMs;
  const taskCompletedAt = firstTaskTimestamp(task?.completedAt, task?.completed_at);
  const deliveredAt = parseTaskTimestamp(task?.metadata?.finalDelivery?.deliveredAt);
  const nodeCompletions = nodeList.map((node) => parseTaskTimestamp(node.completedAt)).filter(Number.isFinite);
  const completedAtMs = Number.isFinite(taskCompletedAt)
    ? taskCompletedAt
    : Number.isFinite(deliveredAt)
      ? deliveredAt
      : nodeCompletions.length ? Math.max(...nodeCompletions) : parseTaskTimestamp(completedAt);
  const durationMs = Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) && completedAtMs >= startedAtMs
    ? completedAtMs - startedAtMs : NaN;
  return { durationLabel: formatTaskDuration(durationMs) };
}

function parseTaskTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function firstTaskTimestamp(...values) {
  return values.map(parseTaskTimestamp).find(Number.isFinite) ?? NaN;
}

function formatTaskDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return '';
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const english = state.languageMode === 'en';
  if (totalSeconds < 1) return english ? '< 1s' : '< 1 秒';
  if (totalSeconds < 60) return english ? `${totalSeconds}s` : `${totalSeconds} 秒`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return english
    ? seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`
    : seconds ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return english
    ? minutes ? `${hours}h ${minutes}m` : `${hours}h`
    : minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
}

function terminalTaskFiles(task = null, deliverable = null, nodes = []) {
  const submissions = Array.isArray(task?.deliverySubmissions) ? task.deliverySubmissions : [];
  const latestSubmissionFiles = submissions.at(-1)?.artifactManifest || [];
  const nodeFiles = (Array.isArray(nodes) ? nodes : []).filter((node) => node.status === 'completed')
    .flatMap((node) => (Array.isArray(node.evidenceRefs) ? node.evidenceRefs : []))
    .filter((item) => ['file', 'artifact'].includes(String(item?.type || item?.kind || '').toLowerCase()));
  return normalizeTerminalTaskFiles([
    ...(Array.isArray(deliverable?.files) ? deliverable.files : []),
    ...(Array.isArray(task?.metadata?.deliverableResult?.files) ? task.metadata.deliverableResult.files : []),
    ...(Array.isArray(task?.metadata?.generatedTaskFiles) ? task.metadata.generatedTaskFiles : []),
    ...latestSubmissionFiles,
    ...nodeFiles,
  ]);
}

function normalizeTerminalTaskFiles(rawFiles = []) {
  const seen = new Set();
  return (Array.isArray(rawFiles) ? rawFiles : []).map((rawFile) => {
    const source = rawFile && typeof rawFile === 'object' ? rawFile : { path: rawFile };
    const sourcePath = String(source.path || source.source_path || source.sourcePath || source.snapshotPath || source.value || '').trim();
    const inferredName = sourcePath.split(/[\\/]/).filter(Boolean).at(-1) || 'file';
    return normalizeFilePayload({
      ...source,
      name: source.name || source.filename || source.label || inferredName,
      path: sourcePath,
      relative_path: source.relative_path || source.relativePath || '',
    });
  }).filter((file) => {
    const actionable = Boolean(file.path || file.remote_file_id || file.fileUrl);
    const key = file.path || file.remote_file_id || file.fileUrl || file.name;
    if (!actionable || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function deliveryFileFormatLabel(file = {}) {
  const value = String(file.name || file.filename || file.path || file.relative_path || '').toLowerCase();
  const extension = value.includes('.') ? value.split('.').pop() : '';
  return ({ doc: 'Word', docx: 'Word', md: 'Markdown', markdown: 'Markdown', pdf: 'PDF', ppt: 'PowerPoint', pptx: 'PowerPoint', xls: 'Excel', xlsx: 'Excel', csv: 'CSV', txt: 'Text', png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WEBP' })[extension]
    || (extension ? extension.toUpperCase() : 'File');
}

function shortDeliveryFormat(label = '') {
  return ({ Word: 'W', Markdown: 'MD', PowerPoint: 'P', Excel: 'X', Text: 'TXT' })[label] || label.slice(0, 4).toUpperCase();
}

function taskDisclosureAttributes(key = '', defaultOpen = false) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return defaultOpen ? ' open' : '';
  const hasState = Object.prototype.hasOwnProperty.call(state.taskDisclosureOpenByKey || {}, cleanKey);
  const open = hasState ? Boolean(state.taskDisclosureOpenByKey[cleanKey]) : Boolean(defaultOpen);
  return ` data-task-disclosure-key="${escapeAttr(cleanKey)}"${open ? ' open' : ''}`;
}

function renderDeliverableFile(rawFile = {}) {
  const file = normalizeFilePayload(rawFile);
  const payload = filePayloadAttr(file);
  return `<article class="final-deliverable-file"><span><strong>${escapeHtml(file.name)}</strong><small>${file.size ? `${Math.max(1, Math.round(file.size / 1024))} KB` : '交付文件'}</small></span><div><button type="button" data-preview-file="${payload}">预览</button><button type="button" data-open-file="${payload}">打开</button><button type="button" data-save-file="${payload}">下载</button><button type="button" data-show-file="${payload}">定位</button></div></article>`;
}
