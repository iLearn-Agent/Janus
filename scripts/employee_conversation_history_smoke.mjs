import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRuntime } from '../src/main/runtime.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'janus-employee-conversation-history-'));
const runtimeRoot = path.join(tempRoot, 'runtime');
const projectRoot = path.join(tempRoot, 'project-history');
let runtime;

try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'README.md'), '# history project\n', 'utf8');
  runtime = await createRuntime({ root: runtimeRoot, isDev: true, serverAuthoritativeSkills: true });
  const user = runtime.currentUser();
  const instance = runtime.store.findUserAgentInstance({ userId: user.id, agentFamilyId: 'general_agent' })
    || runtime.store.recruitUserAgent({
      userId: user.id,
      agentFamilyId: 'general_agent',
      commandId: 'employee-history:recruit-general',
    }).instance;
  const session = runtime.store.createSession({
    title: '员工主会话',
    departmentId: 'general',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    userId: user.id,
  });
  const oldMemory = runtime.store.listMemoryDocuments({ agentInstanceId: instance.id })
    .find((item) => item.scope === 'general' && item.lifecycleState === 'active');
  const oldContext = runtime.store.getAgentConversationContextSpace({ userId: user.id, agentInstanceId: instance.id });
  const attachment = runtime.uploadFile({
    filename: 'history-note.txt',
    contentType: 'text/plain',
    dataBase64: Buffer.from('HISTORY_ATTACHMENT_OK').toString('base64'),
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'OLD_MEMORY_USER_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: oldMemory.id,
    contextSpaceId: oldContext.id,
    metadata: { attachments: [attachment] },
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'OLD_MEMORY_ASSISTANT_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: oldMemory.id,
    contextSpaceId: oldContext.id,
  });

  const currentMemory = runtime.store.createNextGeneralMemoryDocument({
    agentInstanceId: instance.id,
    displayName: '当前 Memory',
    deviceId: 'local',
  });
  const currentContext = runtime.store.getAgentConversationContextSpace({ userId: user.id, agentInstanceId: instance.id });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'CURRENT_CONTEXT_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: currentMemory.id,
    contextSpaceId: currentContext.id,
  });

  const project = runtime.createProject({ title: '历史项目', workspaceRoot: projectRoot });
  const projectContext = runtime.store.ensureAgentContextSpace({
    userId: user.id,
    agentInstanceId: instance.id,
    contextKind: 'project',
    projectId: project.id,
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'PROJECT_HISTORY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    contextSpaceId: projectContext.id,
  });

  const task = runtime.scheduler.createTaskRun({
    title: '历史任务',
    prompt: '验证历史任务分组。',
    departmentId: 'general',
    leadAgentId: 'general_agent',
    leadAgentInstanceId: instance.id,
    userId: user.id,
  });
  const taskMemory = runtime.store.ensureTaskMemoryDocument({
    agentInstanceId: instance.id,
    taskRunId: task.id,
    taskTitle: task.title,
  });
  runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'TASK_HISTORY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    taskRunId: task.id,
    memoryId: taskMemory.id,
    contextSpaceId: taskMemory.contextSpaceId,
  });

  const legacyMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: 'LEGACY_HISTORY_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
  });
  runtime.store.db.prepare("UPDATE messages SET memory_id='',context_space_id='' WHERE id=?").run(legacyMessage.id);

  const requestMessage = runtime.store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: 'ACTIVE_WORK_MESSAGE',
    agentId: 'general_agent',
    agentInstanceId: instance.id,
    departmentId: 'general',
    memoryId: currentMemory.id,
    contextSpaceId: currentContext.id,
  });
  runtime.store.enqueueAgentWork({
    userId: user.id,
    agentInstanceId: instance.id,
    workKind: 'chat',
    workId: requestMessage.id,
    payload: { sessionId: session.id, agentFamilyId: 'general_agent' },
  });

  const beforeContext = runtime.store.getDeviceContextState({ deviceId: 'local', userId: user.id, agentInstanceId: instance.id });
  const overview = runtime.employeeConversationOverview({ agentInstanceId: instance.id });
  assert.equal(overview.primarySession.id, session.id);
  assert.equal(overview.activeWork.route, 'session');
  assert.equal(overview.activeWork.sessionId, session.id);
  assert.equal(overview.activeWork.session.agentInstanceId, instance.id);
  assert.equal(overview.windowId.endsWith(`agent:${instance.id}`), true,
    'the Agent window may include its account/workspace scope but must retain the instance identity');
  assert.equal(overview.activeBranch.primarySessionId, session.id);
  assert.deepEqual(overview.historyGroups, []);
  const timelineContents = overview.timeline.items.map((item) => item.content);
  for (const content of ['CURRENT_CONTEXT_MESSAGE', 'ACTIVE_WORK_MESSAGE']) {
    assert.equal(timelineContents.includes(content), true, `${content} must remain visible in the current Memory branch`);
  }
  for (const content of [
    'OLD_MEMORY_USER_MESSAGE', 'OLD_MEMORY_ASSISTANT_MESSAGE', 'PROJECT_HISTORY_MESSAGE',
    'TASK_HISTORY_MESSAGE', 'LEGACY_HISTORY_MESSAGE',
  ]) assert.equal(timelineContents.includes(content), false, `${content} must not leak into the current Memory branch`);

  const activeTask = runtime.scheduler.createTaskRun({
    title: '当前 uBuddy 任务', prompt: '验证 Agent 顶部任务卡片。', departmentId: 'general',
    leadAgentId: 'general_agent', leadAgentInstanceId: instance.id, userId: user.id,
  });
  const activeNodeA = runtime.store.createTaskNode({
    taskRunId: activeTask.id, title: '整理任务要求', objective: '整理要求',
    agentId: 'general_agent', agentInstanceId: instance.id,
  });
  const activeNodeB = runtime.store.createTaskNode({
    taskRunId: activeTask.id, title: '准备交付', objective: '准备交付',
    agentId: 'general_agent', agentInstanceId: instance.id,
  });
  const nextTask = runtime.scheduler.createTaskRun({
    title: '后续 uBuddy 任务', prompt: '验证后续任务摘要。', departmentId: 'general',
    leadAgentId: 'general_agent', leadAgentInstanceId: instance.id, userId: user.id,
  });
  const nextNode = runtime.store.createTaskNode({
    taskRunId: nextTask.id, title: '后续节点', objective: '后续执行',
    agentId: 'general_agent', agentInstanceId: instance.id,
  });
  const taskWorks = [activeNodeA, activeNodeB, nextNode].map((node) => runtime.store.enqueueAgentWork({
    userId: user.id,
    agentInstanceId: instance.id,
    workKind: 'task_node',
    workId: node.id,
    payload: { taskRunId: node.taskRunId, agentFamilyId: 'general_agent' },
  }));
  runtime.db.prepare(`UPDATE agent_work_queue SET status='running',started_at=?,updated_at=? WHERE id=?`)
    .run('2026-08-12T10:00:00.000Z', '2026-08-12T10:00:00.000Z', taskWorks[0].id);
  runtime.store.updateTaskNode(activeNodeA.id, { status: 'running' });
  runtime.store.updateTaskNode(activeNodeB.id, { status: 'completed' });
  runtime.store.recordTaskEvent({
    taskRunId: activeTask.id,
    taskNodeId: activeNodeA.id,
    eventType: 'node_activity',
    actorId: 'general_agent',
    status: 'running',
    summary: '正在分析仓库结构并定位关键模块',
    payload: { activityId: 'employee-progress-activity', activityType: 'commentary', detail: '正在分析仓库结构并定位关键模块' },
  });
  runtime.store.recordTaskEvent({
    taskRunId: activeTask.id,
    taskNodeId: activeNodeA.id,
    eventType: 'node_activity',
    actorId: 'general_agent',
    status: 'running',
    summary: '内部推理不应展示',
    payload: { activityId: 'employee-private-reasoning', activityType: 'reasoning', detail: '内部推理不应展示' },
  });
  runtime.store.recordTaskEvent({
    taskRunId: activeTask.id,
    taskNodeId: activeNodeA.id,
    eventType: 'node_activity',
    actorId: 'general_agent',
    status: 'running',
    summary: '正在检查 /home/owner/private.txt，token=secret-value',
    payload: { activityId: 'employee-sanitized-progress', activityType: 'commentary', detail: '正在检查敏感路径' },
  });
  const blockedSiblingTask = runtime.store.createTaskRun({
    ownerUserId: user.id, title: '同工作区阻塞任务', prompt: '不得覆盖真正运行的任务。',
    leadAgentId: 'general_agent', leadAgentInstanceId: instance.id,
  });
  const blockedSiblingNode = runtime.store.createTaskNode({
    taskRunId: blockedSiblingTask.id, title: '等待外部输入', objective: '等待输入',
    agentId: 'general_agent', agentInstanceId: instance.id,
  });
  runtime.store.updateTaskNode(blockedSiblingNode.id, { status: 'blocked', waitReason: '等待其他任务提供输入' });
  const availabilityWhileRunning = runtime.store.getAgentAvailability({
    userId: user.id, agentInstanceId: instance.id, workspaceId: 'workspace_personal',
  });
  assert.equal(availabilityWhileRunning.workState, 'running');
  assert.equal(availabilityWhileRunning.currentWork.taskRunId || availabilityWhileRunning.currentWork.payload?.taskRunId, activeTask.id,
    'a blocked sibling task must not replace the Agent actual running work');
  let taskOverview = runtime.employeeConversationOverview({ agentInstanceId: instance.id });
  assert.equal(taskOverview.activeWork.route, 'task_run');
  assert.equal(taskOverview.activeWork.taskRunId, activeTask.id, 'uBuddy task work must be visible ahead of ordinary chat work');
  assert.match(taskOverview.activeWork.currentAction, /正在检查/);
  assert.doesNotMatch(taskOverview.activeWork.currentAction, /\/home\/owner|secret-value|内部推理/);
  assert.deepEqual(taskOverview.activeWork.progress, { completed: 1, total: 4, percent: 25 });
  assert.doesNotMatch(taskOverview.activeWork.recentEvents.map((event) => event.summary).join('\n'), /内部推理|\/home\/owner|secret-value/);
  assert.equal(taskOverview.taskQueue.count, 1, 'multiple queued nodes from one task must count as one queued task');
  assert.deepEqual(taskOverview.taskQueue.taskRunIds, [nextTask.id]);

  for (const work of taskWorks.slice(0, 2)) runtime.store.finishAgentWork({ id: work.id, status: 'completed' });
  runtime.store.updateTaskRunStatus(activeTask.id, 'completed');
  taskOverview = runtime.employeeConversationOverview({ agentInstanceId: instance.id });
  assert.equal(taskOverview.activeWork.taskRunId, nextTask.id, 'the next queued task must be promoted after the current task finishes');
  assert.equal(taskOverview.taskQueue.count, 0);
  runtime.store.finishAgentWork({ id: taskWorks[2].id, status: 'completed' });
  runtime.store.updateTaskRunStatus(nextTask.id, 'completed');
  runtime.store.updateTaskRunStatus(blockedSiblingTask.id, 'cancelled');
  taskOverview = runtime.employeeConversationOverview({ agentInstanceId: instance.id });
  assert.equal(taskOverview.activeWork.route, 'session', 'the task card must clear after all uBuddy tasks finish');

  const organizationWorkspaceId = 'workspace_org_employee_progress_isolation';
  runtime.db.prepare(`INSERT INTO account_workspaces(
    id,workspace_kind,organization_id,owner_user_id,name,status
  ) VALUES(?,?,?,?,?,'active')`).run(
    organizationWorkspaceId, 'organization', 'org_employee_progress_isolation', user.id, 'Progress Isolation',
  );
  runtime.db.prepare(`INSERT INTO account_workspace_memberships(workspace_id,user_id,role,status)
    VALUES(?,?,'owner','active')`).run(organizationWorkspaceId, user.id);
  const otherWorkspaceTask = runtime.store.createTaskRun({
    ownerUserId: user.id, workspaceId: organizationWorkspaceId,
    title: '其他工作区私有任务', prompt: '不得显示在个人工作区。',
    leadAgentId: 'general_agent', leadAgentInstanceId: instance.id,
  });
  const otherWorkspaceNode = runtime.store.createTaskNode({
    taskRunId: otherWorkspaceTask.id, title: '其他工作区私有节点', objective: '验证隔离',
    agentId: 'general_agent', agentInstanceId: instance.id,
  });
  const otherWorkspaceWork = runtime.store.enqueueAgentWork({
    userId: user.id, workspaceId: organizationWorkspaceId,
    agentInstanceId: instance.id, workKind: 'task_node', workId: otherWorkspaceNode.id,
    payload: { taskRunId: otherWorkspaceTask.id, agentFamilyId: 'general_agent' },
  });
  assert.equal(runtime.store.getAgentAvailability({ userId: user.id, agentInstanceId: instance.id }).availability, 'working',
    'the raw global availability fixture must see the other Workspace work');
  assert.notEqual(runtime.store.getAgentAvailability({
    userId: user.id, agentInstanceId: instance.id, workspaceId: 'workspace_personal',
  }).currentWork?.taskRunId, otherWorkspaceTask.id, 'Workspace-scoped availability must exclude another Workspace task');
  taskOverview = runtime.employeeConversationOverview({ agentInstanceId: instance.id });
  assert.equal(taskOverview.activeWork.route, 'session', 'other Workspace work must not appear in the current Agent conversation');
  assert.notEqual(taskOverview.activeWork.taskRunId, otherWorkspaceTask.id);
  const personalEmployee = (await runtime.employeeOverview({ refreshCloud: false })).roster.find((item) => item.id === instance.id);
  assert.notEqual(personalEmployee.currentWork?.taskRunId || personalEmployee.currentWork?.payload?.taskRunId, otherWorkspaceTask.id,
    'the current Workspace roster must ignore another Workspace queue');
  assert.doesNotMatch(JSON.stringify(personalEmployee.currentWork || {}), /其他工作区私有/);
  runtime.store.finishAgentWork({ id: otherWorkspaceWork.id, status: 'completed' });
  runtime.store.updateTaskRunStatus(otherWorkspaceTask.id, 'completed');

  const history = runtime.employeeConversationHistoryGroup({
    agentInstanceId: instance.id,
    historyGroupId: 'legacy-memory-group',
  });
  assert.equal(history.redirected, true);
  assert.equal(history.windowId, overview.windowId);
  assert.equal(history.messages.some((message) => message.content === 'OLD_MEMORY_USER_MESSAGE'), true);
  const oldMemoryHistoryMessage = history.messages.find((message) => message.content === 'OLD_MEMORY_USER_MESSAGE');
  assert.equal(oldMemoryHistoryMessage.metadata.attachments.some((item) => item.name === 'history-note.txt'), true);
  const afterContext = runtime.store.getDeviceContextState({ deviceId: 'local', userId: user.id, agentInstanceId: instance.id });
  assert.equal(afterContext.activeContextSpaceId, beforeContext.activeContextSpaceId);
  assert.equal(afterContext.activeMemoryDocumentId, beforeContext.activeMemoryDocumentId);
  assert.equal(runtime.listMessages(session.id).some((message) => message.content === 'OLD_MEMORY_USER_MESSAGE'), true,
    'the canonical Agent chat must expose the complete direct conversation timeline');

  process.stdout.write('Employee single-window conversation timeline and active-work overview smoke passed.\n');
} finally {
  runtime?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
