import { sha256Text } from '../../../utils.js';
import { taskNodeModelTimeoutMs } from '../domain/taskNodeTimeoutPolicy.js';
import { taskNodeFileDeliverables } from '../domain/deliverableContract.js';

export const UNIFIED_AGENT_WORK_KERNEL_VERSION = 'agent_work_v2';
export const LEGACY_TASK_EXECUTION_KERNEL_VERSION = 'legacy_task_exec_v1';

export function taskUsesUnifiedAgentWorkKernel(task = {}) {
  return String(task?.metadata?.executionKernelVersion || '') === UNIFIED_AGENT_WORK_KERNEL_VERSION;
}

export function taskNodeExecutionSessionId({ taskRunId = '', taskNodeId = '', agentInstanceId = '' } = {}) {
  const digest = sha256Text(`${taskRunId}\n${taskNodeId}\n${agentInstanceId}`).slice(0, 32);
  return `session_task_node_${digest}`;
}

export async function executeTaskNodeAsUnifiedAgentWork({
  store,
  sendChat,
  internalWorkspaceToken,
  task = {},
  node = {},
  agent = {},
  prompt = '',
  model = '',
  reasoningEffort = '',
  permissionMode = 'task-workspace',
  deliverableContract = null,
  finalOutputNode = false,
  signal = null,
  onEvent = null,
  createArtifact = null,
} = {}) {
  if (!store || typeof sendChat !== 'function') throw new Error('Unified Agent work execution is unavailable.');
  if (!task?.id || !node?.id || !node.agentInstanceId || !agent?.id) {
    throw new Error('Unified Agent work identity is incomplete.');
  }
  const sessionId = taskNodeExecutionSessionId({
    taskRunId: task.id,
    taskNodeId: node.id,
    agentInstanceId: node.agentInstanceId,
  });
  const workspaceId = task.workspaceId || task.accountWorkspaceId || task.metadata?.accountWorkspaceId || '';
  const session = store.createSession({
    id: sessionId,
    title: `${agent.name || agent.id} · ${node.title || '任务节点'}`,
    departmentId: agent.departmentId || node.departmentId || task.departmentId || 'general',
    agentId: agent.id,
    agentInstanceId: node.agentInstanceId,
    projectId: task.metadata?.projectId || '',
    workspaceRoot: task.metadata?.workspaceRoot || '',
    userId: task.ownerUserId || task.metadata?.userId || '',
    accountWorkspaceId: workspaceId,
    reusePrimary: false,
    conversationRole: 'task_node',
    status: 'active',
    memoryUseEnabled: false,
    memoryGenerateEnabled: false,
  });
  const attempt = Math.max(1, Number(node.attemptCount || 1));
  const workId = `task-node:${node.id}:attempt:${attempt}`;
  const ownedFileDeliverables = taskNodeFileDeliverables(deliverableContract || {}, node);
  const artifactToolAvailable = Boolean(typeof createArtifact === 'function' && ownedFileDeliverables.length);
  const preparedPrompt = String(prompt || '');
  const existingMessages = store.listMessages(session.id, { includeAllContexts: true });
  const existingResponse = existingMessages.find((message) => (
    message.role === 'assistant' && message.metadata?.unifiedAgentWorkId === workId
  )) || null;
  if (existingResponse) {
    return {
      session,
      message: existingResponse,
      answer: existingResponse.content,
      artifacts: existingResponse.metadata?.outputArtifacts || [],
      reused: true,
      unifiedAgentWorkId: workId,
    };
  }
  let requestMessage = existingMessages.find((message) => (
    message.role === 'user' && message.metadata?.unifiedAgentWorkId === workId
  )) || null;
  if (!requestMessage) {
    requestMessage = store.addMessage({
      sessionId: session.id,
      taskRunId: task.id,
      taskNodeId: node.id,
      role: 'user',
      content: preparedPrompt,
      agentId: agent.id,
      agentInstanceId: node.agentInstanceId,
      departmentId: agent.departmentId || node.departmentId || task.departmentId || 'general',
      visible: false,
      metadata: {
        internalTaskNode: true,
        unifiedAgentWork: true,
        unifiedAgentWorkId: workId,
        executionKernelVersion: UNIFIED_AGENT_WORK_KERNEL_VERSION,
        finalOutputNode: Boolean(finalOutputNode),
      },
    });
  }
  const dynamicTools = artifactToolAvailable ? taskArtifactDynamicToolSpecs() : [];
  const onDynamicToolCall = artifactToolAvailable
    ? async (call = {}) => handleTaskArtifactDynamicToolCall({
        call,
        createArtifact,
        task,
        node,
        agent,
        signal,
        onEvent,
      })
    : null;
  const result = await sendChat({
    sessionId: session.id,
    departmentId: agent.departmentId || node.departmentId || task.departmentId || 'general',
    agentId: agent.id,
    agentInstanceId: node.agentInstanceId,
    projectId: task.metadata?.projectId || '',
    workspaceRoot: task.metadata?.workspaceRoot || '',
    workspaceDetached: !task.metadata?.workspaceRoot,
    chatMode: 'agent',
    routePreference: 'explicit',
    message: preparedPrompt,
    model,
    reasoningEffort,
    timeoutMs: taskNodeModelTimeoutMs({ node }),
    sandboxPermission: permissionMode || 'task-workspace',
    signal,
    skipAgentQueue: true,
    internalRequestMessageId: requestMessage.id,
    internalResponseMetadata: {
      internalTaskNode: true,
      unifiedAgentWork: true,
      unifiedAgentWorkId: workId,
      executionKernelVersion: UNIFIED_AGENT_WORK_KERNEL_VERSION,
      finalOutputNode: Boolean(finalOutputNode),
    },
    internalTaskRunId: task.id,
    internalTaskNodeId: node.id,
    internalExecutionKind: 'task_node',
    internalPreparedPrompt: true,
    deliverableContract: finalOutputNode ? deliverableContract : null,
    requestedAccountWorkspaceId: workspaceId,
    internalWorkspaceToken,
    onEvent,
    dynamicTools,
    onDynamicToolCall,
  });
  return {
    ...result,
    session: result?.session || session,
    unifiedAgentWorkId: workId,
    reused: false,
  };
}

export function taskArtifactDynamicToolSpecs() {
  return [{
    type: 'namespace',
    name: 'janus',
    description: 'Janus host-owned final deliverable creation for the current task workspace.',
    tools: [{
      type: 'function',
      name: 'create_task_artifact',
      description: 'Create or replace a planned final deliverable in the current task workspace. Use this for text, DOCX, XLSX, PPTX, PDF, and image deliverables instead of apply_patch or shell file writes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: {
            type: 'string',
            enum: ['md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'svg', 'mmd', 'mermaid', 'drawio', 'docx', 'xlsx', 'pptx', 'pdf', 'png', 'jpg', 'jpeg', 'webp'],
          },
          deliverable_id: { type: 'string', minLength: 1, maxLength: 80 },
          relative_path: { type: 'string', minLength: 1, maxLength: 500 },
          payload: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              content: { type: 'string' },
              title: { type: 'string' },
              blocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
              sheets: { type: 'array', items: { type: 'object', additionalProperties: true } },
              slides: { type: 'array', items: { type: 'object', additionalProperties: true } },
              prompt: { type: 'string' },
              source_image_paths: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              style_id: { type: 'string' },
              template_id: { type: 'string' },
              user_message: { type: 'string' },
              model: { type: 'string' },
              quality: { type: 'string' },
              size: { type: 'string' },
            },
          },
          expected_sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        },
        required: ['deliverable_id', 'format', 'relative_path', 'payload'],
      },
    }],
  }];
}

async function handleTaskArtifactDynamicToolCall({
  call = {}, createArtifact, task, node, agent, signal = null, onEvent = null,
} = {}) {
  if (String(call.namespace || '') !== 'janus' || String(call.tool || '') !== 'create_task_artifact') {
    return taskArtifactToolResult(false, { ok: false, error: 'unsupported_task_artifact_tool' });
  }
  const args = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : {};
  try {
    const receipt = await createArtifact({
      task,
      node,
      agent,
      deliverableId: args.deliverable_id,
      format: args.format,
      relativePath: args.relative_path,
      payload: args.payload,
      expectedSha256: args.expected_sha256,
      signal,
      onProgress: (progress = {}) => {
        onEvent?.({
          kind: 'activity',
          activityId: `task-artifact-${node.id}-${String(args.relative_path || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`,
          activityType: 'artifact',
          status: progress.status || 'running',
          title: progress.status === 'completed' ? '交付文件已写入' : '正在生成交付文件',
          detail: progress.status === 'completed'
            ? `${progress.receipt?.relativePath || args.relative_path} 已完成格式校验并登记。`
            : `最终 Agent 正在生成 ${args.relative_path || args.format || '交付文件'}。`,
        });
      },
    });
    return taskArtifactToolResult(true, receipt);
  } catch (error) {
    const publicMessage = publicTaskArtifactFailureMessage(error);
    onEvent?.({
      kind: 'activity',
      activityId: `task-artifact-${node.id}-${String(args.relative_path || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`,
      activityType: 'artifact',
      status: 'failed',
      title: '交付文件生成失败',
      detail: publicMessage,
    });
    return taskArtifactToolResult(false, {
      ok: false,
      error: String(error?.code || 'task_artifact_creation_failed'),
      message: error?.code ? String(error.message || publicMessage).slice(0, 1200) : publicMessage,
    });
  }
}

function publicTaskArtifactFailureMessage(error) {
  const code = String(error?.code || '');
  return ({
    invalid_task_workspace_path: '交付文件路径无效，请使用任务工作区内的相对路径重试。',
    task_workspace_path_escape: '交付文件路径超出了任务工作区，请改用安全的相对路径重试。',
    task_workspace_symlink_escape: '交付文件路径经过不安全的符号链接，已拒绝写入。',
    artifact_format_not_planned: '文件格式与任务交付约定不一致，请按约定格式重试。',
    artifact_payload_invalid: '交付内容结构无效，最终 Agent 正在根据格式要求修正。',
    artifact_too_large: '交付文件超过当前大小限制，最终 Agent 需要精简或拆分内容。',
    artifact_renderer_unavailable: '所需文件生成器当前不可用，任务无法继续自动生成该格式。',
    artifact_structure_invalid: '生成文件未通过格式校验，最终 Agent 正在修复后重试。',
    task_workspace_file_conflict: '交付文件已被更新，为避免覆盖新版本已停止本次写入。',
    task_workspace_file_owned_by_other_node: '该交付路径属于另一个任务节点，已拒绝覆盖。',
    required_input_missing: '生成交付文件所需的工作区素材不存在。',
  })[code] || '交付文件生成失败，最终 Agent 将根据错误信息决定修复或报告阻塞。';
}

function taskArtifactToolResult(success, value) {
  return {
    success: Boolean(success),
    contentItems: [{ type: 'inputText', text: JSON.stringify(value ?? {}) }],
  };
}
