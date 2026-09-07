import { state } from '../state.js';
import { iconSvg } from '../ui/icons.js';
import { clipInline, displayNodeTitle, displayTaskTitle, escapeAttr, escapeHtml, formatDateTime, formatNumber, isInternalTaskRecord, userVisibleErrorMessage } from '../utils/format.js';
import { agentInstanceDisplayNameForUi } from '../utils/agentIdentity.js';
import { TASK_CARD_ACTIONS, normalizeTaskSourceContext } from '../../../shared/contracts/taskCard.js';
import { deriveTaskLifecycleProgress, normalizeFinalDeliveryPolicy } from '../../../shared/contracts/uBuddyDeliveryReview.js';
import { renderAttachmentTray } from './chatView.js';
import { renderCodexTranscript } from './codexTranscriptView.js';
import { numberAgentInstanceLabels, renderAgentWorkProjectionSummary, workProjectionEnvelope, workProjectionForAgent, workProjectionForNode } from '../components/agentWorkProjection.js';
import { renderFinalDeliverableCard } from './taskProgressView.js';

let viewDeps = {};

export function configureCollaborationView(deps = {}) {
  viewDeps = { ...viewDeps, ...deps };
}

function agentNameById(...args) {
  return viewDeps.agentNameById?.(...args) || '';
}

function latestDelegationRecord(delegationId = '') {
  const id = String(delegationId || '').trim();
  if (!id) return null;
  return [
    ...(state.agentDelegations || []),
    ...(state.collaborationOverview?.tasks || []),
    ...(state.collaborationGroupDetail?.tasks || []),
  ].filter((item) => String(item?.id || '') === id).reduce((current, item) => {
    if (!current) return item;
    const currentTime = Date.parse(current.updatedAt || current.updated_at || '');
    const itemTime = Date.parse(item.updatedAt || item.updated_at || '');
    if (Number.isFinite(itemTime) && (!Number.isFinite(currentTime) || itemTime > currentTime)) return item;
    if (Number.isFinite(currentTime) && (!Number.isFinite(itemTime) || currentTime > itemTime)) return current;
    return item;
  }, null);
}

export function renderCollaboration() {
  const visibleTasks = (state.tasks || []).filter((item) => !isInternalTaskRecord(item));
  const selectedTask = state.taskDetail && !isInternalTaskRecord(state.taskDetail) ? state.taskDetail : null;
  if (state.activeTaskWorkspaceKind === 'task_run') {
    const rootTaskId = String(state.activeTaskWorkspaceId || '').trim();
    const activeTaskId = String(state.taskRunWorkspaceActiveRunById?.[rootTaskId] || rootTaskId).trim();
    const workspaceTask = selectedTask && (!activeTaskId || selectedTask.id === activeTaskId)
      ? selectedTask
      : visibleTasks.find((item) => item.id === activeTaskId || (!activeTaskId && item.id === rootTaskId)) || null;
    return renderLocalTaskWorkspace(workspaceTask || {
      id: rootTaskId || activeTaskId,
      title: '正在载入任务工作区',
      status: 'loading',
      metadata: {},
      nodes: [],
      communications: [],
      events: [],
    }, {
      loading: !workspaceTask,
      syncing: Boolean(state.taskWorkspaceLoadingById?.[rootTaskId]),
    });
  }
  const task = selectedTask || visibleTasks.find((item) => ['running', 'queued', 'pending', 'ready', 'verifying', 'waiting'].includes(item.status)) || visibleTasks[0] || null;
  const nodes = task?.nodes || [];
  const communications = task?.communications || [];
  const events = task?.events || [];
  const agents = collaborationAgents(task, nodes, communications);
  const progress = collaborationProgress(nodes, task);
  const openComms = communications.filter((item) => item.status === 'open');
  const waitingNodes = nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status));
  const runningNodes = nodes.filter((node) => node.status === 'running');
  const queuedNodes = nodes.filter((node) => node.status === 'queued');
  const readyNodes = nodes.filter((node) => node.status === 'ready');
  const taskActive = task && ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling'].includes(String(task.status || ''));
  const taskRerunnable = task && task.metadata?.source === 'ubuddy_dispatch'
    && !task.metadata?.continuedByTaskRunId
    && ['cancelled', 'failed'].includes(String(task.status || ''));
  return `
    <div class="view collaboration-view" aria-busy="${state.taskBusy ? 'true' : 'false'}" data-preserve-scroll data-scroll-key="collaboration:${escapeAttr(task?.id || 'empty')}">
      ${renderLocalTaskWorkspaceHeader(task)}
      <section class="collab-summary ${task ? '' : 'is-empty'}">
        <div class="collab-title">
          <span>${iconSvg('network')}</span>
          <div>
            <h2>${escapeHtml(task ? displayTaskTitle(task, '\u6682\u65e0\u534f\u4f5c\u4efb\u52a1') : '\u6682\u65e0\u534f\u4f5c\u4efb\u52a1')}</h2>
            <p>${task ? `${taskStatusLabel(task.status, task)} / ${leadershipTaskLabel(task)}` : '等待协作任务启动'}</p>
            ${task ? `<small>${escapeHtml(collaborationStateHint({ readyNodes, queuedNodes, runningNodes, waitingNodes, openComms }))}</small>` : ''}
          </div>
        </div>
        <div class="collab-actions">
          ${task ? `<button class="mini-btn" id="run-ready-btn" type="button" ${state.taskBusy || (!readyNodes.length && !openComms.length && !waitingNodes.length) ? 'disabled' : ''}>${state.taskBusy ? '正在运行…' : '运行可执行节点'}</button>` : ''}
          ${taskActive ? `<button class="mini-btn muted" data-cancel-ubuddy-task="${escapeAttr(task.id)}" type="button" ${state.taskBusy || task.status === 'cancelling' ? 'disabled' : ''}>${task.status === 'cancelling' ? '正在停止…' : '停止整个任务'}</button>` : ''}
          ${taskRerunnable ? `<button class="mini-btn" data-rerun-ubuddy-task="${escapeAttr(task.id)}" type="button" ${state.taskBusy ? 'disabled' : ''}>重新执行</button>` : ''}
          ${task ? `<button class="mini-btn muted" data-delete-collaboration-tasks="${escapeAttr(task.id)}" type="button" ${state.busy || state.taskBusy ? 'disabled' : ''}>删除记录</button>` : ''}
        </div>
        ${task ? `<div class="collab-metrics">
          ${renderCollabMetric('总体进度', `${progress.percent}%`, `${progress.label} · ${progress.done}/${progress.total} 执行节点`, progress.percent === 100 ? 'success' : 'active')}
          ${renderCollabMetric('参与 Agent', formatNumber(agents.length), `${formatNumber(runningNodes.length)} 运行 / ${formatNumber(queuedNodes.length)} 排队`, runningNodes.length || queuedNodes.length ? 'active' : 'muted')}
          ${renderCollabMetric('等待沟通', formatNumber(openComms.length), `${formatNumber(waitingNodes.length)} 个节点等待`, openComms.length || waitingNodes.length ? 'warning' : 'muted')}
          ${renderCollabMetric('可执行', formatNumber(readyNodes.length), '就绪队列', readyNodes.length ? 'ready' : 'muted')}
        </div>` : ''}
      </section>
      ${state.taskBusy ? '<div class="collab-state-notice is-running" role="status"><i aria-hidden="true"></i><span><strong>正在运行可执行节点</strong><small>节点状态和协作 Memory 会在本轮完成后刷新。</small></span></div>' : ''}
      ${renderLeadershipPolicyNotice(task)}
      ${task ? `<section class="collab-flow">
        ${renderCollabStage('待依赖/待执行', nodes.filter((node) => ['pending', 'ready', 'retry_wait'].includes(node.status)), 'queue', taskWorkProjection(task), agents)}
        ${renderCollabStage('排队/运行中', [...queuedNodes, ...runningNodes], 'running', taskWorkProjection(task), agents)}
        ${renderCollabStage('等待协作/阻塞', waitingNodes, 'waiting', taskWorkProjection(task), agents)}
        ${renderCollabStage('已完成/失败', nodes.filter((node) => ['completed', 'failed'].includes(node.status)), 'terminal', taskWorkProjection(task), agents)}
      </section>
      <section class="collab-grid">
        <div class="collab-panel">
          <h3>参与 Agent</h3>
          <div class="collab-agent-list">
            ${agents.map(renderCollabAgent).join('') || '<div class="empty small">暂无参与 Agent。</div>'}
          </div>
        </div>
        <div class="collab-panel">
          <h3>沟通队列</h3>
          <div class="collab-comm-list">
            ${openComms.map(renderCollabCommunication).join('') || '<div class="empty small">暂无开放沟通。</div>'}
          </div>
        </div>
        <div class="collab-panel collab-panel-wide">
          <h3>最近协作事件</h3>
          <div class="collab-event-list">
            ${renderCollabEventStream(events, task.id)}
          </div>
        </div>
        ${renderWorkMemoryObservability(task)}
      </section>` : renderCollaborationEmpty()}
    </div>
  `;
}

function renderLocalTaskWorkspace(task = {}, { loading = false, syncing = false } = {}) {
  const taskId = state.activeTaskWorkspaceId || task.id || '';
  const selected = ['activity', 'result'].includes(state.taskWorkspaceViewById?.[taskId])
    ? state.taskWorkspaceViewById[taskId]
    : 'activity';
  const nodes = task.nodes || [];
  const progress = collaborationProgress(nodes, task);
  const messages = state.taskRunWorkspaceMessagesById?.[taskId] || [];
  const draft = state.taskRunWorkspaceDrafts?.[taskId] || '';
  const deliverable = task.metadata?.deliverableResult || task.metadata?.deliverable || null;
  const workspaceSubject = taskWorkspaceSubject(task, deliverable);
  const workspaceHeading = selected === 'result' ? '查看交付：' : '任务详情：';
  const context = normalizeTaskSourceContext({
    ...(state.activeTaskSourceContext || {}),
    task_workspace_id: taskId,
  });
  return `<div class="view collaboration-view local-task-workspace" data-task-run-workspace="${escapeAttr(taskId)}">
    <header class="local-task-workspace-summary">
      <button type="button" class="local-task-workspace-back" title="返回原对话继续沟通" aria-label="返回原对话继续沟通"
        data-task-card-action="${TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT}"
        data-task-workspace-kind="task_run"
        data-task-workspace-id="${escapeAttr(taskId)}"
        data-task-source-conversation-id="${escapeAttr(context.source_conversation_id)}"
        data-task-source-message-id="${escapeAttr(context.source_message_id)}"
        data-task-source-group-id="${escapeAttr(context.source_group_id)}"
        data-task-return-anchor-id="${escapeAttr(state.activeTaskReturnAnchorId || '')}"
        data-task-return-surface="${escapeAttr(state.activeTaskReturnSurface || 'session')}">${iconSvg('chevronLeft')}<span>返回原对话</span></button>
      <div class="local-task-workspace-heading"><h2><span>${workspaceHeading}</span><span data-no-localize>${escapeHtml(workspaceSubject)}</span></h2><p>${escapeHtml(loading ? '正在读取任务数据。' : selected === 'result' ? '交付结果与验收记录' : '任务进度与执行记录')}</p></div>
      <span class="local-task-workspace-status"><b>${escapeHtml(loading || syncing ? '正在同步' : progress.label)}</b><small>${loading ? '正在准备任务视图' : syncing ? `保留已有动态 · ${progress.percent}%` : `${progress.percent}% · ${progress.done}/${progress.total} 执行节点`}</small></span>
    </header>
    <nav class="network-task-workspace-tabs" aria-label="任务工作区视图">
      ${[['activity', '动态'], ['result', deliverable ? '结果' : '结果 · 待生成']].map(([value, label]) => `<button type="button" class="${selected === value ? 'active' : ''}" data-task-workspace-view="${value}" data-task-workspace-id="${escapeAttr(taskId)}" aria-pressed="${selected === value ? 'true' : 'false'}">${escapeHtml(label)}</button>`).join('')}
    </nav>
    <main class="local-task-workspace-body" data-preserve-scroll data-scroll-key="task-run-workspace:${escapeAttr(taskId)}">
      ${loading ? '<section class="local-task-workspace-loading" role="status"><i></i><strong>正在读取任务数据</strong><span>动态和结果位置会保持不变。</span></section>' : selected === 'result' ? renderLocalTaskResult(task, deliverable) : renderLocalTaskActivity(task, messages, progress)}
    </main>
    <form class="local-task-workspace-composer ${state.attachments.length ? 'has-attachments' : ''}" id="task-run-workspace-form" data-task-run-id="${escapeAttr(taskId)}">
      ${renderAttachmentTray()}
      <textarea id="task-run-workspace-input" rows="2" placeholder="询问进度、查看验收原因、补充要求，或说“采用第 2 版”" ${loading ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
      <div><button class="composer-plus" type="button" title="上传文件" ${loading ? 'disabled' : ''}>+</button><span>${loading ? '任务同步完成后即可继续沟通。' : '查询和采用版本立即处理；修改要求按 FIFO 进入后续轮次。'}</span><button class="send-btn" type="submit" title="发送" aria-label="发送" ${loading || (!String(draft).trim() && !state.attachments.length) ? 'disabled' : ''}>${iconSvg('send')}</button></div>
    </form>
  </div>`;
}

function taskWorkspaceSubject(task = {}, deliverable = null) {
  const contractDeliverables = task?.metadata?.deliverableContract?.deliverables || [];
  const primaryDeliverable = contractDeliverables.find((item) => item?.role === 'primary') || contractDeliverables[0];
  const candidate = deliverable?.title || primaryDeliverable?.title || displayTaskTitle(task, '协作任务');
  return clipInline(String(candidate || '协作任务').trim(), 72);
}

function renderLocalTaskActivity(task = {}, messages = [], progress = {}) {
  const activeNodes = (task.nodes || []).filter((node) => ['ready', 'queued', 'running', 'waiting', 'retry_wait', 'blocked'].includes(node.status));
  return `<section class="local-task-activity">
    <article class="collaboration-card collaboration-status-card">
      <header><span>当前状态</span><strong>${escapeHtml(taskStatusLabel(task.status, task))}</strong></header>
      <div class="network-delegation-progress-track"><i style="width:${Number(progress.percent || 0)}%"></i></div>
      <p>${escapeHtml(task.summary || `${progress.done} 个节点已完成，${activeNodes.length} 个节点仍在处理。`)}</p>
      ${activeNodes.length ? `<div class="local-task-active-nodes">${activeNodes.slice(0, 4).map((node) => `<span><b>${escapeHtml(displayNodeTitle(node, '任务节点'))}</b><small>${escapeHtml(taskStatusLabel(node.status))}</small></span>`).join('')}</div>` : ''}
    </article>
    ${renderTaskFailureDiagnostics(task)}
    <section class="local-task-codex-transcript">${renderCollabEventStream(task.events || [], task.id || '')}</section>
    <section class="local-task-message-timeline">${messages.length ? messages.map(renderLocalTaskWorkspaceMessage).join('') : '<div class="local-task-workspace-empty"><strong>暂无补充消息</strong><span>任务进度会显示在上方；你可以随时在底部追加要求。</span></div>'}</section>
    <details class="collaboration-technical-details local-task-technical-details"${taskDisclosureAttributes(`${task.id || state.activeTaskWorkspaceId || 'task'}:technical`)}><summary>查看技术详情</summary>${renderLocalTaskTechnicalDetails(task)}</details>
  </section>`;
}

export function taskFailureDiagnostics(task = {}) {
  if (String(task.status || '') !== 'failed') return null;
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const events = (Array.isArray(task.events) ? task.events : [])
    .map((event, index) => ({ event, index, time: taskEventTime(event) }))
    .sort((left, right) => left.time - right.time || left.index - right.index);
  const failedEvents = events.filter(({ event }) => taskEventFailed(event));
  const latestFailedEvent = failedEvents.at(-1)?.event || null;
  const reportedNodeId = String(
    latestFailedEvent?.taskNodeId || latestFailedEvent?.task_node_id
    || task.metadata?.failureReport?.nodeId || task.metadata?.publicFailure?.nodeId || '',
  ).trim();
  const failedNodes = nodes.filter((node) => String(node.status || '') === 'failed');
  const node = nodes.find((item) => String(item.id || '') === reportedNodeId)
    || [...failedNodes].sort((left, right) => taskNodeTime(left) - taskNodeTime(right)).at(-1)
    || null;
  const nodeId = String(node?.id || reportedNodeId || '').trim();
  const nodeEvents = nodeId
    ? events.filter(({ event }) => String(event.taskNodeId || event.task_node_id || '') === nodeId)
    : [];
  const nodeFailure = [...nodeEvents].reverse().find(({ event }) => taskEventFailed(event)) || null;
  const failureBoundary = nodeFailure || (latestFailedEvent ? events.find(({ event }) => event === latestFailedEvent) : null);
  const boundaryPosition = failureBoundary ? events.indexOf(failureBoundary) : events.length - 1;
  const commands = nodeEvents
    .filter(({ event }) => taskCommandEvent(event))
    .filter((entry) => events.indexOf(entry) <= boundaryPosition)
    .slice(-3)
    .map(({ event }) => ({
      id: String(event.id || event.eventId || ''),
      command: String(event.command || event.payload?.command || event.payload?.detail || '').trim(),
      output: String(event.output || event.payload?.output || '').trim(),
      cwd: String(event.payload?.cwd || '').trim(),
      status: taskCommandStatus(event),
      exitCode: Number.isInteger(event.payload?.exitCode) ? event.payload.exitCode : null,
      occurredAt: event.updatedAt || event.createdAt || '',
    }));
  const failureEvent = nodeFailure?.event || latestFailedEvent;
  const failureEventIsCommand = taskCommandEvent(failureEvent || {});
  const error = String(
    failureEvent?.payload?.error
    || failureEvent?.payload?.failureReport?.summary
    || failureEvent?.payload?.failureReport?.cause
    || node?.errorText
    || task.metadata?.failureReport?.summary
    || task.metadata?.failureReport?.cause
    || task.metadata?.publicFailure?.summary
    || task.metadata?.publicFailure?.message
    || task.lastError
    || task.summary
    || (!failureEventIsCommand ? failureEvent?.summary : '')
    || failureEvent?.summary
    || '',
  ).trim();
  if (!error) return null;
  return {
    error,
    node: node ? {
      id: String(node.id || ''),
      title: displayNodeTitle(node, '任务节点'),
      agentName: agentNameById(node.agentId) || node.agentId || '',
    } : null,
    occurredAt: failureEvent?.updatedAt || failureEvent?.createdAt || node?.completedAt || node?.updatedAt || '',
    commands,
  };
}

function taskEventTime(event = {}) {
  const timestamp = Number(event.payload?.completedAtMs ?? event.payload?.startedAtMs);
  if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  const parsed = Date.parse(event.createdAt || event.updatedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskNodeTime(node = {}) {
  const parsed = Date.parse(node.completedAt || node.updatedAt || node.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskEventFailed(event = {}) {
  const status = String(event.status || event.payload?.status || '').toLowerCase();
  const eventType = String(event.eventType || event.event_type || '').toLowerCase();
  const exitCode = event.payload?.exitCode;
  return status === 'failed' || Boolean(event.payload?.failureReport)
    || eventType === 'leader_failure_decision'
    || (Number.isInteger(exitCode) && exitCode !== 0)
    || /(?:^|_)(?:failed|failure|timeout)(?:$|_)/.test(eventType);
}

function taskCommandEvent(event = {}) {
  const activityType = String(event.payload?.activityType || '').toLowerCase();
  return activityType === 'command' && Boolean(String(event.command || event.payload?.command || event.payload?.detail || '').trim());
}

function taskCommandStatus(event = {}) {
  const status = String(event.status || event.payload?.status || '').toLowerCase();
  if (taskEventFailed(event)) return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (['running', 'waiting'].includes(status)) return 'running';
  return 'completed';
}

function renderTaskFailureDiagnostics(task = {}) {
  const diagnostics = taskFailureDiagnostics(task);
  if (!diagnostics) return '';
  const meta = [
    diagnostics.node?.title ? `<span>失败节点：${escapeHtml(diagnostics.node.title)}</span>` : '',
    diagnostics.node?.agentName ? `<span>Agent: ${escapeHtml(diagnostics.node.agentName)}</span>` : '',
    diagnostics.occurredAt ? `<time>${escapeHtml(formatDateTime(diagnostics.occurredAt))}</time>` : '',
  ].filter(Boolean).join('');
  return `<section class="local-task-failure-diagnostics" role="alert" aria-label="任务执行失败诊断">
    <header><span>${iconSvg('stop')}</span><div><small>最后一次报错</small><strong>${escapeHtml(diagnostics.error)}</strong>${meta ? `<em>${meta}</em>` : ''}</div></header>
    ${diagnostics.commands.length ? `<div class="local-task-failure-commands"><h3>报错前最近 ${diagnostics.commands.length} 条命令</h3>${diagnostics.commands.map((command, index) => renderTaskFailureCommand(command, index)).join('')}</div>` : '<p class="local-task-failure-no-commands">该失败节点没有可用的命令执行记录。</p>'}
  </section>`;
}

function renderTaskFailureCommand(command = {}, index = 0) {
  const labels = { completed: '成功', failed: '失败', running: '执行中', cancelled: '已取消' };
  const meta = [
    command.exitCode !== null ? `退出码 ${command.exitCode}` : '',
    command.occurredAt ? formatDateTime(command.occurredAt) : '',
  ].filter(Boolean).join(' · ');
  const outputSummary = command.output ? clipInline(command.output, 240) : '无输出';
  return `<article class="local-task-failure-command is-${escapeAttr(command.status)}">
    <header><span>命令 ${index + 1}</span><b>${escapeHtml(labels[command.status] || command.status)}</b>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</header>
    <code>${escapeHtml(command.command || '命令')}</code>
    <p>${escapeHtml(outputSummary)}</p>
    <details><summary>查看完整输出</summary><div><small>命令</small><pre><code>${escapeHtml(command.command || '命令')}</code></pre>${command.cwd ? `<small>工作目录</small><pre><code>${escapeHtml(command.cwd)}</code></pre>` : ''}<small>输出</small><pre><code>${escapeHtml(command.output || '无输出')}</code></pre></div></details>
  </article>`;
}

function renderLocalTaskWorkspaceMessage(message = {}) {
  const mine = message.role === 'user';
  const status = message.metadata?.queueStatus || '';
  const statusLabel = ({ queued: '已排队', waiting: '等待上一轮完成', running: '正在处理', completed: '已完成', failed: '处理失败', cancelled: '已取消' })[status] || '';
  return `<article class="local-task-workspace-message ${mine ? 'mine' : 'agent'} ${status ? `is-${escapeAttr(status)}` : ''}" data-message-id="${escapeAttr(message.id || '')}"><header><strong>${mine ? '我' : 'uBuddy'}</strong>${statusLabel ? `<span>${escapeHtml(statusLabel)}</span>` : ''}</header><div>${escapeHtml(message.content || '')}</div>${message.metadata?.queueError ? `<small>${escapeHtml(message.metadata.queueError)}</small>` : ''}</article>`;
}

function renderLocalTaskResult(task = {}, deliverable = null) {
  const latestSubmission = Array.isArray(task.deliverySubmissions) ? task.deliverySubmissions.at(-1) : null;
  const currentSubmissionId = String(task.metadata?.selectedDeliverySubmissionId
    || deliverable?.selectedSubmissionId || latestSubmission?.id || '');
  const resultWorkspaceId = String(state.activeTaskWorkspaceId || task.id || '');
  const requestedSubmissionId = String(state.taskResultSubmissionById?.[resultWorkspaceId] || '');
  const requestedSubmission = requestedSubmissionId
    ? (task.deliverySubmissions || []).find((item) => String(item.id || '') === requestedSubmissionId) || null
    : null;
  const showingHistoricalSubmission = Boolean(requestedSubmission && requestedSubmission.id !== currentSubmissionId);
  const requestedDeliverable = requestedSubmission ? {
    resultState: showingHistoricalSubmission ? 'under_review' : deliverable?.resultState || 'delivered',
    validationState: showingHistoricalSubmission ? 'pending' : deliverable?.validationState || 'passed',
    previewVersion: showingHistoricalSubmission,
    acceptanceSource: showingHistoricalSubmission ? '' : deliverable?.acceptanceSource || '',
    title: task.title || deliverable?.title || `交付版本 ${requestedSubmission.submissionNo}`,
    summary: showingHistoricalSubmission
      ? `历史交付版本 ${requestedSubmission.submissionNo}，仅供查看和对比。`
      : deliverable?.summary || task.summary || '当前交付版本。',
    body: requestedSubmission.bodySnapshot || '',
    files: (requestedSubmission.artifactManifest || []).map((file) => ({
      ...file,
      path: file.path || file.snapshotPath || '',
      relative_path: file.relativePath || file.relative_path || '',
    })),
    selectedSubmissionId: requestedSubmission.id,
    selectedSubmissionNo: requestedSubmission.submissionNo,
  } : null;
  const current = requestedDeliverable || deliverable || (latestSubmission ? {
    resultState: 'under_review',
    validationState: 'pending',
    previewVersion: true,
    title: `当前已保存版本 ${latestSubmission.submissionNo}`,
    summary: task.deliveryReview?.summary || task.metadata?.deliveryReview?.summary || '该版本已可查看，质量检查不会阻止你接受或要求修改。',
    body: latestSubmission.bodySnapshot || '',
    files: (latestSubmission.artifactManifest || []).map((file) => ({
      ...file,
      path: file.path || file.snapshotPath || '',
      relative_path: file.relativePath || file.relative_path || '',
    })),
  } : null);
  const finalDelivery = finalDeliveryForTask(task);
  const revisionPending = finalDelivery.state === 'not_delivered' && Boolean(task.metadata?.deliveryRevisionRequestedAt);
  const displayCurrent = finalDelivery.state === 'failed' && current ? {
    ...current,
    deliveryFailedSnapshot: true,
    summary: '交付失败；这里保留已经生成的正文和文件快照，重试成功后会产生新的正式交付状态。',
  } : revisionPending && current ? {
      ...current,
      previewVersion: true,
      resultState: 'under_review',
      summary: '你已要求修改；此处保留上一版交付快照，新版本完成后即可再次查看和确认。',
    } : current;
  const selectedSubmissionId = String(task.metadata?.selectedDeliverySubmissionId
    || deliverable?.selectedSubmissionId || latestSubmission?.id || '');
  const selectedSubmissionNo = Number(task.metadata?.selectedDeliverySubmissionNo
    || current?.selectedSubmissionNo || latestSubmission?.submissionNo || 0);
  const ready = Boolean(current || ['completed', 'failed', 'cancelled'].includes(String(task.status || '')));
  return `<section class="network-task-result-view ${ready ? 'is-ready' : 'is-pending'}">
    ${renderFinalDeliveryStatus(task, finalDelivery, { selectedSubmissionId, selectedSubmissionNo })}
    ${requestedSubmission ? `<header class="network-task-selected-delivery-version" data-delivery-submission-id="${escapeAttr(requestedSubmission.id || '')}"><span>正在查看版本 ${Math.max(1, Number(requestedSubmission.submissionNo || 1))}</span><small>${showingHistoricalSubmission ? '历史交付快照' : '当前交付版本'}</small></header>` : ''}
    ${displayCurrent
    ? renderFinalDeliverableCard(displayCurrent, { resultState: displayCurrent.resultState, fallback: task.summary || '', disclosureKeyPrefix: task.id || state.activeTaskWorkspaceId || '' })
    : `<article class="collaboration-card"><header><span>${ready ? '任务结果' : '等待结果'}</span><strong>${escapeHtml(task.title || '任务交付')}</strong></header><p>${escapeHtml(task.summary || '任务完成后，结果摘要会显示在这里。')}</p></article>`}
  </section>`;
}

function renderFinalDeliveryStatus(task = {}, delivery = {}, { selectedSubmissionId = '', selectedSubmissionNo = 0 } = {}) {
  const review = task.deliveryReview || task.metadata?.deliveryReview || {};
  const deliveryState = String(delivery.state || 'not_delivered');
  const externalDelegationId = String(task.metadata?.delegationId || '').trim();
  const externalDelegation = task.metadata?.taskOrigin === 'external_delegation' && Boolean(externalDelegationId);
  const externalDelegationRecord = externalDelegation ? latestDelegationRecord(externalDelegationId) : null;
  const externalDelegationStatus = String(externalDelegationRecord?.status || '');
  const externalSubmitted = ['submitted', 'completed', 'result_accepted', 'closed'].includes(externalDelegationStatus);
  const externalAccepted = ['result_accepted', 'closed'].includes(externalDelegationStatus);
  const externalRevisionRequested = externalDelegationStatus === 'revision_requested';
  const revisionPending = deliveryState === 'not_delivered' && Boolean(task.metadata?.deliveryRevisionRequestedAt);
  const failureReason = delivery.failureReason || task.metadata?.failureReport?.summary
    || task.metadata?.failureReport?.cause || task.metadata?.publicFailure?.summary
    || task.metadata?.publicFailure?.message || task.metadata?.deliveryValidationSummary
    || task.lastError || task.summary || '交付未成功完成。';
  const labels = externalDelegation ? {
    not_delivered: revisionPending
      ? ['已要求修改 · 等待新版本', '上一版不会直接交付；修改完成后请回到委托任务确认交付。']
      : ['尚未生成可交付结果', '任务仍在处理，完成后由接收方确认交付给发出方。'],
    delivered: ['结果已就绪 · 等待接收方交付', '这里不会由接收方关闭任务。请回到委托任务确认交付，最终由发出方验收或打回重做。'],
    user_confirmed: ['已确认交付', '结果正在同步给发出方，等待对方验收。'],
    closed: ['发出方已确认任务结束', '最终结果已由任务发出方验收。'],
    failed: ['交付失败', failureReason],
  } : {
    not_delivered: revisionPending
      ? ['已要求修改 · 等待新版本', '上一版未被确认，任务不会关闭。修改要求已进入后续处理。']
      : ['尚未正式交付', '任务仍在处理，当前没有等待你确认的正式交付版本。'],
    delivered: ['结果已交付 · 等待你确认', '结果已经可查看；后台质量检查仅提供建议。你可以接受当前版本或要求修改。'],
    user_confirmed: ['用户已确认', '确认已记录，任务正在进入最终关闭。'],
    closed: ['任务已关闭', '你已接受本次交付，最终确认闭环已完成。'],
    failed: ['交付失败', failureReason],
  };
  let [title, detail] = labels[deliveryState] || labels.not_delivered;
  if (externalAccepted) {
    title = '发出方已确认任务结束';
    detail = '最终结果已由任务发出方验收，本次外部委托已经结束。';
  } else if (externalSubmitted) {
    title = '已交付 · 等待发出方验收';
    detail = '结果已经发送给任务发出方；对方可以确认任务结束，或打回重做。';
  } else if (externalRevisionRequested) {
    title = '发出方已打回 · 等待修改';
    detail = '发出方提出了重做要求，请回到委托任务查看反馈并完成新版本。';
  }
  const conclusion = review.summary || task.metadata?.deliveryValidationSummary || '';
  const canConfirm = !externalDelegation && deliveryState === 'delivered' && Boolean(selectedSubmissionId);
  const externalDeliveryStillPending = externalDelegation
    && !externalSubmitted && !externalAccepted && !externalRevisionRequested;
  const canOpenExternalDelivery = externalDelegation && deliveryState === 'delivered'
    && externalDeliveryStillPending;
  const canOpenExternalRevision = externalDelegation && externalRevisionRequested;
  const canRequestRevision = deliveryState === 'delivered'
    && (!externalDelegation || externalDeliveryStillPending);
  const canRetry = deliveryState === 'failed' && delivery.retryable !== false && task.metadata?.source === 'ubuddy_dispatch';
  const actionsDisabled = state.taskBusy ? 'disabled' : '';
  return `<article class="collaboration-card final-delivery-status is-${escapeAttr(deliveryState)}" data-final-delivery-state="${escapeAttr(deliveryState)}"${externalDelegationStatus ? ` data-external-delegation-status="${escapeAttr(externalDelegationStatus)}"` : ''}>
    <header><span>当前交付状态</span><strong>${escapeHtml(title)}</strong></header>
    <p>${escapeHtml(detail)}</p>
    ${conclusion ? `<div class="final-delivery-conclusion"><strong>质量检查</strong><span>${escapeHtml(conclusion)}</span></div>` : ''}
    <ol class="final-delivery-steps" aria-label="最终交付流程">
      ${renderFinalDeliveryStep(externalDelegation ? '结果已就绪' : '已交付', ['delivered', 'user_confirmed', 'closed'].includes(deliveryState), externalDelegation ? !externalSubmitted && !externalRevisionRequested && deliveryState === 'delivered' : deliveryState === 'delivered')}
      ${renderFinalDeliveryStep(externalDelegation ? '接收方交付' : '用户确认', externalDelegation ? externalSubmitted : ['user_confirmed', 'closed'].includes(deliveryState), externalDelegation ? externalSubmitted && !externalAccepted : deliveryState === 'user_confirmed')}
      ${renderFinalDeliveryStep(externalDelegation ? '发出方验收' : '任务关闭', externalDelegation ? externalAccepted : deliveryState === 'closed', externalDelegation ? externalAccepted : deliveryState === 'closed')}
    </ol>
    ${canConfirm || canOpenExternalDelivery || canOpenExternalRevision || canRequestRevision || canRetry ? `<footer class="final-delivery-actions">
      ${canConfirm ? `<button class="btn primary" type="button" data-accept-delivery-submission="${escapeAttr(selectedSubmissionId)}" data-delivery-submission-no="${Math.max(1, selectedSubmissionNo)}" ${actionsDisabled}>接受交付并关闭任务</button>` : ''}
      ${canOpenExternalDelivery ? `<button class="btn primary" type="button" data-network-delegation="${escapeAttr(externalDelegationId)}" ${actionsDisabled}>去委托任务确认交付</button>` : ''}
      ${canOpenExternalRevision ? `<button class="btn primary" type="button" data-network-delegation="${escapeAttr(externalDelegationId)}" ${actionsDisabled}>查看打回要求并继续修改</button>` : ''}
      ${canRequestRevision ? `<button class="btn secondary" type="button" data-request-delivery-revision="${escapeAttr(task.id || '')}" ${actionsDisabled}>${externalDelegation ? '继续修改后再交付' : '要求修改'}</button>` : ''}
      ${canRetry ? `<button class="btn primary" type="button" data-rerun-ubuddy-task="${escapeAttr(task.id || '')}" ${actionsDisabled}>${state.taskBusy ? '正在重试…' : '重试交付'}</button>` : ''}
    </footer>` : ''}
  </article>`;
}

function renderFinalDeliveryStep(label = '', complete = false, active = false) {
  return `<li class="${complete ? 'is-complete' : ''} ${active ? 'is-active' : ''}"><i>${complete ? '✓' : '○'}</i><span>${escapeHtml(label)}</span></li>`;
}

function finalDeliveryForTask(task = {}) {
  return normalizeFinalDeliveryPolicy(task.metadata?.finalDelivery, {
    ...task.metadata,
    deliveryFailed: task.status === 'failed' && Boolean(task.deliveryReview || task.metadata?.deliveryReview
      || task.metadata?.deliveryValidationState === 'failed'),
    failureReason: task.metadata?.failureReport?.summary || task.metadata?.deliveryValidationSummary || '',
    retryable: task.metadata?.failureReport?.retryable,
  });
}

function renderLocalTaskFlow(task = {}) {
  const agents = collaborationAgents(task, task.nodes || [], task.communications || []);
  const groups = [
    ['待执行', ['pending', 'ready']], ['处理中', ['queued', 'running']],
    ['等待 / 阻塞', ['waiting', 'retry_wait', 'blocked']], ['已结束', ['completed', 'failed', 'cancelled']],
  ];
  return `<section class="network-task-flow-view"><header><strong>任务流程图</strong><span>仅在当前视图展示。</span></header><div class="network-task-flow-columns">${groups.map(([label, statuses]) => {
    const items = (task.nodes || []).filter((node) => statuses.includes(String(node.status || 'pending')));
    return `<section><h3>${escapeHtml(label)}<b>${items.length}</b></h3><div>${items.length ? items.map((node) => { const projection = workProjectionForNode(taskWorkProjection(task), node); return `<article class="is-${escapeAttr(node.status || 'pending')}"><strong>${escapeHtml(displayNodeTitle(node, '任务节点'))}</strong><span>${escapeHtml(agentDisplayNameForNode(node, agents) || projection?.actorLabel || agentNameById(node.agentId) || node.agentId || 'Agent')} · ${escapeHtml(taskStatusLabel(node.status))}</span>${projection?.currentAction ? `<p>${escapeHtml(projection.currentAction)}</p>` : node.objective ? `<p>${escapeHtml(node.objective)}</p>` : ''}${projection?.timeline?.length ? `<small>${escapeHtml(projection.timeline.at(-1)?.summary || '')}</small>` : ''}</article>`; }).join('') : '<p class="network-task-flow-empty">暂无节点</p>'}</div></section>`;
  }).join('')}</div></section>`;
}

function renderLocalTaskTechnicalDetails(task = {}) {
  const agents = collaborationAgents(task, task.nodes || [], task.communications || []);
  return `<section class="collaboration-task-nodes"><strong>节点状态</strong>${(task.nodes || []).map((node) => `<div class="is-${escapeAttr(node.status || 'pending')}"><span><b>${escapeHtml(displayNodeTitle(node, '任务节点'))}</b><small>${escapeHtml(taskStatusLabel(node.status))}${node.agentId ? ` · ${escapeHtml(agentDisplayNameForNode(node, agents) || agentNameById(node.agentId) || node.agentId)}` : ''}</small></span></div>`).join('') || '<p>暂无节点数据。</p>'}</section>`;
}

function taskDisclosureAttributes(key = '', defaultOpen = false) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return defaultOpen ? ' open' : '';
  const hasState = Object.prototype.hasOwnProperty.call(state.taskDisclosureOpenByKey || {}, cleanKey);
  const open = hasState ? Boolean(state.taskDisclosureOpenByKey[cleanKey]) : Boolean(defaultOpen);
  return ` data-task-disclosure-key="${escapeAttr(cleanKey)}"${open ? ' open' : ''}`;
}

function renderLocalTaskWorkspaceHeader(task = null) {
  if (state.activeTaskWorkspaceKind !== 'task_run') return '';
  const context = normalizeTaskSourceContext({
    ...(state.activeTaskSourceContext || {}),
    task_workspace_id: state.activeTaskWorkspaceId || task?.id || '',
  });
  return `<header class="local-task-workspace-return"><button type="button"
    data-task-card-action="${TASK_CARD_ACTIONS.RETURN_TO_SOURCE_CHAT}"
    data-task-workspace-kind="task_run"
    data-task-workspace-id="${escapeAttr(context.task_workspace_id)}"
    data-task-source-conversation-id="${escapeAttr(context.source_conversation_id)}"
    data-task-source-message-id="${escapeAttr(context.source_message_id)}"
    data-task-source-group-id="${escapeAttr(context.source_group_id)}"
    data-task-return-anchor-id="${escapeAttr(state.activeTaskReturnAnchorId || '')}"
    data-task-return-surface="${escapeAttr(state.activeTaskReturnSurface || 'session')}">${iconSvg('chevronLeft')}<span>返回原对话</span></button><strong>多 Agent 任务工作区</strong></header>`;
}

function renderLeadershipPolicyNotice(task = null) {
  if (!task?.metadata?.leadershipPolicyViolation) return '';
  const selection = task.metadata.taskLeaderSelection || {};
  const mode = task.metadata.leadershipEnforcementMode || selection.enforcementMode || 'shadow';
  const reasons = selection.assignmentEligibility?.reasons || [];
  const labels = reasons.map(leadershipPolicyReasonLabel).filter(Boolean);
  const title = mode === 'warn' ? 'Leadership 资格警告' : 'Leadership Shadow 记录';
  const detail = mode === 'warn'
    ? '当前任务继续由 uBuddy 平面协调；Leadership 资格只影响是否任命 Agent Leader，不影响 uBuddy 调度。'
    : '当前由 uBuddy 平面协调，无需授予 Agent Leader 权限；系统仅记录 Leadership 资格评估。';
  return `<div class="collab-state-notice is-warning" role="status"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}${labels.length ? ` 原因：${escapeHtml(labels.join('、'))}。` : ''}</small></span></div>`;
}

function leadershipPolicyReasonLabel(value = '') {
  return ({
    leadership_not_active: 'Leadership 已冻结或不可用', leadership_level_insufficient: '职级不足',
    agent_limit_exceeded: '协调 Agent 数超限', node_limit_exceeded: '任务节点数超限',
    task_group_limit_exceeded: '任务组数量超限', cross_department_not_allowed: '当前职级不允许跨部门',
    supervisor_approval_required: '缺少试岗监督批准', governance_approval_required: '缺少治理批准',
    professional_p3_required: '需要已确认 P3', professional_p5_required: '需要已确认 P5', professional_p7_required: '需要已确认 P7',
  })[value] || value;
}

function renderCollaborationEmpty() {
  return `<section class="collab-empty-state">
    <span>${iconSvg('network')}</span>
    <div><strong>暂无协作任务</strong><p>从消息中的 uBuddy 发起多人协作后，任务进度、Agent 沟通和 Memory 审计会显示在这里。</p></div>
  </section>`;
}

function renderWorkMemoryObservability(task) {
  if (!task?.id) return '';
  const workScopeId = `task:${task.id}`;
  const snapshot = state.workMemoryObservability?.workScopeId === workScopeId
    ? state.workMemoryObservability
    : null;
  const outbox = snapshot?.outbox || [];
  const audits = snapshot?.audits || [];
  const pending = outbox.filter((item) => ['pending', 'sending', 'failed'].includes(item.status));
  const denied = audits.filter((item) => item.result === 'denied');
  return `<div class="collab-panel collab-panel-wide work-memory-observability" aria-label="协作 Memory 可观测性" aria-busy="${snapshot?.loading ? 'true' : 'false'}">
    <div class="work-memory-observability-head">
      <div><h3>协作 Memory 状态</h3><small>仅显示当前任务范围内的同步与读取记录</small></div>
      <button class="mini-btn muted" type="button" data-work-memory-refresh="${escapeAttr(task.id)}" ${snapshot?.loading ? 'disabled' : ''}>${snapshot?.loading ? '刷新中' : '刷新'}</button>
    </div>
    ${snapshot?.loading ? '<div class="work-memory-loading" role="status"><i aria-hidden="true"></i><span>正在读取当前任务的同步与审计状态…</span></div>' : ''}
    ${snapshot?.error ? `<div class="error" role="alert">${escapeHtml(snapshot.error)}</div>` : ''}
    ${!snapshot?.loading ? `<div class="work-memory-observability-metrics">
      <span>发布 ${formatNumber(outbox.filter((item) => item.status === 'published').length)}</span>
      <span>待补传 ${formatNumber(pending.length)}</span>
      <span>读取审计 ${formatNumber(audits.length)}</span>
      <span>拒绝 ${formatNumber(denied.length)}</span>
    </div>` : ''}
    ${!snapshot?.loading ? `<details class="work-memory-observability-detail">
      <summary>查看同步队列与读取审计 · ${escapeHtml(workScopeId)}</summary>
      <div class="work-memory-observability-list">
      ${pending.slice(0, 5).map((item) => `<div><strong>${syncStatusLabel(item.status)}</strong><span>${escapeHtml(item.federationType)} · ${escapeHtml(item.federationId)}</span><small>${escapeHtml(item.lastError || formatDateTime(item.updatedAt))}</small></div>`).join('') || '<div class="empty small">当前没有待补传记录。</div>'}
      ${denied.slice(0, 5).map((item) => `<div><strong>拒绝 · ${escapeHtml(item.resultCode)}</strong><span>${escapeHtml(item.requesterAgentInstanceId || 'unknown')} → ${escapeHtml(item.targetAgentInstanceId || 'unknown')}</span><small>${escapeHtml(formatDateTime(item.createdAt))}</small></div>`).join('') || '<div class="empty small">当前没有拒绝读取记录。</div>'}
      </div>
    </details>` : ''}
  </div>`;
}


function collaborationStateHint({ readyNodes = [], queuedNodes = [], runningNodes = [], waitingNodes = [], openComms = [] } = {}) {
  if (queuedNodes.length || runningNodes.length) return '任务正在后台自动处理；Agent 忙时会保持 FIFO 排队。';
  if (readyNodes.length) return '已有待执行节点，后台协调器会自动继续处理。';
  if (openComms.length) return '当前等待 Agent 间沟通回复，回复后相关节点会自动恢复执行。';
  if (waitingNodes.length) return '当前存在阻塞节点；通常需要网络/API 恢复后重新运行或补充沟通信息。';
  return '后续节点会在上游完成后自动变为可执行。';
}

function collaborationAgents(task, nodes = [], communications = []) {
  const roster = Array.isArray(state.employeeOverview?.roster) ? state.employeeOverview.roster : [];
  const projectionEnvelope = workProjectionEnvelope(taskWorkProjection(task));
  const groups = new Map();
  const ensure = ({ agentInstanceId = '', agentId = '' } = {}) => {
    const cleanInstanceId = String(agentInstanceId || '').trim();
    const cleanAgentId = String(agentId || '').trim();
    const key = cleanInstanceId ? `instance:${cleanInstanceId}` : cleanAgentId ? `family:${cleanAgentId}` : '';
    if (!key) return null;
    if (!groups.has(key)) groups.set(key, { key, agentInstanceId: cleanInstanceId, agentId: cleanAgentId, nodes: [] });
    const group = groups.get(key);
    if (!group.agentId && cleanAgentId) group.agentId = cleanAgentId;
    return group;
  };
  for (const node of nodes) {
    const group = ensure({ agentInstanceId: node.agentInstanceId || node.agent_instance_id, agentId: node.agentId || node.agent_id });
    if (group) group.nodes.push(node);
  }
  if (task?.leadAgentInstanceId) ensure({ agentInstanceId: task.leadAgentInstanceId, agentId: task?.leadAgentId });
  else if (task?.leadAgentId && ![...groups.values()].some((item) => item.agentId === task.leadAgentId)) {
    ensure({ agentId: task.leadAgentId });
  }
  for (const agentInstanceId of Array.isArray(task?.metadata?.participantAgentInstanceIds) ? task.metadata.participantAgentInstanceIds : []) {
    const employee = roster.find((item) => item.id === agentInstanceId) || {};
    ensure({ agentInstanceId, agentId: employee.agentFamilyId || '' });
  }
  for (const [key, familyGroup] of [...groups.entries()]) {
    if (familyGroup.agentInstanceId || !familyGroup.agentId) continue;
    const instanceGroups = [...groups.values()].filter((item) => item.agentInstanceId && item.agentId === familyGroup.agentId);
    if (instanceGroups.length) groups.delete(key);
  }
  const items = [...groups.values()].map((group) => {
    const employee = roster.find((item) => item.id === group.agentInstanceId) || {};
    const projection = group.agentInstanceId
      ? workProjectionForAgent(projectionEnvelope, { agentInstanceId: group.agentInstanceId })
      : null;
    const agentId = group.agentId || employee.agentFamilyId || projection?.agentId || '';
    const status = group.agentInstanceId
      ? {}
      : state.agentStatuses.find((item) => item.agentId === agentId) || {};
    return {
      ...group,
      agentId,
      agentFamilyId: agentId,
      employee,
      familyName: employee.family?.name || agentNameById(agentId) || '',
      name: agentInstanceDisplayNameForUi(employee, agentNameById(agentId) || agentId || 'Agent'),
      status,
      communications: group.agentInstanceId
        ? []
        : communications.filter((item) => item.fromAgentId === agentId || item.toAgentId === agentId),
      projection: group.agentInstanceId ? projection : workProjectionForAgent(projectionEnvelope, { agentId }),
    };
  });
  return numberAgentInstanceLabels(items, {
    baseName: (item) => item.name || item.familyName || item.agentId || 'Agent',
  }).sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN') || left.agentInstanceId.localeCompare(right.agentInstanceId));
}

function agentDisplayNameForNode(node = {}, agents = []) {
  const instanceId = String(node.agentInstanceId || node.agent_instance_id || '').trim();
  const agentId = String(node.agentId || node.agent_id || '').trim();
  return (Array.isArray(agents) ? agents : []).find((item) => (
    instanceId ? item.agentInstanceId === instanceId : !item.agentInstanceId && item.agentId === agentId
  ))?.displayName || '';
}

function collaborationProgress(nodes = [], task = null) {
  const done = nodes.filter((node) => node.status === 'completed').length;
  const total = nodes.length;
  const executionPercent = total ? Math.round((done / total) * 100) : 0;
  const metadata = task?.metadata || {};
  const reviewState = task?.deliveryReview?.state || metadata.deliveryReview?.state || metadata.deliveryReviewState || '';
  const lifecycle = deriveTaskLifecycleProgress({
    phase: metadata.executionProgress?.lifecyclePhase || metadata.executionProgress?.phase || task?.status || '',
    taskStatus: task?.status || '',
    executionPercent,
    reviewState,
    finalDelivery: metadata.finalDelivery || null,
    acceptanceSource: metadata.deliveryReviewOutcome || '',
    hasConfirmationProtocol: Boolean(
      metadata.finalDelivery || task?.deliveryReview || metadata.deliveryReview || metadata.deliveryReviewState,
    ),
  });
  return {
    total,
    done,
    ...lifecycle,
  };
}

function taskWorkProjection(task = null) {
  return state.uBuddyFeatureFlags?.agentWorkDetailProjection === true
    ? task?.agentWorkStatusProjection || null
    : null;
}

function renderCollabMetric(label, value, detail, tone = 'muted') {
  return `
    <div class="collab-metric is-${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </div>
  `;
}

function renderCollabStage(label, nodes = [], tone = 'queue', projectionEnvelope = null, agents = []) {
  return `
    <div class="collab-stage is-${tone}">
      <div class="collab-stage-head">
        <strong>${escapeHtml(label)}</strong>
        <span>${formatNumber(nodes.length)}</span>
      </div>
      <div class="collab-stage-list">
        ${nodes.slice(0, 6).map((node) => { const projection = workProjectionForNode(projectionEnvelope, node); return `
          <div class="collab-node is-${taskStatusTone(node.status)}">
            <strong>${escapeHtml(displayNodeTitle(node))}</strong>
            <span>${escapeHtml(agentDisplayNameForNode(node, agents) || projection?.actorLabel || agentNameById(node.agentId))} · ${taskStatusLabel(node.status)}</span>
            ${projection?.currentAction ? `<small>${escapeHtml(projection.currentAction)}</small>` : ''}
            ${projection?.timeline?.length ? `<em>${escapeHtml(projection.timeline.at(-1)?.summary || '')}</em>` : ''}
          </div>
        `; }).join('') || '<div class="empty small">暂无节点。</div>'}
        ${nodes.length > 6 ? `<small class="collab-stage-more">还有 ${formatNumber(nodes.length - 6)} 个节点</small>` : ''}
      </div>
    </div>
  `;
}

function renderCollabAgent(item) {
  if (item.projection) return `<div class="collab-agent-row has-work-projection">${renderAgentWorkProjectionSummary(item.projection, { compact: true, displayName: item.displayName, nodes: item.nodes })}</div>`;
  const status = item.status || {};
  const running = item.nodes.filter((node) => ['queued', 'running'].includes(String(node.status || ''))).length;
  const ready = item.nodes.filter((node) => String(node.status || '') === 'ready').length;
  const waiting = item.nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(String(node.status || ''))).length;
  const comm = item.communications?.length || 0;
  const total = running + ready + waiting + comm + item.nodes.length;
  const progress = total ? Math.min(100, Math.round(((running + ready + item.nodes.filter((node) => node.status === 'completed').length) / total) * 100)) : 0;
  return `
    <div class="collab-agent-row">
      <div>
        <strong>${escapeHtml(item.displayName || agentNameById(item.agentId))}</strong>
        <span>${escapeHtml(status.departmentId || state.org.agents.find((agent) => agent.id === item.agentId)?.departmentId || '')}</span>
      </div>
      <div class="collab-agent-load">
        <span>${formatNumber(item.nodes.length)} 个节点</span>
        <span>${comm} 个通信</span>
        ${waiting ? `<span>${waiting} 个等待</span>` : ''}
      </div>
      <i><b style="width: ${progress}%;"></b></i>
    </div>
  `;
}

function renderCollabCommunication(comm) {
  return `
    <div class="collab-comm-row">
      <strong>${escapeHtml(agentNameById(comm.fromAgentId))} → ${escapeHtml(agentNameById(comm.toAgentId))}</strong>
      <span>${escapeHtml(comm.purpose || comm.requestedInfo || '协作沟通')}</span>
      <em>${priorityLabel(comm.priority)}${comm.blocking ? ' · 阻塞任务' : ''}</em>
    </div>
  `;
}

function renderCollabEvent(item) {
  const payload = item.payload || {};
  const command = String(item.command || payload.command || '');
  const output = String(item.output || payload.output || '');
  const activityType = String(payload.activityType || '');
  const label = command || activityType === 'command'
    ? '命令执行'
    : activityType === 'reasoning' ? '执行思考'
      : activityType === 'commentary' ? '执行说明'
        : eventTypeLabel(item.eventType);
  const status = String(item.status || payload.status || '');
  const summary = ['reasoning', 'commentary'].includes(activityType)
    ? String(payload.detail || item.summary || '')
    : String(item.summary || '');
  const technicalDetails = renderCollabEventTechnicalDetails({ command, output, payload });
  return `
    <div class="collab-event-row is-${escapeAttr(status || 'recorded')}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(summary)}</span>
      <em>${escapeHtml(agentNameById(item.agentId || item.actorId) || item.agentId || item.actorId || '')}${status ? ` · ${escapeHtml(taskStatusLabel(status))}` : ''}</em>
      ${technicalDetails ? `<details class="collab-event-technical"><summary>${command || output ? '查看命令与技术详情' : '查看技术详情'}</summary>${technicalDetails}</details>` : ''}
    </div>
  `;
}

function renderCollabEventTechnicalDetails({ command = '', output = '', payload = {} } = {}) {
  const sections = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value) && !value.length) return;
    if (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    sections.push(`<div><small>${escapeHtml(label)}</small><pre><code>${escapeHtml(text)}</code></pre></div>`);
  };
  add('命令', command);
  add('工作目录', payload.cwd);
  add('输出', output);
  add('Reasoning text', payload.reasoningText);
  add('终端输入', payload.terminalInput);
  add('工具参数', payload.arguments);
  add('工具结果', payload.result);
  add('错误详情', payload.error);
  add('文件变更', payload.changes);
  add('Diff', payload.diff);
  add('命令动作', payload.commandActions);
  add('检索结果', payload.searchResults);
  add('计划', payload.plan);
  add('目标', payload.goal);
  add('验证结果', payload.verifications);
  add('原始响应', payload.rawResponse);
  add('上游原始协议', payload.protocolEvents);
  return sections.join('');
}

function renderCollabEventStream(events = [], taskId = '') {
  if (!events.length) return '<div class="empty small">暂无协作事件。</div>';
  const recentLimit = 8;
  const hiddenCount = Math.max(0, events.length - recentLimit);
  const historyOpen = Boolean(state.collaborationEventHistoryOpenByTaskId?.[taskId]);
  const selectedEvents = hiddenCount > 0 && !historyOpen ? events.slice(-recentLimit) : events;
  const visibleEvents = selectedEvents.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const { reasoningText: _reasoningText, ...visibleItem } = item;
    if (visibleItem.payload && typeof visibleItem.payload === 'object' && !Array.isArray(visibleItem.payload)) {
      const { reasoningText: _payloadReasoningText, ...visiblePayload } = visibleItem.payload;
      visibleItem.payload = visiblePayload;
    }
    return visibleItem;
  });
  const transcript = renderCodexTranscript(visibleEvents, {
    messageId: `task-${taskId}`,
    streaming: events.some((item) => String(item.status || item.payload?.status || '') === 'running'),
    actorLabelForEvent: (item) => agentNameById(item.actorId || item.agentId) || item.actorId || item.agentId || '',
  }).replaceAll('<div class="codex-transcript-label">思考</div>', '') || '<div class="empty small">暂无 Janus 处理记录。</div>';
  if (!hiddenCount) return transcript;
  return `<div class="collab-event-history">
    ${transcript}
    <button class="mini-btn muted" type="button" data-collab-event-history="${escapeAttr(taskId)}">${historyOpen ? '收起更早记录' : `展开更早的 ${hiddenCount} 条记录`}</button>
  </div>`;
}

export function renderTasks() {
  const tasks = state.tasks.map((task) => `
    <button class="task-row ${state.taskDetail?.id === task.id ? 'active' : ''}" data-task="${escapeAttr(task.id)}">
      <strong>${escapeHtml(displayTaskTitle(task))}</strong>
      <span>${taskStatusLabel(task.status, task)} / ${escapeHtml(task.departmentId)}</span>
    </button>
  `).join('');
  const statuses = state.agentStatuses.map((item) => `
    <div class="status-row">
      <strong>${escapeHtml(agentNameById(item.agentId))}<small>${escapeHtml(item.departmentId || '')}</small></strong>
      <span>${agentStatusLabel(item.status)}${item.routable === false ? ` / ${agentStatusLabel(item.lifecycleStatus || item.routingState || 'paused')}` : ''}</span>
      <em>
        <b>运行 ${Number(item.runningCount || 0)}</b>
        <b>就绪 ${Number(item.readyCount || 0)}</b>
        <b>等待 ${Number(item.waitingCount || 0)}</b>
        <b>排队 ${Number(item.pendingCount || 0)}</b>
        <b>沟通 ${Number(item.openCommunicationCount || 0)}</b>
      </em>
    </div>
  `).join('');
  const detail = state.taskDetail ? renderTaskDetail(state.taskDetail) : '<div class="empty large">创建或选择一个协作任务。</div>';
  return `
    <div class="view tasks-view">
      <section class="panel task-create">
        <form id="task-form">
          <label>
            <span>复杂任务</span>
            <textarea id="task-prompt" rows="5" placeholder="例如：查找资料并生成一套学术汇报 PPT 大纲"></textarea>
          </label>
          <div class="control-row compact">
            <label>
              <span>主负责部门</span>
              <select id="task-department">
                <option value="">自动分配</option>
                ${state.org.departments.map((dept) => `<option value="${escapeAttr(dept.id)}">${escapeHtml(dept.name)}</option>`).join('')}
              </select>
            </label>
            <button class="btn primary" type="submit">创建协作任务</button>
          </div>
        </form>
        <div class="agent-status-list">
          <h3>Agent 工作状态</h3>
          ${statuses || '<div class="empty small">暂无任务活动。</div>'}
        </div>
        <div class="task-list">${tasks || '<div class="empty">暂无协作任务。</div>'}</div>
      </section>
      <section class="task-detail">${detail}</section>
    </div>
  `;
}

function renderTaskDetail(task) {
  const metadata = task.metadata || {};
  const collaborating = Array.isArray(metadata.collaboratingDepartmentIds) ? metadata.collaboratingDepartmentIds : [];
  const agents = collaborationAgents(task, task.nodes || [], task.communications || []);
  const byStatus = ['ready', 'queued', 'running', 'retry_wait', 'waiting', 'blocked', 'pending', 'completed', 'failed', 'cancelled'].map((status) => {
    const nodes = (task.nodes || []).filter((node) => node.status === status);
    return `
      <div class="kanban-col is-${taskStatusTone(status)}">
        <h3>${taskStatusLabel(status)}</h3>
        ${nodes.map((node) => renderTaskNode(node, task, agents)).join('') || '<div class="empty small">暂无节点</div>'}
      </div>
    `;
  }).join('');
  const comms = (task.communications || []).map(renderCommunication).join('');
  const events = renderCollabEventStream(task.events || [], task.id || '');
  const retro = task.retrospective ? `
    <div class="retrospective">
      <h3>任务复盘</h3>
      <pre>${escapeHtml(task.retrospective.finalSummary)}</pre>
    </div>
  ` : '';
  const taskActive = ['pending', 'ready', 'queued', 'running', 'verifying', 'waiting', 'cancelling'].includes(String(task.status || ''));
  const taskRerunnable = task.metadata?.source === 'ubuddy_dispatch'
    && !task.metadata?.continuedByTaskRunId
    && ['cancelled', 'failed'].includes(String(task.status || ''));
  return `
    <div class="task-head">
      <div>
        <h2>${escapeHtml(displayTaskTitle(task))}</h2>
        <p>${taskStatusLabel(task.status, task)} / ${leadershipTaskLabel(task)}</p>
        <details class="task-technical-details"><summary>查看任务分工与技术信息</summary><p class="task-ownership">主负责部门：${escapeHtml(metadata.primaryDepartmentId || task.departmentId)}${collaborating.length ? ` / 协作部门：${escapeHtml(collaborating.join(', '))}` : ''}${metadata.consistencyCheckNode ? ' / 含一致性检查节点' : ''}</p></details>
      </div>
      <div class="task-head-actions"><button class="btn primary" id="run-ready-btn" data-task="${escapeAttr(task.id)}" ${state.taskBusy || !taskActive ? 'disabled' : ''}>${state.taskBusy ? '正在运行…' : '运行可执行节点'}</button>${taskActive ? `<button class="btn secondary" data-cancel-ubuddy-task="${escapeAttr(task.id)}" ${state.taskBusy || task.status === 'cancelling' ? 'disabled' : ''}>${task.status === 'cancelling' ? '正在停止…' : '停止整个任务'}</button>` : ''}${taskRerunnable ? `<button class="btn secondary" data-rerun-ubuddy-task="${escapeAttr(task.id)}" ${state.taskBusy ? 'disabled' : ''}>重新执行</button>` : ''}</div>
    </div>
    <div class="kanban">${byStatus}</div>
    <div class="communications">
      <h3>Agent 沟通</h3>
      ${comms || '<div class="empty small">暂无 Agent 沟通请求。</div>'}
    </div>
    <div class="communications">
      <h3>执行记录</h3>
      ${events}
    </div>
    ${retro}
  `;
}

function renderCommunication(comm) {
  const open = comm.status === 'open';
  const details = [
    comm.requestedInfo ? `需要的信息：${comm.requestedInfo}` : '',
    comm.expectedFormat ? `期望格式：${comm.expectedFormat}` : '',
    comm.contextSummary ? `相关上下文：${comm.contextSummary}` : '',
  ].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join('');
  const response = open ? `
    <div class="comm-response">
      <textarea rows="2" placeholder="回复 ${escapeAttr(agentNameById(comm.fromAgentId))}"></textarea>
      <button class="mini-btn" data-resolve-communication="${escapeAttr(comm.id)}" ${state.busy ? 'disabled' : ''}>提交回复</button>
    </div>
  ` : `
    <div class="comm-answer">
      <strong>已回复</strong>
      <span>${escapeHtml(comm.responseText || '未记录回复内容。')}</span>
    </div>
  `;
  return `
    <div class="comm-row ${open ? 'open' : 'resolved'}" data-communication-id="${escapeAttr(comm.id)}">
      <div class="comm-main">
        <strong>${escapeHtml(agentNameById(comm.fromAgentId))} → ${escapeHtml(agentNameById(comm.toAgentId))}</strong>
        <span>${escapeHtml(comm.purpose || comm.requestedInfo || 'Agent 沟通')}</span>
      </div>
      <details class="comm-details"><summary>查看沟通要求</summary>${details || '<span>没有补充要求。</span>'}</details>
      <div class="comm-state">
        <em>${communicationStatusLabel(comm.status)}</em>
        <span>${comm.blocking ? '阻塞任务' : '不阻塞任务'} / ${priorityLabel(comm.priority)}</span>
      </div>
      ${response}
    </div>
  `;
}

function renderTaskNode(node, task = {}, agents = []) {
  const retryAllowed = ['failed', 'retry_wait'].includes(node.status) && !['completed', 'cancelled'].includes(task.status);
  const attempts = `${Number(node.attemptCount || 0)}/${Number(node.maxAttempts || 3)}`;
  const dependencyLabels = (node.dependencies || []).map((id) => (task.nodes || []).find((item) => item.id === id)?.title || id);
  const projection = workProjectionForNode(taskWorkProjection(task), node);
  const participant = agents.find((item) => item.agentInstanceId
    ? item.agentInstanceId === String(node.agentInstanceId || node.agent_instance_id || '')
    : item.agentId === String(node.agentId || node.agent_id || ''));
  return `
    <article class="node-card is-${taskStatusTone(node.status)}">
      <div class="node-title">${escapeHtml(node.title)}</div>
      <div class="node-meta">执行 Agent：${escapeHtml(participant?.displayName || agentNameById(node.agentId))} · 优先级 ${Number(node.priority || 0)} · 预计 ${Number(node.estimatedMinutes || 0)} 分钟 · 尝试 ${escapeHtml(attempts)}</div>
      <p>${escapeHtml(node.objective)}</p>
      ${projection ? renderAgentWorkProjectionSummary(projection, { compact: false, displayName: participant?.displayName || '', nodes: participant?.nodes || [] }) : ''}
      <details class="node-technical-details"><summary>查看依赖与调度信息</summary><div class="node-meta">并行组：${escapeHtml(node.parallelGroup || 'main')} · ${node.blocking ? '阻塞节点' : '非阻塞节点'}<br>依赖节点：${escapeHtml(dependencyLabels.length ? dependencyLabels.join('、') : '无')}<br>完成后通知：${escapeHtml((node.notify || []).length ? node.notify.join(', ') : '无')}</div></details>
      ${node.resultText ? `<details><summary>查看执行结果</summary><pre>${escapeHtml(node.resultText)}</pre></details>` : ''}
      ${node.errorText ? `<div class="error">${escapeHtml(userVisibleErrorMessage(node.errorText))}</div>` : ''}
      ${node.lastErrorCode ? `<div class="node-meta">错误类型：${escapeHtml(node.lastErrorCode)}${node.nextRetryAt ? ` · 下次重试：${escapeHtml(formatDateTime(node.nextRetryAt))}` : ''}</div>` : ''}
      ${node.recoveryActions?.length ? `<details><summary>查看恢复记录</summary><ul>${node.recoveryActions.slice(-8).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>` : ''}
      ${retryAllowed ? `<div class="node-actions"><button class="btn secondary" type="button" data-retry-task-node="${escapeAttr(node.id)}" data-retry-task="${escapeAttr(task.id)}" ${state.taskBusy ? 'disabled' : ''}>${node.status === 'retry_wait' ? '立即重试' : '重试此节点'}</button></div>` : ''}
    </article>
  `;
}

function leadershipTaskLabel(task = {}) {
  const selection = task.metadata?.taskLeaderSelection || {};
  const level = selection.leadershipLevel || task.metadata?.leadershipLevelSnapshot || '';
  const role = task.metadata?.leadershipRole || 'task_lead';
  return `负责人：${escapeHtml(agentNameById(task.leadAgentId) || '未分配')}${level ? ` · ${escapeHtml(level)}` : ''} · ${escapeHtml(role)}`;
}

function taskStatusLabel(value, task = null) {
  if (value === 'cancelled' && task?.metadata?.continuedByTaskRunId) return '已续接';
  if (task) {
    const finalDelivery = finalDeliveryForTask(task);
    if (finalDelivery.state === 'delivered') return '已交付 · 等待确认';
    if (finalDelivery.state === 'user_confirmed') return '用户已确认';
    if (finalDelivery.state === 'closed') return '已关闭';
    if (finalDelivery.state === 'failed') return '交付失败';
    if (finalDelivery.state === 'not_delivered' && task.metadata?.deliveryRevisionRequestedAt) return '已要求修改';
  }
  const labels = {
    ready: '待执行', queued: '排队中', running: '处理中', retry_wait: '等待自动重试', verifying: '校验交付物', waiting: '等待协作', blocked: '依赖失败阻塞', pending: '等待依赖', cancelling: '正在停止',
    completed: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停', unknown: '状态未知',
  };
  return escapeHtml(labels[value] || value || labels.unknown);
}

function taskStatusTone(value) {
  const tones = {
    ready: 'ready', queued: 'running', running: 'running', retry_wait: 'warning', waiting: 'warning', blocked: 'danger', pending: 'pending', cancelling: 'warning',
    completed: 'success', verifying: 'active', failed: 'danger', cancelled: 'muted', paused: 'muted',
  };
  return tones[value] || 'muted';
}

function agentStatusLabel(value) {
  const labels = {
    idle: '空闲', ready: '就绪', running: '工作中', waiting: '等待中', pending: '排队中',
    paused: '已暂停', disabled: '已停用', unavailable: '不可用', active: '可工作',
  };
  return escapeHtml(labels[value] || value || '状态未知');
}

function communicationStatusLabel(value) {
  const labels = { open: '等待回复', resolved: '已解决', closed: '已关闭', expired: '已过期' };
  return escapeHtml(labels[value] || value || '状态未知');
}

function priorityLabel(value) {
  const labels = { low: '低优先级', normal: '普通优先级', high: '高优先级', urgent: '紧急' };
  return escapeHtml(labels[value] || value || labels.normal);
}

function eventTypeLabel(value) {
  const labels = {
    task_created: '任务已创建', node_ready: '节点待执行', node_queued: '节点已排队', node_started: '节点开始执行',
    node_completed: '节点已完成', node_failed: '节点执行失败', communication_opened: '发起 Agent 沟通',
    communication_resolved: 'Agent 沟通已解决', task_completed: '任务已完成', task_failed: '任务失败',
  };
  return escapeHtml(labels[value] || value || '协作事件');
}

function syncStatusLabel(value) {
  const labels = { pending: '等待补传', sending: '正在补传', failed: '补传失败', published: '已发布' };
  return escapeHtml(labels[value] || value || '状态未知');
}
