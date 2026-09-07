const ACTIVE_TASK_STATUSES = new Set(['pending', 'ready', 'queued', 'running', 'waiting', 'verifying', 'delivering', 'cancelling']);
const CLOSED_TASK_STATUSES = new Set(['result_accepted', 'closed', 'cancelled', 'withdrawn', 'declined', 'rejected']);

export function taskIdsForMessages(messages = []) {
  const ids = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = message?.metadata || {};
    addTaskId(ids, metadata.taskRunId || metadata.taskSnapshot?.taskRunId);
    for (const card of Array.isArray(metadata.publishedTaskCards) ? metadata.publishedTaskCards : []) {
      addTaskId(ids, card.taskRunId || card.task_run_id || (card.workspaceKind === 'task_run' ? card.taskWorkspaceId : ''));
    }
  }
  return [...ids];
}

export function taskSourceSessionId(task = {}) {
  return String(
    task.metadata?.sourceSecretarySessionId
    || task.metadata?.sourceSessionId
    || task.metadata?.source_session_id
    || '',
  ).trim();
}

export function taskSourceMessageId(task = {}, messages = []) {
  const explicit = String(
    task.metadata?.sourceSecretaryMessageId
    || task.metadata?.sourceMessageId
    || task.metadata?.source_message_id
    || '',
  ).trim();
  if (explicit) return explicit;
  const taskRunId = String(task.id || task.taskRunId || '').trim();
  if (!taskRunId) return '';
  return String((Array.isArray(messages) ? messages : []).find((message) => (
    String(message?.metadata?.taskRunId || message?.metadata?.taskSnapshot?.taskRunId || '').trim() === taskRunId
  ))?.id || '').trim();
}

export function taskBelongsToSession(task = {}, sessionId = '', messages = []) {
  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId || !task?.id) return false;
  const sourceSessionId = taskSourceSessionId(task);
  if (sourceSessionId) return sourceSessionId === cleanSessionId;
  return taskIdsForMessages(messages).includes(String(task.id));
}

export function mergeUBuddyTaskView(state, incoming = null) {
  if (!incoming?.id) return null;
  const previous = state.uBuddyTaskViewsById?.[incoming.id] || null;
  const next = mergeTaskSnapshots(previous, incoming);
  state.uBuddyTaskViewsById = {
    ...(state.uBuddyTaskViewsById || {}),
    [incoming.id]: next,
  };
  return next;
}

export async function hydrateUBuddyTaskViews({
  api,
  state,
  sessionId = '',
  messages = [],
  workspaceGeneration = Number(state.workspaceSwitchGeneration || 0),
  isCurrent = () => true,
  concurrency = 4,
  limit = 24,
} = {}) {
  if (!api?.getTask || !sessionId) return { changed: false, taskRunIds: [] };
  const messageTaskIds = taskIdsForMessages(messages);
  const sessionTaskIds = (state.tasks || [])
    .filter((task) => taskBelongsToSession(task, sessionId, messages))
    .map((task) => String(task.id || '').trim())
    .filter(Boolean);
  const taskRunIds = [...new Set([...messageTaskIds, ...sessionTaskIds])].slice(0, Math.max(1, Number(limit || 24)));
  if (!taskRunIds.length) return { changed: false, taskRunIds: [] };

  state.uBuddyTaskViewLoadingById = {
    ...(state.uBuddyTaskViewLoadingById || {}),
    ...Object.fromEntries(taskRunIds.map((id) => [id, true])),
  };
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < taskRunIds.length) {
      const index = cursor;
      cursor += 1;
      const taskRunId = taskRunIds[index];
      try {
        const task = await api.getTask(taskRunId);
        results[index] = { taskRunId, task, error: null };
      } catch (error) {
        results[index] = { taskRunId, task: null, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Number(concurrency || 4)), taskRunIds.length) }, worker));
  if (Number(state.workspaceSwitchGeneration || 0) !== Number(workspaceGeneration) || !isCurrent()) {
    const loading = { ...(state.uBuddyTaskViewLoadingById || {}) };
    for (const taskRunId of taskRunIds) delete loading[taskRunId];
    state.uBuddyTaskViewLoadingById = loading;
    return { changed: false, stale: true, taskRunIds };
  }

  let changed = false;
  const loading = { ...(state.uBuddyTaskViewLoadingById || {}) };
  const errors = { ...(state.uBuddyTaskViewErrorById || {}) };
  for (const result of results.filter(Boolean)) {
    delete loading[result.taskRunId];
    if (result.task?.id) {
      const previous = state.uBuddyTaskViewsById?.[result.task.id] || null;
      const next = mergeUBuddyTaskView(state, result.task);
      changed ||= JSON.stringify(previous) !== JSON.stringify(next);
      delete errors[result.taskRunId];
    } else {
      errors[result.taskRunId] = String(result.error?.message || result.error || '任务详情加载失败。');
    }
  }
  state.uBuddyTaskViewLoadingById = loading;
  state.uBuddyTaskViewErrorById = errors;
  return { changed, taskRunIds };
}

export function uBuddyTaskDisplayStatus(task = {}, { currentUserId = '' } = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const failureReport = task.metadata?.failureReport || task.metadata?.publicFailure || null;
  const recovery = task.metadata?.backgroundRecovery || null;
  const retryNode = nodes.find((node) => String(node.status || '') === 'retry_wait') || null;
  const blockedNode = nodes.find((node) => ['blocked', 'failed'].includes(String(node.status || ''))) || null;
  const requiresUserAction = Boolean(
    failureReport?.userActionRequired
    || task.metadata?.requiresUserAction
    || task.metadata?.wakeReason?.code === 'user_action_required'
    || task.coordination?.wakeReason?.code === 'user_action_required',
  );
  const status = String(task.status || '').trim().toLowerCase();
  const finalDeliveryState = String(task.metadata?.finalDelivery?.state || task.metadata?.final_delivery?.state || '').trim().toLowerCase();
  const reviewState = String(task.deliveryReview?.state || task.metadata?.deliveryReview?.state || task.metadata?.deliveryReviewState || '').trim().toLowerCase();
  const delegationStatus = String(task.delegationStatus || task.metadata?.externalDelegationStatus || '').trim().toLowerCase();
  const requesterUserId = String(task.requesterUserId || task.requester_user_id || task.metadata?.requesterUserId || '').trim();
  const recipientUserId = String(task.recipientUserId || task.recipient_user_id || task.metadata?.recipientUserId || '').trim();
  const cleanCurrentUserId = String(currentUserId || '').trim();
  const currentUserIsRequester = Boolean(cleanCurrentUserId && requesterUserId === cleanCurrentUserId);
  const currentUserIsRecipient = Boolean(cleanCurrentUserId && recipientUserId === cleanCurrentUserId);
  const externalRecipientTask = currentUserIsRecipient
    || task.metadata?.taskOrigin === 'external_delegation'
    || Boolean(task.metadata?.externalRequesterUserId);
  const confirmationPending = task.confirmationRequired === true
    || task.metadata?.confirmationRequired === true
    || finalDeliveryState === 'delivered'
    || status === 'submitted'
    || delegationStatus === 'submitted';
  if (requiresUserAction || reviewState === 'action_required' || (confirmationPending && (currentUserIsRequester || !externalRecipientTask))) {
    return { key: 'action', group: 'needs_my_action', label: confirmationPending ? '待你验收' : '需要你的操作', tone: 'danger', priority: 0 };
  }
  if (confirmationPending) {
    return { key: 'waiting_counterparty', group: 'waiting_counterparty', label: '等待对方验收', tone: 'waiting', priority: 1 };
  }
  if (retryNode || (recovery && Number(recovery.attemptCount || 0) > 0 && ACTIVE_TASK_STATUSES.has(status))) {
    return { key: 'retry', group: 'retrying', label: retryNode ? '等待自动重试' : 'uBuddy 正在恢复', tone: 'warning', priority: 2 };
  }
  if (status === 'failed' || blockedNode?.status === 'failed') return { key: 'failed', group: 'needs_my_action', label: '执行失败', tone: 'danger', priority: 3 };
  if (CLOSED_TASK_STATUSES.has(status) || ['closed', 'user_confirmed'].includes(finalDeliveryState)) {
    const accepted = status === 'result_accepted' || finalDeliveryState === 'closed';
    return {
      key: status === 'cancelled' ? 'cancelled' : accepted ? 'accepted' : 'completed',
      group: 'closed',
      label: status === 'cancelled' ? '已停止' : accepted ? '已验收' : '已完成',
      tone: status === 'cancelled' ? 'muted' : 'success',
      priority: 6,
    };
  }
  if (status === 'completed') return { key: 'completed', group: 'closed', label: '已完成', tone: 'success', priority: 5 };
  if (status === 'waiting' || task.coordination?.coordinationState === 'waiting_for_agents') {
    return { key: 'waiting', group: 'active', label: '等待可用 Agent', tone: 'muted', priority: 4 };
  }
  if (status === 'verifying') return { key: 'active', group: 'active', label: '正在验收', tone: 'active', priority: 3 };
  if (status === 'delivering') return { key: 'active', group: 'active', label: '正在交付', tone: 'active', priority: 3 };
  return { key: 'active', group: 'active', label: '正在执行', tone: 'active', priority: 3 };
}

export function uBuddyPendingTaskCount({ tasks = [], taskViewsById = {} } = {}) {
  const taskById = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskId = String(task?.id || '').trim();
    if (taskId) taskById.set(taskId, task);
  }
  for (const task of Object.values(taskViewsById || {})) {
    const taskId = String(task?.id || '').trim();
    if (taskId) taskById.set(taskId, task);
  }
  return [...taskById.values()].filter((task) => (
    Boolean(taskSourceSessionId(task) || task.metadata?.source === 'ubuddy_dispatch')
    && uBuddyTaskDisplayStatus(task).group === 'needs_my_action'
  )).length;
}

export function compareUBuddyTasks(left = {}, right = {}, options = {}) {
  const leftStatus = uBuddyTaskDisplayStatus(left, options);
  const rightStatus = uBuddyTaskDisplayStatus(right, options);
  return leftStatus.priority - rightStatus.priority
    || String(right.updatedAt || right.updated_at || right.createdAt || '').localeCompare(String(left.updatedAt || left.updated_at || left.createdAt || ''));
}

export function taskProgressCounts(task = {}) {
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const completed = nodes.filter((node) => String(node.status || '') === 'completed').length;
  return {
    completed,
    total: nodes.length,
    percent: nodes.length ? Math.round((completed / nodes.length) * 100) : Number(task.progress?.percent || 0),
  };
}

function mergeTaskSnapshots(previous = null, incoming = null) {
  if (!previous) return incoming;
  if (!incoming) return previous;
  const incomingNodes = Array.isArray(incoming.nodes) && incoming.nodes.length ? incoming.nodes : previous.nodes;
  const incomingEvents = Array.isArray(incoming.events) && incoming.events.length ? incoming.events : previous.events;
  return {
    ...previous,
    ...incoming,
    metadata: { ...(previous.metadata || {}), ...(incoming.metadata || {}) },
    ...(incomingNodes ? { nodes: incomingNodes } : {}),
    ...(incomingEvents ? { events: incomingEvents } : {}),
  };
}

function addTaskId(target, value = '') {
  const clean = String(value || '').trim();
  if (clean) target.add(clean);
}
