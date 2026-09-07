import {
  buildAttachmentCatalog,
  buildMessageWithAttachments,
  stripAttachmentResourceBlock,
} from '../../../files.js';
import { buildCollaborationTaskPrompt } from '../../../prompts.js';
import { suggestChatTitle } from '../../../chatPlanner.js';
import { clipText } from '../../../utils.js';
import { buildPublicTaskProgressSnapshot, buildUBuddyPlannerCandidates, classifyTaskType, proposeUBuddyTaskGraph } from '../../orchestration/index.js';

function hasSubstantiveCollaborationInput({ prompt = '', chatContext = null, store = null } = {}) {
  const sourceSessionId = String(chatContext?.sourceSessionId || '').trim();
  const sourceText = sourceSessionId && store
    ? store.listMessages(sourceSessionId)
      .filter((item) => item.role === 'user')
      .map((item) => String(item.content || ''))
      .join(' ')
    : String(prompt || '');
  const normalized = sourceText.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/^(hi|hello|hey|test|\u4f60\u597d|\u60a8\u597d|\u5728\u5417|\u54c8\u55bd|\u6d4b\u8bd5)[\s!,.?\u3002\uff01\uff0c\uff1f]*$/i.test(normalized)) return false;
  return normalized.length >= 4;
}

async function sendCollaborationChat({
  runtimeRoot,
  store,
  scheduler,
  org,
  runId = '',
  user,
  sessionId = '',
  message = '',
  routingMessage = '',
  attachments = [],
  chatContext = null,
  contextScope = null,
  chatPlan = null,
  model = '',
  reasoningEffort = '',
  projectId = '',
  workspaceRoot = '',
  permissionMode = '',
  performanceForAgent = null,
  leadershipForAgent = null,
  onApproval = null,
  onEvent = null,
  onTaskCreated = null,
  signal = null,
  triggerAutoSync = null,
  setSession = null,
  emitEvent,
  heartbeat,
  createCancelledError,
}) {
  const prompt = String(message || '').trim();
  const directRoutingPrompt = String(routingMessage || prompt).trim();
  if (!prompt) throw new Error('请输入需要协作处理的复杂任务。');
  if (!hasSubstantiveCollaborationInput({ prompt: directRoutingPrompt, chatContext, store })) {
    throw new Error('\u8bf7\u5148\u63cf\u8ff0\u4e00\u4e2a\u5177\u4f53\u4efb\u52a1\uff0c\u4f8b\u5982\u76ee\u6807\u3001\u4ea4\u4ed8\u7269\u6216\u9700\u8981\u89e3\u51b3\u7684\u95ee\u9898\u3002');
  }
  const throwIfCancelled = () => {
    if (signal?.aborted) throw createCancelledError();
  };
  const taskType = classifyTaskType(directRoutingPrompt);
  const objective = collaborationObjective(directRoutingPrompt, attachments, taskType);
  throwIfCancelled();
  let session = sessionId ? store.getSession(sessionId) : null;
  const accountWorkspaceId = store.activeAccountWorkspace?.({ userId: user?.id || '', deviceId: store.contextDeviceId?.() || 'local' })?.id || 'workspace_personal';
  if (session && (session.userId !== user?.id || session.workspaceId !== accountWorkspaceId)) {
    throw new Error('无权访问该会话。');
  }
  if (!session || session.departmentId !== 'collaboration') {
    session = store.createSession({
      title: chatPlan?.title || suggestChatTitle(prompt, { mode: 'collaboration', departmentId: 'collaboration', attachments }),
      departmentId: 'collaboration',
      agentId: '',
      projectId,
      workspaceRoot,
      userId: user?.id || 'local_admin',
      accountWorkspaceId,
    });
  } else if (projectId && (!session.projectId || session.projectId !== projectId || !session.workspaceRoot)) {
    session = store.updateSession(session.id, { projectId, workspaceRoot }) || session;
  }
  if (setSession) setSession(session);
  emitEvent(onEvent, {
    kind: 'start',
    runId,
    sessionId: session.id,
    title: session.title,
    agentId: '',
    departmentId: 'collaboration',
    targetKind: 'collaboration',
  });
  emitEvent(onEvent, {
    kind: 'routing',
    sessionId: session.id,
    departmentId: 'collaboration',
    agentId: '',
    targetKind: 'collaboration',
    reason: chatPlan?.rationale || '已进入部门协作：将拆解任务并协调多个部门 agent',
  });
  emitEvent(onEvent, {
    kind: 'progress',
    stage: 'confirming',
    planStep: 'decompose',
    message: `任务目标已确认：${taskTypeLabel(taskType)}；${objective.summary}`,
    taskType,
    objective,
  });
  const storedMessage = buildMessageWithAttachments(runtimeRoot, prompt, attachments, user?.id);
  const requestMessage = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: storedMessage,
    agentId: '',
    departmentId: 'collaboration',
    metadata: {
      ...(attachments.length ? { attachments } : {}),
      executionPlan: chatPlan,
    },
  });
  triggerAutoSync?.('collaboration_message', { delayMs: 1200 });
  const recent = store.listMessages(session.id)
    .slice(0, -1)
    .map((item) => ({ ...item, content: stripAttachmentResourceBlock(item.content) }));
  const sourceTitle = String(chatContext?.sourceTitle || '').trim();
  const sourceSessionId = String(chatContext?.sourceSessionId || '').trim();
  const sourceMessages = sourceSessionId ? store.listMessages(sourceSessionId) : [];
  const taskRoutingPrompt = sourceSessionId
    ? sourceMessages.filter((item) => item.role === 'user').map((item) => stripAttachmentResourceBlock(item.content)).join('\n')
    : directRoutingPrompt;
  const sourceAttachments = sourceMessages.flatMap((item) => Array.isArray(item.metadata?.attachments) ? item.metadata.attachments : []);
  const taskAttachments = [...attachments, ...sourceAttachments].filter((item, index, items) => {
    const key = String(item?.id || item?.path || item?.relative_path || item?.name || '');
    return key && items.findIndex((candidate) => String(candidate?.id || candidate?.path || candidate?.relative_path || candidate?.name || '') === key) === index;
  });
  const attachmentCatalogMessage = [storedMessage, ...sourceMessages.map((item) => item.content)].join('\n');
  const attachmentCatalog = buildAttachmentCatalog(runtimeRoot, attachmentCatalogMessage, taskAttachments, user?.id);
  const taskPrompt = buildCollaborationTaskPrompt({
    userMessage: prompt,
    recentMessages: recent,
    chatContext: { ...(chatContext || {}), mode: 'collaboration' },
    attachmentContext: '',
  });
  const plannerTaskPrompt = buildCollaborationTaskPrompt({
    userMessage: taskRoutingPrompt,
    recentMessages: recent,
    chatContext: { ...(chatContext || {}), mode: 'collaboration' },
    attachmentContext: '',
  });
  const globalTaskSummary = clipText([
    `用户目标：${taskRoutingPrompt}`,
    recent.length ? `相关对话：${recent.slice(-4).map((item) => `${item.role}: ${item.content}`).join(' | ')}` : '',
    sourceTitle ? `来源会话：${sourceTitle}` : '',
  ].filter(Boolean).join('\n'), 2200);
  const candidateSnapshots = buildUBuddyPlannerCandidates({ store, org, userId: user?.id || 'local_admin', performanceForAgent, leadershipForAgent });
  emitEvent(onEvent, {
    kind: 'progress', stage: 'planning', planStep: 'decompose',
    message: '正在解析交付物、执行依赖和合适的 Agent，准备协作任务图',
    taskType, objective,
  });
  let taskGraphProposal = null;
  let plannerMode = 'fallback';
  try {
    taskGraphProposal = await heartbeat(proposeUBuddyTaskGraph({
      prompt: plannerTaskPrompt,
      candidates: candidateSnapshots,
      root: runtimeRoot,
      cwd: workspaceRoot || runtimeRoot,
      model,
      reasoningEffort,
      permissionMode,
      signal,
      executionContext: {
        store,
        userId: user?.id || 'local_admin',
        conversationId: session?.id || '',
        departmentId: 'secretary_department',
        agentId: 'secretary_agent',
        executionKind: 'ubuddy_task_graph_planner',
        metadata: { planningMode: 'collaboration_chat' },
      },
    }), onEvent, 'uBuddy 正在生成并校验任务图');
    plannerMode = 'model';
  } catch {
    taskGraphProposal = null;
  }
  throwIfCancelled();
  if (taskGraphProposal?.status === 'needs_clarification') {
    const answer = [taskGraphProposal.clarification?.question,
      ...(taskGraphProposal.clarification?.options || []).map((option, index) => `${index + 1}. ${option}`)].filter(Boolean).join('\n');
    const saved = store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      agentId: 'secretary_agent',
      departmentId: 'collaboration',
      metadata: {
        collaborationClarification: true,
        reasonCode: taskGraphProposal.clarification?.reason || 'ambiguous_final_deliverable',
        requestMessageId: requestMessage.id,
      },
    });
    return { session: store.getSession(session.id), message: saved, answer, threadId: '', task: null, artifacts: [], clarification: taskGraphProposal.clarification };
  }
  const task = scheduler.createTaskRun({
    title: sourceTitle ? `协作：${sourceTitle}` : taskRoutingPrompt.slice(0, 40) || '部门协作任务',
    prompt: taskPrompt,
    departmentId: 'collaboration',
    metadata: {
      userId: user?.id || 'local_admin',
      accountWorkspaceId,
      projectId,
      workspaceRoot,
      conversationId: session.id,
      requestMessageId: requestMessage.id,
      source: sourceSessionId ? 'history_session' : 'direct',
      sourceSessionId,
      sourceTitle,
      attachmentCatalog,
      globalTaskSummary,
      routingPrompt: taskRoutingPrompt,
      candidateSnapshots,
      taskType,
      objective,
      taskGraphProposal,
      deliverablePlan: taskGraphProposal?.deliverablePlan || null,
      ubuddyPlannerMode: plannerMode,
      executionOptions: { model, reasoningEffort, permissionMode },
      ...(chatContext?.type === 'ppt' ? {
        pptContext: {
          type: 'ppt',
          styleId: String(chatContext.styleId || chatContext.styleAgentId || '').trim(),
          templateId: String(chatContext.templateId || '').trim(),
          styleLabel: String(chatContext.styleLabel || '').trim(),
          templateLabel: String(chatContext.templateLabel || '').trim(),
          templateSelection: chatContext.templateSelection === 'explicit' ? 'explicit' : '',
        },
      } : {}),
      ...(contextScope?.delegationId ? {
        coordinationAuthority: 'owner_ubuddy',
        completionGate: 'delegation_delivery',
        deliveryValidationState: 'pending',
        delegationId: String(contextScope.delegationId || ''),
        groupId: String(contextScope.groupId || ''),
      } : {}),
    },
  });
  if (typeof onTaskCreated === 'function') await onTaskCreated(task);
  const emitTaskProgress = (nextTask, change = {}, phase = '') => {
    const changedNode = change?.node || null;
    const snapshot = buildPublicTaskProgressSnapshot(nextTask, {
      phase,
      taskType,
      objective,
      changedNodes: changedNode ? [changedNode] : [],
    });
    if (!snapshot) return;
    emitEvent(onEvent, {
      kind: 'task-progress',
      stage: snapshot.phase,
      planStep: ['confirming', 'planning'].includes(snapshot.phase) ? 'decompose' : snapshot.phase === 'delivering' ? 'synthesize' : 'execute',
      message: collaborationProgressMessage(snapshot, change),
      ...snapshot,
      taskProgress: snapshot.progress,
    });
  };
  triggerAutoSync?.('collaboration_task_created', { delayMs: 1200 });
  emitEvent(onEvent, {
    kind: 'progress',
    stage: 'working',
    planStep: 'execute',
    message: `已创建${plannerMode === 'model' ? '模型规划' : '回退规划'}任务图谱：${task.nodes.length} 个节点，${collaborationDepartmentLabels(task, org).join(' / ') || '待分配'}`,
    taskRunId: task.id,
    taskType,
    objective,
    assignedAgents: [...new Set(task.nodes.map((node) => node.agentId).filter(Boolean))],
    taskProgress: buildPublicTaskProgressSnapshot(task, { phase: 'executing', taskType, objective })?.progress,
  });
  emitTaskProgress(task, { type: 'task_created' }, 'executing');

  let currentTask = task;
  const maxWaves = 12;
  for (let wave = 1; wave <= maxWaves; wave += 1) {
    throwIfCancelled();
    const ready = store.readyTaskNodes(currentTask.id);
    const openBeforeRun = (currentTask.communications || []).filter((item) => item.status === 'open');
    if (!ready.length && !openBeforeRun.length) break;
    if (ready.length) {
      emitEvent(onEvent, {
        kind: 'progress',
        stage: 'working',
        planStep: 'execute',
        message: `部门协作第 ${wave} 轮：并行运行 ${ready.length} 个节点`,
        activeAgents: [...new Set(ready.map((node) => node.agentId).filter(Boolean))],
        activeNodes: ready.map((node) => ({ id: node.id, title: node.title, agentId: node.agentId })),
      });
      currentTask = await heartbeat(
        scheduler.runReadyNodes(currentTask.id, {
          maxParallel: Math.min(3, ready.length),
          signal,
          model,
          reasoningEffort,
          permissionMode,
          onApproval,
          onTaskProgress: (nextTask, change) => emitTaskProgress(nextTask, change, 'executing'),
        }),
        onEvent,
        `部门协作第 ${wave} 轮运行中`,
      );
      throwIfCancelled();
    }
    const openCommunications = (currentTask.communications || []).filter((item) => item.status === 'open');
    if (openCommunications.length) {
      emitEvent(onEvent, {
        kind: 'progress',
        stage: 'working',
        planStep: 'coordinate',
        message: `正在请求 ${openCommunications.length} 个目标 agent 补充信息`,
        activeAgents: [...new Set(openCommunications.map((item) => item.toAgentId).filter(Boolean))],
        activeNodes: [],
        communicationCount: openCommunications.length,
      });
      currentTask = await heartbeat(
        scheduler.resolveOpenCommunications(currentTask.id, {
          maxParallel: Math.min(2, openCommunications.length),
          signal,
          model,
          reasoningEffort,
          permissionMode,
          onApproval,
        }),
        onEvent,
        '目标 agent 正在回复协作请求',
      );
      throwIfCancelled();
    }
    emitEvent(onEvent, {
      kind: 'progress',
      stage: 'working',
      planStep: (currentTask.communications || []).some((item) => item.status === 'open') ? 'coordinate' : 'execute',
      message: collaborationProgressLine(currentTask),
      completedAgents: [...new Set((currentTask.nodes || []).filter((node) => node.status === 'completed').map((node) => node.agentId).filter(Boolean))],
      taskProgress: {
        total: currentTask.nodes?.length || 0,
        completed: (currentTask.nodes || []).filter((node) => node.status === 'completed').length,
        queued: (currentTask.nodes || []).filter((node) => node.status === 'queued').length,
        waiting: (currentTask.nodes || []).filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
        failed: (currentTask.nodes || []).filter((node) => node.status === 'failed').length,
      },
      activeNodes: [],
    });
    triggerAutoSync?.('collaboration_task_progress', { delayMs: 1200 });
    if (!store.readyTaskNodes(currentTask.id).length && !(currentTask.communications || []).some((item) => item.status === 'open')) break;
  }
  currentTask = store.getTaskRun(currentTask.id);
  emitTaskProgress(currentTask, { type: 'verification_started' }, 'verifying');
  emitEvent(onEvent, {
    kind: 'progress',
    stage: 'delivering',
    planStep: 'synthesize',
    message: ['completed', 'failed', 'cancelled'].includes(currentTask.status)
      ? '节点已结束，正在汇总部门结果、阻塞项和最终交付'
      : '任务仍在后台自动推进，正在整理当前进度',
    completedAgents: [...new Set((currentTask.nodes || []).filter((node) => node.status === 'completed').map((node) => node.agentId).filter(Boolean))],
    activeNodes: [],
    taskRunId: currentTask.id,
    taskProgress: buildPublicTaskProgressSnapshot(currentTask, { phase: 'delivering', taskType, objective })?.progress,
  });
  const answer = collaborationAnswer(currentTask, org);
  const finalProgressSnapshot = buildPublicTaskProgressSnapshot(currentTask, { phase: 'delivering', taskType, objective });
  const contributingExecutions = store.listModelExecutionsForTask(currentTask.id);
  const saved = store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: answer,
    agentId: '',
    departmentId: 'collaboration',
    metadata: {
      collaboration: {
        taskRunId: currentTask.id,
        status: currentTask.status,
        nodes: currentTask.nodes.length,
        communications: currentTask.communications.length,
        deliveryType: 'deterministic_collaboration_summary',
        contributingExecutionIds: contributingExecutions.map((item) => item.id),
        taskType,
        objective,
        progressSnapshot: finalProgressSnapshot,
      },
    },
  });
  triggerAutoSync?.('collaboration_answer', { delayMs: 1200 });
  emitEvent(onEvent, {
    kind: ['completed', 'failed', 'cancelled'].includes(currentTask.status) ? 'done' : 'task-progress',
    sessionId: session.id,
    agentId: '',
    departmentId: 'collaboration',
    targetKind: 'collaboration',
    answer,
    task: summarizeCollaborationTask(currentTask),
    taskProgressSnapshot: finalProgressSnapshot,
  });
  return {
    session: store.getSession(session.id),
    message: saved,
    answer,
    threadId: '',
    task: summarizeCollaborationTask(currentTask),
    artifacts: [],
  };
}

function collaborationDepartmentLabels(task, org) {
  const departments = org.list().departments;
  const byId = new Map(departments.map((item) => [item.id, item.name || item.id]));
  return [...new Set((task.nodes || []).map((node) => node.departmentId).filter(Boolean))]
    .map((id) => byId.get(id) || id);
}

function collaborationProgressLine(task) {
  const nodes = task.nodes || [];
  const completed = nodes.filter((node) => node.status === 'completed').length;
  const waiting = nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length;
  const failed = nodes.filter((node) => node.status === 'failed').length;
  const ready = nodes.filter((node) => node.status === 'ready').length;
  const queued = nodes.filter((node) => node.status === 'queued').length;
  const running = nodes.filter((node) => node.status === 'running').length;
  const retrying = nodes.filter((node) => node.status === 'retry_wait').length;
  const openComms = (task.communications || []).filter((item) => item.status === 'open').length;
  if (retrying) return `协作自动恢复中：${retrying} 个节点等待自动重试，已完成 ${completed}/${nodes.length}`;
  if (openComms || waiting) return `协作暂停等待信息：${waiting} 个节点等待，${openComms} 个通信请求未解决`;
  if (failed) return `协作遇到阻塞：${completed}/${nodes.length} 个节点完成，${failed} 个节点失败`;
  return `协作推进中：${completed}/${nodes.length} 个节点完成，${queued} 个排队中，${running} 个运行中，${ready} 个待执行`;
}

function summarizeCollaborationTask(task) {
  const nodes = task.nodes || [];
  const communications = task.communications || [];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    nodeCount: nodes.length,
    completedCount: nodes.filter((node) => node.status === 'completed').length,
    queuedCount: nodes.filter((node) => node.status === 'queued').length,
    waitingCount: nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status)).length,
    failedCount: nodes.filter((node) => node.status === 'failed').length,
    openCommunicationCount: communications.filter((item) => item.status === 'open').length,
    participants: [...new Set(nodes.map((node) => node.agentId).filter(Boolean))],
  };
}

function collaborationAnswer(task, org) {
  const summary = summarizeCollaborationTask(task);
  const departments = collaborationDepartmentLabels(task, org);
  const nodes = task.nodes || [];
  const openComms = (task.communications || []).filter((item) => item.status === 'open');
  const completedNodes = nodes.filter((node) => node.status === 'completed');
  const waitingNodes = nodes.filter((node) => ['waiting', 'retry_wait', 'blocked'].includes(node.status));
  const failedNodes = nodes.filter((node) => node.status === 'failed');
  const finalNode = completedNodes.find((node) => /final|synthesis|最终|整合/i.test(`${node.title} ${node.outputFormat || ''}`))
    || completedNodes[completedNodes.length - 1];
  const heading = summary.status === 'completed'
    ? `部门协作任务已完成：${task.title}`
    : ['failed', 'cancelled'].includes(summary.status)
      ? `部门协作任务已结束：${task.title}`
      : ['queued', 'running'].includes(summary.status)
        ? `部门协作任务处理中：${task.title}`
        : `已创建部门协作任务：${task.title}`;
  const lines = [
    heading,
    '',
    `状态：${statusZh(summary.status)}；节点 ${summary.completedCount}/${summary.nodeCount} 已完成；开放通信 ${summary.openCommunicationCount} 个。`,
    `参与部门：${departments.join('、') || '待分配'}`,
    `参与 agent：${summary.participants.join('、') || '待分配'}`,
  ];
  if (completedNodes.length) {
    lines.push('', '已完成节点：');
    lines.push(...completedNodes.slice(0, 6).map((node) => `- ${node.title}（${node.agentId}）`));
  }
  if (openComms.length) {
    lines.push('', '等待通信：');
    lines.push(...openComms.slice(0, 5).map((item) => `- ${item.fromAgentId} -> ${item.toAgentId}: ${item.requestedInfo || item.purpose || '需要补充信息'}`));
  }
  if (waitingNodes.length) {
    lines.push('', '等待/阻塞节点：');
    lines.push(...waitingNodes.slice(0, 5).map((node) => `- ${node.title}: ${node.waitReason || '等待上游信息'}`));
  }
  if (failedNodes.length) {
    lines.push('', '失败节点：');
    lines.push(...failedNodes.slice(0, 5).map((node) => `- ${node.title}: ${node.errorText || '执行失败'}`));
  }
  if (finalNode?.resultText) {
    lines.push('', '最终整合结果：', String(finalNode.resultText || '').trim());
  } else if (['queued', 'running', 'ready', 'pending'].includes(summary.status)) {
    lines.push('', '任务会在 Agent 可用后自动继续，无需手动运行节点；可在“协作任务”中查看实时进度。');
  } else if (openComms.length || waitingNodes.length) {
    lines.push('', '任务正在等待必要的 Agent 通信；通信解除后会自动继续。');
  }
  const artifacts = collaborationArtifacts(nodes);
  const validation = collaborationValidation(nodes);
  lines.push('', '关键结果：');
  lines.push((finalNode?.resultSummary || finalNode?.resultText) ? `- ${clipForChat(finalNode.resultSummary || finalNode.resultText, 600)}` : `- 已完成 ${summary.completedCount}/${summary.nodeCount} 个协作节点。`);
  lines.push('', '修改或产物：');
  lines.push(...(artifacts.length ? artifacts.map((item) => `- ${item}`) : ['- 未从节点公开结果中识别到结构化文件或产物记录。']));
  lines.push('', '验证情况：');
  lines.push(...(validation.length ? validation.map((item) => `- ${item}`) : ['- 未从节点公开结果中识别到独立测试、构建或检查记录。']));
  lines.push('', '遗留风险：');
  if (failedNodes.length || waitingNodes.length || openComms.length) {
    lines.push(`- 仍有 ${failedNodes.length} 个失败节点、${waitingNodes.length} 个等待节点、${openComms.length} 个开放通信。`);
    lines.push('- 建议查看协作任务详情，补充缺失输入或重试失败节点。');
  } else {
    lines.push('- 无已知遗留阻塞；最终结果仍以各节点实际产出和验证记录为准。');
  }
  return lines.join('\n');
}

function collaborationObjective(prompt, attachments = [], taskType = 'qa') {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  const deliverables = [];
  if (taskType === 'code_change') deliverables.push('完成请求范围内的代码修改', '运行相关测试或检查');
  else if (taskType === 'file_generation') deliverables.push('生成用户要求的文件或文档', '说明产物位置与验证情况');
  else if (taskType === 'command_execution') deliverables.push('执行必要命令', '汇总关键输出和执行结果');
  else if (taskType === 'research') deliverables.push('整理调研发现', '给出结论、依据和限制');
  else deliverables.push('完成问题分析与最终答复');
  if (attachments.length) deliverables.push(`处理 ${attachments.length} 个附件`);
  return {
    summary: clean.length > 180 ? `${clean.slice(0, 179)}…` : clean,
    deliverables,
    executionMode: 'multi_agent_task_graph',
  };
}

function taskTypeLabel(taskType = '') {
  return ({
    code_change: '代码修改', file_generation: '文件生成', command_execution: '命令执行', research: '调研',
    explanation: '解释说明', qa: '问答', collaboration: '多 Agent 协作',
  })[taskType] || '任务处理';
}

function collaborationProgressMessage(snapshot = {}, change = {}) {
  const progress = snapshot.progress || {};
  const node = snapshot.changedNodes?.[0];
  if (change.type === 'task_created') return `已建立任务图：${progress.total || 0} 个节点，开始安排执行。`;
  if (node) return `${node.title}：${statusZh(node.status)}；总体 ${progress.completed || 0}/${progress.total || 0}。`;
  return `协作推进中：${progress.completed || 0}/${progress.total || 0} 个节点完成。`;
}

function collaborationArtifacts(nodes = []) {
  const values = [];
  for (const node of nodes) {
    for (const ref of node.evidenceRefs || []) {
      if (!['file', 'artifact', 'output'].includes(String(ref.type || '').toLowerCase())) continue;
      const label = String(ref.label || ref.path || ref.name || '').trim();
      if (label && !values.includes(label)) values.push(label);
    }
  }
  return values.slice(0, 12);
}

function collaborationValidation(nodes = []) {
  const matches = [];
  for (const node of nodes) {
    const lines = `${node.resultSummary || ''}\n${node.resultText || ''}`.split('\n')
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => /测试|构建|检查|验证|\b(test|build|check|lint|verify|validation)\b/i.test(line));
    for (const line of lines) {
      const clipped = clipForChat(line, 300);
      if (clipped && !matches.includes(clipped)) matches.push(clipped);
    }
  }
  return matches.slice(0, 8);
}

function clipForChat(value, max = 1200) {
  const text = String(value || '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function statusZh(status = '') {
  return ({
    pending: '等待中',
    ready: '待执行',
    queued: '排队中',
    running: '处理中',
    retry_wait: '等待自动重试',
    waiting: '等待信息',
    blocked: '依赖失败阻塞',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  })[status] || status || '未知';
}

export { sendCollaborationChat };
