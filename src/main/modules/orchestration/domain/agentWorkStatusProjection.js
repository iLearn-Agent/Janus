import crypto from 'node:crypto';

import {
  AGENT_WORK_STATUS_PROJECTION_VERSION,
  normalizeAgentWorkStatusProjection,
  normalizeAgentWorkStatusProjectionEnvelope,
  publicAgentWorkStatusProjectionEnvelope,
  sanitizePublicWorkStatusText,
} from '../../../../shared/contracts/uBuddyWorkStatus.js';

const ACTIVE_NODE_STATUSES = new Set(['ready', 'queued', 'running', 'waiting', 'retry_wait', 'blocked']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function projectTaskAgentWorkStatus(task = {}, {
  coordination = null,
  agentName = (agentId) => agentId || 'Agent',
  visibility = 'owner_private',
} = {}) {
  if (!task?.id) return null;
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const events = safeProjectionEvents(task.events);
  const grouped = new Map();
  for (const node of nodes) {
    const key = String(node.agentInstanceId || `family:${node.agentId || 'unassigned'}`).trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }
  const actors = [...grouped.entries()].map(([key, agentNodes], index) => projectTaskActor({
    task, events, agentNodes, key, index, agentName, visibility,
  }));
  if (task.metadata?.source === 'ubuddy_dispatch' || coordination || task.metadata?.coordinationSnapshot || task.metadata?.coordination) {
    actors.unshift(projectUBuddyActor({ task, events, coordination: coordination || task.metadata?.coordinationSnapshot || task.metadata?.coordination, visibility }));
  }
  return normalizeAgentWorkStatusProjectionEnvelope({
    version: AGENT_WORK_STATUS_PROJECTION_VERSION,
    scopeKind: 'task_run',
    scopeId: task.id,
    actors,
    updatedAt: latestTimestamp([task.updatedAt, ...actors.map((item) => item.updatedAt)]),
  });
}

export function projectDeliveryAgentWorkStatus(receipt = {}) {
  if (!receipt?.workId) return null;
  const events = (Array.isArray(receipt.events) ? receipt.events : []).slice(-50);
  const latest = [...events].sort(eventTimeOrder).at(-1) || null;
  const status = normalizeDeliveryStatus(receipt.deliveryStatus);
  const updatedAt = latestTimestamp([latest?.createdAt, receipt.updatedAt, receipt.createdAt]);
  const blocker = status === 'failed' ? {
    summary: receipt.metadata?.error || latest?.message || 'Agent 任务执行失败。',
    errorCode: receipt.metadata?.errorCode || '',
    retryable: receipt.metadata?.retryable !== false,
    suggestedNextStep: '检查失败原因后重新执行或改派任务。',
  } : null;
  const actor = normalizeAgentWorkStatusProjection({
    projectionId: projectionId('delivery', receipt.workId, receipt.targetAgentInstanceId || receipt.metadata?.targetAgentId),
    actorKind: 'local_agent',
    actorLabel: receipt.metadata?.targetAgentName || receipt.metadata?.targetAgentId || 'Agent',
    ownerUserId: receipt.userId || '',
    agentId: receipt.metadata?.targetAgentId || '',
    agentInstanceId: receipt.targetAgentInstanceId || '',
    delegationId: receipt.metadata?.delegationId || `delivery:${receipt.workId}`,
    status,
    currentStage: stageForDelivery(status, latest?.stage),
    currentAction: latest?.message || receipt.metadata?.lastMessage || deliveryStatusAction(status),
    completedSummary: status === 'completed'
      ? receipt.metadata?.resultSummary || latest?.message || 'Agent 已完成本次任务。'
      : '',
    blocker,
    nextStep: blocker?.suggestedNextStep || deliveryNextStep(status),
    progress: { completed: status === 'completed' ? 1 : 0, total: 1 },
    evidenceRefs: events.slice(-10).map((event) => ({ kind: 'task_event', id: event.id || `${receipt.workId}:${event.sequenceNo}`, label: event.message || event.stage })),
    timeline: events.map((event) => ({
      id: event.id || `${receipt.workId}:${event.sequenceNo}`,
      sourceKind: 'delivery_event',
      status: normalizeDeliveryStatus(event.status || event.stage),
      stage: stageForDelivery(normalizeDeliveryStatus(event.status || receipt.deliveryStatus), event.stage),
      summary: event.message || event.stage || 'Agent 工作状态已更新。',
      occurredAt: event.createdAt || receipt.updatedAt,
    })),
    visibility: 'owner_private',
    sourceEventId: latest?.id || `${receipt.workId}:${latest?.sequenceNo || 0}`,
    sourceRevision: Number(latest?.sequenceNo || receipt.metadata?.lastSequence || 0),
    updatedAt,
  });
  return normalizeAgentWorkStatusProjectionEnvelope({
    scopeKind: 'delivery', scopeId: receipt.workId, actors: [actor], updatedAt,
  });
}

export function projectDelegationAgentWorkStatus(delegation = {}) {
  if (!delegation?.id) return null;
  const existing = delegation.metadata?.agentWorkStatusProjection;
  if (existing) return publicAgentWorkStatusProjectionEnvelope(existing);
  const progress = delegation.metadata?.executionProgress || {};
  const nodes = Array.isArray(progress.nodes) ? progress.nodes : [];
  const grouped = new Map();
  for (const node of nodes) {
    const key = String(node.agentName || 'Agent');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }
  const actors = [...grouped.entries()].map(([label, actorNodes], index) => {
    const active = chooseActiveNode(actorNodes);
    const status = active ? normalizeNodeStatus(active.status) : aggregateTerminalStatus(actorNodes, delegation.status);
    const completed = actorNodes.filter((node) => node.status === 'completed').length;
    const milestones = (progress.milestones || []).filter((item) => !item.agentName || item.agentName === label).slice(-20);
    return normalizeAgentWorkStatusProjection({
      projectionId: projectionId('delegation', delegation.id, `${label}:${index}`),
      actorKind: 'remote_agent', actorLabel: label,
      agentId: active?.agentId || '', delegationId: delegation.id,
      taskNodeId: active?.id || '', currentNodeTitle: active?.title || '', status,
      currentStage: stageForDelegation(progress.phase, status),
      currentAction: active?.summary || progress.currentStep?.title || progress.message || nodeStatusAction(status, active),
      completedSummary: actorNodes.filter((node) => node.status === 'completed').slice(-2).map((node) => node.summary || `${node.title}已完成`).join('；'),
      blocker: ['blocked', 'failed'].includes(status) ? progress.blocker || { summary: active?.summary || '当前工作暂时无法继续。' } : null,
      nextStep: delegationNextStep(status, progress),
      progress: { completed, total: actorNodes.length },
      evidenceRefs: actorNodes.map((node) => ({ kind: 'task_node', id: node.id || '', label: node.title || '' })),
      timeline: milestones.map((item) => ({
        id: item.key || `${delegation.id}:${item.title}`,
        sourceKind: 'delegation_milestone', status: item.status || 'running',
        stage: stageForDelegation(progress.phase, item.status), summary: item.detail || item.title,
        occurredAt: item.occurredAt || progress.updatedAt || delegation.updatedAt || delegation.updated_at,
      })),
      visibility: 'participant_public', sourceRevision: Number(progress.sequence || 0),
      updatedAt: progress.updatedAt || delegation.updatedAt || delegation.updated_at,
    });
  });
  actors.unshift(normalizeAgentWorkStatusProjection({
    projectionId: projectionId('delegation', delegation.id, 'ubuddy'),
    actorKind: 'remote_ubuddy', actorLabel: 'uBuddy', delegationId: delegation.id,
    status: normalizeDelegationStatus(delegation.status, progress.phase),
    currentStage: stageForDelegation(progress.phase, delegation.status),
    currentAction: progress.message || 'uBuddy 正在协调任务。',
    completedSummary: progress.terminal && progress.phase === 'delivered' ? 'uBuddy 已完成任务交付。' : '',
    blocker: progress.blocker || null,
    nextStep: delegationNextStep(delegation.status, progress),
    progress: { completed: progress.completed, total: progress.total },
    timeline: (progress.milestones || []).slice(-20).map((item) => ({
      id: item.key || `${delegation.id}:${item.title}`,
      sourceKind: 'delegation_milestone', status: item.status || 'running',
      stage: stageForDelegation(progress.phase, item.status), summary: item.detail || item.title,
      occurredAt: item.occurredAt || progress.updatedAt || delegation.updatedAt || delegation.updated_at,
    })),
    visibility: 'participant_public', sourceRevision: Number(progress.sequence || 0),
    updatedAt: progress.updatedAt || delegation.updatedAt || delegation.updated_at,
  }));
  return normalizeAgentWorkStatusProjectionEnvelope({
    scopeKind: 'delegation', scopeId: delegation.id, actors,
    updatedAt: progress.updatedAt || delegation.updatedAt || delegation.updated_at,
  });
}

export function publicTaskAgentWorkStatus(task = {}, options = {}) {
  return publicAgentWorkStatusProjectionEnvelope(projectTaskAgentWorkStatus(task, options));
}

function projectTaskActor({ task, events, agentNodes, key, index, agentName, visibility }) {
  const active = chooseActiveNode(agentNodes);
  const representative = active || agentNodes[0] || {};
  const actorEvents = events.filter((event) => agentNodes.some((node) => node.id === event.taskNodeId)
    || (!event.taskNodeId && event.actorId === representative.agentId));
  const latestEvent = [...actorEvents].sort(eventTimeOrder).at(-1) || null;
  const completedNodes = agentNodes.filter((node) => node.status === 'completed');
  const status = active ? normalizeNodeStatus(active.status) : aggregateTerminalStatus(agentNodes, task.status);
  const blockerNode = active && ['waiting', 'retry_wait', 'blocked', 'failed'].includes(active.status) ? active : null;
  const blocker = blockerNode ? blockerForNode(blockerNode) : null;
  const updatedAt = latestTimestamp([latestEvent?.updatedAt, latestEvent?.createdAt, active?.updatedAt, ...agentNodes.map((node) => node.updatedAt), task.updatedAt]);
  const sourceRevision = projectionSourceRevision(updatedAt, actorEvents.length);
  const latestActionEvent = [...actorEvents].reverse().find((event) => event.status === 'running' || ['node_activity', 'node_progress'].includes(event.eventType)) || latestEvent;
  return normalizeAgentWorkStatusProjection({
    projectionId: projectionId('task', task.id, representative.agentInstanceId || `${representative.agentId}:${index}`),
    actorKind: 'local_agent',
    actorLabel: agentName(representative.agentId) || representative.agentName || representative.agentId || 'Agent',
    ownerUserId: task.ownerUserId || '', agentId: representative.agentId || '',
    agentInstanceId: representative.agentInstanceId || (key.startsWith('family:') ? '' : key),
    taskRunId: task.id, delegationId: task.metadata?.delegationId || '',
    taskNodeId: active?.id || '', currentNodeTitle: active?.title || '', status,
    currentStage: taskStage(task, status),
    currentAction: latestActionEvent?.summary || nodeStatusAction(status, active),
    completedSummary: completedNodes.slice(-2).map((node) => node.resultSummary || `${node.title}已完成`).filter(Boolean).join('；'),
    blocker,
    nextStep: blocker?.suggestedNextStep || taskActorNextStep(status, active),
    progress: { completed: completedNodes.length, total: agentNodes.length },
    evidenceRefs: uniqueEvidenceRefs([
      ...agentNodes.flatMap(nodeEvidenceRefs),
      ...actorEvents.slice(-10).map((event) => ({ kind: 'task_event', id: event.id, label: event.summary || event.eventType })),
    ]),
    timeline: actorTimeline(actorEvents, agentNodes),
    visibility,
    sourceEventId: latestEvent?.id ? `${latestEvent.id}:${sourceRevision}` : '', sourceRevision,
    updatedAt,
  });
}

function projectUBuddyActor({ task, events, coordination = null, visibility }) {
  const taskEvents = events.filter((event) => !event.taskNodeId || /ubuddy|delivery|validation|task_/i.test(event.eventType || ''));
  const latestEvent = [...taskEvents].sort(eventTimeOrder).at(-1) || null;
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const status = normalizeUBuddyStatus(task, coordination);
  const blockerNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(node.status));
  const currentStage = taskStage(task, status);
  const action = coordination?.coordinationState === 'sleeping'
    ? 'Agent 团队正在执行，uBuddy 等待 leader 唤醒。'
    : currentStage === 'verifying' ? 'uBuddy 大模型正在验收最终交付物。'
      : currentStage === 'delivering' ? 'uBuddy 正在整理并交付最终结果。'
        : currentStage === 'planning' ? 'uBuddy 正在确认任务并分配 Agent。'
          : latestEvent?.summary || 'uBuddy 正在协调任务节点。';
  const updatedAt = latestTimestamp([latestEvent?.updatedAt, latestEvent?.createdAt, coordination?.updatedAt, task.updatedAt]);
  const sourceRevision = projectionSourceRevision(updatedAt, taskEvents.length);
  return normalizeAgentWorkStatusProjection({
    projectionId: projectionId('task', task.id, 'ubuddy'), actorKind: 'ubuddy', actorLabel: 'uBuddy',
    ownerUserId: task.ownerUserId || '', agentId: 'secretary_agent', taskRunId: task.id,
    delegationId: task.metadata?.delegationId || '', status, currentStage, currentAction: action,
    completedSummary: task.status === 'completed' ? task.summary || 'uBuddy 已完成任务交付。' : '',
    blocker: blockerNode ? blockerForNode(blockerNode) : null,
    nextStep: ubuddyNextStep(task, coordination, blockerNode),
    progress: { completed, total: nodes.length },
    evidenceRefs: taskEvents.slice(-10).map((event) => ({ kind: 'task_event', id: event.id, label: event.summary || event.eventType })),
    timeline: actorTimeline(taskEvents, []), visibility,
    sourceEventId: latestEvent?.id ? `${latestEvent.id}:${sourceRevision}` : '', sourceRevision, updatedAt,
  });
}

function actorTimeline(events = [], nodes = []) {
  const entries = events.slice(-50).map((event) => ({
    id: event.id,
    sourceKind: 'task_event',
    status: event.status || '',
    stage: eventStage(event),
    summary: event.summary || event.payload?.title || event.eventType,
    occurredAt: event.updatedAt || event.createdAt,
    evidenceRefs: [{ kind: 'task_event', id: event.id, label: event.eventType }],
  }));
  if (!entries.length) {
    return nodes.slice(-10).map((node) => ({
      id: node.id, sourceKind: 'task_node', status: normalizeNodeStatus(node.status),
      stage: taskStage({ status: node.status, metadata: {} }, normalizeNodeStatus(node.status)),
      summary: nodeStatusAction(normalizeNodeStatus(node.status), node), occurredAt: node.updatedAt || node.createdAt,
      evidenceRefs: [{ kind: 'task_node', id: node.id, label: node.title }],
    }));
  }
  return entries;
}

function safeProjectionEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => {
    const activityType = String(event?.payload?.activityType || '').toLowerCase();
    return activityType !== 'reasoning' && !/prompt|protocol|raw_response/i.test(String(event?.eventType || ''));
  }).sort(eventTimeOrder).slice(-200);
}

function chooseActiveNode(nodes = []) {
  const rank = { running: 0, blocked: 1, waiting: 1, retry_wait: 1, queued: 2, ready: 3, pending: 4 };
  return nodes.filter((node) => ACTIVE_NODE_STATUSES.has(node.status))
    .sort((left, right) => (rank[left.status] ?? 9) - (rank[right.status] ?? 9)
      || String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

function normalizeNodeStatus(status = '') {
  if (status === 'ready') return 'reserved';
  if (status === 'retry_wait') return 'waiting';
  return ['pending', 'skipped'].includes(status) ? 'idle'
    : ['queued', 'running', 'waiting', 'blocked', 'completed', 'failed', 'cancelled'].includes(status) ? status : 'idle';
}

function aggregateTerminalStatus(nodes = [], taskStatus = '') {
  if (nodes.length && nodes.every((node) => ['completed', 'skipped'].includes(node.status))) return 'completed';
  if (nodes.some((node) => node.status === 'failed')) return 'failed';
  if (nodes.length && nodes.every((node) => node.status === 'cancelled')) return 'cancelled';
  if (TERMINAL_STATUSES.has(taskStatus)) return taskStatus;
  return 'idle';
}

function taskStage(task = {}, actorStatus = '') {
  const phase = String(task.metadata?.failurePhase || task.metadata?.failureStage || task.metadata?.phase || '').toLowerCase();
  if (['planning', 'executing', 'verifying', 'delivering'].includes(phase)) return phase;
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'cancelled') return 'cancelled';
  if (task.status === 'verifying' || task.metadata?.resultState === 'needs_revision' || task.metadata?.deliveryValidationState === 'failed') return 'verifying';
  if (task.status === 'delivering') return 'delivering';
  if (['running', 'queued', 'ready', 'waiting', 'blocked'].includes(task.status) || ['running', 'queued', 'reserved', 'waiting', 'blocked'].includes(actorStatus)) return 'executing';
  return 'planning';
}

function eventStage(event = {}) {
  const type = String(event.eventType || '').toLowerCase();
  if (/validation|verif/.test(type)) return 'verifying';
  if (/deliver/.test(type)) return 'delivering';
  if (/completed/.test(type)) return 'completed';
  if (/failed|timeout/.test(type)) return 'failed';
  if (/cancel/.test(type)) return 'cancelled';
  if (/created|planning|assigned/.test(type)) return 'planning';
  return 'executing';
}

function blockerForNode(node = {}) {
  const suggestedNextStep = node.status === 'retry_wait'
    ? '等待系统自动重试，或选择立即重试。'
    : node.status === 'failed' ? '检查失败原因后重试、调整方案或重新分配 Agent。'
      : '补充所需信息或解除依赖后继续。';
  return {
    summary: node.waitReason || node.errorText || `${node.title || '当前节点'}暂时无法继续。`,
    errorCode: node.lastErrorCode || '', retryable: node.status !== 'failed' || Boolean(node.fallback),
    attemptCount: Number(node.attemptCount || 0), maxAttempts: Number(node.maxAttempts || 0),
    nextRetryAt: node.nextRetryAt || '', suggestedNextStep,
  };
}

function nodeStatusAction(status = '', node = null) {
  const title = sanitizePublicWorkStatusText(node?.title || '当前节点', 240);
  return ({
    reserved: `已预留，准备执行“${title}”。`, queued: `“${title}”已进入 Agent 执行队列。`,
    running: `正在执行“${title}”。`, waiting: `“${title}”正在等待恢复或所需信息。`,
    blocked: `“${title}”当前受阻。`, completed: `已完成“${title}”。`, failed: `“${title}”执行失败。`,
    cancelled: `“${title}”已取消。`, idle: `等待“${title}”的上游依赖。`,
  })[status] || '工作状态已更新。';
}

function taskActorNextStep(status = '', node = null) {
  if (status === 'running') return '完成当前节点并提交结果摘要和证据。';
  if (status === 'queued' || status === 'reserved') return '等待 FIFO 调度后开始执行。';
  if (status === 'waiting' || status === 'blocked') return blockerForNode(node).suggestedNextStep;
  if (status === 'completed') return '等待下游节点或 uBuddy 完成交付。';
  if (status === 'failed') return '由用户或 uBuddy 决定重试、调整方案或重新分配。';
  return '等待上游依赖完成。';
}

function normalizeUBuddyStatus(task = {}, coordination = null) {
  if (TERMINAL_STATUSES.has(task.status)) return task.status;
  if (coordination?.coordinationState === 'waiting_for_agents' || task.status === 'waiting') return 'waiting';
  if (task.status === 'blocked') return 'blocked';
  return ['pending', 'ready'].includes(task.status) ? 'reserved' : 'running';
}

function ubuddyNextStep(task = {}, coordination = null, blockerNode = null) {
  if (task.status === 'completed') return '最终结果已经交付。';
  if (task.status === 'failed') return '向用户说明失败原因并提供重试或调整方案。';
  if (task.status === 'cancelled') return '保留历史记录，等待新的任务要求。';
  if (blockerNode) return blockerForNode(blockerNode).suggestedNextStep;
  if (coordination?.coordinationState === 'sleeping') return '等待 leader 完成团队执行并唤醒 uBuddy。';
  if (task.status === 'verifying') return '等待 uBuddy 大模型完成验收；仅可修复质量问题进入有限返工。';
  return '继续协调可执行节点并更新用户可见状态。';
}

function nodeEvidenceRefs(node = {}) {
  return (Array.isArray(node.evidenceRefs) ? node.evidenceRefs : []).map((item) => {
    if (typeof item === 'string') {
      if (/[\\/]/.test(item) || item.startsWith('file:')) return null;
      return { kind: 'deliverable', id: item, label: item };
    }
    if (!item || typeof item !== 'object') return null;
    return {
      kind: item.kind || item.type || (item.remoteFileId ? 'remote_file' : 'deliverable'),
      id: item.remoteFileId || item.remote_file_id || item.id || '',
      label: item.label || item.name || item.title || '',
      url: /^https:\/\//i.test(String(item.url || item.downloadUrl || item.download_url || ''))
        ? String(item.url || item.downloadUrl || item.download_url) : '',
    };
  }).filter(Boolean);
}

function uniqueEvidenceRefs(items = []) {
  const map = new Map();
  for (const item of items.filter(Boolean)) {
    const key = `${item.kind || ''}:${item.id || item.url || item.label || ''}`;
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()].slice(0, 30);
}

function normalizeDeliveryStatus(status = '') {
  const value = String(status || '').toLowerCase();
  if (['queued', 'running', 'completed', 'failed', 'cancelled'].includes(value)) return value;
  if (['working', 'generating', 'executing'].includes(value)) return 'running';
  if (['blocked', 'waiting'].includes(value)) return value;
  return 'queued';
}

function stageForDelivery(status = '', eventStageValue = '') {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (/verif|validat/i.test(eventStageValue)) return 'verifying';
  if (/deliver/i.test(eventStageValue)) return 'delivering';
  return status === 'queued' ? 'planning' : 'executing';
}

function deliveryStatusAction(status = '') {
  return ({ queued: 'Agent 任务正在等待领取。', running: 'Agent 正在处理任务。', waiting: 'Agent 正在等待所需信息。', blocked: 'Agent 任务当前受阻。', completed: 'Agent 已完成任务。', failed: 'Agent 任务执行失败。', cancelled: 'Agent 任务已取消。' })[status] || 'Agent 工作状态已更新。';
}

function deliveryNextStep(status = '') {
  if (status === 'queued') return '等待 Agent 按 FIFO 顺序领取任务。';
  if (status === 'running') return '完成处理并提交交付结果。';
  if (status === 'completed') return '等待 uBuddy 验收和交付。';
  if (status === 'cancelled') return '保留已有内容，等待新的要求。';
  return '检查状态后继续。';
}

function normalizeDelegationStatus(status = '', phase = '') {
  if (['completed', 'result_accepted', 'closed', 'submitted'].includes(status) || phase === 'delivered') return 'completed';
  if (['failed', 'rejected', 'declined'].includes(status) || phase === 'failed') return 'failed';
  if (['withdrawn'].includes(status)) return 'cancelled';
  if (['blocked'].includes(status) || phase === 'blocked') return 'blocked';
  if (['assigned', 'preparing', 'awaiting_approval'].includes(status) || ['queued', 'preparing', 'planning'].includes(phase)) return 'queued';
  return 'running';
}

function stageForDelegation(phase = '', status = '') {
  if (['completed', 'result_accepted', 'closed', 'submitted'].includes(status) || phase === 'delivered') return 'completed';
  if (['failed', 'rejected', 'declined'].includes(status) || phase === 'failed') return 'failed';
  if (status === 'withdrawn') return 'cancelled';
  if (phase === 'verifying' || phase === 'awaiting_delivery') return 'verifying';
  if (phase === 'delivering') return 'delivering';
  if (['queued', 'preparing', 'planning'].includes(phase)) return 'planning';
  return 'executing';
}

function delegationNextStep(status = '', progress = {}) {
  if (progress.blocker?.suggestedNextStep) return progress.blocker.suggestedNextStep;
  if (['completed', 'result_accepted', 'closed'].includes(status) || progress.phase === 'delivered') return '远端任务已完成。';
  if (['failed', 'blocked'].includes(status)) return '等待接收方处理阻塞或重新执行。';
  if (progress.phase === 'awaiting_delivery') return '等待接收方确认并发布交付结果。';
  return '接收方 uBuddy 将继续协调 Agent 执行任务。';
}

function projectionId(scopeKind, scopeId, actorId) {
  return `workstatus_${crypto.createHash('sha256').update(`${scopeKind}:${scopeId}:${actorId || 'actor'}`).digest('hex').slice(0, 24)}`;
}

function latestTimestamp(values = []) {
  return values.filter(Boolean).map((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
  }).filter(Boolean).sort().at(-1) || new Date(0).toISOString();
}

function projectionSourceRevision(updatedAt = '', eventCount = 0) {
  const timestamp = Date.parse(updatedAt) || 0;
  return timestamp ? (timestamp * 1_000) + Math.min(999, Math.max(0, Number(eventCount || 0))) : Math.max(0, Number(eventCount || 0));
}

function eventTimeOrder(left = {}, right = {}) {
  return (Date.parse(left.updatedAt || left.createdAt || '') || 0) - (Date.parse(right.updatedAt || right.createdAt || '') || 0);
}
