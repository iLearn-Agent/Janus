import {
  artifactMessage,
  latestArtifact,
  sessionOutputsDir,
} from '../../../artifacts.js';
import {
  buildMessageWithAttachments,
  resolveAttachmentPath,
} from '../../../files.js';
import {
  editImageArtifact,
  editUploadedImageArtifact,
  generateImageArtifact,
  imageEditSourcesFromAttachments,
  shouldEditPreviousImage,
} from '../../../imageGeneration.js';
import { imageGenerationProviderState } from '../../../imageProvider.js';
import { suggestChatTitle } from '../../../chatPlanner.js';
import {
  PRIVATE_ASSISTANT_DEPARTMENT_ID,
  privateAssistantWorkspace,
  privateAssistantUsageStatus,
} from '../../../privateAssistant.js';
import {
  completeImageGeneration,
  failImageGeneration,
  reserveImageGeneration,
} from '../../../managedProviderUsage.js';
import { newId } from '../../../utils.js';

async function sendImageChat({
  runtimeRoot,
  store,
  user,
  runId = '',
  sessionId = '',
  message = '',
  attachments = [],
  imageAttachments = [],
  imageModel = '',
  imageQuality = 'auto',
  inlineImageMode = false,
  imageHostDepartmentId = '',
  imageHostAgentId = '',
  routingReason = '图像生成模式',
  automaticRoute = false,
  projectId = '',
  workspaceRoot = '',
  accountWorkspaceId = '',
  onEvent = null,
  signal = null,
  triggerAutoSync = null,
  setSession = null,
  emitEvent,
  heartbeat,
  createCancelledError,
}) {
  const prompt = String(message || '').trim();
  if (!prompt) throw new Error('请输入图片生成描述。');
  const throwIfCancelled = () => {
    if (signal?.aborted) throw createCancelledError();
  };
  throwIfCancelled();
  const resolvedAccountWorkspaceId = store.resolveAccountWorkspaceId?.({
    userId: user?.id || 'local_admin',
    workspaceId: accountWorkspaceId,
  }) || 'workspace_personal';
  let session = sessionId ? store.getSession(sessionId) : null;
  if (session && (session.userId !== (user?.id || 'local_admin')
    || String(session.workspaceId || session.accountWorkspaceId || 'workspace_personal') !== resolvedAccountWorkspaceId)) {
    throw new Error('无权访问该会话。');
  }
  if (session && !inlineImageMode && session.departmentId !== 'image_generation') {
    session = null;
  }
  if (!session) {
    const sessionDepartmentId = inlineImageMode ? imageHostDepartmentId || 'general' : 'image_generation';
    const sessionAgentId = inlineImageMode ? imageHostAgentId || '' : imageModel || 'gpt-image-2';
    session = store.createSession({
      title: suggestChatTitle(prompt, { mode: 'image', departmentId: 'image_generation', attachments: imageAttachments.length ? imageAttachments : attachments }),
      departmentId: sessionDepartmentId,
      agentId: sessionAgentId,
      projectId,
      workspaceRoot,
      userId: user?.id || 'local_admin',
      accountWorkspaceId: resolvedAccountWorkspaceId,
    });
  } else {
    if (!inlineImageMode && session.codexThreadId) {
      store.updateSessionThread(session.id, '');
      session = store.getSession(session.id) || session;
    }
    if (projectId && (!session.projectId || session.projectId !== projectId || !session.workspaceRoot)) {
      session = store.updateSession(session.id, { projectId, workspaceRoot }) || session;
    }
  }
  const privateAssistantImage = session.departmentId === PRIVATE_ASSISTANT_DEPARTMENT_ID;
  if (setSession) setSession(session);
  const imageModelId = imageModel || 'gpt-image-2';
  const messageIdentity = inlineImageMode
    ? {
      agentId: session.agentId || imageHostAgentId || '',
      departmentId: session.departmentId || imageHostDepartmentId || 'general',
    }
    : {
      agentId: imageModelId,
      departmentId: 'image_generation',
    };
  throwIfCancelled();
  emitEvent(onEvent, {
    kind: 'start',
    runId,
    sessionId: session.id,
    title: session.title,
    agentId: imageModelId,
    departmentId: 'image_generation',
    targetKind: 'image',
  });
  emitEvent(onEvent, {
    kind: 'routing',
    sessionId: session.id,
    departmentId: 'image_generation',
    agentId: imageModelId,
    targetKind: 'image',
    reason: routingReason || '图像生成模式',
    automaticRoute: Boolean(automaticRoute),
  });
  const storedMessage = buildMessageWithAttachments(runtimeRoot, prompt, attachments, user?.id);
  throwIfCancelled();
  const requestMessage = store.addMessage({
    sessionId: session.id,
    role: 'user',
    content: storedMessage,
    ...messageIdentity,
    metadata: {
      ...(attachments.length ? { attachments } : {}),
      imageGeneration: { requestedModel: imageModelId, inline: inlineImageMode },
    },
  });
  triggerAutoSync?.('image_message', { delayMs: 1200 });

  const resolvedImageAttachments = (imageAttachments.length ? imageAttachments : attachments)
    .map((attachment) => ({
      ...attachment,
      path: attachment.path ? attachment.path : resolveAttachmentPath(runtimeRoot, attachment, user?.id),
    }));
  const uploadedSources = resolvedImageAttachments.length
    ? imageEditSourcesFromAttachments(resolvedImageAttachments)
    : [];
  const previousImage = uploadedSources.length ? null : (shouldEditPreviousImage(prompt) ? latestArtifact(store, session.id, 'image') : null);
  const action = uploadedSources.length ? 'edit_upload' : previousImage ? 'edit' : 'generate';
  const progressMessage = action === 'generate'
    ? '已提交图片生成请求'
    : action === 'edit'
      ? '已引用上一张生成图，正在修改'
      : `已引用 ${uploadedSources.length} 个上传图片，正在修改`;
  emitEvent(onEvent, { kind: 'progress', stage: 'working', message: progressMessage });

  throwIfCancelled();
  const imageExecutionId = newId('model_exec');
  store.beginModelExecution({
    id: imageExecutionId,
    userId: user?.id || 'local_admin',
    projectId,
    conversationId: session.id,
    requestMessageId: requestMessage.id,
    departmentId: 'image_generation',
    agentId: imageModelId,
    agentRole: 'image_model',
    executionKind: `image_${action}`,
    providerId: 'image_api',
    requestedModel: imageModelId,
    effectiveModel: imageModelId,
    modelSource: imageModel ? 'request' : 'mode_default',
    metadata: { action, quality: imageQuality },
  });
  let artifact;
  const imageQuotaEventKey = `image-generation:${imageExecutionId}:0`;
  const imageProviderState = imageGenerationProviderState(runtimeRoot);
  let imageQuotaReserved = false;
  let imageQuotaUsage = null;
  const artifactRoot = privateAssistantImage
    ? privateAssistantWorkspace(runtimeRoot, user?.id || 'local_admin')
    : workspaceRoot || runtimeRoot;
  const artifactOutputRoot = sessionOutputsDir(artifactRoot, session.id);
  try {
    reserveImageGeneration(store, {
      userId: user?.id || 'local_admin',
      accountWorkspaceId: resolvedAccountWorkspaceId,
      executionId: imageExecutionId,
      sessionId: session.id,
      eventKey: imageQuotaEventKey,
      agentId: imageModelId,
      model: imageModelId,
      privateAssistant: privateAssistantImage,
      providerState: imageProviderState,
    });
    imageQuotaReserved = true;
    if (action === 'edit_upload') {
      artifact = await heartbeat(
        editUploadedImageArtifact({
          root: runtimeRoot,
          outputRoot: artifactOutputRoot,
          artifactRoot,
          sessionId: session.id,
          prompt,
          sources: uploadedSources,
          model: imageModelId,
          quality: imageQuality,
          signal,
        }),
        onEvent,
        '图片编辑处理中',
      );
    } else if (action === 'edit') {
      artifact = await heartbeat(
        editImageArtifact({
          root: runtimeRoot,
          outputRoot: artifactOutputRoot,
          artifactRoot,
          sessionId: session.id,
          prompt,
          sourceArtifact: previousImage,
          model: imageModelId,
          quality: imageQuality,
          signal,
        }),
        onEvent,
        '图片编辑处理中',
      );
    } else {
      artifact = await heartbeat(
        generateImageArtifact({
          root: runtimeRoot,
          outputRoot: artifactOutputRoot,
          artifactRoot,
          sessionId: session.id,
          prompt,
          model: imageModelId,
          quality: imageQuality,
          signal,
        }),
        onEvent,
        '图片服务处理中',
      );
    }
    imageQuotaUsage = completeImageGeneration(store, imageQuotaEventKey, {
      userId: user?.id || 'local_admin',
      providerState: imageProviderState,
    }).status;
    imageQuotaReserved = false;
    store.completeModelExecution(imageExecutionId);
  } catch (error) {
    if (imageQuotaReserved) failImageGeneration(store, imageQuotaEventKey, {
      userId: user?.id || 'local_admin',
      providerState: imageProviderState,
    });
    if (signal?.aborted) {
      store.completeModelExecution(imageExecutionId, { status: 'cancelled', errorText: '' });
      throw createCancelledError();
    }
    store.completeModelExecution(imageExecutionId, { status: 'failed', errorText: error.message || String(error) });
    const failureMessage = `图片生成失败：${String(error?.message || error || '图片服务暂时不可用。').slice(0, 1000)}`;
    store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: failureMessage,
      ...messageIdentity,
      metadata: {
        modelExecutionId: imageExecutionId,
        imageGenerationFailed: true,
        retryable: true,
        effectiveModel: imageModelId,
      },
    });
    triggerAutoSync?.('image_failure', { delayMs: 1200 });
    emitEvent(onEvent, { kind: 'error', message: failureMessage, departmentId: 'image_generation', targetKind: 'image' });
    throw error;
  }
  throwIfCancelled();
  const privateAssistantUsage = privateAssistantImage
    ? privateAssistantUsageStatus(store, user?.id || 'local_admin')
    : null;
  emitEvent(onEvent, { kind: 'managed-provider-usage', usage: imageQuotaUsage });
  const answer = action === 'generate' ? '图片已生成。' : '图片已修改。';
  emitEvent(onEvent, { kind: 'token', content: answer });
  const saved = store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    content: answer,
    ...messageIdentity,
    metadata: {
      modelExecutionId: imageExecutionId,
      effectiveModel: imageModelId,
      ...(privateAssistantUsage ? { privateAssistantImageUsage: { count: 1, source: 'daily_image_limit' } } : {}),
    },
  });
  store.updateModelExecution(imageExecutionId, {
    responseMessageId: saved.id,
    metadata: {
      action,
      quality: imageQuality,
      providerUsage: artifact.provider_usage || {},
      imageCount: artifact.image_count || 1,
      ...(privateAssistantUsage ? { privateAssistantImageUsageSource: 'daily_image_limit' } : {}),
    },
  });
  triggerAutoSync?.('image_answer', { delayMs: 1200 });
  store.addMessage({
    sessionId: session.id,
    role: 'system',
    content: artifactMessage('image', artifact),
    ...messageIdentity,
    metadata: { artifact: { kind: 'image' }, effectiveModel: imageModelId },
  });
  triggerAutoSync?.('image_artifact', { delayMs: 1200 });
  emitEvent(onEvent, {
    kind: 'done',
    sessionId: session.id,
    agentId: imageModelId,
    departmentId: 'image_generation',
    targetKind: 'image',
    answer,
    artifacts: [artifact],
    image: artifact,
    ...(privateAssistantUsage ? { privateAssistantUsage } : {}),
  });
  return {
    session: store.getSession(session.id),
    message: saved,
    answer,
    artifacts: [artifact],
    image: artifact,
    threadId: '',
    ...(privateAssistantUsage ? { privateAssistantUsage } : {}),
  };
}

export { sendImageChat };
