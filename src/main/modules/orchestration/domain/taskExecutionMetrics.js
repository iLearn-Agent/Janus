import { deriveTaskLifecycleProgress } from '../../../../shared/contracts/uBuddyDeliveryReview.js';

export function summarizeTaskNode(node) {
  if (!node) return null;
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    agentId: node.agentId,
    dependencies: node.dependencies || [],
    priority: node.priority,
    parallelGroup: node.parallelGroup,
    blocking: Boolean(node.blocking),
    attemptCount: Number(node.attemptCount || 0),
    maxAttempts: Number(node.maxAttempts || 3),
    lastErrorCode: node.lastErrorCode || '',
  };
}

export function classifyTaskType(input = '') {
  const text = String(input || '').toLowerCase();
  if (/\b(code|bug|fix|refactor|implement|repository|repo|api|css|html|javascript|typescript|python)\b|代码|修复|重构|实现|仓库|接口/.test(text)) return 'code_change';
  if (/文件|文档|报告|表格|ppt|演示文稿|生成.{0,8}(文件|文档)|\b(file|document|report|spreadsheet|presentation)\b/.test(text)) return 'file_generation';
  if (/命令|脚本|终端|构建|部署|安装|\b(command|shell|terminal|build|deploy|install)\b/.test(text)) return 'command_execution';
  if (/调研|研究|检索|调查|资料|\b(research|investigate|survey|search)\b/.test(text)) return 'research';
  if (/解释|说明|原理|为什么|\b(explain|describe|how does|why)\b/.test(text)) return 'explanation';
  if (/协作|多部门|多个.{0,8}(agent|智能体)|\bcollaborat/.test(text)) return 'collaboration';
  return 'qa';
}

export function buildPublicTaskProgressSnapshot(task, {
  phase = '',
  taskType = '',
  objective = null,
  changedNodes = [],
} = {}) {
  if (!task?.id) return null;
  const nodes = Array.isArray(task.nodes) ? task.nodes : [];
  const counts = {
    total: nodes.length,
    pending: nodes.filter((node) => node.status === 'pending').length,
    ready: nodes.filter((node) => node.status === 'ready').length,
    queued: nodes.filter((node) => node.status === 'queued').length,
    running: nodes.filter((node) => node.status === 'running').length,
    waiting: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
    completed: nodes.filter((node) => node.status === 'completed').length,
    failed: nodes.filter((node) => node.status === 'failed').length,
    cancelled: nodes.filter((node) => node.status === 'cancelled').length,
  };
  const executionPercent = counts.total ? Math.round((counts.completed / counts.total) * 100) : 0;
  const requestedPhase = phase || progressPhaseForTask(task);
  const reviewState = task.deliveryReview?.state || task.metadata?.deliveryReview?.state
    || task.metadata?.deliveryReviewState || '';
  const lifecycleProgress = deriveTaskLifecycleProgress({
    phase: requestedPhase,
    taskStatus: task.status || 'pending',
    executionPercent,
    reviewState,
    finalDelivery: task.metadata?.finalDelivery || null,
    acceptanceSource: task.metadata?.deliveryReviewOutcome || '',
    hasConfirmationProtocol: Boolean(
      task.metadata?.finalDelivery
      || task.deliveryReview
      || task.metadata?.deliveryReview
      || task.metadata?.deliveryReviewState,
    ),
  });
  counts.executionPercent = lifecycleProgress.executionPercent;
  counts.percent = lifecycleProgress.percent;
  counts.label = lifecycleProgress.label;
  counts.lifecyclePhase = lifecycleProgress.phase;
  counts.confirmationRequired = lifecycleProgress.confirmationRequired;
  const publicNode = (node) => ({
    id: node.id,
    title: node.title || '未命名节点',
    agentId: node.agentId || '',
    status: node.status || 'pending',
    summary: publicNodeSummary(node),
    attemptCount: Number(node.attemptCount || 0),
    maxAttempts: Number(node.maxAttempts || 3),
    nextRetryAt: node.nextRetryAt || '',
    lastErrorCode: node.lastErrorCode || '',
    recoveryActions: (node.recoveryActions || []).slice(-5),
  });
  const blockedNode = nodes.find((node) => ['waiting', 'retry_wait', 'blocked', 'failed'].includes(node.status));
  const attemptedActions = blockedNode
    ? [...new Set([
        ...(blockedNode.recoveryActions || []),
        ...(task.events || []).filter((event) => event.taskNodeId === blockedNode.id && /retry|fallback|timeout|communication|waiting|skipped/i.test(event.eventType || '')).slice(-5).map((event) => event.summary),
      ].filter(Boolean))].slice(-5)
    : [];
  return {
    taskRunId: task.id,
    taskStatus: task.status || 'pending',
    continuedByTaskRunId: String(task.metadata?.continuedByTaskRunId || ''),
    phase: lifecycleProgress.phase,
    taskType: taskType || task.metadata?.taskType || classifyTaskType(task.metadata?.routingPrompt || task.prompt || task.title),
    objective: objective || task.metadata?.objective || null,
    progress: counts,
    lifecycleProgress,
    activeNodes: nodes.filter((node) => ['ready', 'queued', 'running'].includes(node.status)).map(publicNode),
    changedNodes: (Array.isArray(changedNodes) ? changedNodes : [changedNodes]).filter(Boolean).map(publicNode),
    blocker: blockedNode ? {
      nodeId: blockedNode.id,
      summary: blockedNode.waitReason || blockedNode.errorText || `${blockedNode.title || '任务节点'}暂时无法继续。`,
      attemptedActions,
      errorCode: blockedNode.lastErrorCode || '',
      attemptCount: Number(blockedNode.attemptCount || 0),
      maxAttempts: Number(blockedNode.maxAttempts || 3),
      nextRetryAt: blockedNode.nextRetryAt || '',
      suggestedNextStep: blockedNode.status === 'retry_wait'
        ? `系统将于 ${blockedNode.nextRetryAt || '稍后'} 自动重试，无需手动操作。`
        : blockedNode.status === 'failed'
          ? '自动恢复已结束；可以重试该节点、调整任务方案或重新分配 Agent。'
          : '等待所需信息或解除协作依赖后继续。',
      requiresUserDecision: Boolean(blockedNode.status === 'failed' && !blockedNode.fallback),
    } : null,
    resultState: task.metadata?.resultState || '',
    deliverableContract: task.metadata?.deliverableContract || null,
    deliverable: task.metadata?.deliverableResult || null,
    technicalDetails: {
      nodes: nodes.map((node) => {
        const declaration = task.metadata?.nodeOutputDeclarations?.[node.id] || {};
        const contentType = declaration.contentType || '';
        return {
          ...publicNode(node),
          contentType,
          detail: contentType && contentType !== 'deliverable' ? String(node.resultText || '').slice(0, 8000) : '',
        };
      }),
      diagnostics: (task.events || []).filter((event) => /failed|diagnostic|validation/i.test(event.eventType || '')).slice(-20).map((event) => ({
        id: event.id,
        type: event.eventType,
        summary: event.summary,
        createdAt: event.createdAt,
      })),
    },
  };
}

function publicNodeSummary(node = {}) {
  if (node.status === 'completed') return String(node.resultSummary || '').trim().slice(0, 240) || '节点已完成。';
  if (['waiting', 'retry_wait', 'blocked'].includes(node.status)) return String(node.waitReason || '').trim().slice(0, 240) || '正在等待所需信息。';
  if (node.status === 'failed') return String(node.errorText || '').trim().slice(0, 240) || '节点执行失败。';
  if (node.status === 'running') return '正在执行节点任务。';
  if (node.status === 'queued') return '已进入 Agent 执行队列。';
  if (node.status === 'ready') return '依赖已满足，等待执行。';
  return '正在等待上游依赖。';
}

function progressPhaseForTask(task = {}) {
  const declaredFailurePhase = String(task.metadata?.failurePhase || task.metadata?.failureStage || '').trim();
  if (['confirming', 'planning', 'executing', 'verifying', 'delivering'].includes(declaredFailurePhase)) return declaredFailurePhase;
  if (task.status === 'completed') return 'delivering';
  if (task.metadata?.resultState === 'needs_revision' || task.metadata?.deliveryValidationState === 'failed') return 'verifying';
  if (task.status === 'verifying') return 'verifying';
  if (['failed', 'cancelled', 'cancelling'].includes(task.status)) return 'executing';
  if ((task.communications || []).some((item) => item.status === 'open')) return 'coordinating';
  if ((task.nodes || []).some((node) => ['ready', 'queued', 'running', 'retry_wait'].includes(node.status))) return 'executing';
  return 'planning';
}

export function buildExecutionMetrics({ task, nodes, communications, graphRevisions }) {
  const parallelMap = new Map();
  for (const node of nodes) {
    const group = node.parallelGroup || 'main';
    const current = parallelMap.get(group) || {
      group,
      nodeCount: 0,
      estimatedMinutes: 0,
      completed: 0,
      waiting: 0,
      failed: 0,
      cancelled: 0,
      agents: new Set(),
    };
    current.nodeCount += 1;
    current.estimatedMinutes += Number(node.estimatedMinutes || 0);
    if (node.status === 'completed') current.completed += 1;
    if (['waiting', 'retry_wait', 'blocked'].includes(node.status)) current.waiting += 1;
    if (node.status === 'failed') current.failed += 1;
    if (node.status === 'cancelled') current.cancelled += 1;
    if (node.agentId) current.agents.add(node.agentId);
    parallelMap.set(group, current);
  }
  const parallelGroups = [...parallelMap.values()].map((item) => ({
    group: item.group,
    nodeCount: item.nodeCount,
    estimatedMinutes: item.estimatedMinutes,
    completed: item.completed,
    waiting: item.waiting,
    failed: item.failed,
    cancelled: item.cancelled,
    agents: [...item.agents].sort(),
  })).sort((left, right) => left.group.localeCompare(right.group));

  const closedCommunications = communications.filter((item) => item.createdAt && item.resolvedAt);
  const communicationWaitMs = closedCommunications.reduce((sum, item) => sum + durationMs(item.createdAt, item.resolvedAt), 0);
  const timeoutEvents = (task.events || []).filter((event) => event.eventType === 'node_timeout');
  const fallbackNodes = nodes.filter((node) => node.fallback && (node.errorText || ['waiting', 'failed'].includes(node.status)));
  const finalDelivery = chooseFinalDeliveryNode(nodes);
  return {
    taskRunId: task.id,
    status: task.status,
    totalNodes: nodes.length,
    completedNodes: nodes.filter((node) => node.status === 'completed').length,
    failedNodes: nodes.filter((node) => node.status === 'failed').length,
    waitingNodes: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
    cancelledNodes: nodes.filter((node) => node.status === 'cancelled').length,
    totalEstimatedNodeMinutes: nodes.reduce((sum, node) => sum + Number(node.estimatedMinutes || 0), 0),
    criticalPathEstimatedMinutes: criticalPathEstimatedMinutes(nodes),
    maxParallelWidth: parallelGroups.reduce((max, item) => Math.max(max, item.nodeCount), 0),
    parallelGroups,
    communicationCount: communications.length,
    blockingCommunicationCount: communications.filter((item) => item.blocking).length,
    openCommunicationCount: communications.filter((item) => item.status === 'open').length,
    communicationWaitMs,
    retryOrFallbackEventCount: timeoutEvents.length + fallbackNodes.length,
    timeoutEventCount: timeoutEvents.length,
    graphRevisionCount: graphRevisions.length,
    graphRevisionTypes: [...new Set(graphRevisions.map((item) => item.revisionType))].sort(),
    finalDelivery: finalDelivery ? {
      nodeId: finalDelivery.id,
      nodeTitle: finalDelivery.title,
      agentId: finalDelivery.agentId,
      outputFormat: finalDelivery.outputFormat,
      resultChars: String(finalDelivery.resultText || '').length,
    } : null,
  };
}

function criticalPathEstimatedMinutes(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const memo = new Map();
  const visit = (node) => {
    if (!node) return 0;
    if (memo.has(node.id)) return memo.get(node.id);
    const dependencyCost = Math.max(0, ...(node.dependencies || []).map((id) => visit(byId.get(id))));
    const value = dependencyCost + Number(node.estimatedMinutes || 0);
    memo.set(node.id, value);
    return value;
  };
  return Math.max(0, ...nodes.map(visit));
}

function chooseFinalDeliveryNode(nodes) {
  const completed = nodes.filter((node) => node.status === 'completed' && node.resultText);
  return completed.find((node) => /final|synthesis|delivery|最终|交付/i.test(`${node.title} ${node.outputFormat}`))
    || completed.sort((left, right) => right.priority - left.priority)[0]
    || null;
}

export function durationMs(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return endMs - startMs;
}
