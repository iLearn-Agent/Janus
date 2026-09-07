import { deriveTaskLifecycleProgress } from '../../../../shared/contracts/uBuddyDeliveryReview.js';

export function applyDelegationTaskUpdate(state, payload = {}) {
  const delegation = payload.delegation && typeof payload.delegation === 'object'
    ? payload.delegation
    : null;
  const task = payload.task && typeof payload.task === 'object' ? payload.task : null;
  const taskDelegationId = String(task?.metadata?.delegationId || '').trim();
  const delegationId = String(delegation?.id || taskDelegationId).trim();
  if (!delegationId) return '';

  if (delegation) {
    state.agentDelegations = upsertDelegation(state.agentDelegations, delegation);
    const collaborationTasks = state.collaborationOverview?.tasks;
    if (Array.isArray(collaborationTasks)) {
      const belongsToGroup = Boolean(delegation.groupId || delegation.group_id || delegation.metadata?.groupId);
      const alreadyListed = collaborationTasks.some((item) => item.id === delegationId);
      if (alreadyListed || belongsToGroup) {
        state.collaborationOverview = {
          ...(state.collaborationOverview || {}),
          tasks: upsertDelegation(collaborationTasks, delegation),
        };
      }
    }
  }

  if (task && taskDelegationId) {
    state.networkDelegationTaskById = {
      ...(state.networkDelegationTaskById || {}),
      [taskDelegationId]: task,
    };
  }

  const progress = task
    ? progressFromTask(state, task, payload.change, state.networkDelegationProgressById?.[delegationId])
    : payload.change?.progress || payload.progress || delegation?.metadata?.executionProgress || null;
  if (progress && typeof progress === 'object') {
    state.networkDelegationProgressById = {
      ...(state.networkDelegationProgressById || {}),
      [delegationId]: progress,
    };
  }
  return delegationId;
}

export function applyDelegationNoticeUpsert(state, payload = {}) {
  const message = payload.message && typeof payload.message === 'object' ? payload.message : null;
  const session = payload.session && typeof payload.session === 'object' ? payload.session : null;
  if (!message && !session) return { applied: false, currentSession: false, sessionId: '' };
  const sessionId = String(session?.id || message?.sessionId || message?.session_id || '').trim();
  if (session?.id) {
    const sessions = Array.isArray(state.sessions) ? [...state.sessions] : [];
    const index = sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) sessions[index] = { ...sessions[index], ...session };
    else sessions.unshift(session);
    state.sessions = sessions;
  }
  const currentSession = Boolean(message?.id && sessionId && state.currentSessionId === sessionId);
  if (currentSession) {
    const messages = Array.isArray(state.messages) ? [...state.messages] : [];
    const index = messages.findIndex((item) => item.id === message.id);
    if (index >= 0) messages[index] = { ...messages[index], ...message };
    else messages.push(message);
    messages.sort((left, right) => String(left.createdAt || left.created_at || '').localeCompare(String(right.createdAt || right.created_at || '')));
    state.messages = messages;
  }
  return { applied: Boolean(message || session), currentSession, sessionId };
}

function progressFromTask(state, task = {}, change = {}, previous = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const currentNode = change?.node || nodes.find((node) => node.status === 'running') || nodes.find((node) => node.status === 'queued') || null;
  const taskStatus = String(task.status || 'running');
  const publicNodes = nodes.map((node) => ({
    id: node.id || '',
    title: node.title || '任务节点',
    agentId: node.agentId || '',
    agentName: state.org?.agents?.find((agent) => agent.id === node.agentId)?.name || node.agentId || 'Agent',
    status: node.status || 'pending',
    summary: taskNodeStatusSummary(node.status),
    attemptCount: Number(node.attemptCount || 0),
    maxAttempts: Number(node.maxAttempts || 3),
    nextRetryAt: node.nextRetryAt || '',
  }));
  const milestones = Array.isArray(previous?.milestones) ? [...previous.milestones] : [];
  if (change?.node) {
    const milestone = {
      key: `${change.node.id || change.node.title}:${change.node.status || change.type || 'updated'}`,
      status: change.activityStatus || change.node.status || 'running',
      title: change.type === 'node_activity' ? change.title || change.node.title || '执行进度' : change.node.title || '任务节点',
      detail: change.type === 'node_activity'
        ? change.detail || change.message || taskNodeStatusSummary(change.node.status)
        : taskNodeStatusSummary(change.node.status),
      agentId: change.node.agentId || '',
      agentName: state.org?.agents?.find((agent) => agent.id === change.node.agentId)?.name || change.node.agentId || '',
    };
    const index = milestones.findIndex((item) => item.key === milestone.key);
    if (index >= 0) milestones[index] = milestone;
    else milestones.push(milestone);
    if (milestones.length > 20) milestones.splice(0, milestones.length - 20);
  }
  const blockedNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(node.status));
  const publicMessage = currentNode
    ? `${currentNode.title || '任务节点'}：${taskNodeStatusSummary(currentNode.status)}`
    : 'uBuddy 正在处理任务';
  const phase = taskStatus === 'verifying' ? 'verifying'
    : ['failed', 'cancelled'].includes(taskStatus) ? 'failed'
      : taskStatus === 'completed' ? 'awaiting_delivery' : 'executing';
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const executionPercent = nodes.length ? Math.round((completed / nodes.length) * 100) : 0;
  const lifecycle = deriveTaskLifecycleProgress({
    phase: phase === 'awaiting_delivery' ? 'delivering' : phase,
    taskStatus,
    executionPercent,
    reviewState: task.deliveryReview?.state || task.metadata?.deliveryReview?.state || task.metadata?.deliveryReviewState || '',
    finalDelivery: task.metadata?.finalDelivery || null,
    acceptanceSource: task.metadata?.deliveryReviewOutcome || '',
    hasConfirmationProtocol: Boolean(
      task.metadata?.delegationId
      || task.metadata?.completionGate === 'delegation_delivery'
      || task.metadata?.finalDelivery
      || task.deliveryReview
      || task.metadata?.deliveryReview
      || task.metadata?.deliveryReviewState,
    ),
  });
  return {
    version: 2,
    sequence: Date.now(),
    phase,
    message: publicMessage,
    completed,
    total: nodes.length,
    executionPercent: lifecycle.executionPercent,
    percent: lifecycle.percent,
    lifecyclePhase: lifecycle.phase,
    label: lifecycle.label,
    confirmationRequired: lifecycle.confirmationRequired,
    pending: nodes.filter((node) => node.status === 'pending').length,
    ready: nodes.filter((node) => node.status === 'ready').length,
    queued: nodes.filter((node) => node.status === 'queued').length,
    running: nodes.filter((node) => node.status === 'running').length,
    waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
    failed: nodes.filter((node) => node.status === 'failed').length,
    currentStep: currentNode ? { title: currentNode.title || '', status: currentNode.status || '', agentName: state.org?.agents?.find((agent) => agent.id === currentNode.agentId)?.name || currentNode.agentId || '' } : null,
    nodes: publicNodes,
    milestones,
    blocker: blockedNode ? {
      nodeId: blockedNode.id || '',
      summary: taskNodeStatusSummary(blockedNode.status),
      errorCode: blockedNode.lastErrorCode || '',
      attemptCount: Number(blockedNode.attemptCount || 0),
      maxAttempts: Number(blockedNode.maxAttempts || 3),
      nextRetryAt: blockedNode.nextRetryAt || '',
      suggestedNextStep: blockedNode.status === 'retry_wait'
        ? '系统将在稍后自动重试。'
        : blockedNode.status === 'failed'
          ? '可以重试该节点或重新执行任务。'
          : '等待所需信息或解除依赖后继续。',
    } : null,
    updatedAt: new Date().toISOString(),
    terminal: ['failed', 'cancelled'].includes(taskStatus),
  };
}

function taskNodeStatusSummary(status = '') {
  return ({
    pending: '等待上游依赖', ready: '等待执行', queued: '已进入执行队列', running: '正在执行',
    retry_wait: '等待自动重试', waiting: '等待协作信息', blocked: '依赖问题阻塞', completed: '已完成',
    failed: '执行失败', cancelled: '已取消',
  })[String(status || '')] || '状态已更新';
}

function upsertDelegation(items = [], delegation = {}) {
  const current = Array.isArray(items) ? [...items] : [];
  const index = current.findIndex((item) => item.id === delegation.id);
  if (index >= 0) current[index] = delegation;
  else current.unshift(delegation);
  return current;
}
